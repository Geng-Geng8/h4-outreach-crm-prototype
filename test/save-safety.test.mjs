import test from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { harness, C, ACTOR, OTHER, SUPERVISOR, RECORD, VERSION } from "./harness.mjs";

const CLAIM = "/api/schools/claim", UPDATE = "/api/schools/update", ACTIVITY = "/api/activities";
const claim = (osn = "900002") => ({ requestId: randomUUID(), osn });
const update = (notes = "Updated fixture note", version = VERSION) => ({
  requestId: randomUUID(), recordId: RECORD, expectedRequestId: version, patch: { notes },
});
const activity = (version = VERSION) => ({
  requestId: randomUUID(), recordId: RECORD, expectedRequestId: version,
  channel: "Email", activityType: "FollowUp", outcome: "Contact attempted",
  summary: "Synthetic follow-up", stage: "Contacted", followUpDue: "2026-10-20",
});
const schoolRows = (h) => h.sheets.tables.Schools.slice(1).filter((row) => row[C.id]);
const logs = (h) => h.sheets.tables["Activity Log"].slice(1);

test("simultaneous claims of different schools occupy distinct rows and preserve partial rows", async (t) => {
  const h = await harness(t);
  const orphan = structuredClone(h.sheets.tables.Schools[3]);
  const results = await Promise.all([h.post(CLAIM, claim()), h.post(CLAIM, claim("900003"), OTHER)]);
  assert.deepEqual(results.map((result) => result.status), [200, 200]);
  assert.equal(schoolRows(h).length, 3);
  assert.equal(h.sheets.tables.Schools[2][C.osn], "900002");
  assert.equal(h.sheets.tables.Schools[4][C.osn], "900003");
  assert.deepEqual(h.sheets.tables.Schools[3], orphan);
  assert.equal(logs(h).length, 2);
  assert.equal(h.sheets.maxInFlight, 1, "External fetches must not interleave inside the coordinator");
});

test("two students racing to claim the same school get exactly one success", async (t) => {
  const h = await harness(t);
  const results = await Promise.all([h.post(CLAIM, claim()), h.post(CLAIM, claim(), OTHER)]);
  assert.deepEqual(results.map((result) => result.status).sort(), [200, 409]);
  assert.equal(results.find((result) => result.status === 409).body.code, "SCHOOL_ALREADY_CLAIMED");
  assert.equal(schoolRows(h).filter((row) => row[C.osn] === "900002").length, 1);
  assert.equal(logs(h).length, 1);
});

test("simultaneous stale updates return one success and one 409 with the saved version", async (t) => {
  const h = await harness(t);
  const results = await Promise.all([h.post(UPDATE, update("First draft")), h.post(UPDATE, update("Second draft"))]);
  const success = results.find((result) => result.status === 200);
  const conflict = results.find((result) => result.status === 409);
  assert.ok(success); assert.ok(conflict);
  assert.equal(conflict.body.code, "CONFLICT_STALE_VERSION");
  assert.deepEqual(conflict.body.currentServerRecord, success.body.record);
  assert.equal(logs(h).length, 1);
});

test("simultaneous follow-ups cannot lose a counter increment", async (t) => {
  const h = await harness(t);
  const requests = [activity(), activity()];
  const results = await Promise.all(requests.map((input) => h.post(ACTIVITY, input)));
  assert.deepEqual(results.map((result) => result.status).sort(), [200, 409]);
  const current = results.find((result) => result.status === 200).body.record;
  assert.equal(current.followUpCount, 1);
  const retry = await h.post(ACTIVITY, activity(current.lastRequestId));
  assert.equal(retry.status, 200);
  assert.equal(retry.body.record.followUpCount, 2);
  assert.equal(logs(h).length, 2);
});

test("simultaneous identical retries produce one claim and one activity", async (t) => {
  const h = await harness(t);
  const input = claim();
  const results = await Promise.all([h.post(CLAIM, input), h.post(CLAIM, input)]);
  assert.deepEqual(results.map((result) => result.status), [200, 200]);
  assert.equal(results[1].body.replayed, true);
  assert.deepEqual(results[0].body.record, results[1].body.record);
  assert.equal(h.sheets.attempts, 1);
  assert.equal(logs(h).length, 1);
});

test("an older successful request replays after newer edits and a real runtime restart", async (t) => {
  const h = await harness(t);
  const input = update("First accepted note");
  const first = await h.post(UPDATE, input);
  const second = await h.post(UPDATE, update("More recent note", input.requestId));
  assert.equal(second.status, 200);
  await h.restart();
  const replay = await h.post(UPDATE, input);
  assert.equal(replay.status, 200); assert.equal(replay.body.replayed, true);
  assert.deepEqual(replay.body.record, first.body.record);
  assert.equal(h.sheets.tables.Schools[1][C.notes], "More recent note");
  assert.equal(h.sheets.attempts, 2);
  assert.equal(logs(h).length, 2);
});

test("request IDs cannot be reused with a different payload or actor", async (t) => {
  const h = await harness(t);
  const input = claim();
  assert.equal((await h.post(CLAIM, input)).status, 200);
  for (const result of [await h.post(CLAIM, { ...input, osn: "900003" }), await h.post(CLAIM, input, OTHER)]) {
    assert.equal(result.status, 409); assert.equal(result.body.code, "REQUEST_ID_REUSED");
  }
  assert.equal(h.sheets.attempts, 1);
});

test("school updates and activities share one RAW split-range batch, preserving Q/R", async (t) => {
  const h = await harness(t);
  const formulas = h.sheets.tables.Schools.map((row) => row.slice(16, 18));
  const input = activity();
  const saved = await h.post(ACTIVITY, input);
  assert.equal(saved.status, 200);
  assert.equal(h.sheets.batches.length, 1);
  const batch = h.sheets.batches[0];
  assert.equal(batch.valueInputOption, "RAW");
  assert.deepEqual(batch.data.map(({ range }) => range), ["'Schools'!A2:P2", "'Schools'!S2:AF2", "'Activity Log'!A2:P2"]);
  assert.deepEqual(batch.data.map(({ values }) => values[0].length), [16, 14, 16]);
  assert.deepEqual(h.sheets.tables.Schools.map((row) => row.slice(16, 18)), formulas);
  assert.equal(logs(h)[0][11], input.requestId);
  assert.equal(logs(h)[0][10], RECORD);
  assert.equal(h.sheets.tables.Schools[1][C.version], input.requestId);
});

test("claims also leave pre-existing formula cells untouched", async (t) => {
  const h = await harness(t);
  const formulas = h.sheets.tables.Schools[2].slice(16, 18);
  assert.equal((await h.post(CLAIM, claim())).status, 200);
  assert.deepEqual(h.sheets.tables.Schools[2].slice(16, 18), formulas);
});

test("a rejected batch leaves both school and activity unchanged", async (t) => {
  const h = await harness(t);
  const before = structuredClone(h.sheets.tables);
  h.sheets.fault = "reject";
  const input = activity();
  const result = await h.post(ACTIVITY, input);
  assert.equal(result.status, 502); assert.equal(result.body.code, "SHEETS_REJECTED");
  assert.deepEqual(h.sheets.tables, before);
  assert.equal((await h.post(ACTIVITY, input)).body.replayed, true);
  assert.equal(h.sheets.attempts, 1);
  assert.equal((await h.post(UPDATE, update())).status, 200, "Known rejection must release the workbook");
});

test("a lost acknowledgement after commit is reconciled without a second write", async (t) => {
  const h = await harness(t);
  h.sheets.fault = "lost-ack";
  const input = activity();
  const result = await h.post(ACTIVITY, input);
  assert.equal(result.status, 200);
  assert.equal(result.body.record.followUpCount, 1);
  assert.equal((await h.post(ACTIVITY, input)).body.replayed, true);
  assert.equal(h.sheets.attempts, 1); assert.equal(logs(h).length, 1);
});

test("a late commit blocks later writes across restart, then reconciles the same request", async (t) => {
  const h = await harness(t);
  h.sheets.fault = "late";
  const input = claim();
  const uncertain = await h.post(CLAIM, input);
  assert.equal(uncertain.status, 503); assert.equal(uncertain.body.code, "COMMIT_UNCERTAIN");
  await h.restart();
  const blocked = await h.post(CLAIM, claim("900003"));
  assert.equal(blocked.status, 503); assert.equal(blocked.body.code, "WORKBOOK_BLOCKED");
  assert.equal((await h.post(CLAIM, input)).body.code, "COMMIT_UNCERTAIN");
  assert.equal(h.sheets.attempts, 1, "Absence of a marker must never trigger a blind retry");
  h.sheets.commitDeferred();
  const confirmed = await h.post(CLAIM, input);
  assert.equal(confirmed.status, 200);
  assert.equal((await h.post(CLAIM, claim("900003"))).status, 200);
  assert.equal(h.sheets.attempts, 2); assert.equal(logs(h).length, 2);
});

test("an unresolved write with no visible marker remains blocked instead of reporting saved", async (t) => {
  const h = await harness(t);
  h.sheets.fault = "unconfirmed";
  const input = update();
  assert.equal((await h.post(UPDATE, input)).status, 503);
  await h.restart();
  assert.equal((await h.post(UPDATE, input)).body.code, "COMMIT_UNCERTAIN");
  assert.equal((await h.post(CLAIM, claim())).body.code, "WORKBOOK_BLOCKED");
  assert.equal(h.sheets.attempts, 1); assert.equal(logs(h).length, 0);
});

test("ownership and user revocation are enforced before writes and replays", async (t) => {
  const h = await harness(t);
  assert.equal((await h.post(UPDATE, update(), OTHER)).status, 403);
  assert.equal((await h.post(CLAIM, claim(), "revoked@example.test")).status, 403);
  assert.equal((await h.post(CLAIM, claim(), "")).status, 401);
  const input = update();
  assert.equal((await h.post(UPDATE, input)).status, 200);
  h.sheets.tables["CRM Users"][1][3] = false;
  assert.equal((await h.post(UPDATE, input)).status, 403);
  const supervisor = await h.post(UPDATE, update("Supervisor edit", input.requestId), SUPERVISOR);
  assert.equal(supervisor.status, 200);
});

test("schema drift rejects writes before any mutation", async (t) => {
  const h = await harness(t);
  h.sheets.tables.Schools[0][C.notes] = "Unexpected header";
  const result = await h.post(UPDATE, update());
  assert.equal(result.status, 503); assert.equal(result.body.code, "SCHEMA_MISMATCH");
  assert.equal(h.sheets.attempts, 0);
});

test("user text is transmitted literally with RAW and forged ownership is rejected", async (t) => {
  const h = await harness(t);
  const literal = '  =HYPERLINK("https://example.test","fixture")';
  assert.equal((await h.post(UPDATE, update(literal))).status, 200);
  assert.equal(h.sheets.tables.Schools[1][C.notes], literal);
  const forged = update("Forged", h.sheets.tables.Schools[1][C.version]);
  forged.patch.ownerEmail = OTHER;
  assert.equal((await h.post(UPDATE, forged)).status, 422);
  assert.equal(h.sheets.attempts, 1);
});

test("Cold guard rejects warm stages, insufficient follow-ups, missing/current/future due dates", async (t) => {
  const h = await harness(t);
  for (const [stage, count, due] of [
    ["Interested", 2, "2026-10-14"], ["Engaged", 2, "2026-10-14"], ["Booked", 2, "2026-10-14"],
    ["Contacted", 1, "2026-10-14"], ["Contacted", 2, ""],
    ["Contacted", 2, "2026-10-15"], ["Contacted", 2, "2026-10-16"],
  ]) {
    Object.assign(h.sheets.tables.Schools[1], { [C.stage]: stage, [C.count]: count, [C.due]: due });
    const result = await h.post(ACTIVITY, { ...activity(), stage: "Cold" });
    assert.equal(result.status, 422); assert.equal(result.body.code, "COLD_RULE_VIOLATION");
  }
  Object.assign(h.sheets.tables.Schools[1], { [C.stage]: "Contacted", [C.count]: 2, [C.due]: "2026-10-14" });
  assert.equal((await h.post(ACTIVITY, { ...activity(), stage: "Cold" })).status, 200);
  assert.equal(h.sheets.attempts, 1);
});

test("invalid calendar dates are rejected", async (t) => {
  const h = await harness(t);
  const input = update(); input.patch.followUpDue = "2026-02-30";
  const result = await h.post(UPDATE, input);
  assert.equal(result.status, 422); assert.equal(result.body.code, "INVALID_DATE");
  assert.equal(h.sheets.attempts, 0);
});

test("exhausted preformatted capacity fails instead of appending outside it", async (t) => {
  const h = await harness(t);
  for (let number = 2; number <= 500; number++) {
    h.sheets.tables.Schools[number - 1] ??= Array(32).fill("");
    h.sheets.tables.Schools[number - 1][C.notes] ||= "Occupied fixture";
  }
  const result = await h.post(CLAIM, claim());
  assert.equal(result.status, 422); assert.equal(result.body.code, "PREFORMATTED_ROWS_FULL");
  assert.equal(h.sheets.attempts, 0);
});

test("synthetic headers cannot enable mutations when proof mode is disabled", async (t) => {
  const h = await harness(t, { mode: "disabled" });
  const result = await h.post(CLAIM, claim());
  assert.equal(result.status, 503); assert.equal(result.body.code, "LOCAL_PROOF_DISABLED");
  assert.equal(h.sheets.attempts, 0);
});

test("a real spreadsheet ID cannot be used by the synthetic proof", async (t) => {
  const h = await harness(t, { sheetId: "not-the-synthetic-sheet" });
  const result = await h.post(CLAIM, claim());
  assert.equal(result.status, 503); assert.equal(result.body.code, "LOCAL_PROOF_DISABLED");
  assert.equal(h.sheets.attempts, 0);
});

test("partial records without an ID still prevent duplicate school claims", async (t) => {
  const h = await harness(t);
  h.sheets.tables.Schools[3][C.name] = "  EXAMPLE   SCHOOL 2 ";
  const result = await h.post(CLAIM, claim());
  assert.equal(result.status, 409); assert.equal(result.body.code, "SCHOOL_ALREADY_CLAIMED");
  assert.equal(h.sheets.attempts, 0);
});

test("updates locate the record by ID after rows have moved before the request", async (t) => {
  const h = await harness(t);
  [h.sheets.tables.Schools[1], h.sheets.tables.Schools[4]] = [h.sheets.tables.Schools[4], h.sheets.tables.Schools[1]];
  assert.equal((await h.post(UPDATE, update("Located by ID"))).status, 200);
  assert.equal(h.sheets.tables.Schools[4][C.notes], "Located by ID");
  assert.equal(h.sheets.tables.Schools[1][C.notes], "");
  assert.equal(h.sheets.batches[0].data[0].range, "'Schools'!A5:P5");
});

test("duplicate stored record IDs fail closed", async (t) => {
  const h = await harness(t);
  h.sheets.tables.Schools[4] = structuredClone(h.sheets.tables.Schools[1]);
  const result = await h.post(UPDATE, update());
  assert.equal(result.status, 503); assert.equal(result.body.code, "DUPLICATE_RECORD_ID");
  assert.equal(h.sheets.attempts, 0);
});

test("a burst of ten competing claims yields one saved school and one audit entry", async (t) => {
  const h = await harness(t);
  const results = await Promise.all(Array.from({ length: 10 }, (_, index) =>
    h.post(CLAIM, claim(), index % 2 === 0 ? ACTOR : OTHER)));
  assert.equal(results.filter((result) => result.status === 200).length, 1);
  assert.equal(results.filter((result) => result.status === 409).length, 9);
  assert.equal(logs(h).length, 1); assert.equal(h.sheets.attempts, 1);
  assert.equal(h.sheets.maxInFlight, 1);
});
