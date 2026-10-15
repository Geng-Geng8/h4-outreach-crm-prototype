import test from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { readHarness, CLIENT, ACTOR, OTHER, SUPERVISOR } from "./read-only-harness.mjs";
import { C } from "./harness.mjs";

test("claim-to-test-spreadsheet: real writes are disabled by default", async (t) => {
  const h = await readHarness(t);
  const token = await h.token();
  const requestId = randomUUID();

  // Student attempts to claim an available directory school
  const result = await h.claimSchool(token, { osn: "900002", requestId });

  // Disabled by default: returns 503 REAL_WRITES_DISABLED
  assert.equal(result.status, 503);
  assert.equal(result.body.code, "REAL_WRITES_DISABLED");
  assert.equal(result.body.writesEnabled, false);
  assert.match(result.body.message, /Real spreadsheet writes are disabled by default/);

  // Workbook remains completely unchanged
  assert.equal(h.demoSheets.batches.length, 0);
  assert.equal(h.tables.Schools.filter((r) => r[C.osn] === "900002").length, 0);
});

test("claim-to-test-spreadsheet: unauthenticated, forged or inactive users are denied before write checks", async (t) => {
  const h = await readHarness(t);
  const requestId = randomUUID();

  // Missing Bearer token returns 405 READ_ONLY_MODE
  const unauth = await h.request("/api/schools/claim", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ osn: "900002", requestId }),
  });
  assert.equal(unauth.status, 405);
  assert.equal((await unauth.json()).code, "READ_ONLY_MODE");

  // Forged Google token returns 401 INVALID_GOOGLE_TOKEN
  const forged = await h.claimSchool("forged.jwt.token", { osn: "900002", requestId });
  assert.equal(forged.status, 401);
  assert.equal(forged.body.code, "INVALID_GOOGLE_TOKEN");

  // Unlisted user returns 403 USER_NOT_ALLOWED
  const unlistedToken = await h.token({ email: "unlisted@example.test" });
  const unlisted = await h.claimSchool(unlistedToken, { osn: "900002", requestId });
  assert.equal(unlisted.status, 403);
  assert.equal(unlisted.body.code, "USER_NOT_ALLOWED");

  // Inactive user returns 403 USER_NOT_ALLOWED
  const revokedToken = await h.token({ email: "revoked@example.test" });
  const revoked = await h.claimSchool(revokedToken, { osn: "900002", requestId });
  assert.equal(revoked.status, 403);
  assert.equal(revoked.body.code, "USER_NOT_ALLOWED");

  // No write was attempted
  assert.equal(h.demoSheets.batches.length, 0);
});

test("claim-to-test-spreadsheet: controlled write preserves authenticated ownership, Q/R formulas and atomic audit", async (t) => {
  // Controlled test setup with writes enabled
  const h = await readHarness(t, { ENABLE_REAL_WRITES: "true" });
  const token = await h.token(); // Alex (co-op)
  const requestId = randomUUID();

  const result = await h.claimSchool(token, { osn: "900002", requestId });
  assert.equal(result.status, 200);
  assert.equal(result.body.ok, true);
  assert.equal(result.body.code, "SUCCESS");

  const rec = result.body.record;
  // Authenticated ownership: ownerEmail bound to authenticated user
  assert.equal(rec.ownerEmail, ACTOR);
  assert.equal(rec.schoolName, "Example School 2");
  assert.equal(rec.stage, "Not Contacted");
  assert.equal(rec.lastRequestId, requestId);

  // Verify atomic batch was executed
  assert.equal(h.demoSheets.batches.length, 1);
  const batch = h.demoSheets.batches[0];
  assert.equal(batch.valueInputOption, "RAW");
  assert.equal(batch.data.length, 3); // Schools A..P, Schools S..AF, Activity Log

  // Verify Q and R formulas were preserved in the sheet
  const schoolRow = h.demoSheets.tables.Schools[2];
  assert.equal(schoolRow[C.osn], "900002");
  assert.equal(schoolRow[C.owner], ACTOR);
  assert.equal(schoolRow[C.assigned], "Alex");
  assert.equal(schoolRow[16], '=IF(A3="","","fixture follow-up formula")');
  assert.equal(schoolRow[17], '=IF(A3="","","fixture duplicate formula")');

  // Verify Activity Log entry was atomically appended with request ID marker in column L
  const activities = h.demoSheets.tables["Activity Log"].slice(1);
  assert.equal(activities.length, 1);
  const act = activities[0];
  assert.equal(act[2], "Example School 2");
  assert.equal(act[3], "Alex");
  assert.equal(act[4], "App");
  assert.equal(act[5], "Claimed");
  assert.equal(act[11], requestId); // Column L marker
  assert.equal(act[12], ACTOR);
  assert.equal(act[13], "Claimed");
});

test("claim-to-test-spreadsheet: server-computed availability and duplicate claim prevention", async (t) => {
  const h = await readHarness(t, { ENABLE_REAL_WRITES: "true" });
  const token = await h.token();

  // Attempting to claim an already claimed school (900001 is already claimed by Alex in fixture)
  const duplicate = await h.claimSchool(token, { osn: "900001", requestId: randomUUID() });
  assert.equal(duplicate.status, 409);
  assert.equal(duplicate.body.code, "SCHOOL_ALREADY_CLAIMED");

  // Attempting to claim a nonexistent school number
  const nonexistent = await h.claimSchool(token, { osn: "999999", requestId: randomUUID() });
  assert.equal(nonexistent.status, 422);
  assert.equal(nonexistent.body.code, "SCHOOL_UNAVAILABLE");

  // No batch was committed
  assert.equal(h.demoSheets.batches.length, 0);
});

test("claim-to-test-spreadsheet: idempotent retry with same requestId replays saved result without duplicating writes", async (t) => {
  const h = await readHarness(t, { ENABLE_REAL_WRITES: "true" });
  const token = await h.token();
  const requestId = randomUUID();

  // Initial claim
  const first = await h.claimSchool(token, { osn: "900002", requestId });
  assert.equal(first.status, 200);
  assert.equal(h.demoSheets.batches.length, 1);
  assert.equal(h.demoSheets.tables["Activity Log"].slice(1).length, 1);

  // Identical retry with same requestId and payload
  const retry = await h.claimSchool(token, { osn: "900002", requestId });
  assert.equal(retry.status, 200);
  assert.equal(retry.body.replayed, true);
  assert.equal(retry.body.record.recordId, first.body.record.recordId);

  // Still exactly 1 batch and 1 activity row (zero duplicate writes)
  assert.equal(h.demoSheets.batches.length, 1);
  assert.equal(h.demoSheets.tables["Activity Log"].slice(1).length, 1);

  // Reusing the same requestId with a different OSN returns 409 REQUEST_ID_REUSED
  const reused = await h.claimSchool(token, { osn: "900003", requestId });
  assert.equal(reused.status, 409);
  assert.equal(reused.body.code, "REQUEST_ID_REUSED");
});

test("claim-to-test-spreadsheet: two students racing to claim the same school get exactly one success", async (t) => {
  const h = await readHarness(t, { ENABLE_REAL_WRITES: "true" });
  const alexToken = await h.token({ email: ACTOR });
  const samToken = await h.token({ email: OTHER, sub: "fixture-sam-subject" });

  const [res1, res2] = await Promise.all([
    h.claimSchool(alexToken, { osn: "900002", requestId: randomUUID() }),
    h.claimSchool(samToken, { osn: "900002", requestId: randomUUID() }),
  ]);

  const statuses = [res1.status, res2.status].sort();
  assert.deepEqual(statuses, [200, 409]);
  const failed = res1.status === 409 ? res1 : res2;
  assert.equal(failed.body.code, "SCHOOL_ALREADY_CLAIMED");

  // Exactly one school claimed and one activity row recorded
  assert.equal(h.demoSheets.tables.Schools.filter((r) => r[C.osn] === "900002").length, 1);
  assert.equal(h.demoSheets.tables["Activity Log"].slice(1).length, 1);
});

test("claim-to-test-spreadsheet: uncertain-write recovery on test spreadsheet", async (t) => {
  const h = await readHarness(t, { ENABLE_REAL_WRITES: "true" });
  const token = await h.token();
  const requestId = randomUUID();

  // Inject a lost-acknowledgement failure
  h.demoSheets.fault = "lost-ack-unreconciled";
  const uncertain = await h.claimSchool(token, { osn: "900002", requestId });
  assert.equal(uncertain.status, 503);
  assert.equal(uncertain.body.code, "COMMIT_UNCERTAIN");
  assert.equal(uncertain.body.requestId, requestId);

  // Next write attempt is blocked
  const blocked = await h.claimSchool(token, { osn: "900003", requestId: randomUUID() });
  assert.equal(blocked.status, 503);
  assert.equal(blocked.body.code, "WORKBOOK_BLOCKED");

  // The school was committed upstream and is visible in the workbook
  assert.equal(h.demoSheets.tables.Schools.filter((r) => r[C.osn] === "900002").length, 1);
  assert.equal(h.demoSheets.tables["Activity Log"].slice(1).filter((r) => r[11] === requestId).length, 1);
});
