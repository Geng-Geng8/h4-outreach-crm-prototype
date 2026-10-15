import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import vm from "node:vm";
import { webcrypto } from "node:crypto";

const appCode = await readFile("public/app.js", "utf8");

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
  getEl("school-list").children[0].click();
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

function setupEnv({ fetchHandler, apiOrigin = "" }) {
  let googleOptions;
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
    getElementById: (id) => getEl(id),
    createElement: (tag) => makeElement("", tag),
    head: makeElement("head", "head"),
    addEventListener: () => {},
    visibilityState: "visible",
  };
  const window = {
    addEventListener: () => {},
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

  return { context, getEl, signIn, cleanup };
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
