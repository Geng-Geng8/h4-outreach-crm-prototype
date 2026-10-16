const el = (id) => document.getElementById(id);
// Pages supplies a public API origin; the local preview stays on the same origin.
const apiOrigin = document.querySelector?.('meta[name="h4-api-origin"]')?.content?.trim().replace(/\/$/, "") ?? "";
function apiFetch(path, options) {
  return fetch(apiOrigin ? `${apiOrigin}/${path.replace(/^\.\//, "")}` : path, options);
}
let credential = "", schools = [], directory = [], demoSchools = [], config, nonce = "";
let sessionVersion = 0, refreshSeq = 0, dirSeq = 0, demoSeq = 0;
let activeRequest, activeDirRequest, activeDemoRequest, expiryTimer;
let googleLoading, currentTab = "my-schools";
const pendingClaims = new Map(); // osn -> requestId
const editFields = ["contactName", "contactRole", "email", "phone", "stage", "priority", "outreachGoal", "followUpDue", "nextAction", "notes"];
const outreachFields = ["channel", "activityType", "outcome", "summary"];
const detailOnlyFields = ["contactName", "contactRole", "email", "phone", "priority", "outreachGoal", "notes"];
let editing = null, editorSeq = 0, editorRead;
let saveToastTimer;
const editDrafts = new Map();

function status(message) { el("login-status").textContent = message; }
function forgetSession() {
  sessionVersion++;
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
  clearTimeout(expiryTimer);
  credential = ""; schools = []; directory = []; demoSchools = [];
  pendingClaims.clear();
  el("school-list").replaceChildren(); el("search").value = "";
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
  google.initialize({ client_id: config.googleClientId, nonce, auto_select: false, callback: onGoogleSignIn });
  el("google-button").replaceChildren();
  google.renderButton(el("google-button"), { theme: "outline", size: "large", shape: "pill", text: "continue_with", width: 280 });
}

async function onGoogleSignIn(response) {
  // Bind the callback to the current page interaction. Signature and every identity
  // claim are verified on the server before any school data is returned.
  try {
    if (typeof response.credential !== "string") throw new Error();
    const encoded = response.credential.split(".")[1].replace(/-/g, "+").replace(/_/g, "/");
    const payload = JSON.parse(atob(encoded));
    if (!nonce || payload.nonce !== nonce) throw new Error();
    forgetSession(); credential = response.credential;
    el("google-button").hidden = true;
    await refresh();
  } catch {
    forgetSession(); status("We couldn’t confirm that sign-in. Please try again.");
    el("google-button").hidden = false; el("retry").hidden = false;
  }
}

function renderSchools() {
  const query = el("search").value.trim().toLowerCase();
  const visible = schools.filter((school) =>
    [school.schoolName, school.schoolBoard, school.geographicRegion].some((value) => value.toLowerCase().includes(query)));
  el("school-count").textContent = String(schools.length);
  el("school-count-label").textContent = schools.length === 1 ? "school" : "schools";
  el("school-list").replaceChildren();
  for (const school of visible) {
    const container = document.createElement("article"); container.className = "school-card";
    const card = document.createElement("button"); card.className = "school-open"; card.type = "button";
    card.setAttribute("aria-label", `Edit ${school.schoolName}`);
    card.onclick = () => openSchoolEditor(school.recordId);
    const stage = document.createElement("span"); stage.className = "school-stage"; stage.textContent = school.stage || "Stage not set";
    if (["Interested", "Engaged"].includes(school.stage)) stage.classList.add("warm");
    if (school.stage === "Booked") stage.classList.add("booked");
    if (school.stage === "Cold") stage.classList.add("cold");
    const priority = document.createElement("span"); priority.className = "school-priority"; priority.textContent = school.priority ? `${school.priority} priority` : "";
    const heading = document.createElement("h2"); heading.textContent = school.schoolName;
    const meta = document.createElement("p"); meta.className = "school-meta"; meta.textContent = [school.schoolBoard, school.geographicRegion].filter(Boolean).join(" · ") || "Location not listed";
    const assignment = document.createElement("p"); assignment.className = "assignment"; assignment.textContent = school.assignedTo ? `Assigned to ${school.assignedTo}` : "Unassigned";
    const editHint = document.createElement("span"); editHint.className = "edit-hint"; editHint.textContent = "Edit school →";
    const log = document.createElement("button"); log.className = "button school-log"; log.type = "button";
    log.textContent = "Log outreach"; log.setAttribute("aria-label", `Log outreach for ${school.schoolName}`);
    log.onclick = () => openSchoolEditor(school.recordId, false, "activity");
    log.disabled = config?.writesEnabled !== true;
    card.append(stage, priority, heading, meta, assignment, editHint); container.append(card, log); el("school-list").append(container);
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

function switchTab(tab) {
  currentTab = tab;
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
  // Requirement: Reload synthetic availability when entering the Demo tab (never reuse stale cached state)
  if (tab === "demo-claim") loadDemoSchools();
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
  el("refresh").disabled = true; el("retry").disabled = true;
  status("Checking your access and loading schools…"); el("workspace-status").textContent = "Refreshing your schools…";
  try {
    const response = await apiFetch("./api/bootstrap", {
      method: "GET", headers: { Authorization: `Bearer ${credential}` },
      credentials: "omit", cache: "no-store", signal: activeRequest.signal,
    });
    const data = await response.json();
    // Recheck session AFTER awaiting response.json()
    if (currentSession !== sessionVersion || currentSeq !== refreshSeq || !credential) return;
    if (!response.ok) {
      const message = messages[data.code] ?? "We couldn’t load your schools. Please try again.";
      // Remove all previously shown school data on any error, including revocation.
      forgetSession(); status(message); el("retry").hidden = false;
      el("google-button").hidden = false;
      if (config?.ready) await showGoogleButton();
      return;
    }
    schools = data.schools;
    el("user-name").textContent = data.currentUser.name;
    el("user-email").textContent = data.currentUser.email;
    el("user-role").textContent = data.currentUser.role === "Supervisor" ? "Supervisor" : "Student co-op";
    el("avatar").textContent = data.currentUser.name.slice(0, 1).toUpperCase();
    const supervisor = data.currentUser.role === "Supervisor";
    el("workspace-heading").textContent = supervisor ? "School overview." : "Your schools.";
    el("workspace-description").textContent = supervisor ? "School assignments across H4." : "Your assigned schools, ready for your next connection.";
    el("workspace-status").textContent = config?.writesEnabled ? "Up to date" : "Up to date · viewing only";
    renderSchools(); el("welcome").hidden = true; el("workspace").hidden = false;
    el("retry").hidden = true;
    clearTimeout(expiryTimer);
    expiryTimer = setTimeout(() => {
      forgetSession(); status("Your sign-in has expired. Sign in again to continue.");
      el("google-button").hidden = false;
      showGoogleButton().catch(() => { el("retry").hidden = false; });
    }, Math.max(0, data.sessionExpiresAt * 1000 - Date.now()));
  } catch (error) {
    if (currentSession !== sessionVersion || currentSeq !== refreshSeq || error.name === "AbortError") return;
    forgetSession(); status("The connection was interrupted. Sign in again when you’re online.");
    el("google-button").hidden = false; el("retry").hidden = false;
  } finally {
    el("refresh").disabled = false; el("retry").disabled = false;
  }
}

async function initialize() {
  el("retry").hidden = true; el("google-button").hidden = true;
  try {
    const response = await apiFetch("./api/config", { cache: "no-store", credentials: "omit" });
    if (!response.ok) throw new Error();
    config = await response.json();
    el("tab-demo-claim").hidden = config.demoAvailable === false;
    if (!config.ready) {
      status("Google sign-in hasn’t been connected yet. This preview is ready for your supervisor to finish setup.");
      return;
    }
    await showGoogleButton(); el("google-button").hidden = false;
    status("Only accounts approved by H4 can view schools.");
  } catch {
    status("We couldn’t connect to sign-in. Check your connection and try again.");
    el("retry").hidden = false;
  }
}

el("sign-out").addEventListener("click", () => {
  forgetSession(); window.google?.accounts?.id.disableAutoSelect();
  status("You’re signed out."); el("google-button").hidden = false;
  showGoogleButton().catch(() => { el("retry").hidden = false; });
});
el("editor-form").addEventListener("submit", saveSchoolEdits);
el("editor-close").addEventListener("click", closeSchoolEditor);
el("editor-reload").addEventListener("click", () => { if (editing) openSchoolEditor(editing.id, true, editing.mode); });
el("school-editor").addEventListener("cancel", (event) => { event.preventDefault(); closeSchoolEditor(); });
el("refresh").addEventListener("click", refresh);
el("retry").addEventListener("click", initialize);
el("search").addEventListener("input", renderSchools);
el("tab-my-schools").addEventListener("click", () => switchTab("my-schools"));
el("tab-directory").addEventListener("click", () => switchTab("directory"));
el("tab-demo-claim").addEventListener("click", () => switchTab("demo-claim"));
el("dir-search").addEventListener("input", renderDirectory);
el("dir-refresh").addEventListener("click", loadDirectory);
setInterval(() => { if (credential && document.visibilityState === "visible") refresh(); }, 60000);
document.addEventListener("visibilitychange", () => {
  if (credential && document.visibilityState === "visible") refresh();
});
window.addEventListener("pageshow", (event) => { if (event.persisted && credential) refresh(); });
initialize();

