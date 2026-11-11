const el = (id) => {
  const node = document.getElementById(id);
  if (!node && id === "edit-outreachGoal") return document.getElementById("edit-goal");
  if (!node && id === "edit-goal") return document.getElementById("edit-outreachGoal");
  if (!node && id === "field-goal") return document.getElementById("field-outreachGoal");
  if (!node && id === "field-outreachGoal") return document.getElementById("field-goal");
  if (!node && id === "edit-follow-up-date") return document.getElementById("edit-followUpDue");
  if (!node && id === "edit-followUpDue") return document.getElementById("edit-follow-up-date");
  return node;
};
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
let googleLoading, currentTab = "my-schools", isSupervisor = false, currentUser = null;
const pendingClaims = new Map(); // osn -> requestId
let teamSchools = [], dashboardLoaded = false, dashboardSeq = 0, dashboardRequest;
let overviewStudents = [], schoolScopeFilter = null, schoolStageFilter = "", schoolScopeLabel = "", homeShowAll = false;
let supervisorSchoolScope = "mine";
let programsScope = "mine", selectedProgram = "", programStatusFilter = "all";
var state = {
  get programStatusFilter() { return programStatusFilter; },
  set programStatusFilter(val) { programStatusFilter = String(val || "all").trim() || "all"; },
};
const STAGE_CONFIG = {
  "Not Contacted": {
    display: "Cold",
    dropdownLabel: "Cold (Not Contacted) — Haven't reached out yet",
    helperText: "No one has contacted this school yet. Ready for a first intro email or phone call.",
    badgeClass: "stage-cold",
  },
  Contacted: {
    display: "Waiting on Reply",
    dropdownLabel: "Waiting on Reply (Contacted) — Sent email or left voicemail",
    helperText: "We reached out by email or phone and are waiting to hear back from the school.",
    badgeClass: "stage-waiting",
  },
  Engaged: {
    display: "On the Fence",
    dropdownLabel: "On the Fence (Engaged) — Teacher replied / talking details",
    helperText: "The teacher or principal replied! We are discussing dates, pricing, or program details.",
    badgeClass: "stage-fence",
  },
  Booked: {
    display: "Confirmed",
    dropdownLabel: "Confirmed (Booked) — Definite YES / locked in",
    helperText: "Awesome! Only choose this when the school gave a clear YES to participate.",
    badgeClass: "stage-confirmed",
  },
  Completed: {
    display: "Completed",
    dropdownLabel: "Completed — Workshop or program delivered",
    helperText: "The workshop, certification, or event has already been delivered.",
    badgeClass: "stage-completed",
  },
};
const LEGACY_STAGE_FALLBACKS = {
  Interested: {
    display: "On the Fence",
    dropdownLabel: "On the Fence (Interested) — Teacher replied / talking details",
    helperText: STAGE_CONFIG.Engaged.helperText,
    badgeClass: "stage-fence",
  },
  Cold: {
    display: "Cold",
    dropdownLabel: "Cold (Archived / Declined)",
    helperText: "This school declined or was archived after multiple unanswered follow-ups.",
    badgeClass: "stage-cold",
  },
};
function getStageMeta(stage) {
  const key = String(stage || "").trim();
  if (STAGE_CONFIG[key]) return STAGE_CONFIG[key];
  if (LEGACY_STAGE_FALLBACKS[key]) return LEGACY_STAGE_FALLBACKS[key];
  if (!key) return STAGE_CONFIG["Not Contacted"];
  return {
    display: key,
    dropdownLabel: key,
    helperText: "School's current outreach stage.",
    badgeClass: "stage-cold",
  };
}
function ensureStageDropdownPopulated() {
  const stageSelect = el("edit-stage");
  if (!stageSelect) return;
  const currentValue = stageSelect.value;
  const optionSpecs = [
    ...Object.entries(STAGE_CONFIG).map(([value, meta]) => ({ value, label: meta.dropdownLabel })),
    { value: "Interested", label: LEGACY_STAGE_FALLBACKS.Interested.dropdownLabel },
    { value: "Cold", label: LEGACY_STAGE_FALLBACKS.Cold.dropdownLabel },
  ];
  const existingOptions = stageSelect.options
    ? Array.from(stageSelect.options)
    : (stageSelect.children ? Array.from(stageSelect.children) : []);
  if (existingOptions.length === 0) {
    for (const spec of optionSpecs) {
      const opt = document.createElement("option");
      opt.value = spec.value;
      opt.textContent = spec.label;
      stageSelect.append(opt);
    }
    if (currentValue) stageSelect.value = currentValue;
  } else {
    for (const spec of optionSpecs) {
      const match = existingOptions.find((o) => (o.value || o.textContent) === spec.value);
      if (match) {
        match.value = spec.value;
        match.textContent = spec.label;
      }
    }
  }
}
function updateStageHelperText(stageVal) {
  ensureStageDropdownPopulated();
  const helper = el("stage-helper-text");
  if (!helper) return;
  const resolvedStage = stageVal !== undefined ? stageVal : (el("edit-stage")?.value || "Not Contacted");
  helper.textContent = getStageMeta(resolvedStage).helperText;
}
if (typeof window !== "undefined") {
  window.STAGE_CONFIG = STAGE_CONFIG;
  window.state = state;
  window.updateStageHelperText = updateStageHelperText;
}
const FLAGSHIP_PROGRAMS = [
  "Cypher Program",
  "Competitive Arts",
  "B Thee Rise",
  "SHSM",
];
const SECONDARY_PROGRAMS = [
  "Board Partnership",
  "Dance Workshops",
  "Co-op Workshops",
  "Volunteer Workshops",
  "After-School Program",
  "Keynotes",
  "Leadership Programs",
  "Filipino Projects",
  "Misc",
];
const pipelineStages = ["Not Contacted", "Contacted", "Interested", "Engaged", "Booked", "Completed", "Cold"];
const otherStage = "Other / not set";
const stageKey = (school) => pipelineStages.includes(school.stage) ? school.stage : otherStage;
const assignee = (school) => school.assignedTo?.trim() || "Unassigned";

function isAssignedToMe(school) {
  if (!school) return false;
  const userEmail = (currentUser?.email || (credential ? parseJwtPayload(credential)?.email : "") || "").trim().toLowerCase();
  const userName = (currentUser?.name || "").trim().toLowerCase();

  if (school.ownerEmail) {
    const emails = school.ownerEmail
      .toLowerCase()
      .split(",")
      .map((e) => e.trim());
    return Boolean(userEmail && emails.includes(userEmail));
  }

  if (school.assignedTo) {
    const assignees = school.assignedTo
      .toLowerCase()
      .split(",")
      .map((e) => e.trim());
    return Boolean(
      (userName && assignees.some((a) => a === userName || userName.startsWith(a + " ") || a.startsWith(userName + " "))) ||
      (userEmail && assignees.includes(userEmail))
    );
  }

  if (school.isMySchool !== undefined) return Boolean(school.isMySchool);
  return !isSupervisor;
}
const editFields = ["contactName", "contactRole", "email", "phone", "stage", "priority", "outreachGoal", "followUpDue", "nextAction", "notes", "coldReason"];
const outreachFields = ["channel", "activityType", "outcome", "summary"];
const EXPLICIT_REJECTION_REASONS = [
  "Not Interested",
  "Explicit Rejection / Not Interested",
  "No Budget / Funding",
  "Timing / Scheduling Conflict",
  "Outside Program Scope / Ineligible",
  "Other (Declined)",
];
const DEFAULT_DECLINE_REASON = "Explicit Rejection / Not Interested";
const UNRESPONSIVE_COLD_REASON = "Unresponsive (2+ follow-ups completed with no reply)";
const detailOnlyFields = ["contactName", "contactRole", "email", "phone", "priority", "outreachGoal", "notes"];
const PROGRAM_TAGS = [
  "Board Partnership",
  "SHSM",
  "Dance Workshops",
  "Co-op Workshops",
  "Volunteer Workshops",
  "After-School Program",
  "Keynotes",
  "Leadership Programs",
  "B Thee Rise",
  "Cypher Program",
  "Competitive Arts",
  "Filipino Projects",
  "Misc",
];
if (typeof window !== "undefined") {
  window.PROGRAM_TAGS = PROGRAM_TAGS;
}

function parseProgramTracks(rawGoal) {
  if (typeof rawGoal !== "string") return [];
  const parts = rawGoal
    .split(",")
    .map((p) => p.trim())
    .filter(Boolean);
  const tracks = [];
  for (const part of parts) {
    let name = part;
    let status = "Active";
    const completedMatch = part.match(/^(.*?)\s*\(Completed(?:\s*✓)?\)$/i);
    const activeMatch = part.match(/^(.*?)\s*\(Active\)$/i);
    if (completedMatch) {
      name = completedMatch[1].trim();
      status = "Completed";
    } else if (activeMatch) {
      name = activeMatch[1].trim();
      status = "Active";
    }
    if (!name) continue;
    const existing = tracks.find((t) => t.name.toLowerCase() === name.toLowerCase());
    if (existing) {
      existing.name = name;
      existing.status = status;
      existing.completed = status === "Completed";
    } else {
      tracks.push({ name, status, completed: status === "Completed" });
    }
  }
  return tracks;
}

function serializeProgramTracks(tracks) {
  return (tracks || [])
    .filter((t) => t && t.name && String(t.name).trim())
    .map((t) => {
      const cleanName = String(t.name).trim();
      return t.status === "Completed" ? `${cleanName} (Completed)` : cleanName;
    })
    .join(", ");
}

function createProgramBadges(schoolOrGoal) {
  const rawGoal = typeof schoolOrGoal === "object" && schoolOrGoal !== null
    ? (schoolOrGoal.outreachGoal || schoolOrGoal.goal || "")
    : String(schoolOrGoal || "");
  const tracks = parseProgramTracks(rawGoal);
  return tracks.map((track) => {
    const badge = document.createElement("span");
    badge.className = track.status === "Completed"
      ? "badge badge-program badge-program-completed"
      : "badge badge-program";
    badge.textContent = track.status === "Completed"
      ? `✓ ${track.name}`
      : track.name;
    return badge;
  });
}

function ensureProgramControlsPopulated() {
  const addSelect = el("add-program-select");
  if (addSelect) {
    const existingOptions = addSelect.options
      ? Array.from(addSelect.options)
      : (addSelect.children ? Array.from(addSelect.children) : []);
    if (existingOptions.length === 0) {
      const placeholder = document.createElement("option");
      placeholder.value = "";
      placeholder.textContent = "Select a program...";
      addSelect.append(placeholder);
      for (const tag of PROGRAM_TAGS) {
        const opt = document.createElement("option");
        opt.value = tag;
        opt.textContent = tag;
        addSelect.append(opt);
      }
    }
  }
  const statusSelect = el("add-program-status");
  if (statusSelect) {
    const existingStatus = statusSelect.options
      ? Array.from(statusSelect.options)
      : (statusSelect.children ? Array.from(statusSelect.children) : []);
    if (existingStatus.length === 0) {
      const activeOpt = document.createElement("option");
      activeOpt.value = "Active";
      activeOpt.textContent = "Active Pitch";
      const completedOpt = document.createElement("option");
      completedOpt.value = "Completed";
      completedOpt.textContent = "Completed ✓";
      statusSelect.append(activeOpt, completedOpt);
      statusSelect.value = "Active";
    }
  }
}

function renderProgramChips() {
  const container = el("program-chips-list");
  if (!container) return;
  if (typeof container.replaceChildren === "function") {
    container.replaceChildren();
  } else {
    container.innerHTML = "";
  }
  const goalInput = el("edit-goal");
  const tracks = parseProgramTracks(goalInput?.value ?? "");
  for (const track of tracks) {
    const chip = document.createElement("span");
    chip.className = `program-chip ${track.status === "Completed" ? "is-completed" : "is-active"}`;
    chip.setAttribute("role", "listitem");
    chip.setAttribute("data-program", track.name);
    chip.setAttribute("data-status", track.status);
    if (chip.dataset) {
      chip.dataset.program = track.name;
      chip.dataset.status = track.status;
    }

    const toggleBtn = document.createElement("button");
    toggleBtn.type = "button";
    toggleBtn.className = "program-chip-toggle";
    toggleBtn.textContent = track.status === "Completed" ? `✓ ${track.name} (Completed)` : track.name;
    toggleBtn.setAttribute("aria-label", `Toggle status for ${track.name}`);
    toggleBtn.title = track.status === "Completed" ? "Click to mark Active" : "Click to mark Completed";
    toggleBtn.addEventListener("click", (e) => {
      e?.stopPropagation?.();
      const currentTracks = parseProgramTracks(el("edit-goal")?.value ?? "");
      const target = currentTracks.find((t) => t.name.toLowerCase() === track.name.toLowerCase());
      if (target) {
        target.status = target.status === "Completed" ? "Active" : "Completed";
        const input = el("edit-goal");
        if (input) input.value = serializeProgramTracks(currentTracks);
        renderProgramChips();
        updateDirtyState();
        scheduleDraftAutoSave();
      }
    });

    const removeBtn = document.createElement("button");
    removeBtn.type = "button";
    removeBtn.className = "program-chip-remove";
    removeBtn.textContent = "✕";
    removeBtn.setAttribute("aria-label", `Remove ${track.name}`);
    removeBtn.title = `Remove ${track.name}`;
    removeBtn.addEventListener("click", (e) => {
      e?.stopPropagation?.();
      const currentTracks = parseProgramTracks(el("edit-goal")?.value ?? "").filter(
        (t) => t.name.toLowerCase() !== track.name.toLowerCase()
      );
      const input = el("edit-goal");
      if (input) input.value = serializeProgramTracks(currentTracks);
      renderProgramChips();
      updateDirtyState();
      scheduleDraftAutoSave();
    });

    chip.append(toggleBtn, removeBtn);
    container.append(chip);
  }
}

function addProgramFromControls() {
  ensureProgramControlsPopulated();
  const addSelect = el("add-program-select");
  const statusSelect = el("add-program-status");
  const programName = String(addSelect?.value ?? "").trim();
  if (!programName) return false;
  const statusVal = String(statusSelect?.value ?? "Active").trim() === "Completed" ? "Completed" : "Active";
  const goalInput = el("edit-goal");
  const tracks = parseProgramTracks(goalInput?.value ?? "");
  const existing = tracks.find((t) => t.name.toLowerCase() === programName.toLowerCase());
  if (existing) {
    existing.name = programName;
    existing.status = statusVal;
  } else {
    tracks.push({ name: programName, status: statusVal });
  }
  if (goalInput) {
    goalInput.value = serializeProgramTracks(tracks);
  }
  if (addSelect) addSelect.value = "";
  if (statusSelect) statusSelect.value = "Active";
  renderProgramChips();
  updateDirtyState();
  return true;
}

function populateGoalDropdown(currentGoal = "") {
  ensureProgramControlsPopulated();
  const addSelect = el("add-program-select");
  const statusSelect = el("add-program-status");
  if (addSelect) addSelect.value = "";
  if (statusSelect) statusSelect.value = "Active";

  const goalInput = el("edit-goal");
  const tracks = parseProgramTracks(currentGoal);
  if (goalInput) {
    goalInput.value = serializeProgramTracks(tracks);
  }
  renderProgramChips();
}

if (typeof window !== "undefined") {
  window.parseProgramTracks = parseProgramTracks;
  window.serializeProgramTracks = serializeProgramTracks;
  window.createProgramBadges = createProgramBadges;
  window.addProgramFromControls = addProgramFromControls;
  window.renderProgramChips = renderProgramChips;
}
let editing = null, editorSeq = 0, editorRead;
let saveToastTimer;
let draftSaveTimer = null;
const DRAFT_MAX_AGE_MS = 14 * 24 * 60 * 60 * 1000;
const DRAFT_DEBOUNCE_MS = 300;
const editDrafts = new Map();
const savedSchoolGoals = new Map();
const sessionKey = "h4.crm.session-token.v1";
const resumeKey = "h4.crm.resume-view.v1";
const resumableViews = ["home", "my-schools", "programs", "directory", "dashboard"];
let resumeView = null, sessionWasExpired = false;

function getLocalStorage() {
  try {
    if (typeof localStorage !== "undefined" && localStorage) return localStorage;
    if (typeof window !== "undefined" && window.localStorage) return window.localStorage;
  } catch { /* Storage may be disabled. */ }
  return null;
}

function draftFormTypeAliases(formType) {
  const normalized = String(formType ?? "").trim();
  if (normalized === "activity" || normalized === "outreach") return ["activity", "outreach"];
  if (normalized === "details" || normalized === "edit") return ["details", "edit"];
  return [normalized];
}

const DraftManager = {
  getKey(formType, recordId) {
    return `h4_crm_draft_${formType}_${recordId}`;
  },
  saveDraft(formType, recordId, payload) {
    if (!formType || !recordId) return false;
    try {
      const store = getLocalStorage();
      if (!store) return false;
      const entry = JSON.stringify({
        payload,
        updatedAt: Date.now(),
      });
      store.setItem(this.getKey(formType, recordId), entry);
      for (const alias of draftFormTypeAliases(formType)) {
        if (alias !== formType) {
          store.setItem(this.getKey(alias, recordId), entry);
        }
      }
      return true;
    } catch {
      return false;
    }
  },
  loadDraft(formType, recordId) {
    if (!formType || !recordId) return null;
    try {
      const store = getLocalStorage();
      if (!store) return null;
      const aliases = [formType, ...draftFormTypeAliases(formType).filter((a) => a !== formType)];
      let chosenParsed = null;
      for (const candidate of aliases) {
        const key = this.getKey(candidate, recordId);
        const raw = store.getItem(key);
        if (!raw) continue;
        let parsed;
        try {
          parsed = JSON.parse(raw);
        } catch {
          store.removeItem(key);
          continue;
        }
        if (!parsed || typeof parsed !== "object") {
          store.removeItem(key);
          continue;
        }
        const updatedAt = Number(parsed.updatedAt);
        if (!Number.isFinite(updatedAt) || Date.now() - updatedAt > DRAFT_MAX_AGE_MS) {
          for (const alias of aliases) {
            store.removeItem(this.getKey(alias, recordId));
          }
          return null;
        }
        if (!chosenParsed) {
          chosenParsed = { parsed, updatedAt };
        }
      }
      if (!chosenParsed) return null;
      const { parsed, updatedAt } = chosenParsed;
      const payload = parsed.payload && typeof parsed.payload === "object" ? parsed.payload : {};
      return {
        ...payload,
        payload: parsed.payload,
        updatedAt,
      };
    } catch {
      return null;
    }
  },
  clearDraft(formType, recordId) {
    if (!formType || !recordId) return false;
    try {
      const store = getLocalStorage();
      if (!store) return false;
      for (const candidate of draftFormTypeAliases(formType)) {
        store.removeItem(this.getKey(candidate, recordId));
      }
      return true;
    } catch {
      return false;
    }
  },
  clearAllDrafts() {
    try {
      const store = getLocalStorage();
      if (!store) return;
      if (typeof store.length === "number" && typeof store.key === "function") {
        const toRemove = [];
        for (let i = 0; i < store.length; i++) {
          const k = store.key(i);
          if (typeof k === "string" && k.startsWith("h4_crm_draft_")) toRemove.push(k);
        }
        for (const k of toRemove) store.removeItem(k);
      } else if (store._keys instanceof Set) {
        for (const k of Array.from(store._keys)) {
          if (typeof k === "string" && k.startsWith("h4_crm_draft_")) store.removeItem(k);
        }
      }
    } catch {}
  },
};

if (typeof window !== "undefined") {
  window.DraftManager = DraftManager;
}

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
  if (el("workspace").hidden) {
    el("welcome").hidden = false;
    el("google-button").hidden = !!credential;
    el("retry").hidden = false;
    status(message);
  }
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
    el("welcome").hidden = false; status(detail); el("retry").hidden = false; el("google-button").hidden = !!credential;
    if (config?.ready && !credential) showGoogleButton().catch(() => {});
  }
}
const SESSION_STORAGE_KEYS = [sessionKey, resumeKey, "auth_token", "session_id", "user_cache"];

function clearAuthAndSessionStorage() {
  try {
    sessionStorage.removeItem(sessionKey);
    sessionStorage.removeItem(resumeKey);
  } catch { /* Storage may be disabled. */ }
  try {
    const store = getLocalStorage();
    if (!store) return;
    for (const key of SESSION_STORAGE_KEYS) {
      if (!key.startsWith("h4_crm_draft_")) {
        store.removeItem(key);
      }
    }
    if (typeof store.length === "number" && typeof store.key === "function") {
      const toRemove = [];
      for (let i = 0; i < store.length; i++) {
        const k = store.key(i);
        if (typeof k === "string" && !k.startsWith("h4_crm_draft_")) {
          if (k.startsWith("h4.crm.") || k.startsWith("h4_crm_auth") || k.startsWith("h4_crm_session") || k.startsWith("h4_crm_user")) {
            toRemove.push(k);
          }
        }
      }
      for (const k of toRemove) store.removeItem(k);
    }
  } catch { /* Storage may be disabled. */ }
}

function forgetSession() {
  if (editing?.original && !editing.saved && hasFormChanges(editing)) {
    saveCurrentModalDraft(false);
  }
  sessionVersion++;
  nonce = ""; resumeView = null;
  window.google?.accounts?.id.cancel?.();
  clearAuthAndSessionStorage();
  if (el("session-restore")) el("session-restore").hidden = true;
  clearTimeout(draftSaveTimer); draftSaveTimer = null;
  editorSeq++; editorRead?.abort(); editing = null; editDrafts.clear(); savedSchoolGoals.clear();
  if (el("draft-restore-banner")) el("draft-restore-banner").hidden = true;
  if (el("draft-autosave-status")) { el("draft-autosave-status").textContent = ""; el("draft-autosave-status").hidden = true; }
  clearTimeout(saveToastTimer); el("save-toast").hidden = true;
  el("school-editor").close?.();
  for (const field of editFields) {
    const input = el(`edit-${field}`);
    if (input) input.value = "";
  }
  ensureStageDropdownPopulated();
  updateStageHelperText("Not Contacted");
  populateGoalDropdown("");
  for (const field of outreachFields) el(`log-${field}`).value = "";
  updateSuggestionStates?.();
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
  credential = ""; schools = []; directory = []; demoSchools = []; isSupervisor = false; currentUser = null;
  pendingClaims.clear(); supervisorSchoolScope = "mine";
  programsScope = "mine"; selectedProgram = ""; programStatusFilter = "all";
  if (el("schools-supervisor-toggle")) el("schools-supervisor-toggle").hidden = true;
  if (el("programs-view")) {
    el("programs-view").hidden = true;
    el("programs-view").classList?.add("hidden");
    el("programs-overview-matrix")?.replaceChildren?.();
    for (const listId of [
      "programs-confirmed-list",
      "programs-fence-list",
      "programs-attention-list",
      "programs-waiting-list",
      "programs-cold-list",
      "programs-active-list",
      "programs-completed-list",
    ]) {
      el(listId)?.replaceChildren?.();
    }
    el("programs-kpi-strip")?.replaceChildren?.();
    if (el("programs-status")) el("programs-status").textContent = "";
    if (el("quick-tag-feedback")) el("quick-tag-feedback").textContent = "";
  }
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

function renderSupervisorSchoolToggle() {
  const toggle = el("schools-supervisor-toggle");
  if (!toggle) return;
  if (!isSupervisor) {
    toggle.hidden = true;
    return;
  }
  toggle.hidden = false;
  const myCount = schools.filter(isAssignedToMe).length;
  const allCount = schools.length;

  const btnMine = el("schools-toggle-mine");
  const btnAll = el("schools-toggle-all");

  if (btnMine) {
    btnMine.textContent = `My Schools (${myCount})`;
    const active = supervisorSchoolScope !== "all";
    btnMine.classList.toggle("active", active);
    btnMine.setAttribute("aria-pressed", String(active));
  }
  if (btnAll) {
    btnAll.textContent = `All Team Schools (${allCount})`;
    const active = supervisorSchoolScope === "all";
    btnAll.classList.toggle("active", active);
    btnAll.setAttribute("aria-pressed", String(active));
  }
}

function renderSchools() {
  const query = el("search").value.trim().toLowerCase();
  const today = dashboardToday();

  const isDrilldown = Boolean(schoolScopeFilter || schoolStageFilter);
  const mySchools = schools.filter(isAssignedToMe);

  let scopedSchools = schools;
  if (!isDrilldown) {
    if (isSupervisor) {
      scopedSchools = supervisorSchoolScope === "all" ? schools : mySchools;
    } else {
      scopedSchools = schools;
    }
  }

  const visible = scopedSchools.filter((school) => (!schoolScopeFilter || schoolScopeFilter(school, today)) && (!schoolStageFilter || stageKey(school) === schoolStageFilter) &&
    [school.schoolName, school.schoolBoard, school.geographicRegion].some((value) => value.toLowerCase().includes(query)));

  renderSupervisorSchoolToggle();

  if (el("schools-scope")) {
    el("schools-scope").hidden = !schoolScopeFilter && !schoolStageFilter;
    el("schools-scope-label").textContent = `${schoolScopeLabel || schoolStageFilter} · ${visible.length} ${visible.length === 1 ? "school" : "schools"}`;
  }
  if (el("schools-bulk-log")) {
    el("schools-bulk-log").disabled = config?.writesEnabled !== true;
    el("schools-bulk-log").hidden = false;
  }
  const baseTotal = isDrilldown ? schools.length : scopedSchools.length;
  el("school-count").textContent = String(visible.length);
  el("school-count-label").textContent = visible.length !== baseTotal ? `of ${baseTotal} schools` : baseTotal === 1 ? "school" : "schools";
  el("school-list").replaceChildren();
  for (const school of visible) {
    const container = document.createElement("article"); container.className = "school-card";
    const card = document.createElement("button"); card.className = "school-open"; card.type = "button";
    card.setAttribute("aria-label", `Edit ${school.schoolName}`);
    card.onclick = () => openSchoolEditor(school.recordId);
    const stage = schoolBadge(school.stage);
    const priority = document.createElement("span"); priority.className = "school-priority"; priority.textContent = school.priority ? `${school.priority} priority` : "";
    const programBadges = createProgramBadges(school.outreachGoal || school.goal || "");
    const heading = document.createElement("h2"); heading.textContent = school.schoolName;
    const meta = document.createElement("p"); meta.className = "school-meta"; meta.textContent = [school.schoolBoard, school.geographicRegion].filter(Boolean).join(" · ") || "Location not listed";
    const assignment = document.createElement("p"); assignment.className = "assignment"; assignment.textContent = school.assignedTo ? `Assigned to ${school.assignedTo}` : "Unassigned";
    const editHint = document.createElement("span"); editHint.className = "edit-hint"; editHint.textContent = "Edit school →";
    const log = document.createElement("button"); log.className = "button school-log"; log.type = "button";
    log.textContent = "Log outreach"; log.setAttribute("aria-label", `Log outreach for ${school.schoolName}`);
    log.onclick = () => openSchoolEditor(school.recordId, false, "activity");
    log.disabled = config?.writesEnabled !== true;
    card.append(stage, priority, ...programBadges, heading, meta, assignment); appendNextAction(card, school); card.append(editHint);
    container.append(card, log); el("school-list").append(container);
  }
  el("empty-state").hidden = visible.length > 0;
  el("empty-title").textContent = query ? "No matching schools" : "No schools assigned yet";
  el("empty-description").textContent = query ? "Try a different school name, board or region." : "Your supervisor can help you find your next school.";
}

function editorInputs(disabled) {
  for (const field of editFields) el(`edit-${field}`).disabled = disabled;
  for (const field of outreachFields) el(`log-${field}`).disabled = disabled;
  if (el("edit-primary-owner")) el("edit-primary-owner").disabled = disabled;
  if (el("add-collaborator-select")) el("add-collaborator-select").disabled = disabled;
  if (el("add-collaborator-btn")) el("add-collaborator-btn").disabled = disabled;
  if (el("add-program-select")) el("add-program-select").disabled = disabled;
  if (el("add-program-status")) el("add-program-status").disabled = disabled;
  if (el("add-program-btn")) el("add-program-btn").disabled = disabled;
  if (el("editor-unclaim-btn")) el("editor-unclaim-btn").disabled = disabled;
  if (el("unclaim-cancel-btn")) el("unclaim-cancel-btn").disabled = disabled;
  if (el("unclaim-confirm-btn")) el("unclaim-confirm-btn").disabled = disabled;
  if (typeof document?.querySelectorAll === "function") {
    const buttons = document.querySelectorAll(".suggestion-chip, #log-contact-edit, #return-to-activity, #save-contact-return, .collaborator-chip-remove, .program-chip-toggle, .program-chip-remove");
    for (const btn of buttons) btn.disabled = disabled;
  }
}

const OUTCOME_CHAINING = {
  "no reply yet": {
    nextAction: "Follow up if no reply",
    stage: "Contacted",
    days: 4,
  },
  "left voicemail": {
    nextAction: "Call school main office",
    stage: "Contacted",
    days: 3,
  },
  "office asked to email info": {
    nextAction: "Send info package by email",
    stage: "Contacted",
    days: 3,
  },
  "receptionist gave teacher contact": {
    nextAction: "Send info package by email",
    stage: "Contacted",
    days: 2,
  },
  "asked for more information": {
    nextAction: "Send info package by email",
    stage: "Engaged",
    days: 3,
  },
  "interested": {
    nextAction: "Confirm dates with teacher",
    stage: "Engaged",
    days: 3,
  },
  "checking with principal / dept head": {
    nextAction: "Get Principal / Admin approval",
    stage: "Engaged",
    days: 5,
  },
  "confirmed / locked in!": {
    nextAction: "Schedule a workshop",
    stage: "Booked",
    days: 2,
  },
};

function formatQuickDate(daysFromNow, now = new Date()) {
  const d = new Date(now);
  d.setDate(d.getDate() + Number(daysFromNow || 0));
  return dashboardToday(d);
}

function toggleSummaryPhrase(currentText, phrase) {
  const text = (currentText || "").trim();
  if (!text) return phrase;

  const escaped = phrase.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const regex = new RegExp(`(^|[,.;\\n]\\s*)${escaped}(?=[,.;\\n]|\\s|$)`, "i");
  const match = text.match(regex);

  if (match) {
    const idx = match.index + (match[1] ? match[1].length : 0);
    const before = text.slice(0, idx).trimEnd();
    const after = text.slice(idx + phrase.length).trimStart();
    const cleanBefore = before.replace(/[,;]+$/, "");
    const cleanAfter = after.replace(/^[,;]+/, "").trimStart();

    if (!cleanBefore) {
      return cleanAfter.replace(/^[,\s;.]+/, "").trim();
    }
    if (!cleanAfter) {
      return cleanBefore.trim();
    }
    if (cleanBefore.endsWith(".")) {
      return `${cleanBefore} ${cleanAfter}`;
    }
    return `${cleanBefore}, ${cleanAfter}`;
  }

  const clean = text.replace(/[,\s;]+$/, "");
  const sep = clean.endsWith(".") ? " " : ", ";
  return `${clean}${sep}${phrase}`;
}

function applyQuickDate(days) {
  const target = el("edit-followUpDue") || el("edit-follow-up-date");
  if (!target || target.disabled) return;
  target.value = formatQuickDate(Number(days));
  target.dispatchEvent(new Event("input", { bubbles: true }));
  target.dispatchEvent(new Event("change", { bubbles: true }));
  updateDirtyState();
  scheduleDraftAutoSave();
  updateSuggestionStates();
}

if (typeof window !== "undefined") {
  window.formatQuickDate = formatQuickDate;
  window.applyQuickDate = applyQuickDate;
  window.toggleSummaryPhrase = toggleSummaryPhrase;
  window.OUTCOME_CHAINING = OUTCOME_CHAINING;
}

function applySuggestion(targetId, value) {
  const input = el(targetId);
  if (!input || input.disabled) return;

  if (targetId === "log-summary") {
    input.value = toggleSummaryPhrase(input.value, value);
  } else {
    input.value = value;
  }

  input.dispatchEvent(new Event("input", { bubbles: true }));
  input.dispatchEvent(new Event("change", { bubbles: true }));
  input.focus?.();
  updateDirtyState();
  scheduleDraftAutoSave();
  updateSuggestionStates();

  if (targetId === "log-outcome") {
    const outcomeKey = value.toLowerCase().trim();
    if (outcomeKey === "not interested") {
      const origStage = editing?.original?.stage;
      if (!origStage || !["Interested", "Engaged", "Booked", "Completed"].includes(origStage)) {
        if (el("edit-stage")) el("edit-stage").value = "Cold";
        if (el("edit-coldReason")) el("edit-coldReason").value = DEFAULT_DECLINE_REASON;
        if (el("edit-followUpDue")) el("edit-followUpDue").value = "";
        if (el("edit-nextAction")) el("edit-nextAction").value = "Archived for season";
        updateStageHelperText("Cold");
        updateColdWarning();
        updateSuggestionStates();
      }
    } else if (OUTCOME_CHAINING[outcomeKey]) {
      const chain = OUTCOME_CHAINING[outcomeKey];
      if (el("edit-stage")) {
        el("edit-stage").value = chain.stage;
        el("edit-stage").dispatchEvent(new Event("change", { bubbles: true }));
        updateStageHelperText(chain.stage);
      }
      if (el("edit-nextAction")) {
        el("edit-nextAction").value = chain.nextAction;
        el("edit-nextAction").dispatchEvent(new Event("input", { bubbles: true }));
        el("edit-nextAction").dispatchEvent(new Event("change", { bubbles: true }));
      }
      const dateInput = el("edit-followUpDue") || el("edit-follow-up-date");
      if (dateInput) {
        dateInput.value = formatQuickDate(chain.days);
        dateInput.dispatchEvent(new Event("input", { bubbles: true }));
        dateInput.dispatchEvent(new Event("change", { bubbles: true }));
      }
      updateDirtyState();
      scheduleDraftAutoSave();
      updateSuggestionStates();
    }
  }
}

function updateSuggestionStates() {
  if (typeof document?.querySelectorAll !== "function") return;
  const chips = document.querySelectorAll(".suggestion-chip");
  for (const chip of chips) {
    if (chip.classList?.contains("quick-date-chip") || chip.getAttribute?.("data-days")) continue;
    const targetId = chip.getAttribute?.("data-target");
    const value = chip.getAttribute?.("data-value");
    const input = el(targetId);
    if (!input || !value) continue;
    let isMatch = false;
    if (targetId === "log-summary") {
      const escaped = value.trim().replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
      isMatch = new RegExp(`(^|[,.;\\n]\\s*)${escaped}(?=[,.;\\n]|\\s|$)`, "i").test(input.value.trim());
    } else {
      isMatch = Boolean(input.value.trim().toLowerCase() === value.trim().toLowerCase());
    }
    chip.classList?.toggle("selected", isMatch);
    chip.setAttribute?.("aria-pressed", String(isMatch));
  }

  const dateChips = document.querySelectorAll(".quick-date-chip");
  const dateInput = el("edit-followUpDue") || el("edit-follow-up-date");
  if (dateChips && dateInput) {
    const currentDate = (dateInput.value || "").trim();
    for (const chip of dateChips) {
      const days = chip.getAttribute?.("data-days");
      if (days !== null && days !== undefined) {
        const isMatch = Boolean(currentDate && currentDate === formatQuickDate(Number(days)));
        chip.classList?.toggle("selected", isMatch);
        chip.setAttribute?.("aria-pressed", String(isMatch));
      }
    }
  }
}

const STEP4_SUMMARY_SUGGESTIONS = [
  { label: "Introduced H4", value: "Introduced H4" },
  { label: "Offered free workshop", value: "Offered free workshop" },
  { label: "Pitched Cypher Program", value: "Pitched Cypher Program" },
  { label: "Pitched SHSM Certification", value: "Pitched SHSM Certification" },
  { label: "Invited to Battle at the Board", value: "Invited to Battle at the Board" },
  { label: "Asked about dance program", value: "Asked about dance program" },
  { label: "Asked for the right contact", value: "Asked for the right contact" },
  { label: "Sent program info package / flyer", value: "Sent program info package / flyer" },
  { label: "Discussed available dates", value: "Discussed available dates" },
  { label: "Invited student mentors", value: "Invited student mentors" },
];

const summarySuggestions = {
  Email: {
    Outreach: STEP4_SUMMARY_SUGGESTIONS,
    FollowUp: [
      { label: "Followed up about workshop opportunities", value: "Followed up about workshop opportunities." },
      { label: "Requested an update", value: "Requested an update." },
    ],
  },
  Text: {
    Outreach: [
      { label: "Texted about workshop opportunities", value: "Texted about workshop opportunities." },
      { label: "Introduced H4 via text", value: "Texted to introduce H4 and free dance programs." },
      { label: "Asked for contact", value: "Texted to ask for the right contact for student programs." },
    ],
    FollowUp: [
      { label: "Followed up via text", value: "Followed up via text about workshop opportunities." },
      { label: "Checked in", value: "Sent a text check-in regarding our previous message." },
    ],
  },
  Phone: [
    { label: "Called school office", value: "Called school office." },
    { label: "Called the school", value: "Called the school." },
    { label: "Left voicemail", value: "Left voicemail." },
    { label: "Discussed workshop opportunities", value: "Discussed workshop opportunities." },
  ],
  Visit: {
    Outreach: [
      { label: "Visited school to introduce H4", value: "Visited school to introduce H4." },
      { label: "Dropped off materials", value: "Dropped off H4 introductory materials at the school office." },
      { label: "Met with office staff", value: "Spoke with front office staff to introduce H4 programs." },
    ],
    FollowUp: [
      { label: "Follow-up visit", value: "Followed up with an in-person school visit." },
      { label: "Checked in with office", value: "Checked in with school office regarding program delivery." },
    ],
  },
  Meeting: [
    { label: "Discussed program delivery", value: "Discussed program delivery." },
    { label: "Discussed workshop plans", value: "Discussed workshop plans." },
    { label: "Discussed scheduling", value: "Discussed scheduling." },
    { label: "Agreed on next steps", value: "Agreed on next steps." },
  ],
  Social: [
    { label: "Sent direct message", value: "Sent direct message." },
    { label: "Sent introductory message", value: "Sent introductory message." },
    { label: "Followed up through social media", value: "Followed up through social media." },
  ],
};

const bulkSummarySuggestions = {
  Email: {
    Outreach: [
      { label: "Introduced H4", value: "Sent an introductory email explaining H4 and our free dance programs." },
      { label: "Offered free workshop", value: "Sent an email offering a free introductory dance workshop." },
      { label: "Asked about dance program", value: "Emailed to ask if the school has a dance class, team, or club." },
      { label: "Asked for the right contact", value: "Emailed to ask who oversees dance, leadership, or student clubs." },
      { label: "Invited student mentors", value: "Sent an email inviting students to become H4 volunteer dance mentors." },
    ],
    FollowUp: [
      { label: "Followed up about workshop opportunities", value: "Followed up about workshop opportunities." },
      { label: "Requested an update", value: "Requested an update." },
    ],
  },
  Text: {
    Outreach: [
      { label: "Texted about workshop opportunities", value: "Texted about workshop opportunities." },
      { label: "Introduced H4 via text", value: "Texted to introduce H4 and free dance programs." },
      { label: "Asked for contact", value: "Texted to ask for the right contact for student programs." },
    ],
    FollowUp: [
      { label: "Followed up via text", value: "Followed up via text about workshop opportunities." },
      { label: "Checked in", value: "Sent a text check-in regarding our previous message." },
    ],
  },
  Phone: [
    { label: "Called school office", value: "Called school office." },
    { label: "Called the school", value: "Called the school." },
    { label: "Left voicemail", value: "Left voicemail." },
    { label: "Discussed workshop opportunities", value: "Discussed workshop opportunities." },
  ],
  Visit: {
    Outreach: [
      { label: "Visited school to introduce H4", value: "Visited school to introduce H4." },
      { label: "Dropped off materials", value: "Dropped off H4 introductory materials at the school office." },
      { label: "Met with office staff", value: "Spoke with front office staff to introduce H4 programs." },
    ],
    FollowUp: [
      { label: "Follow-up visit", value: "Followed up with an in-person school visit." },
      { label: "Checked in with office", value: "Checked in with school office regarding program delivery." },
    ],
  },
  Meeting: [
    { label: "Discussed program delivery", value: "Discussed program delivery." },
    { label: "Discussed workshop plans", value: "Discussed workshop plans." },
    { label: "Discussed scheduling", value: "Discussed scheduling." },
    { label: "Agreed on next steps", value: "Agreed on next steps." },
  ],
  Social: [
    { label: "Sent direct message", value: "Sent direct message." },
    { label: "Sent introductory message", value: "Sent introductory message." },
    { label: "Followed up through social media", value: "Followed up through social media." },
  ],
};

function getSummarySuggestions(channel, activityType) {
  const channelData = summarySuggestions[channel] || summarySuggestions.Email;
  if (Array.isArray(channelData)) return channelData;
  return channelData[activityType] || channelData.Outreach || [];
}

const STEP3_OUTCOME_SUGGESTIONS = [
  "No reply yet",
  "Left voicemail",
  "Spoke with someone",
  "Office asked to email info",
  "Receptionist gave teacher contact",
  "Asked for more information",
  "Interested",
  "Checking with Principal / Dept Head",
  "Confirmed / Locked in!",
  "Not interested",
];

const STEP5_NEXT_ACTION_SUGGESTIONS = [
  "Follow up if no reply",
  "Schedule a workshop",
  "Visit the school",
  "Call school main office",
  "Send info package by email",
  "Confirm dates with teacher",
  "Get Principal / Admin approval",
  "Send booking confirmation",
  "Send invoice / feedback survey",
];

const QUICK_DATE_SUGGESTIONS = [
  { label: "Tomorrow", days: 1 },
  { label: "In 3 days", days: 3 },
  { label: "Next week", days: 7 },
  { label: "In 2 weeks", days: 14 },
];

function renderOutcomeSuggestions() {
  const container = el("outcome-suggestion-chips");
  if (!container || (container.children && container.children.length > 0)) return;
  for (const text of STEP3_OUTCOME_SUGGESTIONS) {
    const chip = document.createElement("button");
    chip.type = "button";
    chip.className = "suggestion-chip";
    chip.setAttribute("data-target", "log-outcome");
    chip.setAttribute("data-value", text);
    chip.textContent = text;
    chip.onclick = () => {
      chip._handledClick = true;
      applySuggestion("log-outcome", text);
    };
    if (editing?.busy || el("log-outcome")?.disabled) chip.disabled = true;
    container.append(chip);
  }
}

function renderNextActionSuggestions() {
  const container = el("next-action-suggestion-chips");
  if (!container || (container.children && container.children.length > 0)) return;
  for (const text of STEP5_NEXT_ACTION_SUGGESTIONS) {
    const chip = document.createElement("button");
    chip.type = "button";
    chip.className = "suggestion-chip";
    chip.setAttribute("data-target", "edit-nextAction");
    chip.setAttribute("data-value", text);
    chip.textContent = text;
    chip.onclick = () => {
      chip._handledClick = true;
      applySuggestion("edit-nextAction", text);
    };
    if (editing?.busy || el("edit-nextAction")?.disabled) chip.disabled = true;
    container.append(chip);
  }
}

function renderQuickDateChips() {
  const container = el("quick-date-suggestion-chips");
  if (!container || (container.children && container.children.length > 0)) return;
  for (const item of QUICK_DATE_SUGGESTIONS) {
    const chip = document.createElement("button");
    chip.type = "button";
    chip.className = "suggestion-chip quick-date-chip";
    chip.setAttribute("data-days", String(item.days));
    chip.textContent = item.label;
    chip.onclick = () => {
      chip._handledClick = true;
      applyQuickDate(item.days);
    };
    if (editing?.busy || (el("edit-followUpDue") || el("edit-follow-up-date"))?.disabled) chip.disabled = true;
    container.append(chip);
  }
}

function ensureAllEditorSuggestionPills() {
  renderOutcomeSuggestions();
  renderNextActionSuggestions();
  renderQuickDateChips();
  bindEditorSuggestionChips();
  updateSuggestionStates();
}

function renderSummarySuggestions() {
  const container = el("summary-suggestion-chips");
  if (!container) return;
  const channel = el("log-channel")?.value || "Email";
  const activityType = el("log-activityType")?.value || "Outreach";
  const suggestions = getSummarySuggestions(channel, activityType);
  container.replaceChildren();
  for (const item of suggestions) {
    const chip = document.createElement("button");
    chip.type = "button";
    chip.className = "suggestion-chip";
    chip.setAttribute("data-target", "log-summary");
    chip.setAttribute("data-value", item.value);
    chip.textContent = item.label;
    chip.onclick = () => {
      chip._handledClick = true;
      applySuggestion("log-summary", item.value);
    };
    if (editing?.busy || el("log-summary")?.disabled) chip.disabled = true;
    container.append(chip);
  }
  updateSuggestionStates();
}

function evaluateColdEligibility(params) {
  const PROTECTED_STAGES = new Set(["Interested", "Engaged", "Booked", "Completed"]);

  if (PROTECTED_STAGES.has(params.currentStage)) {
    return {
      allowed: false,
      reason: `Schools in "${params.currentStage}" stage are protected. Change stage to Contacted first before marking Cold.`,
    };
  }

  const explicitRejectionReasons = [
    "Not Interested",
    "Explicit Rejection / Not Interested",
    "No Budget / Funding",
    "Timing / Scheduling Conflict",
    "Outside Program Scope / Ineligible",
    "Other (Declined)",
  ];

  if (
    params.isExplicitRejection ||
    (params.coldReason && explicitRejectionReasons.includes(params.coldReason))
  ) {
    return {
      allowed: true,
      reason: "Eligible for Cold status (Explicit rejection / declined by school).",
    };
  }

  // Unresponsive path
  if (params.followUpCount < 2) {
    return {
      allowed: false,
      reason: `Requires 2 unanswered follow-ups before marking Cold due to no response (currently ${params.followUpCount}/2), OR select an explicit decline reason.`,
    };
  }

  const today = params.today || new Date().toISOString().slice(0, 10);
  if (!params.followUpDue || today <= params.followUpDue) {
    return {
      allowed: false,
      reason: `Response deadline (${params.followUpDue || "not set"}) must pass before marking Cold due to no response.`,
    };
  }

  return {
    allowed: true,
    reason: "Eligible for Cold status (2 unanswered follow-ups completed & deadline passed).",
  };
}

function updateColdWarning() {
  const warning = el("cold-warning");
  const coldReasonField = el("field-coldReason");
  if (!warning) return;
  const stage = el("edit-stage")?.value;
  if (stage !== "Cold") {
    warning.textContent = "";
    warning.hidden = true;
    if (coldReasonField) coldReasonField.hidden = true;
    if (editing) editing.coldAllowed = true;
    return;
  }

  if (coldReasonField) coldReasonField.hidden = false;
  const coldReasonInput = el("edit-coldReason");
  const coldReason = coldReasonInput?.value || DEFAULT_DECLINE_REASON;
  const outcome = el("log-outcome")?.value || "";
  const isExplicit = EXPLICIT_REJECTION_REASONS.includes(coldReason) || outcome.trim().toLowerCase() === "not interested";

  const check = evaluateColdEligibility({
    currentStage: editing?.original?.stage || "Not Contacted",
    followUpCount: Number(editing?.original?.followUpCount || 0),
    followUpDue: editing?.original?.followUpDue || null,
    coldReason: coldReason,
    isExplicitRejection: isExplicit,
  });

  if (!check.allowed) {
    warning.textContent = check.reason;
    warning.hidden = false;
    if (editing) editing.coldAllowed = false;
  } else {
    warning.textContent = "";
    warning.hidden = true;
    if (editing) editing.coldAllowed = true;
  }
}

function getSelectedContactIds() {
  const genBox = el("contact-choice-general");
  if (genBox?.checked) return [];
  const allBoxes = Array.from(document.querySelectorAll(".named-contact-checkbox") || []);
  const namedBoxes = allBoxes.filter((cb) => cb.checked);
  return Array.from(new Set(namedBoxes.map((cb) => cb.value)));
}

function getSelectedContactTokens() {
  const genBox = el("contact-choice-general");
  if (genBox?.checked) return ["__general__"];
  const allBoxes = Array.from(document.querySelectorAll(".named-contact-checkbox") || []);
  const namedBoxes = allBoxes.filter((cb) => cb.checked);
  return Array.from(new Set(namedBoxes.map((cb) => cb.value)));
}

function updateSelectedContactsSummary() {
  const display = el("outreach-selected-text");
  if (!display) return;
  const genBox = el("contact-choice-general");
  const allBoxes = Array.from(document.querySelectorAll(".named-contact-checkbox") || []);
  const namedBoxes = allBoxes.filter((cb) => cb.checked);
  const selectedIds = Array.from(new Set(namedBoxes.map((cb) => cb.value)));

  if (selectedIds.length > 0) {
    const contactsMap = new Map((editing?.contacts || []).map((c) => [c.contactId, c]));
    const selectedNames = selectedIds.map((id) => {
      const c = contactsMap.get(id);
      if (c) {
        return `${c.name} — ${c.role || "Contact"}`;
      }
      const cb = namedBoxes.find((b) => b.value === id);
      const card = cb?.closest?.(".outreach-contact-card");
      return card?.querySelector?.(".outreach-contact-name")?.textContent || cb?.getAttribute?.("aria-label") || "Contact";
    });
    display.textContent = selectedNames.join(", ");
  } else if (genBox?.checked) {
    display.textContent = "General School Outreach";
  } else {
    display.textContent = "No contacts selected (optional)";
  }
}

function renderOutreachContactPicker(contacts = [], selectedIds = []) {
  const container = el("outreach-named-contacts");
  const genCard = el("contact-choice-general-card");
  const genBox = el("contact-choice-general");
  if (!container) return;

  if (typeof container.replaceChildren === "function") {
    container.replaceChildren();
  } else {
    container.innerHTML = "";
  }

  const activeContacts = (contacts || []).filter((c) => c.active !== false);

  if (activeContacts.length === 0) {
    const emptyMsg = document.createElement("p");
    emptyMsg.className = "contacts-empty-note";
    emptyMsg.textContent = "No specific contacts recorded yet for this school. You can select General School Outreach or add a contact.";
    container.append(emptyMsg);
  } else {
    for (const c of activeContacts) {
      const card = document.createElement("label");
      card.className = `outreach-contact-card${c.isPrimary ? " is-primary" : ""}`;
      card.setAttribute("data-contact-id", c.contactId);
      if (card.dataset) card.dataset.contactId = c.contactId;

      const checkbox = document.createElement("input");
      checkbox.type = "checkbox";
      checkbox.className = "outreach-contact-checkbox named-contact-checkbox";
      checkbox.value = c.contactId;
      checkbox.setAttribute("aria-label", `${c.name} — ${c.role || "Contact"}`);
      if (selectedIds && selectedIds.includes(c.contactId)) {
        checkbox.checked = true;
        card.classList.add("is-selected");
      }

      checkbox.addEventListener("change", () => {
        if (checkbox.checked) {
          if (genBox) {
            genBox.checked = false;
            genCard?.classList.remove("is-selected");
          }
          card.classList.add("is-selected");
        } else {
          card.classList.remove("is-selected");
        }
        updateSelectedContactsSummary();
        updateDirtyState();
        scheduleDraftAutoSave();
      });

      const content = document.createElement("div");
      content.className = "outreach-contact-content";

      const nameRow = document.createElement("div");
      nameRow.className = "outreach-contact-name-row";

      const nameEl = document.createElement("strong");
      nameEl.className = "outreach-contact-name";
      nameEl.textContent = `${c.name} — ${c.role || "Contact"}`;
      nameRow.append(nameEl);

      if (c.isPrimary) {
        const pBadge = document.createElement("span");
        pBadge.className = "contact-badge-primary";
        pBadge.textContent = "★ Primary";
        nameRow.append(pBadge);
      }

      if (c.category) {
        const catBadge = document.createElement("span");
        catBadge.className = `contact-badge-cat${c.category === "Student" ? " contact-badge-student" : ""}`;
        catBadge.textContent = c.category;
        nameRow.append(catBadge);
      }

      content.append(nameRow);

      const subInfo = [c.email, c.phone, c.programGroup].filter(Boolean).join(" · ");
      if (subInfo) {
        const subEl = document.createElement("span");
        subEl.className = "outreach-contact-sub";
        subEl.textContent = subInfo;
        content.append(subEl);
      }

      card.append(checkbox);
      card.append(content);
      container.append(card);
    }
  }

  if (genBox) {
    genBox.checked = Boolean(selectedIds && selectedIds.includes("__general__"));
    genCard?.classList.toggle("is-selected", genBox.checked);
  }

  updateSelectedContactsSummary();
}

function editSchoolContact() {
  if (!editing || editing.busy) return;
  const values = editorValues();
  const activity = outreachValues();
  const selectedContactIds = getSelectedContactTokens();
  const outreachDraftPayload = {
    ...values,
    ...activity,
    values,
    activity,
    selectedContactIds,
    pending: editing.pending,
    original: editing.original,
  };
  // Always preserve the complete outreach draft when entering contact editor
  editDrafts.set(`activity:${editing.id}`, outreachDraftPayload);
  DraftManager.saveDraft("activity", editing.id, outreachDraftPayload);
  openSchoolEditor(editing.id, false, "details");
}

function hasFormChanges(edit = editing) {
  if (!edit || !edit.original) return false;
  if (edit.pending) return true;

  // Check uncommitted collaborator selection in dropdown
  const addSelect = el("add-collaborator-select");
  const selectedCollab = addSelect?.value?.trim().toLowerCase();
  const primaryEmail = (edit.primaryOwner?.email || "").trim().toLowerCase();
  if (selectedCollab && selectedCollab !== primaryEmail && !(edit.collaborators || []).some((c) => c.email.toLowerCase() === selectedCollab)) {
    return true;
  }

  // Check assignees comparison when assignees were modified
  if (edit.assigneesChanged) {
    const origEmails = String(edit.original.ownerEmail || "").split(",").map((e) => e.trim().toLowerCase()).filter(Boolean);
    const origNames = String(edit.original.assignedTo || "").split(",").map((n) => n.trim()).filter(Boolean);
    const newEmails = [
      edit.primaryOwner?.email,
      ...(edit.collaborators || []).map((c) => c.email),
    ].filter(Boolean).map((e) => e.trim().toLowerCase());
    const newNames = [
      edit.primaryOwner?.name,
      ...(edit.collaborators || []).map((c) => c.name),
    ].filter(Boolean).map((n) => n.trim());

    if (newEmails.join(",") !== origEmails.join(",") || newNames.join(",") !== origNames.join(",")) {
      return true;
    }
  }

  if (edit.mode === "activity") {
    const activity = outreachValues();
    const values = editorValues();
    const selectedContactIds = getSelectedContactTokens();
    const defaultStage = edit.original.stage === "Not Contacted" ? "Contacted" : edit.original.stage;
    return Boolean(
      activity.outcome?.trim() ||
      activity.summary?.trim() ||
      (activity.channel && activity.channel !== "Email") ||
      (activity.activityType && activity.activityType !== "Outreach") ||
      values.nextAction !== String(edit.original.nextAction ?? "") ||
      values.followUpDue !== String(edit.original.followUpDue ?? "") ||
      (values.stage && values.stage !== defaultStage) ||
      selectedContactIds.length > 0
    );
  }

  const values = editorValues();
  const goalVal = el("edit-goal")?.value ?? el("edit-outreachGoal")?.value ?? values.outreachGoal ?? "";
  const origGoal = String(edit.original.outreachGoal ?? edit.original.goal ?? "");
  if (goalVal !== origGoal) return true;

  // Check uncommitted program selection in #add-program-select
  const pendingProgram = el("add-program-select")?.value?.trim();
  if (pendingProgram) {
    const pendingStatus = el("add-program-status")?.value === "Completed" ? "Completed" : "Active";
    const previewTracks = parseProgramTracks(goalVal);
    const existing = previewTracks.find((t) => t.name.toLowerCase() === pendingProgram.toLowerCase());
    if (existing) {
      existing.name = pendingProgram;
      existing.status = pendingStatus;
    } else {
      previewTracks.push({ name: pendingProgram, status: pendingStatus });
    }
    if (serializeProgramTracks(previewTracks) !== origGoal) return true;
  }

  return editFields.some((key) => values[key] !== String(edit.original[key] ?? ""));
}

function isDirty(edit = editing) {
  return hasFormChanges(edit);
}

function updateDirtyState() {
  if (!editing) return false;
  const dirty = hasFormChanges(editing);
  editing.dirty = dirty;
  const form = el("editor-form");
  if (form) {
    form.setAttribute("data-dirty", dirty ? "true" : "false");
    form.classList.toggle("is-dirty", dirty);
  }
  const dialog = el("school-editor");
  if (dialog) {
    dialog.setAttribute("data-dirty", dirty ? "true" : "false");
    dialog.classList.toggle("is-dirty", dirty);
  }
  const saveBtn = el("editor-save");
  if (saveBtn && !editing.busy && !editing.stale) {
    saveBtn.disabled = false;
  }
  return dirty;
}

if (typeof window !== "undefined") {
  window.hasFormChanges = hasFormChanges;
  window.isDirty = isDirty;
  window.updateDirtyState = updateDirtyState;
}

function hasUnsavedContactEdits() {
  if (!editing || editing.mode !== "details" || !editing.original) return false;
  return hasFormChanges(editing);
}

function returnToActivity(force = false) {
  if (!editing || editing.busy) return;
  if (!force && hasUnsavedContactEdits()) {
    if (typeof window?.confirm === "function") {
      if (!window.confirm("You have unsaved contact edits. Discard them and return to Log Outreach?")) return;
    } else {
      const btn = el("return-to-activity");
      if (btn && btn.getAttribute("data-confirming") !== "true") {
        btn.setAttribute("data-confirming", "true");
        btn.textContent = "Discard edits & return to Log Outreach";
        editorFeedback("You have unsaved contact edits. Click again to discard them, or save first.", "error");
        return;
      }
    }
  }
  const btn = el("return-to-activity");
  if (btn) {
    btn.removeAttribute?.("data-confirming");
    btn.textContent = "← Return to Log Outreach";
  }
  editDrafts.delete(`details:${editing.id}`);
  DraftManager.clearDraft("details", editing.id);
  openSchoolEditor(editing.id, false, "activity");
}

function editorValues() {
  const vals = Object.fromEntries(editFields.map((field) => {
    let input = el(`edit-${field}`);
    if (!input && (field === "outreachGoal" || field === "goal")) {
      input = el("edit-goal") || el("edit-outreachGoal");
    }
    return [field, input?.value ?? ""];
  }));
  const goalVal = el("edit-goal")?.value ?? el("edit-outreachGoal")?.value ?? vals.outreachGoal ?? "";
  vals.outreachGoal = goalVal;
  vals.goal = goalVal;
  if (vals.stage !== "Cold" && !editing?.original?.coldReason) {
    vals.coldReason = "";
  }
  return vals;
}
function outreachValues() { return Object.fromEntries(outreachFields.map((field) => [field, el(`log-${field}`).value])); }
function editorDraftKey(edit) { return `${edit.mode ?? "details"}:${edit.id}`; }
function editorSaveLabel(edit) {
  if (edit.mode === "activity") return "Save outreach";
  if (editDrafts.has(`activity:${edit.id}`)) return "Save contact & return";
  return "Save changes";
}

function editorFeedback(message, kind = "info") {
  el("editor-status").textContent = message;
  el("editor-feedback").textContent = message;
  el("editor-feedback").setAttribute("data-kind", kind);
}

function scrollEditorErrorIntoView() {
  el("editor-feedback")?.scrollIntoView?.({ behavior: "smooth", block: "nearest" });
  el("editor-status")?.scrollIntoView?.({ behavior: "smooth", block: "nearest" });
}

function buildCurrentDraftPayload(edit = editing) {
  if (!edit || !edit.id || !edit.original) return null;
  const values = editorValues();
  const activity = outreachValues();
  const selectedContactIds = getSelectedContactTokens();
  return {
    ...values,
    ...(edit.mode === "activity" ? activity : {}),
    values,
    activity,
    selectedContactIds,
    primaryOwner: edit.primaryOwner,
    collaborators: edit.collaborators,
    assigneesChanged: Boolean(edit.assigneesChanged),
    pending: edit.pending,
    original: edit.original,
  };
}

function saveCurrentModalDraft(showStatus = true) {
  clearTimeout(draftSaveTimer);
  draftSaveTimer = null;
  if (!editing || !editing.id || !editing.original || editing.saved) return false;
  const payload = buildCurrentDraftPayload(editing);
  if (!payload) return false;
  const formType = editing.mode === "activity" ? "activity" : "details";
  DraftManager.saveDraft(formType, editing.id, payload);
  editDrafts.set(editorDraftKey(editing), payload);
  if (showStatus && !editing.busy) {
    const statusBadge = el("draft-autosave-status");
    if (statusBadge) {
      statusBadge.textContent = "Draft auto-saved on this device";
      statusBadge.hidden = false;
    }
    if (!editing.stale) {
      el("editor-feedback").textContent = "Draft auto-saved on this device";
      el("editor-feedback").setAttribute("data-kind", "info");
    }
  }
  return true;
}

function scheduleDraftAutoSave() {
  if (!editing || !editing.id || !editing.original || editing.busy) return;
  if (editing.retryRequestId) editing.retryRequestId = null;
  clearTimeout(draftSaveTimer);
  draftSaveTimer = setTimeout(() => {
    draftSaveTimer = null;
    if (!editing || !editing.id || !editing.original || editing.saved) return;
    saveCurrentModalDraft(true);
  }, DRAFT_DEBOUNCE_MS);
}

function discardCurrentDraft() {
  if (!editing || editing.busy) return;
  clearTimeout(draftSaveTimer);
  draftSaveTimer = null;
  const formType = editing.mode === "activity" ? "activity" : "details";
  DraftManager.clearDraft(formType, editing.id);
  editDrafts.delete(editorDraftKey(editing));
  editing.pending = null;
  editing.retryRequestId = null;
  editing.stale = false;
  if (el("draft-restore-banner")) el("draft-restore-banner").hidden = true;
  if (el("draft-autosave-status")) {
    el("draft-autosave-status").textContent = "";
    el("draft-autosave-status").hidden = true;
  }
  const record = editing.serverRecord || editing.original;
  if (record) {
    editing.original = { ...record };
    for (const field of editFields) {
      const input = el(`edit-${field}`);
      if (input) input.value = String(record[field] ?? "");
    }
    const goalVal = record.outreachGoal ?? record.goal ?? "";
    populateGoalDropdown(goalVal);
    if (editing.mode === "activity") {
      for (const field of outreachFields) {
        el(`log-${field}`).value = field === "channel" ? "Email" : field === "activityType" ? "Outreach" : "";
      }
      if (record.stage === "Not Contacted" && el("edit-stage")) {
        el("edit-stage").value = "Contacted";
      }
      renderOutreachContactPicker(editing.contacts || [], []);
    }
    if (el("edit-coldReason")) {
      el("edit-coldReason").value = record.coldReason || (record.stage === "Cold" ? DEFAULT_DECLINE_REASON : "");
    }
    const rawOwnerEmails = String(record.ownerEmail || "").split(",").map((e) => e.trim()).filter(Boolean);
    const rawAssignedNames = String(record.assignedTo || "").split(",").map((n) => n.trim()).filter(Boolean);
    const primaryEmail = (rawOwnerEmails[0] || (currentUser?.email || "")).trim().toLowerCase();
    const primaryUser = (editing.crmUsers || []).find((u) => u.email.toLowerCase() === primaryEmail);
    const primaryName = primaryUser?.name || rawAssignedNames[0] || (currentUser?.name || primaryEmail);
    const initialCollaborators = [];
    for (let i = 1; i < Math.max(rawOwnerEmails.length, rawAssignedNames.length); i++) {
      const email = (rawOwnerEmails[i] || "").trim().toLowerCase();
      const userMatch = (editing.crmUsers || []).find((u) => u.email.toLowerCase() === email);
      const name = userMatch?.name || rawAssignedNames[i] || email;
      if (email || name) initialCollaborators.push({ email, name });
    }
    editing.primaryOwner = { email: primaryEmail, name: primaryName };
    editing.collaborators = initialCollaborators;
    editing.assigneesChanged = false;
    const canEditAssignment = isSupervisor || isAssignedToMe(record);
    renderAssigneeSection(canEditAssignment);

    updateStageHelperText(el("edit-stage")?.value || record.stage || "Not Contacted");
    updateColdWarning();
    editorInputs(false);
    renderSummarySuggestions();
    updateSuggestionStates();
    updateDirtyState();
    el("editor-save").disabled = false;
    el("editor-save").textContent = editorSaveLabel(editing);
    el("editor-reload").disabled = false;
    editorFeedback("Changes save to the test spreadsheet.", "info");
  }
}

if (typeof window !== "undefined") {
  window.discardCurrentDraft = discardCurrentDraft;
}

function showSaveToast(message) {
  clearTimeout(saveToastTimer);
  el("save-toast").textContent = message; el("save-toast").hidden = false;
  saveToastTimer = setTimeout(() => { el("save-toast").hidden = true; }, 5000);
}

function closeSchoolEditor() {
  if (editing?.busy) return;
  clearTimeout(draftSaveTimer);
  draftSaveTimer = null;
  if (editing?.original && !editing.saved) {
    if (hasFormChanges(editing)) {
      saveCurrentModalDraft(false);
    } else {
      editDrafts.delete(editorDraftKey(editing));
      DraftManager.clearDraft(editing.mode === "activity" ? "activity" : "details", editing.id);
    }
  }
  if (el("draft-restore-banner")) el("draft-restore-banner").hidden = true;
  if (el("draft-autosave-status")) {
    el("draft-autosave-status").textContent = "";
    el("draft-autosave-status").hidden = true;
  }
  if (typeof closeContactForm === "function") closeContactForm(true);
  if (el("unclaim-confirm-panel")) el("unclaim-confirm-panel").hidden = true;
  if (el("editor-unclaim-btn")) el("editor-unclaim-btn").hidden = false;
  editorSeq++; editorRead?.abort(); editing = null;
  el("school-editor").close();
}

let editingContactId = null;

function renderSchoolContacts(contacts = []) {
  const container = el("contacts-list");
  if (!container) return;
  if (typeof container.replaceChildren === "function") {
    container.replaceChildren();
  } else {
    container.innerHTML = "";
  }
  if (!contacts || contacts.length === 0) {
    const empty = document.createElement("p");
    empty.className = "contacts-empty-note";
    empty.textContent = "No contacts recorded yet. Add your first contact below.";
    container.append(empty);
    return;
  }

  for (const c of contacts) {
    const card = document.createElement("div");
    card.className = `contact-item-card${c.isPrimary ? " is-primary" : ""}`;
    card.setAttribute("role", "listitem");
    card.setAttribute("data-contact-id", c.contactId);
    if (card.dataset) card.dataset.contactId = c.contactId;

    const main = document.createElement("div");
    main.className = "contact-main";

    const nameRow = document.createElement("div");
    nameRow.className = "contact-name-row";

    const nameEl = document.createElement("span");
    nameEl.className = "contact-person-name";
    nameEl.textContent = c.name;
    nameRow.append(nameEl);

    if (c.role) {
      const roleEl = document.createElement("span");
      roleEl.className = "contact-role-text";
      roleEl.textContent = `· ${c.role}`;
      nameRow.append(roleEl);
    }

    if (c.isPrimary) {
      const pBadge = document.createElement("span");
      pBadge.className = "contact-badge-primary";
      pBadge.textContent = "★ Primary";
      nameRow.append(pBadge);
    }

    if (c.category) {
      const catBadge = document.createElement("span");
      catBadge.className = `contact-badge-cat${c.category === "Student" ? " contact-badge-student" : ""}`;
      catBadge.textContent = c.category;
      nameRow.append(catBadge);
    }

    main.append(nameRow);

    const metaRow = document.createElement("div");
    metaRow.className = "contact-meta-row";

    if (c.email) {
      const emailItem = document.createElement("span");
      emailItem.className = "contact-meta-item";
      const emailLink = document.createElement("a");
      emailLink.className = "contact-meta-link";
      emailLink.href = `mailto:${c.email}`;
      emailLink.textContent = c.email;
      emailItem.append(emailLink);
      metaRow.append(emailItem);
    }

    if (c.phone) {
      const phoneItem = document.createElement("span");
      phoneItem.className = "contact-meta-item";
      phoneItem.textContent = `📞 ${c.phone}`;
      metaRow.append(phoneItem);
    }

    if (c.gradeRange) {
      const gradeItem = document.createElement("span");
      gradeItem.className = "contact-meta-item";
      gradeItem.textContent = `Grades: ${c.gradeRange}`;
      metaRow.append(gradeItem);
    }

    if (c.programGroup) {
      const progItem = document.createElement("span");
      progItem.className = "contact-meta-item";
      progItem.textContent = `Group: ${c.programGroup}`;
      metaRow.append(progItem);
    }

    if (metaRow.children.length > 0) {
      main.append(metaRow);
    }

    if (c.notes) {
      const notesEl = document.createElement("div");
      notesEl.className = "contact-notes-text";
      notesEl.textContent = c.notes;
      main.append(notesEl);
    }

    card.append(main);

    const actions = document.createElement("div");
    actions.className = "contact-actions-row";

    const editBtn = document.createElement("button");
    editBtn.type = "button";
    editBtn.className = "button secondary compact-button";
    editBtn.textContent = "Edit";
    editBtn.setAttribute("aria-label", `Edit ${c.name}`);
    editBtn.addEventListener("click", () => openContactForm(c));
    actions.append(editBtn);

    if (!c.isPrimary) {
      const setPrimaryBtn = document.createElement("button");
      setPrimaryBtn.type = "button";
      setPrimaryBtn.className = "button secondary compact-button";
      setPrimaryBtn.textContent = "Set primary";
      setPrimaryBtn.setAttribute("aria-label", `Set ${c.name} as primary contact`);
      setPrimaryBtn.addEventListener("click", () => setPrimaryContact(c.contactId));
      actions.append(setPrimaryBtn);
    }

    const deactBtn = document.createElement("button");
    deactBtn.type = "button";
    deactBtn.className = "button secondary compact-button";
    deactBtn.textContent = "Deactivate";
    deactBtn.setAttribute("aria-label", `Deactivate ${c.name}`);
    deactBtn.addEventListener("click", () => deactivateContact(c.contactId));
    actions.append(deactBtn);

    card.append(actions);
    container.append(card);
  }
}

function renderAssigneeSection(canEdit) {
  const primarySelect = el("edit-primary-owner");
  const collabsList = el("collaborators-list");
  const addSelect = el("add-collaborator-select");
  const addBtn = el("add-collaborator-btn");

  if (!primarySelect || !editing) return;

  const users = editing.crmUsers || [];

  if (typeof primarySelect.replaceChildren === "function") {
    primarySelect.replaceChildren();
  } else {
    primarySelect.innerHTML = "";
  }
  const currentPrimaryEmail = (editing.primaryOwner?.email || "").toLowerCase();
  let foundPrimary = false;

  for (const user of users) {
    const opt = document.createElement("option");
    opt.value = user.email;
    opt.textContent = `${user.name} (${user.role === "Supervisor" ? "Supervisor" : "Student"})`;
    if (user.email.toLowerCase() === currentPrimaryEmail) {
      opt.selected = true;
      foundPrimary = true;
    }
    primarySelect.append(opt);
  }

  if (!foundPrimary && editing.primaryOwner?.email) {
    const opt = document.createElement("option");
    opt.value = editing.primaryOwner.email;
    opt.textContent = editing.primaryOwner.name ? `${editing.primaryOwner.name} (${editing.primaryOwner.email})` : editing.primaryOwner.email;
    opt.selected = true;
    primarySelect.append(opt);
  }

  primarySelect.value = currentPrimaryEmail;
  primarySelect.disabled = !canEdit;

  if (typeof collabsList.replaceChildren === "function") {
    collabsList.replaceChildren();
  } else {
    collabsList.innerHTML = "";
  }
  const collabs = editing.collaborators || [];
  if (collabs.length === 0) {
    const emptySpan = document.createElement("span");
    emptySpan.className = "collaborators-empty";
    emptySpan.textContent = "No co-assignees assigned.";
    collabsList.append(emptySpan);
  } else {
    for (const collab of collabs) {
      const chip = document.createElement("span");
      chip.className = "collaborator-chip";
      const nameText = document.createElement("span");
      nameText.textContent = collab.name || collab.email;
      chip.append(nameText);

      if (canEdit) {
        const removeBtn = document.createElement("button");
        removeBtn.type = "button";
        removeBtn.className = "collaborator-chip-remove";
        removeBtn.setAttribute("aria-label", `Remove collaborator ${collab.name || collab.email}`);
        removeBtn.textContent = "✕";
        removeBtn.onclick = () => {
          editing.assigneesChanged = true;
          editing.collaborators = (editing.collaborators || []).filter((c) => c.email.toLowerCase() !== collab.email.toLowerCase());
          renderAssigneeSection(canEdit);
          updateDirtyState();
        };
        chip.append(removeBtn);
      }
      collabsList.append(chip);
    }
  }

  if (typeof addSelect.replaceChildren === "function") {
    addSelect.replaceChildren();
  } else {
    addSelect.innerHTML = "";
  }
  const defaultOpt = document.createElement("option");
  defaultOpt.value = "";
  defaultOpt.textContent = "Select team member…";
  addSelect.append(defaultOpt);

  const assignedEmails = new Set([
    currentPrimaryEmail,
    ...collabs.map((c) => c.email.toLowerCase()),
  ]);

  const availableUsers = users.filter((u) => !assignedEmails.has(u.email.toLowerCase()));

  for (const user of availableUsers) {
    const opt = document.createElement("option");
    opt.value = user.email;
    opt.textContent = `${user.name} (${user.role === "Supervisor" ? "Supervisor" : "Student"})`;
    addSelect.append(opt);
  }

  addSelect.disabled = !canEdit || availableUsers.length === 0;
  if (addBtn) addBtn.disabled = !canEdit || availableUsers.length === 0;
}

async function unclaimSchool() {
  if (!credential || !editing?.original || editing.busy) return;
  const session = sessionVersion, edit = editing;
  edit.busy = true;
  editorInputs(true);
  el("editor-save").disabled = true;
  el("editor-close").disabled = true;
  el("editor-reload").disabled = true;
  editorFeedback("Releasing school back to directory…");

  try {
    const payload = {
      recordId: edit.id,
      expectedRequestId: edit.original.lastRequestId,
      requestId: crypto.randomUUID(),
    };
    const response = await apiFetch("./api/schools/unclaim", {
      method: "POST",
      headers: { Authorization: `Bearer ${credential}`, "content-type": "application/json" },
      credentials: "omit",
      cache: "no-store",
      body: JSON.stringify(payload),
    });
    const data = await response.json();
    if (session !== sessionVersion || editing !== edit || !credential) return;

    if (response.ok) {
      edit.saved = true;
      editDrafts.delete(editorDraftKey(edit));
      editDrafts.delete(`activity:${edit.id}`);
      DraftManager.clearDraft("details", edit.id);
      DraftManager.clearDraft("activity", edit.id);
      edit.busy = false;
      closeSchoolEditor();
      showSaveToast("✓ School released to directory");
      await refresh();
      if (directory.length > 0) await loadDirectory();
    } else if (response.status === 401 || response.status === 403) {
      forgetSession();
      status("Your access changed. Please sign in again.");
      el("google-button").hidden = false;
      if (config?.ready) await showGoogleButton();
    } else if (response.status === 409 || data.code === "CONFLICT_STALE_VERSION") {
      edit.busy = false;
      edit.stale = true;
      editorFeedback("Someone changed this school. Your draft is kept. Reload school values and review before saving.", "error");
    } else {
      editorFeedback(data.message || "Failed to release school. Please try again.", "error");
    }
  } catch {
    if (session === sessionVersion && editing === edit) {
      editorFeedback("Connection interrupted. Retry releasing school.", "error");
    }
  } finally {
    if (session === sessionVersion && editing === edit) {
      edit.busy = false;
      editorInputs(false);
      el("editor-save").disabled = !!edit.stale;
      el("editor-close").disabled = false;
      el("editor-reload").disabled = false;
      if (el("unclaim-confirm-panel")) el("unclaim-confirm-panel").hidden = true;
      if (el("editor-unclaim-btn")) el("editor-unclaim-btn").hidden = false;
    }
  }
}

let unresolvedContactOp = null;

function openContactForm(contactToEdit = null) {
  if (unresolvedContactOp) {
    if (unresolvedContactOp.recordId !== editing?.id) {
      editorFeedback(`A contact save for "${unresolvedContactOp.schoolName || "another school"}" is pending verification. Please resolve or retry that operation first.`, "error");
      return;
    }
    const isSameTarget = (
      (unresolvedContactOp.action === "update" && contactToEdit && unresolvedContactOp.contactId === contactToEdit.contactId) ||
      (unresolvedContactOp.action === "create" && !contactToEdit)
    );
    if (!isSameTarget) {
      editorFeedback("An uncertain contact save is already pending verification. Please retry or resolve the pending operation first.", "error");
      return;
    }
  }

  const panel = el("contact-form-panel");
  const addBtn = el("contact-add-btn");
  if (!panel) return;
  panel.hidden = false;
  if (addBtn) addBtn.hidden = true;

  editingContactId = contactToEdit ? contactToEdit.contactId : (unresolvedContactOp?.contactId || null);
  const isRetry = Boolean(unresolvedContactOp && unresolvedContactOp.recordId === editing?.id);
  el("contact-form-heading").textContent = isRetry ? "Retry contact save" : (contactToEdit ? "Edit contact" : "Add contact");

  const draft = (unresolvedContactOp && unresolvedContactOp.recordId === editing?.id) ? unresolvedContactOp.formDraft : null;
  el("cform-name").value = draft ? draft.name : (contactToEdit?.name || "");
  el("cform-role").value = draft ? draft.role : (contactToEdit?.role || "");
  el("cform-category").value = draft ? draft.category : (contactToEdit?.category || "Administration");
  el("cform-gradeRange").value = draft ? draft.gradeRange : (contactToEdit?.gradeRange || "");
  el("cform-programGroup").value = draft ? draft.programGroup : (contactToEdit?.programGroup || "");
  el("cform-email").value = draft ? draft.email : (contactToEdit?.email || "");
  el("cform-phone").value = draft ? draft.phone : (contactToEdit?.phone || "");
  el("cform-notes").value = draft ? draft.notes : (contactToEdit?.notes || "");

  const isPrimaryBox = el("cform-isPrimary");
  if (isPrimaryBox) {
    isPrimaryBox.checked = draft ? Boolean(draft.isPrimary) : (contactToEdit ? Boolean(contactToEdit.isPrimary) : (editing?.contacts?.length === 0));
  }

  updateStudentPrivacyCallout();
  const saveBtn = el("cform-save-btn");
  if (saveBtn) {
    saveBtn.disabled = false;
    saveBtn.textContent = isRetry ? "Retry save" : "Save contact";
  }
  el("cform-name").focus();
}

const CONSUMER_EMAIL_DOMAINS = new Set([
  "gmail.com", "googlemail.com", "yahoo.com", "ymail.com", "rocketmail.com",
  "hotmail.com", "outlook.com", "live.com", "msn.com",
  "icloud.com", "me.com", "mac.com", "aol.com", "aim.com",
  "proton.me", "protonmail.com", "zoho.com", "yandex.com", "gmx.com", "mail.com",
]);

function closeContactForm(force = false) {
  if (unresolvedContactOp && !force) {
    editorFeedback("An uncertain contact save is pending. Use Retry save to check safely; your draft is kept.", "error");
    return;
  }
  const panel = el("contact-form-panel");
  const addBtn = el("contact-add-btn");
  if (panel) panel.hidden = true;
  if (addBtn) addBtn.hidden = false;
  editingContactId = null;
  const saveBtn = el("cform-save-btn");
  if (saveBtn) { saveBtn.disabled = false; saveBtn.textContent = "Save contact"; }
}

function updateStudentPrivacyCallout() {
  const cat = el("cform-category")?.value;
  const note = el("student-privacy-note");
  const phoneInput = el("cform-phone");
  const isStudent = cat === "Student";
  if (note) note.hidden = !isStudent;
  if (phoneInput) {
    if (isStudent) {
      phoneInput.value = "";
      phoneInput.disabled = true;
      phoneInput.placeholder = "Not permitted for students";
    } else {
      phoneInput.disabled = false;
      phoneInput.placeholder = "e.g., 416-555-0123";
    }
  }
}

async function saveContactFromForm() {
  if (!editing || !credential || editing.busy) return;
  const name = el("cform-name")?.value.trim();
  const role = el("cform-role")?.value.trim();
  if (!name || !role) {
    editorFeedback("Please enter a contact name and role.", "error");
    if (!name) el("cform-name")?.focus();
    else el("cform-role")?.focus();
    return;
  }

  const category = el("cform-category")?.value || "Other";
  const gradeRange = el("cform-gradeRange")?.value.trim() || "";
  const programGroup = el("cform-programGroup")?.value.trim() || "";
  const email = el("cform-email")?.value.trim() || "";
  const phone = el("cform-phone")?.value.trim() || "";
  const notes = el("cform-notes")?.value.trim() || "";
  const isPrimary = el("cform-isPrimary")?.checked || false;

  // Client-side student privacy enforcement
  if (category === "Student") {
    if (phone) {
      editorFeedback("Personal phone numbers cannot be stored for student contacts.", "error");
      el("cform-phone")?.focus();
      return;
    }
    const at = email.lastIndexOf("@");
    const domain = at !== -1 ? email.slice(at + 1).toLowerCase() : "";
    if (CONSUMER_EMAIL_DOMAINS.has(domain)) {
      editorFeedback("Consumer email addresses (such as Gmail, Yahoo, Hotmail) cannot be stored for student contacts. Please use an official school email.", "error");
      el("cform-email")?.focus();
      return;
    }
  }

  const action = editingContactId ? "update" : "create";

  // Prevent a different contact operation from replacing an unresolved one
  if (unresolvedContactOp) {
    const isSame = (
      unresolvedContactOp.recordId === editing.id &&
      unresolvedContactOp.action === action &&
      (!unresolvedContactOp.contactId || unresolvedContactOp.contactId === editingContactId)
    );
    if (!isSame) {
      editorFeedback(`A contact save for "${unresolvedContactOp.schoolName || "another school"}" is pending verification. You must retry or resolve it before performing other contact operations.`, "error");
      return;
    }
  }

  const saveBtn = el("cform-save-btn");
  if (saveBtn) { saveBtn.disabled = true; saveBtn.textContent = "Saving…"; }
  editorFeedback("Saving contact…");

  if (!unresolvedContactOp) {
    unresolvedContactOp = {
      requestId: crypto.randomUUID(),
      recordId: editing.id,
      schoolName: editing.original?.schoolName || "",
      expectedRequestId: editing.original.lastRequestId,
      action,
      contactId: editingContactId || undefined,
      contact: { name, role, category, gradeRange, programGroup, email, phone, notes, isPrimary },
      formDraft: { name, role, category, gradeRange, programGroup, email, phone, notes, isPrimary },
    };
  }
  editing.pendingContactOp = unresolvedContactOp;
  const payload = {
    requestId: unresolvedContactOp.requestId,
    recordId: unresolvedContactOp.recordId,
    expectedRequestId: unresolvedContactOp.expectedRequestId,
    action: unresolvedContactOp.action,
    contactId: unresolvedContactOp.contactId,
    contact: unresolvedContactOp.contact,
  };

  try {
    const res = await apiFetch("./api/schools/contacts", {
      method: "POST",
      headers: { Authorization: `Bearer ${credential}`, "content-type": "application/json" },
      credentials: "omit", cache: "no-store",
      body: JSON.stringify(payload),
    });
    const data = await res.json();
    if (!res.ok) {
      if (res.status === 409 && data.code === "CONFLICT_STALE_VERSION") {
        unresolvedContactOp = null;
        editing.pendingContactOp = null;
        editing.stale = true;
        editorFeedback("School was modified elsewhere. Your draft is kept; reload saved values before saving.", "error");
      } else if (res.status === 401 || res.status === 403) {
        unresolvedContactOp = null;
        editing.pendingContactOp = null;
        forgetSession(); status("Your access changed. Please sign in again.");
        el("google-button").hidden = false;
        if (config?.ready) await showGoogleButton();
        return;
      } else if (res.status === 422 || res.status === 404 || res.status === 409) {
        unresolvedContactOp = null;
        editing.pendingContactOp = null;
        editorFeedback(data.message || "Failed to save contact. Please check the fields and try again.", "error");
      } else {
        editorFeedback("Save status is uncertain. Use Retry save to check safely; your draft is kept.", "error");
      }
      return;
    }

    unresolvedContactOp = null;
    editing.pendingContactOp = null;
    editing.original.lastRequestId = data.record.lastRequestId;
    editing.original.contactName = data.record.contactName;
    editing.original.contactRole = data.record.contactRole;
    editing.original.email = data.record.email;
    editing.original.phone = data.record.phone;
    if (el("edit-contactName")) el("edit-contactName").value = data.record.contactName || "";
    if (el("edit-contactRole")) el("edit-contactRole").value = data.record.contactRole || "";
    if (el("edit-email")) el("edit-email").value = data.record.email || "";
    if (el("edit-phone")) el("edit-phone").value = data.record.phone || "";

    const outreachDraft = editDrafts.get(`activity:${editing.id}`);
    if (outreachDraft) {
      outreachDraft.original = { ...outreachDraft.original, ...data.record, lastRequestId: data.record.lastRequestId };
      if (outreachDraft.values) {
        outreachDraft.values.contactName = data.record.contactName;
        outreachDraft.values.contactRole = data.record.contactRole;
      }
      DraftManager.saveDraft("activity", editing.id, outreachDraft);
    }

    if (payload.action === "create" && data.contact) {
      if (data.contact.isPrimary) {
        editing.contacts.forEach((c) => { c.isPrimary = false; });
      }
      editing.contacts.push(data.contact);
      editing.lastCreatedContactId = data.contact.contactId;
      if (outreachDraft) {
        const existing = (outreachDraft.selectedContactIds || []).filter((id) => id && id !== "__general__");
        if (!existing.includes(data.contact.contactId)) {
          existing.push(data.contact.contactId);
        }
        outreachDraft.selectedContactIds = existing;
        DraftManager.saveDraft("activity", editing.id, outreachDraft);
      }
    } else if (payload.action === "update" && data.contact) {
      const idx = editing.contacts.findIndex((c) => c.contactId === data.contact.contactId);
      if (data.contact.isPrimary) {
        editing.contacts.forEach((c) => { c.isPrimary = false; });
      }
      if (idx !== -1) editing.contacts[idx] = data.contact;
    }

    renderSchoolContacts(editing.contacts);
    closeContactForm(true);
    editorFeedback("Contact saved to the test spreadsheet.");
    showSaveToast("✓ Contact saved");
    await refresh();
  } catch (err) {
    editorFeedback("Connection interrupted. Use Retry save; your draft is kept.", "error");
  } finally {
    if (saveBtn) {
      saveBtn.disabled = !!editing?.stale;
      saveBtn.textContent = unresolvedContactOp ? "Retry save" : "Save contact";
    }
    if (el("editor-reload")) {
      el("editor-reload").disabled = Boolean(unresolvedContactOp || editing?.pending);
    }
  }
}

async function setPrimaryContact(contactId) {
  if (!editing || !credential || editing.busy) return;

  // Prevent a different contact operation from replacing an unresolved one
  if (unresolvedContactOp) {
    const isSame = (
      unresolvedContactOp.recordId === editing.id &&
      unresolvedContactOp.action === "set_primary" &&
      unresolvedContactOp.contactId === contactId
    );
    if (!isSame) {
      editorFeedback(`A contact operation is pending verification (${unresolvedContactOp.schoolName || "previous school"}). You must retry or resolve it before performing other contact operations.`, "error");
      return;
    }
  }

  editorFeedback("Setting primary contact…");
  if (!unresolvedContactOp) {
    unresolvedContactOp = {
      requestId: crypto.randomUUID(),
      recordId: editing.id,
      schoolName: editing.original?.schoolName || "",
      expectedRequestId: editing.original.lastRequestId,
      action: "set_primary",
      contactId,
    };
  }
  editing.pendingContactOp = unresolvedContactOp;
  const payload = {
    requestId: unresolvedContactOp.requestId,
    recordId: unresolvedContactOp.recordId,
    expectedRequestId: unresolvedContactOp.expectedRequestId,
    action: unresolvedContactOp.action,
    contactId: unresolvedContactOp.contactId,
  };

  try {
    const res = await apiFetch("./api/schools/contacts", {
      method: "POST",
      headers: { Authorization: `Bearer ${credential}`, "content-type": "application/json" },
      credentials: "omit", cache: "no-store",
      body: JSON.stringify(payload),
    });
    const data = await res.json();
    if (!res.ok) {
      if (res.status === 409 || res.status === 422 || res.status === 404 || res.status === 401 || res.status === 403) {
        unresolvedContactOp = null;
        editing.pendingContactOp = null;
      }
      editorFeedback(data.message || "Failed to set primary contact.", "error");
      return;
    }

    unresolvedContactOp = null;
    editing.pendingContactOp = null;
    editing.original.lastRequestId = data.record.lastRequestId;
    editing.original.contactName = data.record.contactName;
    editing.original.contactRole = data.record.contactRole;
    editing.original.email = data.record.email;
    editing.original.phone = data.record.phone;
    if (el("edit-contactName")) el("edit-contactName").value = data.record.contactName || "";
    if (el("edit-contactRole")) el("edit-contactRole").value = data.record.contactRole || "";
    if (el("edit-email")) el("edit-email").value = data.record.email || "";
    if (el("edit-phone")) el("edit-phone").value = data.record.phone || "";

    const outreachDraft = editDrafts.get(`activity:${editing.id}`);
    if (outreachDraft) {
      outreachDraft.original = { ...outreachDraft.original, ...data.record, lastRequestId: data.record.lastRequestId };
      if (outreachDraft.values) {
        outreachDraft.values.contactName = data.record.contactName;
        outreachDraft.values.contactRole = data.record.contactRole;
      }
      DraftManager.saveDraft("activity", editing.id, outreachDraft);
    }

    editing.contacts.forEach((c) => { c.isPrimary = (c.contactId === contactId); });
    renderSchoolContacts(editing.contacts);
    editorFeedback("Primary contact updated.");
    showSaveToast("✓ Primary contact updated");
    await refresh();
  } catch (err) {
    editorFeedback("Connection interrupted. Retry setting primary contact; your action is kept.", "error");
  } finally {
    if (el("editor-reload")) el("editor-reload").disabled = Boolean(unresolvedContactOp || editing?.pending);
  }
}

async function deactivateContact(contactId) {
  if (!editing || !credential || editing.busy) return;

  // Prevent a different contact operation from replacing an unresolved one
  if (unresolvedContactOp) {
    const isSame = (
      unresolvedContactOp.recordId === editing.id &&
      unresolvedContactOp.action === "deactivate" &&
      unresolvedContactOp.contactId === contactId
    );
    if (!isSame) {
      editorFeedback(`A contact operation is pending verification (${unresolvedContactOp.schoolName || "previous school"}). You must retry or resolve it before performing other contact operations.`, "error");
      return;
    }
  }

  editorFeedback("Deactivating contact…");
  if (!unresolvedContactOp) {
    unresolvedContactOp = {
      requestId: crypto.randomUUID(),
      recordId: editing.id,
      schoolName: editing.original?.schoolName || "",
      expectedRequestId: editing.original.lastRequestId,
      action: "deactivate",
      contactId,
    };
  }
  editing.pendingContactOp = unresolvedContactOp;
  const payload = {
    requestId: unresolvedContactOp.requestId,
    recordId: unresolvedContactOp.recordId,
    expectedRequestId: unresolvedContactOp.expectedRequestId,
    action: unresolvedContactOp.action,
    contactId: unresolvedContactOp.contactId,
  };

  try {
    const res = await apiFetch("./api/schools/contacts", {
      method: "POST",
      headers: { Authorization: `Bearer ${credential}`, "content-type": "application/json" },
      credentials: "omit", cache: "no-store",
      body: JSON.stringify(payload),
    });
    const data = await res.json();
    if (!res.ok) {
      if (res.status === 409 || res.status === 422 || res.status === 404 || res.status === 401 || res.status === 403) {
        unresolvedContactOp = null;
        editing.pendingContactOp = null;
      }
      editorFeedback(data.message || "Failed to deactivate contact.", "error");
      return;
    }

    unresolvedContactOp = null;
    editing.pendingContactOp = null;
    editing.original.lastRequestId = data.record.lastRequestId;
    editing.original.contactName = data.record.contactName;
    editing.original.contactRole = data.record.contactRole;
    editing.original.email = data.record.email;
    editing.original.phone = data.record.phone;
    if (el("edit-contactName")) el("edit-contactName").value = data.record.contactName || "";
    if (el("edit-contactRole")) el("edit-contactRole").value = data.record.contactRole || "";
    if (el("edit-email")) el("edit-email").value = data.record.email || "";
    if (el("edit-phone")) el("edit-phone").value = data.record.phone || "";

    const outreachDraft = editDrafts.get(`activity:${editing.id}`);
    if (outreachDraft) {
      outreachDraft.original = { ...outreachDraft.original, ...data.record, lastRequestId: data.record.lastRequestId };
      if (outreachDraft.values) {
        outreachDraft.values.contactName = data.record.contactName;
        outreachDraft.values.contactRole = data.record.contactRole;
      }
      if (outreachDraft.selectedContactIds) {
        outreachDraft.selectedContactIds = outreachDraft.selectedContactIds.filter((id) => id !== contactId);
      }
      DraftManager.saveDraft("activity", editing.id, outreachDraft);
    }

    editing.contacts = editing.contacts.filter((c) => c.contactId !== contactId);
    if (data.record.contactName) {
      editing.contacts.forEach((c) => {
        if (c.name === data.record.contactName) c.isPrimary = true;
      });
    }
    renderSchoolContacts(editing.contacts);
    editorFeedback("Contact deactivated.");
    showSaveToast("✓ Contact deactivated");
    await refresh();
  } catch (err) {
    editorFeedback("Connection interrupted. Retry deactivating contact; your action is kept.", "error");
  } finally {
    if (el("editor-reload")) el("editor-reload").disabled = Boolean(unresolvedContactOp || editing?.pending);
  }
}

async function openSchoolEditor(id, reload = false, mode = "details") {
  if (!credential) return;
  clearTimeout(draftSaveTimer);
  draftSaveTimer = null;
  if (reload && unresolvedContactOp && unresolvedContactOp.recordId === id) {
    unresolvedContactOp = null;
  }
  const retainedActivity = reload && mode === "activity" && editing?.id === id ? outreachValues() : null;
  if (reload && !retainedActivity) {
    DraftManager.clearDraft(mode === "activity" ? "activity" : "details", id);
    editDrafts.delete(`${mode ?? "details"}:${id}`);
  }
  if (el("draft-restore-banner")) el("draft-restore-banner").hidden = true;
  if (el("draft-autosave-status")) {
    el("draft-autosave-status").textContent = "";
    el("draft-autosave-status").hidden = true;
  }
  const session = sessionVersion, seq = ++editorSeq;
  editorRead?.abort(); editorRead = new AbortController();
  editing = { id, mode, original: null, serverRecord: null, pending: null, busy: false, pendingContactOp: unresolvedContactOp?.recordId === id ? unresolvedContactOp : null };
  el("editor-kind").textContent = mode === "activity" ? "LOG OUTREACH" : "SCHOOL DETAILS";
  el("outreach-fields").hidden = mode !== "activity";
  for (const field of detailOnlyFields) el(`field-${field}`).hidden = mode === "activity";
  if (el("contacts-management")) el("contacts-management").hidden = mode === "activity";
  if (el("assignment-section")) el("assignment-section").hidden = mode === "activity";
  if (el("editor-unclaim-btn")) el("editor-unclaim-btn").hidden = true;
  if (el("unclaim-confirm-panel")) el("unclaim-confirm-panel").hidden = true;
  closeContactForm(true);
  if (el("activity-step-5")) el("activity-step-5").classList.toggle("flow-step", mode === "activity");
  if (el("activity-step-5-header")) el("activity-step-5-header").hidden = mode !== "activity";
  if (el("return-to-activity-container")) el("return-to-activity-container").hidden = mode !== "details" || !editDrafts.has(`activity:${id}`);
  const returnBtn = el("return-to-activity");
  if (returnBtn) {
    returnBtn.removeAttribute?.("data-confirming");
    returnBtn.textContent = "← Return to Log Outreach";
  }
  for (const field of outreachFields) {
    el(`log-${field}`).value = field === "channel" ? "Email" : field === "activityType" ? "Outreach" : "";
    el(`log-${field}`).required = mode === "activity" && ["outcome", "summary"].includes(field);
  }
  el("editor-title").textContent = "Loading school…"; el("editor-meta").textContent = "";
  if (el("log-contact-name")) {
    el("log-contact-name").textContent = "Loading contact…";
    el("log-contact-role").textContent = "";
    el("log-contact-card")?.classList.remove("missing");
  }
  editorFeedback("Loading saved information…");
  el("editor-save").disabled = true; el("editor-save").textContent = editorSaveLabel(editing);
  el("editor-reload").textContent = mode === "activity" ? "Reload school values" : "Reload saved values";
  el("editor-close").disabled = false; el("editor-reload").disabled = true;
  if (typeof closeContactForm === "function") closeContactForm(true);
  for (const field of editFields) {
    const input = el(`edit-${field}`);
    if (input) input.value = "";
  }
  ensureStageDropdownPopulated();
  updateStageHelperText("Not Contacted");
  populateGoalDropdown("");
  editorInputs(true);
  renderSummarySuggestions();
  updateSuggestionStates();
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
    editing.serverRecord = data.record;
    const formType = mode === "activity" ? "activity" : "details";
    const localDraft = reload ? null : DraftManager.loadDraft(formType, id);
    const memoryDraft = reload ? null : editDrafts.get(editorDraftKey(editing));
    const draft = (localDraft || memoryDraft)
      ? {
          ...(memoryDraft || {}),
          ...(localDraft || {}),
          values: { ...(memoryDraft?.values || {}), ...(localDraft?.values || {}) },
          activity: { ...(memoryDraft?.activity || {}), ...(localDraft?.activity || {}) },
          pending: memoryDraft?.pending ?? localDraft?.pending ?? null,
          original: memoryDraft?.original ?? localDraft?.original ?? null,
        }
      : null;
    editing.original = draft?.original ?? data.record; editing.pending = draft?.pending ?? null;
    editing.contacts = data.contacts || [];
    try { renderSchoolContacts(editing.contacts); } catch {}
    for (const field of editFields) {
      const input = el(`edit-${field}`);
      const draftVal = draft?.values?.[field] ?? draft?.payload?.[field] ?? draft?.[field];
      if (input) input.value = draftVal !== undefined ? String(draftVal) : String(data.record[field] ?? "");
    }
    const goalVal = draft?.values?.outreachGoal ?? draft?.values?.goal ?? draft?.payload?.outreachGoal ?? draft?.payload?.goal ?? draft?.outreachGoal ?? draft?.goal ?? data.record.outreachGoal ?? data.record.goal ?? "";
    populateGoalDropdown(goalVal);
    if (data.record) {
      if (data.record.outreachGoal !== undefined && data.record.goal === undefined) data.record.goal = data.record.outreachGoal;
      if (data.record.goal !== undefined && data.record.outreachGoal === undefined) data.record.outreachGoal = data.record.goal;
    }
    if (editing.original) {
      if (editing.original.outreachGoal !== undefined && editing.original.goal === undefined) editing.original.goal = editing.original.outreachGoal;
      if (editing.original.goal !== undefined && editing.original.outreachGoal === undefined) editing.original.outreachGoal = editing.original.goal;
    }
    const goalEl = el("edit-goal");
    if (goalEl && !goalEl._dirtyBound) {
      goalEl._dirtyBound = true;
      goalEl.addEventListener("change", () => updateDirtyState());
      goalEl.addEventListener("input", () => updateDirtyState());
    }
    if (mode === "activity") {
      const activity = retainedActivity ?? draft?.activity ?? draft?.payload ?? draft;
      if (activity) {
        for (const field of outreachFields) {
          const actVal = activity[field] ?? draft?.payload?.[field] ?? draft?.[field];
          if (actVal !== undefined) el(`log-${field}`).value = String(actVal);
        }
      }
      const hasDraftStage = (draft?.values?.stage ?? draft?.payload?.stage ?? draft?.stage) !== undefined;
      if (!hasDraftStage && data.record.stage === "Not Contacted") el("edit-stage").value = "Contacted";
      let toSelect = draft?.selectedContactIds ? [...draft.selectedContactIds] : (draft?.payload?.selectedContactIds ? [...draft.payload.selectedContactIds] : []);
      if (editing.lastCreatedContactId) {
        toSelect = toSelect.filter((id) => id && id !== "__general__");
        if (!toSelect.includes(editing.lastCreatedContactId)) {
          toSelect.push(editing.lastCreatedContactId);
        }
        delete editing.lastCreatedContactId;
      }
      renderOutreachContactPicker(editing.contacts, toSelect);
    }
    const contactName = (data.record.contactName ?? "").trim();
    const contactRole = (data.record.contactRole ?? "").trim();
    if (el("log-contact-name")) {
      el("log-contact-name").textContent = contactName || "Contact not recorded";
      el("log-contact-role").textContent = contactRole ? `· ${contactRole}` : "";
      el("log-contact-card")?.classList.toggle("missing", !contactName);
      if (el("log-contact-edit")) {
        el("log-contact-edit").textContent = contactName ? "Edit contact" : "Add contact";
        el("log-contact-edit").setAttribute("aria-label", contactName ? `Edit contact details for ${contactName}` : "Add contact details for this school");
      }
    }
    el("editor-title").textContent = data.record.schoolName;
    el("editor-meta").textContent = [data.record.schoolBoard, `Assigned to ${data.record.assignedTo || "you"}`].filter(Boolean).join(" · ");
    const day = new Date().toLocaleDateString("en-CA", { timeZone: "America/Toronto" });
    const isProtected = ["Interested", "Engaged", "Booked", "Completed"].includes(data.record.stage);
    const cold = el("edit-stage").querySelector?.('option[value="Cold"]');
    if (cold) cold.disabled = isProtected;
    editing.coldAllowed = !isProtected;
    if (el("edit-coldReason")) {
      const draftColdReason = draft?.values?.coldReason ?? draft?.payload?.coldReason ?? draft?.coldReason;
      el("edit-coldReason").value = draftColdReason !== undefined ? String(draftColdReason) : (data.record.coldReason || (data.record.stage === "Cold" ? DEFAULT_DECLINE_REASON : ""));
    }
    updateStageHelperText(el("edit-stage")?.value || data.record.stage || "Not Contacted");
    updateColdWarning();

    editing.crmUsers = data.users || [];
    const rawOwnerEmails = String(data.record.ownerEmail || "").split(",").map((e) => e.trim()).filter(Boolean);
    const rawAssignedNames = String(data.record.assignedTo || "").split(",").map((n) => n.trim()).filter(Boolean);

    const primaryEmail = (rawOwnerEmails[0] || (currentUser?.email || "")).trim().toLowerCase();
    const primaryUser = (editing.crmUsers || []).find((u) => u.email.toLowerCase() === primaryEmail);
    const primaryName = primaryUser?.name || rawAssignedNames[0] || (currentUser?.name || primaryEmail);
    const initialCollaborators = [];
    for (let i = 1; i < Math.max(rawOwnerEmails.length, rawAssignedNames.length); i++) {
      const email = (rawOwnerEmails[i] || "").trim().toLowerCase();
      const userMatch = (editing.crmUsers || []).find((u) => u.email.toLowerCase() === email);
      const name = userMatch?.name || rawAssignedNames[i] || email;
      if (email || name) {
        initialCollaborators.push({ email, name });
      }
    }

    editing.primaryOwner = draft?.primaryOwner ?? { email: primaryEmail, name: primaryName };
    editing.collaborators = draft?.collaborators ?? initialCollaborators;
    editing.assigneesChanged = Boolean(draft?.assigneesChanged);

    const canEditAssignment = isSupervisor || isAssignedToMe(data.record);
    renderAssigneeSection(canEditAssignment);
    updateDirtyState();

    if (el("assignment-section")) el("assignment-section").hidden = mode === "activity";
    if (el("editor-unclaim-btn")) el("editor-unclaim-btn").hidden = mode === "activity" || !canEditAssignment;
    if (el("unclaim-confirm-panel")) el("unclaim-confirm-panel").hidden = true;

    const staleDraft = draft?.original && draft.original.lastRequestId !== data.record.lastRequestId && !editing.pending;
    editing.stale = !!staleDraft;

    if (el("draft-restore-banner")) {
      el("draft-restore-banner").hidden = !draft;
    }
    if (el("draft-restore-text") && draft) {
      el("draft-restore-text").textContent = "Restored your unsaved draft from this device.";
    }
    if (el("draft-discard-btn")) {
      el("draft-discard-btn").disabled = Boolean(editing.pending);
    }

    if (unresolvedContactOp && unresolvedContactOp.recordId === id && mode === "details") {
      editing.pendingContactOp = unresolvedContactOp;
      if (unresolvedContactOp.action === "create" || unresolvedContactOp.action === "update") {
        openContactForm(unresolvedContactOp.contactId ? { contactId: unresolvedContactOp.contactId, ...unresolvedContactOp.formDraft } : null);
        editorFeedback("An uncertain contact save is pending. Use Retry save to check safely; your draft is kept.", "error");
      } else {
        editorFeedback(`An uncertain contact ${unresolvedContactOp.action === "set_primary" ? "primary update" : "deactivation"} is pending. Click Retry to complete safely.`, "error");
      }
    } else if (unresolvedContactOp && unresolvedContactOp.recordId !== id) {
      editorFeedback(`Notice: A contact save for "${unresolvedContactOp.schoolName || "another school"}" is pending verification.`, "info");
    } else {
      editorFeedback(staleDraft ? "Your draft is kept, but saved information changed. Reload school values and review before saving." : retainedActivity ? "Latest school values loaded. Your outreach text is kept; review stage and follow-up before saving." : draft ? "Restored your unsaved draft from this device." : "Changes save to the test spreadsheet.", staleDraft ? "error" : "info");
    }

    editorInputs(!!editing.pending);
    ensureAllEditorSuggestionPills();
    renderSummarySuggestions();
    updateSuggestionStates();
    el("editor-save").disabled = !!staleDraft; el("editor-save").textContent = editing.pending ? "Retry save" : editorSaveLabel(editing);
    el("editor-reload").disabled = Boolean(editing.pending || unresolvedContactOp);
  } catch (error) {
    if (session !== sessionVersion || seq !== editorSeq || error.name === "AbortError") return;
    editorFeedback(error.message, "error");
  }
}

async function saveSchoolEdits(event) {
  event?.preventDefault?.();
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
    if (values.stage === "Cold" && edit.coldAllowed === false) {
      const warningText = el("cold-warning")?.textContent || "This school cannot be marked Cold yet. Check the follow-up rule below.";
      editorFeedback(warningText, "error");
      return;
    }
    if (edit.mode === "activity") {
      const activity = outreachValues();
      if (!activity.outcome.trim() || !activity.summary.trim()) { editorFeedback("Add an outcome and a short description before saving.", "error"); return; }
      const contactIds = getSelectedContactIds();
      const isCold = values.stage === "Cold";
      const coldReasonVal = isCold ? (values.coldReason || el("edit-coldReason")?.value || DEFAULT_DECLINE_REASON) : undefined;
      const isExplicitRejection = isCold && (EXPLICIT_REJECTION_REASONS.includes(coldReasonVal) || activity.outcome.trim().toLowerCase() === "not interested");
      edit.pending = { recordId: edit.id, expectedRequestId: edit.original.lastRequestId, requestId: edit.retryRequestId || crypto.randomUUID(), ...activity,
        contactIds,
        followUpDue: isCold && isExplicitRejection && !values.followUpDue ? "" : values.followUpDue,
        nextAction: isCold && isExplicitRejection && !values.nextAction ? "Archived for season" : values.nextAction,
        ...(values.stage !== edit.original.stage || isCold ? { stage: values.stage } : {}),
        ...(isCold ? { coldReason: coldReasonVal, isExplicitRejection } : {}),
      };
    } else {
      if (el("add-program-select")?.value?.trim()) {
        addProgramFromControls();
        const updatedGoal = el("edit-goal")?.value ?? "";
        values.outreachGoal = updatedGoal;
        values.goal = updatedGoal;
      }

      const addSelect = el("add-collaborator-select");
      const uncommittedEmail = addSelect?.value?.trim().toLowerCase();
      if (uncommittedEmail) {
        const currentPrimaryEmail = (edit.primaryOwner?.email || "").trim().toLowerCase();
        if (uncommittedEmail !== currentPrimaryEmail && !(edit.collaborators || []).some((c) => c.email.toLowerCase() === uncommittedEmail)) {
          const foundUser = (edit.crmUsers || []).find((u) => u.email.toLowerCase() === uncommittedEmail);
          const newCollab = {
            email: uncommittedEmail,
            name: foundUser ? foundUser.name : uncommittedEmail,
          };
          if (!edit.collaborators) edit.collaborators = [];
          edit.collaborators.push(newCollab);
          edit.assigneesChanged = true;
          const canEdit = isSupervisor || isAssignedToMe(edit.original);
          renderAssigneeSection(canEdit);
          updateDirtyState();
        }
        if (addSelect) addSelect.value = "";
      }

      const origEmails = String(edit.original.ownerEmail || "").split(",").map((e) => e.trim().toLowerCase()).filter(Boolean);
      const origNames = String(edit.original.assignedTo || "").split(",").map((n) => n.trim()).filter(Boolean);

      const newEmails = [
        edit.primaryOwner?.email,
        ...(edit.collaborators || []).map((c) => c.email),
      ].filter(Boolean).map((e) => e.trim().toLowerCase());

      const newNames = [
        edit.primaryOwner?.name,
        ...(edit.collaborators || []).map((c) => c.name),
      ].filter(Boolean).map((n) => n.trim());

      const assigneesChanged = Boolean(
        edit.assigneesChanged &&
        edit.primaryOwner &&
        (newEmails.join(",") !== origEmails.join(",") || newNames.join(",") !== origNames.join(","))
      );

      if (assigneesChanged) {
        saveCurrentModalDraft(false);
        edit.busy = true; editorInputs(true);
        el("editor-save").disabled = true; el("editor-close").disabled = true; el("editor-reload").disabled = true;
        if (el("draft-discard-btn")) el("draft-discard-btn").disabled = true;
        if (el("draft-autosave-status")) el("draft-autosave-status").hidden = true;
        el("editor-save").textContent = "Saving to Google Sheet...";
        editorFeedback("Saving to Google Sheet...");

        try {
          const reassignPayload = {
            recordId: edit.id,
            expectedRequestId: edit.original.lastRequestId,
            requestId: crypto.randomUUID(),
            newOwnerEmails: newEmails,
            newOwnerNames: newNames,
          };
          const reassignResponse = await apiFetch("./api/schools/reassign", {
            method: "POST",
            headers: { Authorization: `Bearer ${credential}`, "content-type": "application/json" },
            credentials: "omit", cache: "no-store",
            body: JSON.stringify(reassignPayload),
          });
          const reassignData = await reassignResponse.json();
          if (session !== sessionVersion || editing !== edit || !credential) return;

          if (!reassignResponse.ok) {
            edit.busy = false;
            editorInputs(false);
            if (reassignResponse.status === 409 || reassignData.code === "CONFLICT_STALE_VERSION") {
              edit.stale = true;
              editorFeedback("Someone changed this school. Could not save to Google Sheet — your draft is still saved on this device. Reload school values and review before saving.", "error");
            } else if (reassignResponse.status === 401 || reassignResponse.status === 403) {
              forgetSession(); status("Your access changed. Please sign in again.");
              el("google-button").hidden = false;
              if (config?.ready) await showGoogleButton();
            } else {
              editorFeedback("Could not save to Google Sheet — your draft is still saved on this device. Please try again.", "error");
            }
            scrollEditorErrorIntoView();
            el("editor-save").disabled = !!edit.stale;
            el("editor-save").textContent = editorSaveLabel(edit);
            el("editor-close").disabled = false;
            el("editor-reload").disabled = false;
            if (el("draft-discard-btn")) el("draft-discard-btn").disabled = false;
            return;
          }

          edit.original = { ...edit.original, ...reassignData.record, lastRequestId: reassignData.record.lastRequestId };
        } catch {
          if (session === sessionVersion && editing === edit) {
            edit.busy = false;
            editorInputs(false);
            el("editor-save").disabled = false;
            el("editor-save").textContent = editorSaveLabel(edit);
            el("editor-close").disabled = false;
            el("editor-reload").disabled = false;
            if (el("draft-discard-btn")) el("draft-discard-btn").disabled = false;
            editorFeedback("Could not save to Google Sheet — your draft is still saved on this device. Please try again.", "error");
            scrollEditorErrorIntoView();
          }
          return;
        }
      }

      const patch = Object.fromEntries(Object.entries(values).filter(([key, value]) => value !== String(edit.original[key] ?? "")));
      const goalEl = el("edit-goal") || el("edit-outreachGoal");
      const selectedGoal = goalEl?.value ?? values.outreachGoal ?? "";
      const origGoal = String(edit.original.outreachGoal ?? edit.original.goal ?? "");
      if (selectedGoal !== origGoal) {
        patch.outreachGoal = selectedGoal;
        patch.goal = selectedGoal;
      } else {
        delete patch.outreachGoal;
        delete patch.goal;
      }
      if (values.stage === "Cold") {
        const coldReasonVal = values.coldReason || el("edit-coldReason")?.value || DEFAULT_DECLINE_REASON;
        if (!patch.coldReason) patch.coldReason = coldReasonVal;
        const isExplicitRejection = EXPLICIT_REJECTION_REASONS.includes(coldReasonVal);
        if (isExplicitRejection) {
          patch.isExplicitRejection = true;
          if (values.followUpDue === "" && edit.original.followUpDue) patch.followUpDue = "";
          if (values.nextAction && !patch.nextAction && values.nextAction !== edit.original.nextAction) patch.nextAction = values.nextAction;
        }
      }
      if (!Object.keys(patch).length) {
        if (assigneesChanged) {
          edit.busy = false;
          edit.saved = true;
          DraftManager.clearDraft("details", edit.id);
          editDrafts.delete(editorDraftKey(edit));
          closeSchoolEditor();
          showSaveToast("✓ School reassigned");
          await refresh();
          return;
        }
        if (edit.mode === "details" && editDrafts.has(`activity:${edit.id}`)) {
          openSchoolEditor(edit.id, false, "activity");
          return;
        }
        closeSchoolEditor(); showSaveToast("No changes to save"); return;
      }
      edit.pending = { recordId: edit.id, expectedRequestId: edit.original.lastRequestId, requestId: edit.retryRequestId || crypto.randomUUID(), patch };
    }
  }
  saveCurrentModalDraft(false);
  edit.busy = true; editorInputs(true);
  el("editor-save").disabled = true; el("editor-close").disabled = true; el("editor-reload").disabled = true;
  if (el("draft-discard-btn")) el("draft-discard-btn").disabled = true;
  if (el("draft-autosave-status")) el("draft-autosave-status").hidden = true;
  el("editor-save").textContent = "Saving to Google Sheet...";
  editorFeedback("Saving to Google Sheet...");
  try {
    const response = await apiFetch(edit.mode === "activity" ? "./api/activities" : "./api/schools/update", {
      method: "POST", headers: { Authorization: `Bearer ${credential}`, "content-type": "application/json" },
      credentials: "omit", cache: "no-store", body: JSON.stringify(edit.pending),
    });
    const data = await response.json();
    if (session !== sessionVersion || editing !== edit || !credential) return;
    if (response.ok) {
      edit.original = { ...edit.original, ...edit.pending.patch, lastRequestId: data.record.lastRequestId };
      const hasGoalInPatch = edit.pending?.patch && ("outreachGoal" in edit.pending.patch || "goal" in edit.pending.patch);
      const savedGoal = String(
        hasGoalInPatch
          ? (edit.pending.patch.outreachGoal ?? edit.pending.patch.goal ?? "")
          : (data.record?.outreachGoal ?? data.record?.goal ?? edit.original?.outreachGoal ?? edit.original?.goal ?? "")
      );
      edit.original.outreachGoal = savedGoal;
      edit.original.goal = savedGoal;
      savedSchoolGoals.set(edit.id, savedGoal);
      const syncLocalGoal = () => {
        for (const list of [schools, teamSchools]) {
          const target = (list || []).find((s) => s.recordId === edit.id);
          if (target) {
            if (edit.pending?.patch) Object.assign(target, edit.pending.patch);
            target.outreachGoal = savedGoal;
            target.goal = savedGoal;
          }
        }
        renderSchools();
        renderHome();
        renderDashboard();
        renderProgramsView();
      };
      syncLocalGoal();
      DraftManager.clearDraft(edit.mode === "activity" ? "activity" : "details", edit.id);
      edit.pending = null; edit.retryRequestId = null; edit.saved = true; editDrafts.delete(editorDraftKey(edit));
      if (el("draft-restore-banner")) el("draft-restore-banner").hidden = true;
      if (el("draft-autosave-status")) { el("draft-autosave-status").textContent = ""; el("draft-autosave-status").hidden = true; }
      const outreachDraft = editDrafts.get(`activity:${edit.id}`);
      if (outreachDraft) {
        outreachDraft.original = { ...data.record };
        if (outreachDraft.values) {
          outreachDraft.values.contactName = data.record.contactName;
          outreachDraft.values.contactRole = data.record.contactRole;
        }
        DraftManager.saveDraft("activity", edit.id, outreachDraft);
      }
      edit.busy = false;
      if (edit.mode === "details" && outreachDraft) {
        showSaveToast("✓ Contact saved");
        await refresh();
        syncLocalGoal();
        await openSchoolEditor(edit.id, false, "activity");
        return;
      }
      editorFeedback("Saved to Google Sheet!");
      closeSchoolEditor();
      showSaveToast("Saved to Google Sheet!");
      await refresh();
      syncLocalGoal();
    } else if (response.status === 401 || response.status === 403) {
      forgetSession(); status("Your access changed. Please sign in again.");
      el("google-button").hidden = false;
      if (config?.ready) await showGoogleButton();
      return;
    } else if (response.status === 409 || response.status === 422 || ["SHEETS_REJECTED", "TEST_SHEET_EDIT_ACCESS_REQUIRED"].includes(data.code)) {
      edit.pending = null;
      edit.stale = data.code === "CONFLICT_STALE_VERSION";
      editorFeedback(data.code === "CONFLICT_STALE_VERSION"
        ? "Someone changed this school. Could not save to Google Sheet — your draft is still saved on this device. Reload school values and review before saving."
        : data.code === "COLD_RULE_VIOLATION" ? (data.reason || "This school cannot be marked Cold yet. Check the follow-up rule below.")
        : data.code === "OUTREACH_DETAILS_REQUIRED" ? "Add an outcome and a short description before saving."
        : data.message
          ? `${data.message} — Could not save to Google Sheet — your draft is still saved on this device. Please try again.`
          : "Could not save to Google Sheet — your draft is still saved on this device. Please try again.", "error");
      scrollEditorErrorIntoView();
    } else if (data?.code === "COMMIT_UNCERTAIN") {
      editorFeedback("Could not save to Google Sheet — your draft is still saved on this device. Please try again. (Save status is uncertain; use Retry save.)", "error");
      scrollEditorErrorIntoView();
    } else {
      edit.retryRequestId = edit.pending?.requestId || null;
      edit.pending = null;
      editorFeedback("Could not save to Google Sheet — your draft is still saved on this device. Please try again.", "error");
      scrollEditorErrorIntoView();
    }
  } catch {
    if (session === sessionVersion && editing === edit) {
      edit.retryRequestId = edit.pending?.requestId || null;
      edit.pending = null;
      editorFeedback("Could not save to Google Sheet — your draft is still saved on this device. Please try again.", "error");
      scrollEditorErrorIntoView();
    }
  } finally {
    edit.busy = false;
    if (session === sessionVersion && editing === edit) {
      editorInputs(!!edit.pending);
      el("editor-save").disabled = !!edit.stale; el("editor-save").textContent = edit.pending ? "Retry save" : editorSaveLabel(edit);
      el("editor-close").disabled = false; el("editor-reload").disabled = !!edit.pending;
      if (el("draft-discard-btn")) el("draft-discard-btn").disabled = !!edit.pending;
    }
  }
}

let bulkSelectedIds = new Set();
let bulkStep = 1;
let bulkBatch = null;
let savedUnresolvedBatch = null;

function isUnresolvedBulkItem(item) {
  if (!item) return false;
  return ["uncertain", "blocked", "pending"].includes(item.status) || (item.status === "failed" && item.retryable);
}

function hasUnresolvedBulkRecords(batch) {
  return Boolean(batch?.items?.some(isUnresolvedBulkItem));
}

function getUnresolvedBulkCount(batch) {
  return batch?.items?.filter(isUnresolvedBulkItem).length || 0;
}

function getEligibleBulkSchools() {
  return schools.filter((school) => {
    if (school.canEdit === false) return false;
    if (isSupervisor && !isAssignedToMe(school)) return false;
    if (!isAssignedToMe(school)) return false;
    if (["Booked", "Cold"].includes(school.stage)) return false;
    return true;
  });
}

function openBulkOutreach(preSelected = []) {
  if (!credential || config?.writesEnabled !== true) return;
  const eligible = getEligibleBulkSchools();
  bulkSelectedIds = new Set(preSelected.filter((id) => eligible.some((s) => s.recordId === id)).slice(0, 20));
  bulkBatch = null;

  if (savedUnresolvedBatch && hasUnresolvedBulkRecords(savedUnresolvedBatch)) {
    const unresolvedCount = getUnresolvedBulkCount(savedUnresolvedBatch);
    if (el("bulk-unresolved-banner")) el("bulk-unresolved-banner").hidden = false;
    if (el("bulk-unresolved-text")) {
      el("bulk-unresolved-text").textContent = `${unresolvedCount} ${unresolvedCount === 1 ? "school" : "schools"} from your previous batch need review or retry.`;
    }
  } else {
    if (el("bulk-unresolved-banner")) el("bulk-unresolved-banner").hidden = true;
  }

  if (el("bulk-search")) el("bulk-search").value = "";
  if (el("bulk-channel")) el("bulk-channel").value = "Email";
  if (el("bulk-activityType")) el("bulk-activityType").value = "Outreach";
  if (el("bulk-outcome")) el("bulk-outcome").value = "No reply yet";
  if (el("bulk-summary")) el("bulk-summary").value = "";
  if (el("bulk-nextAction")) el("bulk-nextAction").value = "Follow up if no reply";
  if (el("bulk-followUpDue")) {
    const nextWeek = new Date(Date.now() + 7 * 86400000);
    const dayParts = new Intl.DateTimeFormat("en-CA", { timeZone: "America/Toronto", year: "numeric", month: "2-digit", day: "2-digit" }).formatToParts(nextWeek);
    el("bulk-followUpDue").value = ["year", "month", "day"].map((k) => dayParts.find((p) => p.type === k)?.value).join("-");
  }
  if (el("bulk-overwrite-next-steps")) el("bulk-overwrite-next-steps").checked = false;
  if (el("bulk-confirm-sent")) el("bulk-confirm-sent").checked = false;
  setBulkStep(1);
  renderBulkStep1();
  const dialog = el("bulk-outreach-dialog");
  if (dialog && !dialog.open) dialog.showModal();
}

function closeBulkOutreach(force = false) {
  const shouldBypass = force === true;
  if (bulkBatch?.inProgress) return false;
  const hasUnresolved = hasUnresolvedBulkRecords(bulkBatch);
  if (!shouldBypass && hasUnresolved) {
    const unresolvedCount = getUnresolvedBulkCount(bulkBatch);
    const msg = `You have ${unresolvedCount} unresolved ${unresolvedCount === 1 ? "save" : "saves"} waiting for confirmation or retry.\n\nClosing now will keep retry information in memory for this session, but reloading the browser will lose retry tracking.\n\nExit bulk outreach?`;
    if (typeof window !== "undefined" && window.confirm && !window.confirm(msg)) {
      return false;
    }
    savedUnresolvedBatch = bulkBatch;
  } else if (hasUnresolved) {
    savedUnresolvedBatch = bulkBatch;
  }
  const dialog = el("bulk-outreach-dialog");
  if (dialog?.open) dialog.close();
  bulkBatch = null;
  return true;
}

function setBulkStep(step) {
  bulkStep = step;
  if (el("bulk-step-1")) el("bulk-step-1").hidden = step !== 1;
  if (el("bulk-step-2")) el("bulk-step-2").hidden = step !== 2;
  if (el("bulk-step-3")) el("bulk-step-3").hidden = step !== 3;
  if (el("bulk-step-progress")) el("bulk-step-progress").hidden = step !== 4;
  if (el("bulk-dialog-close")) el("bulk-dialog-close").disabled = (step === 4 && !!bulkBatch?.inProgress);
  if (el("bulk-step-eyebrow")) {
    el("bulk-step-eyebrow").textContent = step === 1 ? "STEP 1 OF 3 · SELECT SCHOOLS"
      : step === 2 ? "STEP 2 OF 3 · LOG ACTIVITY"
      : step === 3 ? "STEP 3 OF 3 · REVIEW & CONFIRM"
      : bulkBatch?.inProgress ? "SAVING OUTREACH" : "OUTREACH RESULTS";
  }
}

function toggleBulkSchoolSelection(recordId, shouldSelect) {
  if (shouldSelect) {
    if (bulkSelectedIds.size >= 20) {
      if (el("bulk-step1-feedback")) {
        el("bulk-step1-feedback").textContent = "Maximum 20 schools can be selected at once.";
        el("bulk-step1-feedback").className = "editor-feedback error";
      }
      renderBulkStep1();
      return;
    }
    bulkSelectedIds.add(recordId);
  } else {
    bulkSelectedIds.delete(recordId);
  }
  if (el("bulk-step1-feedback")) {
    el("bulk-step1-feedback").textContent = "";
    el("bulk-step1-feedback").className = "editor-feedback";
  }
  renderBulkStep1();
}

function updateBulkSelectionHeader() {
  const count = bulkSelectedIds.size;
  if (el("bulk-select-count")) el("bulk-select-count").textContent = `${count} of 20 selected`;
  if (el("bulk-to-step2")) el("bulk-to-step2").disabled = count === 0;
}

function renderBulkStep1() {
  const query = (el("bulk-search")?.value || "").trim().toLowerCase();
  const eligible = getEligibleBulkSchools();
  const visible = eligible.filter((s) =>
    [s.schoolName, s.schoolBoard, s.geographicRegion].some((t) => (t || "").toLowerCase().includes(query))
  );

  const list = el("bulk-school-list");
  if (list) {
    list.replaceChildren();
    for (const school of visible) {
      const isSelected = bulkSelectedIds.has(school.recordId);
      const row = document.createElement("label");
      row.className = `bulk-school-item${isSelected ? " selected" : ""}`;
      row.setAttribute("data-id", school.recordId);

      const check = document.createElement("input");
      check.type = "checkbox";
      check.checked = isSelected;
      check.setAttribute("aria-label", `Select ${school.schoolName}`);
      check.onchange = (e) => {
        e.stopPropagation();
        toggleBulkSchoolSelection(school.recordId, check.checked);
      };

      const info = document.createElement("div");
      info.className = "bulk-school-item-info";
      const title = document.createElement("strong");
      title.textContent = school.schoolName;
      const meta = document.createElement("p");
      meta.className = "school-meta";
      meta.textContent = [school.schoolBoard, school.geographicRegion].filter(Boolean).join(" · ") || "Location not listed";
      info.append(title, meta);

      const badge = schoolBadge(school.stage);

      row.append(check, info, badge);
      list.append(row);
    }
  }

  if (el("bulk-empty-selectable")) el("bulk-empty-selectable").hidden = visible.length > 0;
  updateBulkSelectionHeader();
}

function renderBulkSummarySuggestions() {
  const container = el("bulk-summary-suggestion-chips");
  if (!container) return;
  const channel = el("bulk-channel")?.value || "Email";
  const activityType = el("bulk-activityType")?.value || "Outreach";
  const channelData = bulkSummarySuggestions[channel] || bulkSummarySuggestions.Email;
  const suggestions = Array.isArray(channelData) ? channelData : (channelData[activityType] || channelData.Outreach || []);
  container.replaceChildren();
  for (const item of suggestions) {
    const chip = document.createElement("button");
    chip.type = "button";
    chip.className = "suggestion-chip";
    chip.setAttribute("data-target", "bulk-summary");
    chip.setAttribute("data-value", item.value);
    chip.textContent = item.label;
    chip.onclick = () => {
      applySuggestion("bulk-summary", item.value);
      updateBulkSuggestionStates();
    };
    container.append(chip);
  }
  updateBulkSuggestionStates();
}

function updateBulkSuggestionStates() {
  if (typeof document?.querySelectorAll !== "function") return;
  const chips = document.querySelectorAll("#bulk-outreach-dialog .suggestion-chip");
  for (const chip of chips) {
    const targetId = chip.getAttribute?.("data-target");
    const value = chip.getAttribute?.("data-value");
    const input = el(targetId);
    const isMatch = Boolean(input && value && input.value.trim().toLowerCase() === value.trim().toLowerCase());
    chip.classList?.toggle("selected", isMatch);
    chip.setAttribute?.("aria-pressed", String(isMatch));
  }
}

function prepareBulkStep2() {
  const count = bulkSelectedIds.size;
  if (el("bulk-recap-count")) el("bulk-recap-count").textContent = `${count} ${count === 1 ? "school" : "schools"} selected`;

  const selectedSchools = schools.filter((s) => bulkSelectedIds.has(s.recordId));
  const notContactedSchools = selectedSchools.filter((s) => s.stage === "Not Contacted");
  const contactedSchools = selectedSchools.filter((s) => s.stage !== "Not Contacted");
  const notContactedCount = notContactedSchools.length;
  const contactedCount = contactedSchools.length;
  const activityType = el("bulk-activityType")?.value || "Outreach";

  const notice = el("bulk-qualification-notice");
  const noticeText = el("bulk-qualification-text");
  const deselectBtn = el("bulk-deselect-ineligible");
  let hasClassificationError = false;

  if (activityType === "Outreach" && contactedCount > 0) {
    hasClassificationError = true;
    if (notice) notice.hidden = false;
    if (noticeText) {
      noticeText.textContent = `First Contact cannot be applied to previously contacted schools. ${contactedCount} of your selected ${contactedCount === 1 ? "school was" : "schools were"} already contacted.`;
    }
    if (deselectBtn) {
      deselectBtn.hidden = false;
      deselectBtn.textContent = `Deselect ${contactedCount} contacted ${contactedCount === 1 ? "school" : "schools"}`;
      deselectBtn.onclick = () => {
        for (const s of contactedSchools) bulkSelectedIds.delete(s.recordId);
        renderBulkStep1();
        prepareBulkStep2();
      };
    }
  } else if (activityType === "FollowUp" && notContactedCount > 0) {
    hasClassificationError = true;
    if (notice) notice.hidden = false;
    if (noticeText) {
      noticeText.textContent = `Follow-Up cannot be applied to Not Contacted schools. ${notContactedCount} of your selected ${notContactedCount === 1 ? "school is" : "schools are"} still "Not Contacted".`;
    }
    if (deselectBtn) {
      deselectBtn.hidden = false;
      deselectBtn.textContent = `Deselect ${notContactedCount} "Not Contacted" ${notContactedCount === 1 ? "school" : "schools"}`;
      deselectBtn.onclick = () => {
        for (const s of notContactedSchools) bulkSelectedIds.delete(s.recordId);
        renderBulkStep1();
        prepareBulkStep2();
      };
    }
  } else {
    if (notice) notice.hidden = true;
    if (noticeText) noticeText.textContent = "";
    if (deselectBtn) {
      deselectBtn.hidden = true;
      deselectBtn.onclick = null;
    }
  }

  if (el("bulk-to-step3")) {
    el("bulk-to-step3").disabled = hasClassificationError || bulkSelectedIds.size === 0;
  }

  const existingPlansCount = selectedSchools.filter((s) => Boolean(s.nextAction?.trim() || s.followUpDue?.trim())).length;
  const overwriteSpan = el("bulk-overwrite-text");
  if (overwriteSpan) {
    overwriteSpan.textContent = existingPlansCount > 0
      ? `Overwrite existing Next Action and Follow-Up Date on schools that already have them (${existingPlansCount} of ${count} schools have existing plans)`
      : `Overwrite existing Next Action and Follow-Up Date on schools that already have them (0 schools currently have plans)`;
  }

  renderBulkSummarySuggestions();
}

function prepareBulkStep3() {
  const activityType = el("bulk-activityType")?.value || "Outreach";
  const outcome = el("bulk-outcome")?.value?.trim() || "";
  const summary = el("bulk-summary")?.value?.trim() || "";
  const nextAction = el("bulk-nextAction")?.value?.trim() || "";
  const followUpDue = el("bulk-followUpDue")?.value?.trim() || "";
  const overwrite = Boolean(el("bulk-overwrite-next-steps")?.checked);

  const channel = el("bulk-channel")?.value || "Email";
  const channelLabels = {
    Email: "Email",
    Text: "Text Message",
    Phone: "Phone Call",
    Visit: "School Visit",
    Meeting: "Meeting",
    Social: "Social Media",
  };
  if (el("bulk-rev-channel")) el("bulk-rev-channel").textContent = channelLabels[channel] || channel;
  if (el("bulk-rev-type")) el("bulk-rev-type").textContent = activityType === "FollowUp" ? "Follow-up (Adds 1 to count)" : "First contact (Initial outreach)";
  if (el("bulk-rev-outcome")) el("bulk-rev-outcome").textContent = outcome;
  if (el("bulk-rev-summary")) el("bulk-rev-summary").textContent = summary;
  if (el("bulk-rev-action")) el("bulk-rev-action").textContent = nextAction || "None specified";
  if (el("bulk-rev-due")) el("bulk-rev-due").textContent = followUpDue || "None scheduled";
  if (el("bulk-rev-count")) el("bulk-rev-count").textContent = String(bulkSelectedIds.size);

  const list = el("bulk-review-schools-list");
  if (list) {
    list.replaceChildren();
    const selectedSchools = schools.filter((s) => bulkSelectedIds.has(s.recordId));
    for (const school of selectedSchools) {
      const item = document.createElement("div");
      item.className = "bulk-review-item";

      const nameWrap = document.createElement("div");
      nameWrap.className = "bulk-review-school-name";
      const name = document.createElement("span");
      name.textContent = school.schoolName;
      const meta = document.createElement("span");
      meta.className = "school-meta";
      meta.textContent = [school.schoolBoard, school.geographicRegion].filter(Boolean).join(" · ");
      nameWrap.append(name, meta);

      const trans = document.createElement("div");
      trans.className = "bulk-review-transition";

      const stageTag = document.createElement("span");
      if (school.stage === "Not Contacted") {
        stageTag.className = "bulk-review-tag";
        stageTag.textContent = "Not Contacted → Contacted";
      } else {
        stageTag.className = "bulk-review-tag bulk-review-preserved";
        stageTag.textContent = `${school.stage} (Preserved)`;
      }

      const countTag = document.createElement("span");
      countTag.className = "bulk-review-tag bulk-review-preserved";
      countTag.textContent = activityType === "FollowUp" ? "Count +1" : "Count unchanged";

      const hasPlan = Boolean(school.nextAction?.trim() || school.followUpDue?.trim());
      const planTag = document.createElement("span");
      planTag.className = "bulk-review-tag bulk-review-preserved";
      if (hasPlan && !overwrite) {
        planTag.textContent = "Existing plan kept";
      } else if (nextAction || followUpDue) {
        planTag.textContent = "Plan will update";
      } else {
        planTag.textContent = "No plan change";
      }

      trans.append(stageTag, countTag, planTag);
      item.append(nameWrap, trans);
      list.append(item);
    }
  }

  if (el("bulk-confirm-sent")) el("bulk-confirm-sent").checked = false;
  if (el("bulk-submit-save")) {
    el("bulk-submit-save").disabled = true;
    el("bulk-submit-save").textContent = `Log outreach for ${bulkSelectedIds.size} ${bulkSelectedIds.size === 1 ? "school" : "schools"}`;
  }
  if (el("bulk-step3-feedback")) el("bulk-step3-feedback").textContent = "";
}

async function executeBulkBatch(isRetry = false) {
  if (!credential || !bulkBatch || bulkBatch.inProgress) return;
  bulkBatch.inProgress = true;
  bulkBatch.stopped = false;
  bulkBatch.stopReason = "";
  setBulkStep(4);
  updateBulkProgressUI();

  const items = bulkBatch.items;
  const progressBar = el("bulk-progress-bar");
  if (progressBar) {
    progressBar.max = items.length;
    progressBar.value = items.filter((it) => it.status === "success").length;
  }

  for (let i = 0; i < items.length; i++) {
    const item = items[i];
    if (item.status === "success") continue;
    // Do not blindly retry validation failures or permanent rejections
    if (isRetry && item.retryable === false) continue;

    // Requirement 1: For a confirmed rejected operation, create a fresh request ID when retrying an unchanged valid request
    // Preserve original request ID and payload for uncertain writes
    if (isRetry && item.isConfirmedRejection) {
      item.requestId = crypto.randomUUID();
      if (item.payload) {
        item.payload.requestId = item.requestId;
      }
      item.isConfirmedRejection = false;
    }

    item.status = "saving";
    updateBulkProgressUI(i);

    try {
      if (!item.payload) {
        let schoolDetail = null;
        try {
          const detailRes = await apiFetch(`./api/schools/detail?recordId=${encodeURIComponent(item.school.recordId)}`, {
            headers: { Authorization: `Bearer ${credential}` }, credentials: "omit", cache: "no-store",
          });
          if (detailRes.ok) {
            const detailData = await detailRes.json();
            if (detailData && detailData.record) {
              schoolDetail = detailData.record;
            }
          }
        } catch {
          // Network or server fetch error
        }

        if (!schoolDetail) {
          // If fresh school details cannot be retrieved, fail safely rather than using potentially outdated cached information.
          item.status = "failed";
          item.error = "Could not retrieve fresh school information. Save skipped for safety.";
          item.code = "DETAIL_FETCH_FAILED";
          item.retryable = true;
          item.isConfirmedRejection = false;
          updateBulkProgressUI(i);
          continue;
        }

        const currentStage = schoolDetail.stage;

        if (schoolDetail.canEdit === false) {
          item.status = "conflict";
          item.error = "You can only edit schools assigned to you.";
          item.code = "NOT_OWNER";
          item.retryable = false;
          item.isConfirmedRejection = false;
          updateBulkProgressUI(i);
          continue;
        }

        if (isSupervisor) {
          const authEmail = (currentUser?.email || (credential ? parseJwtPayload(credential)?.email : "") || "").trim().toLowerCase();
          const ownerEmails = (typeof schoolDetail.ownerEmail === "string" ? schoolDetail.ownerEmail : "")
            .toLowerCase()
            .split(",")
            .map((e) => e.trim())
            .filter(Boolean);
          if (!authEmail || !ownerEmails.includes(authEmail)) {
            item.status = "conflict";
            item.error = "Supervisors can only bulk-log schools they personally own.";
            item.code = "NOT_OWNER";
            item.retryable = false;
            item.isConfirmedRejection = false;
            updateBulkProgressUI(i);
            continue;
          }
        }

        // Skip schools that have become Booked or Cold
        if (["Booked", "Cold"].includes(currentStage)) {
          item.status = "conflict";
          item.error = `School is now ${currentStage}. Outreach skipped.`;
          item.code = "STAGE_INELIGIBLE";
          item.retryable = false;
          item.isConfirmedRejection = false;
          updateBulkProgressUI(i);
          continue;
        }

        // First Contact requires the current stage to be Not Contacted
        if (bulkBatch.activityType === "Outreach" && currentStage !== "Not Contacted") {
          item.status = "conflict";
          item.error = `First Contact requires "Not Contacted" stage. School is now ${currentStage}.`;
          item.code = "STAGE_MISMATCH";
          item.retryable = false;
          item.isConfirmedRejection = false;
          updateBulkProgressUI(i);
          continue;
        }

        // Follow-Up requires an already-contacted, eligible stage
        if (bulkBatch.activityType === "FollowUp" && currentStage === "Not Contacted") {
          item.status = "conflict";
          item.error = `Follow-Up requires an already-contacted school.`;
          item.code = "STAGE_MISMATCH";
          item.retryable = false;
          item.isConfirmedRejection = false;
          updateBulkProgressUI(i);
          continue;
        }

        const payload = {
          recordId: item.school.recordId,
          expectedRequestId: schoolDetail.lastRequestId || item.school.lastRequestId || crypto.randomUUID(),
          requestId: item.requestId,
          channel: bulkBatch.channel || "Email",
          activityType: bulkBatch.activityType,
          outcome: bulkBatch.outcome,
          summary: bulkBatch.summary,
        };

        if (schoolDetail.stage === "Not Contacted") {
          payload.stage = "Contacted";
        }

        const hasExistingAction = Boolean(schoolDetail.nextAction?.trim());
        const hasExistingDue = Boolean(schoolDetail.followUpDue?.trim());

        if (bulkBatch.overwriteExisting || !hasExistingAction) {
          if (bulkBatch.nextAction) payload.nextAction = bulkBatch.nextAction;
        }
        if (bulkBatch.overwriteExisting || !hasExistingDue) {
          if (bulkBatch.followUpDue) payload.followUpDue = bulkBatch.followUpDue;
        }

        item.payload = payload;
      }

      const response = await apiFetch("./api/activities", {
        method: "POST",
        headers: { Authorization: `Bearer ${credential}`, "content-type": "application/json" },
        credentials: "omit", cache: "no-store",
        body: JSON.stringify(item.payload),
      });
      const data = await response.json();

      if (response.ok) {
        item.status = "success";
        item.error = "";
        item.code = "SUCCESS";
        item.retryable = false;
        item.isConfirmedRejection = false;
      } else if (response.status === 409 && data.code === "CONFLICT_STALE_VERSION") {
        item.status = "conflict";
        item.error = "School was updated elsewhere. Changes not applied.";
        item.code = "CONFLICT_STALE_VERSION";
        item.retryable = false;
        item.isConfirmedRejection = false;
      } else if (response.status === 503 || response.status === 504 || ["SAVE_UNAVAILABLE", "WORKBOOK_BLOCKED", "COMMIT_UNCERTAIN", "COORDINATOR_UNAVAILABLE", "GOOGLE_CONNECTION_UNAVAILABLE", "PROOF_UNAVAILABLE"].includes(data.code)) {
        // Requirement 2: Ambiguous server failures (503 SAVE_UNAVAILABLE, WORKBOOK_BLOCKED, COMMIT_UNCERTAIN, etc.)
        // Treat as uncertain (or blocked for WORKBOOK_BLOCKED), preserve original request ID and identical payload, and stop the batch until safely reconciled!
        item.status = data.code === "WORKBOOK_BLOCKED" ? "blocked" : "uncertain";
        item.error = data.code === "WORKBOOK_BLOCKED"
          ? "Workbook is blocked by coordinator. Batch stopped for safety."
          : (data.message || "Save status uncertain upstream. Batch stopped to protect workbook.");
        item.code = data.code || "SAVE_UNAVAILABLE";
        item.retryable = true;
        item.isConfirmedRejection = false; // Uncertain write: preserve requestId and payload!
        bulkBatch.stopped = true;
        bulkBatch.stopReason = data.message || (data.code === "WORKBOOK_BLOCKED"
          ? "Workbook is blocked by coordinator. Batch stopped for safety."
          : "Server reported save unavailable. Batch stopped safely to protect the workbook and prevent duplicate writes.");
        updateBulkProgressUI();
        break;
      } else if (response.status === 401 || response.status === 403) {
        if (data.code === "NOT_OWNER") {
          item.status = "conflict";
          item.error = "You can only edit schools assigned to you.";
          item.code = "NOT_OWNER";
          item.retryable = false;
          item.isConfirmedRejection = false;
        } else {
          item.status = "failed";
          item.error = "Session expired or access revoked.";
          item.code = data.code || "AUTH_FAILED";
          item.retryable = false;
          item.isConfirmedRejection = false;
          bulkBatch.stopped = true;
          bulkBatch.stopReason = "Your session expired. Please sign in again.";
          updateBulkProgressUI();
          break;
        }
      } else if (response.status === 400 || response.status === 422) {
        // Validation failures: do not blindly retry
        item.status = "failed";
        item.error = data.message || "Spreadsheet rejected save due to invalid input.";
        item.code = data.code || "VALIDATION_FAILED";
        item.retryable = false;
        item.isConfirmedRejection = false;
      } else if (response.status === 502 && ["SHEETS_REJECTED", "TEST_SHEET_EDIT_ACCESS_REQUIRED"].includes(data.code)) {
        // Conclusively rejected operation: upstream Sheets rejected write cleanly without mutating
        // For a confirmed rejected operation, create a fresh request ID when retrying an unchanged valid request
        item.status = "failed";
        item.error = data.message || "Spreadsheet rejected save.";
        item.code = data.code || "SHEETS_REJECTED";
        item.retryable = true;
        item.isConfirmedRejection = true;
      } else {
        // Any other ambiguous server error (e.g. 500) -> treat as uncertain, preserve requestId and payload, stop the batch!
        item.status = "uncertain";
        item.error = data.message || "Save status uncertain upstream. Batch stopped for safety.";
        item.code = data.code || "SERVER_ERROR";
        item.retryable = true;
        item.isConfirmedRejection = false;
        bulkBatch.stopped = true;
        bulkBatch.stopReason = data.message || "Server error encountered. Batch stopped safely to protect the workbook.";
        updateBulkProgressUI();
        break;
      }
    } catch {
      // Requirement 3: Network interruption -> outcome is uncertain!
      // Keep affected request ID and payload for safe retry, and STOP the batch immediately!
      item.status = "uncertain";
      item.error = "Connection interrupted during save.";
      item.code = "CONNECTION_ERROR";
      item.retryable = true;
      item.isConfirmedRejection = false;
      bulkBatch.stopped = true;
      bulkBatch.stopReason = "Network connection interrupted during save. Batch stopped safely to protect the workbook and prevent duplicate writes. Retry once your connection is restored.";
      updateBulkProgressUI();
      break;
    }

    if (progressBar) progressBar.value = items.filter((it) => it.status === "success").length;
    updateBulkProgressUI();
  }

  bulkBatch.inProgress = false;
  finalizeBulkBatch();
}

function updateBulkProgressUI(currentIndex = -1) {
  if (!bulkBatch) return;
  const items = bulkBatch.items;
  const successCount = items.filter((it) => it.status === "success").length;
  const total = items.length;

  if (el("bulk-progress-status")) {
    if (bulkBatch.inProgress && currentIndex >= 0 && currentIndex < total) {
      el("bulk-progress-status").textContent = `Saving ${currentIndex + 1} of ${total}: ${items[currentIndex].school.schoolName}…`;
    } else if (bulkBatch.inProgress) {
      el("bulk-progress-status").textContent = `Saving outreach… (${successCount} of ${total} completed)`;
    } else {
      el("bulk-progress-status").textContent = `Batch complete: ${successCount} of ${total} schools saved.`;
    }
  }

  const list = el("bulk-results-list");
  if (list) {
    list.replaceChildren();
    for (const item of items) {
      const row = document.createElement("div");
      row.className = "bulk-result-row";

      const schoolInfo = document.createElement("div");
      schoolInfo.className = "bulk-result-school";
      const name = document.createElement("span");
      name.textContent = item.school.schoolName;
      const desc = document.createElement("span");
      desc.className = "bulk-result-desc";
      desc.textContent = item.status === "saving" ? "Saving outreach to spreadsheet…"
        : item.status === "success" ? "Outreach recorded in Activity Log"
        : item.error || "Waiting in queue…";
      schoolInfo.append(name, desc);

      const pill = document.createElement("span");
      pill.className = `bulk-status-pill status-${item.status}`;
      pill.textContent = item.status === "saving" ? "Saving…"
        : item.status === "success" ? "✓ Saved"
        : item.status === "conflict" ? "⚠ Conflict"
        : item.status === "uncertain" ? "⚠ Uncertain"
        : item.status === "blocked" ? "🛑 Blocked"
        : item.status === "failed" ? "✕ Failed"
        : "Pending";

      row.append(schoolInfo, pill);
      list.append(row);
    }
  }
}

function renderBulkResultsView() {
  if (!bulkBatch) return;
  const items = bulkBatch.items;
  const successCount = items.filter((it) => it.status === "success").length;
  const conflictCount = items.filter((it) => it.status === "conflict").length;
  const uncertainCount = items.filter((it) => it.status === "uncertain").length;
  const blockedCount = items.filter((it) => it.status === "blocked").length;
  const retryableCount = items.filter((it) => it.retryable && it.status !== "success").length;
  const total = items.length;

  setBulkStep(4);
  updateBulkProgressUI();

  if (bulkBatch.stopped) {
    if (el("bulk-blocked-alert")) {
      el("bulk-blocked-alert").hidden = false;
      if (el("bulk-blocked-message")) el("bulk-blocked-message").textContent = bulkBatch.stopReason || "Batch stopped safely.";
    }
  } else {
    if (el("bulk-blocked-alert")) el("bulk-blocked-alert").hidden = true;
  }

  if (el("bulk-final-summary")) {
    if (successCount === total) {
      el("bulk-final-summary").textContent = `✓ All ${total} schools were saved successfully to Google Sheets.`;
      el("bulk-final-summary").className = "editor-feedback";
    } else {
      const parts = [`${successCount} saved`];
      if (conflictCount > 0) parts.push(`${conflictCount} conflicts`);
      if (uncertainCount > 0) parts.push(`${uncertainCount} uncertain`);
      if (blockedCount > 0) parts.push(`${blockedCount} blocked`);
      const otherFailed = total - successCount - conflictCount - uncertainCount - blockedCount;
      if (otherFailed > 0) parts.push(`${otherFailed} remaining`);
      el("bulk-final-summary").textContent = `Finished with ${parts.join(", ")}.`;
      el("bulk-final-summary").className = (retryableCount > 0 || uncertainCount > 0 || blockedCount > 0) ? "editor-feedback error" : "editor-feedback";
    }
  }

  if (el("bulk-retry-failed")) {
    el("bulk-retry-failed").hidden = retryableCount === 0;
    el("bulk-retry-failed").textContent = `Retry eligible saves (${retryableCount})`;
  }

  if (el("bulk-reload-note")) {
    el("bulk-reload-note").textContent = "Session & reload limit: Retry tracking is maintained in memory during your active browser session. If you reload this page or your session expires, in-flight retry tracking cannot be recovered.";
  }

  if (el("bulk-finish-done")) {
    el("bulk-finish-done").hidden = false;
    el("bulk-finish-done").textContent = successCount === total ? "Done" : "Done with remaining";
  }
}

function finalizeBulkBatch() {
  if (!bulkBatch) return;
  const items = bulkBatch.items;
  const successCount = items.filter((it) => it.status === "success").length;

  if (hasUnresolvedBulkRecords(bulkBatch)) {
    savedUnresolvedBatch = bulkBatch;
  }

  renderBulkResultsView();

  if (successCount > 0) {
    showSaveToast(`✓ Logged outreach for ${successCount} ${successCount === 1 ? "school" : "schools"}`);
    refresh();
  }
}

function updateWorkspaceHeading() {
  if (el("tab-home")) el("tab-home").textContent = isSupervisor ? "H4 Overview" : "My Outreach";
  if (el("tab-my-schools")) el("tab-my-schools").textContent = isSupervisor ? "Schools" : "My Schools";
  if (el("workspace-heading")) el("workspace-heading").textContent = currentTab === "home" ? isSupervisor ? "H4 Overview." : "My Outreach." : currentTab === "dashboard" ? "Team Progress." : currentTab === "programs" ? "Program Tracks." : currentTab === "directory" ? "Find your next school." : isSupervisor ? "School overview." : "Your schools.";
  if (el("workspace-description")) el("workspace-description").textContent = currentTab === "home" ? isSupervisor ? "A clear view of the program. A little support where it counts." : "Your next step, without the guesswork." : currentTab === "dashboard" ? "Coordinate your outreach. Make every connection count." : currentTab === "programs" ? "Manage flagship tracks, triage school health, and track completed deliveries." : currentTab === "directory" ? "Browse available schools and start a new connection." : isSupervisor ? "School assignments across H4." : "Your assigned schools, ready for your next connection.";
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
  el("tab-my-schools")?.classList.toggle("active", tab === "my-schools");
  el("tab-my-schools")?.setAttribute("aria-selected", String(tab === "my-schools"));
  el("tab-programs")?.classList.toggle("active", tab === "programs");
  el("tab-programs")?.setAttribute("aria-selected", String(tab === "programs"));
  if (el("programs-view")) {
    el("programs-view").hidden = tab !== "programs";
    el("programs-view").classList?.toggle("hidden", tab !== "programs");
  }
  el("tab-directory")?.classList.toggle("active", tab === "directory");
  el("tab-directory")?.setAttribute("aria-selected", String(tab === "directory"));
  el("tab-demo-claim")?.classList.toggle("active", tab === "demo-claim");
  el("tab-demo-claim")?.setAttribute("aria-selected", String(tab === "demo-claim"));

  if (el("schools-view")) el("schools-view").hidden = tab !== "my-schools";
  if (el("directory-view")) el("directory-view").hidden = tab !== "directory";
  if (el("demo-view")) el("demo-view").hidden = tab !== "demo-claim";

  if (tab === "programs") {
    renderProgramsView();
    if (!dashboardLoaded && !isSupervisor && credential) loadDashboard();
  }
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
function normalizeSheetDate(dateInput) {
  if (!dateInput || typeof dateInput !== "string") return "";
  const str = dateInput.trim();
  if (!str) return "";
  const isoMatch = /^(\d{4})-(\d{1,2})-(\d{1,2})$/.exec(str);
  if (isoMatch) {
    const year = Number(isoMatch[1]);
    const month = Number(isoMatch[2]);
    const day = Number(isoMatch[3]);
    if (month < 1 || month > 12 || day < 1 || day > 31) return "";
    const padded = `${String(year).padStart(4, "0")}-${String(month).padStart(2, "0")}-${String(day).padStart(2, "0")}`;
    const parsed = new Date(`${padded}T00:00:00Z`);
    if (Number.isNaN(parsed.getTime()) || parsed.toISOString().slice(0, 10) !== padded) return "";
    return padded;
  }
  const slashMatch = /^(\d{1,2})\/(\d{1,2})\/(\d{4})$/.exec(str);
  if (slashMatch) {
    const month = Number(slashMatch[1]);
    const day = Number(slashMatch[2]);
    const year = Number(slashMatch[3]);
    if (month < 1 || month > 12 || day < 1 || day > 31) return "";
    const padded = `${String(year).padStart(4, "0")}-${String(month).padStart(2, "0")}-${String(day).padStart(2, "0")}`;
    const parsed = new Date(`${padded}T00:00:00Z`);
    if (Number.isNaN(parsed.getTime()) || parsed.toISOString().slice(0, 10) !== padded) return "";
    return padded;
  }
  return "";
}
function dueState(school, today = dashboardToday()) {
  const due = school?.followUpDue || school?.followUpDate;
  // Only unambiguous ISO dates are compared. Preserve other sheet formatting as text.
  if (["Booked", "Cold", "Completed"].includes(school?.stage) || typeof due !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(due)
    || Number.isNaN(Date.parse(due)) || new Date(due).toISOString().slice(0, 10) !== due) return "none";
  return due < today ? "overdue" : due === today ? "today" : "upcoming";
}
function overdueSchool(school, today) { return dueState(school, today) === "overdue"; }
function isOverdue(dateStrOrSchool, today = dashboardToday()) {
  if (!dateStrOrSchool) return false;
  if (typeof dateStrOrSchool === "object") {
    if (["Booked", "Cold", "Completed"].includes(dateStrOrSchool.stage)) return false;
    const due = dateStrOrSchool.followUpDue || dateStrOrSchool.followUpDate || "";
    return isOverdue(due, today);
  }
  if (typeof dateStrOrSchool !== "string" || !dateStrOrSchool.trim()) return false;
  try {
    const normalized = normalizeSheetDate(dateStrOrSchool);
    if (!normalized) return false;
    return normalized < today;
  } catch {
    return false;
  }
}
if (typeof window !== "undefined") {
  window.isOverdue = isOverdue;
  window.normalizeSheetDate = normalizeSheetDate;
}
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
  const suggested = school.stage === "Not Contacted" ? "Make your first contact" : school.stage === "Booked" ? "Confirm workshop details" : school.stage === "Completed" ? "Send invoice / feedback survey" : school.stage === "Cold" ? "No outreach planned" : "Plan your next follow-up";
  card.append(dashboardNode("p", school.nextAction?.trim() ? `Next: ${school.nextAction}` : `Suggested: ${suggested}`, "action-next"));
  const due = dueState(school);
  card.append(dashboardNode("p", school.followUpDue ? `Follow-up: ${school.followUpDue}${due === "overdue" ? " · Overdue" : due === "today" ? " · Today" : ""}` : "No follow-up reminder set", due === "overdue" ? "action-date dashboard-due" : "action-date"));
}
function schoolBadge(stage, label) {
  const meta = getStageMeta(stage);
  const displayLabel = label !== undefined ? label : (STAGE_CONFIG[stage]?.display || meta.display || stage || "Stage not set");
  const badge = dashboardNode("span", displayLabel, "school-stage");
  if (meta.badgeClass) badge.classList.add(meta.badgeClass);
  if (stage === "Contacted") badge.classList.add("contacted");
  if (["Interested", "Engaged"].includes(stage)) badge.classList.add("warm");
  if (stage === "Booked") badge.classList.add("booked");
  if (stage === "Completed") badge.classList.add("completed", "badge-completed");
  if (stage === "Cold" || stage === "Not Contacted" || !stage) badge.classList.add("cold");
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
  const programBadges = createProgramBadges(school.outreachGoal || school.goal || "");
  card.append(badge, ...programBadges, dashboardNode("h3", school.schoolName));
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
  const container = el(id);
  if (!container) return;
  container.replaceChildren?.();
  for (const [label, count, onSelect] of entries) {
    const metric = dashboardNode(onSelect ? "button" : "div", "", "dashboard-metric");
    if (onSelect) { metric.type = "button"; metric.onclick = onSelect; metric.setAttribute("aria-label", `${label}: ${count}`); }
    metric.append(dashboardNode("strong", String(count)), dashboardNode("span", label)); container.append(metric);
  }
}
function reviewSchools(filter, label, stage = "") {
  schoolScopeFilter = filter;
  schoolScopeLabel = label; schoolStageFilter = stage; el("search").value = "";
  if (!filter && !stage) supervisorSchoolScope = "all";
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
  if (el("home-bulk-log")) {
    el("home-bulk-log").disabled = config?.writesEnabled !== true;
    el("home-bulk-log").hidden = isSupervisor;
  }
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
  const visible = teamSchools.filter((school) => (!stage || stageKey(school) === stage) && (!owner || assignee(school).split(",").map((s) => s.trim()).includes(owner))
    && (!overdueOnly || overdue(school)) && [school.schoolName, school.schoolBoard, school.geographicRegion].some((text) => (text || "").toLowerCase().includes(query)))
    .sort((a, b) => Number(overdue(b)) - Number(overdue(a)) || a.schoolName.localeCompare(b.schoolName));
  el("dashboard-rows").replaceChildren();
  for (const school of visible) {
    const row = document.createElement("tr");
    const cell = (label) => { const td = document.createElement("td"); td.setAttribute("data-label", label); row.append(td); return td; };
    cell("School").append(dashboardNode("strong", school.schoolName), dashboardNode("span", [school.schoolBoard, school.geographicRegion].filter(Boolean).join(" · "), "dashboard-school-meta"));
    cell("Assigned to").textContent = assignee(school);
    const badge = schoolBadge(school.stage);
    const programBadges = createProgramBadges(school.outreachGoal || school.goal || "");
    cell("Stage").append(badge, ...programBadges);
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
    for (const s of teamSchools) {
      const rawGoal = s.outreachGoal || s.goal || savedSchoolGoals.get(s.recordId) || "";
      if (rawGoal || s.outreachGoal !== undefined || s.goal !== undefined) {
        s.outreachGoal = rawGoal;
        s.goal = rawGoal;
      }
    }
    dashboardOptions("dashboard-owner", "Everyone", [...new Set(teamSchools.flatMap((s) => (s.assignedTo || "").split(",").map((n) => n.trim()).filter(Boolean)))].sort());
    dashboardOptions("dashboard-stage", "All stages", [...pipelineStages, ...(teamSchools.some((s) => stageKey(s) === otherStage) ? [otherStage] : [])]);
    renderDashboard();
    renderProgramsView();
    el("dashboard-content").hidden = false;
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

function getProgramScopedSchools() {
  const byId = new Map();
  for (const s of (schools || [])) {
    if (s && s.recordId) byId.set(s.recordId, s);
  }
  for (const ts of (teamSchools || [])) {
    if (!ts || !ts.recordId) continue;
    if (byId.has(ts.recordId)) {
      const existing = byId.get(ts.recordId);
      const rawGoal = existing.outreachGoal || existing.goal || ts.outreachGoal || ts.goal || savedSchoolGoals.get(ts.recordId) || "";
      if (rawGoal) {
        existing.outreachGoal = rawGoal;
        existing.goal = rawGoal;
      }
    } else {
      const rawGoal = ts.outreachGoal || ts.goal || savedSchoolGoals.get(ts.recordId) || "";
      if (rawGoal) {
        ts.outreachGoal = rawGoal;
        ts.goal = rawGoal;
      }
      byId.set(ts.recordId, ts);
    }
  }
  const allList = byId.size > 0 ? Array.from(byId.values()) : [...(schools || []), ...(teamSchools || [])];
  const myList = allList.filter(isAssignedToMe);
  const activeList = programsScope === "all" ? allList : myList;
  return { myList, allList, activeList };
}

function categorizeSchoolsForProgram(arg1, arg2 = getProgramScopedSchools().activeList, today = dashboardToday()) {
  let programName;
  let schoolList;
  if (Array.isArray(arg1)) {
    schoolList = arg1;
    programName = arg2;
  } else {
    programName = arg1;
    schoolList = Array.isArray(arg2) ? arg2 : getProgramScopedSchools().activeList;
  }
  const target = String(programName || "").trim().toLowerCase();
  const confirmed = [];
  const onTheFence = [];
  const waitingOnReply = [];
  const cold = [];
  const completed = [];
  const needsAttention = [];
  const active = [];
  if (!target) {
    return {
      confirmed,
      onTheFence,
      waitingOnReply,
      cold,
      completed,
      needsAttention,
      active,
      total: 0,
    };
  }
  for (const school of (schoolList || [])) {
    if (!school) continue;
    const rawGoal = savedSchoolGoals.get(school.recordId) || school.outreachGoal || school.goal || "";
    const tracks = parseProgramTracks(rawGoal);
    const match = tracks.find((track) => track.name.toLowerCase() === target);
    if (!match) continue;
    const isCompleted = match.completed === true || match.status === "Completed" || school.stage === "Completed";
    if (isCompleted) {
      completed.push(school);
      continue;
    }
    const rawStage = String(school.stage || "").trim();
    if (rawStage === "Booked") {
      confirmed.push(school);
    } else if (rawStage === "Engaged" || rawStage === "Interested") {
      onTheFence.push(school);
    } else if (rawStage === "Contacted") {
      waitingOnReply.push(school);
    } else {
      cold.push(school);
    }
    const dueDate = school.followUpDue || school.followUpDate || "";
    const isOverdueFollowUp = (
      isOverdue(school, today) ||
      (!["Booked", "Cold", "Completed"].includes(rawStage) && isOverdue(dueDate, today))
    );
    if (isOverdueFollowUp) {
      needsAttention.push(school);
    } else {
      active.push(school);
    }
  }
  const total = confirmed.length + onTheFence.length + waitingOnReply.length + cold.length + completed.length;
  return {
    confirmed,
    onTheFence,
    waitingOnReply,
    cold,
    completed,
    needsAttention,
    active,
    total,
  };
}

function programAttentionReasons(school, today = dashboardToday()) {
  const reasons = attentionReasons(school, today);
  if ((school?.priority === "High" || school?.priority === "Urgent") && !reasons.some((r) => r.includes("priority"))) {
    reasons.unshift(`${school.priority} priority`);
  }
  if (!["Booked", "Cold", "Completed"].includes(school?.stage) && isOverdue(school?.followUpDue || school?.followUpDate, today) && !reasons.includes("Overdue follow-up")) {
    reasons.unshift("Overdue follow-up");
  }
  return reasons;
}

function setProgramStatusFilter(bucket = "all") {
  const normalized = String(bucket || "all").trim();
  if (!normalized || normalized === "all" || programStatusFilter === normalized) {
    programStatusFilter = "all";
  } else {
    programStatusFilter = normalized;
  }
  renderProgramsView();
}

function selectProgram(programName = "") {
  const nextProgram = String(programName || "").trim();
  if (nextProgram.toLowerCase() !== selectedProgram.toLowerCase()) {
    programStatusFilter = "all";
  }
  selectedProgram = nextProgram;
  const moreSelect = el("more-programs-select");
  if (moreSelect) {
    moreSelect.value = SECONDARY_PROGRAMS.includes(selectedProgram) ? selectedProgram : "";
  }
  if (el("quick-tag-feedback")) el("quick-tag-feedback").textContent = "";
  renderProgramsView();
}

function setProgramsScope(scope) {
  programsScope = scope === "all" ? "all" : "mine";
  if (programsScope === "all" && !dashboardLoaded && !isSupervisor && credential) {
    loadDashboard();
  }
  renderProgramsView();
}

function ensureProgramsNavPopulated(activeList, today) {
  const pillContainer = el("programs-primary-pills");
  const primarySpecs = [
    { id: "program-pill-all", program: "", label: "All Programs" },
    { id: "program-pill-cypher", program: "Cypher Program", label: "Cypher Program" },
    { id: "program-pill-competitive", program: "Competitive Arts", label: "Competitive Arts" },
    { id: "program-pill-btheerise", program: "B Thee Rise", label: "B Thee Rise" },
    { id: "program-pill-shsm", program: "SHSM", label: "SHSM" },
  ];
  for (const spec of primarySpecs) {
    const btn = el(spec.id);
    if (!btn) continue;
    btn.type = "button";
    btn.setAttribute("data-program", spec.program);
    const existingChildren = pillContainer?.children ? Array.from(pillContainer.children) : [];
    if (pillContainer && !existingChildren.includes(btn)) {
      pillContainer.append(btn);
    }
    const isActive = selectedProgram.toLowerCase() === spec.program.toLowerCase();
    btn.className = `program-nav-pill${isActive ? " active" : ""}`;
    btn.setAttribute("aria-pressed", String(isActive));
    btn.replaceChildren?.();
    if (!spec.program) {
      btn.textContent = spec.label;
    } else {
      const count = categorizeSchoolsForProgram(spec.program, activeList, today).total;
      const badge = dashboardNode("span", String(count), "program-pill-count");
      btn.append(dashboardNode("span", spec.label), badge);
    }
    btn.onclick = () => selectProgram(spec.program);
  }

  const moreSelect = el("more-programs-select");
  if (moreSelect) {
    moreSelect.replaceChildren?.();
    const placeholder = dashboardNode("option", "More programs…");
    placeholder.value = "";
    moreSelect.append(placeholder);
    for (const tag of SECONDARY_PROGRAMS) {
      const count = categorizeSchoolsForProgram(tag, activeList, today).total;
      const opt = dashboardNode("option", `${tag} (${count})`);
      opt.value = tag;
      moreSelect.append(opt);
    }
    moreSelect.value = SECONDARY_PROGRAMS.some((t) => t.toLowerCase() === selectedProgram.toLowerCase())
      ? SECONDARY_PROGRAMS.find((t) => t.toLowerCase() === selectedProgram.toLowerCase())
      : "";
  }
}

async function quickTagSchoolToProgram() {
  const select = el("quick-tag-school-select");
  const btn = el("quick-tag-school-btn");
  const feedback = el("quick-tag-feedback");
  const recordId = String(select?.value || "").trim();
  const programName = String(selectedProgram || "").trim();
  if (!recordId || !programName) {
    if (feedback) feedback.textContent = "Select a school first to add it to this program.";
    return false;
  }
  const { allList } = getProgramScopedSchools();
  const school = allList.find((s) => s.recordId === recordId) || schools.find((s) => s.recordId === recordId);
  if (!school) return false;

  const existingTracks = parseProgramTracks(school.outreachGoal || school.goal || "");
  if (!existingTracks.some((t) => t.name.toLowerCase() === programName.toLowerCase())) {
    existingTracks.push({ name: programName, status: "Active", completed: false });
  }
  const newGoal = serializeProgramTracks(existingTracks);

  if (btn) btn.disabled = true;
  if (feedback) feedback.textContent = `Adding ${school.schoolName} to ${programName}…`;

  const applyLocalGoalUpdate = (lastReqId) => {
    savedSchoolGoals.set(recordId, newGoal);
    for (const list of [schools, teamSchools]) {
      const target = (list || []).find((s) => s.recordId === recordId);
      if (target) {
        target.outreachGoal = newGoal;
        target.goal = newGoal;
        if (lastReqId) target.lastRequestId = lastReqId;
      }
    }
    school.outreachGoal = newGoal;
    school.goal = newGoal;
    if (lastReqId) school.lastRequestId = lastReqId;
  };

  if (!credential) {
    applyLocalGoalUpdate(school.lastRequestId);
    if (feedback) feedback.textContent = `Added ${school.schoolName} to ${programName}.`;
    renderProgramsView();
    renderSchools();
    renderHome();
    renderDashboard();
    return true;
  }

  const session = sessionVersion;
  const requestId = crypto.randomUUID();
  const payload = {
    recordId: school.recordId,
    expectedRequestId: school.lastRequestId || crypto.randomUUID(),
    requestId,
    patch: { outreachGoal: newGoal, goal: newGoal },
  };

  try {
    const response = await apiFetch("./api/schools/update", {
      method: "POST",
      headers: { Authorization: `Bearer ${credential}`, "content-type": "application/json" },
      credentials: "omit",
      cache: "no-store",
      body: JSON.stringify(payload),
    });
    const data = await response.json().catch(() => ({}));
    if (session !== sessionVersion || !credential) return false;
    if (response.ok) {
      applyLocalGoalUpdate(data.record?.lastRequestId || requestId);
      if (feedback) feedback.textContent = `✓ Added ${school.schoolName} to ${programName}.`;
      showSaveToast(`✓ Added to ${programName}`);
      renderProgramsView();
      renderSchools();
      renderHome();
      renderDashboard();
      return true;
    } else {
      if (feedback) feedback.textContent = data.message || "Could not update program tags for this school.";
      return false;
    }
  } catch {
    if (session === sessionVersion && feedback) {
      feedback.textContent = "Connection interrupted while saving program tag.";
    }
    return false;
  } finally {
    if (btn && session === sessionVersion) {
      btn.disabled = config?.writesEnabled === false;
    }
  }
}

function renderProgramsView() {
  try {
    const view = el("programs-view");
    if (!view) return;
    const today = dashboardToday();
    const { myList, allList, activeList } = getProgramScopedSchools();

    const btnMine = el("programs-toggle-mine");
    const btnAll = el("programs-toggle-all");
    if (btnMine) {
      btnMine.textContent = `My Schools (${myList.length})`;
      const isMine = programsScope !== "all";
      btnMine.classList?.toggle("active", isMine);
      btnMine.setAttribute?.("aria-pressed", String(isMine));
    }
    if (btnAll) {
      btnAll.textContent = `All Team Schools (${allList.length})`;
      const isAll = programsScope === "all";
      btnAll.classList?.toggle("active", isAll);
      btnAll.setAttribute?.("aria-pressed", String(isAll));
    }

    ensureProgramsNavPopulated(activeList, today);

    const matrixEl = el("programs-overview-matrix");
    const drilldownEl = el("programs-drilldown");
    const headingEl = el("programs-heading");
    const subheadingEl = el("programs-subheading");
    const statusEl = el("programs-status");

    if (!selectedProgram) {
      if (headingEl) headingEl.textContent = "Program tracks at a glance.";
      if (subheadingEl) subheadingEl.textContent = "Track flagship programs, pipeline health, and completed deliveries across schools.";
      if (statusEl) {
        statusEl.textContent = `Showing ${programsScope === "all" ? "All Team Schools" : "My Schools"} (${activeList.length} ${activeList.length === 1 ? "school" : "schools"})`;
      }
      if (matrixEl) {
        matrixEl.hidden = false;
        matrixEl.classList?.remove("hidden");
        matrixEl.replaceChildren?.();

        const activeSecondary = SECONDARY_PROGRAMS.filter(
          (prog) => categorizeSchoolsForProgram(prog, activeList, today).total > 0
        );
        const programsToRender = [...FLAGSHIP_PROGRAMS, ...activeSecondary];

        for (const prog of programsToRender) {
          const isFlagship = FLAGSHIP_PROGRAMS.includes(prog);
          const stats = categorizeSchoolsForProgram(prog, activeList, today);
          const card = dashboardNode(
            "button",
            "",
            `school-card program-summary-card${isFlagship ? " flagship-program-card" : ""}`
          );
          card.type = "button";
          card.setAttribute("data-program", prog);
          card.setAttribute(
            "aria-label",
            `${prog}: Needs attention ${stats.needsAttention.length}, Active pipeline ${stats.active.length}, Completed ${stats.completed.length}`
          );

          const headerRow = dashboardNode("div", "", "program-card-header");
          const eyebrow = dashboardNode(
            "span",
            isFlagship ? "Flagship Track" : "Program Track",
            `program-card-eyebrow${isFlagship ? " is-flagship" : ""}`
          );
          const totalBadge = dashboardNode(
            "span",
            `${stats.total} ${stats.total === 1 ? "school" : "schools"}`,
            "program-card-total"
          );
          headerRow.append(eyebrow, totalBadge);

          const title = dashboardNode("h3", prog, "program-card-title");

          const kpiRow = dashboardNode("div", "", "program-kpi-pills");
          const pillConfirmed = dashboardNode(
            "span",
            `Confirmed: ${stats.confirmed.length}`,
            `program-kpi-pill kpi-confirmed${stats.confirmed.length > 0 ? " has-count" : ""}`
          );
          const pillFence = dashboardNode(
            "span",
            `On the Fence: ${stats.onTheFence.length}`,
            `program-kpi-pill kpi-fence${stats.onTheFence.length > 0 ? " has-count" : ""}`
          );
          const pillWaiting = dashboardNode(
            "span",
            `Waiting on Reply: ${stats.waitingOnReply.length}`,
            `program-kpi-pill kpi-waiting${stats.waitingOnReply.length > 0 ? " has-count" : ""}`
          );
          const pillCold = dashboardNode(
            "span",
            `Cold: ${stats.cold.length}`,
            `program-kpi-pill kpi-cold${stats.cold.length > 0 ? " has-count" : ""}`
          );
          const pillAttention = dashboardNode(
            "span",
            `Overdue Follow-Up: ${stats.needsAttention.length}`,
            `program-kpi-pill kpi-attention${stats.needsAttention.length > 0 ? " has-count" : ""}`
          );
          const pillCompleted = dashboardNode(
            "span",
            `Completed: ${stats.completed.length}`,
            `program-kpi-pill kpi-completed${stats.completed.length > 0 ? " has-count" : ""}`
          );
          kpiRow.append(pillConfirmed, pillFence, pillWaiting, pillCold, pillAttention, pillCompleted);

          card.append(headerRow, title, kpiRow);
          card.onclick = () => selectProgram(prog);
          matrixEl.append(card);
        }
      }
      if (drilldownEl) {
        drilldownEl.hidden = true;
        drilldownEl.classList?.add("hidden");
      }
      return;
    }

    // View Mode 2: Single Program Drill-Down
    const buckets = categorizeSchoolsForProgram(selectedProgram, activeList, today);
    const activeFilter = programStatusFilter || "all";
    if (headingEl) headingEl.textContent = selectedProgram;
    if (subheadingEl) {
      subheadingEl.textContent = FLAGSHIP_PROGRAMS.includes(selectedProgram)
        ? `Flagship program track · ${buckets.total} tagged ${buckets.total === 1 ? "school" : "schools"} in ${programsScope === "all" ? "All Team Schools" : "My Schools"}.`
        : `Program track · ${buckets.total} tagged ${buckets.total === 1 ? "school" : "schools"} in ${programsScope === "all" ? "All Team Schools" : "My Schools"}.`;
    }
    if (statusEl) {
      statusEl.textContent = `${selectedProgram} · ${buckets.total} ${buckets.total === 1 ? "school" : "schools"} (${buckets.confirmed.length} confirmed, ${buckets.onTheFence.length} on the fence, ${buckets.waitingOnReply.length} waiting on reply, ${buckets.cold.length} cold, ${buckets.needsAttention.length} overdue follow-up, ${buckets.completed.length} completed)`;
    }

    if (matrixEl) {
      matrixEl.hidden = true;
      matrixEl.classList?.add("hidden");
    }
    if (drilldownEl) {
      drilldownEl.hidden = false;
      drilldownEl.classList?.remove("hidden");
    }

    const kpiStrip = el("programs-kpi-strip");
    if (kpiStrip) {
      kpiStrip.replaceChildren?.();
      const statCards = [
        { key: "all", label: "All", count: buckets.total, accentClass: "stat-all" },
        { key: "confirmed", label: "Confirmed", count: buckets.confirmed.length, accentClass: "stat-confirmed" },
        { key: "onTheFence", label: "On the Fence", count: buckets.onTheFence.length, accentClass: "stat-fence" },
        { key: "waitingOnReply", label: "Waiting on Reply", count: buckets.waitingOnReply.length, accentClass: "stat-waiting" },
        { key: "cold", label: "Cold", count: buckets.cold.length, accentClass: "stat-cold" },
        { key: "needsAttention", label: "Overdue Follow-Up", count: buckets.needsAttention.length, accentClass: "stat-attention" },
      ];
      for (const spec of statCards) {
        const isPressed = activeFilter === spec.key;
        const btn = dashboardNode(
          "button",
          "",
          `dashboard-metric program-stat-card ${spec.accentClass}${isPressed ? " active is-active" : ""}`
        );
        btn.type = "button";
        btn.setAttribute("data-status-filter", spec.key);
        btn.setAttribute("aria-pressed", String(isPressed));
        btn.setAttribute("aria-label", `${spec.label}: ${spec.count}`);
        btn.append(
          dashboardNode("strong", String(spec.count), "stat-card-count"),
          dashboardNode("span", spec.label, "stat-card-label")
        );
        btn.onclick = () => setProgramStatusFilter(spec.key);
        kpiStrip.append(btn);
      }
    }

    const quickSelect = el("quick-tag-school-select");
    if (quickSelect) {
      const prevVal = quickSelect.value;
      quickSelect.replaceChildren?.();
      const placeholder = dashboardNode("option", "Select a school…");
      placeholder.value = "";
      quickSelect.append(placeholder);

      const untaggedSchools = activeList
        .filter((s) => {
          const tracks = parseProgramTracks(s.outreachGoal || s.goal || "");
          return !tracks.some((t) => t.name.toLowerCase() === selectedProgram.toLowerCase());
        })
        .sort((a, b) => (a.schoolName || "").localeCompare(b.schoolName || ""));

      for (const s of untaggedSchools) {
        const opt = dashboardNode("option", s.schoolName);
        opt.value = s.recordId;
        quickSelect.append(opt);
      }
      quickSelect.value = untaggedSchools.some((s) => s.recordId === prevVal) ? prevVal : "";
    }

    const quickBtn = el("quick-tag-school-btn");
    if (quickBtn) {
      quickBtn.textContent = `+ Add School to ${selectedProgram}`;
      quickBtn.disabled = config?.writesEnabled === false;
    }

    const prioritySectionSpecs = [
      {
        bucket: "confirmed",
        sectionId: "programs-section-confirmed",
        title: "Confirmed",
        listId: "programs-confirmed-list",
        countId: "programs-confirmed-count",
        emptyId: "programs-confirmed-empty",
        items: buckets.confirmed,
        isAttention: false,
      },
      {
        bucket: "onTheFence",
        sectionId: "programs-section-fence",
        title: "On the Fence",
        listId: "programs-fence-list",
        countId: "programs-fence-count",
        emptyId: "programs-fence-empty",
        items: buckets.onTheFence,
        isAttention: false,
      },
      {
        bucket: "needsAttention",
        sectionId: "programs-section-attention",
        title: "Overdue Follow-Up",
        listId: "programs-attention-list",
        countId: "programs-attention-count",
        emptyId: "programs-attention-empty",
        items: buckets.needsAttention,
        isAttention: true,
      },
      {
        bucket: "waitingOnReply",
        sectionId: "programs-section-waiting",
        title: "Waiting on Reply",
        listId: "programs-waiting-list",
        countId: "programs-waiting-count",
        emptyId: "programs-waiting-empty",
        items: buckets.waitingOnReply,
        isAttention: false,
      },
      {
        bucket: "cold",
        sectionId: "programs-section-cold",
        title: "Cold",
        listId: "programs-cold-list",
        countId: "programs-cold-count",
        emptyId: "programs-cold-empty",
        items: buckets.cold,
        isAttention: false,
      },
      {
        bucket: "completed",
        sectionId: "programs-section-completed",
        title: "Completed",
        listId: "programs-completed-list",
        countId: "programs-completed-count",
        emptyId: "programs-completed-empty",
        items: buckets.completed,
        isAttention: false,
      },
    ];

    if (el("programs-section-active")) {
      el("programs-section-active").hidden = true;
      el("programs-section-active").classList?.add("hidden");
    }

    for (const spec of prioritySectionSpecs) {
      const sectionNode = el(spec.sectionId);
      const listNode = el(spec.listId);
      const countNode = el(spec.countId);
      const emptyNode = el(spec.emptyId);
      const isVisible = activeFilter === "all" || activeFilter === spec.bucket;

      if (sectionNode) {
        sectionNode.classList?.add("programs-triage-section");
        sectionNode.setAttribute?.("data-bucket", spec.bucket);
        sectionNode.hidden = !isVisible;
        sectionNode.classList?.toggle("hidden", !isVisible);
        if (drilldownEl && sectionNode.parentElement !== drilldownEl) {
          drilldownEl.append?.(sectionNode);
        }
        const sectionChildren = sectionNode.children ? Array.from(sectionNode.children) : [];
        if (listNode && !sectionChildren.includes(listNode)) {
          sectionNode.append?.(listNode);
        }
      }
      if (countNode) {
        countNode.textContent = String(spec.items.length);
      }
      if (listNode) {
        if (isVisible) {
          listNode.replaceChildren?.(
            ...spec.items.map((school) => actionCard(school, spec.isAttention ? programAttentionReasons(school, today) : []))
          );
        } else {
          listNode.replaceChildren?.();
        }
      }
      if (emptyNode) {
        emptyNode.hidden = !isVisible || spec.items.length > 0;
      }
    }
  } catch (err) {
    console.error("[Programs View Render Error]", err);
  }
}

if (typeof window !== "undefined") {
  window.FLAGSHIP_PROGRAMS = FLAGSHIP_PROGRAMS;
  window.SECONDARY_PROGRAMS = SECONDARY_PROGRAMS;
  window.categorizeSchoolsForProgram = categorizeSchoolsForProgram;
  window.renderProgramsView = renderProgramsView;
  window.selectProgram = selectProgram;
  window.setProgramsScope = setProgramsScope;
  window.setProgramStatusFilter = setProgramStatusFilter;
  window.quickTagSchoolToProgram = quickTagSchoolToProgram;
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

async function loadConfig() {
  if (config?.ready) return config;
  const response = await apiFetch("./api/config", { cache: "no-store", credentials: "omit" });
  if (!response.ok) throw new Error("Config unavailable");
  config = await response.json();
  el("tab-demo-claim").hidden = config.demoAvailable === false;
  return config;
}

async function refresh() {
  if (!credential) return;
  if (!config?.ready) {
    try {
      await loadConfig();
    } catch {
      refreshFailed(browserOffline() ? "You’re not connected. Reconnect, then try again." : "We couldn’t reach the app. Please try again.");
      return;
    }
  }
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
    currentUser = data.currentUser;
    schools = data.schools;
    for (const s of schools) {
      const rawGoal = s.outreachGoal || s.goal || savedSchoolGoals.get(s.recordId) || "";
      if (rawGoal || s.outreachGoal !== undefined || s.goal !== undefined) {
        s.outreachGoal = rawGoal;
        s.goal = rawGoal;
      }
    }
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
    renderSchools();
    renderHome();
    try {
      renderProgramsView();
    } catch (programsErr) {
      console.error("[Programs View Init Error]", programsErr);
    }
    el("welcome").hidden = true; el("workspace").hidden = false;
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
    console.error("[Init Failure]", error);
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
    setConnection(false);
    return;
  }
  let loadingGoogle = false;
  try {
    await loadConfig();
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
  } catch (err) {
    console.error("[Init Failure]", err);
    finishRestore(credential ? "We couldn’t restore your workspace. Please try again." : "We couldn’t reach the app. Please try again.");
    status(browserOffline() ? "You’re not connected. Reconnect, then try again."
      : loadingGoogle ? "Google sign-in couldn’t load. Please try again."
      : "We couldn’t reach the app. Please try again.");
  }
}

el("sign-out")?.addEventListener("click", () => {
  forgetSession(); window.google?.accounts?.id.disableAutoSelect();
  status("You’re signed out."); el("google-button").hidden = false;
  showGoogleButton().catch(() => { el("retry").hidden = false; });
});
el("restore-sign-in")?.addEventListener("click", () => {
  forgetSession();
  finishRestore("Continue with Google to return to your workspace.");
  if (config?.ready) showGoogleButton().catch(() => {});
});
el("editor-form")?.addEventListener("submit", saveSchoolEdits);
el("editor-close")?.addEventListener("click", closeSchoolEditor);
el("editor-reload")?.addEventListener("click", () => { if (editing) openSchoolEditor(editing.id, true, editing.mode); });
el("draft-discard-btn")?.addEventListener("click", discardCurrentDraft);
el("school-editor")?.addEventListener("cancel", (event) => { event.preventDefault(); closeSchoolEditor(); });
el("edit-primary-owner")?.addEventListener("change", (e) => {
  if (!editing) return;
  editing.assigneesChanged = true;
  const newEmail = e.target.value.toLowerCase();
  const foundUser = (editing.crmUsers || []).find((u) => u.email.toLowerCase() === newEmail);
  editing.primaryOwner = {
    email: newEmail,
    name: foundUser ? foundUser.name : (editing.primaryOwner?.name || newEmail),
  };
  editing.collaborators = (editing.collaborators || []).filter((c) => c.email.toLowerCase() !== newEmail);
  const canEdit = isSupervisor || isAssignedToMe(editing.original);
  renderAssigneeSection(canEdit);
  updateDirtyState();
  scheduleDraftAutoSave();
});
el("add-collaborator-select")?.addEventListener("change", () => {
  updateDirtyState();
  scheduleDraftAutoSave();
});
el("add-collaborator-btn")?.addEventListener("click", () => {
  if (!editing) return;
  const select = el("add-collaborator-select");
  const selectedEmail = select?.value.trim().toLowerCase();
  if (!selectedEmail) return;

  const currentPrimaryEmail = (editing.primaryOwner?.email || "").trim().toLowerCase();
  if (selectedEmail === currentPrimaryEmail) return;
  if ((editing.collaborators || []).some((c) => c.email.toLowerCase() === selectedEmail)) return;

  editing.assigneesChanged = true;
  const foundUser = (editing.crmUsers || []).find((u) => u.email.toLowerCase() === selectedEmail);
  const newCollab = {
    email: selectedEmail,
    name: foundUser ? foundUser.name : selectedEmail,
  };
  if (!editing.collaborators) editing.collaborators = [];
  editing.collaborators.push(newCollab);

  if (select) select.value = "";
  const canEdit = isSupervisor || isAssignedToMe(editing.original);
  renderAssigneeSection(canEdit);
  updateDirtyState();
  scheduleDraftAutoSave();
});
el("editor-form")?.addEventListener("input", () => {
  updateDirtyState();
  scheduleDraftAutoSave();
});
el("editor-form")?.addEventListener("change", () => {
  updateDirtyState();
  scheduleDraftAutoSave();
});
for (const field of editFields) {
  if (field === "outreachGoal") continue;
  el(`edit-${field}`)?.addEventListener("input", () => {
    updateDirtyState();
    scheduleDraftAutoSave();
  });
  el(`edit-${field}`)?.addEventListener("change", () => {
    updateDirtyState();
    scheduleDraftAutoSave();
  });
}
for (const field of outreachFields) {
  el(`log-${field}`)?.addEventListener("input", () => {
    updateDirtyState();
    scheduleDraftAutoSave();
  });
  el(`log-${field}`)?.addEventListener("change", () => {
    updateDirtyState();
    scheduleDraftAutoSave();
  });
}
el("edit-goal")?.addEventListener("change", () => {
  updateDirtyState();
  scheduleDraftAutoSave();
});
el("edit-goal")?.addEventListener("input", () => {
  updateDirtyState();
  scheduleDraftAutoSave();
});
el("add-program-select")?.addEventListener("change", () => {
  updateDirtyState();
  scheduleDraftAutoSave();
});
el("add-program-status")?.addEventListener("change", () => {
  updateDirtyState();
  scheduleDraftAutoSave();
});
el("add-program-btn")?.addEventListener("click", () => {
  if (!editing) return;
  addProgramFromControls();
  scheduleDraftAutoSave();
});
el("editor-unclaim-btn")?.addEventListener("click", () => {
  el("unclaim-confirm-panel").hidden = false;
  el("editor-unclaim-btn").hidden = true;
});
el("unclaim-cancel-btn")?.addEventListener("click", () => {
  el("unclaim-confirm-panel").hidden = true;
  el("editor-unclaim-btn").hidden = false;
});
el("unclaim-confirm-btn")?.addEventListener("click", async () => {
  await unclaimSchool();
});
function bindEditorSuggestionChips() {
  const chips = document.querySelectorAll?.(".quick-date-chip");
  if (chips) {
    for (const chip of chips) {
      const days = chip.getAttribute?.("data-days");
      if (days !== null && days !== undefined) {
        chip.onclick = () => {
          chip._handledClick = true;
          applyQuickDate(days);
        };
      }
    }
  }
}

el("editor-form").addEventListener("click", (event) => {
  const chip = event.target.closest?.(".suggestion-chip");
  if (!chip) return;
  if (chip._handledClick) {
    chip._handledClick = false;
    return;
  }
  const days = chip.getAttribute?.("data-days");
  if (days !== null && days !== undefined && days !== "") {
    applyQuickDate(days);
    return;
  }
  const targetId = chip.getAttribute("data-target");
  const value = chip.getAttribute("data-value");
  if (targetId && value) applySuggestion(targetId, value);
});
el("log-outcome")?.addEventListener("input", updateSuggestionStates);
el("log-summary")?.addEventListener("input", updateSuggestionStates);
el("edit-nextAction")?.addEventListener("input", updateSuggestionStates);
el("edit-followUpDue")?.addEventListener("input", updateSuggestionStates);
el("edit-followUpDue")?.addEventListener("change", updateSuggestionStates);
ensureAllEditorSuggestionPills();
el("log-channel")?.addEventListener("change", () => {
  renderSummarySuggestions();
  updateSuggestionStates();
});
el("log-activityType")?.addEventListener("change", () => {
  renderSummarySuggestions();
  updateSuggestionStates();
});
el("edit-stage")?.addEventListener("change", () => {
  const stage = el("edit-stage")?.value;
  if (stage === "Completed") {
    if (el("edit-nextAction") && (!el("edit-nextAction").value.trim() || el("edit-nextAction").value === "Follow up if no reply" || el("edit-nextAction").value === "Confirm workshop details")) {
      el("edit-nextAction").value = "Send invoice / feedback survey";
    }
    updateSuggestionStates();
  }
  if (stage === "Cold") {
    const reasonInput = el("edit-coldReason");
    if (reasonInput && !reasonInput.value) reasonInput.value = DEFAULT_DECLINE_REASON;
    const reason = reasonInput?.value || DEFAULT_DECLINE_REASON;
    if (EXPLICIT_REJECTION_REASONS.includes(reason)) {
      if (el("edit-followUpDue")) el("edit-followUpDue").value = "";
      if (el("edit-nextAction") && (!el("edit-nextAction").value || el("edit-nextAction").value === "Follow up if no reply")) {
        el("edit-nextAction").value = "Archived for season";
      }
    }
  } else {
    if (el("edit-coldReason") && !editing?.original?.coldReason) {
      el("edit-coldReason").value = "";
    }
  }
  updateColdWarning();
  updateStageHelperText(stage || "Not Contacted");
});
ensureStageDropdownPopulated();
updateStageHelperText(el("edit-stage")?.value || "Not Contacted");
el("edit-coldReason")?.addEventListener("change", () => {
  const reason = el("edit-coldReason")?.value;
  if (EXPLICIT_REJECTION_REASONS.includes(reason)) {
    if (el("edit-followUpDue")) el("edit-followUpDue").value = "";
    if (el("edit-nextAction") && (!el("edit-nextAction").value || el("edit-nextAction").value === "Follow up if no reply")) {
      el("edit-nextAction").value = "Archived for season";
    }
  }
  updateColdWarning();
});
el("log-contact-edit")?.addEventListener("click", editSchoolContact);
el("log-contact-add-quick")?.addEventListener("click", editSchoolContact);
el("contact-choice-general")?.addEventListener("change", () => {
  const genBox = el("contact-choice-general");
  const genCard = el("contact-choice-general-card");
  if (genBox?.checked) {
    genCard?.classList.add("is-selected");
    const named = document.querySelectorAll(".named-contact-checkbox");
    named.forEach((cb) => {
      cb.checked = false;
      cb.closest(".outreach-contact-card")?.classList.remove("is-selected");
    });
  } else {
    genCard?.classList.remove("is-selected");
  }
  updateSelectedContactsSummary();
  updateDirtyState();
  scheduleDraftAutoSave();
});
el("return-to-activity")?.addEventListener("click", () => returnToActivity(false));
el("save-contact-return")?.addEventListener("click", saveSchoolEdits);
el("contact-add-btn")?.addEventListener("click", () => openContactForm());
el("cform-cancel-btn")?.addEventListener("click", closeContactForm);
el("cform-save-btn")?.addEventListener("click", saveContactFromForm);
el("cform-category")?.addEventListener("change", updateStudentPrivacyCallout);
el("home-bulk-log")?.addEventListener("click", () => openBulkOutreach());
el("schools-bulk-log")?.addEventListener("click", () => openBulkOutreach());
el("bulk-dialog-close")?.addEventListener("click", () => closeBulkOutreach(false));
el("bulk-outreach-dialog")?.addEventListener("cancel", (event) => { event.preventDefault(); closeBulkOutreach(false); });
el("bulk-outreach-dialog")?.addEventListener("click", (event) => {
  const chip = event.target.closest?.(".suggestion-chip");
  if (!chip) return;
  const targetId = chip.getAttribute("data-target");
  const value = chip.getAttribute("data-value");
  if (targetId && value) {
    applySuggestion(targetId, value);
    updateBulkSuggestionStates();
  }
});
el("bulk-search")?.addEventListener("input", renderBulkStep1);
el("bulk-clear-selected")?.addEventListener("click", () => { bulkSelectedIds.clear(); renderBulkStep1(); });
el("bulk-cancel-step1")?.addEventListener("click", () => closeBulkOutreach(false));
el("bulk-to-step2")?.addEventListener("click", () => {
  if (bulkSelectedIds.size === 0) return;
  prepareBulkStep2();
  setBulkStep(2);
});
el("bulk-back-to-step1-link")?.addEventListener("click", () => { setBulkStep(1); renderBulkStep1(); });
el("bulk-back-to-step1")?.addEventListener("click", () => { setBulkStep(1); renderBulkStep1(); });
el("bulk-channel")?.addEventListener("change", () => {
  renderBulkSummarySuggestions();
});
el("bulk-activityType")?.addEventListener("change", () => {
  renderBulkSummarySuggestions();
  prepareBulkStep2();
});
el("bulk-outcome")?.addEventListener("input", updateBulkSuggestionStates);
el("bulk-summary")?.addEventListener("input", updateBulkSuggestionStates);
el("bulk-nextAction")?.addEventListener("input", updateBulkSuggestionStates);
el("bulk-resume-unresolved")?.addEventListener("click", () => {
  if (savedUnresolvedBatch) {
    bulkBatch = savedUnresolvedBatch;
    renderBulkResultsView();
  }
});
el("bulk-to-step3")?.addEventListener("click", () => {
  const selectedSchools = schools.filter((s) => bulkSelectedIds.has(s.recordId));
  const notContactedCount = selectedSchools.filter((s) => s.stage === "Not Contacted").length;
  const contactedCount = selectedSchools.length - notContactedCount;
  const activityType = el("bulk-activityType")?.value || "Outreach";

  if (activityType === "Outreach" && contactedCount > 0) {
    if (el("bulk-step2-feedback")) {
      el("bulk-step2-feedback").textContent = `First Contact cannot be applied to previously contacted schools. Adjust your selection or choose Follow-Up.`;
      el("bulk-step2-feedback").className = "editor-feedback error";
    }
    return;
  }
  if (activityType === "FollowUp" && notContactedCount > 0) {
    if (el("bulk-step2-feedback")) {
      el("bulk-step2-feedback").textContent = `Follow-Up cannot be applied to Not Contacted schools. Adjust your selection or choose First Contact.`;
      el("bulk-step2-feedback").className = "editor-feedback error";
    }
    return;
  }

  const outcome = el("bulk-outcome")?.value?.trim() || "";
  const summary = el("bulk-summary")?.value?.trim() || "";
  if (!outcome || !summary) {
    if (el("bulk-step2-feedback")) {
      el("bulk-step2-feedback").textContent = "Add an outcome and a short description before continuing.";
      el("bulk-step2-feedback").className = "editor-feedback error";
    }
    return;
  }
  if (el("bulk-step2-feedback")) el("bulk-step2-feedback").textContent = "";
  prepareBulkStep3();
  setBulkStep(3);
});
el("bulk-back-to-step2")?.addEventListener("click", () => setBulkStep(2));
function onBulkConfirmUpdate(e) {
  const isChecked = Boolean(e?.target?.checked ?? el("bulk-confirm-sent")?.checked);
  if (el("bulk-submit-save")) el("bulk-submit-save").disabled = !isChecked;
}
el("bulk-confirm-sent")?.addEventListener("change", onBulkConfirmUpdate);
el("bulk-confirm-sent")?.addEventListener("click", onBulkConfirmUpdate);
el("bulk-submit-save")?.addEventListener("click", () => {
  if (!el("bulk-confirm-sent")?.checked) return;
  if (savedUnresolvedBatch && hasUnresolvedBulkRecords(savedUnresolvedBatch)) {
    const unresolvedCount = getUnresolvedBulkCount(savedUnresolvedBatch);
    const msg = `You have ${unresolvedCount} unresolved ${unresolvedCount === 1 ? "save" : "saves"} from a previous batch.\n\nStarting a new batch will replace that unresolved retry tracking for this session.\n\nDo you want to proceed and replace the previous batch?`;
    if (typeof window !== "undefined" && window.confirm && !window.confirm(msg)) {
      return;
    }
  }
  const selectedSchools = schools.filter((s) => bulkSelectedIds.has(s.recordId));
  bulkBatch = {
    inProgress: false,
    stopped: false,
    stopReason: "",
    channel: el("bulk-channel")?.value || "Email",
    activityType: el("bulk-activityType")?.value || "Outreach",
    outcome: el("bulk-outcome")?.value?.trim() || "",
    summary: el("bulk-summary")?.value?.trim() || "",
    nextAction: el("bulk-nextAction")?.value?.trim() || "",
    followUpDue: el("bulk-followUpDue")?.value?.trim() || "",
    overwriteExisting: Boolean(el("bulk-overwrite-next-steps")?.checked),
    items: selectedSchools.map((school) => ({
      school,
      requestId: crypto.randomUUID(),
      status: "pending",
      error: "",
      code: "",
      payload: null,
      retryable: true,
      isConfirmedRejection: false,
    })),
  };
  executeBulkBatch(false);
});
el("bulk-retry-failed")?.addEventListener("click", () => executeBulkBatch(true));
el("bulk-finish-done")?.addEventListener("click", () => closeBulkOutreach(false));
window.addEventListener("beforeunload", (e) => {
  const modalUnsavedOrBusy = Boolean(
    editing && (editing.busy || (el("school-editor")?.open && hasFormChanges(editing)))
  );
  if (modalUnsavedOrBusy || (bulkBatch && (bulkBatch.inProgress || hasUnresolvedBulkRecords(bulkBatch)))) {
    e.preventDefault();
    e.returnValue = "You have outreach saves waiting for confirmation or retry.";
    return e.returnValue;
  }
});
el("refresh")?.addEventListener("click", refresh);
el("tab-home")?.addEventListener("click", () => switchTab("home"));
el("home-refresh")?.addEventListener("click", refresh);
el("home-find")?.addEventListener("click", () => switchTab("directory"));
el("home-schools")?.addEventListener("click", () => {
  supervisorSchoolScope = isSupervisor ? "all" : "mine";
  reviewSchools(null, "");
});
el("home-filter")?.addEventListener("change", () => { homeShowAll = false; renderHome(); });
el("home-more")?.addEventListener("click", () => { homeShowAll = true; renderHome(); });
el("schools-scope-clear")?.addEventListener("click", () => {
  supervisorSchoolScope = "all";
  reviewSchools(null, "");
});
el("retry")?.addEventListener("click", initialize);
el("search")?.addEventListener("input", renderSchools);
el("tab-my-schools")?.addEventListener("click", () => {
  supervisorSchoolScope = "mine";
  schoolScopeFilter = null;
  schoolStageFilter = "";
  schoolScopeLabel = "";
  switchTab("my-schools");
  renderSchools();
});
el("schools-toggle-mine")?.addEventListener("click", () => {
  supervisorSchoolScope = "mine";
  schoolScopeFilter = null;
  schoolStageFilter = "";
  schoolScopeLabel = "";
  renderSchools();
});
el("schools-toggle-all")?.addEventListener("click", () => {
  supervisorSchoolScope = "all";
  schoolScopeFilter = null;
  schoolStageFilter = "";
  schoolScopeLabel = "";
  renderSchools();
});
el("tab-dashboard")?.addEventListener("click", () => switchTab("dashboard"));
el("tab-programs")?.addEventListener("click", () => {
  switchTab("programs");
  renderProgramsView();
});
el("programs-toggle-mine")?.addEventListener("click", () => setProgramsScope("mine"));
el("programs-toggle-all")?.addEventListener("click", () => setProgramsScope("all"));
el("programs-refresh")?.addEventListener("click", async () => {
  await refresh();
  if (!isSupervisor && credential) await loadDashboard();
});
el("more-programs-select")?.addEventListener("change", (e) => {
  const val = e?.target?.value ?? el("more-programs-select")?.value ?? "";
  selectProgram(val);
});
el("quick-tag-school-btn")?.addEventListener("click", () => {
  quickTagSchoolToProgram();
});
el("dashboard-refresh")?.addEventListener("click", loadDashboard);
el("dashboard-clear")?.addEventListener("click", clearDashboardFilters);
el("dashboard-search")?.addEventListener("input", renderDashboard);
for (const id of ["dashboard-owner", "dashboard-stage", "dashboard-overdue"]) el(id)?.addEventListener("change", renderDashboard);
el("tab-directory")?.addEventListener("click", () => switchTab("directory"));
el("tab-demo-claim")?.addEventListener("click", () => switchTab("demo-claim"));
el("dir-search")?.addEventListener("input", renderDirectory);
el("dir-refresh")?.addEventListener("click", loadDirectory);
async function reconnect() {
  const connected = await checkConnection();
  if (!connected) return;
  if (el("workspace").hidden) {
    if (!el("retry").hidden) await initialize();
  } else if (credential) {
    await refresh();
  }
}
window.addEventListener("offline", () => {
  connectionAttempt++; setConnection(false);
  if (el("workspace").hidden) {
    finishRestore("You’re not connected. Reconnect, then try again.");
    setConnection(false);
  }
});
window.addEventListener("online", reconnect);
setInterval(() => {
  if (document.visibilityState !== "visible") return;
  if (browserOffline()) { setConnection(false); return; }
  if (!el("workspace").hidden && credential) refresh(); else reconnect();
}, 60000);
document.addEventListener("visibilitychange", () => {
  if (document.visibilityState === "visible") {
    if (browserOffline()) { setConnection(false); return; }
    if (!el("workspace").hidden && credential) refresh(); else reconnect();
  }
});
window.addEventListener("pageshow", (event) => { if (event.persisted && credential && !browserOffline()) refresh(); });
initialize();

