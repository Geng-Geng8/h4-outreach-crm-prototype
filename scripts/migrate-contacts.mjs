// Idempotent, non-destructive migration script: backfills existing school-level contacts into the Contacts tab.
// Preserves existing data, skips already-migrated schools, and guarantees zero duplicate contacts.
// Never overwrites populated rows, even when blank rows (gaps) exist between records.
//
// SAFE DEPLOYMENT & TEST-WORKBOOK CUTOVER SEQUENCE:
// 1. Tab Preparation:
//    Create the 'Contacts' tab in the test workbook with standard A1:N1 headers (matching HEADERS.Contacts).
// 2. Cloudflare Worker Deployment:
//    Deploy the Worker code from PR #11 containing contact CRUD and one-source-of-truth synchronization.
//    Once deployed, legacy /api/schools/update calls automatically synchronize with Contacts.
// 3. Dry-Run Migration & Quiet Window:
//    During a quiet window (no concurrent outreach writes), run 'node scripts/migrate-contacts.mjs'
//    to inspect schools to be backfilled and review non-destructive row allocations.
// 4. Live Migration Commit & Verification:
//    Run 'node scripts/migrate-contacts.mjs --commit'.
//    The script re-verifies pre-commit that target rows remain empty, writes non-overlapping ranges,
//    and preserves all populated rows and gaps. Verify in Google Sheets and rerun dry-run (reports 0 remaining).
// 5. GitHub Pages Publication:
//    Publish the updated frontend build to GitHub Pages to deliver the School Contacts UI to users.

import { randomUUID } from "node:crypto";
import { C, ContactCol } from "../src/schema.ts";

export async function planMigration(snapshot) {
  const schools = snapshot.Schools.slice(1).filter((r) => r[C.id]);
  const existingContacts = snapshot.Contacts?.slice(1) ?? [];
  const existingByRecordId = new Set(
    existingContacts
      .filter((c) => c[ContactCol.recordId] && String(c[ContactCol.recordId]).trim())
      .map((c) => String(c[ContactCol.recordId])),
  );

  const planned = [];
  const today = new Date().toLocaleDateString("en-CA", { timeZone: "America/Toronto" });

  for (const school of schools) {
    const recordId = String(school[C.id]);
    const schoolName = String(school[C.name] ?? "");
    const contactName = String(school[C.contactName] ?? "").trim();
    const contactRole = String(school[C.contactRole] ?? "").trim() || "School Representative";
    const email = String(school[C.email] ?? "").trim();
    const phone = String(school[C.phone] ?? "").trim();

    if (existingByRecordId.has(recordId)) {
      continue;
    }

    if (!contactName && !email) {
      continue;
    }

    planned.push({
      contactId: randomUUID(),
      recordId,
      schoolName,
      name: contactName || "School Office",
      role: contactRole,
      category: "Administration",
      gradeRange: "",
      programGroup: "Main Office",
      email,
      phone,
      notes: "Migrated from existing school record",
      isPrimary: "TRUE",
      active: "TRUE",
      updatedAt: today,
    });
  }

  // Non-destructive row allocation:
  // Inspect candidate rows starting from row 2.
  // Any row that contains ANY non-empty cell is skipped and preserved, even when gaps exist.
  let candidateRow = 2;
  for (const item of planned) {
    while ((snapshot.Contacts?.[candidateRow - 1] ?? []).some((cell) => String(cell ?? "").trim() !== "")) {
      candidateRow++;
    }
    item.targetRow = candidateRow;
    candidateRow++;
  }

  return planned;
}

export function buildMigrationRanges(planned) {
  if (!planned || planned.length === 0) return [];
  const sorted = [...planned].sort((a, b) => a.targetRow - b.targetRow);
  const ranges = [];
  let currentGroup = [];
  let startRow = null;
  let prevRow = null;

  for (const item of sorted) {
    const rowValues = [
      item.contactId, item.recordId, item.schoolName, item.name, item.role,
      item.category, item.gradeRange, item.programGroup, item.email, item.phone,
      item.notes, item.isPrimary, item.active, item.updatedAt,
    ];
    if (startRow === null) {
      startRow = item.targetRow;
      prevRow = item.targetRow;
      currentGroup = [rowValues];
    } else if (item.targetRow === prevRow + 1) {
      currentGroup.push(rowValues);
      prevRow = item.targetRow;
    } else {
      ranges.push({
        range: `'Contacts'!A${startRow}:N${prevRow}`,
        values: currentGroup,
      });
      startRow = item.targetRow;
      prevRow = item.targetRow;
      currentGroup = [rowValues];
    }
  }

  if (startRow !== null) {
    ranges.push({
      range: `'Contacts'!A${startRow}:N${prevRow}`,
      values: currentGroup,
    });
  }

  return ranges;
}

if (process.argv[1] && process.argv[1].endsWith("migrate-contacts.mjs")) {
  const { localBindings } = await import("./local-runtime.mjs");
  const isCommit = process.argv.includes("--commit");
  const bindings = await localBindings();

  if (!bindings.GOOGLE_SERVICE_ACCOUNT_EMAIL || !bindings.GOOGLE_PRIVATE_KEY) {
    console.log("No live credentials found in .dev.vars; running in dry-run explanation mode.");
  }

  console.log(`=== H4 CRM School Contacts Migration ===`);
  console.log(`Mode: ${isCommit ? "COMMIT (Live write)" : "DRY-RUN (Inspection only, pass --commit to write)"}\n`);

  if (!bindings.GOOGLE_SERVICE_ACCOUNT_EMAIL || !bindings.GOOGLE_PRIVATE_KEY) {
    console.log("To run migration against the test spreadsheet, set service account credentials in .dev.vars.");
    process.exit(0);
  }

  const { GoogleSheetsCoordinator } = await import("../src/google-sheets-write.ts");
  const coordinator = new GoogleSheetsCoordinator(bindings);
  console.log("Reading test spreadsheet snapshot...");
  const snapshot = await coordinator.snapshot();
  const planned = await planMigration(snapshot);

  console.log(`Found ${planned.length} schools with legacy contact information needing backfill.`);
  for (const p of planned) {
    console.log(`  - Row ${p.targetRow}: ${p.schoolName} -> ${p.name} (${p.role}) <${p.email || "no email"}>`);
  }

  if (!isCommit) {
    console.log("\nDry-run completed. Re-run with --commit to apply these contacts to the sheet.");
  } else if (planned.length > 0) {
    // Race-condition prevention: verify no active concurrent contact writes occurred
    console.log("\nVerifying spreadsheet state hasn't changed before committing...");
    const preWriteSnapshot = await coordinator.snapshot();
    const recheckedPlanned = await planMigration(preWriteSnapshot);
    const hasConflict = (
      recheckedPlanned.length !== planned.length ||
      recheckedPlanned.some((rp, idx) => rp.recordId !== planned[idx].recordId || rp.targetRow !== planned[idx].targetRow)
    );
    if (hasConflict) {
      console.error("ABORT: Concurrent modification detected in Contacts tab during migration. Re-run migration after active writes complete.");
      process.exitCode = 1;
      process.exit(1);
    }

    const ranges = buildMigrationRanges(planned);
    console.log(`Writing ${planned.length} contacts across ${ranges.length} non-destructive range(s)...`);
    for (const r of ranges) {
      console.log(`  - Writing range: ${r.range} (${r.values.length} contact(s))`);
    }

    const res = await coordinator.request("POST", "values:batchUpdate", {
      valueInputOption: "RAW",
      data: ranges,
    });

    if (res.ok) {
      console.log(`✓ Successfully migrated ${planned.length} contacts non-destructively!`);
    } else {
      console.error(`Failed to write migration: HTTP ${res.status}`);
      process.exitCode = 1;
    }
  } else {
    console.log("All schools already have contacts. Nothing to migrate.");
  }
}
