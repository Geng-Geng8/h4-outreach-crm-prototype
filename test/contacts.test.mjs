import test from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { harness, C, ACTOR, OTHER, SUPERVISOR, RECORD, VERSION } from "./harness.mjs";
import { ContactCol, HEADERS } from "../src/schema.ts";
import { planMigration, buildMigrationRanges } from "../scripts/migrate-contacts.mjs";

const CONTACTS_URL = "/api/schools/contacts";
const DETAIL_URL = (id) => `/api/schools/detail?recordId=${encodeURIComponent(id)}`;

test("contact CRUD: create secondary contact, edit details, set primary (demoting previous), and deactivate", async (t) => {
  const h = await harness(t);

  // 1. Fetch initial school detail - should include the initial contact Jane Smith
  const initialDetail = await h.get(DETAIL_URL(RECORD), ACTOR);
  assert.equal(initialDetail.status, 200);
  assert.equal(initialDetail.body.contacts.length, 1);
  assert.equal(initialDetail.body.contacts[0].name, "Jane Smith");
  assert.equal(initialDetail.body.contacts[0].isPrimary, true);

  // 2. Create secondary contact (John Doe)
  const createReqId = randomUUID();
  const createRes = await h.post(CONTACTS_URL, {
    requestId: createReqId,
    recordId: RECORD,
    expectedRequestId: VERSION,
    action: "create",
    contact: {
      name: "John Doe",
      role: "Science Teacher",
      category: "Teacher",
      gradeRange: "9-11",
      programGroup: "Science Dept",
      email: "jdoe@example.test",
      phone: "416-555-0102",
      notes: "Coordinates dance club",
      isPrimary: false,
    },
  }, ACTOR);

  assert.equal(createRes.status, 200);
  assert.equal(createRes.body.ok, true);
  assert.equal(createRes.body.contact.name, "John Doe");
  assert.equal(createRes.body.contact.isPrimary, false);
  const johnContactId = createRes.body.contact.contactId;

  assert.equal(createRes.body.record.contactName, "");

  // Contacts table in sheets has 2 contacts now
  const contactsInSheet = h.sheets.tables.Contacts.slice(1);
  assert.equal(contactsInSheet.length, 2);
  const johnRow = contactsInSheet.find((r) => r[ContactCol.id] === johnContactId);
  assert.ok(johnRow);
  assert.equal(johnRow[ContactCol.name], "John Doe");
  assert.equal(johnRow[ContactCol.isPrimary], "FALSE");

  // 3. Update John Doe's role
  const updateReqId = randomUUID();
  const updateRes = await h.post(CONTACTS_URL, {
    requestId: updateReqId,
    recordId: RECORD,
    expectedRequestId: createRes.body.requestId,
    action: "update",
    contactId: johnContactId,
    contact: {
      role: "Head of Science",
    },
  }, ACTOR);

  assert.equal(updateRes.status, 200);
  assert.equal(updateRes.body.contact.role, "Head of Science");

  // 4. Set John Doe as primary contact (demotes Jane Smith)
  const setPrimaryReqId = randomUUID();
  const setPrimaryRes = await h.post(CONTACTS_URL, {
    requestId: setPrimaryReqId,
    recordId: RECORD,
    expectedRequestId: updateRes.body.requestId,
    action: "set_primary",
    contactId: johnContactId,
  }, ACTOR);

  assert.equal(setPrimaryRes.status, 200);
  assert.equal(setPrimaryRes.body.contact.isPrimary, true);
  assert.equal(setPrimaryRes.body.record.contactName, "John Doe");
  assert.equal(setPrimaryRes.body.record.contactRole, "Head of Science");
  assert.equal(setPrimaryRes.body.record.email, "jdoe@example.test");
  assert.equal(setPrimaryRes.body.record.phone, "416-555-0102");

  // Verify in Sheets tables that Jane is demoted to FALSE and John is TRUE
  const janeRow = h.sheets.tables.Contacts.slice(1).find((r) => r[ContactCol.name] === "Jane Smith");
  const updatedJohnRow = h.sheets.tables.Contacts.slice(1).find((r) => r[ContactCol.id] === johnContactId);
  assert.equal(janeRow[ContactCol.isPrimary], "FALSE");
  assert.equal(updatedJohnRow[ContactCol.isPrimary], "TRUE");

  // Verify Activity Log recorded the change
  const logs = h.sheets.tables["Activity Log"].slice(1);
  const primaryLog = logs.find((l) => l[11] === setPrimaryReqId);
  assert.ok(primaryLog);
  assert.equal(primaryLog[13], "ContactUpdated");
  assert.equal(primaryLog[7], "Set John Doe as primary contact");

  // 5. Deactivate John Doe -> Jane Smith is automatically promoted back to primary
  const deactReqId = randomUUID();
  const deactRes = await h.post(CONTACTS_URL, {
    requestId: deactReqId,
    recordId: RECORD,
    expectedRequestId: setPrimaryRes.body.requestId,
    action: "deactivate",
    contactId: johnContactId,
  }, ACTOR);

  assert.equal(deactRes.status, 200);
  assert.equal(deactRes.body.record.contactName, "Jane Smith");
  assert.equal(deactRes.body.record.contactRole, "Principal");

  const deactivatedJohnRow = h.sheets.tables.Contacts.slice(1).find((r) => r[ContactCol.id] === johnContactId);
  assert.equal(deactivatedJohnRow[ContactCol.active], "FALSE");
  assert.equal(deactivatedJohnRow[ContactCol.isPrimary], "FALSE");

  const repromotedJaneRow = h.sheets.tables.Contacts.slice(1).find((r) => r[ContactCol.name] === "Jane Smith");
  assert.equal(repromotedJaneRow[ContactCol.isPrimary], "TRUE");
});

test("contact safety: stale version protection and idempotent request replay", async (t) => {
  const h = await harness(t);

  // Stale version rejected with 409
  const staleRes = await h.post(CONTACTS_URL, {
    requestId: randomUUID(),
    recordId: RECORD,
    expectedRequestId: randomUUID(),
    action: "create",
    contact: {
      name: "Alice Brown",
      role: "Guidance Counselor",
    },
  }, ACTOR);

  assert.equal(staleRes.status, 409);
  assert.equal(staleRes.body.code, "CONFLICT_STALE_VERSION");

  // Successful create
  const reqId = randomUUID();
  const createPayload = {
    requestId: reqId,
    recordId: RECORD,
    expectedRequestId: VERSION,
    action: "create",
    contact: {
      name: "Alice Brown",
      role: "Guidance Counselor",
      category: "Staff",
      email: "alice@example.test",
    },
  };
  const firstRes = await h.post(CONTACTS_URL, createPayload, ACTOR);
  assert.equal(firstRes.status, 200);
  const contactCountAfterFirst = h.sheets.tables.Contacts.slice(1).length;

  // Idempotent replay with same request ID returns saved result and does not append row
  const replayRes = await h.post(CONTACTS_URL, createPayload, ACTOR);
  assert.equal(replayRes.status, 200);
  assert.equal(replayRes.body.requestId, reqId);
  assert.equal(h.sheets.tables.Contacts.slice(1).length, contactCountAfterFirst);
});

test("contact permissions: non-owner student denied (403), supervisor allowed (200)", async (t) => {
  const h = await harness(t);

  // Student non-owner denied
  const nonOwnerRes = await h.post(CONTACTS_URL, {
    requestId: randomUUID(),
    recordId: RECORD,
    expectedRequestId: VERSION,
    action: "create",
    contact: { name: "Test Contact", role: "VP" },
  }, OTHER);
  assert.equal(nonOwnerRes.status, 403);
  assert.equal(nonOwnerRes.body.code, "NOT_OWNER");

  // Supervisor allowed
  const supervisorRes = await h.post(CONTACTS_URL, {
    requestId: randomUUID(),
    recordId: RECORD,
    expectedRequestId: VERSION,
    action: "create",
    contact: { name: "Supervisor Added Contact", role: "Vice Principal", category: "Administration" },
  }, SUPERVISOR);
  assert.equal(supervisorRes.status, 200);
  assert.equal(supervisorRes.body.contact.name, "Supervisor Added Contact");
});

test("contact validation: rejects missing name, invalid category, or invalid action", async (t) => {
  const h = await harness(t);

  // Missing name
  const missingNameRes = await h.post(CONTACTS_URL, {
    requestId: randomUUID(),
    recordId: RECORD,
    expectedRequestId: VERSION,
    action: "create",
    contact: { name: "   ", role: "Teacher" },
  }, ACTOR);
  assert.equal(missingNameRes.status, 422);
  assert.equal(missingNameRes.body.code, "CONTACT_DETAILS_REQUIRED");

  // Invalid category
  const badCategoryRes = await h.post(CONTACTS_URL, {
    requestId: randomUUID(),
    recordId: RECORD,
    expectedRequestId: VERSION,
    action: "create",
    contact: { name: "Valid Name", role: "Teacher", category: "InvalidCategory" },
  }, ACTOR);
  assert.equal(badCategoryRes.status, 422);
  assert.equal(badCategoryRes.body.code, "INVALID_CATEGORY");

  // Invalid action
  const badActionRes = await h.post(CONTACTS_URL, {
    requestId: randomUUID(),
    recordId: RECORD,
    expectedRequestId: VERSION,
    action: "unknown_action",
  }, ACTOR);
  assert.equal(badActionRes.status, 422);
  assert.equal(badActionRes.body.code, "INVALID_ACTION");
});

test("planMigration: idempotently identifies legacy contacts and skips existing contacts", async () => {
  function makeSchool(id, name, contactName, contactRole, email, phone) {
    const row = Array(32).fill("");
    row[C.id] = id;
    row[C.name] = name;
    row[C.contactName] = contactName;
    row[C.contactRole] = contactRole;
    row[C.email] = email;
    row[C.phone] = phone;
    return row;
  }

  // Synthetic snapshot with 3 schools:
  // rec-1: has legacy contact, but already migrated in Contacts tab -> should skip
  // rec-2: has legacy contact, not in Contacts tab -> should plan migration
  // rec-3: has no contact info -> should skip
  const snapshot = {
    Schools: [
      [...HEADERS.Schools],
      makeSchool("rec-1", "Alpha School", "Jane Principal", "Principal", "jane@alpha.test", "416-555-1111"),
      makeSchool("rec-2", "Beta School", "Bob VicePrincipal", "VP", "bob@beta.test", "416-555-2222"),
      makeSchool("rec-3", "Gamma School", "", "", "", ""),
    ],
    Contacts: [
      [...HEADERS.Contacts],
      ["c-1", "rec-1", "Alpha School", "Jane Principal", "Principal", "Administration", "", "Office", "jane@alpha.test", "416-555-1111", "Existing", "TRUE", "TRUE", "2026-10-15"],
    ],
  };

  const plan = await planMigration(snapshot);
  assert.equal(plan.length, 1);
  assert.equal(plan[0].recordId, "rec-2");
  assert.equal(plan[0].name, "Bob VicePrincipal");
  assert.equal(plan[0].role, "VP");
  assert.equal(plan[0].email, "bob@beta.test");
  assert.equal(plan[0].isPrimary, "TRUE");
  assert.equal(plan[0].active, "TRUE");
});

test("planMigration: non-destructively assigns rows skipping populated rows separated by gaps", async () => {
  function makeSchool(id, name, contactName, email) {
    const row = Array(32).fill("");
    row[C.id] = id;
    row[C.name] = name;
    row[C.contactName] = contactName;
    row[C.contactRole] = "Principal";
    row[C.email] = email;
    return row;
  }

  // Synthetic snapshot with Contacts having populated rows separated by blank rows (gaps)
  // Row 1: Header
  // Row 2: Populated contact (rec-1)
  // Row 3: Blank gap
  // Row 4: Populated contact (rec-2)
  // Row 5: Blank gap
  // Row 6: Populated contact (rec-3)
  const snapshot = {
    Schools: [
      [...HEADERS.Schools],
      makeSchool("rec-1", "Alpha School", "Jane Principal", "jane@alpha.test"),
      makeSchool("rec-2", "Beta School", "Bob VP", "bob@beta.test"),
      makeSchool("rec-3", "Gamma School", "Grace Head", "grace@gamma.test"),
      makeSchool("rec-4", "Delta School", "Danielle Admin", "danielle@delta.test"),
      makeSchool("rec-5", "Epsilon School", "Evan Coord", "evan@epsilon.test"),
    ],
    Contacts: [
      [...HEADERS.Contacts],
      ["c-1", "rec-1", "Alpha School", "Jane Principal", "Principal", "Administration", "", "Office", "jane@alpha.test", "", "Existing", "TRUE", "TRUE", "2026-10-15"],
      ["", "", "", "", "", "", "", "", "", "", "", "", "", ""], // Row 3: Blank gap
      ["c-2", "rec-2", "Beta School", "Bob VP", "VP", "Administration", "", "Office", "bob@beta.test", "", "Existing", "TRUE", "TRUE", "2026-10-15"], // Row 4: Populated
      ["", "", "", "", "", "", "", "", "", "", "", "", "", ""], // Row 5: Blank gap
      ["c-3", "rec-3", "Gamma School", "Grace Head", "Head", "Administration", "", "Office", "grace@gamma.test", "", "Existing", "TRUE", "TRUE", "2026-10-15"], // Row 6: Populated
    ],
  };

  const plan = await planMigration(snapshot);
  assert.equal(plan.length, 2);
  assert.equal(plan[0].recordId, "rec-4");
  assert.equal(plan[0].targetRow, 3, "First planned contact must fill the blank gap at row 3");
  assert.equal(plan[1].recordId, "rec-5");
  assert.equal(plan[1].targetRow, 5, "Second planned contact must skip populated row 4 and fill blank gap at row 5");

  const ranges = buildMigrationRanges(plan);
  assert.equal(ranges.length, 2);
  assert.equal(ranges[0].range, "'Contacts'!A3:N3");
  assert.equal(ranges[1].range, "'Contacts'!A5:N5");

  // Verify that populated rows 2, 4, 6 are never included in any write range
  const touchedRows = new Set();
  for (const r of ranges) {
    const match = /^'Contacts'!A(\d+):N(\d+)$/.exec(r.range);
    assert.ok(match);
    for (let row = Number(match[1]); row <= Number(match[2]); row++) {
      touchedRows.add(row);
    }
  }
  assert.equal(touchedRows.has(2), false, "Row 2 must not be overwritten");
  assert.equal(touchedRows.has(4), false, "Row 4 must not be overwritten");
  assert.equal(touchedRows.has(6), false, "Row 6 must not be overwritten");
});

test("operator recovery: contacts write committed with lost ack reconciles with Contacts range evidence", async (t) => {
  const h = await harness(t);
  h.sheets.fault = "lost-ack-unreconciled";
  const reqId = randomUUID();
  const input = {
    requestId: reqId,
    recordId: RECORD,
    expectedRequestId: VERSION,
    action: "create",
    contact: {
      name: "Recovery Contact",
      role: "Guidance",
      category: "Staff",
      email: "guidance@example.test",
    },
  };
  const uncertain = await h.post(CONTACTS_URL, input, ACTOR);
  assert.equal(uncertain.status, 503);
  assert.equal(uncertain.body.code, "COMMIT_UNCERTAIN");

  // Inspect recovery state as supervisor
  const inspection = await h.get("/api/operator/recovery", SUPERVISOR);
  assert.equal(inspection.status, 200);
  assert.equal(inspection.body.blocked, true);
  assert.equal(inspection.body.evidence.status, "CONFIRMED_COMMITTED");
  assert.equal(inspection.body.evidence.reconcilable, true);

  // Reconcile
  const recon = await h.post("/api/operator/recovery", { requestId: reqId, action: "reconcile" }, SUPERVISOR);
  assert.equal(recon.status, 200);
  assert.equal(recon.body.code, "RECONCILED_COMMITTED");
  assert.equal(recon.body.blocked, false);

  // Replay
  const replay = await h.post(CONTACTS_URL, input, ACTOR);
  assert.equal(replay.status, 200);
  assert.equal(replay.body.contact.name, "Recovery Contact");
});

test("one source of truth: /api/schools/update synchronizes primary Contacts record and preserves non-contact edits", async (t) => {
  const h = await harness(t);

  // 1. Initial primary contact in Contacts table
  const contactsBefore = h.sheets.tables.Contacts.slice(1);
  const primaryBefore = contactsBefore.find((c) => c[ContactCol.recordId] === RECORD && c[ContactCol.isPrimary] === "TRUE");
  assert.ok(primaryBefore);
  assert.equal(primaryBefore[ContactCol.name], "Jane Smith");
  assert.equal(primaryBefore[ContactCol.role], "Principal");

  // 2. Patch primary contact fields via /api/schools/update
  const updateReqId = randomUUID();
  const updateRes = await h.post("/api/schools/update", {
    requestId: updateReqId,
    recordId: RECORD,
    expectedRequestId: VERSION,
    patch: {
      contactName: "Dr. Evelyn Reed",
      contactRole: "Principal Lead",
      email: "ereed@example.test",
      phone: "416-555-4321",
      notes: "Updated school notes",
    },
  }, ACTOR);

  assert.equal(updateRes.status, 200);
  assert.equal(updateRes.body.ok, true);

  // Verify Schools row projection E/F/G/O
  const schoolRow = h.sheets.tables.Schools.slice(1).find((r) => r[C.id] === RECORD);
  assert.equal(schoolRow[C.contactName], "Dr. Evelyn Reed");
  assert.equal(schoolRow[C.contactRole], "Principal Lead");
  assert.equal(schoolRow[C.email], "ereed@example.test");
  assert.equal(schoolRow[C.phone], "416-555-4321");
  assert.equal(schoolRow[C.notes], "Updated school notes");

  // Verify Contacts table synchronized the primary record
  const contactsAfter = h.sheets.tables.Contacts.slice(1);
  const primaryAfter = contactsAfter.find((c) => c[ContactCol.recordId] === RECORD && c[ContactCol.isPrimary] === "TRUE");
  assert.ok(primaryAfter);
  assert.equal(primaryAfter[ContactCol.id], primaryBefore[ContactCol.id], "Contact ID preserved");
  assert.equal(primaryAfter[ContactCol.name], "Dr. Evelyn Reed");
  assert.equal(primaryAfter[ContactCol.role], "Principal Lead");
  assert.equal(primaryAfter[ContactCol.email], "ereed@example.test");
  assert.equal(primaryAfter[ContactCol.phone], "416-555-4321");

  // 3. Non-contact update: changing priority and notes does not alter Contacts
  const nonContactReqId = randomUUID();
  const nonContactRes = await h.post("/api/schools/update", {
    requestId: nonContactReqId,
    recordId: RECORD,
    expectedRequestId: updateReqId,
    patch: {
      priority: "High",
      notes: "High priority follow-up needed",
    },
  }, ACTOR);

  assert.equal(nonContactRes.status, 200);
  const contactsAfterNonContact = h.sheets.tables.Contacts.slice(1);
  const primaryUnchanged = contactsAfterNonContact.find((c) => c[ContactCol.recordId] === RECORD && c[ContactCol.isPrimary] === "TRUE");
  assert.deepEqual(primaryUnchanged, primaryAfter, "Contacts record untouched by non-contact school edit");
});

test("student privacy: server strictly prohibits personal phone and consumer email for Student category", async (t) => {
  const h = await harness(t);

  // 1. Create student with phone -> rejected with 422 STUDENT_PHONE_FORBIDDEN
  const phoneRes = await h.post(CONTACTS_URL, {
    requestId: randomUUID(),
    recordId: RECORD,
    expectedRequestId: VERSION,
    action: "create",
    contact: {
      name: "Taylor Student",
      role: "Student Council Rep",
      category: "Student",
      phone: "416-555-0199",
      email: "taylor@schoolboard.ca",
    },
  }, ACTOR);
  assert.equal(phoneRes.status, 422);
  assert.equal(phoneRes.body.code, "STUDENT_PHONE_FORBIDDEN");

  // 2. Create student with consumer emails -> rejected with 422 STUDENT_PERSONAL_EMAIL_FORBIDDEN
  for (const personalEmail of ["taylor@gmail.com", "taylor@yahoo.com", "taylor@hotmail.com", "taylor@icloud.com", "taylor@proton.me"]) {
    const emailRes = await h.post(CONTACTS_URL, {
      requestId: randomUUID(),
      recordId: RECORD,
      expectedRequestId: VERSION,
      action: "create",
      contact: {
        name: "Taylor Student",
        role: "Student Council Rep",
        category: "Student",
        phone: "",
        email: personalEmail,
      },
    }, ACTOR);
    assert.equal(emailRes.status, 422);
    assert.equal(emailRes.body.code, "STUDENT_PERSONAL_EMAIL_FORBIDDEN");
  }

  // 3. Create student with valid school/board email and no phone -> 200 SUCCESS
  const validStudentReqId = randomUUID();
  const validStudentRes = await h.post(CONTACTS_URL, {
    requestId: validStudentReqId,
    recordId: RECORD,
    expectedRequestId: VERSION,
    action: "create",
    contact: {
      name: "Taylor Student",
      role: "Student Council Rep",
      category: "Student",
      phone: "",
      email: "taylor@tdsb.on.ca",
      isPrimary: false,
    },
  }, ACTOR);
  assert.equal(validStudentRes.status, 200);
  const studentContactId = validStudentRes.body.contact.contactId;

  // 4. Update student to add phone -> rejected
  const addPhoneRes = await h.post(CONTACTS_URL, {
    requestId: randomUUID(),
    recordId: RECORD,
    expectedRequestId: validStudentReqId,
    action: "update",
    contactId: studentContactId,
    contact: {
      phone: "416-555-9988",
    },
  }, ACTOR);
  assert.equal(addPhoneRes.status, 422);
  assert.equal(addPhoneRes.body.code, "STUDENT_PHONE_FORBIDDEN");

  // 5. Update student to add consumer email -> rejected
  const addConsumerEmailRes = await h.post(CONTACTS_URL, {
    requestId: randomUUID(),
    recordId: RECORD,
    expectedRequestId: validStudentReqId,
    action: "update",
    contactId: studentContactId,
    contact: {
      email: "taylor.personal@gmail.com",
    },
  }, ACTOR);
  assert.equal(addConsumerEmailRes.status, 422);
  assert.equal(addConsumerEmailRes.body.code, "STUDENT_PERSONAL_EMAIL_FORBIDDEN");

  // 6. Create teacher with phone and switch category to Student -> rejected
  const teacherReqId = randomUUID();
  const teacherRes = await h.post(CONTACTS_URL, {
    requestId: teacherReqId,
    recordId: RECORD,
    expectedRequestId: validStudentReqId,
    action: "create",
    contact: {
      name: "Mr. Davis",
      role: "Music Teacher",
      category: "Teacher",
      phone: "416-555-3322",
      email: "davis@schoolboard.ca",
      isPrimary: false,
    },
  }, ACTOR);
  assert.equal(teacherRes.status, 200);
  const teacherContactId = teacherRes.body.contact.contactId;

  // Changing category to Student while retaining teacher's phone fails
  const switchCategoryRes = await h.post(CONTACTS_URL, {
    requestId: randomUUID(),
    recordId: RECORD,
    expectedRequestId: teacherReqId,
    action: "update",
    contactId: teacherContactId,
    contact: {
      category: "Student",
    },
  }, ACTOR);
  assert.equal(switchCategoryRes.status, 422);
  assert.equal(switchCategoryRes.body.code, "STUDENT_PHONE_FORBIDDEN");

  // 7. /api/schools/update enforces student privacy when primary contact is Student
  // Set Taylor Student as primary
  const setPrimaryReqId = randomUUID();
  const setPrimaryRes = await h.post(CONTACTS_URL, {
    requestId: setPrimaryReqId,
    recordId: RECORD,
    expectedRequestId: teacherReqId,
    action: "set_primary",
    contactId: studentContactId,
  }, ACTOR);
  assert.equal(setPrimaryRes.status, 200);

  // Updating primary student contact with phone via /api/schools/update fails
  const schoolUpdatePhoneRes = await h.post("/api/schools/update", {
    requestId: randomUUID(),
    recordId: RECORD,
    expectedRequestId: setPrimaryReqId,
    patch: {
      phone: "416-555-7777",
    },
  }, ACTOR);
  assert.equal(schoolUpdatePhoneRes.status, 422);
  assert.equal(schoolUpdatePhoneRes.body.code, "STUDENT_PHONE_FORBIDDEN");

  // Updating primary student contact with consumer email via /api/schools/update fails
  const schoolUpdateEmailRes = await h.post("/api/schools/update", {
    requestId: randomUUID(),
    recordId: RECORD,
    expectedRequestId: setPrimaryReqId,
    patch: {
      email: "taylor@gmail.com",
    },
  }, ACTOR);
  assert.equal(schoolUpdateEmailRes.status, 422);
  assert.equal(schoolUpdateEmailRes.body.code, "STUDENT_PERSONAL_EMAIL_FORBIDDEN");
});

test("uncertain-write retry: contact operations retain same request ID and payload across uncertain failures", async (t) => {
  const h = await harness(t);

  // Set simulated fault: write committed upstream but ack lost
  h.sheets.fault = "lost-ack-unreconciled";
  const reqId = randomUUID();
  const payload = {
    requestId: reqId,
    recordId: RECORD,
    expectedRequestId: VERSION,
    action: "create",
    contact: {
      name: "Uncertain Contact",
      role: "Lab Tech",
      category: "Staff",
      email: "lab@example.test",
      phone: "416-555-8888",
      isPrimary: false,
    },
  };

  // 1. Initial attempt fails with 503 COMMIT_UNCERTAIN
  const res1 = await h.post(CONTACTS_URL, payload, ACTOR);
  assert.equal(res1.status, 503);
  assert.equal(res1.body.code, "COMMIT_UNCERTAIN");

  // 2. While blocked, a new operation with a DIFFERENT request ID is rejected
  const differentOp = await h.post(CONTACTS_URL, {
    ...payload,
    requestId: randomUUID(),
  }, ACTOR);
  assert.equal(differentOp.status, 503);
  assert.equal(differentOp.body.code, "WORKBOOK_BLOCKED");

  // 3. Supervisor reconciles the uncertain write
  const recon = await h.post("/api/operator/recovery", { requestId: reqId, action: "reconcile" }, SUPERVISOR);
  assert.equal(recon.status, 200);

  // 4. Safe retry with identical requestId and payload replays cleanly
  const retryRes = await h.post(CONTACTS_URL, payload, ACTOR);
  assert.equal(retryRes.status, 200);
  assert.equal(retryRes.body.requestId, reqId);
  assert.equal(retryRes.body.contact.name, "Uncertain Contact");

  // Contacts table contains exactly 1 row for Uncertain Contact (no duplicate)
  const matchingContacts = h.sheets.tables.Contacts.slice(1).filter((c) => c[ContactCol.name] === "Uncertain Contact");
  assert.equal(matchingContacts.length, 1);

  // 5. Reusing the resolved requestId with an altered payload is rejected
  const alteredRes = await h.post(CONTACTS_URL, {
    ...payload,
    contact: { ...payload.contact, name: "Altered Name" },
  }, ACTOR);
  assert.equal(alteredRes.status, 409);
  assert.equal(alteredRes.body.code, "REQUEST_ID_REUSED");
});

