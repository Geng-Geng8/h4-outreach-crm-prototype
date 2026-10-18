import test from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { harness, C, ACTOR, OTHER, SUPERVISOR, RECORD, VERSION } from "./harness.mjs";
import { ContactCol, ActivityCol } from "../src/schema.ts";

const ACTIVITY_URL = "/api/activities";
const CONTACTS_URL = "/api/schools/contacts";
const RECOVERY_URL = "/api/operator/recovery";

// Helper to add contacts for testing
async function addContact(h, recordId, expectedVersion, name, role, isPrimary = false) {
  const reqId = randomUUID();
  const res = await h.post(CONTACTS_URL, {
    requestId: reqId,
    recordId,
    expectedRequestId: expectedVersion,
    action: "create",
    contact: {
      name,
      role,
      category: "Teacher",
      email: `${name.toLowerCase().replace(/\s+/g, ".")}@example.test`,
      phone: "416-555-0199",
      isPrimary,
    },
  }, ACTOR);
  assert.equal(res.status, 200, `Failed to add contact ${name}`);
  return { contact: res.body.contact, nextVersion: res.body.record.lastRequestId };
}

test("multi-contact outreach: zero contacts with empty array sets General School Outreach and empty Column P", async (t) => {
  const h = await harness(t);
  const reqId = randomUUID();

  const res = await h.post(ACTIVITY_URL, {
    requestId: reqId,
    recordId: RECORD,
    expectedRequestId: VERSION,
    channel: "Email",
    activityType: "Outreach",
    outcome: "Sent email to general inbox",
    summary: "Sent introductory email to school office inbox.",
    contactIds: [],
    stage: "Contacted",
  }, ACTOR);

  assert.equal(res.status, 200);
  assert.equal(res.body.ok, true);

  // Exactly 1 Activity Log row
  const activities = h.sheets.tables["Activity Log"].slice(1);
  assert.equal(activities.length, 1);
  const act = activities[0];

  assert.equal(act[ActivityCol.requestId], reqId);
  assert.equal(act[ActivityCol.relatedRecordId], RECORD);
  assert.equal(act[ActivityCol.contactedPerson], "General School Outreach");
  assert.equal(act[ActivityCol.contactIds], "");
  assert.equal(act.length, 16);

  // Follow-up count unchanged for Outreach
  assert.equal(h.sheets.tables.Schools[1][C.count], 0);
  assert.equal(h.sheets.tables.Schools[1][C.stage], "Contacted");
});

test("multi-contact outreach: omitted contactIds (legacy/bulk) preserves primary contact name and empty Column P", async (t) => {
  const h = await harness(t);
  const reqId = randomUUID();

  const res = await h.post(ACTIVITY_URL, {
    requestId: reqId,
    recordId: RECORD,
    expectedRequestId: VERSION,
    channel: "Phone",
    activityType: "Outreach",
    outcome: "Spoke with front desk",
    summary: "Called school main phone line.",
  }, ACTOR);

  assert.equal(res.status, 200);
  const act = h.sheets.tables["Activity Log"].slice(1)[0];
  assert.equal(act[ActivityCol.requestId], reqId);
  // Falls back to primary contact name and role
  assert.equal(act[ActivityCol.contactedPerson], "Jane Smith (Principal)");
  assert.equal(act[ActivityCol.contactIds], "");
  assert.equal(act.length, 16);
});

test("multi-contact outreach: single selected contact sets human-readable name and single UUID", async (t) => {
  const h = await harness(t);
  const janeContactId = "00000000-0000-4000-9000-000000000001";
  const reqId = randomUUID();

  const res = await h.post(ACTIVITY_URL, {
    requestId: reqId,
    recordId: RECORD,
    expectedRequestId: VERSION,
    channel: "Email",
    activityType: "Outreach",
    outcome: "Sent email",
    summary: "Emailed principal about upcoming dance mentorship.",
    contactIds: [janeContactId],
  }, ACTOR);

  assert.equal(res.status, 200);
  const activities = h.sheets.tables["Activity Log"].slice(1);
  assert.equal(activities.length, 1);
  const act = activities[0];

  assert.equal(act[ActivityCol.contactedPerson], "Jane Smith (Principal)");
  assert.equal(act[ActivityCol.contactIds], janeContactId);
  assert.equal(act.length, 16);
});

test("multi-contact outreach: multiple contacts (e.g. Principal, Dance Teacher, Leadership Teacher) logs one row with linked IDs", async (t) => {
  const h = await harness(t);
  const janeId = "00000000-0000-4000-9000-000000000001"; // Jane Smith (Principal)

  // Add Michael Lee (Dance Teacher)
  const { contact: michael, nextVersion: v2 } = await addContact(h, RECORD, VERSION, "Michael Lee", "Dance Teacher");
  // Add Jessica Cruz (Leadership Teacher)
  const { contact: jessica, nextVersion: v3 } = await addContact(h, RECORD, v2, "Jessica Cruz", "Leadership Teacher");

  const reqId = randomUUID();
  const res = await h.post(ACTIVITY_URL, {
    requestId: reqId,
    recordId: RECORD,
    expectedRequestId: v3,
    channel: "Email",
    activityType: "Outreach",
    outcome: "Sent group email",
    summary: "Emailed principal, dance teacher, and leadership teacher introducing H4 programs.",
    contactIds: [janeId, michael.contactId, jessica.contactId],
    stage: "Contacted",
  }, ACTOR);

  assert.equal(res.status, 200);
  assert.equal(res.body.ok, true);

  // Exactly ONE activity log row created for this outreach
  const activities = h.sheets.tables["Activity Log"].slice(1).filter((r) => r[ActivityCol.relatedRecordId] === RECORD && r[ActivityCol.activityType] === "Outreach");
  assert.equal(activities.length, 1);
  const act = activities[0];

  // Column G: human-readable contact names and roles
  assert.equal(
    act[ActivityCol.contactedPerson],
    "Jane Smith (Principal), Michael Lee (Dance Teacher), Jessica Cruz (Leadership Teacher)",
  );

  // Column P: comma-separated contact UUIDs
  assert.equal(
    act[ActivityCol.contactIds],
    `${janeId},${michael.contactId},${jessica.contactId}`,
  );
  assert.equal(act.length, 16);

  // Outreach activity type: follow-up count is not incremented
  assert.equal(h.sheets.tables.Schools[1][C.count], 0);
});

test("multi-contact follow-up increments school follow-up count exactly once, not once per contact", async (t) => {
  const h = await harness(t);
  const janeId = "00000000-0000-4000-9000-000000000001";
  const { contact: michael, nextVersion: v2 } = await addContact(h, RECORD, VERSION, "Michael Lee", "Dance Teacher");

  assert.equal(h.sheets.tables.Schools[1][C.count], 0);

  const reqId = randomUUID();
  const res = await h.post(ACTIVITY_URL, {
    requestId: reqId,
    recordId: RECORD,
    expectedRequestId: v2,
    channel: "Email",
    activityType: "FollowUp",
    outcome: "Followed up with both",
    summary: "Checking in on workshop scheduling with principal and dance teacher.",
    contactIds: [janeId, michael.contactId],
  }, ACTOR);

  assert.equal(res.status, 200);
  // Follow-up count incremented by 1 (NOT 2)
  assert.equal(h.sheets.tables.Schools[1][C.count], 1);

  // Exactly one Activity Log row created
  const activities = h.sheets.tables["Activity Log"].slice(1).filter((r) => r[ActivityCol.requestId] === reqId);
  assert.equal(activities.length, 1);
  assert.equal(activities[0][ActivityCol.contactedPerson], "Jane Smith (Principal), Michael Lee (Dance Teacher)");
  assert.equal(activities[0][ActivityCol.contactIds], `${janeId},${michael.contactId}`);
});

test("multi-contact validation: rejects invalid UUID, non-existent, inactive, duplicate, and cross-school contacts", async (t) => {
  const h = await harness(t);
  const janeId = "00000000-0000-4000-9000-000000000001";

  // 1. Invalid UUID format
  const badUuidRes = await h.post(ACTIVITY_URL, {
    requestId: randomUUID(),
    recordId: RECORD,
    expectedRequestId: VERSION,
    channel: "Email",
    activityType: "Outreach",
    outcome: "Test",
    summary: "Test",
    contactIds: ["not-a-uuid"],
  }, ACTOR);
  assert.equal(badUuidRes.status, 422);
  assert.equal(badUuidRes.body.code, "INVALID_CONTACT_ID");

  // 2. Non-existent contact ID
  const missingRes = await h.post(ACTIVITY_URL, {
    requestId: randomUUID(),
    recordId: RECORD,
    expectedRequestId: VERSION,
    channel: "Email",
    activityType: "Outreach",
    outcome: "Test",
    summary: "Test",
    contactIds: [randomUUID()],
  }, ACTOR);
  assert.equal(missingRes.status, 404);
  assert.equal(missingRes.body.code, "CONTACT_NOT_FOUND");

  // 3. Duplicate contact IDs
  const dupRes = await h.post(ACTIVITY_URL, {
    requestId: randomUUID(),
    recordId: RECORD,
    expectedRequestId: VERSION,
    channel: "Email",
    activityType: "Outreach",
    outcome: "Test",
    summary: "Test",
    contactIds: [janeId, janeId],
  }, ACTOR);
  assert.equal(dupRes.status, 422);
  assert.equal(dupRes.body.code, "DUPLICATE_CONTACT_IDS");

  // 4. Inactive contact ID
  const inactiveId = randomUUID();
  h.sheets.tables.Contacts.push([
    inactiveId, RECORD, "Maple Example Secondary", "Old Contact", "Former VP",
    "Administration", "", "", "former@example.test", "", "", "FALSE", "FALSE", "2026-10-15",
  ]);
  const inactiveRes = await h.post(ACTIVITY_URL, {
    requestId: randomUUID(),
    recordId: RECORD,
    expectedRequestId: VERSION,
    channel: "Email",
    activityType: "Outreach",
    outcome: "Test",
    summary: "Test",
    contactIds: [inactiveId],
  }, ACTOR);
  assert.equal(inactiveRes.status, 422);
  assert.equal(inactiveRes.body.code, "INACTIVE_CONTACT_FORBIDDEN");

  // 5. Cross-school contact ID
  const otherSchoolRecordId = "00000000-0000-4000-8000-000000000002";
  const crossContactId = randomUUID();
  h.sheets.tables.Contacts.push([
    crossContactId, otherSchoolRecordId, "Other Secondary", "Other Person", "Principal",
    "Administration", "", "", "other@example.test", "", "", "TRUE", "TRUE", "2026-10-15",
  ]);
  const crossRes = await h.post(ACTIVITY_URL, {
    requestId: randomUUID(),
    recordId: RECORD,
    expectedRequestId: VERSION,
    channel: "Email",
    activityType: "Outreach",
    outcome: "Test",
    summary: "Test",
    contactIds: [crossContactId],
  }, ACTOR);
  assert.equal(crossRes.status, 422);
  assert.equal(crossRes.body.code, "CROSS_SCHOOL_CONTACT_FORBIDDEN");

  // 6. Invalid contactIds type (not an array)
  const badTypeRes = await h.post(ACTIVITY_URL, {
    requestId: randomUUID(),
    recordId: RECORD,
    expectedRequestId: VERSION,
    channel: "Email",
    activityType: "Outreach",
    outcome: "Test",
    summary: "Test",
    contactIds: "not-an-array",
  }, ACTOR);
  assert.equal(badTypeRes.status, 422);
  assert.equal(badTypeRes.body.code, "INVALID_CONTACT_IDS");
});

test("permissions: non-owner student cannot log outreach; Supervisor can log outreach", async (t) => {
  const h = await harness(t);
  const janeId = "00000000-0000-4000-9000-000000000001";

  // Non-owner student OTHER is rejected
  const denied = await h.post(ACTIVITY_URL, {
    requestId: randomUUID(),
    recordId: RECORD,
    expectedRequestId: VERSION,
    channel: "Email",
    activityType: "Outreach",
    outcome: "Test",
    summary: "Test",
    contactIds: [janeId],
  }, OTHER);
  assert.equal(denied.status, 403);
  assert.equal(denied.body.code, "NOT_OWNER");

  // Supervisor is allowed
  const supReq = randomUUID();
  const allowed = await h.post(ACTIVITY_URL, {
    requestId: supReq,
    recordId: RECORD,
    expectedRequestId: VERSION,
    channel: "Email",
    activityType: "Outreach",
    outcome: "Supervisor outreach",
    summary: "Supervisor checking on partnership.",
    contactIds: [janeId],
  }, SUPERVISOR);
  assert.equal(allowed.status, 200);
  assert.equal(allowed.body.ok, true);
});

test("preservation of historical 15-column Activity Log rows: older rows remain intact", async (t) => {
  const h = await harness(t);
  const historicalReq = randomUUID();

  // Add historical 15-column row into Activity Log
  h.sheets.tables["Activity Log"].push([
    randomUUID(), "2026-10-10", "Maple Example Secondary", "Alex", "Email",
    "Left voicemail", "Jane Smith (Principal)", "Historical outreach before PR 12",
    "Follow up next week", "2026-10-18", RECORD, historicalReq, ACTOR, "Outreach", "App",
  ]);
  assert.equal(h.sheets.tables["Activity Log"][1].length, 15);

  // New multi-contact outreach appends row with 16 columns
  const janeId = "00000000-0000-4000-9000-000000000001";
  const newReq = randomUUID();
  const res = await h.post(ACTIVITY_URL, {
    requestId: newReq,
    recordId: RECORD,
    expectedRequestId: VERSION,
    channel: "Email",
    activityType: "Outreach",
    outcome: "Followed up",
    summary: "Follow up message with new 16-column format.",
    contactIds: [janeId],
  }, ACTOR);

  assert.equal(res.status, 200);

  // Both rows exist
  const activities = h.sheets.tables["Activity Log"].slice(1);
  assert.equal(activities.length, 2);

  // Historical row preserved with 15 columns
  assert.equal(activities[0][ActivityCol.requestId], historicalReq);
  assert.equal(activities[0].length, 15);

  // New row has 16 columns
  assert.equal(activities[1][ActivityCol.requestId], newReq);
  assert.equal(activities[1].length, 16);
  assert.equal(activities[1][ActivityCol.contactIds], janeId);
});

test("safe retries: replaying identical multi-contact outreach returns replayed: true without duplicating activity", async (t) => {
  const h = await harness(t);
  const janeId = "00000000-0000-4000-9000-000000000001";
  const reqId = randomUUID();

  const payload = {
    requestId: reqId,
    recordId: RECORD,
    expectedRequestId: VERSION,
    channel: "Email",
    activityType: "Outreach",
    outcome: "Initial email",
    summary: "Initial outreach to principal.",
    contactIds: [janeId],
  };

  const first = await h.post(ACTIVITY_URL, payload, ACTOR);
  assert.equal(first.status, 200);
  assert.equal(first.body.replayed, undefined);

  // Replay identical request
  const retry = await h.post(ACTIVITY_URL, payload, ACTOR);
  assert.equal(retry.status, 200);
  assert.equal(retry.body.replayed, true);

  // Exactly 1 activity row in sheet
  const matches = h.sheets.tables["Activity Log"].slice(1).filter((r) => r[ActivityCol.requestId] === reqId);
  assert.equal(matches.length, 1);
});

test("uncertain-write recovery: reconciles committed 16-column activity after lost acknowledgement", async (t) => {
  const h = await harness(t);
  const janeId = "00000000-0000-4000-9000-000000000001";
  const reqId = randomUUID();

  // Inject lost-ack fault: write succeeds in sheet, but response is 503
  h.sheets.fault = "lost-ack";

  const payload = {
    requestId: reqId,
    recordId: RECORD,
    expectedRequestId: VERSION,
    channel: "Email",
    activityType: "Outreach",
    outcome: "Uncertain write",
    summary: "Simulated network timeout after write committed.",
    contactIds: [janeId],
  };

  const lost = await h.post(ACTIVITY_URL, payload, ACTOR);
  assert.equal(lost.status, 200); // Reconciled automatically via snapshot check!

  // Workbook is not blocked and has exactly 1 activity row
  const activities = h.sheets.tables["Activity Log"].slice(1).filter((r) => r[ActivityCol.requestId] === reqId);
  assert.equal(activities.length, 1);
  assert.equal(activities[0][ActivityCol.contactIds], janeId);
  assert.equal(activities[0].length, 16);
});
