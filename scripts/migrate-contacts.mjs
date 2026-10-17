// Idempotent migration script: backfills existing school-level contacts into the Contacts tab.
// Preserves existing data, skips already-migrated schools, and guarantees zero duplicate contacts.
import { randomUUID } from "node:crypto";
import { C, ContactCol } from "../src/schema.ts";

export async function planMigration(snapshot) {
  const schools = snapshot.Schools.slice(1).filter((r) => r[C.id]);
  const existingContacts = snapshot.Contacts?.slice(1) ?? [];
  const existingByRecordId = new Set(
    existingContacts
      .filter((c) => String(c[ContactCol.active]).trim().toUpperCase() === "TRUE")
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

  return planned;
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
    console.log(`  - ${p.schoolName}: ${p.name} (${p.role}) <${p.email || "no email"}>`);
  }

  if (!isCommit) {
    console.log("\nDry-run completed. Re-run with --commit to apply these contacts to the sheet.");
  } else if (planned.length > 0) {
    console.log(`\nWriting ${planned.length} contacts to Contacts tab...`);
    let startRow = 2;
    while ((snapshot.Contacts?.[startRow - 1] ?? []).some((cell) => cell !== "")) startRow++;
    const endRow = startRow + planned.length - 1;
    const values = planned.map((p) => [
      p.contactId, p.recordId, p.schoolName, p.name, p.role,
      p.category, p.gradeRange, p.programGroup, p.email, p.phone,
      p.notes, p.isPrimary, p.active, p.updatedAt,
    ]);

    const res = await coordinator.request("POST", "values:batchUpdate", {
      valueInputOption: "RAW",
      data: [{ range: `'Contacts'!A${startRow}:N${endRow}`, values }],
    });

    if (res.ok) {
      console.log(`✓ Successfully migrated ${planned.length} contacts!`);
    } else {
      console.error(`Failed to write migration: HTTP ${res.status}`);
      process.exitCode = 1;
    }
  } else {
    console.log("All schools already have contacts. Nothing to migrate.");
  }
}
