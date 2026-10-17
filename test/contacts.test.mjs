import test from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { harness, C, ACTOR, OTHER, SUPERVISOR, RECORD, VERSION } from "./harness.mjs";
import { ContactCol, HEADERS } from "../src/schema.ts";
import { planMigration } from "../scripts/migrate-contacts.mjs";

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

