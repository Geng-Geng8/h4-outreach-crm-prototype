// Idempotent, non-destructive migration script: backfills existing school-level contacts into the Contacts tab.
// Preserves existing data, skips already-migrated schools, and guarantees zero duplicate contacts.
// Never overwrites populated rows, even when blank rows (gaps) exist between records.
//
// SAFE DEPLOYMENT & TEST-WORKBOOK CUTOVER SEQUENCE:
// 1. Workbook Backup:
//    Back up the authorized test workbook before any schema or data modifications.
// 2. Quiet Window:
//    Establish a quiet window with no CRM writes (no active outreach logging or school updates).
// 3. Tab Preparation & Validation:
//    Create the 'Contacts' tab in the test workbook with standard A1:N1 headers (matching HEADERS.Contacts).
//    Validate headers match schema expectations.
// 4. Migration Execution & Verification:
//    Run dry-run 'node scripts/migrate-contacts.mjs' to review allocations, then live commit
//    with 'node scripts/migrate-contacts.mjs --commit'. Verify data in Google Sheets and rerun dry-run.
// 5. Worker Deployment & Pre-Merge Verification:
//    Deploy the PR #11 Worker to Cloudflare and verify read/write endpoints against the test workbook.
// 6. Merge PR #11:
//    Merge PR #11 to main, which automatically triggers GitHub Pages publication of the updated frontend.
// 7. Post-Deployment Verification:
//    Verify end-to-end functionality: existing outreach logging, multi-channel bulk outreach, and new contact management.

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

  const { build } = await import("esbuild");
  const { fileURLToPath, pathToFileURL } = await import("node:url");
  const { unlink } = await import("node:fs/promises");
  const entry = fileURLToPath(new URL("../src/google-sheets-write.ts", import.meta.url));
  const out = fileURLToPath(new URL("./.tmp-sheets-write.mjs", import.meta.url));
  await build({ entryPoints: [entry], outfile: out, bundle: true, format: "esm", platform: "node", target: "es2022", packages: "external" });
  let GoogleSheetsCoordinator;
  try {
    const mod = await import(pathToFileURL(out).href);
    GoogleSheetsCoordinator = mod.GoogleSheetsCoordinator;
  } finally {
    await unlink(out).catch(() => {});
  }
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
