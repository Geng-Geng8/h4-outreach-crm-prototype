import test from "node:test";
import assert from "node:assert/strict";
import { readHarness, ACTOR, OTHER, SUPERVISOR } from "./read-only-harness.mjs";
import { C } from "../src/schema.ts";

test("outreach API: verified ownership, atomic activity, safe retry, stale protection and preserved notes/formulas", async (t) => {
  const h = await readHarness(t, { ENABLE_REAL_WRITES: "true", GOOGLE_ADAPTER_TEST: "true" });
  const row = h.demoSheets.tables.Schools[1], token = await h.token();
  row[13] = "Existing school note"; const before = [row[16], row[17]], initialCount = Number(row[26]);
  const input = { recordId: row[0], expectedRequestId: row[27], requestId: crypto.randomUUID(), channel: "Phone", activityType: "FollowUp", outcome: "Left a message", summary: "Synthetic outreach summary", stage: "Contacted", followUpDue: "2026-11-01", nextAction: "Call again" };
  const save = async (body, bearer = token) => {
    const response = await h.request("/api/activities", { method: "POST", token: bearer, headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
    return { status: response.status, body: await response.json() };
  };
  assert.equal((await save(input, "forged.jwt.token")).status, 401);
  assert.equal((await save(input, await h.token({ email: OTHER }))).status, 403);
  assert.equal((await save(input, await h.token({ email: "unlisted@example.test" }))).status, 403);
  assert.equal((await save(input, await h.token({ email: "revoked@example.test" }))).status, 403);
  assert.equal((await save({ ...input, requestId: crypto.randomUUID(), summary: " " })).status, 422);
  assert.equal(h.demoSheets.attempts, 0);
  const preflight = await h.request("/api/activities", { method: "OPTIONS", headers: { Origin: "http://localhost:8787", "access-control-request-method": "POST", "access-control-request-headers": "authorization,content-type" } });
  assert.equal(preflight.status, 204);
  const result = await save(input); assert.equal(result.status, 200, JSON.stringify(result.body));
  assert.equal(h.demoSheets.attempts, 1); assert.equal(h.demoSheets.batches[0].data.length, 3);
  const current = h.demoSheets.tables.Schools[1];
  assert.equal(current[8], "Contacted"); assert.match(current[9], /^\d{4}-\d{2}-\d{2}$/);
  assert.equal(current[10], "2026-11-01"); assert.equal(current[11], "Call again");
  assert.equal(current[13], "Existing school note"); assert.equal(current[26], initialCount + 1);
  assert.deepEqual([current[16], current[17]], before);
  const activity = h.demoSheets.tables["Activity Log"].find((item) => item[11] === input.requestId);
  assert.equal(activity[7], input.summary); assert.equal(activity[12], ACTOR); assert.equal(activity[13], "FollowUp");
  assert.equal((await save(input)).status, 200); assert.equal(h.demoSheets.attempts, 1);
  assert.equal((await save({ ...input, requestId: crypto.randomUUID() })).status, 409);
  assert.equal((await save({ ...input, requestId: crypto.randomUUID(), expectedRequestId: input.requestId, stage: "Cold" })).status, 422);
  const outreach = await save({ ...input, requestId: crypto.randomUUID(), expectedRequestId: input.requestId, activityType: "Outreach" });
  assert.equal(outreach.status, 200); assert.equal(h.demoSheets.tables.Schools[1][26], initialCount + 1);
});

test("outreach API: accepts all channels (Email, Text, Phone, Visit, Meeting, Social) and rejects invalid channel", async (t) => {
  const h = await readHarness(t, { ENABLE_REAL_WRITES: "true", GOOGLE_ADAPTER_TEST: "true" });
  const row = h.demoSheets.tables.Schools[1], token = await h.token();
  let expectedVersion = row[27];
  const save = async (body, bearer = token) => {
    const response = await h.request("/api/activities", { method: "POST", token: bearer, headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
    return { status: response.status, body: await response.json() };
  };

  // Invalid channel is rejected with 422 INVALID_CHANNEL
  const invalid = await save({
    recordId: row[0], expectedRequestId: expectedVersion, requestId: crypto.randomUUID(),
    channel: "CarrierPigeon", activityType: "FollowUp", outcome: "Sent bird", summary: "Flew over school",
  });
  assert.equal(invalid.status, 422);
  assert.equal(invalid.body.code, "INVALID_CHANNEL");

  // All valid channels are accepted and stored correctly in Activity Log column E (index 4)
  const channels = ["Text", "Visit", "Meeting", "Social", "Email", "Phone"];
  for (const ch of channels) {
    const reqId = crypto.randomUUID();
    const res = await save({
      recordId: row[0], expectedRequestId: expectedVersion, requestId: reqId,
      channel: ch, activityType: "FollowUp", outcome: `Completed ${ch}`, summary: `Outreach via ${ch}`,
    });
    assert.equal(res.status, 200, `Expected 200 for channel ${ch}, got ${res.status}`);
    expectedVersion = reqId;

    const activity = h.demoSheets.tables["Activity Log"].find((item) => item[11] === reqId);
    assert.ok(activity, `Activity Log entry found for ${ch}`);
    assert.equal(activity[4], ch, `Channel in Activity Log must be ${ch}`);
    assert.equal(activity[13], "FollowUp");
  }
});

test("school editor: own details, other-student denial and Supervisor access", async (t) => {
  const h = await readHarness(t, { ENABLE_REAL_WRITES: "true", GOOGLE_ADAPTER_TEST: "true" });
  const school = h.demoSheets.tables.Schools[1];
  school[13] = "Private owner note";
  const path = `/api/schools/detail?recordId=${school[0]}`;
  const own = await h.request(path, { token: await h.token() });
  assert.equal(own.status, 200); assert.equal((await own.json()).record.notes, "Private owner note");
  const other = await h.request(path, { token: await h.token({ email: OTHER }), headers: { "x-proof-actor": SUPERVISOR } });
  assert.equal(other.status, 403); assert.doesNotMatch(await other.text(), /Private owner note/);
  const supervisor = await h.request(path, { token: await h.token({ email: SUPERVISOR }) });
  assert.equal(supervisor.status, 200);
  const unlisted = await h.request(path, { token: await h.token({ email: "unlisted@example.test" }) });
  assert.equal(unlisted.status, 403);
  assert.equal(h.demoSheets.attempts, 0);
});

test("school editor: real adapter saves atomically, replays safely, rejects stale/other-owner/Cold updates", async (t) => {
  const h = await readHarness(t, { ENABLE_REAL_WRITES: "true", GOOGLE_ADAPTER_TEST: "true" });
  const row = h.demoSheets.tables.Schools[1], token = await h.token();
  const before = [row[16], row[17]], version = row[27];
  const update = async (body, bearer = token) => {
    const response = await h.request("/api/schools/update", { method: "POST", token: bearer, headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
    return { status: response.status, body: await response.json() };
  };
  const input = { recordId: row[0], expectedRequestId: version, requestId: crypto.randomUUID(), patch: { notes: "Edited note", contactName: "Example contact", priority: "High", stage: "Contacted" } };
  const unauthorized = await update(input, await h.token({ email: OTHER }));
  assert.equal(unauthorized.status, 403);
  const saved = await update(input);
  assert.equal(saved.status, 200); assert.equal(saved.body.record.notes, "Edited note");
  assert.equal(h.demoSheets.attempts, 1);
  assert.deepEqual([h.demoSheets.tables.Schools[1][16],h.demoSheets.tables.Schools[1][17]], before);
  assert.equal(h.demoSheets.tables["Activity Log"].slice(1).filter((r) => r[11] === input.requestId).length, 1);
  const replay = await update(input); assert.equal(replay.status, 200); assert.equal(h.demoSheets.attempts, 1);
  const stale = await update({ ...input, requestId: crypto.randomUUID(), patch: { notes: "stale" } });
  assert.equal(stale.status, 409); assert.equal(stale.body.code, "CONFLICT_STALE_VERSION");
  const cold = await update({ ...input, requestId: crypto.randomUUID(), expectedRequestId: input.requestId, patch: { stage: "Cold" } });
  assert.equal(cold.status, 422); assert.equal(cold.body.code, "COLD_RULE_VIOLATION");
  const explicitCold = await update({ ...input, requestId: crypto.randomUUID(), expectedRequestId: input.requestId, patch: { stage: "Cold", coldReason: "Timing / Scheduling Conflict" } });
  assert.equal(explicitCold.status, 200);
  assert.equal(h.demoSheets.tables.Schools[1][C.stage], "Cold");
  assert.equal(h.demoSheets.tables.Schools[1][C.coldReason], "Timing / Scheduling Conflict");
  assert.equal(h.demoSheets.tables.Schools[1][C.due], "");
  assert.equal(h.demoSheets.tables.Schools[1][C.action], "Archived for season");
  const detail = await h.request(`/api/schools/detail?recordId=${row[0]}`, { token });
  const record = (await detail.json()).record;
  assert.equal(record.contactName, "Example contact"); assert.equal(record.priority, "High"); assert.equal(record.stage, "Cold"); assert.equal(record.coldReason, "Timing / Scheduling Conflict");
});

test("real Google adapter: authenticated claim, RAW split batch, formula preservation and retry", async (t) => {
  const h = await readHarness(t, { ENABLE_REAL_WRITES: "true", GOOGLE_ADAPTER_TEST: "true" });
  const header = h.demoSheets.tables["School Directory"][0];
  for (const [i, text] of [[0,"School Number"],[2,"Board"],[3,"Level"],[4,"Grades"],[5,"City"],[8,"School Email"],[12,"Board Zone"],[13,"Data Source"],[14,"Outreach Status"]]) header[i] = text;
  const before = h.demoSheets.tables.Schools.map((row) => [row[16], row[17]]);
  const token = await h.token();
  const input = { osn: "900002", requestId: crypto.randomUUID() };
  const result = await h.claimSchool(token, input);
  assert.equal(result.status, 200, JSON.stringify(result.body));
  assert.equal(result.body.record.ownerEmail, ACTOR);
  assert.equal(result.body.record.notes, undefined);
  assert.equal(h.demoSheets.attempts, 1);
  assert.equal(h.demoSheets.batches[0].data.length, 3);
  assert.equal(h.demoSheets.batches[0].valueInputOption, "RAW");
  assert.deepEqual(h.demoSheets.tables.Schools.map((row) => [row[16], row[17]]), before);
  assert.ok(h.calls.some((call) => call.host === "sheets.googleapis.com" && call.method === "POST"));
  assert.ok(h.assertions.some((assertion) => assertion.scope === "https://www.googleapis.com/auth/spreadsheets"));
  const replay = await h.claimSchool(token, input);
  assert.equal(replay.status, 200); assert.equal(replay.body.replayed, true);
  assert.equal(h.demoSheets.attempts, 1);
  const studentRecovery = await h.request("/api/operator/recovery", { token });
  assert.equal(studentRecovery.status, 403);
  const supervisorRecovery = await h.request("/api/operator/recovery", { token: await h.token({ email: SUPERVISOR }) });
  assert.equal(supervisorRecovery.status, 200);
  assert.equal((await supervisorRecovery.json()).blocked, false);
});

test("real Google adapter: claims beyond the allocation grid still prevent duplicates", async (t) => {
  const h = await readHarness(t, { ENABLE_REAL_WRITES: "true", GOOGLE_ADAPTER_TEST: "true" });
  const existing = structuredClone(h.demoSheets.tables.Schools[1]);
  existing[0] = crypto.randomUUID(); existing[24] = "900002";
  while (h.demoSheets.tables.Schools.length <= 1000) h.demoSheets.tables.Schools.push([]);
  h.demoSheets.tables.Schools[1000] = existing;
  const result = await h.claimSchool(await h.token(), { osn: "900002", requestId: crypto.randomUUID() });
  assert.equal(result.status, 409);
  assert.equal(result.body.code, "SCHOOL_ALREADY_CLAIMED");
  assert.equal(h.demoSheets.attempts, 0);
});
