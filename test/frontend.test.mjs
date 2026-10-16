import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import vm from "node:vm";
import { webcrypto } from "node:crypto";

const appCode = await readFile("public/app.js", "utf8");

test("team dashboard totals, pipeline and combined filters show team status without other-owner actions", async (t) => {
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
  assert.deepEqual(h.getEl("dashboard-metrics").children.map((node) => node.children[0].textContent), ["7", "1", "1", "5"]);
  assert.equal(h.getEl("dashboard-pipeline").children.length, 7);
  assert.equal(h.getEl("dashboard-rows").children.find((row) => row.children[0].children[0].textContent === "School 1").children[5].textContent, "View only");
  assert.equal(h.getEl("dashboard-rows").children[0].children[5].children[0].textContent, "Open school →");
  h.getEl("dashboard-pipeline").children[4].click();
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

function setupEnv({ fetchHandler, apiOrigin = "", online = true, missingIds = [] }) {
  let googleOptions;
  const windowListeners = new Map();
  const activeTimers = new Set();
  const activeIntervals = new Set();
  const elements = new Map();

  function cleanup() {
    for (const t of activeTimers) {
      globalThis.clearTimeout(t);
    }
    activeTimers.clear();
    for (const i of activeIntervals) {
      globalThis.clearInterval(i);
    }
    activeIntervals.clear();
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
      hidden: false,
      disabled: false,
      open: false,
      showModal() { this.open = true; },
      close() { this.open = false; },
      children,
      replaceChildren: (...args) => { children.length = 0; children.push(...args); },
      append: (...args) => { children.push(...args); },
      setAttribute: (k, v) => { attrs[k] = String(v); },
      getAttribute: (k) => attrs[k],
      addEventListener: (ev, fn) => { (listeners[ev] ??= []).push(fn); },
      click: function () {
        if (this.disabled) return;
        if (this.onclick) this.onclick();
        (listeners["click"] || []).forEach((fn) => fn({ target: this }));
      },
    };
  }

  const document = {
    querySelector: () => ({ content: apiOrigin }),
    getElementById: (id) => missingIds.includes(id) ? null : getEl(id),
    createElement: (tag) => makeElement("", tag),
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
        },
      },
    },
  };

  const context = {
    document,
    window,
    navigator: { onLine: online },
    crypto: webcrypto,
    el: (id) => getEl(id),
    fetch: fetchHandler,
    setTimeout: (fn, ms) => {
      let t;
      t = globalThis.setTimeout(() => {
        activeTimers.delete(t);
        fn();
      }, ms);
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
    atob: (str) => Buffer.from(str, "base64").toString("binary"),
    console,
  };

  vm.createContext(context);
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

  return { context, getEl, signIn, cleanup,
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
