import test from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { harness, C, ACTOR, OTHER, SUPERVISOR, RECORD, VERSION } from "./harness.mjs";

const REASSIGN = "/api/schools/reassign";
const UNCLAIM = "/api/schools/unclaim";
const CLAIM = "/api/schools/claim";
const DETAIL = "/api/schools/detail";

test("co-assignee collaboration: school with multiple owners allows access to all assigned co-owners and supervisor, but denies non-owners", async (t) => {
  const h = await harness(t);
  // Set school to have multiple owners: Alex and Sam
  h.sheets.tables.Schools[1][C.owner] = `${ACTOR}, ${OTHER}`;
  h.sheets.tables.Schools[1][C.assigned] = "Alex, Sam";

  // Both Alex and Sam can access school details
  const alexRes = await h.get(`${DETAIL}?recordId=${RECORD}`, ACTOR);
  assert.equal(alexRes.status, 200);
  assert.equal(alexRes.body.ok, true);
  assert.equal(alexRes.body.record.ownerEmail, `${ACTOR}, ${OTHER}`);
  assert.equal(alexRes.body.record.assignedTo, "Alex, Sam");
  assert.ok(Array.isArray(alexRes.body.users));
  assert.ok(alexRes.body.users.length >= 2);

  const samRes = await h.get(`${DETAIL}?recordId=${RECORD}`, OTHER);
  assert.equal(samRes.status, 200);
  assert.equal(samRes.body.ok, true);

  // Supervisor can also access
  const supervisorRes = await h.get(`${DETAIL}?recordId=${RECORD}`, SUPERVISOR);
  assert.equal(supervisorRes.status, 200);

  // A third student not on the school cannot access
  // Temporarily make thirdActor an active student in CRM Users for this test
  h.sheets.tables["CRM Users"][4] = ["third@example.test", "Third Student", "co-op", true];
  const thirdRes = await h.get(`${DETAIL}?recordId=${RECORD}`, "third@example.test");
  assert.equal(thirdRes.status, 403);
  assert.equal(thirdRes.body.code, "NOT_OWNER");
});

test("reassign endpoint: updates Column D, Column Z, appends Activity Log row, and protects Column Q/R formulas", async (t) => {
  const h = await harness(t);
  const qFormula = h.sheets.tables.Schools[1][16];
  const rFormula = h.sheets.tables.Schools[1][17];

  const reqId = randomUUID();
  const reassignRes = await h.post(REASSIGN, {
    requestId: reqId,
    recordId: RECORD,
    expectedRequestId: VERSION,
    newOwnerEmails: [OTHER, SUPERVISOR],
    newOwnerNames: ["Sam", "Morgan"],
  }, ACTOR);

  assert.equal(reassignRes.status, 200);
  assert.equal(reassignRes.body.ok, true);
  assert.equal(reassignRes.body.record.assignedTo, "Sam, Morgan");
  assert.equal(reassignRes.body.record.ownerEmail, `${OTHER}, ${SUPERVISOR}`);
  assert.equal(reassignRes.body.record.lastRequestId, reqId);

  // Verify spreadsheet columns
  const updatedRow = h.sheets.tables.Schools[1];
  assert.equal(updatedRow[C.assigned], "Sam, Morgan");
  assert.equal(updatedRow[C.owner], `${OTHER}, ${SUPERVISOR}`);
  assert.equal(updatedRow[C.version], reqId);
  // Column Q and R formulas must be preserved
  assert.equal(updatedRow[16], qFormula);
  assert.equal(updatedRow[17], rFormula);

  // Verify Activity Log audit entry
  const logs = h.sheets.tables["Activity Log"].slice(1);
  assert.equal(logs.length, 1);
  const log = logs[0];
  assert.equal(log[4], "App"); // Channel (Col E, index 4)
  assert.equal(log[5], "Reassigned"); // Outcome (Col F, index 5)
  assert.equal(log[7], "Reassigned to Sam, Morgan"); // Summary (Col H, index 7)
  assert.equal(log[11], reqId); // Request ID (Col L, index 11)
  assert.equal(log[12], ACTOR); // Actor Email (Col M, index 12)
  assert.equal(log[13], "Reassign"); // Activity Type (Col N, index 13)
});

test("reassign endpoint: enforces permissions (Supervisor can reassign any; non-owner is rejected) and checks stale version", async (t) => {
  const h = await harness(t);

  // Non-owner student cannot reassign
  const nonOwnerRes = await h.post(REASSIGN, {
    requestId: randomUUID(),
    recordId: RECORD,
    expectedRequestId: VERSION,
    newOwnerEmails: [OTHER],
    newOwnerNames: ["Sam"],
  }, OTHER);
  assert.equal(nonOwnerRes.status, 403);
  assert.equal(nonOwnerRes.body.code, "NOT_OWNER");

  // Stale version is rejected with 409
  const staleRes = await h.post(REASSIGN, {
    requestId: randomUUID(),
    recordId: RECORD,
    expectedRequestId: "00000000-0000-4000-8000-000000000099",
    newOwnerEmails: [OTHER],
    newOwnerNames: ["Sam"],
  }, ACTOR);
  assert.equal(staleRes.status, 409);
  assert.equal(staleRes.body.code, "CONFLICT_STALE_VERSION");

  // Supervisor can reassign any school
  const supRes = await h.post(REASSIGN, {
    requestId: randomUUID(),
    recordId: RECORD,
    expectedRequestId: VERSION,
    newOwnerEmails: [OTHER],
    newOwnerNames: ["Sam"],
  }, SUPERVISOR);
  assert.equal(supRes.status, 200);
  assert.equal(supRes.body.ok, true);
  assert.equal(h.sheets.tables.Schools[1][C.owner], OTHER);
});

test("unclaim endpoint: clears ownership, resets stage and engagementStatus, clears followUp, logs audit, and preserves Q/R", async (t) => {
  const h = await harness(t);
  const qFormula = h.sheets.tables.Schools[1][16];
  const rFormula = h.sheets.tables.Schools[1][17];

  // Set some follow-up and count first
  h.sheets.tables.Schools[1][C.stage] = "Contacted";
  h.sheets.tables.Schools[1][C.due] = "2026-11-01";
  h.sheets.tables.Schools[1][C.count] = 2;
  h.sheets.tables.Schools[1][C.action] = "Call back";

  const reqId = randomUUID();
  const unclaimRes = await h.post(UNCLAIM, {
    requestId: reqId,
    recordId: RECORD,
    expectedRequestId: VERSION,
  }, ACTOR);

  assert.equal(unclaimRes.status, 200);
  assert.equal(unclaimRes.body.ok, true);

  const row = h.sheets.tables.Schools[1];
  assert.equal(row[C.assigned], "");
  assert.equal(row[C.owner], "");
  assert.equal(row[C.stage], "Not Contacted");
  assert.equal(row[C.engagementStatus], "Available");
  assert.equal(row[C.due], "");
  assert.equal(row[C.count], 0);
  assert.equal(row[C.action], "");
  assert.equal(row[C.version], reqId);

  // Q/R formulas intact
  assert.equal(row[16], qFormula);
  assert.equal(row[17], rFormula);

  // Activity Log audit
  const logs = h.sheets.tables["Activity Log"].slice(1);
  assert.equal(logs.length, 1);
  const log = logs[0];
  assert.equal(log[4], "App");
  assert.equal(log[5], "Unclaimed");
  assert.equal(log[7], "School released back to directory by Alex");
  assert.equal(log[11], reqId);
  assert.equal(log[12], ACTOR);
  assert.equal(log[13], "Unclaim");
});

test("unclaim endpoint: enforces permissions (Supervisor allowed; non-owner denied) and stale version conflict", async (t) => {
  const h = await harness(t);

  // Non-owner cannot unclaim
  const nonOwnerRes = await h.post(UNCLAIM, {
    requestId: randomUUID(),
    recordId: RECORD,
    expectedRequestId: VERSION,
  }, OTHER);
  assert.equal(nonOwnerRes.status, 403);
  assert.equal(nonOwnerRes.body.code, "NOT_OWNER");

  // Stale version rejected
  const staleRes = await h.post(UNCLAIM, {
    requestId: randomUUID(),
    recordId: RECORD,
    expectedRequestId: "00000000-0000-4000-8000-000000000099",
  }, ACTOR);
  assert.equal(staleRes.status, 409);
  assert.equal(staleRes.body.code, "CONFLICT_STALE_VERSION");

  // Supervisor can unclaim
  const supRes = await h.post(UNCLAIM, {
    requestId: randomUUID(),
    recordId: RECORD,
    expectedRequestId: VERSION,
  }, SUPERVISOR);
  assert.equal(supRes.status, 200);
  assert.equal(h.sheets.tables.Schools[1][C.owner], "");
  assert.equal(h.sheets.tables.Schools[1][C.engagementStatus], "Available");
});

test("unclaimed school flow end-to-end: unclaim releases school to directory and allows re-claiming", async (t) => {
  const h = await harness(t);
  const osn = "900001"; // Maple Example Secondary
  assert.equal(h.sheets.tables.Schools[1][C.osn], osn);

  // Check demo-status: initially claimed
  const statusBefore = await h.get("/api/schools/demo-status", ACTOR);
  assert.equal(statusBefore.status, 200);
  assert.ok(statusBefore.body.claimedOsns.includes(osn));

  // Unclaim the school
  const unclaimReqId = randomUUID();
  const unclaimRes = await h.post(UNCLAIM, {
    requestId: unclaimReqId,
    recordId: RECORD,
    expectedRequestId: VERSION,
  }, ACTOR);
  assert.equal(unclaimRes.status, 200);

  // Check demo-status: now available!
  const statusAfter = await h.get("/api/schools/demo-status", ACTOR);
  assert.equal(statusAfter.status, 200);
  assert.equal(statusAfter.body.claimedOsns.includes(osn), false);

  // Re-claim the school as Sam
  const claimReqId = randomUUID();
  const claimRes = await h.post(CLAIM, {
    requestId: claimReqId,
    osn,
  }, OTHER);
  assert.equal(claimRes.status, 200);
  assert.equal(claimRes.body.ok, true);

  // Verify the row in Schools was re-claimed by Sam
  const reclaimedRow = h.sheets.tables.Schools[1];
  assert.equal(reclaimedRow[C.osn], osn);
  assert.equal(reclaimedRow[C.assigned], "Sam");
  assert.equal(reclaimedRow[C.owner], OTHER);
  assert.equal(reclaimedRow[C.engagementStatus], "Claimed");
  assert.equal(reclaimedRow[C.stage], "Not Contacted");
});
