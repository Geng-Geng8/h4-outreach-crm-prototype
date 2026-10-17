import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import vm from "node:vm";
import { webcrypto } from "node:crypto";

const appCode = await readFile("public/app.js", "utf8");

const sessionKey = "h4.crm.session-token.v1";
const resumeKey = "h4.crm.resume-view.v1";
const reloadRecord = { recordId: "example", schoolName: "Example School", schoolBoard: "EXAMPLE", geographicRegion: "North", stage: "Contacted", nextAction: "Private next step", notes: "Private notes", lastRequestId: "version-1" };
const reloadPayload = () => ({ currentUser: { name: "Alex", email: "alex@example.test", role: "co-op" }, schools: [reloadRecord], sessionExpiresAt: Math.floor(Date.now() / 1000) + 3600 });
function fixtureCredential(nonce, exp = Math.floor(Date.now() / 1000) + 3600) {
  return { credential: `header.${Buffer.from(JSON.stringify({ nonce, exp })).toString("base64url")}.signature` };
}
async function until(predicate) {
  for (let i = 0; i < 100; i++) {
    if (predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  assert.fail("Expected browser state did not arrive");
}
function reloadFetch(url) {
  if (url.includes("/api/config")) return Promise.resolve(Response.json({ ready: true, writesEnabled: true, googleClientId: "fixture-client" }));
  if (url.includes("/api/schools/detail")) return Promise.resolve(Response.json({ record: reloadRecord }));
  return Promise.resolve(Response.json(reloadPayload()));
}

test("F5 restores the tab via session storage without prompting Google account chooser or caching private data", async (t) => {
  const storage = new Map();
  const before = setupEnv({ storage, fetchHandler: reloadFetch }); t.after(before.cleanup);
  await before.signIn("alex@example.test"); before.context.switchTab("my-schools");
  assert.equal(storage.has(sessionKey), true);
  assert.equal(storage.get(resumeKey), "my-schools");
  assert.equal(storage.size, 2, "only session token and view hint are stored; no private data");
  before.cleanup();

  let respond, promptCalled = false;
  const after = setupEnv({ storage, onPrompt: () => { promptCalled = true; }, fetchHandler: async (url, init) => {
    if (url.includes("/api/config")) return reloadFetch(url);
    assert.match(init.headers.Authorization, /^Bearer /);
    return new Promise((resolve) => { respond = resolve; });
  } }); t.after(after.cleanup);

  // Before server authorization arrives: restore view is active, workspace is hidden, no cached schools
  await until(() => respond);
  assert.equal(promptCalled, false, "Google account chooser was not prompted on refresh");
  assert.equal(after.getEl("session-restore").hidden, false);
  assert.equal(after.getEl("workspace").hidden, true);
  assert.equal(after.getEl("school-list").children.length, 0, "no cached records before server authorization");

  respond(Response.json(reloadPayload()));
  await until(() => !after.getEl("workspace").hidden);
  assert.equal(after.getEl("schools-view").hidden, false);
  assert.equal(after.getEl("session-restore").hidden, true);
  assert.equal(after.getEl("user-name").textContent, "Alex");
  assert.equal(storage.get(resumeKey), "my-schools");
});

test("explicit sign-out clears session token and navigation hint; subsequent reload stays on welcome screen", async (t) => {
  const storage = new Map();
  const h = setupEnv({ storage, fetchHandler: reloadFetch }); t.after(h.cleanup);
  await h.signIn("alex@example.test");
  assert.equal(storage.has(sessionKey), true);
  const old = h.googleOptions();

  h.getEl("sign-out").click();
  await until(() => h.googleOptions() !== old);
  assert.equal(storage.has(sessionKey), false);
  assert.equal(storage.has(resumeKey), false);
  assert.equal(h.getEl("workspace").hidden, true);
  assert.equal(h.getEl("school-list").children.length, 0);
  assert.equal(h.getEl("login-status").textContent, "You’re signed out.");

  // Stale callback from earlier nonce does not restore session
  await old.callback(fixtureCredential(old.nonce));
  assert.equal(h.getEl("workspace").hidden, true);
  assert.equal(storage.has(sessionKey), false);

  // Subsequent reload starts cleanly on sign-in screen without restore attempt
  const next = setupEnv({ storage, fetchHandler: reloadFetch }); t.after(next.cleanup);
  await until(() => next.googleOptions());
  assert.equal(next.getEl("session-restore").hidden, true);
  assert.equal(next.getEl("welcome").hidden, false);
  assert.equal(next.getEl("google-button").hidden, false);
});

test("expired session on reload clears storage, prevents workspace access, and prompts for fresh sign-in", async (t) => {
  // Scenario A: Client-side expired token (exp in the past)
  const expiredPayload = Buffer.from(JSON.stringify({ nonce: "test", exp: Math.floor(Date.now() / 1000) - 60 })).toString("base64url");
  const expiredToken = `header.${expiredPayload}.signature`;
  const storage = new Map([[sessionKey, expiredToken], [resumeKey, "my-schools"]]);

  const h = setupEnv({ storage, fetchHandler: reloadFetch }); t.after(h.cleanup);
  await until(() => h.googleOptions());
  assert.equal(h.getEl("workspace").hidden, true);
  assert.equal(h.getEl("session-restore").hidden, true);
  assert.equal(h.getEl("welcome").hidden, false);
  assert.match(h.getEl("login-status").textContent, /expired/);
  assert.equal(storage.has(sessionKey), false);
  assert.equal(storage.has(resumeKey), false);

  // Scenario B: Server-side expired/invalid token (401 response from server)
  const validFormatPayload = Buffer.from(JSON.stringify({ nonce: "test", exp: Math.floor(Date.now() / 1000) + 3600 })).toString("base64url");
  const serverRejectedToken = `header.${validFormatPayload}.signature`;
  const storageB = new Map([[sessionKey, serverRejectedToken], [resumeKey, "my-schools"]]);
  const h2 = setupEnv({ storage: storageB, fetchHandler: (url) => url.includes("/api/config")
    ? reloadFetch(url)
    : Promise.resolve(Response.json({ ok: false, code: "INVALID_GOOGLE_TOKEN" }, { status: 401 }))
  }); t.after(h2.cleanup);
  await until(() => h2.googleOptions());
  assert.equal(h2.getEl("workspace").hidden, true);
  assert.equal(storageB.has(sessionKey), false);
  assert.equal(storageB.has(resumeKey), false);
  assert.match(h2.getEl("login-status").textContent, /sign-in couldn’t be verified|sign in again/);
});

test("revoked restore is rejected by the server (403) and clears all stored session and private data", async (t) => {
  const tokenPayload = Buffer.from(JSON.stringify({ nonce: "test", exp: Math.floor(Date.now() / 1000) + 3600 })).toString("base64url");
  const storage = new Map([[sessionKey, `header.${tokenPayload}.signature`], [resumeKey, "home"]]);
  const h = setupEnv({ storage, fetchHandler: (url) => url.includes("/api/config")
    ? reloadFetch(url)
    : Promise.resolve(Response.json({ ok: false, code: "USER_NOT_ALLOWED" }, { status: 403 }))
  }); t.after(h.cleanup);
  await until(() => h.googleOptions());
  assert.equal(h.getEl("workspace").hidden, true);
  assert.equal(h.getEl("session-restore").hidden, true);
  assert.equal(h.getEl("home-actions").children.length, 0);
  assert.equal(h.getEl("user-name").textContent, "");
  assert.equal(storage.has(sessionKey), false);
  assert.equal(storage.has(resumeKey), false);
  assert.match(h.getEl("login-status").textContent, /doesn’t have access/);
});

test("manual cancellation on restore screen clears stored session and returns to login", async (t) => {
  const tokenPayload = Buffer.from(JSON.stringify({ nonce: "test", exp: Math.floor(Date.now() / 1000) + 3600 })).toString("base64url");
  const storage = new Map([[sessionKey, `header.${tokenPayload}.signature`], [resumeKey, "my-schools"]]);
  let holdBootstrap;
  const h = setupEnv({ storage, fetchHandler: (url) => {
    if (url.includes("/api/config")) return reloadFetch(url);
    return new Promise((resolve) => { holdBootstrap = resolve; });
  } }); t.after(h.cleanup);
  await until(() => holdBootstrap);
  assert.equal(h.getEl("session-restore").hidden, false);
  assert.equal(storage.has(sessionKey), true);

  h.getEl("restore-sign-in").click();
  assert.equal(h.getEl("session-restore").hidden, true);
  assert.equal(h.getEl("welcome").hidden, false);
  assert.equal(storage.has(sessionKey), false);
  assert.equal(storage.has(resumeKey), false);
  assert.match(h.getEl("login-status").textContent, /Continue with Google/);
});

test("regression: offline reload with stored session keeps recovery controls visible, and reconnection or retry restores writesEnabled", async (t) => {
  const tokenPayload = Buffer.from(JSON.stringify({ nonce: "test", exp: Math.floor(Date.now() / 1000) + 3600 })).toString("base64url");
  const storage = new Map([[sessionKey, `header.${tokenPayload}.signature`], [resumeKey, "my-schools"]]);

  // Start offline
  const h = setupEnv({ storage, online: false, fetchHandler: reloadFetch }); t.after(h.cleanup);

  // Recovery controls must remain visible: welcome card and retry button are shown, session-restore is hidden
  assert.equal(h.getEl("session-restore").hidden, true);
  assert.equal(h.getEl("welcome").hidden, false);
  assert.equal(h.getEl("workspace").hidden, true);
  assert.equal(h.getEl("retry").hidden, false);
  assert.equal(h.getEl("google-button").hidden, true);
  assert.match(h.getEl("login-status").textContent, /not connected/);

  // Reconnection loads config first and restores workspace with writesEnabled true ("Up to date")
  h.context.navigator.onLine = true;
  await h.dispatchWindow("online");
  await until(() => !h.getEl("workspace").hidden);

  assert.equal(h.getEl("workspace").hidden, false);
  assert.equal(h.getEl("welcome").hidden, true);
  assert.equal(h.getEl("session-restore").hidden, true);
  assert.equal(h.getEl("workspace-status").textContent, "Up to date");
});

test("regression: initial /api/config failure with stored session keeps recovery controls visible, and Retry loads config before restoring workspace", async (t) => {
  const tokenPayload = Buffer.from(JSON.stringify({ nonce: "test", exp: Math.floor(Date.now() / 1000) + 3600 })).toString("base64url");
  const storage = new Map([[sessionKey, `header.${tokenPayload}.signature`], [resumeKey, "my-schools"]]);
  let configFails = true;
  let configAttempts = 0;

  const h = setupEnv({ storage, fetchHandler: (url) => {
    if (url.includes("/api/config")) {
      configAttempts++;
      if (configFails) return Promise.resolve(new Response("Config error", { status: 503 }));
    }
    return reloadFetch(url);
  } }); t.after(h.cleanup);

  // Both screens must not be hidden: welcome card is visible, retry button is shown
  await until(() => h.getEl("session-restore").hidden);
  assert.equal(h.getEl("welcome").hidden, false);
  assert.equal(h.getEl("workspace").hidden, true);
  assert.equal(h.getEl("retry").hidden, false);
  assert.equal(h.getEl("google-button").hidden, true);
  assert.match(h.getEl("login-status").textContent, /reach the app|restore your workspace/);
  assert.equal(configAttempts, 1);

  // When server recovers and user clicks Retry: config must load successfully before refresh()
  configFails = false;
  h.getEl("retry").click();
  await until(() => !h.getEl("workspace").hidden);

  assert.equal(configAttempts, 2);
  assert.equal(h.getEl("workspace").hidden, false);
  assert.equal(h.getEl("welcome").hidden, true);
  assert.equal(h.getEl("session-restore").hidden, true);
  // Writes must be correctly enabled ("Up to date", not "Up to date · viewing only")
  assert.equal(h.getEl("workspace-status").textContent, "Up to date");
});

test("temporary refresh failures keep the signed-in workspace and draft; recovery succeeds and a real 403 clears them", async (t) => {
  let failure = "";
  const h = setupEnv({ fetchHandler: (url) => {
    if (url.includes("/api/bootstrap")) {
      if (failure === "network") return Promise.reject(new TypeError("Network lost"));
      if (failure === "json") return Promise.resolve(new Response("broken JSON"));
      if (failure) return Promise.resolve(new Response("Unavailable", { status: Number(failure) }));
    }
    return reloadFetch(url);
  } }); t.after(h.cleanup);
  await h.signIn("alex@example.test"); await h.context.openSchoolEditor(reloadRecord.recordId);
  h.getEl("edit-notes").value = "Keep my draft";
  for (failure of ["503", "network", "json"]) {
    await h.context.refresh();
    assert.equal(h.getEl("workspace").hidden, false);
    assert.equal(h.getEl("school-editor").open, true);
    assert.equal(h.getEl("edit-notes").value, "Keep my draft");
    assert.match(h.getEl("home-status").textContent, /last loaded records/);
    assert.equal(h.getEl("refresh").disabled, false);
  }
  failure = ""; await h.context.refresh(); assert.equal(h.getEl("workspace-status").textContent, "Up to date");
  failure = "403"; await h.context.refresh();
  assert.equal(h.getEl("workspace").hidden, true);
  assert.equal(h.getEl("edit-notes").value, ""); assert.equal(h.getEl("school-editor").open, false);
});

test("first-load outage can retry without another Google login; disabled browser storage does not break login", async (t) => {
  let bootstrap = 0, configs = 0;
  const storage = { get() { throw new Error("Storage blocked"); }, set() { throw new Error("Storage blocked"); }, delete() { throw new Error("Storage blocked"); } };
  const h = setupEnv({ storage, fetchHandler: (url) => {
    if (url.includes("/api/config")) configs++;
    if (url.includes("/api/bootstrap") && bootstrap++ === 0) return Promise.resolve(Response.json({}, { status: 503 }));
    return reloadFetch(url);
  } }); t.after(h.cleanup);
  await h.signIn("alex@example.test");
  assert.equal(h.getEl("workspace").hidden, true); assert.equal(h.getEl("retry").hidden, false);
  h.getEl("retry").click(); await until(() => !h.getEl("workspace").hidden);
  assert.equal(bootstrap, 2); assert.equal(configs, 1);
  h.getEl("sign-out").click(); assert.equal(h.getEl("workspace").hidden, true);
});

test("a timed-out refresh unlocks retry without signing out; token expiry still clears protected data", async (t) => {
  let hang = false;
  const h = setupEnv({ timerDelay: (ms) => ms === 15000 ? 5 : ms, fetchHandler: (url, init) => {
    if (hang && url.includes("/api/bootstrap")) return new Promise((_, reject) => {
      init.signal.addEventListener("abort", () => reject(Object.assign(new Error("Aborted"), { name: "AbortError" })));
    });
    return reloadFetch(url);
  } }); t.after(h.cleanup);
  await h.signIn("alex@example.test"); hang = true; await h.context.refresh();
  assert.equal(h.getEl("workspace").hidden, false);
  assert.match(h.getEl("home-status").textContent, /timed out/);
  assert.equal(h.getEl("refresh").disabled, false);
  assert.equal(h.getEl("home-refresh").disabled, false);
  const expired = setupEnv({ fetchHandler: async (url) => url.includes("/api/config") ? reloadFetch(url) : Response.json({ ...reloadPayload(), sessionExpiresAt: 1 }) }); t.after(expired.cleanup);
  await expired.signIn("alex@example.test");
  assert.equal(expired.getEl("workspace").hidden, true);
  assert.equal(expired.getEl("home-actions").children.length, 0);
  assert.match(expired.getEl("login-status").textContent, /expired/);
});

test("access rejection during save resets the Google button so a fresh authorized login can recover", async (t) => {
  const h = setupEnv({ fetchHandler: (url) => url.includes("/api/schools/update")
    ? Promise.resolve(Response.json({ code: "USER_NOT_ALLOWED" }, { status: 403 })) : reloadFetch(url) }); t.after(h.cleanup);
  await h.signIn("alex@example.test"); const old = h.googleOptions();
  await h.context.openSchoolEditor(reloadRecord.recordId);
  h.getEl("edit-notes").value = "Changed notes";
  await h.context.saveSchoolEdits({ preventDefault() {} });
  assert.equal(h.getEl("workspace").hidden, true);
  assert.notEqual(h.googleOptions().nonce, old.nonce);
  assert.equal(h.getEl("google-button").hidden, false);
  await h.signIn("alex@example.test");
  assert.equal(h.getEl("workspace").hidden, false);
});

test("students land on My Outreach with correct priorities, quick actions and a working follow-up reminder", async (t) => {
  const today = new Intl.DateTimeFormat("en-CA", { timeZone: "America/Toronto", year: "numeric", month: "2-digit", day: "2-digit" }).format(new Date());
  const records = [
    { recordId: "overdue", schoolName: "Overdue School", stage: "Contacted", followUpDue: "2000-01-01", nextAction: "Call the office" },
    { recordId: "today", schoolName: "Today School", stage: "Interested", followUpDue: today, nextAction: "Follow up today" },
    { recordId: "high", schoolName: "Priority School", stage: "Not Contacted", priority: "High" },
    { recordId: "booked", schoolName: "Booked School", stage: "Booked", followUpDue: "2000-01-01" },
    { recordId: "cold", schoolName: "Cold School", stage: "Cold", followUpDue: "2000-01-01" },
    { recordId: "engaged", schoolName: "Engaged School", stage: "Engaged", followUpDue: "2099-01-01" },
  ].map((school) => ({ schoolBoard: "EXAMPLE", geographicRegion: "North", assignedTo: "Alex", lastRequestId: "00000000-0000-4000-8000-000000000002", ...school }));
  const requests = [], saves = [];
  const h = setupEnv({ fetchHandler: async (url, init = {}) => {
    requests.push(url);
    if (url.includes("/api/config")) return Response.json({ ready: true, writesEnabled: true, googleClientId: "test-client-id" });
    if (url.includes("/api/bootstrap")) return Response.json({ currentUser: { name: "Alex", email: "alex@example.test", role: "co-op" }, schools: records, sessionExpiresAt: Math.floor(Date.now()/1000)+3600 });
    if (url.includes("/api/schools/detail")) return Response.json({ record: records[0] });
    if (url.includes("/api/schools/update")) {
      const body = JSON.parse(init.body); saves.push(body); Object.assign(records[0], body.patch, { lastRequestId: body.requestId });
      return Response.json({ ok: true, record: records[0] });
    }
    return Response.json({ directory: [] });
  } }); t.after(h.cleanup);
  await h.signIn("alex@example.test");
  assert.equal(h.getEl("tab-home").textContent, "My Outreach"); assert.equal(h.getEl("tab-home").getAttribute("aria-selected"), "true");
  assert.equal(h.getEl("home-view").hidden, false); assert.equal(h.getEl("overview-panel").hidden, true);
  assert.equal(h.getEl("workspace-heading").textContent, "My Outreach.");
  assert.equal(requests.length, 2, "initial config + bootstrap, with no extra dashboard fetch");
  assert.deepEqual(h.getEl("home-metrics").children.map((node) => node.children[0].textContent), ["6", "2", "2", "1"]);
  assert.equal(h.getEl("home-actions").children[0].children[1].textContent, "Overdue School");
  assert.match(h.getEl("home-description").textContent, /Overdue School.*Call the office/);
  h.getEl("home-metrics").children[3].click(); assert.equal(h.getEl("home-actions").children.length, 1);
  assert.equal(h.getEl("home-actions").children[0].children[1].textContent, "Booked School");
  await h.context.openAction("overdue", "reminder");
  assert.equal(h.getEl("school-editor").open, true); assert.equal(h.getEl("edit-followUpDue").focused, true);
  h.getEl("edit-followUpDue").value = "2099-02-01"; await h.context.saveSchoolEdits({ preventDefault() {} });
  assert.equal(saves.length, 1); assert.equal(saves[0].patch.followUpDue, "2099-02-01");
  assert.equal(h.getEl("save-toast").textContent, "✓ Saved"); assert.equal(h.getEl("school-editor").open, false);
  assert.equal(h.getEl("home-metrics").children[1].children[0].textContent, "1");
  await h.context.openAction("overdue", "contact"); assert.equal(h.getEl("edit-contactName").focused, true);
  h.context.closeSchoolEditor(); await h.context.openAction("overdue", "log"); assert.equal(h.getEl("outreach-fields").hidden, false);
  h.context.closeSchoolEditor(); h.getEl("home-find").click();
  assert.equal(h.getEl("directory-view").hidden, false);
  assert.equal(h.context.dashboardToday(new Date("2026-10-16T02:00:00Z")), "2026-10-15");
  assert.equal(h.context.dashboardToday(new Date("2026-01-16T04:59:00Z")), "2026-01-15");
  assert.equal(h.context.dueState({ stage: "Interested", followUpDue: today }, today), "today");
});

test("supervisors land on H4 Overview; totals use dates, student drill-down survives refresh, downgrade and revocation clear protected data", async (t) => {
  let role = "Supervisor", revoked = false;
  const records = [
    { recordId: "1", schoolName: "Alex First School", studentId: "alex", stage: "Not Contacted", followUpDue: "2000-01-01", nextAction: "Make contact" },
    { recordId: "2", schoolName: "Sam School", studentId: "sam", stage: "Interested", followUpDue: "2000-01-01", lastContacted: "2026-10-01" },
    { recordId: "3", schoolName: "Booked School", studentId: "alex", stage: "Booked" },
    { recordId: "4", schoolName: "Cold School", studentId: "alex", stage: "Cold" },
  ].map((s) => ({ schoolBoard: "EXAMPLE", geographicRegion: "North", assignedTo: s.studentId === "sam" ? "Sam" : "Alex", ...s }));
  const h = setupEnv({ fetchHandler: async (url) => {
    if (url.includes("/api/config")) return Response.json({ ready: true, writesEnabled: true, googleClientId: "test-client-id" });
    if (revoked) return Response.json({ code: "USER_NOT_ALLOWED" }, { status: 403 });
    if (url.includes("/api/dashboard")) return Response.json({ ok: true, schools: records.map(({ studentId, nextAction, ...school }) => ({ ...school, canEdit: false })) });
    return Response.json({ currentUser: { name: "Morgan", email: "morgan@example.test", role }, schools: role === "Supervisor" ? records : [records[0]],
      ...(role === "Supervisor" ? { overview: { students: [{ id: "alex", name: "Alex", active: true }, { id: "sam", name: "Sam", active: true }, { id: "new", name: "New student", active: true }] } } : {}), sessionExpiresAt: Math.floor(Date.now()/1000)+3600 });
  } }); t.after(h.cleanup);
  await h.signIn("morgan@example.test");
  assert.equal(h.getEl("workspace-heading").textContent, "H4 Overview."); assert.equal(h.getEl("overview-panel").hidden, false);
  assert.deepEqual(h.getEl("home-metrics").children.map((node) => node.children[0].textContent), ["4", "1", "1", "1", "2"]);
  assert.equal(h.getEl("overview-students").children.length, 3);
  const sam = h.getEl("overview-students").children.find((row) => row.children[0].children[0].textContent === "Sam");
  assert.equal(sam.children[1].textContent, "1"); assert.equal(sam.children[4].textContent, "1");
  h.context.renderPipeline("overview-pipeline", [...records, { stage: "Legacy stage" }], () => {});
  assert.equal(h.getEl("overview-pipeline").children.length, 7);
  assert.equal(h.getEl("overview-pipeline").children[6].children[1].textContent, "1");
  h.context.renderHome();
  sam.children[5].children[0].click(); assert.equal(h.getEl("school-list").children.length, 1);
  assert.equal(h.getEl("school-count").textContent, "1"); assert.equal(h.getEl("school-count-label").textContent, "of 4 schools");
  records.push({ ...records[1], recordId: "5", schoolName: "New Sam School" }); await h.context.refresh();
  assert.equal(h.getEl("school-list").children.length, 2, "student filter follows new assignments after refresh");
  h.getEl("schools-scope-clear").click(); assert.equal(h.getEl("school-list").children.length, 5);
  h.getEl("overview-pipeline").children[4].click(); assert.equal(h.getEl("school-list").children.length, 1);
  role = "co-op"; await h.context.refresh();
  assert.equal(h.getEl("tab-home").textContent, "My Outreach"); assert.equal(h.getEl("overview-students").children.length, 0);
  assert.equal(h.getEl("overview-panel").hidden, true); assert.equal(h.getEl("home-metrics").children.length, 4);
  assert.equal(h.getEl("school-list").children.length, 1);
  await h.context.loadDashboard(); assert.equal(h.getEl("dashboard-rows").children.length, 5);
  revoked = true; await h.context.loadDashboard();
  assert.equal(h.getEl("workspace").hidden, true); assert.equal(h.getEl("home-actions").children.length, 0);
  assert.equal(h.getEl("home-metrics").children.length, 0); assert.equal(h.getEl("dashboard-rows").children.length, 0);
  assert.equal(h.getEl("home-description").textContent, ""); assert.equal(h.getEl("schools-scope-label").textContent, "");
  assert.equal(h.getEl("school-count").textContent, "0");
});

test("quick-action revocation clears protected home data, and late bootstrap JSON cannot restore signed-out data", async (t) => {
  let late = false, resolveJson;
  const payload = { currentUser: { name: "Morgan", email: "morgan@example.test", role: "Supervisor" }, schools: [{ recordId: "1", schoolName: "Protected School", schoolBoard: "EXAMPLE", geographicRegion: "North", nextAction: "Protected action" }], overview: { students: [{ id: "alex", name: "Protected Student", active: true }] }, sessionExpiresAt: Math.floor(Date.now()/1000)+3600 };
  const h = setupEnv({ fetchHandler: async (url) => {
    if (url.includes("/api/config")) return Response.json({ ready: true, writesEnabled: true, googleClientId: "test-client-id" });
    if (url.includes("/api/schools/detail")) return Response.json({ code: "USER_NOT_ALLOWED" }, { status: 403 });
    if (late) return { ok: true, json: () => new Promise((resolve) => { resolveJson = resolve; }) };
    return Response.json(payload);
  } }); t.after(h.cleanup);
  await h.signIn("morgan@example.test"); await h.context.openAction("1", "reminder");
  assert.equal(h.getEl("workspace").hidden, true); assert.equal(h.getEl("home-actions").children.length, 0);
  assert.equal(h.getEl("overview-students").children.length, 0); assert.equal(h.getEl("school-editor").open, false);
  await h.signIn("morgan@example.test"); late = true;
  const pending = h.context.refresh(); await new Promise((resolve) => setTimeout(resolve, 1));
  h.getEl("sign-out").click(); resolveJson(payload); await pending;
  assert.equal(h.getEl("workspace").hidden, true); assert.equal(h.getEl("home-actions").children.length, 0);
  assert.equal(h.getEl("overview-students").children.length, 0); assert.equal(h.getEl("home-metrics").children.length, 0);
});

test("Team Progress combines school filters without individual performance cards or other-owner actions", async (t) => {
  const stages = ["Not Contacted", "Contacted", "Interested", "Engaged", "Booked", "Cold", "Legacy stage"];
  const records = stages.map((stage, i) => ({ recordId: String(i), schoolName: `School ${i}`, schoolBoard: "BOARD", geographicRegion: "North",
    assignedTo: i % 2 ? "Sam" : "Alex", stage, lastContacted: "", followUpDue: "2000-01-01", canEdit: i % 2 === 0 }));
  let unavailable = false;
  const h = setupEnv({ fetchHandler: async (url) => {
    if (url.includes("/api/config")) return Response.json({ ready: true, writesEnabled: true, googleClientId: "test-client-id" });
    if (url.includes("/api/dashboard")) return unavailable ? Response.json({ ok: false }, { status: 503 }) : Response.json({ ok: true, schools: records });
    return Response.json({ currentUser: { name: "Alex", email: "alex@example.test", role: "co-op" }, schools: [records[0]], sessionExpiresAt: Math.floor(Date.now()/1000)+3600 });
  } }); t.after(h.cleanup);
  await h.signIn("alex@example.test"); await h.context.switchTab("dashboard");
  // Tab selection starts a read. Wait on a subsequent read to exercise latest-request handling too.
  await h.context.loadDashboard();
  assert.equal(h.getEl("dashboard-view").hidden, false); assert.equal(h.getEl("schools-view").hidden, true);
  assert.equal(h.getEl("dashboard-rows").children.length, 7);
  assert.equal(h.getEl("dashboard-metrics").children.length, 0);
  assert.equal(h.getEl("dashboard-team").children.length, 0);
  assert.equal(h.getEl("dashboard-rows").children.find((row) => row.children[0].children[0].textContent === "School 1").children[5].textContent, "View only");
  assert.equal(h.getEl("dashboard-rows").children[0].children[5].children[0].textContent, "Open school →");
  h.getEl("dashboard-stage").value = "Booked"; h.context.renderDashboard();
  assert.equal(h.getEl("dashboard-count").textContent, "Showing 1 of 7 claimed schools");
  assert.equal(h.getEl("dashboard-rows").children[0].children[0].children[0].textContent, "School 4");
  h.getEl("dashboard-owner").value = "Sam"; h.context.renderDashboard();
  assert.equal(h.getEl("dashboard-rows").children.length, 0); assert.equal(h.getEl("dashboard-empty").hidden, false);
  h.context.clearDashboardFilters(); h.getEl("dashboard-search").value = "School 3"; h.context.renderDashboard();
  assert.equal(h.getEl("dashboard-rows").children.length, 1);
  h.context.clearDashboardFilters(); h.getEl("dashboard-overdue").checked = true; h.context.renderDashboard();
  assert.equal(h.getEl("dashboard-rows").children.length, 5);
  assert.equal(h.context.overdueSchool({ stage: "Contacted", followUpDue: "2000-02-31" }), false);
  assert.equal(h.context.overdueSchool({ stage: "Contacted", followUpDue: "1/2/2000" }), false);
  unavailable = true; await h.context.loadDashboard();
  assert.equal(h.getEl("dashboard-content").hidden, true); assert.match(h.getEl("dashboard-status").textContent, /Couldn’t load/);
  assert.equal(h.getEl("workspace").hidden, false);
});

test("sign-out clears team data and ignores a dashboard response whose JSON arrives late", async (t) => {
  let resolveJson;
  const h = setupEnv({ fetchHandler: async (url) => {
    if (url.includes("/api/config")) return Response.json({ ready: true, writesEnabled: true, googleClientId: "test-client-id" });
    if (url.includes("/api/dashboard")) return { ok: true, status: 200, json: () => new Promise((resolve) => { resolveJson = resolve; }) };
    return Response.json({ currentUser: { name: "Alex", email: "alex@example.test", role: "co-op" }, schools: [], sessionExpiresAt: Math.floor(Date.now()/1000)+3600 });
  } }); t.after(h.cleanup);
  await h.signIn("alex@example.test"); const pending = h.context.loadDashboard();
  await new Promise((resolve) => setTimeout(resolve, 1));
  h.getEl("sign-out").click(); resolveJson({ ok: true, schools: [{ schoolName: "Must never appear" }] }); await pending;
  assert.equal(h.getEl("dashboard-rows").children.length, 0); assert.equal(h.getEl("dashboard-content").hidden, true);
  assert.equal(h.getEl("workspace").hidden, true); assert.equal(h.getEl("dashboard-count").textContent, "");
});

test("connection badge follows server reachability and browser events without clearing an unsaved draft", async (t) => {
  let health = "ok";
  const record = { recordId: "00000000-0000-4000-8000-000000000001", schoolName: "Example School", schoolBoard: "EXAMPLE", geographicRegion: "Example Region", stage: "Contacted", lastRequestId: "00000000-0000-4000-8000-000000000002" };
  const h = setupEnv({ fetchHandler: async (url) => {
    if (url.includes("/api/config")) return Response.json({ ready: true, writesEnabled: true, googleClientId: "test-client-id" });
    if (url.includes("/api/bootstrap")) return Response.json({ currentUser: { name: "Alex", email: "alex@example.test", role: "co-op" }, schools: [record], sessionExpiresAt: Math.floor(Date.now()/1000)+3600 });
    if (url.includes("/api/schools/detail")) return Response.json({ record });
    if (health === "network") throw new TypeError("Network unavailable");
    return Response.json({ ok: health === "ok" }, { status: health === "server" ? 503 : 200 });
  } }); t.after(h.cleanup);
  await h.signIn("alex@example.test");
  assert.equal(h.getEl("mode-label").textContent, "Online");
  await h.context.openSchoolEditor(record.recordId); h.getEl("edit-notes").value = "Keep this unsaved draft";
  h.context.navigator.onLine = false; await h.dispatchWindow("offline");
  assert.equal(h.getEl("mode-label").textContent, "Not connected"); assert.equal(h.getEl("connection-badge").getAttribute("data-state"), "offline");
  assert.equal(h.getEl("school-editor").open, true); assert.equal(h.getEl("edit-notes").value, "Keep this unsaved draft");
  h.context.navigator.onLine = true; health = "network";
  assert.equal(await h.context.checkConnection(), false); assert.equal(h.getEl("mode-label").textContent, "Not connected");
  health = "server"; assert.equal(await h.context.checkConnection(), false); assert.equal(h.getEl("mode-label").textContent, "Not connected");
  health = "ok"; await h.dispatchWindow("online"); assert.equal(h.getEl("mode-label").textContent, "Online");
  assert.equal(h.getEl("edit-notes").value, "Keep this unsaved draft");
});

test("sign-in works with cached HTML missing the optional badge, and recovers from starting offline", async (t) => {
  let requests = 0;
  const h = setupEnv({ online: false, missingIds: ["mode-label", "connection-badge", "dashboard-view", "tab-dashboard", "dashboard-refresh"], fetchHandler: async (url) => {
    requests++;
    if (url.includes("/api/config")) return Response.json({ ready: true, writesEnabled: true, googleClientId: "test-client-id" });
    if (url.includes("/api/health")) return Response.json({ ok: true });
    return Response.json({ currentUser: { name: "Alex", email: "alex@example.test", role: "co-op" }, schools: [], sessionExpiresAt: Math.floor(Date.now()/1000)+3600 });
  } }); t.after(h.cleanup);
  assert.equal(requests, 0); assert.match(h.getEl("login-status").textContent, /not connected/);
  h.context.navigator.onLine = true; await h.dispatchWindow("online");
  await h.signIn("alex@example.test");
  assert.equal(h.getEl("workspace").hidden, false); assert.equal(h.getEl("user-name").textContent, "Alex");
});

test("Log outreach validates required text, locks double taps, retries the same request and confirms only after save", async (t) => {
  const record = { recordId: "00000000-0000-4000-8000-000000000001", schoolName: "Example School", schoolBoard: "EXAMPLE", geographicRegion: "Example Region", stage: "Not Contacted", lastRequestId: "00000000-0000-4000-8000-000000000002", notes: "Keep these notes" };
  const requests = []; let resolveSave;
  const { context, getEl, signIn, cleanup } = setupEnv({ fetchHandler: async (url, init = {}) => {
    if (url.includes("/api/config")) return Response.json({ ready: true, writesEnabled: true, googleClientId: "test-client-id" });
    if (url.includes("/api/bootstrap")) return Response.json({ currentUser: { name: "Alex", email: "alex@example.test", role: "co-op" }, schools: [record], sessionExpiresAt: Math.floor(Date.now()/1000)+3600 });
    if (url.includes("/api/schools/detail")) return Response.json({ record });
    assert.equal(url, "./api/activities"); requests.push(JSON.parse(init.body));
    return new Promise((done) => { resolveSave = done; });
  } }); t.after(cleanup);
  await signIn("alex@example.test");
  const logButton = getEl("school-list").children[0].children[1];
  assert.equal(logButton.textContent, "Log outreach"); logButton.click();
  // Await the detail read started by the real card action.
  for (let i = 0; i < 10 && getEl("editor-save").disabled; i++) await new Promise((done) => setTimeout(done, 1));
  assert.equal(getEl("outreach-fields").hidden, false); assert.equal(getEl("field-notes").hidden, true);
  assert.equal(getEl("edit-stage").value, "Contacted");
  await context.saveSchoolEdits({ preventDefault() {} }); assert.equal(requests.length, 0);
  getEl("log-outcome").value = "Left a message"; getEl("log-summary").value = "Asked about a workshop.";
  getEl("log-activityType").value = "FollowUp";
  const first = context.saveSchoolEdits({ preventDefault() {} });
  await context.saveSchoolEdits({ preventDefault() {} }); assert.equal(requests.length, 1);
  assert.equal(getEl("editor-save").textContent, "Saving…");
  resolveSave(Response.json({ code: "COMMIT_UNCERTAIN" }, { status: 503 })); await first;
  context.closeSchoolEditor(); await context.openSchoolEditor(record.recordId, false, "activity");
  assert.equal(getEl("log-summary").value, "Asked about a workshop."); assert.equal(getEl("log-summary").disabled, true);
  const retry = context.saveSchoolEdits({ preventDefault() {} });
  assert.deepEqual(requests[0], requests[1]); assert.equal(requests[0].activityType, "FollowUp");
  assert.equal(requests[0].notes, undefined); assert.equal(requests[0].stage, "Contacted");
  resolveSave(Response.json({ ok: true, record: { ...record, lastRequestId: requests[0].requestId } })); await retry;
  assert.equal(getEl("school-editor").open, false); assert.equal(getEl("save-toast").textContent, "✓ Outreach saved");
});

test("outreach conflict keeps the message, reloads current school values and clears private drafts on sign-out", async (t) => {
  let record = { recordId: "00000000-0000-4000-8000-000000000001", schoolName: "Example School", schoolBoard: "EXAMPLE", geographicRegion: "Example Region", stage: "Contacted", followUpDue: "2026-10-20", lastRequestId: "00000000-0000-4000-8000-000000000002" };
  const { context, getEl, signIn, cleanup } = setupEnv({ fetchHandler: async (url) => {
    if (url.includes("/api/config")) return Response.json({ ready: true, writesEnabled: true, googleClientId: "test-client-id" });
    if (url.includes("/api/bootstrap")) return Response.json({ currentUser: { name: "Alex", email: "alex@example.test", role: "co-op" }, schools: [record], sessionExpiresAt: Math.floor(Date.now()/1000)+3600 });
    if (url.includes("/api/schools/detail")) return Response.json({ record });
    return Response.json({ code: "CONFLICT_STALE_VERSION" }, { status: 409 });
  } }); t.after(cleanup);
  await signIn("alex@example.test"); await context.openSchoolEditor(record.recordId, false, "activity");
  getEl("log-outcome").value = "Reply"; getEl("log-summary").value = "Private draft";
  await context.saveSchoolEdits({ preventDefault() {} }); assert.equal(getEl("editor-save").disabled, true);
  record = { ...record, stage: "Interested", followUpDue: "2026-11-01", lastRequestId: "00000000-0000-4000-8000-000000000003" };
  await context.openSchoolEditor(record.recordId, true, "activity");
  assert.equal(getEl("log-summary").value, "Private draft"); assert.equal(getEl("edit-stage").value, "Interested");
  assert.equal(getEl("edit-followUpDue").value, "2026-11-01"); assert.equal(getEl("editor-save").disabled, false);
  getEl("sign-out").click(); assert.equal(getEl("school-editor").open, false); assert.equal(getEl("log-summary").value, "");
});

test("student-friendly outreach flow: displays existing contact, applies outcome and next-action suggestions, and retains drafts across mode toggle", async (t) => {
  let record = { recordId: "00000000-0000-4000-8000-000000000010", schoolName: "Maple Grove High", schoolBoard: "TDSB", geographicRegion: "Toronto", stage: "Not Contacted", contactName: "Ms. Patel", contactRole: "Guidance", lastRequestId: "version-1" };
  const requests = [];
  const { context, getEl, signIn, cleanup } = setupEnv({ fetchHandler: async (url, init = {}) => {
    if (url.includes("/api/config")) return Response.json({ ready: true, writesEnabled: true, googleClientId: "test-client-id" });
    if (url.includes("/api/bootstrap")) return Response.json({ currentUser: { name: "Alex", email: "alex@example.test", role: "co-op" }, schools: [record], sessionExpiresAt: Math.floor(Date.now()/1000)+3600 });
    if (url.includes("/api/schools/detail")) return Response.json({ record });
    if (url.includes("/api/activities")) { requests.push(JSON.parse(init.body)); return Response.json({ ok: true, record: { ...record, stage: "Contacted", lastRequestId: "version-2" } }); }
    return new Response("Not found", { status: 404 });
  } }); t.after(cleanup);
  await signIn("alex@example.test");
  await context.openSchoolEditor(record.recordId, false, "activity");

  // Step 1: Who did you contact?
  assert.equal(getEl("log-contact-name").textContent, "Ms. Patel");
  assert.equal(getEl("log-contact-role").textContent, "· Guidance");
  assert.equal(getEl("log-contact-card").classList.contains("missing"), false);
  assert.equal(getEl("log-contact-edit").textContent, "Edit contact");

  // Step 2: Channel & activity type defaults
  assert.equal(getEl("log-channel").value, "Email");
  assert.equal(getEl("log-activityType").value, "Outreach");

  // Step 3: Suggestions apply to log-outcome
  context.applySuggestion("log-outcome", "No reply yet");
  assert.equal(getEl("log-outcome").value, "No reply yet");
  context.applySuggestion("log-outcome", "Left voicemail");
  assert.equal(getEl("log-outcome").value, "Left voicemail");

  // Step 4: Summary
  getEl("log-summary").value = "Emailed Ms. Patel about a free workshop. She’ll ask the principal. Follow up next Wednesday.";

  // Step 5: Suggestions apply to edit-nextAction
  context.applySuggestion("edit-nextAction", "Follow up if no reply");
  assert.equal(getEl("edit-nextAction").value, "Follow up if no reply");
  getEl("edit-followUpDue").value = "2026-10-21";

  // Switch to contact editor via log-contact-edit and confirm draft preservation
  getEl("log-contact-edit").click();
  for (let i = 0; i < 10 && getEl("editor-save").disabled; i++) await new Promise((done) => setTimeout(done, 1));
  assert.equal(getEl("editor-kind").textContent, "SCHOOL DETAILS");
  assert.equal(getEl("outreach-fields").hidden, true);
  assert.equal(getEl("field-contactName").hidden, false);
  assert.equal(getEl("return-to-activity-container").hidden, false);

  // Return to outreach mode and verify preserved draft
  getEl("return-to-activity").click();
  for (let i = 0; i < 10 && getEl("editor-save").disabled; i++) await new Promise((done) => setTimeout(done, 1));
  assert.equal(getEl("editor-kind").textContent, "LOG OUTREACH");
  assert.equal(getEl("outreach-fields").hidden, false);
  assert.equal(getEl("log-outcome").value, "Left voicemail");
  assert.equal(getEl("log-summary").value, "Emailed Ms. Patel about a free workshop. She’ll ask the principal. Follow up next Wednesday.");
  assert.equal(getEl("edit-nextAction").value, "Follow up if no reply");
  assert.equal(getEl("edit-followUpDue").value, "2026-10-21");

  // Save changes
  await context.saveSchoolEdits({ preventDefault() {} });
  assert.equal(requests.length, 1);
  assert.equal(requests[0].outcome, "Left voicemail");
  assert.equal(requests[0].summary, "Emailed Ms. Patel about a free workshop. She’ll ask the principal. Follow up next Wednesday.");
  assert.equal(requests[0].nextAction, "Follow up if no reply");
  assert.equal(requests[0].followUpDue, "2026-10-21");
  assert.equal(requests[0].stage, "Contacted");
  assert.equal(getEl("save-toast").textContent, "✓ Outreach saved");
});

test("student-friendly outreach flow: missing contact displays fallback and save validation requires outcome and summary", async (t) => {
  let record = { recordId: "00000000-0000-4000-8000-000000000020", schoolName: "Unknown Contact School", schoolBoard: "YRDSB", geographicRegion: "York", stage: "Not Contacted", lastRequestId: "version-1" };
  const requests = [];
  const { context, getEl, signIn, cleanup } = setupEnv({ fetchHandler: async (url, init = {}) => {
    if (url.includes("/api/config")) return Response.json({ ready: true, writesEnabled: true, googleClientId: "test-client-id" });
    if (url.includes("/api/bootstrap")) return Response.json({ currentUser: { name: "Alex", email: "alex@example.test", role: "co-op" }, schools: [record], sessionExpiresAt: Math.floor(Date.now()/1000)+3600 });
    if (url.includes("/api/schools/detail")) return Response.json({ record });
    if (url.includes("/api/activities")) { requests.push(JSON.parse(init.body)); return Response.json({ ok: true, record: { ...record, lastRequestId: "version-2" } }); }
    return new Response("Not found", { status: 404 });
  } }); t.after(cleanup);
  await signIn("alex@example.test");
  await context.openSchoolEditor(record.recordId, false, "activity");

  // Step 1: Missing contact fallback
  assert.equal(getEl("log-contact-name").textContent, "Contact not recorded");
  assert.equal(getEl("log-contact-role").textContent, "");
  assert.equal(getEl("log-contact-card").classList.contains("missing"), true);
  assert.equal(getEl("log-contact-edit").textContent, "Add contact");

  // Save validation: missing both
  await context.saveSchoolEdits({ preventDefault() {} });
  assert.equal(requests.length, 0);
  assert.match(getEl("editor-feedback").textContent, /outcome and a short description/i);

  // Missing summary
  getEl("log-outcome").value = "Left voicemail";
  await context.saveSchoolEdits({ preventDefault() {} });
  assert.equal(requests.length, 0);
  assert.match(getEl("editor-feedback").textContent, /outcome and a short description/i);

  // Provide summary and save succeeds
  getEl("log-summary").value = "Left voicemail with school secretary.";
  await context.saveSchoolEdits({ preventDefault() {} });
  assert.equal(requests.length, 1);
  assert.equal(requests[0].outcome, "Left voicemail");
  assert.equal(requests[0].summary, "Left voicemail with school secretary.");
});

test("contact-editing round trip: add contact before entering text keeps return button, handles unsaved edits, and saves contact without stale outreach draft", async (t) => {
  let record = { recordId: "00000000-0000-4000-8000-000000000030", schoolName: "Bayview Secondary", schoolBoard: "YRDSB", geographicRegion: "Richmond Hill", stage: "Not Contacted", contactName: "", contactRole: "", lastRequestId: "v1" };
  const updateRequests = [], activityRequests = [];
  const { context, getEl, signIn, cleanup } = setupEnv({ fetchHandler: async (url, init = {}) => {
    if (url.includes("/api/config")) return Response.json({ ready: true, writesEnabled: true, googleClientId: "test-client-id" });
    if (url.includes("/api/bootstrap")) return Response.json({ currentUser: { name: "Alex", email: "alex@example.test", role: "co-op" }, schools: [record], sessionExpiresAt: Math.floor(Date.now()/1000)+3600 });
    if (url.includes("/api/schools/detail")) return Response.json({ record });
    if (url.includes("/api/schools/update")) {
      const body = JSON.parse(init.body);
      updateRequests.push(body);
      record = { ...record, ...body.patch, lastRequestId: "v2" };
      return Response.json({ ok: true, code: "SUCCESS", requestId: "v2", record });
    }
    if (url.includes("/api/activities")) {
      const body = JSON.parse(init.body);
      activityRequests.push(body);
      record = { ...record, stage: body.stage || record.stage, lastRequestId: "v3" };
      return Response.json({ ok: true, code: "SUCCESS", requestId: "v3", record });
    }
    return new Response("Not found", { status: 404 });
  } }); t.after(cleanup);
  await signIn("alex@example.test");

  // 1. Open outreach with missing contact, enter draft details
  await context.openSchoolEditor(record.recordId, false, "activity");
  assert.equal(getEl("log-contact-name").textContent, "Contact not recorded");
  assert.equal(getEl("log-contact-edit").textContent, "Add contact");

  getEl("log-channel").value = "Phone";
  getEl("log-activityType").value = "FollowUp";
  context.applySuggestion("log-outcome", "Spoke with someone");
  getEl("log-summary").value = "Spoke with main office about hip hop education.";
  getEl("edit-stage").value = "Contacted";
  context.applySuggestion("edit-nextAction", "Follow up if no reply");
  getEl("edit-followUpDue").value = "2026-10-30";

  // 2. Click "Add contact" -> switches to details mode
  getEl("log-contact-edit").click();
  for (let i = 0; i < 10 && getEl("editor-save").disabled; i++) await new Promise((done) => setTimeout(done, 1));
  assert.equal(getEl("editor-kind").textContent, "SCHOOL DETAILS");
  // Regression 1: Return button is visible even if entered before typing or after typing
  assert.equal(getEl("return-to-activity-container").hidden, false);
  assert.equal(getEl("editor-save").textContent, "Save contact & return");

  // 3. Regression 2: Unsaved contact edits are not silently discarded on return click
  getEl("edit-contactName").value = "Dr. Alvarez";
  getEl("return-to-activity").click();
  // It warns and requires confirmation instead of silently leaving
  assert.equal(getEl("editor-kind").textContent, "SCHOOL DETAILS");
  assert.equal(getEl("return-to-activity").getAttribute("data-confirming"), "true");
  assert.match(getEl("editor-feedback").textContent, /unsaved contact edits/i);

  // 4. Save contact and return
  getEl("edit-contactRole").value = "Principal";
  getEl("save-contact-return").click();
  for (let i = 0; i < 50 && (getEl("editor-kind").textContent !== "LOG OUTREACH" || getEl("editor-save").disabled); i++) {
    await new Promise((done) => setTimeout(done, 5));
  }
  assert.equal(updateRequests.length, 1);
  assert.equal(updateRequests[0].patch.contactName, "Dr. Alvarez");
  assert.equal(updateRequests[0].patch.contactRole, "Principal");

  // 5. Returned automatically to Log Outreach with contact displayed and complete draft intact
  assert.equal(getEl("editor-kind").textContent, "LOG OUTREACH");
  assert.equal(getEl("log-contact-name").textContent, "Dr. Alvarez");
  assert.equal(getEl("log-contact-role").textContent, "· Principal");
  assert.equal(getEl("log-channel").value, "Phone");
  assert.equal(getEl("log-activityType").value, "FollowUp");
  assert.equal(getEl("log-outcome").value, "Spoke with someone");
  assert.equal(getEl("log-summary").value, "Spoke with main office about hip hop education.");
  assert.equal(getEl("edit-stage").value, "Contacted");
  assert.equal(getEl("edit-nextAction").value, "Follow up if no reply");
  assert.equal(getEl("edit-followUpDue").value, "2026-10-30");

  // Regression 3: Outreach draft is NOT marked stale (Save button is enabled, not disabled)
  assert.equal(getEl("editor-save").disabled, false);
  assert.equal(getEl("editor-save").textContent, "Save outreach");

  // 6. Complete outreach log save
  await context.saveSchoolEdits({ preventDefault() {} });
  assert.equal(activityRequests.length, 1);
  assert.equal(activityRequests[0].expectedRequestId, "v2", "uses latest version from contact update");
  assert.equal(activityRequests[0].channel, "Phone");
  assert.equal(activityRequests[0].activityType, "FollowUp");
  assert.equal(activityRequests[0].outcome, "Spoke with someone");
  assert.equal(activityRequests[0].summary, "Spoke with main office about hip hop education.");
  assert.equal(activityRequests[0].nextAction, "Follow up if no reply");
  assert.equal(activityRequests[0].followUpDue, "2026-10-30");
  assert.equal(activityRequests[0].stage, "Contacted");
  assert.equal(getEl("save-toast").textContent, "✓ Outreach saved");
});

test("contact-editing round trip: add contact on empty outreach form retains return button, and returning preserves full draft across contact editor cancel", async (t) => {
  let record = { recordId: "00000000-0000-4000-8000-000000000031", schoolName: "Earl Haig SS", schoolBoard: "TDSB", geographicRegion: "North York", stage: "Not Contacted", contactName: "", contactRole: "", lastRequestId: "v10" };
  const { context, getEl, signIn, cleanup } = setupEnv({ fetchHandler: async (url) => {
    if (url.includes("/api/config")) return Response.json({ ready: true, writesEnabled: true, googleClientId: "test-client-id" });
    if (url.includes("/api/bootstrap")) return Response.json({ currentUser: { name: "Alex", email: "alex@example.test", role: "co-op" }, schools: [record], sessionExpiresAt: Math.floor(Date.now()/1000)+3600 });
    if (url.includes("/api/schools/detail")) return Response.json({ record });
    return new Response("Not found", { status: 404 });
  } }); t.after(cleanup);
  await signIn("alex@example.test");

  // 1. Immediately click Add contact with zero text entered
  await context.openSchoolEditor(record.recordId, false, "activity");
  getEl("log-contact-edit").click();
  for (let i = 0; i < 10 && getEl("editor-save").disabled; i++) await new Promise((done) => setTimeout(done, 1));
  assert.equal(getEl("editor-kind").textContent, "SCHOOL DETAILS");
  // Return button must be visible
  assert.equal(getEl("return-to-activity-container").hidden, false);

  // Return with no edits returns cleanly to outreach
  getEl("return-to-activity").click();
  for (let i = 0; i < 10 && getEl("editor-save").disabled; i++) await new Promise((done) => setTimeout(done, 1));
  assert.equal(getEl("editor-kind").textContent, "LOG OUTREACH");

  // 2. Draft complete outreach with next action and follow-up date
  getEl("log-channel").value = "Phone";
  getEl("log-activityType").value = "Outreach";
  getEl("log-outcome").value = "Left voicemail";
  getEl("log-summary").value = "Called guidance department.";
  getEl("edit-nextAction").value = "Check email next week";
  getEl("edit-followUpDue").value = "2026-11-05";
  getEl("edit-stage").value = "Contacted";

  // Switch to contact editor again
  getEl("log-contact-edit").click();
  for (let i = 0; i < 10 && getEl("editor-save").disabled; i++) await new Promise((done) => setTimeout(done, 1));
  assert.equal(getEl("editor-kind").textContent, "SCHOOL DETAILS");

  // Make an unsaved edit, click return -> warns and does not discard
  getEl("edit-email").value = "guidance@school.test";
  getEl("return-to-activity").click();
  assert.equal(getEl("editor-kind").textContent, "SCHOOL DETAILS");
  assert.equal(getEl("return-to-activity").getAttribute("data-confirming"), "true");

  // Confirm discard to return
  getEl("return-to-activity").click();
  for (let i = 0; i < 10 && getEl("editor-save").disabled; i++) await new Promise((done) => setTimeout(done, 1));
  assert.equal(getEl("editor-kind").textContent, "LOG OUTREACH");

  // Entire outreach draft is completely intact
  assert.equal(getEl("log-channel").value, "Phone");
  assert.equal(getEl("log-activityType").value, "Outreach");
  assert.equal(getEl("log-outcome").value, "Left voicemail");
  assert.equal(getEl("log-summary").value, "Called guidance department.");
  assert.equal(getEl("edit-nextAction").value, "Check email next week");
  assert.equal(getEl("edit-followUpDue").value, "2026-11-05");
  assert.equal(getEl("edit-stage").value, "Contacted");
});

test("editor shows Saving immediately, keeps failed drafts open, then closes with Saved only after confirmation", async (t) => {
  let resolveSave;
  const requests = [];
  let record = { recordId: "00000000-0000-4000-8000-000000000001", schoolName: "Example School", schoolBoard: "EXAMPLE", geographicRegion: "Example Region", assignedTo: "Alex", stage: "Not Contacted", lastRequestId: "00000000-0000-4000-8000-000000000002", notes: "Original", priority: "Medium", followUpCount: 0 };
  const fetchHandler = async (url, init = {}) => {
    if (String(url).includes("/api/config")) return Response.json({ ready: true, writesEnabled: true, googleClientId: "test-client-id" });
    if (String(url).includes("/api/bootstrap")) return Response.json({ currentUser: { name: "Alex", email: "alex@example.test", role: "co-op" }, sessionExpiresAt: Math.floor(Date.now()/1000)+3600, schools: [record] });
    if (String(url).includes("/api/schools/detail")) return Response.json({ ok: true, record });
    if (String(url).includes("/api/schools/update")) {
      requests.push(JSON.parse(init.body));
      return new Promise((resolve) => { resolveSave = resolve; });
    }
    return new Response("Not found", { status: 404 });
  };
  const { context, getEl, signIn, cleanup } = setupEnv({ fetchHandler }); t.after(cleanup);
  await signIn("alex@example.test"); await context.openSchoolEditor(record.recordId);
  getEl("edit-notes").value = "Changed note";
  const attempt = context.saveSchoolEdits({ preventDefault() {} });
  assert.equal(getEl("editor-save").textContent, "Saving…");
  assert.equal(getEl("editor-save").disabled, true);
  assert.equal(getEl("school-editor").open, true);
  resolveSave(Response.json({ code: "COMMIT_UNCERTAIN" }, { status: 503 })); await attempt;
  assert.equal(getEl("school-editor").open, true);
  assert.equal(getEl("editor-save").textContent, "Retry save");
  assert.match(getEl("editor-feedback").textContent, /uncertain/);
  assert.equal(getEl("save-toast").hidden, true);
  const retry = context.saveSchoolEdits({ preventDefault() {} });
  assert.equal(requests[0].requestId, requests[1].requestId);
  record = { ...record, notes: "Changed note", lastRequestId: requests[1].requestId };
  resolveSave(Response.json({ ok: true, record })); await retry;
  assert.equal(getEl("school-editor").open, false);
  assert.equal(getEl("save-toast").hidden, false);
  assert.equal(getEl("save-toast").textContent, "✓ Saved");
});

test("editor shows validation beside Save, and unchanged values close with a clear tag", async (t) => {
  const record = { recordId: "00000000-0000-4000-8000-000000000001", schoolName: "Example School", schoolBoard: "EXAMPLE", geographicRegion: "Example Region", stage: "Not Contacted", lastRequestId: "00000000-0000-4000-8000-000000000002", notes: "" };
  let writes = 0;
  const fetchHandler = async (url) => {
    if (String(url).includes("/api/config")) return Response.json({ ready: true, writesEnabled: true, googleClientId: "test-client-id" });
    if (String(url).includes("/api/bootstrap")) return Response.json({ currentUser: { name: "Alex", email: "alex@example.test", role: "co-op" }, sessionExpiresAt: Math.floor(Date.now()/1000)+3600, schools: [record] });
    if (String(url).includes("/api/schools/detail")) return Response.json({ ok: true, record });
    writes++; return new Response("Unexpected write", { status: 500 });
  };
  const { context, getEl, signIn, cleanup } = setupEnv({ fetchHandler }); t.after(cleanup);
  await signIn("alex@example.test"); await context.openSchoolEditor(record.recordId);
  getEl("edit-email").validity = { valid: false };
  getEl("edit-email").validationMessage = "Please enter a valid email address.";
  await context.saveSchoolEdits({ preventDefault() {} });
  assert.match(getEl("editor-feedback").textContent, /valid email/);
  assert.equal(getEl("school-editor").open, true); assert.equal(writes, 0);
  getEl("edit-email").validity = { valid: true };
  await context.saveSchoolEdits({ preventDefault() {} });
  assert.equal(getEl("school-editor").open, false);
  assert.equal(getEl("save-toast").textContent, "No changes to save"); assert.equal(writes, 0);
});

test("editor reopening loads fresh values and preserves a stale draft without overwriting newer edits", async (t) => {
  let record = { recordId: "00000000-0000-4000-8000-000000000001", schoolName: "Example School", schoolBoard: "EXAMPLE", geographicRegion: "Example Region", assignedTo: "Alex", stage: "Not Contacted", lastRequestId: "00000000-0000-4000-8000-000000000002", notes: "Original", priority: "Medium", followUpCount: 0 };
  const fetchHandler = async (url) => {
    if (String(url).includes("/api/config")) return Response.json({ ready: true, writesEnabled: true, googleClientId: "test-client-id" });
    if (String(url).includes("/api/bootstrap")) return Response.json({ currentUser: { name: "Alex", email: "alex@example.test", role: "co-op" }, sessionExpiresAt: Math.floor(Date.now()/1000)+3600, schools: [record] });
    if (String(url).includes("/api/schools/detail")) return Response.json({ ok: true, record });
    return new Response("Not found", { status: 404 });
  };
  const { context, getEl, signIn, cleanup } = setupEnv({ fetchHandler });
  t.after(cleanup);
  await signIn("alex@example.test");
  getEl("school-list").children[0].children[0].click();
  await new Promise((r) => setTimeout(r, 20));
  assert.equal(getEl("school-editor").open, true);
  assert.equal(getEl("edit-notes").value, "Original");
  getEl("editor-close").click();
  record = { ...record, notes: "New server note", lastRequestId: "00000000-0000-4000-8000-000000000003" };
  await context.openSchoolEditor(record.recordId);
  assert.equal(getEl("edit-notes").value, "New server note");
  getEl("edit-notes").value = "Unsaved draft";
  getEl("editor-close").click();
  record = { ...record, notes: "Another server edit", lastRequestId: "00000000-0000-4000-8000-000000000004" };
  await context.openSchoolEditor(record.recordId);
  assert.equal(getEl("edit-notes").value, "Unsaved draft");
  assert.equal(getEl("editor-save").disabled, true);
  assert.match(getEl("editor-status").textContent, /saved information changed/);
  await context.openSchoolEditor(record.recordId, true);
  assert.equal(getEl("edit-notes").value, "Another server edit");
  assert.equal(getEl("editor-save").disabled, false);
});

test("a definitely rejected directory claim starts a fresh request on retry", async (t) => {
  const requestIds = [];
  const school = { osn: "900002", schoolName: "Example School 2", schoolBoard: "EXAMPLE", city: "Example City", geographicRegion: "Example Region", available: true };
  const fetchHandler = async (url, init = {}) => {
    if (String(url).includes("/api/config")) return Response.json({ ready: true, writesEnabled: true, googleClientId: "test-client-id" });
    if (String(url).includes("/api/bootstrap")) return Response.json({ currentUser: { name: "Example Supervisor", email: "supervisor@example.test", role: "Supervisor" }, sessionExpiresAt: Math.floor(Date.now()/1000)+3600, schools: [] });
    if (String(url).includes("/api/directory")) return Response.json({ directory: [school] });
    if (String(url).includes("/api/schools/claim")) {
      requestIds.push(JSON.parse(init.body).requestId);
      return requestIds.length === 1
        ? Response.json({ code: "TEST_SHEET_EDIT_ACCESS_REQUIRED", message: "Editor access is needed. Nothing was saved." }, { status: 502 })
        : Response.json({ ok: true, message: "School claimed successfully", record: { schoolName: school.schoolName } });
    }
    return new Response("Not found", { status: 404 });
  };
  const { getEl, signIn, cleanup } = setupEnv({ fetchHandler });
  t.after(cleanup);
  await signIn("supervisor@example.test");
  getEl("tab-directory").click();
  await new Promise((r) => setTimeout(r, 20));
  const button = getEl("dir-list").children[0].children.at(-1);
  button.click();
  await new Promise((r) => setTimeout(r, 20));
  assert.equal(button.disabled, false);
  assert.match(getEl("dir-feedback").textContent, /Nothing was saved/);
  button.click();
  await new Promise((r) => setTimeout(r, 20));
  assert.equal(requestIds.length, 2);
  assert.notEqual(requestIds[0], requestIds[1]);
  assert.equal(getEl("dir-feedback").textContent, "School claimed successfully");
});

function setupEnv({ fetchHandler, apiOrigin = "", online = true, missingIds = [], storage = new Map(), onPrompt, timerDelay = (ms) => ms }) {
  let googleOptions;
  const windowListeners = new Map();
  const activeTimers = new Set();
  const activeIntervals = new Set();
  const elements = new Map();

  const createdElements = new Set();

  function cleanup() {
    for (const t of activeTimers) {
      globalThis.clearTimeout(t);
    }
    activeTimers.clear();
    for (const i of activeIntervals) {
      globalThis.clearInterval(i);
    }
    activeIntervals.clear();
    createdElements.clear();
  }

  function getEl(id) {
    if (!elements.has(id)) {
      elements.set(id, makeElement(id));
    }
    return elements.get(id);
  }
  function makeElement(id = "", tag = "div") {
    const classes = new Set();
    const children = [];
    const attrs = {};
    const listeners = {};
    return {
      id,
      tagName: tag.toUpperCase(),
      parentElement: null,
      style: {},
      classes,
      get className() { return Array.from(classes).join(" "); },
      set className(val) {
        classes.clear();
        (val || "").split(/\s+/).filter(Boolean).forEach((c) => classes.add(c));
      },
      classList: {
        add: (...cs) => cs.forEach((c) => classes.add(c)),
        remove: (...cs) => cs.forEach((c) => classes.delete(c)),
        contains: (c) => classes.has(c),
        toggle: (c, force) => {
          if (force !== undefined) {
            force ? classes.add(c) : classes.delete(c);
            return force;
          }
          const has = classes.has(c);
          has ? classes.delete(c) : classes.add(c);
          return !has;
        },
      },
      textContent: "",
      value: "",
      checked: false,
      hidden: false,
      disabled: false,
      open: false,
      showModal() { this.open = true; },
      close() { this.open = false; },
      focus() { this.focused = true; },
      children,
      replaceChildren: function (...args) {
        children.length = 0;
        this.append(...args);
      },
      append: function (...args) {
        for (const child of args) {
          if (child && typeof child === "object") child.parentElement = this;
        }
        children.push(...args);
      },
      setAttribute: (k, v) => { attrs[k] = String(v); },
      getAttribute: (k) => attrs[k],
      removeAttribute: (k) => { delete attrs[k]; },
      closest: function (sel) {
        if (sel.startsWith(".")) return this.classList.contains(sel.slice(1)) ? this : this.parentElement?.closest(sel) ?? null;
        if (sel.startsWith("#")) return this.id === sel.slice(1) ? this : this.parentElement?.closest(sel) ?? null;
        return null;
      },
      dispatchEvent: function (ev) {
        const type = typeof ev === "string" ? ev : ev?.type;
        (listeners[type] || []).forEach((fn) => fn(ev));
        if (ev?.bubbles && this.parentElement) {
          this.parentElement.dispatchEvent(ev);
        }
      },
      addEventListener: (ev, fn) => { (listeners[ev] ??= []).push(fn); },
      click: function () {
        if (this.disabled) return;
        if (this.id.includes("confirm") || this.id.includes("check") || this.id.includes("overwrite") || attrs.type === "checkbox") {
          this.checked = !this.checked;
          this.dispatchEvent({ target: this, type: "change", bubbles: true });
        }
        if (this.onclick) this.onclick();
        const ev = { target: this, type: "click", bubbles: true, preventDefault() {}, stopPropagation() {} };
        this.dispatchEvent(ev);
      },
    };
  }

  const document = {
    querySelector: () => ({ content: apiOrigin }),
    querySelectorAll: (sel) => {
      const parts = sel.split(",").map((s) => s.trim());
      const all = [...elements.values(), ...createdElements];
      return all.filter((el) => {
        return parts.some((p) => {
          if (p.startsWith(".")) return el.classList.contains(p.slice(1));
          if (p.startsWith("#")) return el.id === p.slice(1);
          return false;
        });
      });
    },
    getElementById: (id) => missingIds.includes(id) ? null : getEl(id),
    createElement: (tag) => {
      const el = makeElement("", tag);
      createdElements.add(el);
      return el;
    },
    head: makeElement("head", "head"),
    addEventListener: () => {},
    visibilityState: "visible",
  };
  const window = {
    addEventListener: (event, callback) => {
      const handlers = windowListeners.get(event) ?? []; handlers.push(callback); windowListeners.set(event, handlers);
    },
    google: {
      accounts: {
        id: {
          initialize: (opts) => { googleOptions = opts; },
          renderButton: () => {},
          disableAutoSelect: () => {},
          prompt: (notification) => onPrompt?.(googleOptions, notification),
          cancel: () => {},
        },
      },
    },
  };

  const context = {
    document,
    window,
    navigator: { onLine: online },
    sessionStorage: {
      getItem: (key) => storage.get(key) ?? null,
      setItem: (key, value) => storage.set(key, String(value)),
      removeItem: (key) => storage.delete(key),
    },
    crypto: webcrypto,
    el: (id) => getEl(id),
    fetch: fetchHandler,
    setTimeout: (fn, ms) => {
      let t;
      t = globalThis.setTimeout(() => {
        activeTimers.delete(t);
        fn();
      }, timerDelay(ms));
      t.unref?.();
      activeTimers.add(t);
      return t;
    },
    clearTimeout: (t) => {
      activeTimers.delete(t);
      globalThis.clearTimeout(t);
    },
    setInterval: (fn, ms) => {
      const i = globalThis.setInterval(fn, ms);
      i.unref?.();
      activeIntervals.add(i);
      return i;
    },
    clearInterval: (i) => {
      activeIntervals.delete(i);
      globalThis.clearInterval(i);
    },
    Headers: globalThis.Headers,
    Response: globalThis.Response,
    Request: globalThis.Request,
    AbortController: globalThis.AbortController,
    Event: globalThis.Event,
    atob: (str) => Buffer.from(str, "base64").toString("binary"),
    console,
  };

  vm.createContext(context);
  getEl("workspace").hidden = true;
  getEl("session-restore").hidden = true;
  getEl("editor-form").append(getEl("step-summary"));
  getEl("step-summary").append(getEl("summary-suggestion-chips"));
  vm.runInContext(appCode, context);

  async function signIn(email = "supervisor@example.test") {
    const deadline = Date.now() + 2000;
    while (!googleOptions) {
      if (Date.now() > deadline) {
        cleanup();
        throw new Error("Timed out after 2000ms waiting for Google Sign-In initialization (googleOptions)");
      }
      await new Promise((r) => setTimeout(r, 10));
    }
    const header = Buffer.from(JSON.stringify({ alg: "RS256" })).toString("base64url");
    const payload = Buffer.from(JSON.stringify({
      email, email_verified: true, nonce: googleOptions.nonce,
      exp: Math.floor(Date.now() / 1000) + 3600,
    })).toString("base64url");
    await googleOptions.callback({ credential: `${header}.${payload}.sig` });
    await new Promise((r) => setTimeout(r, 20));
  }

  return { context, getEl, signIn, cleanup, googleOptions: () => googleOptions,
    dispatchWindow: (event) => Promise.all((windowListeners.get(event) ?? []).map((callback) => callback({}))),
  };
}

test("GitHub Pages sends config, sign-in and authenticated API requests to the configured Worker", async (t) => {
  const requests = [];
  const { context, signIn, cleanup } = setupEnv({ apiOrigin: "https://example-api.workers.dev", fetchHandler: async (url, init = {}) => {
    requests.push({ url, init });
    if (url.endsWith("/api/config")) return Response.json({ ready: true, googleClientId: "test-client-id" });
    if (url.endsWith("/api/bootstrap")) return Response.json({ currentUser: { name: "Alex", email: "alex@example.test", role: "co-op" }, schools: [], sessionExpiresAt: Math.floor(Date.now()/1000)+3600 });
    return Response.json({ ok: true });
  } });
  t.after(cleanup);
  await signIn("alex@example.test");
  await context.apiFetch("./api/schools/update", { method: "POST", headers: { Authorization: "Bearer example" } });
  assert.deepEqual(requests.map((r) => r.url), [
    "https://example-api.workers.dev/api/config", "https://example-api.workers.dev/api/bootstrap", "https://example-api.workers.dev/api/schools/update",
  ]);
  assert.equal(requests[2].init.headers.Authorization, "Bearer example");
});

test("frontend regression: automatic refresh during a pending claim does not discard claim response or stick button", async (t) => {
  let resolveClaim;
  const claimPromise = new Promise((resolve) => { resolveClaim = resolve; });

  const fetchHandler = async (url) => {
    const path = String(url);
    if (path.includes("/api/config")) {
      return new Response(JSON.stringify({ ok: true, ready: true, googleClientId: "test-client-id" }), { status: 200 });
    }
    if (path.includes("/api/bootstrap")) {
      return new Response(JSON.stringify({
        ok: true,
        currentUser: { name: "Glen", email: "supervisor@example.test", role: "Supervisor" },
        sessionExpiresAt: Math.floor(Date.now() / 1000) + 3600,
        schools: [{ recordId: "rec-1", schoolName: "Initial School", stage: "Not Contacted" }],
      }), { status: 200 });
    }
    if (path.includes("/api/demo/schools")) {
      return new Response(JSON.stringify({
        ok: true, demo: true,
        schools: [
          { osn: "900001", schoolName: "School 1", available: false },
          { osn: "900002", schoolName: "School 2", available: true },
        ],
      }), { status: 200 });
    }
    if (path.includes("/api/demo/claim")) {
      return claimPromise;
    }
    return new Response("Not found", { status: 404 });
  };

  const { getEl, signIn, cleanup } = setupEnv({ fetchHandler });
  t.after(cleanup);

  // 1. Authenticate user
  await signIn("supervisor@example.test");
  assert.equal(getEl("user-name").textContent, "Glen");

  // 2. Switch to demo tab and load demo schools
  getEl("tab-demo-claim").click();
  await new Promise((r) => setTimeout(r, 10));
  assert.equal(getEl("demo-list").children.length, 2);

  // 3. Initiate claim on School 2 (osn 900002)
  const school2Card = getEl("demo-list").children[1];
  const claimBtn = school2Card.children[3]; // [badge, heading, meta, claimBtn]
  assert.equal(claimBtn.textContent, "Claim (Demo)");
  assert.equal(claimBtn.disabled, false);

  claimBtn.click();
  assert.equal(claimBtn.disabled, true);
  assert.equal(getEl("demo-feedback").textContent, "Saving demo claim through SQLite coordinator…");

  // 4. Background automatic refresh() triggers while claim is in flight (e.g. 60s timer or refresh button)
  getEl("refresh").click();
  await new Promise((r) => setTimeout(r, 10));
  assert.equal(getEl("workspace-status").textContent, "Up to date · viewing only");

  // 5. Claim response now resolves
  resolveClaim(new Response(JSON.stringify({
    ok: true, code: "SUCCESS", demo: true,
    message: "Demo claim saved — test data only",
    record: { osn: "900002", schoolName: "School 2", ownerEmail: "morgan@example.test" },
  }), { status: 200 }));

  await new Promise((r) => setTimeout(r, 20));

  // 6. Assert claim was NOT discarded: feedback is updated, button is marked Already Claimed
  assert.equal(getEl("demo-feedback").textContent, "Demo claim saved — test data only");
  const updatedCard = getEl("demo-list").children[1];
  const updatedBtn = updatedCard.children[3];
  assert.equal(updatedBtn.textContent, "Already Claimed");
  assert.equal(updatedBtn.disabled, true);
});

test("frontend regression: sign-out while a response body is delayed discards late data without rendering to DOM", async (t) => {
  let resolveJson;
  const jsonPromise = new Promise((resolve) => { resolveJson = resolve; });

  const fetchHandler = async (url) => {
    const path = String(url);
    if (path.includes("/api/config")) {
      return new Response(JSON.stringify({ ok: true, ready: true, googleClientId: "test-client-id" }), { status: 200 });
    }
    if (path.includes("/api/bootstrap")) {
      return new Response(JSON.stringify({
        ok: true,
        currentUser: { name: "Glen", email: "supervisor@example.test", role: "Supervisor" },
        sessionExpiresAt: Math.floor(Date.now() / 1000) + 3600,
        schools: [{ recordId: "rec-1", schoolName: "Initial School", stage: "Not Contacted" }],
      }), { status: 200 });
    }
    if (path.includes("/api/directory")) {
      return {
        ok: true,
        status: 200,
        headers: new Headers({ "content-type": "application/json" }),
        json: () => jsonPromise,
      };
    }
    return new Response("Not found", { status: 404 });
  };

  const { getEl, signIn, cleanup } = setupEnv({ fetchHandler });
  t.after(cleanup);

  // 1. Sign in successfully
  await signIn("supervisor@example.test");
  assert.equal(getEl("user-name").textContent, "Glen");

  // 2. Switch to directory tab; directory fetch starts with delayed json body
  getEl("tab-directory").click();
  await new Promise((r) => setTimeout(r, 10));
  assert.equal(getEl("dir-status").textContent, "Loading school directory…");

  // 3. User signs out while response.json() is delayed
  getEl("sign-out").click();
  assert.equal(getEl("workspace").hidden, true);
  assert.equal(getEl("login-status").textContent, "You’re signed out.");
  assert.equal(getEl("user-name").textContent, "");

  // 4. Delayed directory json body finally resolves
  resolveJson({
    ok: true,
    directory: [
      { osn: "888888", schoolName: "Sensitive Directory School", schoolBoard: "TEST", available: true },
    ],
  });

  await new Promise((r) => setTimeout(r, 20));

  // 5. Assert workspace remains hidden and directory school was NOT rendered to DOM
  assert.equal(getEl("workspace").hidden, true);
  assert.equal(getEl("dir-list").children.length, 0);
  assert.equal(getEl("school-list").children.length, 0);
});

test("frontend regression: returning to Demo tab reloads synthetic availability, and shows error if coordinator fails", async (t) => {
  let coordinatorFailed = false;
  let currentClaims = ["900001"];

  const fetchHandler = async (url) => {
    const path = String(url);
    if (path.includes("/api/config")) {
      return new Response(JSON.stringify({ ok: true, ready: true, googleClientId: "test-client-id" }), { status: 200 });
    }
    if (path.includes("/api/bootstrap")) {
      return new Response(JSON.stringify({
        ok: true,
        currentUser: { name: "Glen", email: "supervisor@example.test", role: "Supervisor" },
        sessionExpiresAt: Math.floor(Date.now() / 1000) + 3600,
        schools: [],
      }), { status: 200 });
    }
    if (path.includes("/api/demo/schools")) {
      if (coordinatorFailed) {
        return new Response(JSON.stringify({
          ok: false, code: "COORDINATOR_UNAVAILABLE", message: "Availability unavailable",
        }), { status: 503 });
      }
      return new Response(JSON.stringify({
        ok: true, demo: true,
        schools: [
          { osn: "900001", schoolName: "School 1", schoolBoard: "EXAMPLE", city: "Example City", available: !currentClaims.includes("900001") },
          { osn: "900002", schoolName: "School 2", schoolBoard: "EXAMPLE", city: "Example City", available: !currentClaims.includes("900002") },
        ],
      }), { status: 200 });
    }
    return new Response("Not found", { status: 404 });
  };

  const { getEl, signIn, cleanup } = setupEnv({ fetchHandler });
  t.after(cleanup);

  await signIn("supervisor@example.test");

  // 1. Enter Demo tab: School 2 is available
  getEl("tab-demo-claim").click();
  await new Promise((r) => setTimeout(r, 10));
  assert.equal(getEl("demo-list").children.length, 2);
  let card2 = getEl("demo-list").children[1];
  assert.equal(card2.children[0].textContent, "Available (Demo)");
  assert.equal(card2.children[3].textContent, "Claim (Demo)");

  // 2. Switch away to My Schools
  getEl("tab-my-schools").click();
  assert.equal(getEl("schools-view").hidden, false);
  assert.equal(getEl("demo-view").hidden, true);

  // 3. Another session claims 900002
  currentClaims.push("900002");

  // 4. Return to Demo tab: it MUST reload availability
  getEl("tab-demo-claim").click();
  await new Promise((r) => setTimeout(r, 10));
  card2 = getEl("demo-list").children[1];
  assert.equal(card2.children[0].textContent, "Claimed (Demo)");
  assert.equal(card2.children[3].textContent, "Already Claimed");
  assert.equal(card2.children[3].disabled, true);

  // 5. When coordinator lookup fails, shows "Availability unavailable" rather than silent fallback
  coordinatorFailed = true;
  getEl("tab-demo-claim").click();
  await new Promise((r) => setTimeout(r, 10));
  assert.equal(getEl("demo-feedback").textContent, "Availability unavailable");
  assert.equal(getEl("demo-list").children.length, 0);
});

test("Scenario A: Grade 9 first email outreach: selects 'No reply yet', sets follow-up date, and saves in under 60s flow", async (t) => {
  const record = { recordId: "00000000-0000-4000-8000-000000000091", schoolName: "Highland Heights SS", schoolBoard: "TDSB", geographicRegion: "Scarborough", stage: "Not Contacted", contactName: "Mr. Lee", contactRole: "Arts Head", lastRequestId: "v1" };
  const requests = [];
  const { context, getEl, signIn, cleanup } = setupEnv({ fetchHandler: async (url, init = {}) => {
    if (url.includes("/api/config")) return Response.json({ ready: true, writesEnabled: true, googleClientId: "test-client-id" });
    if (url.includes("/api/bootstrap")) return Response.json({ currentUser: { name: "Alex", email: "alex@example.test", role: "co-op" }, schools: [record], sessionExpiresAt: Math.floor(Date.now() / 1000) + 3600 });
    if (url.includes("/api/schools/detail")) return Response.json({ record });
    if (url.includes("/api/activities")) { requests.push(JSON.parse(init.body)); return Response.json({ ok: true, record: { ...record, stage: "Contacted", lastRequestId: "v2" } }); }
    return new Response("Not found", { status: 404 });
  } });
  t.after(cleanup);
  await signIn("alex@example.test");
  await context.openSchoolEditor(record.recordId, false, "activity");

  // Step 1: Contact displayed
  assert.equal(getEl("log-contact-name").textContent, "Mr. Lee");
  assert.equal(getEl("log-contact-role").textContent, "· Arts Head");

  // Step 2: First contact defaults
  assert.equal(getEl("log-channel").value, "Email");
  assert.equal(getEl("log-activityType").value, "Outreach");

  // Step 3: Grade 9 student selects "No reply yet"
  context.applySuggestion("log-outcome", "No reply yet");
  assert.equal(getEl("log-outcome").value, "No reply yet");

  // Step 4: Short summary
  getEl("log-summary").value = "Sent an email introducing H4's free dance workshops and asked about their dance program.";

  // Step 5: Unified Step 5 card - Next Action & Follow-up date
  assert.equal(getEl("activity-step-5").classList.contains("flow-step"), true);
  assert.equal(getEl("activity-step-5-header").hidden, false);
  context.applySuggestion("edit-nextAction", "Follow up if no reply");
  assert.equal(getEl("edit-nextAction").value, "Follow up if no reply");
  getEl("edit-followUpDue").value = "2026-10-24";
  assert.equal(getEl("edit-stage").value, "Contacted");
  assert.equal(getEl("cold-warning").hidden, true);

  // Save
  await context.saveSchoolEdits({ preventDefault() {} });
  assert.equal(requests.length, 1);
  assert.equal(requests[0].channel, "Email");
  assert.equal(requests[0].activityType, "Outreach");
  assert.equal(requests[0].outcome, "No reply yet");
  assert.equal(requests[0].summary, "Sent an email introducing H4's free dance workshops and asked about their dance program.");
  assert.equal(requests[0].nextAction, "Follow up if no reply");
  assert.equal(requests[0].followUpDue, "2026-10-24");
  assert.equal(requests[0].stage, "Contacted");
  assert.equal(getEl("save-toast").textContent, "✓ Outreach saved");
  assert.equal(getEl("school-editor").open, false);
});

test("Scenario B: School responds: records outcome, custom text, summarizes discussion, selects stage, and schedules next step", async (t) => {
  const record = { recordId: "00000000-0000-4000-8000-000000000092", schoolName: "Westdale Secondary", schoolBoard: "HWDSB", geographicRegion: "Hamilton", stage: "Contacted", contactName: "Ms. Chen", contactRole: "Principal", lastRequestId: "v1" };
  const requests = [];
  const { context, getEl, signIn, cleanup } = setupEnv({ fetchHandler: async (url, init = {}) => {
    if (url.includes("/api/config")) return Response.json({ ready: true, writesEnabled: true, googleClientId: "test-client-id" });
    if (url.includes("/api/bootstrap")) return Response.json({ currentUser: { name: "Alex", email: "alex@example.test", role: "co-op" }, schools: [record], sessionExpiresAt: Math.floor(Date.now() / 1000) + 3600 });
    if (url.includes("/api/schools/detail")) return Response.json({ record });
    if (url.includes("/api/activities")) { requests.push(JSON.parse(init.body)); return Response.json({ ok: true, record: { ...record, stage: "Interested", lastRequestId: "v2" } }); }
    return new Response("Not found", { status: 404 });
  } });
  t.after(cleanup);
  await signIn("alex@example.test");
  await context.openSchoolEditor(record.recordId, false, "activity");

  // Step 2: Channel Phone, type FollowUp
  getEl("log-channel").value = "Phone";
  getEl("log-activityType").value = "FollowUp";

  // Step 3: Suggestion "Interested", plus verify custom text is preserved if typed
  context.applySuggestion("log-outcome", "Interested");
  assert.equal(getEl("log-outcome").value, "Interested");
  getEl("log-outcome").value = "Interested in 2 hip hop workshops for Grade 9s";

  // Step 4: Summary of call
  getEl("log-summary").value = "Spoke with Ms. Chen on phone. She wants to book workshops for November and requested availability.";

  // Step 5: Advance stage to Interested, custom next action, follow-up date
  getEl("edit-stage").value = "Interested";
  getEl("edit-nextAction").value = "Send available November workshop dates";
  getEl("edit-followUpDue").value = "2026-10-28";
  assert.equal(getEl("cold-warning").hidden, true);

  // Save
  await context.saveSchoolEdits({ preventDefault() {} });
  assert.equal(requests.length, 1);
  assert.equal(requests[0].channel, "Phone");
  assert.equal(requests[0].activityType, "FollowUp");
  assert.equal(requests[0].outcome, "Interested in 2 hip hop workshops for Grade 9s");
  assert.equal(requests[0].summary, "Spoke with Ms. Chen on phone. She wants to book workshops for November and requested availability.");
  assert.equal(requests[0].stage, "Interested");
  assert.equal(requests[0].nextAction, "Send available November workshop dates");
  assert.equal(requests[0].followUpDue, "2026-10-28");
  assert.equal(getEl("save-toast").textContent, "✓ Outreach saved");
  assert.equal(getEl("school-editor").open, false);
});

test("quick summary suggestions: provides Grade 9 Email First Contact pills, supports one-tap fill, updates contextually, and does not overwrite existing text", async (t) => {
  const record = { recordId: "00000000-0000-4000-8000-000000000093", schoolName: "Silverthorn CI", schoolBoard: "TDSB", geographicRegion: "Etobicoke", stage: "Not Contacted", contactName: "Mr. Brown", contactRole: "Guidance", lastRequestId: "v1" };
  const requests = [];
  const { context, getEl, signIn, cleanup } = setupEnv({ fetchHandler: async (url, init = {}) => {
    if (url.includes("/api/config")) return Response.json({ ready: true, writesEnabled: true, googleClientId: "test-client-id" });
    if (url.includes("/api/bootstrap")) return Response.json({ currentUser: { name: "Alex", email: "alex@example.test", role: "co-op" }, schools: [record], sessionExpiresAt: Math.floor(Date.now() / 1000) + 3600 });
    if (url.includes("/api/schools/detail")) return Response.json({ record });
    if (url.includes("/api/activities")) { requests.push(JSON.parse(init.body)); return Response.json({ ok: true, record: { ...record, stage: "Contacted", lastRequestId: "v2" } }); }
    return new Response("Not found", { status: 404 });
  } });
  t.after(cleanup);
  await signIn("alex@example.test");
  await context.openSchoolEditor(record.recordId, false, "activity");

  // Step 4: Initially no summary preselected
  assert.equal(getEl("log-summary").value, "");
  const chipsContainer = getEl("summary-suggestion-chips");
  assert.equal(chipsContainer.children.length, 5);

  const expectedEmailOutreach = [
    { label: "Introduced H4", value: "Sent an introductory email explaining H4 and our free dance programs." },
    { label: "Offered free workshop", value: "Sent an email offering a free introductory dance workshop." },
    { label: "Asked about dance program", value: "Emailed to ask if the school has a dance class, team, or club." },
    { label: "Asked for the right contact", value: "Emailed to ask who oversees dance, leadership, or student clubs." },
    { label: "Invited student mentors", value: "Sent an email inviting students to become H4 volunteer dance mentors." },
  ];

  for (let i = 0; i < expectedEmailOutreach.length; i++) {
    const chip = chipsContainer.children[i];
    assert.equal(chip.textContent, expectedEmailOutreach[i].label);
    assert.equal(chip.getAttribute("data-value"), expectedEmailOutreach[i].value);
    assert.equal(chip.getAttribute("data-target"), "log-summary");
    assert.equal(chip.classList.contains("selected"), false);
  }

  // Tapping first pill fills summary and selects chip
  chipsContainer.children[0].click();
  assert.equal(getEl("log-summary").value, "Sent an introductory email explaining H4 and our free dance programs.");
  assert.equal(chipsContainer.children[0].classList.contains("selected"), true);
  assert.equal(chipsContainer.children[0].getAttribute("aria-pressed"), "true");
  assert.equal(chipsContainer.children[1].classList.contains("selected"), false);

  // Tapping another pill updates summary and transfers selection
  chipsContainer.children[1].click();
  assert.equal(getEl("log-summary").value, "Sent an email offering a free introductory dance workshop.");
  assert.equal(chipsContainer.children[0].classList.contains("selected"), false);
  assert.equal(chipsContainer.children[1].classList.contains("selected"), true);

  // Manual typing preserves editing; unselects pill if non-matching
  getEl("log-summary").value = "Sent custom email to department head.";
  getEl("log-summary").dispatchEvent(new Event("input", { bubbles: true }));
  assert.equal(chipsContainer.children[1].classList.contains("selected"), false);

  // Context-aware update: Switch to Email + Follow-up
  getEl("log-activityType").value = "FollowUp";
  getEl("log-activityType").dispatchEvent(new Event("change", { bubbles: true }));

  // Crucial invariant: does NOT overwrite existing text
  assert.equal(getEl("log-summary").value, "Sent custom email to department head.");
  assert.equal(chipsContainer.children.length, 2);
  assert.equal(chipsContainer.children[0].textContent, "Followed up about workshop opportunities");
  assert.equal(chipsContainer.children[0].getAttribute("data-value"), "Followed up about workshop opportunities.");
  assert.equal(chipsContainer.children[1].textContent, "Requested an update");
  assert.equal(chipsContainer.children[1].getAttribute("data-value"), "Requested an update.");

  // Tapping follow-up pill fills summary
  chipsContainer.children[1].click();
  assert.equal(getEl("log-summary").value, "Requested an update.");
  assert.equal(chipsContainer.children[1].classList.contains("selected"), true);

  // Context-aware update: Switch to Phone
  getEl("log-channel").value = "Phone";
  getEl("log-channel").dispatchEvent(new Event("change", { bubbles: true }));
  // Text preserved across channel switch
  assert.equal(getEl("log-summary").value, "Requested an update.");
  assert.equal(chipsContainer.children.length, 3);
  assert.equal(chipsContainer.children[0].textContent, "Called the school");
  assert.equal(chipsContainer.children[0].getAttribute("data-value"), "Called the school.");
  assert.equal(chipsContainer.children[1].textContent, "Left voicemail");
  assert.equal(chipsContainer.children[1].getAttribute("data-value"), "Left voicemail.");
  assert.equal(chipsContainer.children[2].textContent, "Discussed workshop opportunities");
  assert.equal(chipsContainer.children[2].getAttribute("data-value"), "Discussed workshop opportunities.");

  // Context-aware update: Switch to Social
  getEl("log-channel").value = "Social";
  getEl("log-channel").dispatchEvent(new Event("change", { bubbles: true }));
  assert.equal(getEl("log-summary").value, "Requested an update.");
  assert.equal(chipsContainer.children.length, 2);
  assert.equal(chipsContainer.children[0].textContent, "Sent introductory message");
  assert.equal(chipsContainer.children[0].getAttribute("data-value"), "Sent introductory message.");
  assert.equal(chipsContainer.children[1].textContent, "Followed up through social media");
  assert.equal(chipsContainer.children[1].getAttribute("data-value"), "Followed up through social media.");

  // Context-aware update: Switch to Meeting
  getEl("log-channel").value = "Meeting";
  getEl("log-channel").dispatchEvent(new Event("change", { bubbles: true }));
  assert.equal(getEl("log-summary").value, "Requested an update.");
  assert.equal(chipsContainer.children.length, 3);
  assert.equal(chipsContainer.children[0].textContent, "Discussed workshop plans");
  assert.equal(chipsContainer.children[0].getAttribute("data-value"), "Discussed workshop plans.");
  assert.equal(chipsContainer.children[1].textContent, "Discussed scheduling");
  assert.equal(chipsContainer.children[1].getAttribute("data-value"), "Discussed scheduling.");
  assert.equal(chipsContainer.children[2].textContent, "Agreed on next steps");
  assert.equal(chipsContainer.children[2].getAttribute("data-value"), "Agreed on next steps.");

  // Tapping Meeting pill fills summary
  chipsContainer.children[2].click();
  assert.equal(getEl("log-summary").value, "Agreed on next steps.");
  assert.equal(chipsContainer.children[2].classList.contains("selected"), true);
});

test("Scenario: Grade 9 first email outreach using quick summary suggestion pill saves end-to-end", async (t) => {
  const record = { recordId: "00000000-0000-4000-8000-000000000094", schoolName: "Birchmount Park CI", schoolBoard: "TDSB", geographicRegion: "Scarborough", stage: "Not Contacted", contactName: "Ms. Miller", contactRole: "Dance Teacher", lastRequestId: "v1" };
  const requests = [];
  const { context, getEl, signIn, cleanup } = setupEnv({ fetchHandler: async (url, init = {}) => {
    if (url.includes("/api/config")) return Response.json({ ready: true, writesEnabled: true, googleClientId: "test-client-id" });
    if (url.includes("/api/bootstrap")) return Response.json({ currentUser: { name: "Alex", email: "alex@example.test", role: "co-op" }, schools: [record], sessionExpiresAt: Math.floor(Date.now() / 1000) + 3600 });
    if (url.includes("/api/schools/detail")) return Response.json({ record });
    if (url.includes("/api/activities")) { requests.push(JSON.parse(init.body)); return Response.json({ ok: true, record: { ...record, stage: "Contacted", lastRequestId: "v2" } }); }
    return new Response("Not found", { status: 404 });
  } });
  t.after(cleanup);
  await signIn("alex@example.test");
  await context.openSchoolEditor(record.recordId, false, "activity");

  // Step 1: Contact
  assert.equal(getEl("log-contact-name").textContent, "Ms. Miller");

  // Step 2: Defaults Email + Outreach
  assert.equal(getEl("log-channel").value, "Email");
  assert.equal(getEl("log-activityType").value, "Outreach");

  // Step 3: Select Outcome "No reply yet"
  context.applySuggestion("log-outcome", "No reply yet");

  // Step 4: One-tap summary suggestion "Offered free workshop"
  const chipsContainer = getEl("summary-suggestion-chips");
  const workshopChip = chipsContainer.children.find?.((c) => c.textContent === "Offered free workshop")
    ?? Array.from(chipsContainer.children).find((c) => c.textContent === "Offered free workshop");
  assert.ok(workshopChip);
  workshopChip.click();
  assert.equal(getEl("log-summary").value, "Sent an email offering a free introductory dance workshop.");
  assert.equal(workshopChip.classList.contains("selected"), true);

  // Step 5: Next action & Follow-up date
  context.applySuggestion("edit-nextAction", "Follow up if no reply");
  getEl("edit-followUpDue").value = "2026-10-25";

  // Save activity
  await context.saveSchoolEdits({ preventDefault() {} });
  assert.equal(requests.length, 1);
  assert.equal(requests[0].channel, "Email");
  assert.equal(requests[0].activityType, "Outreach");
  assert.equal(requests[0].outcome, "No reply yet");
  assert.equal(requests[0].summary, "Sent an email offering a free introductory dance workshop.");
  assert.equal(requests[0].nextAction, "Follow up if no reply");
  assert.equal(requests[0].followUpDue, "2026-10-25");
  assert.equal(requests[0].stage, "Contacted");
  assert.equal(getEl("save-toast").textContent, "✓ Outreach saved");
  assert.equal(getEl("school-editor").open, false);
});

test("Bulk Log Outreach: 3-step workflow selects up to 20 schools, reuses quick summaries, requires confirmation, and shows correct button text", async (t) => {
  const records = [
    { recordId: "00000000-0000-4000-8000-000000000001", schoolName: "School One", schoolBoard: "TDSB", geographicRegion: "North", stage: "Not Contacted", lastRequestId: "v1", canEdit: true },
    { recordId: "00000000-0000-4000-8000-000000000002", schoolName: "School Two", schoolBoard: "TDSB", geographicRegion: "East", stage: "Not Contacted", lastRequestId: "v2", canEdit: true },
    { recordId: "00000000-0000-4000-8000-000000000003", schoolName: "School Three", schoolBoard: "TDSB", geographicRegion: "West", stage: "Not Contacted", lastRequestId: "v3", canEdit: true },
    { recordId: "00000000-0000-4000-8000-000000000004", schoolName: "School Four (Booked)", schoolBoard: "TDSB", geographicRegion: "South", stage: "Booked", lastRequestId: "v4", canEdit: true },
    { recordId: "00000000-0000-4000-8000-000000000005", schoolName: "School Five (Cold)", schoolBoard: "TDSB", geographicRegion: "Central", stage: "Cold", lastRequestId: "v5", canEdit: true },
  ];
  const activityRequests = [];
  const { context, getEl, signIn, cleanup } = setupEnv({ fetchHandler: async (url, init = {}) => {
    if (url.includes("/api/config")) return Response.json({ ready: true, writesEnabled: true, googleClientId: "test-client-id" });
    if (url.includes("/api/bootstrap")) return Response.json({ currentUser: { name: "Alex", email: "alex@example.test", role: "co-op" }, schools: records, sessionExpiresAt: Math.floor(Date.now() / 1000) + 3600 });
    if (url.includes("/api/schools/detail")) {
      const match = url.match(/recordId=([^&]+)/);
      const rec = records.find((r) => r.recordId === decodeURIComponent(match[1]));
      return Response.json({ ok: true, record: rec });
    }
    if (url.includes("/api/activities")) {
      const body = JSON.parse(init.body);
      activityRequests.push(body);
      return Response.json({ ok: true, record: { ...records.find((r) => r.recordId === body.recordId), lastRequestId: crypto.randomUUID() } });
    }
    return new Response("Not found", { status: 404 });
  } });
  t.after(cleanup);
  await signIn("alex@example.test");

  // Open bulk outreach dialog
  context.openBulkOutreach();
  assert.equal(getEl("bulk-outreach-dialog").open, true);
  assert.equal(getEl("bulk-step-1").hidden, false);

  // Eligible list excludes Booked and Cold by default
  const picker = getEl("bulk-school-list");
  assert.equal(picker.children.length, 3, "Only the 3 non-Booked, non-Cold schools are selectable");

  // Step 1: Select 3 schools
  context.toggleBulkSchoolSelection(records[0].recordId, true);
  context.toggleBulkSchoolSelection(records[1].recordId, true);
  context.toggleBulkSchoolSelection(records[2].recordId, true);
  assert.equal(getEl("bulk-select-count").textContent, "3 of 20 selected");
  assert.equal(getEl("bulk-to-step2").disabled, false);

  // Advance to Step 2
  getEl("bulk-to-step2").click();
  assert.equal(getEl("bulk-step-1").hidden, true);
  assert.equal(getEl("bulk-step-2").hidden, false);
  assert.equal(getEl("bulk-recap-count").textContent, "3 schools selected");

  // Step 2: Use summary suggestions and chips
  const chipsContainer = getEl("bulk-summary-suggestion-chips");
  assert.ok(chipsContainer.children.length > 0);
  const introChip = Array.from(chipsContainer.children).find((c) => c.textContent === "Introduced H4");
  assert.ok(introChip);
  introChip.click();
  assert.equal(getEl("bulk-summary").value, "Sent an introductory email explaining H4 and our free dance programs.");

  context.applySuggestion("bulk-outcome", "No reply yet");
  context.applySuggestion("bulk-nextAction", "Follow up if no reply");
  getEl("bulk-followUpDue").value = "2026-10-30";

  // Advance to Step 3
  getEl("bulk-to-step3").click();
  assert.equal(getEl("bulk-step-2").hidden, true);
  assert.equal(getEl("bulk-step-3").hidden, false);

  // Step 3: Displays all selected school names before confirmation
  const reviewList = getEl("bulk-review-schools-list");
  assert.equal(reviewList.children.length, 3);
  assert.equal(getEl("bulk-rev-count").textContent, "3");
  assert.equal(getEl("bulk-rev-summary").textContent, "Sent an introductory email explaining H4 and our free dance programs.");

  // Requirement 5: Button wording is "Log outreach for 3 schools"
  assert.equal(getEl("bulk-submit-save").textContent, "Log outreach for 3 schools");

  // Confirmation is mandatory
  assert.equal(getEl("bulk-submit-save").disabled, true);
  getEl("bulk-confirm-sent").click();
  assert.equal(getEl("bulk-submit-save").disabled, false);

  // Submit save
  getEl("bulk-submit-save").click();

  // Wait for saves to finish
  for (let i = 0; i < 50 && activityRequests.length < 3; i++) {
    await new Promise((done) => setTimeout(done, 10));
  }
  assert.equal(activityRequests.length, 3);

  // Requests: Not Contacted moved to Contacted
  assert.equal(activityRequests[0].recordId, records[0].recordId);
  assert.equal(activityRequests[0].stage, "Contacted");
  assert.equal(activityRequests[0].channel, "Email");
  assert.equal(activityRequests[0].summary, "Sent an introductory email explaining H4 and our free dance programs.");
  assert.equal(activityRequests[1].stage, "Contacted");
  assert.equal(activityRequests[2].stage, "Contacted");

  // All 3 requests have unique UUIDs
  const requestIds = new Set(activityRequests.map((r) => r.requestId));
  assert.equal(requestIds.size, 3);

  // UI shows completion
  assert.match(getEl("bulk-final-summary").textContent, /All 3 schools were saved successfully/);
  assert.equal(getEl("bulk-finish-done").hidden, false);
});

test("Bulk Log Outreach: First Contact vs Follow-Up preserves distinct counting rules", async (t) => {
  const records = [
    { recordId: "00000000-0000-4000-8000-000000000011", schoolName: "School 11", schoolBoard: "TDSB", geographicRegion: "North", stage: "Contacted", lastRequestId: "v1", canEdit: true },
  ];
  const activityRequests = [];
  const { context, getEl, signIn, cleanup } = setupEnv({ fetchHandler: async (url, init = {}) => {
    if (url.includes("/api/config")) return Response.json({ ready: true, writesEnabled: true, googleClientId: "test-client-id" });
    if (url.includes("/api/bootstrap")) return Response.json({ currentUser: { name: "Alex", email: "alex@example.test", role: "co-op" }, schools: records, sessionExpiresAt: Math.floor(Date.now() / 1000) + 3600 });
    if (url.includes("/api/schools/detail")) return Response.json({ ok: true, record: records[0] });
    if (url.includes("/api/activities")) {
      activityRequests.push(JSON.parse(init.body));
      return Response.json({ ok: true, record: { ...records[0], lastRequestId: crypto.randomUUID() } });
    }
    return new Response("Not found", { status: 404 });
  } });
  t.after(cleanup);
  await signIn("alex@example.test");

  context.openBulkOutreach([records[0].recordId]);
  getEl("bulk-to-step2").click();

  // Previously contacted school under First Contact shows classification mismatch
  assert.equal(getEl("bulk-qualification-notice").hidden, false);
  assert.equal(getEl("bulk-to-step3").disabled, true);

  // Select Follow-up: clears error and enables next step
  getEl("bulk-activityType").value = "FollowUp";
  getEl("bulk-activityType").dispatchEvent(new Event("change", { bubbles: true }));
  assert.equal(getEl("bulk-qualification-notice").hidden, true);
  assert.equal(getEl("bulk-to-step3").disabled, false);

  context.applySuggestion("bulk-outcome", "Requested an update");
  context.applySuggestion("bulk-summary", "Followed up about workshop opportunities.");

  getEl("bulk-to-step3").click();
  getEl("bulk-confirm-sent").click();
  getEl("bulk-submit-save").click();

  for (let i = 0; i < 50 && activityRequests.length < 1; i++) {
    await new Promise((done) => setTimeout(done, 10));
  }
  assert.equal(activityRequests.length, 1);
  assert.equal(activityRequests[0].activityType, "FollowUp", "Sends FollowUp to increment followUpCount");
});

test("Bulk Log Outreach: does not overwrite existing Next Action or Follow-Up Date without explicit student approval", async (t) => {
  const records = [
    { recordId: "00000000-0000-4000-8000-000000000021", schoolName: "School 21", schoolBoard: "TDSB", geographicRegion: "North", stage: "Not Contacted", lastRequestId: "v1", canEdit: true, nextAction: "Existing Action", followUpDue: "2026-10-22" },
    { recordId: "00000000-0000-4000-8000-000000000022", schoolName: "School 22", schoolBoard: "TDSB", geographicRegion: "East", stage: "Not Contacted", lastRequestId: "v2", canEdit: true, nextAction: "", followUpDue: "" },
  ];
  const activityRequests = [];
  const { context, getEl, signIn, cleanup } = setupEnv({ fetchHandler: async (url, init = {}) => {
    if (url.includes("/api/config")) return Response.json({ ready: true, writesEnabled: true, googleClientId: "test-client-id" });
    if (url.includes("/api/bootstrap")) return Response.json({ currentUser: { name: "Alex", email: "alex@example.test", role: "co-op" }, schools: records, sessionExpiresAt: Math.floor(Date.now() / 1000) + 3600 });
    if (url.includes("/api/schools/detail")) {
      const match = url.match(/recordId=([^&]+)/);
      return Response.json({ ok: true, record: records.find((r) => r.recordId === decodeURIComponent(match[1])) });
    }
    if (url.includes("/api/activities")) {
      activityRequests.push(JSON.parse(init.body));
      return Response.json({ ok: true, record: { recordId: "test", lastRequestId: crypto.randomUUID() } });
    }
    return new Response("Not found", { status: 404 });
  } });
  t.after(cleanup);
  await signIn("alex@example.test");

  context.openBulkOutreach([records[0].recordId, records[1].recordId]);
  getEl("bulk-to-step2").click();

  context.applySuggestion("bulk-outcome", "No reply yet");
  context.applySuggestion("bulk-summary", "Sent an introductory email.");
  getEl("bulk-nextAction").value = "New bulk action";
  getEl("bulk-followUpDue").value = "2026-11-05";

  // By default, overwrite checkbox is FALSE
  assert.equal(getEl("bulk-overwrite-next-steps").checked, false);

  getEl("bulk-to-step3").click();
  getEl("bulk-confirm-sent").click();
  getEl("bulk-submit-save").click();

  for (let i = 0; i < 50 && activityRequests.length < 2; i++) {
    await new Promise((done) => setTimeout(done, 10));
  }
  assert.equal(activityRequests.length, 2);

  // School 21 already had next action and due date: preserved!
  assert.equal(activityRequests[0].nextAction, undefined, "Existing next action was not overwritten");
  assert.equal(activityRequests[0].followUpDue, undefined, "Existing follow-up due was not overwritten");

  // School 22 had empty next action and due date: bulk values applied!
  assert.equal(activityRequests[1].nextAction, "New bulk action");
  assert.equal(activityRequests[1].followUpDue, "2026-11-05");
});

test("Bulk Log Outreach: coordinator safety halts batch immediately on WORKBOOK_BLOCKED or COMMIT_UNCERTAIN", async (t) => {
  const records = [
    { recordId: "00000000-0000-4000-8000-000000000031", schoolName: "School 31", schoolBoard: "TDSB", geographicRegion: "North", stage: "Not Contacted", lastRequestId: "v1", canEdit: true },
    { recordId: "00000000-0000-4000-8000-000000000032", schoolName: "School 32", schoolBoard: "TDSB", geographicRegion: "East", stage: "Not Contacted", lastRequestId: "v2", canEdit: true },
    { recordId: "00000000-0000-4000-8000-000000000033", schoolName: "School 33", schoolBoard: "TDSB", geographicRegion: "West", stage: "Not Contacted", lastRequestId: "v3", canEdit: true },
  ];
  const activityCalls = [];
  const { context, getEl, signIn, cleanup } = setupEnv({ fetchHandler: async (url, init = {}) => {
    if (url.includes("/api/config")) return Response.json({ ready: true, writesEnabled: true, googleClientId: "test-client-id" });
    if (url.includes("/api/bootstrap")) return Response.json({ currentUser: { name: "Alex", email: "alex@example.test", role: "co-op" }, schools: records, sessionExpiresAt: Math.floor(Date.now() / 1000) + 3600 });
    if (url.includes("/api/schools/detail")) {
      const match = url.match(/recordId=([^&]+)/);
      return Response.json({ ok: true, record: records.find((r) => r.recordId === decodeURIComponent(match[1])) });
    }
    if (url.includes("/api/activities")) {
      const body = JSON.parse(init.body);
      activityCalls.push(body.recordId);
      if (body.recordId === records[1].recordId) {
        return Response.json({ ok: false, code: "WORKBOOK_BLOCKED", message: "Workbook is blocked by pending uncertain operation." }, { status: 503 });
      }
      return Response.json({ ok: true, record: { recordId: body.recordId, lastRequestId: crypto.randomUUID() } });
    }
    return new Response("Not found", { status: 404 });
  } });
  t.after(cleanup);
  await signIn("alex@example.test");

  context.openBulkOutreach([records[0].recordId, records[1].recordId, records[2].recordId]);
  getEl("bulk-to-step2").click();
  context.applySuggestion("bulk-outcome", "No reply yet");
  context.applySuggestion("bulk-summary", "Sent an introductory email.");
  getEl("bulk-to-step3").click();
  getEl("bulk-confirm-sent").click();
  getEl("bulk-submit-save").click();

  for (let i = 0; i < 50 && activityCalls.length < 2; i++) {
    await new Promise((done) => setTimeout(done, 10));
  }
  assert.equal(activityCalls.length, 2);
  assert.equal(activityCalls.includes(records[2].recordId), false, "Batch stopped immediately before school 33");
  assert.equal(getEl("bulk-blocked-alert").hidden, false);
  assert.match(getEl("bulk-blocked-message").textContent, /blocked/i);
});

test("Bulk Log Outreach: 409 version conflict on individual school is marked separately while batch continues", async (t) => {
  const records = [
    { recordId: "00000000-0000-4000-8000-000000000041", schoolName: "School 41", schoolBoard: "TDSB", geographicRegion: "North", stage: "Not Contacted", lastRequestId: "v1", canEdit: true },
    { recordId: "00000000-0000-4000-8000-000000000042", schoolName: "School 42", schoolBoard: "TDSB", geographicRegion: "East", stage: "Not Contacted", lastRequestId: "v2", canEdit: true },
    { recordId: "00000000-0000-4000-8000-000000000043", schoolName: "School 43", schoolBoard: "TDSB", geographicRegion: "West", stage: "Not Contacted", lastRequestId: "v3", canEdit: true },
  ];
  const activityCalls = [];
  const { context, getEl, signIn, cleanup } = setupEnv({ fetchHandler: async (url, init = {}) => {
    if (url.includes("/api/config")) return Response.json({ ready: true, writesEnabled: true, googleClientId: "test-client-id" });
    if (url.includes("/api/bootstrap")) return Response.json({ currentUser: { name: "Alex", email: "alex@example.test", role: "co-op" }, schools: records, sessionExpiresAt: Math.floor(Date.now() / 1000) + 3600 });
    if (url.includes("/api/schools/detail")) {
      const match = url.match(/recordId=([^&]+)/);
      return Response.json({ ok: true, record: records.find((r) => r.recordId === decodeURIComponent(match[1])) });
    }
    if (url.includes("/api/activities")) {
      const body = JSON.parse(init.body);
      activityCalls.push(body.recordId);
      if (body.recordId === records[1].recordId) {
        return Response.json({ ok: false, code: "CONFLICT_STALE_VERSION", message: "Stale version" }, { status: 409 });
      }
      return Response.json({ ok: true, record: { recordId: body.recordId, lastRequestId: crypto.randomUUID() } });
    }
    return new Response("Not found", { status: 404 });
  } });
  t.after(cleanup);
  await signIn("alex@example.test");

  context.openBulkOutreach([records[0].recordId, records[1].recordId, records[2].recordId]);
  getEl("bulk-to-step2").click();
  context.applySuggestion("bulk-outcome", "No reply yet");
  context.applySuggestion("bulk-summary", "Sent an introductory email.");
  getEl("bulk-to-step3").click();
  getEl("bulk-confirm-sent").click();
  getEl("bulk-submit-save").click();

  for (let i = 0; i < 50 && activityCalls.length < 3; i++) {
    await new Promise((done) => setTimeout(done, 10));
  }
  assert.equal(activityCalls.length, 3);
  assert.match(getEl("bulk-final-summary").textContent, /Finished with 2 saved, 1 conflicts/);
});

test("Bulk Log Outreach: safe retries retain original request ID for uncertain writes and generate fresh ID for confirmed rejections", async (t) => {
  const records = [
    { recordId: "00000000-0000-4000-8000-000000000051", schoolName: "School 51", schoolBoard: "TDSB", geographicRegion: "North", stage: "Not Contacted", lastRequestId: "v1", canEdit: true },
    { recordId: "00000000-0000-4000-8000-000000000052", schoolName: "School 52", schoolBoard: "TDSB", geographicRegion: "East", stage: "Not Contacted", lastRequestId: "v2", canEdit: true },
  ];
  const activityRequests = [];
  let attempt = 0;

  const { context, getEl, signIn, cleanup } = setupEnv({ fetchHandler: async (url, init = {}) => {
    if (url.includes("/api/config")) return Response.json({ ready: true, writesEnabled: true, googleClientId: "test-client-id" });
    if (url.includes("/api/bootstrap")) return Response.json({ currentUser: { name: "Alex", email: "alex@example.test", role: "co-op" }, schools: records, sessionExpiresAt: Math.floor(Date.now() / 1000) + 3600 });
    if (url.includes("/api/schools/detail")) {
      const match = url.match(/recordId=([^&]+)/);
      return Response.json({ ok: true, record: records.find((r) => r.recordId === decodeURIComponent(match[1])) });
    }
    if (url.includes("/api/activities")) {
      const body = JSON.parse(init.body);
      activityRequests.push(body);
      attempt++;
      if (body.recordId === records[1].recordId && attempt === 2) {
        // Confirmed rejected operation (e.g. 502 SHEETS_REJECTED)
        return Response.json({ ok: false, code: "SHEETS_REJECTED", message: "Google Sheets rejected write" }, { status: 502 });
      }
      return Response.json({ ok: true, record: { recordId: body.recordId, lastRequestId: crypto.randomUUID() } });
    }
    return new Response("Not found", { status: 404 });
  } });
  t.after(cleanup);
  await signIn("alex@example.test");

  context.openBulkOutreach([records[0].recordId, records[1].recordId]);
  getEl("bulk-to-step2").click();
  context.applySuggestion("bulk-outcome", "No reply yet");
  context.applySuggestion("bulk-summary", "Sent an introductory email.");
  getEl("bulk-to-step3").click();
  getEl("bulk-confirm-sent").click();
  getEl("bulk-submit-save").click();

  for (let i = 0; i < 50 && activityRequests.length < 2; i++) {
    await new Promise((done) => setTimeout(done, 10));
  }
  assert.equal(activityRequests.length, 2);
  const initialRejectedId = activityRequests[1].requestId;

  // Retry button is visible
  assert.equal(getEl("bulk-retry-failed").hidden, false);

  // Click retry
  getEl("bulk-retry-failed").click();

  for (let i = 0; i < 50 && activityRequests.length < 3; i++) {
    await new Promise((done) => setTimeout(done, 10));
  }
  assert.equal(activityRequests.length, 3);

  // Confirmed rejection creates a FRESH request ID upon retrying
  assert.equal(activityRequests[2].recordId, records[1].recordId);
  assert.notEqual(activityRequests[2].requestId, initialRejectedId, "Confirmed rejection generated a fresh request ID on retry!");
  assert.equal(activityRequests[2].summary, activityRequests[1].summary, "Payload content was unchanged");
});

test("Bulk Log Outreach: Activity classification prevents mismatched outreach types and provides one-click deselect helper", async (t) => {
  const records = [
    { recordId: "00000000-0000-4000-8000-000000000061", schoolName: "School 61 (Not Contacted)", schoolBoard: "TDSB", geographicRegion: "North", stage: "Not Contacted", lastRequestId: "v1", canEdit: true },
    { recordId: "00000000-0000-4000-8000-000000000062", schoolName: "School 62 (Contacted)", schoolBoard: "TDSB", geographicRegion: "East", stage: "Contacted", lastRequestId: "v2", canEdit: true },
  ];
  const { context, getEl, signIn, cleanup } = setupEnv({ fetchHandler: async (url) => {
    if (url.includes("/api/config")) return Response.json({ ready: true, writesEnabled: true, googleClientId: "test-client-id" });
    if (url.includes("/api/bootstrap")) return Response.json({ currentUser: { name: "Alex", email: "alex@example.test", role: "co-op" }, schools: records, sessionExpiresAt: Math.floor(Date.now() / 1000) + 3600 });
    return new Response("Not found", { status: 404 });
  } });
  t.after(cleanup);
  await signIn("alex@example.test");

  // Select both schools
  context.openBulkOutreach([records[0].recordId, records[1].recordId]);
  getEl("bulk-to-step2").click();

  // 1. With First Contact (default): Contacted school triggers classification error
  assert.equal(getEl("bulk-qualification-notice").hidden, false);
  assert.match(getEl("bulk-qualification-text").textContent, /First Contact cannot be applied to previously contacted schools/);
  assert.equal(getEl("bulk-to-step3").disabled, true);

  // Click deselect helper
  const deselectBtn = getEl("bulk-deselect-ineligible");
  assert.equal(deselectBtn.hidden, false);
  assert.match(deselectBtn.textContent, /Deselect 1 contacted school/);
  deselectBtn.click();

  // Error clears, only Not Contacted school remains, step 3 enabled
  assert.equal(getEl("bulk-qualification-notice").hidden, true);
  assert.equal(getEl("bulk-to-step3").disabled, false);
  assert.equal(getEl("bulk-recap-count").textContent, "1 school selected");

  // 2. Add back Contacted school, switch to Follow-Up
  context.toggleBulkSchoolSelection(records[1].recordId, true);
  getEl("bulk-activityType").value = "FollowUp";
  getEl("bulk-activityType").dispatchEvent(new Event("change", { bubbles: true }));

  // Not Contacted school triggers classification error under Follow-Up
  assert.equal(getEl("bulk-qualification-notice").hidden, false);
  assert.match(getEl("bulk-qualification-text").textContent, /Follow-Up cannot be applied to Not Contacted schools/);
  assert.equal(getEl("bulk-to-step3").disabled, true);

  // Deselect helper removes Not Contacted school
  assert.match(deselectBtn.textContent, /Deselect 1 "Not Contacted" school/);
  deselectBtn.click();
  assert.equal(getEl("bulk-qualification-notice").hidden, true);
  assert.equal(getEl("bulk-to-step3").disabled, false);
  assert.equal(getEl("bulk-recap-count").textContent, "1 school selected");
});

test("Bulk Log Outreach: Connection interruption stops batch immediately and retains affected request ID for safe retry", async (t) => {
  const records = [
    { recordId: "00000000-0000-4000-8000-000000000071", schoolName: "School 71", schoolBoard: "TDSB", geographicRegion: "North", stage: "Not Contacted", lastRequestId: "v1", canEdit: true },
    { recordId: "00000000-0000-4000-8000-000000000072", schoolName: "School 72", schoolBoard: "TDSB", geographicRegion: "East", stage: "Not Contacted", lastRequestId: "v2", canEdit: true },
    { recordId: "00000000-0000-4000-8000-000000000073", schoolName: "School 73", schoolBoard: "TDSB", geographicRegion: "West", stage: "Not Contacted", lastRequestId: "v3", canEdit: true },
  ];
  const activityCalls = [];
  let networkFailed = true;

  const { context, getEl, signIn, cleanup } = setupEnv({ fetchHandler: async (url, init = {}) => {
    if (url.includes("/api/config")) return Response.json({ ready: true, writesEnabled: true, googleClientId: "test-client-id" });
    if (url.includes("/api/bootstrap")) return Response.json({ currentUser: { name: "Alex", email: "alex@example.test", role: "co-op" }, schools: records, sessionExpiresAt: Math.floor(Date.now() / 1000) + 3600 });
    if (url.includes("/api/schools/detail")) {
      const match = url.match(/recordId=([^&]+)/);
      return Response.json({ ok: true, record: records.find((r) => r.recordId === decodeURIComponent(match[1])) });
    }
    if (url.includes("/api/activities")) {
      const body = JSON.parse(init.body);
      activityCalls.push(body);
      if (body.recordId === records[1].recordId && networkFailed) {
        networkFailed = false;
        throw new TypeError("Failed to fetch: Connection timeout");
      }
      return Response.json({ ok: true, record: { recordId: body.recordId, lastRequestId: crypto.randomUUID() } });
    }
    return new Response("Not found", { status: 404 });
  } });
  t.after(cleanup);
  await signIn("alex@example.test");

  context.openBulkOutreach([records[0].recordId, records[1].recordId, records[2].recordId]);
  getEl("bulk-to-step2").click();
  context.applySuggestion("bulk-outcome", "No reply yet");
  context.applySuggestion("bulk-summary", "Sent an introductory email.");
  getEl("bulk-to-step3").click();
  getEl("bulk-confirm-sent").click();
  getEl("bulk-submit-save").click();

  for (let i = 0; i < 50 && activityCalls.length < 2; i++) {
    await new Promise((done) => setTimeout(done, 10));
  }
  // S1 succeeded. S2 threw network error. S3 was NEVER attempted!
  assert.equal(activityCalls.length, 2);
  assert.equal(activityCalls.some((c) => c.recordId === records[2].recordId), false, "Batch stopped immediately on network interruption!");

  assert.equal(getEl("bulk-blocked-alert").hidden, false);
  assert.match(getEl("bulk-blocked-message").textContent, /interrupted/i);

  const interruptedRequestId = activityCalls[1].requestId;

  // Retry resumes with same request ID for S2 and continues to S3
  getEl("bulk-retry-failed").click();
  for (let i = 0; i < 50 && activityCalls.length < 4; i++) {
    await new Promise((done) => setTimeout(done, 10));
  }
  assert.equal(activityCalls.length, 4);
  assert.equal(activityCalls[2].recordId, records[1].recordId);
  assert.equal(activityCalls[2].requestId, interruptedRequestId, "Uncertain write reused exact request ID on retry!");
  assert.equal(activityCalls[3].recordId, records[2].recordId);
});

test("Bulk Log Outreach: closing with uncertain saves requires confirmation and enables recovery via banner upon reopening", async (t) => {
  const records = [
    { recordId: "00000000-0000-4000-8000-000000000081", schoolName: "School 81", schoolBoard: "TDSB", geographicRegion: "North", stage: "Not Contacted", lastRequestId: "v1", canEdit: true },
  ];
  let confirmCalled = false;
  let confirmResult = false;

  const { context, getEl, signIn, cleanup } = setupEnv({ fetchHandler: async (url, init = {}) => {
    if (url.includes("/api/config")) return Response.json({ ready: true, writesEnabled: true, googleClientId: "test-client-id" });
    if (url.includes("/api/bootstrap")) return Response.json({ currentUser: { name: "Alex", email: "alex@example.test", role: "co-op" }, schools: records, sessionExpiresAt: Math.floor(Date.now() / 1000) + 3600 });
    if (url.includes("/api/schools/detail")) return Response.json({ ok: true, record: records[0] });
    if (url.includes("/api/activities")) {
      throw new Error("Connection failed");
    }
    return new Response("Not found", { status: 404 });
  } });
  t.after(cleanup);
  await signIn("alex@example.test");

  context.window.confirm = (msg) => {
    confirmCalled = true;
    return confirmResult;
  };

  context.openBulkOutreach([records[0].recordId]);
  getEl("bulk-to-step2").click();
  context.applySuggestion("bulk-outcome", "No reply yet");
  context.applySuggestion("bulk-summary", "Sent an introductory email.");
  getEl("bulk-to-step3").click();
  getEl("bulk-confirm-sent").click();
  getEl("bulk-submit-save").click();

  for (let i = 0; i < 50 && !getEl("bulk-retry-failed").hidden; i++) {
    await new Promise((done) => setTimeout(done, 10));
  }

  // Reload note is visible
  assert.match(getEl("bulk-reload-note").textContent, /Session & reload limit/);

  // Attempting to close via close button with confirmResult = false prevents closing
  confirmResult = false;
  confirmCalled = false;
  getEl("bulk-dialog-close").click();
  assert.equal(confirmCalled, true, "Clicking close button triggers confirmation dialog");
  assert.equal(getEl("bulk-outreach-dialog").open, true, "Dialog remains open when close button confirmation is cancelled");

  // Attempting to close via Done button with confirmResult = false also prevents closing
  confirmCalled = false;
  getEl("bulk-finish-done").click();
  assert.equal(confirmCalled, true, "Clicking Done button triggers confirmation dialog");
  assert.equal(getEl("bulk-outreach-dialog").open, true, "Dialog remains open when Done button confirmation is cancelled");

  // Confirming exit closes dialog and stores unresolved batch
  confirmResult = true;
  getEl("bulk-dialog-close").click();
  assert.equal(getEl("bulk-outreach-dialog").open, false);

  // Re-opening bulk outreach shows unresolved banner
  context.openBulkOutreach();
  assert.equal(getEl("bulk-unresolved-banner").hidden, false);
  assert.match(getEl("bulk-unresolved-text").textContent, /1 school from your previous batch/);

  // Clicking resume takes student directly back to results to retry
  getEl("bulk-resume-unresolved").click();
  assert.equal(getEl("bulk-step-progress").hidden, false);
  assert.equal(getEl("bulk-retry-failed").hidden, false);
});

test("Bulk Log Outreach: ambiguous 503 errors (SAVE_UNAVAILABLE) are treated as uncertain, stop batch, and retain identical request ID and payload on retry", async (t) => {
  const records = [
    { recordId: "00000000-0000-4000-8000-000000000091", schoolName: "School 91", schoolBoard: "TDSB", geographicRegion: "North", stage: "Not Contacted", lastRequestId: "v1", canEdit: true },
    { recordId: "00000000-0000-4000-8000-000000000092", schoolName: "School 92", schoolBoard: "TDSB", geographicRegion: "East", stage: "Not Contacted", lastRequestId: "v2", canEdit: true },
  ];
  const activityRequests = [];
  let saveUnavailable = true;

  const { context, getEl, signIn, cleanup } = setupEnv({ fetchHandler: async (url, init = {}) => {
    if (url.includes("/api/config")) return Response.json({ ready: true, writesEnabled: true, googleClientId: "test-client-id" });
    if (url.includes("/api/bootstrap")) return Response.json({ currentUser: { name: "Alex", email: "alex@example.test", role: "co-op" }, schools: records, sessionExpiresAt: Math.floor(Date.now() / 1000) + 3600 });
    if (url.includes("/api/schools/detail")) {
      const match = url.match(/recordId=([^&]+)/);
      return Response.json({ ok: true, record: records.find((r) => r.recordId === decodeURIComponent(match[1])) });
    }
    if (url.includes("/api/activities")) {
      const body = JSON.parse(init.body);
      activityRequests.push(body);
      if (saveUnavailable) {
        return Response.json({ ok: false, code: "SAVE_UNAVAILABLE", message: "Google Sheets save unavailable" }, { status: 503 });
      }
      return Response.json({ ok: true, record: { recordId: body.recordId, lastRequestId: crypto.randomUUID() } });
    }
    return new Response("Not found", { status: 404 });
  } });
  t.after(cleanup);
  await signIn("alex@example.test");

  context.openBulkOutreach([records[0].recordId, records[1].recordId]);
  getEl("bulk-to-step2").click();
  context.applySuggestion("bulk-outcome", "No reply yet");
  context.applySuggestion("bulk-summary", "Sent introductory email.");
  getEl("bulk-to-step3").click();
  getEl("bulk-confirm-sent").click();
  getEl("bulk-submit-save").click();

  for (let i = 0; i < 50 && !getEl("bulk-retry-failed").hidden; i++) {
    await new Promise((done) => setTimeout(done, 10));
  }

  // Ambiguous 503 stopped batch immediately: School 92 was NOT called!
  assert.equal(activityRequests.length, 1);
  const initialRequestId = activityRequests[0].requestId;
  assert.equal(activityRequests[0].recordId, records[0].recordId);

  // Status is uncertain and batch is stopped safely
  assert.equal(getEl("bulk-blocked-alert").hidden, false);
  assert.match(getEl("bulk-blocked-message").textContent, /unavailable/i);
  assert.match(getEl("bulk-final-summary").textContent, /1 uncertain/i);
  assert.equal(getEl("bulk-retry-failed").hidden, false);

  // Now retry: server becomes available
  saveUnavailable = false;
  getEl("bulk-retry-failed").click();

  for (let i = 0; i < 50 && activityRequests.length < 3; i++) {
    await new Promise((done) => setTimeout(done, 10));
  }

  // 1 initial call + 1 retry call for School 91 + 1 call for School 92 = 3 calls
  assert.equal(activityRequests.length, 3);
  // Original request ID and payload MUST be preserved for uncertain retry!
  assert.equal(activityRequests[1].requestId, initialRequestId, "Exact request ID preserved on retry for ambiguous 503");
  assert.equal(activityRequests[1].summary, activityRequests[0].summary, "Identical payload preserved on retry");
  assert.equal(activityRequests[2].recordId, records[1].recordId, "Batch continued safely to School 92 after reconciling");
  assert.match(getEl("bulk-final-summary").textContent, /All 2 schools were saved successfully/);
});

test("Bulk Log Outreach: WORKBOOK_BLOCKED preserves blocked and pending records across close/reopen and prevents silent batch replacement", async (t) => {
  const records = [
    { recordId: "00000000-0000-4000-8000-000000000101", schoolName: "School 101", schoolBoard: "TDSB", geographicRegion: "North", stage: "Not Contacted", lastRequestId: "v1", canEdit: true },
    { recordId: "00000000-0000-4000-8000-000000000102", schoolName: "School 102", schoolBoard: "TDSB", geographicRegion: "East", stage: "Not Contacted", lastRequestId: "v2", canEdit: true },
  ];
  const activityRequests = [];
  let isBlocked = true;

  const { context, getEl, signIn, cleanup } = setupEnv({ fetchHandler: async (url, init = {}) => {
    if (url.includes("/api/config")) return Response.json({ ready: true, writesEnabled: true, googleClientId: "test-client-id" });
    if (url.includes("/api/bootstrap")) return Response.json({ currentUser: { name: "Alex", email: "alex@example.test", role: "co-op" }, schools: records, sessionExpiresAt: Math.floor(Date.now() / 1000) + 3600 });
    if (url.includes("/api/schools/detail")) {
      const match = url.match(/recordId=([^&]+)/);
      return Response.json({ ok: true, record: records.find((r) => r.recordId === decodeURIComponent(match[1])) });
    }
    if (url.includes("/api/activities")) {
      const body = JSON.parse(init.body);
      activityRequests.push(body);
      if (isBlocked) {
        return Response.json({ ok: false, code: "WORKBOOK_BLOCKED", message: "Workbook is blocked for safety." }, { status: 503 });
      }
      return Response.json({ ok: true, record: { recordId: body.recordId, lastRequestId: crypto.randomUUID() } });
    }
    return new Response("Not found", { status: 404 });
  } });
  t.after(cleanup);
  await signIn("alex@example.test");

  let confirmPrompted = false;
  let confirmAnswer = true;
  context.window.confirm = () => {
    confirmPrompted = true;
    return confirmAnswer;
  };

  context.openBulkOutreach([records[0].recordId, records[1].recordId]);
  getEl("bulk-to-step2").click();
  context.applySuggestion("bulk-outcome", "No reply yet");
  context.applySuggestion("bulk-summary", "Sent introductory email.");
  getEl("bulk-to-step3").click();
  getEl("bulk-confirm-sent").click();
  getEl("bulk-submit-save").click();

  for (let i = 0; i < 50 && !getEl("bulk-retry-failed").hidden; i++) {
    await new Promise((done) => setTimeout(done, 10));
  }

  // Batch stopped on School 101; School 102 remained pending
  assert.equal(activityRequests.length, 1);
  assert.equal(getEl("bulk-blocked-alert").hidden, false);
  assert.match(getEl("bulk-blocked-message").textContent, /blocked/i);

  // Close dialog using actual button click
  confirmPrompted = false;
  confirmAnswer = true;
  getEl("bulk-dialog-close").click();
  assert.equal(confirmPrompted, true, "Closing with unresolved blocked/pending items prompts confirmation");
  assert.equal(getEl("bulk-outreach-dialog").open, false);

  // Reopen bulk outreach
  context.openBulkOutreach();
  assert.equal(getEl("bulk-outreach-dialog").open, true);
  // Recovery banner is displayed with count of unresolved records (1 blocked + 1 pending = 2)
  assert.equal(getEl("bulk-unresolved-banner").hidden, false);
  assert.match(getEl("bulk-unresolved-text").textContent, /2 schools from your previous batch need review or retry/);

  // Attempt to start a NEW batch without resolving previous batch:
  // User cancels confirmation -> new batch must NOT silently replace previous batch
  getEl("bulk-to-step2").click();
  context.applySuggestion("bulk-outcome", "Left voicemail");
  context.applySuggestion("bulk-summary", "Left message with principal.");
  getEl("bulk-to-step3").click();
  getEl("bulk-confirm-sent").click();

  confirmPrompted = false;
  confirmAnswer = false; // User cancels replacement!
  getEl("bulk-submit-save").click();
  assert.equal(confirmPrompted, true, "Attempting new batch prompts confirmation to avoid silent replacement");
  // Still only 1 activity call had been made previously
  assert.equal(activityRequests.length, 1);

  // Return to step 1 and resume unresolved batch
  getEl("bulk-back-to-step2").click();
  getEl("bulk-back-to-step1").click();
  getEl("bulk-resume-unresolved").click();

  // Results screen is shown with 2 eligible items to retry (blocked + pending)
  assert.equal(getEl("bulk-step-progress").hidden, false);
  assert.equal(getEl("bulk-retry-failed").hidden, false);
  assert.match(getEl("bulk-retry-failed").textContent, /Retry eligible saves \(2\)/);

  // Unblock coordinator and retry
  isBlocked = false;
  getEl("bulk-retry-failed").click();

  for (let i = 0; i < 50 && activityRequests.length < 3; i++) {
    await new Promise((done) => setTimeout(done, 10));
  }

  assert.equal(activityRequests.length, 3);
  assert.equal(activityRequests[1].recordId, records[0].recordId);
  assert.equal(activityRequests[1].requestId, activityRequests[0].requestId, "Exact request ID preserved on retry");
  assert.equal(activityRequests[2].recordId, records[1].recordId);
  assert.match(getEl("bulk-final-summary").textContent, /All 2 schools were saved successfully/);

  // Reopening now shows no unresolved banner
  context.closeBulkOutreach(true);
  context.openBulkOutreach();
  assert.equal(getEl("bulk-unresolved-banner").hidden, true);
});

