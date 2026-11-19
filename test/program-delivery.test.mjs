import test from "node:test";
import assert from "node:assert/strict";
import { harness, ACTOR, OTHER, SUPERVISOR, RECORD, C } from "./harness.mjs";
import { readHarness } from "./read-only-harness.mjs";
import { DeliveryCol, ActivityCol } from "../src/schema.ts";

test("program delivery: non-owner co-op student can upsert/update checklist and Activity Log records exact diff", async (t) => {
  const h = await harness(t);
  // RECORD is owned by ACTOR ("Alex"). Tag with Cypher Program and set stage to Booked.
  const school = h.sheets.tables.Schools[1];
  school[C.goal] = "Cypher Program";
  school[C.stage] = "Booked";

  // Initial GET /api/delivery returns uninitialized default entry
  const initialGet = await h.get("/api/delivery", OTHER);
  assert.equal(initialGet.status, 200);
  assert.equal(initialGet.body.deliveries.length, 1);
  const initialEntry = initialGet.body.deliveries[0];
  assert.equal(initialEntry.recordId, RECORD);
  assert.equal(initialEntry.programTrack, "Cypher Program");
  assert.equal(initialEntry.deliveryId, "");
  assert.equal(initialEntry.lastRequestId, "");
  assert.equal(initialEntry.musicSubmitted, false);
  assert.equal(initialEntry.teachersCount, 0);
  assert.deepEqual(initialEntry.history, []);

  // Non-owner co-op student (OTHER = "Sam") creates/upserts the delivery record
  const req1 = crypto.randomUUID();
  const upsert = await h.post("/api/delivery/update", {
    requestId: req1,
    recordId: RECORD,
    programTrack: "Cypher Program",
    expectedLastRequestId: "",
    teachersCount: 2,
    studentsCount: 24,
    musicSubmitted: true,
    workshopDate: "2026-12-09",
    classTime: "13:30",
    schoolStartTime: "08:45",
    schoolEndTime: "15:10",
    studentMentors: "Maya L., Jordan K.",
    deliveryNotes: "Gym booked for afternoon session",
  }, OTHER);

  assert.equal(upsert.status, 200, JSON.stringify(upsert.body));
  assert.equal(upsert.body.delivery.lastEditedBy, "Sam");
  assert.equal(upsert.body.delivery.lastRequestId, req1);
  assert.equal(upsert.body.delivery.musicSubmitted, true);
  assert.equal(upsert.body.delivery.teachersCount, 2);
  assert.equal(upsert.body.delivery.studentsCount, 24);
  assert.equal(upsert.body.delivery.workshopDate, "2026-12-09");
  assert.ok(upsert.body.delivery.deliveryId);
  assert.equal(
    upsert.body.diff,
    "Teachers Count: 0 → 2; Students Count: 0 → 24; Music Submitted: No → Yes; Workshop Date: (none) → 2026-12-09; Class Time: (none) → 13:30; School Start Time: (none) → 08:45; School End Time: (none) → 15:10; Student Mentors: (none) → Maya L., Jordan K.; Delivery Notes: (none) → Gym booked for afternoon session",
  );

  // Verify Program Delivery tab row and Activity Log row written atomically (2 ranges)
  assert.equal(h.sheets.batches.length, 1);
  assert.equal(h.sheets.batches[0].data.length, 2);
  assert.equal(h.sheets.tables["Program Delivery"].length, 2);
  assert.equal(h.sheets.tables["Program Delivery"][1][DeliveryCol.lastEditedBy], "Sam");
  assert.equal(h.sheets.tables["Program Delivery"][1][DeliveryCol.lastRequestId], req1);

  const act = h.sheets.tables["Activity Log"].slice(1).find((r) => r[ActivityCol.requestId] === req1);
  assert.ok(act);
  assert.equal(act[ActivityCol.activityType], "Program Delivery");
  assert.equal(act[ActivityCol.assignedTo], "Sam");
  assert.equal(act[ActivityCol.actorEmail], OTHER);
  assert.equal(act[ActivityCol.outcome], "Cypher Program");
  assert.equal(act[ActivityCol.messageSummary], upsert.body.diff);

  // Subsequent update by ACTOR records only the changed fields in diff
  const req2 = crypto.randomUUID();
  const update2 = await h.post("/api/delivery/update", {
    requestId: req2,
    recordId: RECORD,
    programTrack: "Cypher Program",
    expectedLastRequestId: req1,
    videoSubmitted: true,
    musicSubmitted: false,
  }, ACTOR);
  assert.equal(update2.status, 200, JSON.stringify(update2.body));
  assert.equal(update2.body.delivery.lastEditedBy, "Alex");
  assert.equal(update2.body.diff, "Music Submitted: Yes → No; Video Submitted: No → Yes");
  assert.equal(h.sheets.tables["Program Delivery"].length, 2); // updated in place
});

test("program delivery: concurrent edit with stale expectedLastRequestId returns 409 CONFLICT", async (t) => {
  const h = await harness(t);
  const school = h.sheets.tables.Schools[1];
  school[C.goal] = "Cypher Program";
  school[C.stage] = "Engaged";

  const req1 = crypto.randomUUID();
  const first = await h.post("/api/delivery/update", {
    requestId: req1,
    recordId: RECORD,
    programTrack: "Cypher Program",
    expectedLastRequestId: "",
    danceTeamConfirmed: true,
  }, ACTOR);
  assert.equal(first.status, 200);

  // Two users race with the same expectedLastRequestId = req1
  const [resA, resB] = await Promise.all([
    h.post("/api/delivery/update", {
      requestId: crypto.randomUUID(),
      recordId: RECORD,
      programTrack: "Cypher Program",
      expectedLastRequestId: req1,
      introWorkshopDone: true,
    }, ACTOR),
    h.post("/api/delivery/update", {
      requestId: crypto.randomUUID(),
      recordId: RECORD,
      programTrack: "Cypher Program",
      expectedLastRequestId: req1,
      finaleConfirmed: true,
    }, OTHER),
  ]);

  const statuses = [resA.status, resB.status].sort();
  assert.deepEqual(statuses, [200, 409]);
  const conflict = resA.status === 409 ? resA : resB;
  assert.equal(conflict.body.code, "CONFLICT");
  assert.ok(conflict.body.currentDelivery);
});

test("program delivery: same school stores independent Cypher Program and Competitive Arts rows without overwriting", async (t) => {
  const h = await harness(t);
  const school = h.sheets.tables.Schools[1];
  school[C.goal] = "Cypher Program, Competitive Arts";
  school[C.stage] = "Booked";

  const reqCypher = crypto.randomUUID();
  const resCypher = await h.post("/api/delivery/update", {
    requestId: reqCypher,
    recordId: RECORD,
    programTrack: "Cypher Program",
    teachersCount: 1,
    studentsCount: 15,
    musicSubmitted: true,
    workshopDate: "2026-12-01",
  }, ACTOR);
  assert.equal(resCypher.status, 200);

  const reqComp = crypto.randomUUID();
  const resComp = await h.post("/api/delivery/update", {
    requestId: reqComp,
    recordId: RECORD,
    programTrack: "Competitive Arts",
    teachersCount: 3,
    studentsCount: 40,
    finaleConfirmed: true,
    workshopDate: "2026-12-15",
  }, OTHER);
  assert.equal(resComp.status, 200);

  assert.equal(h.sheets.tables["Program Delivery"].length, 3); // header + 2 track rows
  assert.notEqual(resCypher.body.delivery.deliveryId, resComp.body.delivery.deliveryId);

  const list = await h.get("/api/delivery", SUPERVISOR);
  assert.equal(list.status, 200);
  assert.equal(list.body.deliveries.length, 2);

  const cypher = list.body.deliveries.find((d) => d.programTrack === "Cypher Program");
  const comp = list.body.deliveries.find((d) => d.programTrack === "Competitive Arts");
  assert.ok(cypher && comp);
  assert.equal(cypher.studentsCount, 15);
  assert.equal(cypher.musicSubmitted, true);
  assert.equal(cypher.finaleConfirmed, false);
  assert.equal(cypher.history.length, 1);
  assert.equal(cypher.history[0].editedBy, "Alex");

  assert.equal(comp.studentsCount, 40);
  assert.equal(comp.musicSubmitted, false);
  assert.equal(comp.finaleConfirmed, true);
  assert.equal(comp.history.length, 1);
  assert.equal(comp.history[0].editedBy, "Sam");
});

test("program delivery: rejects phone numbers and consumer emails in Student Mentors with 422", async (t) => {
  const h = await harness(t);
  const school = h.sheets.tables.Schools[1];
  school[C.goal] = "Cypher Program";
  school[C.stage] = "Booked";

  const badMentors = [
    "Maya L. 416-555-1234",
    "Jordan K. (647) 555-9876",
    "Taylor 9055551122",
    "Alex alex.student@gmail.com",
    "Chris (chris@Yahoo.com)",
    "Pat pat@icloud.com",
    "Sam sam@outlook.com",
  ];

  for (const studentMentors of badMentors) {
    const res = await h.post("/api/delivery/update", {
      requestId: crypto.randomUUID(),
      recordId: RECORD,
      programTrack: "Cypher Program",
      studentMentors,
    }, ACTOR);
    assert.equal(res.status, 422, `Expected 422 for mentor string: ${studentMentors}`);
    assert.equal(res.body.code, "STUDENT_PRIVACY_VIOLATION");
  }

  // School-affiliated email or plain names without phones are allowed
  const ok = await h.post("/api/delivery/update", {
    requestId: crypto.randomUUID(),
    recordId: RECORD,
    programTrack: "Cypher Program",
    studentMentors: "Maya L., Jordan K. (jordan@tdsb.on.ca)",
  }, ACTOR);
  assert.equal(ok.status, 200);
  assert.equal(h.sheets.attempts, 1);
});

test("program delivery: GET /api/delivery strips Actor Email from history and never leaks contacts or outreach notes", async (t) => {
  const h = await harness(t);
  const school = h.sheets.tables.Schools[1];
  school[C.goal] = "Cypher Program";
  school[C.stage] = "Completed";
  school[C.email] = "SECRET_PRINCIPAL_EMAIL@school.test";
  school[C.phone] = "416-555-9999";
  school[C.notes] = "SECRET_PRIVATE_OUTREACH_NOTE";
  school[C.contactName] = "SECRET_CONTACT_NAME";

  const reqId = crypto.randomUUID();
  const saved = await h.post("/api/delivery/update", {
    requestId: reqId,
    recordId: RECORD,
    programTrack: "Cypher Program",
    thankYouSent: true,
  }, ACTOR);
  assert.equal(saved.status, 200);

  const res = await h.get("/api/delivery", OTHER);
  assert.equal(res.status, 200);
  const raw = JSON.stringify(res.body);

  // Must not leak school contacts, owner email, actor email, or private notes
  assert.doesNotMatch(raw, /SECRET_PRINCIPAL_EMAIL/);
  assert.doesNotMatch(raw, /416-555-9999/);
  assert.doesNotMatch(raw, /SECRET_PRIVATE_OUTREACH_NOTE/);
  assert.doesNotMatch(raw, /SECRET_CONTACT_NAME/);
  assert.doesNotMatch(raw, /principal@example\.test/);
  assert.doesNotMatch(raw, /alex@example\.test/);

  const entry = res.body.deliveries[0];
  assert.equal(entry.history.length, 1);
  assert.deepEqual(Object.keys(entry.history[0]).sort(), ["activityId", "date", "editedBy", "requestId", "summary"]);
  assert.equal(entry.history[0].editedBy, "Alex");
  assert.equal(entry.history[0].requestId, reqId);
});

test("program delivery: validates fields, filters ineligible schools, and reconciles lost-ack writes", async (t) => {
  const h = await harness(t);
  const school = h.sheets.tables.Schools[1];
  school[C.goal] = "Cypher Program";
  school[C.stage] = "Contacted"; // Not Booked/Completed/Engaged

  const ineligible = await h.get("/api/delivery", ACTOR);
  assert.equal(ineligible.status, 200);
  assert.equal(ineligible.body.deliveries.length, 0);

  school[C.stage] = "Booked";

  // Untagged track rejected
  const wrongTrack = await h.post("/api/delivery/update", {
    requestId: crypto.randomUUID(),
    recordId: RECORD,
    programTrack: "Competitive Arts",
    musicSubmitted: true,
  }, ACTOR);
  assert.equal(wrongTrack.status, 422);
  assert.equal(wrongTrack.body.code, "TRACK_NOT_TAGGED");

  // Invalid count and invalid time rejected
  const badCount = await h.post("/api/delivery/update", {
    requestId: crypto.randomUUID(),
    recordId: RECORD,
    programTrack: "Cypher Program",
    studentsCount: -5,
  }, ACTOR);
  assert.equal(badCount.status, 422);
  assert.equal(badCount.body.code, "INVALID_COUNT");

  const badTime = await h.post("/api/delivery/update", {
    requestId: crypto.randomUUID(),
    recordId: RECORD,
    programTrack: "Cypher Program",
    classTime: "25:00",
  }, ACTOR);
  assert.equal(badTime.status, 422);
  assert.equal(badTime.body.code, "INVALID_TIME");

  // Lost acknowledgement reconciles cleanly without duplicate write
  h.sheets.fault = "lost-ack";
  const reqId = crypto.randomUUID();
  const recovered = await h.post("/api/delivery/update", {
    requestId: reqId,
    recordId: RECORD,
    programTrack: "Cypher Program",
    introWorkshopDone: true,
  }, ACTOR);
  assert.equal(recovered.status, 200);
  assert.equal(h.sheets.attempts, 1);
});

test("program delivery via read-only router & GoogleSheetsCoordinator: auth, CORS, and end-to-end write", async (t) => {
  const h = await readHarness(t, { ENABLE_REAL_WRITES: "true", GOOGLE_ADAPTER_TEST: "true" });
  const school = h.demoSheets.tables.Schools[1];
  school[C.goal] = "Cypher Program";
  school[C.stage] = "Booked";
  const formulasBefore = [school[16], school[17]];

  // CORS preflight for GET /api/delivery and POST /api/delivery/update
  const optGet = await h.request("/api/delivery", {
    method: "OPTIONS",
    headers: { Origin: "http://localhost:8787", "access-control-request-method": "GET", "access-control-request-headers": "authorization" },
  });
  assert.equal(optGet.status, 204);

  const optPost = await h.request("/api/delivery/update", {
    method: "OPTIONS",
    headers: { Origin: "http://localhost:8787", "access-control-request-method": "POST", "access-control-request-headers": "authorization,content-type" },
  });
  assert.equal(optPost.status, 204);

  // Revoked user denied
  const revokedRes = await h.request("/api/delivery", { token: await h.token({ email: "revoked@example.test" }) });
  assert.equal(revokedRes.status, 403);

  // Active co-op student (non-owner OTHER) reads and updates via router -> GoogleSheetsCoordinator
  const otherToken = await h.token({ email: OTHER });
  const getRes = await h.request("/api/delivery", { token: otherToken });
  assert.equal(getRes.status, 200);
  const getBody = await getRes.json();
  assert.equal(getBody.deliveries.length, 1);

  const reqId = crypto.randomUUID();
  const postRes = await h.request("/api/delivery/update", {
    method: "POST",
    token: otherToken,
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      requestId: reqId,
      recordId: school[C.id],
      programTrack: "Cypher Program",
      musicSubmitted: true,
      workshopDate: "2026-12-10",
    }),
  });
  assert.equal(postRes.status, 200);
  const postBody = await postRes.json();
  assert.equal(postBody.delivery.lastEditedBy, "Sam");
  assert.equal(postBody.delivery.musicSubmitted, true);

  // Schools Q/R formulas untouched
  assert.deepEqual([h.demoSheets.tables.Schools[1][16], h.demoSheets.tables.Schools[1][17]], formulasBefore);
  assert.equal(h.demoSheets.attempts, 1);
  assert.equal(h.demoSheets.batches[0].data.length, 2);
});
