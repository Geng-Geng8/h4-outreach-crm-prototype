import test from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { harness, C, ACTOR, OTHER, SUPERVISOR, RECORD, VERSION } from "./harness.mjs";

const CLAIM = "/api/schools/claim";
const UPDATE = "/api/schools/update";
const RECOVERY = "/api/operator/recovery";
const claim = (osn = "900002") => ({ requestId: randomUUID(), osn });
const update = (notes = "Updated fixture note", version = VERSION) => ({
  requestId: randomUUID(), recordId: RECORD, expectedRequestId: version, patch: { notes },
});
const logs = (h) => h.sheets.tables["Activity Log"].slice(1);
const schoolRows = (h) => h.sheets.tables.Schools.slice(1).filter((row) => row[C.id]);

test("operator recovery 1: write committed but response was lost reconciles without duplicating write", async (t) => {
  const h = await harness(t);
  h.sheets.fault = "lost-ack-unreconciled";
  const input = claim("900002");
  const uncertain = await h.post(CLAIM, input);
  assert.equal(uncertain.status, 503);
  assert.equal(uncertain.body.code, "COMMIT_UNCERTAIN");
  assert.equal(uncertain.body.requestId, input.requestId);

  // 1. Inspect evidence explaining why writes are blocked
  const inspection = await h.get(RECOVERY, SUPERVISOR);
  assert.equal(inspection.status, 200);
  assert.equal(inspection.body.ok, true);
  assert.equal(inspection.body.blocked, true);
  assert.equal(inspection.body.pendingOperation.requestId, input.requestId);
  assert.equal(inspection.body.evidence.status, "CONFIRMED_COMMITTED");
  assert.equal(inspection.body.evidence.reconcilable, true);
  assert.equal(inspection.body.evidence.activityMarkerCount, 1);
  assert.ok(inspection.body.evidence.explanation.includes("committed upstream"));

  // 2. Competing writes are blocked
  const blocked = await h.post(CLAIM, claim("900003"), OTHER);
  assert.equal(blocked.status, 503);
  assert.equal(blocked.body.code, "WORKBOOK_BLOCKED");
  assert.equal(blocked.body.pendingRequestId, input.requestId);

  // 3. Reconcile confirmed committed operation
  const reconciliation = await h.post(RECOVERY, { requestId: input.requestId, action: "reconcile" }, SUPERVISOR);
  assert.equal(reconciliation.status, 200);
  assert.equal(reconciliation.body.ok, true);
  assert.equal(reconciliation.body.code, "RECONCILED_COMMITTED");
  assert.equal(reconciliation.body.blocked, false);

  // 4. Client replay returns saved result without second write
  const replay = await h.post(CLAIM, input);
  assert.equal(replay.status, 200);
  assert.equal(replay.body.replayed, true);
  assert.equal(h.sheets.attempts, 1, "Replay must never duplicate upstream writes");
  assert.equal(logs(h).length, 1);

  // 5. Subsequent writes now succeed normally
  const nextClaim = await h.post(CLAIM, claim("900003"), OTHER);
  assert.equal(nextClaim.status, 200);
  assert.equal(h.sheets.attempts, 2);
  assert.equal(logs(h).length, 2);
});

test("operator recovery 2: write definitely rejected leaves sheet unchanged and workbook unblocked", async (t) => {
  const h = await harness(t);
  const before = structuredClone(h.sheets.tables);
  h.sheets.fault = "reject";
  const input = update("Test rejection");

  const result = await h.post(UPDATE, input);
  assert.equal(result.status, 502);
  assert.equal(result.body.code, "SHEETS_REJECTED");
  assert.deepEqual(h.sheets.tables, before, "Rejected batch must not alter sheet data");

  // Inspection confirms workbook is NOT blocked
  const inspection = await h.get(RECOVERY, SUPERVISOR);
  assert.equal(inspection.status, 200);
  assert.equal(inspection.body.blocked, false);
  assert.equal(inspection.body.pendingOperation, null);
  assert.equal(inspection.body.lastOperation?.state, "rejected");

  // Subsequent writes succeed immediately
  const subsequent = await h.post(UPDATE, update("Subsequent success"));
  assert.equal(subsequent.status, 200);

  // Replay of the rejected request replays rejection
  const replay = await h.post(UPDATE, input);
  assert.equal(replay.status, 502);
  assert.equal(replay.body.replayed, true);
});

test("operator recovery 3: conflicting or incomplete evidence keeps writes blocked and forbids force-unlock", async (t) => {
  const h = await harness(t);
  h.sheets.fault = "unconfirmed";
  const input = claim("900002");
  const uncertain = await h.post(CLAIM, input);
  assert.equal(uncertain.status, 503);

  // Case A: Absent marker — evidence explains why writes remain blocked
  const absentCheck = await h.get(RECOVERY, SUPERVISOR);
  assert.equal(absentCheck.status, 200);
  assert.equal(absentCheck.body.blocked, true);
  assert.equal(absentCheck.body.evidence.status, "ABSENT_UNRESOLVED");
  assert.equal(absentCheck.body.evidence.reconcilable, false);

  // Reconcile attempt fails closed
  const reconcileFail = await h.post(RECOVERY, { requestId: input.requestId, action: "reconcile" }, SUPERVISOR);
  assert.equal(reconcileFail.status, 409);
  assert.equal(reconcileFail.body.code, "RECONCILIATION_REFUSED");
  assert.equal(reconcileFail.body.blocked, true);

  // Blind force-unlock is strictly forbidden
  const forceUnlock = await h.post(RECOVERY, { action: "force_unlock" }, SUPERVISOR);
  assert.equal(forceUnlock.status, 403);
  assert.equal(forceUnlock.body.code, "BLIND_FORCE_UNLOCK_FORBIDDEN");
  assert.equal(forceUnlock.body.blocked, true);

  // Case B: Conflicting evidence (e.g. orphan activity marker with un-updated school row)
  h.sheets.tables["Activity Log"].push([
    randomUUID(), "2026-10-15", "Example School 2", "Alex", "App", "Claimed",
    "", "", "", "", RECORD, input.requestId, ACTOR, "Claimed", "Synthesized conflicting row",
  ]);
  const conflictingCheck = await h.get(RECOVERY, SUPERVISOR);
  assert.equal(conflictingCheck.status, 200);
  assert.equal(conflictingCheck.body.evidence.status, "PARTIAL_OR_CONFLICTING");
  assert.equal(conflictingCheck.body.evidence.reconcilable, false);

  // Refuses reconciliation on conflicting evidence
  const reconcileConflict = await h.post(RECOVERY, { requestId: input.requestId, action: "reconcile" }, SUPERVISOR);
  assert.equal(reconcileConflict.status, 409);
  assert.equal(reconcileConflict.body.code, "RECONCILIATION_REFUSED");

  // Subsequent writes remain strictly blocked
  const blocked = await h.post(CLAIM, claim("900003"));
  assert.equal(blocked.status, 503);
  assert.equal(blocked.body.code, "WORKBOOK_BLOCKED");
});

test("operator recovery 4: recovery behavior and journal are preserved across coordinator restart", async (t) => {
  const h = await harness(t);
  h.sheets.fault = "late";
  const input = claim("900002");
  await h.post(CLAIM, input);

  // Restart coordinator while write is pending in SQLite journal
  await h.restart();

  // After restart, pending operation and evidence remain preserved in SQLite
  const postRestartCheck = await h.get(RECOVERY, SUPERVISOR);
  assert.equal(postRestartCheck.status, 200);
  assert.equal(postRestartCheck.body.blocked, true);
  assert.equal(postRestartCheck.body.pendingOperation.requestId, input.requestId);
  assert.equal(postRestartCheck.body.evidence.status, "ABSENT_UNRESOLVED");

  // Subsequent writes remain blocked across restart
  const blocked = await h.post(CLAIM, claim("900003"));
  assert.equal(blocked.status, 503);
  assert.equal(blocked.body.code, "WORKBOOK_BLOCKED");

  // Commit the deferred write upstream
  h.sheets.commitDeferred();

  // Reconcile successfully across restart
  const postRestartReconcile = await h.post(RECOVERY, { requestId: input.requestId, action: "reconcile" }, SUPERVISOR);
  assert.equal(postRestartReconcile.status, 200);
  assert.equal(postRestartReconcile.body.code, "RECONCILED_COMMITTED");
  assert.equal(postRestartReconcile.body.blocked, false);

  // Subsequent writes proceed after recovery
  const unblockedClaim = await h.post(CLAIM, claim("900003"));
  assert.equal(unblockedClaim.status, 200);
  assert.equal(schoolRows(h).length, 3);
});

test("operator recovery 5: late upstream write completing after earlier timeout is safely reconciled without duplicate", async (t) => {
  const h = await harness(t);
  h.sheets.fault = "late";
  const input1 = claim("900002");

  // 1. Initial attempt times out on upstream
  const res1 = await h.post(CLAIM, input1);
  assert.equal(res1.status, 503);
  assert.equal(res1.body.code, "COMMIT_UNCERTAIN");

  // 2. Immediately checking recovery shows absent marker; write is still pending upstream
  const check1 = await h.get(RECOVERY, SUPERVISOR);
  assert.equal(check1.body.evidence.status, "ABSENT_UNRESOLVED");
  assert.equal(check1.body.evidence.reconcilable, false);

  // 3. Competing claim for another school is blocked
  const input2 = claim("900003");
  const res2 = await h.post(CLAIM, input2, OTHER);
  assert.equal(res2.status, 503);
  assert.equal(res2.body.code, "WORKBOOK_BLOCKED");

  // 4. Late write finally commits upstream
  h.sheets.commitDeferred();

  // 5. Recovery check now confirms write committed
  const check2 = await h.get(RECOVERY, SUPERVISOR);
  assert.equal(check2.body.evidence.status, "CONFIRMED_COMMITTED");
  assert.equal(check2.body.evidence.reconcilable, true);

  // 6. Operator reconciles operation
  const reconcileRes = await h.post(RECOVERY, { requestId: input1.requestId, action: "reconcile" }, SUPERVISOR);
  assert.equal(reconcileRes.status, 200);
  assert.equal(reconcileRes.body.code, "RECONCILED_COMMITTED");

  // 7. Competing claim now retries and succeeds
  const res2Success = await h.post(CLAIM, input2, OTHER);
  assert.equal(res2Success.status, 200);

  // 8. Verify workbook integrity: two distinct claimed schools, two activities, formulas preserved
  assert.equal(schoolRows(h).length, 3);
  assert.equal(h.sheets.tables.Schools[2][C.osn], "900002");
  assert.equal(h.sheets.tables.Schools[4][C.osn], "900003");
  assert.equal(h.sheets.tables.Schools[2][16], `=IF(A3="","","fixture follow-up formula")`);
  assert.equal(h.sheets.tables.Schools[4][16], `=IF(A5="","","fixture follow-up formula")`);
  assert.equal(logs(h).length, 2);
  assert.equal(h.sheets.attempts, 2);
});

test("operator recovery 6: students, inactive users, and unlisted users cannot inspect or reconcile recovery state, leaving pending block intact", async (t) => {
  const h = await harness(t);
  h.sheets.fault = "unconfirmed";
  const input = claim("900002");
  const uncertain = await h.post(CLAIM, input);
  assert.equal(uncertain.status, 503);

  const student = ACTOR; // alex@example.test (co-op)
  const inactive = "revoked@example.test"; // CRM Users Active = false
  const unlisted = "unlisted@example.test"; // Not in CRM Users

  // 1. GET inspection attempts by non-supervisors fail closed
  const getStudent = await h.get(RECOVERY, student);
  assert.equal(getStudent.status, 403);
  assert.equal(getStudent.body.code, "SUPERVISOR_ROLE_REQUIRED");

  const getInactive = await h.get(RECOVERY, inactive);
  assert.equal(getInactive.status, 403);
  assert.equal(getInactive.body.code, "USER_NOT_ALLOWED");

  const getUnlisted = await h.get(RECOVERY, unlisted);
  assert.equal(getUnlisted.status, 403);
  assert.equal(getUnlisted.body.code, "USER_NOT_ALLOWED");

  const getNoActor = await h.get(RECOVERY, "");
  assert.equal(getNoActor.status, 401);
  assert.equal(getNoActor.body.code, "SYNTHETIC_ACTOR_REQUIRED");

  // 2. POST reconciliation attempts by non-supervisors fail closed
  const postStudent = await h.post(RECOVERY, { requestId: input.requestId, action: "reconcile" }, student);
  assert.equal(postStudent.status, 403);
  assert.equal(postStudent.body.code, "SUPERVISOR_ROLE_REQUIRED");

  const postInactive = await h.post(RECOVERY, { requestId: input.requestId, action: "reconcile" }, inactive);
  assert.equal(postInactive.status, 403);
  assert.equal(postInactive.body.code, "USER_NOT_ALLOWED");

  const postUnlisted = await h.post(RECOVERY, { requestId: input.requestId, action: "reconcile" }, unlisted);
  assert.equal(postUnlisted.status, 403);
  assert.equal(postUnlisted.body.code, "USER_NOT_ALLOWED");

  const postNoActor = await h.post(RECOVERY, { requestId: input.requestId, action: "reconcile" }, "");
  assert.equal(postNoActor.status, 401);
  assert.equal(postNoActor.body.code, "SYNTHETIC_ACTOR_REQUIRED");

  // 3. POST with missing, malformed, or unknown actions/IDs fail without changing journal
  const missingAction = await h.post(RECOVERY, { requestId: input.requestId }, SUPERVISOR);
  assert.equal(missingAction.status, 422);
  assert.equal(missingAction.body.code, "INVALID_RECOVERY_ACTION");

  const unknownAction = await h.post(RECOVERY, { requestId: input.requestId, action: "ignore_and_unlock" }, SUPERVISOR);
  assert.equal(unknownAction.status, 422);
  assert.equal(unknownAction.body.code, "INVALID_RECOVERY_ACTION");

  const missingRequestId = await h.post(RECOVERY, { action: "reconcile" }, SUPERVISOR);
  assert.equal(missingRequestId.status, 422);
  assert.equal(missingRequestId.body.code, "INVALID_REQUEST_ID");

  const malformedRequestId = await h.post(RECOVERY, { requestId: "not-a-valid-uuid", action: "reconcile" }, SUPERVISOR);
  assert.equal(malformedRequestId.status, 422);
  assert.equal(malformedRequestId.body.code, "INVALID_REQUEST_ID");

  const mismatchedRequestId = await h.post(RECOVERY, { requestId: randomUUID(), action: "reconcile" }, SUPERVISOR);
  assert.equal(mismatchedRequestId.status, 409);
  assert.equal(mismatchedRequestId.body.code, "REQUEST_ID_MISMATCH");

  // 4. Verify the pending operation and workbook block remain completely unchanged
  const supervisorCheck = await h.get(RECOVERY, SUPERVISOR);
  assert.equal(supervisorCheck.status, 200);
  assert.equal(supervisorCheck.body.blocked, true);
  assert.equal(supervisorCheck.body.pendingOperation.requestId, input.requestId);
  assert.equal(supervisorCheck.body.pendingOperation.state, "pending");

  const nextWrite = await h.post(CLAIM, claim("900003"), SUPERVISOR);
  assert.equal(nextWrite.status, 503);
  assert.equal(nextWrite.body.code, "WORKBOOK_BLOCKED");
  assert.equal(nextWrite.body.pendingRequestId, input.requestId);
});
