import test from "node:test";
import assert from "node:assert/strict";
import { readHarness, ACTOR, OTHER, SUPERVISOR, CLIENT, SCOPE } from "./read-only-harness.mjs";

const sheetReads = (h) => h.calls.filter((call) => call.host === "sheets.googleapis.com");
const schoolReads = (h) => sheetReads(h).filter((call) => call.ranges.some((range) => range.startsWith("'Schools'!")));

test("installation metadata and correctly sized icons are public static assets", async (t) => {
  const h = await readHarness(t);
  const response = await h.request("/manifest.webmanifest?v=1");
  assert.equal(response.status, 200); assert.match(response.headers.get("content-type"), /application\/manifest\+json/);
  assert.equal((await response.json()).short_name, "H4 Outreach");
  for (const size of [48, 180, 192, 512]) {
    const icon = await h.request(`/assets/icons/h4-outreach-v1-${size}.png`);
    assert.equal(icon.status, 200); assert.equal(icon.headers.get("content-type"), "image/png");
    const png = Buffer.from(await icon.arrayBuffer());
    assert.equal(png.readUInt32BE(16), size); assert.equal(png.readUInt32BE(20), size);
  }
  assert.equal(h.calls.length, 0, "loading installation assets never calls Google or reads school data");
});

test("team dashboard shares all progress summaries with students, but no private fields or edit grants", async (t) => {
  const h = await readHarness(t);
  h.tables.Schools[1][9] = "2026-10-14"; h.tables.Schools[1][10] = "2026-10-20";
  h.tables.Schools.find((row) => row[3] === "Sam")[8] = "Booked";
  const response = await h.request("/api/dashboard", { token: await h.token() });
  const data = await response.json();
  assert.equal(response.status, 200); assert.equal(data.schools.length, 2);
  assert.equal(data.schools[0].lastContacted, "2026-10-14"); assert.equal(data.schools[0].followUpDue, "2026-10-20");
  assert.equal(data.schools[0].canEdit, true); assert.equal(data.schools[1].canEdit, false);
  assert.equal(data.schools[1].assignedTo, "Sam"); assert.equal(data.schools[1].stage, "Booked");
  assert.deepEqual(Object.keys(data.schools[0]).sort(), ["recordId", "schoolName", "schoolBoard", "assignedTo", "stage", "priority", "geographicRegion", "lastContacted", "followUpDue", "canEdit"].sort());
  assert.doesNotMatch(JSON.stringify(data), /PRIVATE_|@|ownerEmail|notes|activities|contactName|lastRequestId/);
  assert.equal(response.headers.get("cache-control"), "no-store");
  assert.ok(sheetReads(h).every((call) => call.method === "GET"));
  assert.deepEqual(schoolReads(h)[0].ranges, ["'Schools'!A1:D1000", "'Schools'!I1:K1000", "'Schools'!M1:M1000", "'Schools'!S1:S1000", "'Schools'!Z1:Z1000"]);
});

test("dashboard verifies supervisor membership and immediately rejects revocation and unlisted identities", async (t) => {
  const h = await readHarness(t);
  const token = await h.token({ email: SUPERVISOR, sub: "fixture-supervisor" });
  const success = await h.request("/api/dashboard", { token });
  assert.equal(success.status, 200); assert.ok((await success.json()).schools.every((school) => school.canEdit));
  const reads = schoolReads(h).length;
  h.tables["CRM Users"].find((row) => row[0] === SUPERVISOR)[3] = false;
  assert.equal((await h.request("/api/dashboard", { token })).status, 403);
  assert.equal((await h.request("/api/dashboard", { token: await h.token({ email: "unlisted@example.test" }) })).status, 403);
  assert.equal((await h.request("/api/dashboard")).status, 401);
  assert.equal((await h.request("/api/dashboard", { token, method: "POST", body: "{}" })).status, 405);
  assert.equal(schoolReads(h).length, reads);
});

test("dashboard fails closed when progress headers are misaligned", async (t) => {
  const h = await readHarness(t);
  h.tables.Schools[0][9] = "Wrong date column";
  const response = await h.request("/api/dashboard", { token: await h.token() });
  assert.equal(response.status, 503); assert.equal((await response.json()).code, "SCHEMA_MISMATCH");
});

test("verified Google identity receives only its assigned school summaries", async (t) => {
  const h = await readHarness(t);
  const result = await h.bootstrap(await h.token());
  assert.equal(result.status, 200);
  assert.equal(result.body.currentUser.email, ACTOR);
  assert.equal(result.body.currentUser.subject, "fixture-alex-subject");
  assert.equal(result.body.currentUser.role, "co-op");
  assert.equal(result.body.schools.length, 1);
  assert.equal(result.body.schools[0].schoolName, "Maple Example Secondary");
  assert.equal(result.body.writesEnabled, false);
  assert.equal(result.body.visibility.scope, "assigned-school-summaries");
  assert.deepEqual(Object.keys(result.body.schools[0]).sort(), [
    "recordId", "schoolName", "schoolBoard", "assignedTo", "stage", "priority", "geographicRegion", "lastContacted", "followUpDue", "nextAction", "isMySchool",
  ].sort());
  assert.equal(result.body.schools[0].isMySchool, true);
  assert.doesNotMatch(JSON.stringify(result.body), /PRIVATE_|Other Student School|sam@example\.test/);
  assert.equal(result.headers.get("cache-control"), "no-store");
});

test("My Outreach receives own next actions and due dates, never another student's next action or roster", async (t) => {
  const h = await readHarness(t);
  h.tables.Schools[1][11] = "Call the school office"; h.tables.Schools[1][10] = "2026-10-16";
  h.tables.Schools.find((row) => row[3] === "Sam")[11] = "PRIVATE_OTHER_NEXT_ACTION";
  const token = await h.token(), result = await h.bootstrap(token);
  assert.equal(result.body.schools[0].nextAction, "Call the school office");
  assert.equal(result.body.schools[0].followUpDue, "2026-10-16");
  assert.equal(result.body.overview, undefined); assert.doesNotMatch(JSON.stringify(result.body), /PRIVATE_|studentId|assignmentIssue/);
  const team = await h.request("/api/dashboard", { token });
  assert.doesNotMatch(await team.text(), /PRIVATE_|nextAction|studentId|assignmentIssue|students/);
});

test("H4 Overview rejects students before school reads, even with forged role hints", async (t) => {
  const h = await readHarness(t);
  const response = await h.request("/api/dashboard?view=overview&role=Supervisor", { token: await h.token(), headers: { "x-proof-actor": SUPERVISOR, "x-role": "Supervisor" } });
  assert.equal(response.status, 403); assert.equal((await response.json()).code, "SUPERVISOR_ROLE_REQUIRED");
  assert.equal(schoolReads(h).length, 0);
});

test("Supervisor overview includes zero-assignment students and joins schools by identity instead of name", async (t) => {
  const h = await readHarness(t);
  h.tables["CRM Users"][1][1] = "Student"; h.tables["CRM Users"][2][1] = "Student";
  h.tables["CRM Users"].push(["new@example.test", "New student", "co-op", true]);
  const result = await h.bootstrap(await h.token({ email: SUPERVISOR }));
  assert.equal(result.status, 200); const students = result.body.overview.students;
  assert.equal(students.filter((s) => s.name === "Student").length, 2);
  assert.notEqual(result.body.schools[0].studentId, result.body.schools[1].studentId);
  assert.ok(students.some((s) => s.id === result.body.schools[0].studentId));
  assert.ok(students.some((s) => s.name === "New student" && !result.body.schools.some((school) => school.studentId === s.id)));
  assert.ok(students.some((s) => s.name === "Revoked" && s.active === false));
  assert.doesNotMatch(JSON.stringify(result.body.schools), /ownerEmail|@|PRIVATE_/);
  assert.equal(sheetReads(h).length, 2, "authentication and one batched school/roster read");
  const token = await h.token({ email: SUPERVISOR });
  assert.equal((await h.request("/api/dashboard?view=overview", { token })).status, 200);
  h.tables["CRM Users"].find((row) => row[0] === SUPERVISOR)[2] = "co-op";
  assert.equal((await h.request("/api/dashboard?view=overview", { token })).status, 403);
  assert.equal((await h.bootstrap(token)).body.overview, undefined);
});

test("Supervisor can read all summaries, without contact details, notes, users or activities", async (t) => {
  const h = await readHarness(t);
  // Add a school owned by supervisor but with non-matching display name
  const ownSchool = structuredClone(h.tables.Schools[1]);
  ownSchool[0] = "00000000-0000-4000-8000-000000000101";
  ownSchool[1] = "Supervisor Owned School";
  ownSchool[3] = "Other Assigned Name";
  ownSchool[25] = SUPERVISOR;
  h.tables.Schools.push(ownSchool);

  // Add a school owned by student Sam, but with display name matching supervisor
  const samSchool = structuredClone(h.tables.Schools[1]);
  samSchool[0] = "00000000-0000-4000-8000-000000000102";
  samSchool[1] = "Sam School With Supervisor Name";
  samSchool[3] = "Morgan"; // Supervisor's display name
  samSchool[25] = OTHER;
  h.tables.Schools.push(samSchool);

  const result = await h.bootstrap(await h.token({ email: SUPERVISOR, sub: "fixture-supervisor" }));
  assert.equal(result.status, 200); assert.equal(result.body.schools.length, 4);
  assert.equal(result.body.visibility.scope, "all-school-summaries");
  assert.equal(result.body.activities, undefined); assert.equal(result.body.users, undefined);
  assert.doesNotMatch(JSON.stringify(result.body), /PRIVATE_/);
  assert.doesNotMatch(JSON.stringify(result.body.schools), /ownerEmail|@/);

  const mySchool = result.body.schools.find((s) => s.recordId === "00000000-0000-4000-8000-000000000101");
  assert.equal(mySchool.isMySchool, true, "School owned by supervisor email has isMySchool = true");

  const otherSchool = result.body.schools.find((s) => s.recordId === "00000000-0000-4000-8000-000000000102");
  assert.equal(otherSchool.isMySchool, false, "School owned by another email with supervisor display name has isMySchool = false");
});

test("unlisted users are denied before any school range is fetched", async (t) => {
  const h = await readHarness(t);
  const result = await h.bootstrap(await h.token({ email: "unlisted@example.test" }));
  assert.equal(result.status, 403); assert.equal(result.body.code, "USER_NOT_ALLOWED");
  assert.equal(schoolReads(h).length, 0);
});

test("false, NO, REMOVED and unknown active statuses are denied", async (t) => {
  const h = await readHarness(t);
  const token = await h.token();
  for (const active of [false, "FALSE", "NO", "REMOVED", "SUSPENDED"]) {
    h.tables["CRM Users"][1][3] = active;
    assert.equal((await h.bootstrap(token)).status, 403);
  }
  assert.equal(schoolReads(h).length, 0);
});

test("legacy blank Active values remain compatible and unknown roles fail closed", async (t) => {
  const h = await readHarness(t);
  const token = await h.token();
  h.tables["CRM Users"][1][3] = "";
  assert.equal((await h.bootstrap(token)).status, 200);
  h.tables["CRM Users"][1][2] = "Administrator";
  assert.equal((await h.bootstrap(token)).status, 403);
});

test("duplicate email allowlist entries are denied instead of picking a role", async (t) => {
  const h = await readHarness(t);
  h.tables["CRM Users"].push([ACTOR, "Another name", "Supervisor", true]);
  assert.equal((await h.bootstrap(await h.token())).status, 403);
  assert.equal(schoolReads(h).length, 0);
});

test("permissions are reread on each request and revocation takes effect immediately on the next read", async (t) => {
  const h = await readHarness(t);
  const token = await h.token();
  assert.equal((await h.bootstrap(token)).status, 200);
  h.tables["CRM Users"][1][3] = false;
  const denied = await h.bootstrap(token);
  assert.equal(denied.status, 403);
  assert.equal(denied.body.schools, undefined);
  assert.equal(sheetReads(h).filter((call) => call.ranges[0].includes("CRM Users")).length, 2);
  assert.equal(schoolReads(h).length, 1);
});

test("role changes affect the next read without a stale permission cache", async (t) => {
  const h = await readHarness(t);
  const token = await h.token();
  h.tables["CRM Users"][1][2] = "Supervisor";
  assert.equal((await h.bootstrap(token)).body.schools.length, 2);
  h.tables["CRM Users"][1][2] = "co-op";
  assert.equal((await h.bootstrap(token)).body.schools.length, 1);
});

test("missing credentials, fixture actor headers and cookies cannot bypass Google verification", async (t) => {
  const h = await readHarness(t);
  for (const headers of [{}, { "x-proof-actor": SUPERVISOR }, { cookie: "session=fixture; role=Supervisor" }]) {
    assert.equal((await h.bootstrap(undefined, headers)).status, 401);
  }
  assert.equal(h.calls.length, 0);
});

test("client role and ownership hints cannot expand a student's server-filtered scope", async (t) => {
  const h = await readHarness(t);
  const response = await h.request(`/api/bootstrap?role=Supervisor&ownerEmail=${OTHER}`, {
    token: await h.token(), headers: { "x-proof-actor": SUPERVISOR },
  });
  const data = await response.json();
  assert.equal(response.status, 200); assert.equal(data.schools.length, 1);
  assert.equal(data.currentUser.role, "co-op");
});

test("forged, expired, future-issued, wrong-audience and wrong-issuer tokens are rejected", async (t) => {
  const h = await readHarness(t);
  const now = Math.floor(Date.now() / 1000);
  const valid = await h.token();
  const parts = valid.split("."); parts[2] = (parts[2][0] === "A" ? "B" : "A") + parts[2].slice(1);
  const invalid = [
    parts.join("."), await h.token({ exp: now - 120 }), await h.token({ iat: now + 120 }),
    await h.token({ aud: "another-client.apps.googleusercontent.com" }),
    await h.token({ iss: "https://attacker.example.test" }), await h.token({ azp: "another-client" }),
    await h.token({ aud: [CLIENT, "another-client"] }),
  ];
  for (const token of invalid) {
    const result = await h.bootstrap(token);
    assert.equal(result.status, 401); assert.equal(result.body.code, "INVALID_GOOGLE_TOKEN");
  }
  assert.equal(sheetReads(h).length, 0);
});

test("unverified email, missing mandatory claims and algorithm confusion are denied", async (t) => {
  const h = await readHarness(t);
  const invalid = [await h.token({ email_verified: false }), await h.token({ sub: "" }),
    await h.token({}, { omit: ["exp"] }), await h.token({}, { omit: ["iat"] }),
    await h.token({}, { omit: ["email_verified"] }),
    "eyJhbGciOiJub25lIn0.eyJzdWIiOiJmaXh0dXJlIn0.",
  ];
  for (const token of invalid) assert.equal((await h.bootstrap(token)).status, 401);
  assert.equal(sheetReads(h).length, 0);
});

test("non-Gmail/non-Workspace Google accounts stay blocked pending an email-ownership policy", async (t) => {
  const h = await readHarness(t);
  const token = await h.token({ email: "fixture@outlook.example.test" }, { omit: ["hd"] });
  const result = await h.bootstrap(token);
  assert.equal(result.status, 403); assert.equal(result.body.code, "EMAIL_PROVIDER_NOT_SUPPORTED");
  assert.equal(sheetReads(h).length, 0);
});

test("service account assertion is cryptographically valid and requests only spreadsheets.readonly", async (t) => {
  const h = await readHarness(t);
  assert.equal((await h.bootstrap(await h.token())).status, 200);
  assert.equal(h.assertions.length, 1); assert.equal(h.assertions[0].scope, SCOPE);
  assert.equal(h.assertions[0].sub, undefined);
  assert.equal(h.assertions[0].exp - h.assertions[0].iat, 3600);
  assert.equal(sheetReads(h).every((call) => call.method === "GET"), true);
  const allRanges = sheetReads(h).flatMap((call) => call.ranges);
  assert.equal(allRanges.length, 6);
  assert.equal(allRanges.some((range) => /Activity Log|Dashboard|N1:N|E1:H|AF/.test(range)), false);
});

test("access tokens are reused while CRM permissions remain fresh", async (t) => {
  const h = await readHarness(t);
  const token = await h.token();
  assert.equal((await h.bootstrap(token)).status, 200);
  assert.equal((await h.bootstrap(token)).status, 200);
  assert.equal(h.assertions.length, 1);
  assert.equal(sheetReads(h).length, 4);
  assert.equal(h.calls.filter((call) => call.host === "www.googleapis.com").length, 1);
});

test("every spreadsheet mutation route rejects all mutating methods, even with synthetic proof flags", async (t) => {
  const h = await readHarness(t, { PROOF_MODE: "synthetic" });
  for (const path of ["/api/schools/claim", "/api/schools/update", "/api/activities", "/api/users", "/api/bootstrap"]) {
    for (const method of ["POST", "PUT", "PATCH", "DELETE"]) {
      const response = await h.request(path, { method, headers: { "x-proof-actor": SUPERVISOR } });
      assert.equal(response.status, 405); assert.equal((await response.json()).code, "READ_ONLY_MODE");
    }
  }
  assert.equal(h.calls.length, 0);
});

test("CORS permits only the configured origin and read-only preflights", async (t) => {
  const h = await readHarness(t);
  const response = await h.request("/api/bootstrap", { method: "OPTIONS", headers: {
    origin: "http://localhost:8787", "access-control-request-method": "GET", "access-control-request-headers": "Authorization",
  } });
  assert.equal(response.status, 204);
  assert.equal(response.headers.get("access-control-allow-origin"), "http://localhost:8787");
  assert.equal(response.headers.get("access-control-allow-credentials"), null);
  const forbidden = await h.request("/api/bootstrap", { headers: { origin: "https://attacker.example.test" } });
  assert.equal(forbidden.status, 403); assert.equal(forbidden.headers.get("access-control-allow-origin"), null);
  const post = await h.request("/api/bootstrap", { method: "OPTIONS", headers: {
    origin: "http://localhost:8787", "access-control-request-method": "POST",
  } });
  assert.equal(post.status, 405); assert.equal(h.calls.length, 0);
});

test("public config exposes only the client ID and setup status, never service credentials", async (t) => {
  const h = await readHarness(t);
  const response = await h.request("/api/config");
  const data = await response.json();
  assert.equal(data.ready, true); assert.equal(data.googleClientId, CLIENT); assert.equal(data.writesEnabled, false);
  assert.doesNotMatch(JSON.stringify(data), /PRIVATE KEY|client_email|private_key|iam\.gserviceaccount|fixture-service-access-token/);
  assert.equal(h.calls.length, 0);
});

test("missing Google setup fails closed without attempting a request", async (t) => {
  const h = await readHarness(t, { GOOGLE_CLIENT_ID: "", GOOGLE_PRIVATE_KEY: "" });
  const config = await (await h.request("/api/config")).json();
  assert.equal(config.ready, false); assert.equal(config.googleClientId, "");
  const result = await h.bootstrap(await h.token());
  assert.equal(result.status, 503); assert.equal(result.body.code, "GOOGLE_SETUP_REQUIRED");
  assert.equal(h.calls.length, 0);
});

test("another Sheet ID cannot redirect the read-only adapter to production", async (t) => {
  const h = await readHarness(t, { GOOGLE_SHEET_ID: "a-different-workbook" });
  assert.equal((await h.bootstrap(await h.token())).status, 503);
  assert.equal(h.calls.length, 0);
});

test("schema drift fails closed without returning school data", async (t) => {
  const h = await readHarness(t);
  h.tables.Schools[0][25] = "Unexpected Owner header";
  const result = await h.bootstrap(await h.token());
  assert.equal(result.status, 503); assert.equal(result.body.code, "SCHEMA_MISMATCH");
  assert.equal(result.body.schools, undefined);
});

test("users schema drift denies access before school reads", async (t) => {
  const h = await readHarness(t);
  h.tables["CRM Users"][0][3] = "Unexpected Active header";
  assert.equal((await h.bootstrap(await h.token())).status, 503);
  assert.equal(schoolReads(h).length, 0);
});

test("upstream permission and quota failures produce safe actionable errors", async (t) => {
  const h = await readHarness(t);
  const token = await h.token();
  for (const [status, code] of [[403, "TEST_SHEET_ACCESS_REQUIRED"], [429, "GOOGLE_READ_LIMIT_REACHED"], [500, "GOOGLE_CONNECTION_UNAVAILABLE"]]) {
    h.fault("sheet", status);
    const result = await h.bootstrap(token);
    assert.equal(result.status, 503); assert.equal(result.body.code, code);
    assert.doesNotMatch(JSON.stringify(result.body), /PRIVATE_|fixture-service-access-token/);
  }
});

test("service-account token failures never disclose upstream errors or credentials", async (t) => {
  const h = await readHarness(t);
  h.fault("token", 400);
  const result = await h.bootstrap(await h.token());
  assert.equal(result.status, 503); assert.equal(result.body.code, "GOOGLE_CONNECTION_UNAVAILABLE");
  assert.doesNotMatch(JSON.stringify(result.body), /PRIVATE_|KEY|assertion/);
  assert.equal(sheetReads(h).length, 0);
});

test("unavailable Google verification keys fail closed", async (t) => {
  const h = await readHarness(t);
  h.fault("keys", 503);
  assert.equal((await h.bootstrap(await h.token())).status, 401);
  assert.equal(sheetReads(h).length, 0);
});

test("only allowlisted frontend files are served; repository and secret paths return 404", async (t) => {
  const h = await readHarness(t);
  const page = await h.request("/");
  assert.equal(page.status, 200); assert.match(await page.text(), /School outreach/);
  assert.match(page.headers.get("content-security-policy"), /frame-ancestors 'none'/);
  for (const path of ["/.dev.vars", "/.dev.vars.example", "/package.json", "/.git/config", "/src/index.ts", "/docs/google-setup.md"]) {
    assert.equal((await h.request(path)).status, 404);
  }
  assert.equal(h.calls.length, 0);
});

test("read-only directory browsing calculates availability server-side and excludes private student/owner data", async (t) => {
  const h = await readHarness(t);
  const result = await h.directory(await h.token());
  assert.equal(result.status, 200);
  assert.equal(result.body.ok, true);
  assert.equal(result.body.mode, "read-only");
  assert.equal(result.body.writesEnabled, false);
  assert.ok(Array.isArray(result.body.directory));
  assert.equal(result.body.directory.length, 4);

  // Maple Example Secondary is already claimed in Schools (osn 900001) -> available must be false
  const maple = result.body.directory.find((d) => d.osn === "900001");
  assert.ok(maple);
  assert.equal(maple.schoolName, "Maple Example Secondary");
  assert.equal(maple.available, false);

  // Other unclaimed schools are available
  const unclaimed = result.body.directory.find((d) => d.osn === "900002");
  assert.ok(unclaimed);
  assert.equal(unclaimed.schoolName, "Example School 2");
  assert.equal(unclaimed.available, true);

  // Private notes, student owners, contact details must not leak in directory
  assert.doesNotMatch(JSON.stringify(result.body), /PRIVATE_|alex@example\.test|sam@example\.test/);
  for (const entry of result.body.directory) {
    assert.deepEqual(Object.keys(entry).sort(), [
      "osn", "schoolName", "schoolBoard", "schoolLevel", "gradeRange",
      "city", "streetAddress", "postalCode", "geographicRegion", "available",
    ].sort());
  }

  // Live mutations remain blocked
  assert.equal((await h.request("/api/directory", { method: "POST" })).status, 405);
  assert.equal((await h.request("/api/schools/claim", { method: "POST" })).status, 405);

  // Blank status in School Directory must NOT count as available (requires explicit Available)
  h.tables["School Directory"].push([
    "900005", "Blank Status Secondary", "EXAMPLE", "Secondary", "9-12",
    "Example City", "123 Street", "A1A 1A1", "", "", "", "Example Region", "Area A", "", "",
  ]);
  const resWithBlank = await h.directory(await h.token());
  assert.equal(resWithBlank.status, 200);
  const blankSchool = resWithBlank.body.directory.find((d) => d.osn === "900005");
  assert.ok(blankSchool);
  assert.equal(blankSchool.available, false);

  // Validates every directory column used; schema mismatch fails closed with 503
  const origHeader = [...h.tables["School Directory"][0]];
  h.tables["School Directory"][0][14] = "Corrupted Outreach Status";
  assert.equal((await h.directory(await h.token())).status, 503);
  h.tables["School Directory"][0] = origHeader;
});

test("synthetic claiming works through SQLite DO coordinator on invented schools only and rejects real schools", async (t) => {
  const h = await readHarness(t);
  const token = await h.token();

  // GET /api/demo/schools returns invented test schools
  const demoList = await h.request("/api/demo/schools");
  assert.equal(demoList.status, 200);
  const demoData = await demoList.json();
  assert.equal(demoData.demo, true);
  assert.ok(demoData.schools.some((s) => s.osn === "900002" && s.available === true));

  // Attempting to claim a non-invented / real school OSN in demo is rejected
  const realSchoolClaim = await h.demoClaim(token, { osn: "751537" });
  assert.equal(realSchoolClaim.status, 422);
  assert.equal(realSchoolClaim.body.code, "DEMO_INVENTED_SCHOOLS_ONLY");

  // Attempting to claim an already claimed invented school (900001) yields 409
  const claimedSchool = await h.demoClaim(token, { osn: "900001" });
  assert.equal(claimedSchool.status, 409);
  assert.equal(claimedSchool.body.code, "SCHOOL_ALREADY_CLAIMED");

  // Successfully claiming an available invented school (900002)
  const requestId = crypto.randomUUID();
  const success = await h.demoClaim(token, { osn: "900002", requestId });
  assert.equal(success.status, 200);
  assert.equal(success.body.ok, true);
  assert.equal(success.body.demo, true);
  assert.equal(success.body.message, "Demo claim saved — test data only");
  assert.equal(success.body.record.schoolName, "Example School 2");
  assert.equal(success.body.record.ownerEmail, ACTOR);

  // Retrying the same claim with identical requestId returns replayed result safely
  const replay = await h.demoClaim(token, { osn: "900002", requestId });
  assert.equal(replay.status, 200);

  // Racing or subsequent claim of 900002 with a new requestId fails with 409
  const duplicate = await h.demoClaim(token, { osn: "900002", requestId: crypto.randomUUID() });
  assert.equal(duplicate.status, 409);
  assert.equal(duplicate.body.code, "SCHOOL_ALREADY_CLAIMED");
});

test("demo identity verifies active CRM membership, maps to isolated synthetic actor, and dynamically updates demo availability", async (t) => {
  const h = await readHarness(t);

  // 1. Unlisted Google account is denied before touching coordinator
  const unlistedToken = await h.token({ email: "unlisted@example.test" });
  const unlistedClaim = await h.demoClaim(unlistedToken, { osn: "900003" });
  assert.equal(unlistedClaim.status, 403);
  assert.equal(unlistedClaim.body.code, "USER_NOT_ALLOWED");

  // 2. Inactive CRM account is denied
  h.tables["CRM Users"].push(["inactive@example.test", "Inactive User", "co-op", false]);
  const inactiveToken = await h.token({ email: "inactive@example.test" });
  const inactiveClaim = await h.demoClaim(inactiveToken, { osn: "900003" });
  assert.equal(inactiveClaim.status, 403);
  assert.equal(inactiveClaim.body.code, "USER_NOT_ALLOWED");

  // 3. Active CRM user (even with arbitrary allowed email) maps to isolated synthetic actor
  h.tables["CRM Users"].push(["real_member@example.test", "Real Member", "co-op", true]);
  const realMemberToken = await h.token({ email: "real_member@example.test" });
  const memberClaim = await h.demoClaim(realMemberToken, { osn: "900003" });
  assert.equal(memberClaim.status, 200);
  assert.equal(memberClaim.body.message, "Demo claim saved — test data only");
  // Never copy real identity into fixture: record owner is isolated synthetic actor ACTOR ("alex@example.test")
  assert.equal(memberClaim.body.record.ownerEmail, ACTOR);
  assert.notEqual(memberClaim.body.record.ownerEmail, "real_member@example.test");

  // 4. GET /api/demo/schools reads current synthetic state dynamically: 900003 is now unavailable
  const demoList = await h.request("/api/demo/schools");
  assert.equal(demoList.status, 200);
  const demoData = await demoList.json();
  const claimedEntry = demoData.schools.find((s) => s.osn === "900003");
  assert.ok(claimedEntry);
  assert.equal(claimedEntry.available, false);
  // Unclaimed 900004 remains available
  const unclaimedEntry = demoData.schools.find((s) => s.osn === "900004");
  assert.ok(unclaimedEntry);
  assert.equal(unclaimedEntry.available, true);
});

