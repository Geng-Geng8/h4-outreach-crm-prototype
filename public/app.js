const el = (id) => document.getElementById(id);
// Pages supplies a public API origin; the local preview stays on the same origin.
const apiOrigin = document.querySelector?.('meta[name="h4-api-origin"]')?.content?.trim().replace(/\/$/, "") ?? "";
let connectionAttempt = 0, connectionProbe;
function browserOffline() { return typeof navigator !== "undefined" && navigator.onLine === false; }
function setConnection(connected) {
  const label = el("mode-label"), badge = el("connection-badge");
  // Older cached HTML may not include the badge. Never let optional UI break login.
  if (!label || !badge) return;
  const online = connected && !browserOffline();
  const message = online ? "Online" : "Not connected";
  if (label.textContent !== message) label.textContent = message;
  badge.setAttribute("data-state", online ? "online" : "offline");
  badge.title = online ? "Connected to the H4 app server. Saves are confirmed separately." : "The app server could not be reached. Reconnect and try again.";
}
async function apiFetch(path, options) {
  const attempt = ++connectionAttempt;
  try {
    const response = await fetch(apiOrigin ? `${apiOrigin}/${path.replace(/^\.\//, "")}` : path, options);
    if (attempt === connectionAttempt) setConnection(response.status < 500);
    return response;
  } catch (error) {
    if (attempt === connectionAttempt && error.name !== "AbortError") setConnection(false);
    throw error;
  }
}
function checkConnection() {
  if (browserOffline()) { setConnection(false); return Promise.resolve(false); }
  connectionProbe ??= (async () => {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 8000);
    const attempt = connectionAttempt + 1;
    try {
      const response = await apiFetch("./api/health", { cache: "no-store", credentials: "omit", signal: controller.signal });
      if (!response.ok && attempt === connectionAttempt) setConnection(false);
      return response.ok;
    } catch { if (attempt === connectionAttempt) setConnection(false); return false; }
    finally { clearTimeout(timeout); }
  })().finally(() => { connectionProbe = undefined; });
  return connectionProbe;
}
let credential = "", schools = [], directory = [], demoSchools = [], config, nonce = "";
let sessionVersion = 0, refreshSeq = 0, dirSeq = 0, demoSeq = 0;
let activeRequest, activeDirRequest, activeDemoRequest, expiryTimer;
let googleLoading, currentTab = "my-schools", isSupervisor = false;
const pendingClaims = new Map(); // osn -> requestId
let teamSchools = [], dashboardLoaded = false, dashboardSeq = 0, dashboardRequest;
let overviewStudents = [], schoolScopeFilter = null, schoolStageFilter = "", schoolScopeLabel = "", homeShowAll = false;
const pipelineStages = ["Not Contacted", "Contacted", "Interested", "Engaged", "Booked", "Cold"];
const otherStage = "Other / not set";
const stageKey = (school) => pipelineStages.includes(school.stage) ? school.stage : otherStage;
const assignee = (school) => school.assignedTo?.trim() || "Unassigned";
const editFields = ["contactName", "contactRole", "email", "phone", "stage", "priority", "outreachGoal", "followUpDue", "nextAction", "notes"];
const outreachFields = ["channel", "activityType", "outcome", "summary"];
const detailOnlyFields = ["contactName", "contactRole", "email", "phone", "priority", "outreachGoal", "notes"];
let editing = null, editorSeq = 0, editorRead;
let saveToastTimer;
const editDrafts = new Map();
const sessionKey = "h4.crm.session-token.v1";
const resumeKey = "h4.crm.resume-view.v1";
const resumableViews = ["home", "my-schools", "directory", "dashboard"];
let resumeView = null, sessionWasExpired = false;

function parseJwtPayload(token) {
  if (typeof token !== "string") return null;
  const parts = token.split(".");
  if (parts.length !== 3) return null;
  try {
    const encoded = parts[1].replace(/-/g, "+").replace(/_/g, "/");
    return JSON.parse(atob(encoded));
  } catch {
    return null;
  }
}

function isSessionExpired(token) {
  const payload = parseJwtPayload(token);
  if (!payload || typeof payload.exp !== "number") return true;
  return payload.exp * 1000 <= Date.now();
}

function savedSession() {
  try {
    const token = sessionStorage.getItem(sessionKey);
    if (typeof token !== "string" || !token) return null;
    if (isSessionExpired(token)) {
      sessionWasExpired = true;
      forgetSession();
      return null;
    }
    return token;
  } catch {
    return null;
  }
}

function rememberSession(token) {
  // Session token only: allows reload without re-prompting Google within the same browser tab.
  // Never persist private school records, notes, contacts, or cached user details.
  try {
    if (token) sessionStorage.setItem(sessionKey, token);
    else sessionStorage.removeItem(sessionKey);
  } catch { /* Storage may be disabled. */ }
}

function savedView() {
  try { const view = sessionStorage.getItem(resumeKey); return resumableViews.includes(view) ? view : null; }
  catch { return null; }
}

function rememberView() {
  // A navigation hint only.
  if (credential && !el("workspace").hidden && resumableViews.includes(currentTab)) {
    try { sessionStorage.setItem(resumeKey, currentTab); } catch { /* Storage may be disabled. */ }
  }
}

function finishRestore(message) {
  if (el("session-restore")) el("session-restore").hidden = true;
  if (!credential) { el("welcome").hidden = false; el("google-button").hidden = false; status(message); }
}

function status(message) { el("login-status").textContent = message; }
function refreshFailed(message) {
  const visibleWorkspace = !el("workspace").hidden;
  const detail = visibleWorkspace ? `${message} Showing your last loaded records. Your draft is kept; try Refresh again.` : `${message} Choose Try again to load your workspace.`;
  el("workspace-status").textContent = detail;
  if (el("home-status")) el("home-status").textContent = detail;
  if (currentTab === "dashboard" && el("dashboard-status")) el("dashboard-status").textContent = detail;
  if (!visibleWorkspace) {
    if (el("session-restore")) el("session-restore").hidden = true;
    el("welcome").hidden = false; status(detail); el("retry").hidden = false; el("google-button").hidden = false;
    if (config?.ready) showGoogleButton().catch(() => {});
  }
}
function forgetSession() {
  sessionVersion++;
  nonce = ""; resumeView = null;
  window.google?.accounts?.id.cancel?.();
  try {
    sessionStorage.removeItem(sessionKey);
    sessionStorage.removeItem(resumeKey);
  } catch { /* Storage may be disabled. */ }
  if (el("session-restore")) el("session-restore").hidden = true;
  editorSeq++; editorRead?.abort(); editing = null; editDrafts.clear();
  clearTimeout(saveToastTimer); el("save-toast").hidden = true;
  el("school-editor").close?.();
  for (const field of editFields) el(`edit-${field}`).value = "";
  for (const field of outreachFields) el(`log-${field}`).value = "";
  el("editor-title").textContent = "Edit school"; el("editor-meta").textContent = ""; el("editor-status").textContent = "";
  el("editor-feedback").textContent = "";
  activeRequest?.abort();
  activeDirRequest?.abort();
  activeDemoRequest?.abort();
  dashboardRequest?.abort(); dashboardSeq++; teamSchools = []; dashboardLoaded = false;
  overviewStudents = []; schoolScopeFilter = null; schoolStageFilter = ""; schoolScopeLabel = ""; homeShowAll = false;
  if (el("home-view")) {
    for (const id of ["home-metrics", "home-actions", "overview-pipeline", "overview-students"]) el(id).replaceChildren();
    el("home-filter").value = ""; el("home-content").hidden = true; el("overview-panel").hidden = true;
    el("home-status").textContent = ""; el("home-action-count").textContent = "";
    el("home-message").textContent = ""; el("home-description").textContent = "";
    el("home-more").textContent = "Show more schools"; el("home-more").hidden = true;
  }
  if (el("dashboard-view")) {
    el("dashboard-rows").replaceChildren();
    for (const id of ["dashboard-search", "dashboard-owner", "dashboard-stage"]) el(id).value = "";
    el("dashboard-overdue").checked = false;
    el("dashboard-owner").replaceChildren(); el("dashboard-stage").replaceChildren();
    el("dashboard-count").textContent = ""; el("dashboard-status").textContent = "";
    el("dashboard-content").hidden = true;
  }
  clearTimeout(expiryTimer);
  el("refresh").disabled = false; el("retry").disabled = false;
  if (el("home-refresh")) el("home-refresh").disabled = false;
  credential = ""; schools = []; directory = []; demoSchools = []; isSupervisor = false;
  pendingClaims.clear();
  el("school-list").replaceChildren(); el("search").value = "";
  el("school-count").textContent = "0"; el("school-count-label").textContent = "schools";
  if (el("schools-scope")) { el("schools-scope").hidden = true; el("schools-scope-label").textContent = ""; }
  if (el("dir-list")) {
    el("dir-list").replaceChildren(); el("dir-search").value = "";
    const dirFeedback = el("dir-feedback");
    if (dirFeedback) { dirFeedback.textContent = ""; dirFeedback.className = "demo-feedback"; }
  }
  if (el("demo-list")) {
    el("demo-list").replaceChildren();
    const feedback = el("demo-feedback");
    if (feedback) { feedback.textContent = ""; feedback.className = "demo-feedback"; }
  }
  ["user-name", "user-email", "user-role", "avatar", "workspace-description"].forEach((id) => { el(id).textContent = ""; });
  el("workspace").hidden = true; el("welcome").hidden = false;
  switchTab("my-schools");
}

async function googleClient() {
  googleLoading ??= new Promise((resolve, reject) => {
    if (window.google?.accounts?.id) return resolve(window.google.accounts.id);
    const script = document.createElement("script");
    script.src = "https://accounts.google.com/gsi/client"; script.async = true;
    script.onload = () => window.google?.accounts?.id ? resolve(window.google.accounts.id) : reject(new Error());
    script.onerror = () => { script.remove(); googleLoading = undefined; reject(new Error()); };
    document.head.append(script);
  });
  return googleLoading;
}

async function showGoogleButton() {
  const google = await googleClient();
  nonce = crypto.randomUUID() + crypto.randomUUID();
  const callbackNonce = nonce;
  google.initialize({ client_id: config.googleClientId, nonce, auto_select: false,
    callback: (response) => { if (nonce === callbackNonce) return onGoogleSignIn(response); } });
  el("google-button").replaceChildren();
  google.renderButton(el("google-button"), { theme: "outline", size: "large", shape: "pill", text: "continue_with", width: 280 });
  el("google-button").hidden = false;
}

async function onGoogleSignIn(response) {
  // Bind the callback to the current page interaction. Signature and every identity
  // claim are verified on the server before any school data is returned.
  try {
    if (typeof response.credential !== "string") throw new Error();
    const payload = parseJwtPayload(response.credential);
    if (!payload || !nonce || payload.nonce !== nonce) throw new Error();
    const previousView = resumeView || savedView();
    forgetSession();
    credential = response.credential;
    rememberSession(credential);
    resumeView = previousView;
    if (previousView && el("session-restore")) { el("session-restore").hidden = false; el("welcome").hidden = true; }
    el("google-button").hidden = true;
    await refresh();
  } catch {
    forgetSession(); status("We couldn’t confirm that sign-in. Please try again.");
    el("google-button").hidden = false; el("retry").hidden = false;
    if (config?.ready) await showGoogleButton().catch(() => {});
  }
}

function renderSchools() {
  const query = el("search").value.trim().toLowerCase();
  const today = dashboardToday();
  const visible = schools.filter((school) => (!schoolScopeFilter || schoolScopeFilter(school, today)) && (!schoolStageFilter || stageKey(school) === schoolStageFilter) &&
    [school.schoolName, school.schoolBoard, school.geographicRegion].some((value) => value.toLowerCase().includes(query)));
  if (el("schools-scope")) {
    el("schools-scope").hidden = !schoolScopeFilter && !schoolStageFilter;
    el("schools-scope-label").textContent = `${schoolScopeLabel || schoolStageFilter} · ${visible.length} ${visible.length === 1 ? "school" : "schools"}`;
  }
  el("school-count").textContent = String(visible.length);
  el("school-count-label").textContent = visible.length !== schools.length ? `of ${schools.length} schools` : schools.length === 1 ? "school" : "schools";
  el("school-list").replaceChildren();
  for (const school of visible) {
    const container = document.createElement("article"); container.className = "school-card";
    const card = document.createElement("button"); card.className = "school-open"; card.type = "button";
    card.setAttribute("aria-label", `Edit ${school.schoolName}`);
    card.onclick = () => openSchoolEditor(school.recordId);
    const stage = schoolBadge(school.stage);
    const priority = document.createElement("span"); priority.className = "school-priority"; priority.textContent = school.priority ? `${school.priority} priority` : "";
    const heading = document.createElement("h2"); heading.textContent = school.schoolName;
    const meta = document.createElement("p"); meta.className = "school-meta"; meta.textContent = [school.schoolBoard, school.geographicRegion].filter(Boolean).join(" · ") || "Location not listed";
    const assignment = document.createElement("p"); assignment.className = "assignment"; assignment.textContent = school.assignedTo ? `Assigned to ${school.assignedTo}` : "Unassigned";
    const editHint = document.createElement("span"); editHint.className = "edit-hint"; editHint.textContent = "Edit school →";
    const log = document.createElement("button"); log.className = "button school-log"; log.type = "button";
    log.textContent = "Log outreach"; log.setAttribute("aria-label", `Log outreach for ${school.schoolName}`);
    log.onclick = () => openSchoolEditor(school.recordId, false, "activity");
    log.disabled = config?.writesEnabled !== true;
    card.append(stage, priority, heading, meta, assignment); appendNextAction(card, school); card.append(editHint);
    container.append(card, log); el("school-list").append(container);
  }
  el("empty-state").hidden = visible.length > 0;
  el("empty-title").textContent = query ? "No matching schools" : "No schools assigned yet";
  el("empty-description").textContent = query ? "Try a different school name, board or region." : "Your supervisor can help you find your next school.";
}

function editorInputs(disabled) {
  for (const field of editFields) el(`edit-${field}`).disabled = disabled;
  for (const field of outreachFields) el(`log-${field}`).disabled = disabled;
}

function editorValues() { return Object.fromEntries(editFields.map((field) => [field, el(`edit-${field}`).value])); }
function outreachValues() { return Object.fromEntries(outreachFields.map((field) => [field, el(`log-${field}`).value])); }
function editorDraftKey(edit) { return `${edit.mode ?? "details"}:${edit.id}`; }
function editorSaveLabel(edit) { return edit.mode === "activity" ? "Save outreach" : "Save changes"; }

function editorFeedback(message, kind = "info") {
  el("editor-status").textContent = message;
  el("editor-feedback").textContent = message;
  el("editor-feedback").setAttribute("data-kind", kind);
}

function showSaveToast(message) {
  clearTimeout(saveToastTimer);
  el("save-toast").textContent = message; el("save-toast").hidden = false;
  saveToastTimer = setTimeout(() => { el("save-toast").hidden = true; }, 5000);
}

function closeSchoolEditor() {
  if (editing?.busy) return;
  if (editing?.original && !editing.saved) {
    const values = editorValues();
    const activity = outreachValues();
    if (editing.pending || (editing.mode === "activity" ? activity.outcome || activity.summary : editFields.some((key) => values[key] !== String(editing.original[key] ?? "")))) {
      editDrafts.set(editorDraftKey(editing), { values, activity, pending: editing.pending, original: editing.original });
    } else editDrafts.delete(editorDraftKey(editing));
  }
  editorSeq++; editorRead?.abort(); editing = null;
  el("school-editor").close();
}

async function openSchoolEditor(id, reload = false, mode = "details") {
  if (!credential) return;
  const retainedActivity = reload && mode === "activity" && editing?.id === id ? outreachValues() : null;
  const session = sessionVersion, seq = ++editorSeq;
  editorRead?.abort(); editorRead = new AbortController();
  editing = { id, mode, original: null, pending: null, busy: false };
  el("editor-kind").textContent = mode === "activity" ? "LOG OUTREACH" : "SCHOOL DETAILS";
  el("outreach-fields").hidden = mode !== "activity";
  for (const field of detailOnlyFields) el(`field-${field}`).hidden = mode === "activity";
  for (const field of outreachFields) {
    el(`log-${field}`).value = field === "channel" ? "Email" : field === "activityType" ? "Outreach" : "";
    el(`log-${field}`).required = mode === "activity" && ["outcome", "summary"].includes(field);
  }
  el("editor-title").textContent = "Loading school…"; el("editor-meta").textContent = "";
  editorFeedback("Loading saved information…");
  el("editor-save").disabled = true; el("editor-save").textContent = editorSaveLabel(editing);
  el("editor-reload").textContent = mode === "activity" ? "Reload school values" : "Reload saved values";
  el("editor-close").disabled = false; el("editor-reload").disabled = true;
  for (const field of editFields) el(`edit-${field}`).value = "";
  editorInputs(true);
  if (!el("school-editor").open) el("school-editor").showModal();
  try {
    const response = await apiFetch(`./api/schools/detail?recordId=${encodeURIComponent(id)}`, {
      headers: { Authorization: `Bearer ${credential}` }, credentials: "omit", cache: "no-store", signal: editorRead.signal,
    });
    const data = await response.json();
    if (session !== sessionVersion || seq !== editorSeq || !credential) return;
    if (response.status === 401 || (response.status === 403 && data.code !== "NOT_OWNER")) {
      forgetSession(); status(messages[data.code] ?? "Your access changed. Please sign in again.");
      el("google-button").hidden = false;
      if (config?.ready) await showGoogleButton();
      return;
    }
    if (!response.ok) throw new Error(data.code === "NOT_OWNER" ? "You can edit only your assigned schools." : "Could not load this school. Close and try again.");
    const draft = reload ? null : editDrafts.get(editorDraftKey(editing));
    editing.original = draft?.original ?? data.record; editing.pending = draft?.pending ?? null;
    for (const field of editFields) el(`edit-${field}`).value = draft?.values[field] ?? String(data.record[field] ?? "");
    if (mode === "activity") {
      const activity = retainedActivity ?? draft?.activity;
      if (activity) for (const field of outreachFields) el(`log-${field}`).value = activity[field];
      if (!draft && data.record.stage === "Not Contacted") el("edit-stage").value = "Contacted";
    }
    el("editor-title").textContent = data.record.schoolName;
    el("editor-meta").textContent = [data.record.schoolBoard, `Assigned to ${data.record.assignedTo || "you"}`].filter(Boolean).join(" · ");
    const day = new Date().toLocaleDateString("en-CA", { timeZone: "America/Toronto" });
    const coldAllowed = data.record.stage === "Cold" || (!["Interested", "Engaged", "Booked"].includes(data.record.stage) && Number(data.record.followUpCount) >= 2 && data.record.followUpDue && day > data.record.followUpDue);
    const cold = el("edit-stage").querySelector?.('option[value="Cold"]');
    if (cold) cold.disabled = !coldAllowed;
    el("cold-warning").textContent = coldAllowed ? "" : "Cold requires two follow-ups and a past follow-up date. Interested, Engaged and Booked schools stay protected.";
    const staleDraft = draft?.original && draft.original.lastRequestId !== data.record.lastRequestId && !editing.pending;
    editing.stale = !!staleDraft;
    editorFeedback(staleDraft ? "Your draft is kept, but saved information changed. Reload school values and review before saving." : retainedActivity ? "Latest school values loaded. Your outreach text is kept; review stage and follow-up before saving." : draft ? "Your unsaved draft was restored." : "Changes save to the test spreadsheet.", staleDraft ? "error" : "info");
    editorInputs(!!editing.pending);
    el("editor-save").disabled = !!staleDraft; el("editor-save").textContent = editing.pending ? "Retry save" : editorSaveLabel(editing);
    el("editor-reload").disabled = !!editing.pending;
  } catch (error) {
    if (session !== sessionVersion || seq !== editorSeq || error.name === "AbortError") return;
    editorFeedback(error.message, "error");
  }
}

async function saveSchoolEdits(event) {
  event.preventDefault();
  if (!credential || !editing?.original || editing.busy || editing.stale) return;
  const session = sessionVersion, edit = editing;
  if (!edit.pending) {
    const inputs = edit.mode === "activity" ? [...outreachFields.map((field) => el(`log-${field}`)), ...["stage", "followUpDue", "nextAction"].map((field) => el(`edit-${field}`))] : editFields.map((field) => el(`edit-${field}`));
    const invalid = inputs.find((input) => input.validity?.valid === false);
    if (invalid) {
      editorFeedback(invalid.validationMessage || "Please check the highlighted field before saving.", "error");
      invalid.reportValidity?.(); invalid.focus?.();
      return;
    }
  }
  if (!edit.pending) {
    const values = editorValues();
    if (edit.mode === "activity") {
      const activity = outreachValues();
      if (!activity.outcome.trim() || !activity.summary.trim()) { editorFeedback("Add an outcome and a short description before saving.", "error"); return; }
      edit.pending = { recordId: edit.id, expectedRequestId: edit.original.lastRequestId, requestId: crypto.randomUUID(), ...activity,
        followUpDue: values.followUpDue, nextAction: values.nextAction,
        ...(values.stage !== edit.original.stage ? { stage: values.stage } : {}),
      };
    } else {
    const patch = Object.fromEntries(Object.entries(values).filter(([key, value]) => value !== String(edit.original[key] ?? "")));
    if (!Object.keys(patch).length) { closeSchoolEditor(); showSaveToast("No changes to save"); return; }
    edit.pending = { recordId: edit.id, expectedRequestId: edit.original.lastRequestId, requestId: crypto.randomUUID(), patch };
    }
  }
  edit.busy = true; editorInputs(true);
  el("editor-save").disabled = true; el("editor-close").disabled = true; el("editor-reload").disabled = true;
  el("editor-save").textContent = "Saving…";
  editorFeedback("Saving…");
  try {
    const response = await apiFetch(edit.mode === "activity" ? "./api/activities" : "./api/schools/update", {
      method: "POST", headers: { Authorization: `Bearer ${credential}`, "content-type": "application/json" },
      credentials: "omit", cache: "no-store", body: JSON.stringify(edit.pending),
    });
    const data = await response.json();
    if (session !== sessionVersion || editing !== edit || !credential) return;
    if (response.ok) {
      edit.original = { ...edit.original, ...edit.pending.patch, lastRequestId: data.record.lastRequestId };
      edit.pending = null; edit.saved = true; editDrafts.delete(editorDraftKey(edit));
      editorFeedback("Saved to the test spreadsheet.");
      edit.busy = false;
      closeSchoolEditor();
      showSaveToast(edit.mode === "activity" ? "✓ Outreach saved" : "✓ Saved");
      await refresh();
    } else if (response.status === 401 || response.status === 403) {
      forgetSession(); status("Your access changed. Please sign in again.");
      el("google-button").hidden = false;
      if (config?.ready) await showGoogleButton();
      return;
    } else if (response.status === 409 || response.status === 422 || ["SHEETS_REJECTED", "TEST_SHEET_EDIT_ACCESS_REQUIRED"].includes(data.code)) {
      edit.pending = null;
      edit.stale = data.code === "CONFLICT_STALE_VERSION";
      editorFeedback(data.code === "CONFLICT_STALE_VERSION"
        ? "Someone changed this school. Your draft is kept. Reload school values and review before saving."
        : data.code === "COLD_RULE_VIOLATION" ? "This school cannot be marked Cold yet. Check the follow-up rule below."
        : data.code === "OUTREACH_DETAILS_REQUIRED" ? "Add an outcome and a short description before saving."
        : data.message || "The spreadsheet rejected this change. Your draft is kept.", "error");
    } else {
      editorFeedback("Save status is uncertain. Use Retry save to check safely; your draft is kept.", "error");
    }
  } catch {
    if (session === sessionVersion && editing === edit) editorFeedback("Connection interrupted. Use Retry save; your draft is kept.", "error");
  } finally {
    edit.busy = false;
    if (session === sessionVersion && editing === edit) {
      editorInputs(!!edit.pending);
      el("editor-save").disabled = !!edit.stale; el("editor-save").textContent = edit.pending ? "Retry save" : editorSaveLabel(edit);
      el("editor-close").disabled = false; el("editor-reload").disabled = !!edit.pending;
    }
  }
}

function updateWorkspaceHeading() {
  if (el("tab-home")) el("tab-home").textContent = isSupervisor ? "H4 Overview" : "My Outreach";
  el("tab-my-schools").textContent = isSupervisor ? "Schools" : "My Schools";
  el("workspace-heading").textContent = currentTab === "home" ? isSupervisor ? "H4 Overview." : "My Outreach." : currentTab === "dashboard" ? "Team Progress." : currentTab === "directory" ? "Find your next school." : isSupervisor ? "School overview." : "Your schools.";
  el("workspace-description").textContent = currentTab === "home" ? isSupervisor ? "A clear view of the program. A little support where it counts." : "Your next step, without the guesswork." : currentTab === "dashboard" ? "Coordinate your outreach. Make every connection count." : currentTab === "directory" ? "Browse available schools and start a new connection." : isSupervisor ? "School assignments across H4." : "Your assigned schools, ready for your next connection.";
}
function switchTab(tab) {
  currentTab = tab;
  rememberView();
  updateWorkspaceHeading();
  el("tab-home")?.classList.toggle("active", tab === "home");
  el("tab-home")?.setAttribute("aria-selected", String(tab === "home"));
  if (el("home-view")) el("home-view").hidden = tab !== "home";
  el("tab-dashboard")?.classList.toggle("active", tab === "dashboard");
  el("tab-dashboard")?.setAttribute("aria-selected", String(tab === "dashboard"));
  if (el("dashboard-view")) el("dashboard-view").hidden = tab !== "dashboard";
  el("tab-my-schools").classList.toggle("active", tab === "my-schools");
  el("tab-my-schools").setAttribute("aria-selected", String(tab === "my-schools"));
  el("tab-directory").classList.toggle("active", tab === "directory");
  el("tab-directory").setAttribute("aria-selected", String(tab === "directory"));
  el("tab-demo-claim").classList.toggle("active", tab === "demo-claim");
  el("tab-demo-claim").setAttribute("aria-selected", String(tab === "demo-claim"));

  el("schools-view").hidden = tab !== "my-schools";
  el("directory-view").hidden = tab !== "directory";
  el("demo-view").hidden = tab !== "demo-claim";

  if (tab === "directory" && directory.length === 0) loadDirectory();
  if (tab === "dashboard" && !dashboardLoaded) loadDashboard();
  // Requirement: Reload synthetic availability when entering the Demo tab (never reuse stale cached state)
  if (tab === "demo-claim") loadDemoSchools();
}

function dashboardNode(tag, text, className = "") {
  const node = document.createElement(tag); node.textContent = text; node.className = className; return node;
}
function dashboardToday(now = new Date()) {
  const parts = new Intl.DateTimeFormat("en-CA", { timeZone: "America/Toronto", year: "numeric", month: "2-digit", day: "2-digit" }).formatToParts(now);
  return ["year", "month", "day"].map((key) => parts.find((part) => part.type === key).value).join("-");
}
function dueState(school, today = dashboardToday()) {
  const due = school.followUpDue;
  // Only unambiguous ISO dates are compared. Preserve other sheet formatting as text.
  if (["Booked", "Cold"].includes(school.stage) || !/^\d{4}-\d{2}-\d{2}$/.test(due)
    || Number.isNaN(Date.parse(due)) || new Date(due).toISOString().slice(0, 10) !== due) return "none";
  return due < today ? "overdue" : due === today ? "today" : "upcoming";
}
function overdueSchool(school, today) { return dueState(school, today) === "overdue"; }
function dashboardOptions(id, allLabel, values) {
  const select = el(id), previous = select.value;
  const all = dashboardNode("option", allLabel); all.value = "";
  select.replaceChildren(all);
  for (const value of values) {
    const option = dashboardNode("option", value === "Not Contacted" ? "Claimed / not contacted" : value);
    option.value = value; select.append(option);
  }
  select.value = values.includes(previous) ? previous : "";
}
function clearDashboardFilters() {
  for (const id of ["dashboard-search", "dashboard-owner", "dashboard-stage"]) el(id).value = "";
  el("dashboard-overdue").checked = false; renderDashboard();
}
function renderPipeline(id, records, onSelect) {
  el(id).replaceChildren();
  const stages = [...pipelineStages, ...(records.some((school) => stageKey(school) === otherStage) ? [otherStage] : [])];
  for (const key of stages) {
    const count = records.filter((school) => stageKey(school) === key).length;
    const label = key === "Not Contacted" ? "Claimed / not contacted" : key;
    const button = dashboardNode("button", "", "pipeline-step"); button.type = "button";
    button.setAttribute("aria-label", `${label}: ${count} ${count === 1 ? "school" : "schools"}`);
    button.append(dashboardNode("span", label), dashboardNode("strong", String(count)));
    button.onclick = () => onSelect(key);
    el(id).append(button);
  }
}
function appendNextAction(card, school) {
  const suggested = school.stage === "Not Contacted" ? "Make your first contact" : school.stage === "Booked" ? "Confirm workshop details" : school.stage === "Cold" ? "No outreach planned" : "Plan your next follow-up";
  card.append(dashboardNode("p", school.nextAction?.trim() ? `Next: ${school.nextAction}` : `Suggested: ${suggested}`, "action-next"));
  const due = dueState(school);
  card.append(dashboardNode("p", school.followUpDue ? `Follow-up: ${school.followUpDue}${due === "overdue" ? " · Overdue" : due === "today" ? " · Today" : ""}` : "No follow-up reminder set", due === "overdue" ? "action-date dashboard-due" : "action-date"));
}
function schoolBadge(stage, label = stage || "Stage not set") {
  const badge = dashboardNode("span", label, "school-stage");
  if (["Interested", "Engaged"].includes(stage)) badge.classList.add("warm");
  if (stage === "Booked") badge.classList.add("booked");
  if (stage === "Cold") badge.classList.add("cold");
  return badge;
}
async function openAction(id, action = "open") {
  const session = sessionVersion;
  await openSchoolEditor(id, false, action === "log" ? "activity" : "details");
  if (session !== sessionVersion || !editing?.original || editing.id !== id || editing.pending) return;
  const focus = action === "reminder" ? "edit-followUpDue" : action === "contact" ? "edit-contactName" : null;
  if (focus) el(focus).focus?.();
}
function actionCard(school, reasons = []) {
  const card = dashboardNode("article", "", "school-card action-card");
  const badge = schoolBadge(school.stage);
  card.append(badge, dashboardNode("h3", school.schoolName));
  if (isSupervisor) card.append(dashboardNode("p", `Assigned to ${assignee(school)}`, "school-meta"));
  if (reasons.length) card.append(dashboardNode("p", reasons.join(" · "), "attention-reasons"));
  appendNextAction(card, school);
  const actions = dashboardNode("div", "", "action-buttons");
  for (const [label, action, className] of [["Log outreach", "log", "button"], ["Open school", "open", "button secondary"], ["Contact info", "contact", "text-button"], ["Set reminder", "reminder", "text-button"]]) {
    const button = dashboardNode("button", label, className); button.type = "button";
    button.setAttribute("aria-label", `${label} for ${school.schoolName}`);
    button.disabled = config?.writesEnabled !== true;
    button.onclick = () => openAction(school.recordId, action); actions.append(button);
  }
  card.append(actions); return card;
}
function renderMetrics(id, entries) {
  el(id).replaceChildren();
  for (const [label, count, onSelect] of entries) {
    const metric = dashboardNode(onSelect ? "button" : "div", "", "dashboard-metric");
    if (onSelect) { metric.type = "button"; metric.onclick = onSelect; metric.setAttribute("aria-label", `${label}: ${count}`); }
    metric.append(dashboardNode("strong", String(count)), dashboardNode("span", label)); el(id).append(metric);
  }
}
function reviewSchools(filter, label, stage = "") {
  schoolScopeFilter = filter;
  schoolScopeLabel = label; schoolStageFilter = stage; el("search").value = "";
  renderSchools(); switchTab("my-schools");
}
function attentionReasons(school, today = dashboardToday()) {
  const reasons = [];
  if (school.assignmentIssue) reasons.push(school.assignmentIssue);
  if (overdueSchool(school, today)) reasons.push("Overdue follow-up");
  if (!["Booked", "Cold"].includes(school.stage)) {
    if (!school.nextAction?.trim()) reasons.push("Next action missing");
    if (["Contacted", "Interested", "Engaged"].includes(school.stage) && dueState(school, today) === "none") reasons.push("Follow-up date needs setting");
  }
  return reasons;
}
function priorityOrder(a, b, today) {
  const rank = (school) => {
    const due = dueState(school, today);
    return due === "overdue" ? 0 : due === "today" ? 1 : school.priority === "High" ? 2 : ["Interested", "Engaged"].includes(school.stage) ? 3 : 4;
  };
  return rank(a) - rank(b) || (a.followUpDue || "9999").localeCompare(b.followUpDue || "9999") || a.schoolName.localeCompare(b.schoolName);
}
function renderHome() {
  if (!el("home-view") || !credential) return;
  const today = dashboardToday(), overdue = (s) => overdueSchool(s, today);
  el("home-view").classList.toggle("student-home", !isSupervisor);
  const warm = (s) => ["Interested", "Engaged"].includes(s.stage), booked = (s) => s.stage === "Booked";
  el("overview-panel").hidden = !isSupervisor;
  el("home-filter-label").hidden = isSupervisor;
  el("home-message").textContent = isSupervisor ? "The program at a glance." : "Your next connection starts here.";
  el("home-description").textContent = isSupervisor ? "Track school progress and see where your team needs support." : "Start with today’s follow-ups, then keep your conversations moving.";
  el("home-actions-title").textContent = isSupervisor ? "Needs your attention" : "What to do next";
  el("home-actions-description").textContent = isSupervisor ? "Overdue follow-ups, assignment issues and missing next steps." : "Follow-ups first, then your highest-priority schools.";
  el("home-schools").textContent = isSupervisor ? "View all schools →" : "View my schools →";
  const choose = (filter) => { el("home-filter").value = filter; homeShowAll = false; renderHome(); };
  if (isSupervisor) {
    const contacted = schools.filter((s) => !!s.lastContacted?.trim());
    renderMetrics("home-metrics", [
      ["Schools claimed", schools.length, () => reviewSchools(null, "")],
      ["Schools contacted", contacted.length, () => reviewSchools((school) => !!school.lastContacted?.trim(), "Recorded last contact")],
      ["Interested / Engaged", schools.filter(warm).length, () => reviewSchools(warm, "Interested / Engaged")],
      ["Schools booked", schools.filter(booked).length, () => reviewSchools(null, "Booked", "Booked")],
      ["Overdue follow-ups", schools.filter(overdue).length, () => reviewSchools(overdueSchool, "Overdue follow-ups")],
    ]);
    renderPipeline("overview-pipeline", schools, (stage) => reviewSchools(null, stage, stage));
    el("overview-students").replaceChildren();
    for (const student of [...overviewStudents].sort((a, b) => a.name.localeCompare(b.name))) {
      const assigned = schools.filter((school) => school.studentId === student.id);
      const row = document.createElement("tr");
      const cell = (label, text = "") => { const td = dashboardNode("td", text); td.setAttribute("data-label", label); row.append(td); return td; };
      cell("Student").append(dashboardNode("strong", student.name), dashboardNode("span", student.active ? "Student co-op" : "Inactive", "dashboard-school-meta"));
      cell("Assigned", String(assigned.length));
      const pipeline = cell("Current pipeline"); pipeline.className = "student-pipeline";
      for (const stage of [...pipelineStages, ...(assigned.some((s) => stageKey(s) === otherStage) ? [otherStage] : [])]) {
        pipeline.append(dashboardNode("span", `${stage === "Not Contacted" ? "Not contacted" : stage}: ${assigned.filter((s) => stageKey(s) === stage).length}`));
      }
      cell("Booked", String(assigned.filter(booked).length)); cell("Overdue", String(assigned.filter(overdue).length));
      const button = dashboardNode("button", "Review schools →", "text-button"); button.type = "button";
      button.setAttribute("aria-label", `Review ${student.name}’s schools`); button.onclick = () => reviewSchools((school) => school.studentId === student.id, student.name);
      cell("Review").append(button); el("overview-students").append(row);
    }
    if (!overviewStudents.length) {
      const row = document.createElement("tr"), cell = dashboardNode("td", "No student accounts are listed yet.");
      cell.setAttribute("colspan", "6"); row.append(cell); el("overview-students").append(row);
    }
  } else {
    const due = schools.filter((s) => ["today", "overdue"].includes(dueState(s, today)));
    renderMetrics("home-metrics", [
      ["My schools", schools.length, () => reviewSchools(null, "")],
      ["Due today / overdue", due.length, () => choose("due")],
      ["Interested / Engaged", schools.filter(warm).length, () => choose("warm")],
      ["My bookings", schools.filter(booked).length, () => choose("booked")],
    ]);
  }
  const filter = el("home-filter").value;
  const actions = schools.filter((school) => isSupervisor ? attentionReasons(school, today).length > 0
    : filter === "due" ? ["today", "overdue"].includes(dueState(school, today)) : filter === "warm" ? warm(school) : filter === "booked" ? booked(school) : !["Booked", "Cold"].includes(school.stage))
    .sort((a, b) => priorityOrder(a, b, today));
  const visible = homeShowAll ? actions : actions.slice(0, 6);
  if (!isSupervisor && actions.length) {
    const due = schools.filter((s) => ["today", "overdue"].includes(dueState(s, today))).length;
    el("home-message").textContent = due ? `${due} follow-up${due === 1 ? " needs" : "s need"} you.` : "Start with this school.";
    const next = actions[0];
    el("home-description").textContent = `${next.schoolName} · ${(next.nextAction?.trim() || (next.stage === "Not Contacted" ? "Make your first contact" : "Plan your next follow-up")).slice(0, 140)}`;
  }
  el("home-actions").replaceChildren(...visible.map((school) => actionCard(school, isSupervisor ? attentionReasons(school, today) : [])));
  el("home-action-count").textContent = actions.length ? `Showing ${visible.length} of ${actions.length} ${isSupervisor ? "schools needing attention" : "schools"}` : "";
  el("home-empty").hidden = actions.length > 0;
  el("home-empty").textContent = isSupervisor ? "No schools need attention right now. Your team is up to date." : !schools.length ? "No schools assigned yet. Choose Find a school to start your outreach." : filter ? "No schools in this group right now. Try another filter." : "No next actions waiting. Check your bookings or find another school.";
  el("home-more").hidden = visible.length === actions.length;
  el("home-more").textContent = `Show all ${actions.length} schools`;
  el("home-content").hidden = false;
  el("home-status").textContent = "Up to date · follow-up dates use Ontario time";
}
function renderDashboard() {
  if (!el("dashboard-view") || !dashboardLoaded) return;
  const today = dashboardToday(), overdue = (school) => overdueSchool(school, today);
  const stage = el("dashboard-stage").value, owner = el("dashboard-owner").value;
  const query = el("dashboard-search").value.trim().toLowerCase();
  const overdueOnly = el("dashboard-overdue").checked;
  const visible = teamSchools.filter((school) => (!stage || stageKey(school) === stage) && (!owner || assignee(school) === owner)
    && (!overdueOnly || overdue(school)) && [school.schoolName, school.schoolBoard, school.geographicRegion].some((text) => (text || "").toLowerCase().includes(query)))
    .sort((a, b) => Number(overdue(b)) - Number(overdue(a)) || a.schoolName.localeCompare(b.schoolName));
  el("dashboard-rows").replaceChildren();
  for (const school of visible) {
    const row = document.createElement("tr");
    const cell = (label) => { const td = document.createElement("td"); td.setAttribute("data-label", label); row.append(td); return td; };
    cell("School").append(dashboardNode("strong", school.schoolName), dashboardNode("span", [school.schoolBoard, school.geographicRegion].filter(Boolean).join(" · "), "dashboard-school-meta"));
    cell("Assigned to").textContent = assignee(school);
    const badge = schoolBadge(school.stage, school.stage === "Not Contacted" ? "Claimed / not contacted" : school.stage || "Stage not set");
    cell("Stage").append(badge);
    cell("Last contact").textContent = school.lastContacted || "Not recorded";
    const due = cell("Follow-up due"); due.textContent = school.followUpDue || "Not scheduled";
    if (overdue(school)) { due.className = "dashboard-due"; due.append(dashboardNode("span", "Overdue", "dashboard-school-meta")); }
    const actions = cell("Actions");
    if (school.canEdit && config?.writesEnabled) {
      const open = dashboardNode("button", "Open school →", "text-button"); open.type = "button";
      open.setAttribute("aria-label", `Open ${school.schoolName}`); open.onclick = () => openSchoolEditor(school.recordId);
      actions.append(open);
    } else actions.textContent = "View only";
    el("dashboard-rows").append(row);
  }
  el("dashboard-count").textContent = `Showing ${visible.length} of ${teamSchools.length} claimed schools`;
  el("dashboard-empty").hidden = visible.length > 0;
}
async function loadDashboard() {
  if (!credential || !el("dashboard-view")) return;
  const session = sessionVersion, seq = ++dashboardSeq;
  dashboardRequest?.abort(); dashboardRequest = new AbortController();
  el("dashboard-refresh").disabled = true;
  el("dashboard-status").textContent = "Loading team progress…";
  try {
    const response = await apiFetch("./api/dashboard", { headers: { Authorization: `Bearer ${credential}` }, cache: "no-store", credentials: "omit", signal: dashboardRequest.signal });
    const data = await response.json();
    if (session !== sessionVersion || seq !== dashboardSeq || !credential) return;
    if (response.status === 401 || response.status === 403) {
      forgetSession(); status(messages[data.code] ?? "Your access was revoked or session expired.");
      if (config?.ready) await showGoogleButton();
      el("google-button").hidden = false; return;
    }
    if (!response.ok || !data.ok || !Array.isArray(data.schools)) throw new Error();
    teamSchools = data.schools; dashboardLoaded = true;
    dashboardOptions("dashboard-owner", "Everyone", [...new Set(teamSchools.map(assignee))].sort());
    dashboardOptions("dashboard-stage", "All stages", [...pipelineStages, ...(teamSchools.some((s) => stageKey(s) === otherStage) ? [otherStage] : [])]);
    renderDashboard(); el("dashboard-content").hidden = false;
    el("dashboard-status").textContent = "Up to date · whole team · dates use Ontario time";
  } catch (error) {
    if (session !== sessionVersion || seq !== dashboardSeq || error.name === "AbortError") return;
    teamSchools = []; dashboardLoaded = false; el("dashboard-content").hidden = true;
    el("dashboard-rows").replaceChildren();
    el("dashboard-status").textContent = "Couldn’t load team progress. Choose Refresh dashboard to try again.";
  } finally {
    if (session === sessionVersion && seq === dashboardSeq) el("dashboard-refresh").disabled = false;
  }
}

function renderDirectory() {
  const query = el("dir-search").value.trim().toLowerCase();
  const visible = directory.filter((school) =>
    [school.schoolName, school.schoolBoard, school.city, school.geographicRegion].some((val) => (val || "").toLowerCase().includes(query)));
  el("dir-count").textContent = String(directory.length);
  el("dir-count-label").textContent = directory.length === 1 ? "school" : "schools";
  el("dir-list").replaceChildren();
  for (const school of visible) {
    const card = document.createElement("article"); card.className = "school-card";
    const badge = document.createElement("span");
    badge.className = school.available ? "badge-available" : "badge-claimed";
    badge.textContent = school.available ? "Available" : "Claimed";
    const heading = document.createElement("h2"); heading.textContent = school.schoolName;
    const meta = document.createElement("p"); meta.className = "school-meta";
    meta.textContent = [school.schoolBoard, school.city, school.geographicRegion].filter(Boolean).join(" · ") || "Location not listed";
    const details = document.createElement("p"); details.className = "assignment";
    details.textContent = [school.schoolLevel, school.gradeRange, school.streetAddress, school.postalCode].filter(Boolean).join(" · ") || "Basic directory listing";
    const note = document.createElement("p"); note.style.fontSize = "10px"; note.style.color = "#8b9487"; note.style.margin = "8px 0 0";
    note.textContent = school.available ? "Available in directory" : "Claimed in CRM (Read-only)";
    card.append(badge, heading, meta, details, note);
    if (school.available) {
      const claimBtn = document.createElement("button");
      claimBtn.className = "button secondary small";
      claimBtn.style.marginTop = "10px";
      claimBtn.textContent = "Claim school";
      claimBtn.type = "button";
      claimBtn.onclick = () => claimDirectorySchool(school.osn, claimBtn);
      card.append(claimBtn);
    }
    el("dir-list").append(card);
  }
  el("dir-empty-state").hidden = visible.length > 0;
}

async function claimDirectorySchool(osn, btn) {
  if (!credential) return;
  const currentSession = sessionVersion;
  btn.disabled = true;
  const feedback = el("dir-feedback");
  if (feedback) {
    feedback.className = "demo-feedback show";
    feedback.textContent = "Submitting claim request…";
  }

  let requestId = pendingClaims.get(osn);
  if (!requestId) {
    requestId = crypto.randomUUID();
    pendingClaims.set(osn, requestId);
  }

  try {
    const response = await apiFetch("./api/schools/claim", {
      method: "POST",
      headers: { "content-type": "application/json", Authorization: `Bearer ${credential}` },
      body: JSON.stringify({ osn, requestId }),
    });
    const data = await response.json();
    if (currentSession !== sessionVersion || !credential) return;

    if (response.ok && data.ok) {
      pendingClaims.delete(osn);
      if (feedback) {
        feedback.className = "demo-feedback show";
        feedback.textContent = data.message || "School claimed successfully.";
      }
      const item = directory.find((s) => s.osn === osn);
      if (item) item.available = false;
      renderDirectory();
      await refresh();
    } else if (["REAL_WRITES_DISABLED", "SHEETS_REJECTED", "TEST_SHEET_EDIT_ACCESS_REQUIRED"].includes(data.code)) {
      pendingClaims.delete(osn);
      if (feedback) {
        feedback.className = "demo-feedback show error";
        feedback.textContent = data.message || (data.code === "REAL_WRITES_DISABLED" ? "Spreadsheet writes are disabled." : "The spreadsheet rejected this save. Nothing was saved; click Claim school to try again.");
      }
      btn.disabled = false;
    } else if (data.code === "SCHOOL_ALREADY_CLAIMED") {
      pendingClaims.delete(osn);
      if (feedback) {
        feedback.className = "demo-feedback show error";
        feedback.textContent = "This school was already claimed.";
      }
      const item = directory.find((s) => s.osn === osn);
      if (item) item.available = false;
      renderDirectory();
    } else if (response.status === 401 || response.status === 403) {
      pendingClaims.delete(osn);
      forgetSession();
      status(messages[data.code] ?? "Your access was revoked or session expired.");
      if (config?.ready) await showGoogleButton();
    } else {
      if (feedback) {
        feedback.className = "demo-feedback show error";
        feedback.textContent = data.message || "Claim could not be processed.";
      }
      btn.disabled = false;
    }
  } catch (err) {
    if (currentSession !== sessionVersion || !credential) return;
    if (feedback) {
      feedback.className = "demo-feedback show error";
      feedback.textContent = "Connection interrupted while submitting claim.";
    }
    btn.disabled = false;
  }
}

async function loadDirectory() {
  if (!credential) return;
  const currentSession = sessionVersion;
  const currentSeq = ++dirSeq;
  activeDirRequest?.abort();
  activeDirRequest = new AbortController();
  el("dir-status").textContent = "Loading school directory…";
  try {
    const response = await apiFetch("./api/directory", {
      headers: { Authorization: `Bearer ${credential}` },
      cache: "no-store", credentials: "omit",
      signal: activeDirRequest.signal,
    });
    const data = await response.json();
    // Recheck session AFTER awaiting response.json()
    if (currentSession !== sessionVersion || currentSeq !== dirSeq || !credential) return;
    if (!response.ok) {
      directory = [];
      el("dir-list").replaceChildren();
      if (response.status === 401 || response.status === 403) {
        forgetSession();
        status(messages[data.code] ?? "Your access was revoked or session expired.");
        if (config?.ready) await showGoogleButton();
        return;
      }
      el("dir-status").textContent = messages[data.code] ?? "Could not load directory.";
      return;
    }
    directory = data.directory || [];
    el("dir-status").textContent = `Up to date · ${directory.length} schools · ${config?.writesEnabled ? "claims enabled" : "read-only browsing"}`;
    renderDirectory();
  } catch (err) {
    if (currentSession !== sessionVersion || currentSeq !== dirSeq || !credential) return;
    if (err?.name === "AbortError") return;
    directory = [];
    el("dir-list").replaceChildren();
    el("dir-status").textContent = "Connection interrupted while loading directory.";
  }
}

async function loadDemoSchools() {
  const currentSession = sessionVersion;
  const currentSeq = ++demoSeq;
  activeDemoRequest?.abort();
  activeDemoRequest = new AbortController();
  try {
    const response = await apiFetch("./api/demo/schools", {
      cache: "no-store", credentials: "omit", signal: activeDemoRequest.signal,
    });
    const data = await response.json();
    // Recheck session AFTER awaiting response.json()
    if (currentSession !== sessionVersion || currentSeq !== demoSeq) return;
    if (!response.ok || !data.ok || !Array.isArray(data.schools)) {
      demoSchools = [];
      el("demo-list").replaceChildren();
      const feedback = el("demo-feedback");
      if (feedback) {
        feedback.className = "demo-feedback show error";
        feedback.textContent = "Availability unavailable";
      }
      return;
    }
    const feedback = el("demo-feedback");
    if (feedback && feedback.textContent === "Availability unavailable") {
      feedback.textContent = ""; feedback.className = "demo-feedback";
    }
    demoSchools = data.schools;
    renderDemoSchools();
  } catch (err) {
    if (currentSession !== sessionVersion || currentSeq !== demoSeq) return;
    if (err?.name === "AbortError") return;
    demoSchools = [];
    el("demo-list").replaceChildren();
    const feedback = el("demo-feedback");
    if (feedback) {
      feedback.className = "demo-feedback show error";
      feedback.textContent = "Availability unavailable";
    }
  }
}

function renderDemoSchools() {
  el("demo-list").replaceChildren();
  for (const school of demoSchools) {
    const card = document.createElement("article"); card.className = "school-card";
    const badge = document.createElement("span");
    badge.className = school.available ? "badge-available" : "badge-claimed";
    badge.textContent = school.available ? "Available (Demo)" : "Claimed (Demo)";
    const heading = document.createElement("h2"); heading.textContent = school.schoolName;
    const meta = document.createElement("p"); meta.className = "school-meta";
    meta.textContent = `${school.schoolBoard} · ${school.city || "Example City"} · OSN ${school.osn}`;
    const claimBtn = document.createElement("button");
    claimBtn.type = "button";
    claimBtn.className = "claim-btn";
    if (school.available) {
      claimBtn.textContent = "Claim (Demo)";
      claimBtn.onclick = () => claimDemoSchool(school.osn, claimBtn);
    } else {
      claimBtn.textContent = "Already Claimed";
      claimBtn.disabled = true;
    }
    card.append(badge, heading, meta, claimBtn);
    el("demo-list").append(card);
  }
}

async function claimDemoSchool(osn, btn) {
  if (!credential) return;
  // Separate session identity: bind to sessionVersion, unaffected by automatic background refresh()
  const currentSession = sessionVersion;
  btn.disabled = true;
  const feedback = el("demo-feedback");
  feedback.className = "demo-feedback show";
  feedback.textContent = "Saving demo claim through SQLite coordinator…";

  // Requirement 5: Preserve the same ID when retrying an uncertain claim.
  let requestId = pendingClaims.get(osn);
  if (!requestId) {
    requestId = crypto.randomUUID();
    pendingClaims.set(osn, requestId);
  }

  try {
    const response = await apiFetch("./api/demo/claim", {
      method: "POST",
      headers: { "content-type": "application/json", Authorization: `Bearer ${credential}` },
      body: JSON.stringify({ osn, requestId }),
    });
    const data = await response.json();
    // Recheck session AFTER awaiting response.json() before updating state or DOM
    if (currentSession !== sessionVersion || !credential) return;
    if (response.ok && data.demo) {
      pendingClaims.delete(osn);
      feedback.className = "demo-feedback show";
      feedback.textContent = "Demo claim saved — test data only";
      const item = demoSchools.find((s) => s.osn === osn);
      if (item) item.available = false;
      renderDemoSchools();
    } else if (data.code === "SCHOOL_ALREADY_CLAIMED") {
      pendingClaims.delete(osn);
      feedback.className = "demo-feedback show error";
      feedback.textContent = "This school was already claimed in the demo.";
      const item = demoSchools.find((s) => s.osn === osn);
      if (item) item.available = false;
      renderDemoSchools();
    } else if (response.status === 401 || response.status === 403) {
      pendingClaims.delete(osn);
      forgetSession();
      status(messages[data.code] ?? "Your access was revoked or session expired.");
      if (config?.ready) await showGoogleButton();
    } else if (response.status === 422) {
      pendingClaims.delete(osn);
      feedback.className = "demo-feedback show error";
      feedback.textContent = data.message || "Invalid claim request.";
      btn.disabled = false;
    } else {
      feedback.className = "demo-feedback show error";
      feedback.textContent = (data.message || "Claim could not be saved.") + " Click Retry to safely reconcile.";
      btn.disabled = false;
      btn.textContent = "Retry Claim (Demo)";
    }
  } catch (err) {
    if (currentSession !== sessionVersion || !credential) return;
    if (err?.name === "AbortError") return;
    feedback.className = "demo-feedback show error";
    feedback.textContent = "Connection interrupted while saving demo claim. Click Retry to safely reconcile.";
    btn.disabled = false;
    btn.textContent = "Retry Claim (Demo)";
  }
}

const messages = {
  USER_NOT_ALLOWED: "This account doesn’t have access. Ask your H4 supervisor to check your CRM access.",
  EMAIL_PROVIDER_NOT_SUPPORTED: "Use an approved Gmail or Google Workspace account to sign in.",
  INVALID_GOOGLE_TOKEN: "Your sign-in couldn’t be verified. Please sign in again.",
  SIGN_IN_REQUIRED: "Please sign in again to see your schools.",
  GOOGLE_SETUP_REQUIRED: "Google sign-in is not connected yet. Your supervisor can finish the setup.",
  TEST_SHEET_ACCESS_REQUIRED: "The test spreadsheet isn’t available to the app yet. Please contact your supervisor.",
  SCHEMA_MISMATCH: "The spreadsheet layout needs to be checked before schools can be shown.",
  GOOGLE_READ_LIMIT_REACHED: "The connection is busy. Please wait a moment and try again.",
};

async function refresh() {
  if (!credential) return;
  const currentSession = sessionVersion;
  const currentSeq = ++refreshSeq;
  activeRequest?.abort(); activeRequest = new AbortController();
  const controller = activeRequest;
  let timedOut = false;
  const timeout = setTimeout(() => { timedOut = true; controller.abort(); }, 15000);
  el("refresh").disabled = true; el("retry").disabled = true;
  status("Checking your access and loading schools…"); el("workspace-status").textContent = "Refreshing your schools…";
  if (el("home-status")) el("home-status").textContent = "Refreshing your outreach…";
  if (el("home-refresh")) el("home-refresh").disabled = true;
  try {
    const response = await apiFetch("./api/bootstrap", {
      method: "GET", headers: { Authorization: `Bearer ${credential}` },
      credentials: "omit", cache: "no-store", signal: controller.signal,
    });
    const data = response.ok ? await response.json() : await response.json().catch(() => ({}));
    // Recheck session AFTER awaiting response.json()
    if (currentSession !== sessionVersion || currentSeq !== refreshSeq || !credential) return;
    if (!response.ok) {
      const message = messages[data.code] ?? "We couldn’t load your schools. Please try again.";
      if (response.status === 401 || response.status === 403) {
        // Actual expiry/revocation must clear protected records and drafts.
        forgetSession(); status(message); el("retry").hidden = false;
        el("google-button").hidden = false;
        if (config?.ready) await showGoogleButton();
      } else refreshFailed(message);
      return;
    }
    const firstLoad = el("workspace").hidden;
    const nextSupervisor = data.currentUser.role === "Supervisor";
    if (isSupervisor !== nextSupervisor) {
      schoolScopeFilter = null; schoolStageFilter = ""; schoolScopeLabel = "";
      dashboardRequest?.abort(); dashboardSeq++; teamSchools = [];
    }
    schools = data.schools;
    overviewStudents = nextSupervisor ? data.overview?.students ?? [] : [];
    if (!nextSupervisor && el("home-view")) {
      el("overview-students").replaceChildren(); el("overview-pipeline").replaceChildren();
    }
    dashboardLoaded = false;
    el("user-name").textContent = data.currentUser.name;
    el("user-email").textContent = data.currentUser.email;
    el("user-role").textContent = data.currentUser.role === "Supervisor" ? "Supervisor" : "Student co-op";
    el("avatar").textContent = data.currentUser.name.slice(0, 1).toUpperCase();
    isSupervisor = nextSupervisor;
    if (firstLoad && el("home-view")) currentTab = resumeView || "home";
    resumeView = null;
    switchTab(currentTab);
    el("workspace-status").textContent = config?.writesEnabled ? "Up to date" : "Up to date · viewing only";
    renderSchools(); renderHome(); el("welcome").hidden = true; el("workspace").hidden = false;
    if (el("session-restore")) el("session-restore").hidden = true;
    rememberSession(credential);
    rememberView();
    el("retry").hidden = true;
    clearTimeout(expiryTimer);
    expiryTimer = setTimeout(() => {
      forgetSession(); status("Your sign-in has expired. Sign in again to continue.");
      el("google-button").hidden = false;
      showGoogleButton().catch(() => { el("retry").hidden = false; });
    }, Math.max(0, data.sessionExpiresAt * 1000 - Date.now()));
  } catch (error) {
    if (currentSession !== sessionVersion || currentSeq !== refreshSeq || (error.name === "AbortError" && !timedOut)) return;
    refreshFailed(timedOut ? "The refresh timed out." : "The connection was interrupted.");
  } finally {
    clearTimeout(timeout);
    if (currentSession === sessionVersion && currentSeq === refreshSeq) {
      el("refresh").disabled = false; el("retry").disabled = false;
      if (el("home-refresh")) el("home-refresh").disabled = false;
    }
  }
}

async function initialize() {
  el("retry").hidden = true; el("google-button").hidden = true;
  const existingSession = savedSession();
  resumeView = savedView();
  if (existingSession) {
    credential = existingSession;
    if (el("session-restore")) { el("session-restore").hidden = false; el("welcome").hidden = true; }
  } else {
    if (el("session-restore")) el("session-restore").hidden = true;
    el("welcome").hidden = false;
  }
  if (browserOffline()) {
    finishRestore("You’re not connected. Reconnect, then try again.");
    el("google-button").hidden = true;
    setConnection(false); status("You’re not connected. Reconnect, then try again."); el("retry").hidden = false;
    return;
  }
  let loadingGoogle = false;
  try {
    const response = await apiFetch("./api/config", { cache: "no-store", credentials: "omit" });
    if (!response.ok) throw new Error();
    config = await response.json();
    el("tab-demo-claim").hidden = config.demoAvailable === false;
    if (!config.ready) {
      finishRestore("Google sign-in hasn’t been connected yet.");
      status("Google sign-in hasn’t been connected yet. This preview is ready for your supervisor to finish setup.");
      return;
    }
    if (credential) {
      await refresh();
    } else {
      loadingGoogle = true;
      await showGoogleButton();
      el("google-button").hidden = false;
      const expiredNotice = sessionWasExpired;
      sessionWasExpired = false;
      status(expiredNotice ? "Your session expired. Please sign in again." : "Only accounts approved by H4 can view schools.");
    }
  } catch {
    finishRestore(credential ? "We couldn’t restore your workspace. Please try again." : "We couldn’t reach the app. Please try again.");
    status(browserOffline() ? "You’re not connected. Reconnect, then try again."
      : loadingGoogle ? "Google sign-in couldn’t load. Please try again."
      : "We couldn’t reach the app. Please try again.");
    el("retry").hidden = false;
  }
}

el("sign-out").addEventListener("click", () => {
  forgetSession(); window.google?.accounts?.id.disableAutoSelect();
  status("You’re signed out."); el("google-button").hidden = false;
  showGoogleButton().catch(() => { el("retry").hidden = false; });
});
el("restore-sign-in")?.addEventListener("click", () => {
  forgetSession();
  finishRestore("Continue with Google to return to your workspace.");
  if (config?.ready) showGoogleButton().catch(() => {});
});
el("editor-form").addEventListener("submit", saveSchoolEdits);
el("editor-close").addEventListener("click", closeSchoolEditor);
el("editor-reload").addEventListener("click", () => { if (editing) openSchoolEditor(editing.id, true, editing.mode); });
el("school-editor").addEventListener("cancel", (event) => { event.preventDefault(); closeSchoolEditor(); });
el("refresh").addEventListener("click", refresh);
el("tab-home")?.addEventListener("click", () => switchTab("home"));
el("home-refresh")?.addEventListener("click", refresh);
el("home-find")?.addEventListener("click", () => switchTab("directory"));
el("home-schools")?.addEventListener("click", () => reviewSchools(null, ""));
el("home-filter")?.addEventListener("change", () => { homeShowAll = false; renderHome(); });
el("home-more")?.addEventListener("click", () => { homeShowAll = true; renderHome(); });
el("schools-scope-clear")?.addEventListener("click", () => reviewSchools(null, ""));
el("retry").addEventListener("click", () => credential ? refresh() : initialize());
el("search").addEventListener("input", renderSchools);
el("tab-my-schools").addEventListener("click", () => switchTab("my-schools"));
el("tab-dashboard")?.addEventListener("click", () => switchTab("dashboard"));
el("dashboard-refresh")?.addEventListener("click", loadDashboard);
el("dashboard-clear")?.addEventListener("click", clearDashboardFilters);
el("dashboard-search")?.addEventListener("input", renderDashboard);
for (const id of ["dashboard-owner", "dashboard-stage", "dashboard-overdue"]) el(id)?.addEventListener("change", renderDashboard);
el("tab-directory").addEventListener("click", () => switchTab("directory"));
el("tab-demo-claim").addEventListener("click", () => switchTab("demo-claim"));
el("dir-search").addEventListener("input", renderDirectory);
el("dir-refresh").addEventListener("click", loadDirectory);
async function reconnect() {
  const connected = await checkConnection();
  if (connected && !credential && el("google-button").hidden && !el("retry").hidden) await initialize();
}
window.addEventListener("offline", () => {
  connectionAttempt++; setConnection(false);
  if (!credential) {
    status("You’re not connected. Reconnect, then try again.");
    el("google-button").hidden = true; el("retry").hidden = false;
  }
});
window.addEventListener("online", reconnect);
setInterval(() => {
  if (document.visibilityState !== "visible") return;
  if (browserOffline()) { setConnection(false); return; }
  if (credential) refresh(); else reconnect();
}, 60000);
document.addEventListener("visibilitychange", () => {
  if (document.visibilityState === "visible") {
    if (credential && !browserOffline()) refresh(); else reconnect();
  }
});
window.addEventListener("pageshow", (event) => { if (event.persisted && credential && !browserOffline()) refresh(); });
initialize();

