const STORAGE_KEY = "mc_dashboard_v2";       // legacy; used only for one-time migration
const DEFAULT_USER = "Clarence";

/* =================================================================
   FIREBASE (Auth + Firestore)
   - Shared data lives under /workspace/default/data
   - Per-user state (timer, UI filters) lives under /users/{uid}/prefs
   - Sign-in restricted to @jcatmedia.com via Firestore security rules.
================================================================= */
const firebaseConfig = {
  apiKey: "AIzaSyDzTwlIOAI3GfFJhVtLlesdw5BOKerB0no",
  authDomain: "medicalcoding-39666.firebaseapp.com",
  projectId: "medicalcoding-39666",
  storageBucket: "medicalcoding-39666.firebasestorage.app",
  messagingSenderId: "677805653967",
  appId: "1:677805653967:web:a836d72d1f70821543dcba",
};
firebase.initializeApp(firebaseConfig);
const auth = firebase.auth();
const db = firebase.firestore();
db.enablePersistence({ synchronizeTabs: true }).catch(() => {});   // offline cache

let currentUser = null;      // set by onAuthStateChanged
let wsUnsub = null;          // onSnapshot unsubscribe for shared workspace
let prefsUnsub = null;       // onSnapshot unsubscribe for per-user prefs

const state = {
  cases: [],
  activeId: null,
  timesheet: [],   // {id, date, hours, caseId}
  activeTimer: null, // {startedAt, caseId}
  caseSearch: "",
  caseStatusFilter: "coding", // coding | review | complete
  calendarMonth: null,        // "YYYY-MM" (null = current month)
  feedback: [],               // [{id, createdAt, rating, account, caseId, note}]
};

const STATUS_META = {
  assigned: { label: "Assigned",  tone: "violet"  },
  coding:   { label: "Coding",    tone: "amber"   },
  review:   { label: "In Review", tone: "emerald" },
  complete: { label: "Complete",  tone: "mute"    },
};

const FEEDBACK_RATINGS = {
  good:    { label: "Good",       tone: "emerald" },
  neutral: { label: "Neutral",    tone: "amber"   },
  needs:   { label: "Needs Work", tone: "violet"  },
};

let timerInterval = null;

/* =================================================================
   STORAGE + MIGRATION
================================================================= */
// Takes a raw data object (from Firestore or legacy localStorage) and
// normalizes it onto `state`. Does all schema migrations.
function applyLoadedData(raw) {
  if (raw && typeof raw === "object") Object.assign(state, raw);
  if (!Array.isArray(state.timesheet)) state.timesheet = [];
  if (!Array.isArray(state.cases)) state.cases = [];
  if (!Array.isArray(state.feedback)) state.feedback = [];

  const legacyAccounts = Array.isArray(state.accounts) ? state.accounts : [];
  const legacyById = Object.fromEntries(legacyAccounts.map((a) => [a.id, a.name || ""]));
  for (const c of state.cases) {
    if (!c.status) c.status = "coding";
    if (typeof c.assignee !== "string") c.assignee = "";
    if (typeof c.dueDate !== "string") c.dueDate = "";
    if (typeof c.completedAt !== "string") c.completedAt = "";
    if (typeof c.account !== "string") c.account = "";
    if (!c.account && c.accountId && legacyById[c.accountId]) c.account = legacyById[c.accountId];
    if ("accountId" in c) delete c.accountId;
    if (!Array.isArray(c.hpDocs)) c.hpDocs = [];
    if (Array.isArray(c.dxDocs)) {
      for (const d of c.dxDocs) c.hpDocs.push(d);
      delete c.dxDocs;
    }
    if (!Array.isArray(c.opDocs)) c.opDocs = [];
    if (typeof c.opLink !== "string") c.opLink = "";
    if (typeof c.hpLink !== "string") c.hpLink = "";
  }
  if ("accounts" in state) delete state.accounts;
  for (const e of state.timesheet) {
    if (typeof e.employee !== "string") e.employee = "";
  }
  const validFilters = ["assigned", "coding", "review", "complete"];
  if (!validFilters.includes(state.caseStatusFilter)) state.caseStatusFilter = "coding";
}

// The shared workspace doc: cases, timesheet, feedback.
function wsDocRef() { return db.doc("workspace/default/data/state"); }
// Per-user preferences doc: timer, filter, calendar view.
function prefsDocRef() { return currentUser ? db.doc(`users/${currentUser.uid}/prefs/state`) : null; }

// Write the shared workspace, debounced to avoid write spam. Skipped if
// the latest render was driven by an incoming snapshot.
let saveSharedTimer = null;
let savePrefsTimer = null;
function save() {
  if (!currentUser) return;
  clearTimeout(saveSharedTimer);
  saveSharedTimer = setTimeout(() => {
    const payload = {
      cases: state.cases || [],
      timesheet: state.timesheet || [],
      feedback: state.feedback || [],
      updatedAt: firebase.firestore.FieldValue.serverTimestamp(),
      updatedBy: currentUser.email || currentUser.uid,
    };
    wsDocRef().set(payload, { merge: true }).catch((e) => console.warn("Workspace save failed", e));
  }, 350);
  clearTimeout(savePrefsTimer);
  savePrefsTimer = setTimeout(() => {
    const p = prefsDocRef();
    if (!p) return;
    p.set({
      activeId: state.activeId || null,
      caseSearch: state.caseSearch || "",
      caseStatusFilter: state.caseStatusFilter || "coding",
      calendarMonth: state.calendarMonth || null,
      activeTimer: state.activeTimer || null,
    }, { merge: true }).catch((e) => console.warn("Prefs save failed", e));
  }, 350);
}

// One-time migration from legacy mc_dashboard_v2 localStorage into Firestore.
// Only runs if Firestore has no shared data yet and the local blob exists.
async function maybeMigrateLocalStorage() {
  try {
    const snap = await wsDocRef().get();
    if (snap.exists) return false;    // shared workspace already seeded
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return false;
    const parsed = JSON.parse(raw);
    if (!parsed || !Array.isArray(parsed.cases)) return false;
    await wsDocRef().set({
      cases: parsed.cases || [],
      timesheet: parsed.timesheet || [],
      feedback: parsed.feedback || [],
      updatedAt: firebase.firestore.FieldValue.serverTimestamp(),
      updatedBy: currentUser ? currentUser.email : "migration",
      migratedFromLocalStorage: true,
    });
    console.info("Migrated local data into Firestore");
    return true;
  } catch (e) {
    console.warn("Migration check failed", e);
    return false;
  }
}

// Initial load: subscribe to both docs. The first snapshot populates
// state and renders the app. Subsequent snapshots reflect remote edits
// from other devices.
function subscribeFirestore(onFirstReady) {
  let firstWs = false;
  let firstPrefs = false;
  const tryReady = () => { if (firstWs && firstPrefs && onFirstReady) { const cb = onFirstReady; onFirstReady = null; cb(); } };

  wsUnsub = wsDocRef().onSnapshot((snap) => {
    if (snap.exists) {
      const d = snap.data() || {};
      state.cases = Array.isArray(d.cases) ? d.cases : [];
      state.timesheet = Array.isArray(d.timesheet) ? d.timesheet : [];
      state.feedback = Array.isArray(d.feedback) ? d.feedback : [];
    }
    applyLoadedData({});   // normalize / backfill in place
    firstWs = true;
    if (typeof render === "function") render();
    tryReady();
  }, (e) => { console.warn("Workspace snapshot error", e); firstWs = true; tryReady(); });

  const p = prefsDocRef();
  if (p) {
    prefsUnsub = p.onSnapshot((snap) => {
      if (snap.exists) {
        const d = snap.data() || {};
        state.activeId = d.activeId || null;
        state.caseSearch = d.caseSearch || "";
        state.caseStatusFilter = d.caseStatusFilter || "coding";
        state.calendarMonth = d.calendarMonth || null;
        state.activeTimer = d.activeTimer || null;
      }
      firstPrefs = true;
      if (typeof render === "function") render();
      if (state.activeTimer && !timerInterval) startTimerLoop();
      else if (!state.activeTimer && timerInterval) stopTimerLoop();
      tryReady();
    }, (e) => { console.warn("Prefs snapshot error", e); firstPrefs = true; tryReady(); });
  } else {
    firstPrefs = true;
  }
}

function unsubscribeFirestore() {
  if (wsUnsub) { try { wsUnsub(); } catch (_) {} wsUnsub = null; }
  if (prefsUnsub) { try { prefsUnsub(); } catch (_) {} prefsUnsub = null; }
}
function uid() { return Date.now().toString(36) + Math.random().toString(36).slice(2, 8); }
function escapeHtml(s) {
  return String(s ?? "").replace(/[&<>"']/g, (m) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[m]));
}
function escapeAttr(s) { return escapeHtml(s); }

/* =================================================================
   CASES
================================================================= */
function getActive() { return state.cases.find((c) => c.id === state.activeId) || null; }

function createCase() {
  const c = {
    id: uid(),
    createdAt: new Date().toISOString(),
    patient: { name: "", dob: "", mrn: "", dos: "", provider: "", facility: "", notes: "" },
    opDocs: [], hpDocs: [], cpts: [],
    opLink: "", hpLink: "",
    status: "coding",
    assignee: DEFAULT_USER,
    dueDate: "",
    account: "",
  };
  state.cases.unshift(c);
  state.activeId = c.id;
  save();
  navigate(`case/${c.id}`);
}

function deleteCase(id) {
  if (!confirm("Delete this case permanently? Time entries tied to it will remain but lose the case link.")) return;
  state.cases = state.cases.filter((c) => c.id !== id);
  for (const e of state.timesheet) if (e.caseId === id) e.caseId = "";
  if (state.activeId === id) state.activeId = null;
  save();
  navigate("cases");
}

function caseLabel(c) {
  if (!c) return "—";
  return c.patient.name || `Case ${c.id.slice(-4)}`;
}

/* =================================================================
   ACCOUNTS (free-text + autocomplete from past values)
================================================================= */
function uniqueAccounts() {
  const set = new Set();
  for (const c of state.cases) {
    const v = (c.account || "").trim();
    if (v) set.add(v);
  }
  return Array.from(set).sort((a, b) => a.localeCompare(b));
}

function refreshAccountSuggestions() {
  const dl = document.getElementById("account-suggestions");
  if (!dl) return;
  dl.innerHTML = uniqueAccounts().map((n) => `<option value="${escapeAttr(n)}"></option>`).join("");
}

/* =================================================================
   DOCUMENTS
================================================================= */
function fileToDataURL(file) {
  return new Promise((resolve, reject) => {
    const r = new FileReader();
    r.onload = () => resolve(r.result);
    r.onerror = reject;
    r.readAsDataURL(file);
  });
}

function blobToDataUrl(blob) {
  return new Promise((resolve, reject) => {
    const r = new FileReader();
    r.onload = () => resolve(r.result);
    r.onerror = reject;
    r.readAsDataURL(blob);
  });
}

async function imagesToPdfDataUrl(files) {
  const { jsPDF } = window.jspdf;
  const doc = new jsPDF({ unit: "pt", format: "letter" });
  const pageW = doc.internal.pageSize.getWidth();
  const pageH = doc.internal.pageSize.getHeight();
  const margin = 24;
  let first = true;
  for (const file of files) {
    const dataUrl = await fileToDataURL(file);
    const dims = await getImageDimensions(dataUrl);
    if (!first) doc.addPage();
    first = false;
    const maxW = pageW - margin * 2;
    const maxH = pageH - margin * 2;
    const ratio = Math.min(maxW / dims.w, maxH / dims.h);
    const w = dims.w * ratio;
    const h = dims.h * ratio;
    const x = (pageW - w) / 2;
    const y = (pageH - h) / 2;
    const fmt = file.type.includes("png") ? "PNG" : "JPEG";
    try { doc.addImage(dataUrl, fmt, x, y, w, h); }
    catch (e) { console.warn("Could not embed image", file.name, e); }
  }
  // Use FileReader on the Blob output — gives a clean
  // "data:application/pdf;base64,..." with no filename= param that
  // previously confused the parser and the browser.
  return blobToDataUrl(doc.output("blob"));
}

async function addDocs(kind, fileList) {
  const c = getActive();
  if (!c) return;
  const target = kind === "op" ? c.opDocs : c.hpDocs;
  const files = Array.from(fileList);

  if (kind === "op") {
    const images = files.filter((f) => f.type.startsWith("image/"));
    const others = files.filter((f) => !f.type.startsWith("image/"));

    if (images.length) {
      const dataUrl = await imagesToPdfDataUrl(images);
      const base = images.length === 1
        ? images[0].name.replace(/\.[^.]+$/, "")
        : `operative-report-${new Date().toISOString().slice(0, 10)}`;
      target.push({
        id: uid(),
        name: `${base}.pdf`,
        type: "application/pdf",
        size: Math.floor((dataUrl.length - "data:application/pdf;base64,".length) * 3 / 4),
        dataUrl,
      });
    }
    for (const file of others) {
      const dataUrl = await fileToDataURL(file);
      target.push({ id: uid(), name: file.name, type: file.type, size: file.size, dataUrl });
    }
  } else {
    for (const file of files) {
      const dataUrl = await fileToDataURL(file);
      target.push({ id: uid(), name: file.name, type: file.type, size: file.size, dataUrl });
    }
  }
  save();
  render();
}

function removeDoc(kind, docId) {
  const c = getActive();
  if (!c) return;
  if (kind === "op") c.opDocs = c.opDocs.filter((d) => d.id !== docId);
  else c.hpDocs = c.hpDocs.filter((d) => d.id !== docId);
  save();
  render();
}

/* =================================================================
   CPT CODES
================================================================= */
function addCpt() {
  const c = getActive();
  if (!c) return;
  c.cpts.push({ id: uid(), code: "", description: "", modifiers: "", units: 1 });
  save();
  render();
}
function updateCpt(id, field, value) {
  const c = getActive();
  const row = c.cpts.find((r) => r.id === id);
  if (!row) return;
  row[field] = field === "units" ? Number(value) || 0 : value;
  save();
}
function removeCpt(id) {
  const c = getActive();
  c.cpts = c.cpts.filter((r) => r.id !== id);
  save();
  render();
}

/* =================================================================
   TIMESHEET + CLOCK
================================================================= */
function clockIn() {
  if (state.activeTimer) return;
  const caseId = document.getElementById("timer-case").value;
  const employee = document.getElementById("timer-employee").value.trim();
  state.activeTimer = { startedAt: Date.now(), caseId, employee };
  save();
  renderTimesheet();
  renderNavBadges();
  startTimerLoop();
}

function clockOut() {
  const t = state.activeTimer;
  if (!t) return;
  const elapsedMs = Date.now() - t.startedAt;
  const hours = +(elapsedMs / 3600000).toFixed(6);
  if (hours > 0) {
    state.timesheet.unshift({
      id: uid(),
      date: new Date(t.startedAt).toISOString().slice(0, 10),
      hours,
      caseId: t.caseId || "",
      employee: t.employee || "",
    });
  }
  state.activeTimer = null;
  save();
  stopTimerLoop();
  renderTimesheet();
  renderNavBadges();
  renderOverview();
}

function startTimerLoop() {
  stopTimerLoop();
  updateTimerDisplay();
  timerInterval = setInterval(updateTimerDisplay, 1000);
}
function stopTimerLoop() {
  if (timerInterval) { clearInterval(timerInterval); timerInterval = null; }
}
function updateTimerDisplay() {
  const timerEl = document.getElementById("clock-timer");
  const stateEl = document.getElementById("clock-state");
  const btn = document.getElementById("clock-btn");
  if (!timerEl || !btn) return;
  if (state.activeTimer) {
    const ms = Date.now() - state.activeTimer.startedAt;
    timerEl.textContent = formatDuration(ms);
    timerEl.classList.add("active");
    stateEl.textContent = "Clocked in";
    stateEl.classList.add("active");
    btn.textContent = "Clock Out";
    btn.classList.remove("primary");
    btn.classList.add("danger");
    // Keep KPIs ticking in real time while the timer runs.
    const pageTs = document.getElementById("page-timesheet");
    if (pageTs && !pageTs.hidden) renderKpis();
    const pageOv = document.getElementById("page-overview");
    if (pageOv && !pageOv.hidden) {
      const k1 = document.getElementById("kpi-hours-today");
      const k2 = document.getElementById("kpi-hours-week");
      if (k1) k1.textContent = hoursToHMS(sumHours(filterEntriesSince(startOfToday())) + runningHoursSince(startOfToday()));
      if (k2) k2.textContent = hoursToHMS(sumHours(filterEntriesSince(startOfWeek())) + runningHoursSince(startOfWeek()));
    }
  } else {
    timerEl.textContent = "00:00:00";
    timerEl.classList.remove("active");
    stateEl.textContent = "Not clocked in";
    stateEl.classList.remove("active");
    btn.textContent = "Clock In";
    btn.classList.remove("danger");
    btn.classList.add("primary");
  }
}
function formatDuration(ms) {
  const s = Math.max(0, Math.floor(ms / 1000));
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const sec = s % 60;
  return `${String(h).padStart(2, "0")}:${String(m).padStart(2, "0")}:${String(sec).padStart(2, "0")}`;
}

// Convert a fractional-hour value to "HH:MM:SS".
function hoursToHMS(hours) {
  const totalSec = Math.max(0, Math.round((Number(hours) || 0) * 3600));
  const h = Math.floor(totalSec / 3600);
  const m = Math.floor((totalSec % 3600) / 60);
  const s = totalSec % 60;
  return `${String(h).padStart(2, "0")}:${String(m).padStart(2, "0")}:${String(s).padStart(2, "0")}`;
}

// Convert a fractional-hour value to a shorter "HH:MM" display.
function hoursToHM(hours) {
  const totalMin = Math.max(0, Math.round((Number(hours) || 0) * 60));
  const h = Math.floor(totalMin / 60);
  const m = totalMin % 60;
  return `${String(h).padStart(2, "0")}:${String(m).padStart(2, "0")}`;
}

// Parse "H:MM", "H:MM:SS", or a decimal number into fractional hours.
// Returns NaN if the input can't be read.
function parseHoursInput(raw) {
  if (raw == null) return NaN;
  const str = String(raw).trim();
  if (!str) return 0;
  if (str.includes(":")) {
    const parts = str.split(":").map((p) => Number(p));
    if (parts.some((n) => Number.isNaN(n) || n < 0)) return NaN;
    const [h = 0, m = 0, s = 0] = parts;
    return h + m / 60 + s / 3600;
  }
  const n = Number(str);
  return Number.isNaN(n) ? NaN : n;
}

function addManualEntry() {
  const today = new Date().toISOString().slice(0, 10);
  state.timesheet.unshift({ id: uid(), date: today, hours: 0, caseId: "", employee: "" });
  save();
  renderTimesheet();
}
function updateEntry(id, field, value) {
  const row = state.timesheet.find((r) => r.id === id);
  if (!row) return;
  if (field === "hours") {
    const parsed = parseHoursInput(value);
    row.hours = Number.isNaN(parsed) ? row.hours : +parsed.toFixed(6);
  } else {
    row[field] = value;
  }
  save();
  renderKpis();
  renderNavBadges();
  renderCalendar();
}
function removeEntry(id) {
  state.timesheet = state.timesheet.filter((r) => r.id !== id);
  save();
  renderTimesheet();
  renderOverview();
}

/* =================================================================
   TIME HELPERS
================================================================= */
function sumHours(entries) { return entries.reduce((s, e) => s + (Number(e.hours) || 0), 0); }
function startOfToday() { const d = new Date(); d.setHours(0, 0, 0, 0); return d; }
function startOfWeek() {
  const d = startOfToday();
  const day = d.getDay(); // Sun = 0
  const diff = (day + 6) % 7; // Monday start
  d.setDate(d.getDate() - diff);
  return d;
}
function startOfMonth() { const d = startOfToday(); d.setDate(1); return d; }
function filterEntriesSince(cutoff) {
  return state.timesheet.filter((e) => new Date(e.date) >= cutoff);
}
function filterEntriesBetween(fromInclusive, toExclusive) {
  return state.timesheet.filter((e) => {
    const d = new Date(e.date);
    return d >= fromInclusive && d < toExclusive;
  });
}

// Hours accumulated by the currently-running timer, counted from `cutoff`.
// Pass `null` to count the timer's full elapsed time (for the All-Time KPI).
function runningHoursSince(cutoff) {
  const t = state.activeTimer;
  if (!t) return 0;
  const fromMs = cutoff ? Math.max(t.startedAt, cutoff.getTime()) : t.startedAt;
  const toMs = Date.now();
  const ms = Math.max(0, toMs - fromMs);
  return ms / 3600000;
}
function ymd(d) {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");
  return `${y}-${m}-${day}`;
}

/* =================================================================
   ROUTING
   Routes:
     #overview         → overview page
     #cases            → gallery of all cases
     #case/:id         → detail/edit view for one case (stable URL)
     #timesheet        → timesheet page
================================================================= */
function parseRoute() {
  const raw = (location.hash || "#overview").replace(/^#/, "");
  const [head, id] = raw.split("/");
  if (head === "case" && id) return { name: "case", id };
  if (["overview", "cases", "timesheet", "productivity", "feedback"].includes(head)) return { name: head, id: null };
  return { name: "overview", id: null };
}
function navigate(route) { location.hash = route; }
function onRouteChange() {
  const r = parseRoute();

  const pageId = r.name === "case" ? "page-case" : `page-${r.name}`;
  document.querySelectorAll(".page").forEach((p) => { p.hidden = p.id !== pageId; });

  const navKey = r.name === "case" ? "cases" : r.name;
  document.querySelectorAll(".nav-item").forEach((n) => {
    n.classList.toggle("active", n.dataset.route === navKey);
  });

  if (r.name === "overview") renderOverview();
  if (r.name === "cases") renderCasesIndex();
  if (r.name === "case") {
    const exists = state.cases.some((c) => c.id === r.id);
    if (!exists) { navigate("cases"); return; }
    state.activeId = r.id;
    save();
    renderCaseDetail();
  }
  if (r.name === "timesheet") renderTimesheet();
  if (r.name === "productivity") renderProductivity();
  if (r.name === "feedback") renderFeedback();
}

/* =================================================================
   RENDERING
================================================================= */
function render() {
  renderNavBadges();
  onRouteChange();
}

function renderNavBadges() {
  const countEl = document.getElementById("nav-case-count");
  if (countEl) countEl.textContent = state.cases.length;
  const dot = document.getElementById("nav-timer-dot");
  if (dot) dot.hidden = !state.activeTimer;
}

function renderTopbar() {
  const dateEl = document.getElementById("topbar-date");
  if (dateEl) {
    const now = new Date();
    dateEl.textContent = now.toLocaleDateString(undefined, {
      weekday: "short", month: "short", day: "numeric", year: "numeric",
    });
  }

  // Show the actual signed-in user. Known accounts get friendly role
  // names; everyone else falls back to a title-cased email local-part.
  const nameEl = document.getElementById("topbar-user-name");
  const avatarEl = document.getElementById("topbar-user-avatar");
  const wrapEl = document.getElementById("topbar-user");
  if (!currentUser) return;
  const email = (currentUser.email || "").toLowerCase();
  const known = USER_PROFILES[email];
  let name, initials;
  if (known) {
    name = known.name;
    initials = known.initials;
  } else {
    const local = email.split("@")[0] || "User";
    name = local
      .split(/[._-]/)
      .filter(Boolean)
      .map((w) => w.charAt(0).toUpperCase() + w.slice(1))
      .join(" ");
    initials = (name.match(/\b[A-Za-z]/g) || ["U"]).slice(0, 2).join("").toUpperCase();
  }
  if (nameEl) nameEl.textContent = name;
  if (avatarEl) avatarEl.textContent = initials;
  if (wrapEl) wrapEl.title = `Signed in as ${email}`;
}

// Human-friendly role/name per account. Admin gets the "Admin" label,
// Clarence keeps his name, anyone else (if added later) falls through
// to the email-derived default.
const USER_PROFILES = {
  "support@jcatmedia.com":  { name: "Admin",    initials: "AD" },
  "clarence@jcatmedia.com": { name: "Clarence", initials: "CL" },
};

/* ---------- Trend chips ---------- */
const ARROW_UP   = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-linecap="round" stroke-linejoin="round"><polyline points="6 15 12 9 18 15"/></svg>`;
const ARROW_DOWN = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-linecap="round" stroke-linejoin="round"><polyline points="6 9 12 15 18 9"/></svg>`;
const DASH_ICON  = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-linecap="round" stroke-linejoin="round"><line x1="5" y1="12" x2="19" y2="12"/></svg>`;

function setTrendChip(el, current, previous, { unit = "", mode = "percent" } = {}) {
  if (!el) return;
  const hasPrev = Number.isFinite(previous);
  let cls = "flat", icon = DASH_ICON, label;
  if (!hasPrev || (previous === 0 && current === 0)) {
    label = "No change";
  } else if (previous === 0 && current > 0) {
    cls = "up"; icon = ARROW_UP; label = `+${current.toFixed(unit === "h" ? 2 : 0)}${unit} new`;
  } else {
    const diff = current - previous;
    if (Math.abs(diff) < 1e-6) { label = "Even"; }
    else if (mode === "percent") {
      const pct = (diff / Math.abs(previous)) * 100;
      cls = diff > 0 ? "up" : "down";
      icon = diff > 0 ? ARROW_UP : ARROW_DOWN;
      label = `${diff > 0 ? "+" : "−"}${Math.abs(pct).toFixed(0)}%`;
    } else {
      cls = diff > 0 ? "up" : "down";
      icon = diff > 0 ? ARROW_UP : ARROW_DOWN;
      label = `${diff > 0 ? "+" : "−"}${Math.abs(diff).toFixed(unit === "h" ? 2 : 0)}${unit}`;
    }
  }
  el.className = `kpi-trend ${cls}`;
  el.innerHTML = `${icon}<span>${label}</span>`;
}

function casesCodedBetween(fromInclusive, toExclusive) {
  return state.cases.filter((c) => {
    if (c.status !== "complete" || !c.completedAt) return false;
    const d = new Date(c.completedAt);
    return d >= fromInclusive && d < toExclusive;
  }).length;
}
function casesCodedSince(cutoff) {
  return state.cases.filter((c) => {
    if (c.status !== "complete" || !c.completedAt) return false;
    return new Date(c.completedAt) >= cutoff;
  }).length;
}

function computeKpiTrends() {
  const now = new Date();
  const today0 = startOfToday();
  const weekStart = startOfWeek();
  const prevWeekStart = new Date(weekStart); prevWeekStart.setDate(prevWeekStart.getDate() - 7);
  const yesterday = new Date(today0); yesterday.setDate(yesterday.getDate() - 1);

  const casesAddedThisWeek = state.cases.filter((c) => new Date(c.createdAt) >= weekStart).length;
  const casesAddedPrevWeek = state.cases.filter((c) => {
    const d = new Date(c.createdAt);
    return d >= prevWeekStart && d < weekStart;
  }).length;

  const codedToday = casesCodedSince(today0);
  const codedYesterday = casesCodedBetween(yesterday, today0);

  const hoursToday = sumHours(filterEntriesSince(today0));
  const hoursYesterday = sumHours(filterEntriesBetween(yesterday, today0));
  const hoursThisWeek = sumHours(filterEntriesSince(weekStart));
  const hoursPrevWeek = sumHours(filterEntriesBetween(prevWeekStart, weekStart));

  setTrendChip(document.getElementById("trend-cases"), casesAddedThisWeek, casesAddedPrevWeek, { unit: "", mode: "delta" });
  setTrendChip(document.getElementById("trend-coded-today"), codedToday, codedYesterday, { unit: "", mode: "delta" });
  setTrendChip(document.getElementById("trend-hours-today"), hoursToday, hoursYesterday, { unit: "h", mode: "percent" });
  setTrendChip(document.getElementById("trend-hours-week"), hoursThisWeek, hoursPrevWeek, { unit: "h", mode: "percent" });
}

/* ---------- Feedback page ---------- */
function renderFeedback() {
  const today0 = startOfToday();
  const monthAgo = new Date(today0); monthAgo.setDate(monthAgo.getDate() - 30);
  const recent = state.feedback.filter((f) => new Date(f.createdAt) >= monthAgo);
  const counts = { good: 0, neutral: 0, needs: 0 };
  for (const f of recent) if (counts[f.rating] != null) counts[f.rating] += 1;

  document.getElementById("fb-total").textContent = recent.length;
  document.getElementById("fb-good").textContent = counts.good;
  document.getElementById("fb-neutral").textContent = counts.neutral;
  document.getElementById("fb-needs").textContent = counts.needs;

  // 8-week stacked bar chart
  const weeks = [];
  for (let i = 7; i >= 0; i--) {
    const ws = startOfWeek(); ws.setDate(ws.getDate() - i * 7);
    const we = new Date(ws); we.setDate(we.getDate() + 7);
    const inWeek = state.feedback.filter((f) => {
      const d = new Date(f.createdAt);
      return d >= ws && d < we;
    });
    weeks.push({
      start: ws,
      isCurrent: i === 0,
      good: inWeek.filter((f) => f.rating === "good").length,
      neutral: inWeek.filter((f) => f.rating === "neutral").length,
      needs: inWeek.filter((f) => f.rating === "needs").length,
    });
  }
  renderFeedbackChart(weeks);

  // Log
  const ul = document.getElementById("fb-list");
  if (!state.feedback.length) {
    ul.innerHTML = '<li class="feedback-empty">No feedback logged yet. Click <strong>Add Feedback</strong> to record the first one.</li>';
    return;
  }
  const sorted = state.feedback.slice().sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt));
  ul.innerHTML = sorted.map((f) => {
    const meta = FEEDBACK_RATINGS[f.rating] || FEEDBACK_RATINGS.neutral;
    const when = new Date(f.createdAt).toLocaleString(undefined, {
      month: "short", day: "numeric", year: "numeric",
      hour: "numeric", minute: "2-digit",
    });
    const c = f.caseId ? state.cases.find((x) => x.id === f.caseId) : null;
    const tags = [
      `<span class="status-pill ${meta.tone}">${meta.label}</span>`,
      f.account ? `<span class="fb-tag">${escapeHtml(f.account)}</span>` : "",
      c ? `<a class="fb-tag fb-tag-link" href="#case/${c.id}">${escapeHtml(caseLabel(c))}</a>` : "",
    ].filter(Boolean).join("");
    return `
      <li class="feedback-row" data-id="${f.id}">
        <div class="feedback-head">
          <div class="feedback-tags">${tags}</div>
          <div class="feedback-actions">
            <span class="feedback-when">${escapeHtml(when)}</span>
            <button class="btn icon danger-ghost" title="Delete" data-fb-del="${f.id}">${trashIcon}</button>
          </div>
        </div>
        <div class="feedback-note">${escapeHtml(f.note || "(no note)")}</div>
      </li>`;
  }).join("");
  ul.querySelectorAll("[data-fb-del]").forEach((btn) => {
    btn.addEventListener("click", () => {
      const id = btn.dataset.fbDel;
      if (!confirm("Delete this feedback entry?")) return;
      state.feedback = state.feedback.filter((f) => f.id !== id);
      save();
      renderFeedback();
    });
  });
}

function renderFeedbackChart(weeks) {
  const wrap = document.getElementById("fb-chart");
  const totalEl = document.getElementById("fb-chart-total");
  if (!wrap) return;
  const total = weeks.reduce((s, w) => s + w.good + w.neutral + w.needs, 0);
  if (totalEl) totalEl.textContent = String(total);
  if (total === 0) {
    wrap.innerHTML = '<div class="chart-empty">No feedback in the last 8 weeks.</div>';
    return;
  }

  const W = 760, H = 220, padL = 24, padR = 16, padT = 18, padB = 36;
  const plotW = W - padL - padR, plotH = H - padT - padB;
  const max = Math.max(...weeks.map((w) => w.good + w.neutral + w.needs), 1);
  const slot = plotW / weeks.length;
  const barW = Math.min(38, slot - 10);
  const grid = [0.25, 0.5, 0.75, 1].map((t) => {
    const y = padT + plotH * (1 - t);
    return `<line class="bar-grid" x1="${padL}" y1="${y.toFixed(1)}" x2="${W - padR}" y2="${y.toFixed(1)}"/>`;
  }).join("");
  // Stack: needs (bottom) + neutral + good (top), purple-friendly colors
  const colors = { good: "#22c55e", neutral: "#a78bfa", needs: "#ef4444" };
  const bars = weeks.map((w, i) => {
    const cx = padL + slot * i + slot / 2;
    const stack = w.good + w.neutral + w.needs;
    const totalH = (stack / max) * plotH;
    let y = padT + plotH - totalH;
    const segs = [];
    for (const k of ["good", "neutral", "needs"]) {
      if (w[k] === 0) continue;
      const segH = (w[k] / stack) * totalH;
      segs.push(`<rect x="${(cx - barW/2).toFixed(1)}" y="${y.toFixed(1)}" width="${barW}" height="${Math.max(2, segH).toFixed(1)}" fill="${colors[k]}" opacity="${w.isCurrent ? 1 : 0.78}"/>`);
      y += segH;
    }
    const lbl = stack > 0 ? `<text class="bar-label-v" x="${cx.toFixed(1)}" y="${(padT + plotH - totalH - 6).toFixed(1)}">${stack}</text>` : "";
    const wkLabel = `Wk ${w.start.getMonth() + 1}/${w.start.getDate()}`;
    const xLbl = `<text class="bar-label-x" x="${cx.toFixed(1)}" y="${H - 16}">${wkLabel.split(" ")[0]}</text>
                  <text class="bar-label-x" x="${cx.toFixed(1)}" y="${H - 4}">${wkLabel.split(" ")[1]}</text>`;
    return `${segs.join("")}${lbl}${xLbl}`;
  }).join("");

  const legend = `
    <g transform="translate(${(padL + 4)}, ${padT - 6})" font-size="10" font-weight="700" letter-spacing="0.06em">
      <rect x="0" y="-9" width="9" height="9" fill="${colors.good}"/><text x="13" y="-1" fill="${'var(--text-muted)'}">GOOD</text>
      <rect x="58" y="-9" width="9" height="9" fill="${colors.neutral}"/><text x="71" y="-1" fill="${'var(--text-muted)'}">NEUTRAL</text>
      <rect x="138" y="-9" width="9" height="9" fill="${colors.needs}"/><text x="151" y="-1" fill="${'var(--text-muted)'}">NEEDS WORK</text>
    </g>`;

  wrap.innerHTML = `
    <svg viewBox="0 0 ${W} ${H}" preserveAspectRatio="none">
      ${grid}
      ${bars}
      ${legend}
    </svg>`;
}

function openFeedbackModal() {
  const modal = document.getElementById("fb-modal");
  if (!modal) return;
  document.getElementById("fb-rating").value = "good";
  document.getElementById("fb-account").value = "";
  document.getElementById("fb-note").value = "";
  refreshAccountSuggestions();
  populateCaseSelect("fb-case");
  modal.hidden = false;
  setTimeout(() => document.getElementById("fb-note")?.focus(), 50);
}

function closeFeedbackModal() {
  const modal = document.getElementById("fb-modal");
  if (modal) modal.hidden = true;
}

function saveFeedbackFromModal() {
  const rating = document.getElementById("fb-rating").value;
  const account = document.getElementById("fb-account").value.trim();
  const caseId = document.getElementById("fb-case").value;
  const note = document.getElementById("fb-note").value.trim();
  if (!note && !account && !caseId) {
    alert("Add at least a note, account, or case before saving.");
    return;
  }
  state.feedback.push({
    id: uid(),
    createdAt: new Date().toISOString(),
    rating: FEEDBACK_RATINGS[rating] ? rating : "neutral",
    account, caseId, note,
  });
  save();
  closeFeedbackModal();
  renderFeedback();
}

/* ---------- Productivity page ---------- */
function renderProductivity() {
  const today0 = startOfToday();
  const weekStart = startOfWeek();
  const monthAgo = new Date(today0); monthAgo.setDate(monthAgo.getDate() - 30);

  const completed = state.cases.filter((c) => c.status === "complete" && c.completedAt);

  const codedToday = completed.filter((c) => new Date(c.completedAt) >= today0).length;
  const codedMonth = completed.filter((c) => new Date(c.completedAt) >= monthAgo).length;

  // Time entries tie into productivity for the per-case breakdown, but the
  // throughput ratios only make sense when the numerator is *finished*
  // charts — otherwise a case with 22 seconds of logged time inflates
  // Cases/Hour into the hundreds.
  const monthEntries = state.timesheet.filter((e) => e.caseId && new Date(e.date) >= monthAgo);
  const weekEntries = state.timesheet.filter((e) => e.caseId && new Date(e.date) >= weekStart);

  const hoursByCaseMonth = {};
  const entriesByCaseMonth = {};
  for (const e of monthEntries) {
    hoursByCaseMonth[e.caseId] = (hoursByCaseMonth[e.caseId] || 0) + (Number(e.hours) || 0);
    entriesByCaseMonth[e.caseId] = (entriesByCaseMonth[e.caseId] || 0) + 1;
  }
  const hoursMonth = Object.values(hoursByCaseMonth).reduce((s, h) => s + h, 0);
  const workedCasesWeek = new Set(weekEntries.map((e) => e.caseId)).size;

  // Only compute throughput ratios once we have at least one completed
  // chart and a non-trivial amount of time logged (15 min). Below that
  // the numbers are noise — show a dash instead.
  const haveSignal = codedMonth > 0 && hoursMonth >= 0.25;
  const hoursPerCase = haveSignal ? hoursMonth / codedMonth : null;
  const casesPerHour = haveSignal ? codedMonth / hoursMonth : null;

  document.getElementById("p-coded-today").textContent = codedToday;
  document.getElementById("p-worked-week").textContent = workedCasesWeek;
  document.getElementById("p-hours-per-case").textContent = hoursPerCase == null ? "—" : hoursPerCase.toFixed(2);
  document.getElementById("p-cases-per-hour").textContent = casesPerHour == null ? "—" : casesPerHour.toFixed(2);

  renderHoursByCase(hoursByCaseMonth, entriesByCaseMonth);

  renderHoursByCase(hoursByCaseMonth, entriesByCaseMonth);

  const days = [];
  for (let i = 13; i >= 0; i--) {
    const d = new Date(today0); d.setDate(d.getDate() - i);
    const key = ymd(d);
    const count = completed.filter((c) => ymd(new Date(c.completedAt)) === key).length;
    const hours = sumHours(state.timesheet.filter((e) => e.date === key));
    days.push({ date: d, key, count, hours, isToday: i === 0 });
  }
  renderProdBars(days);
  renderProdLine(days);

  const byCoder = {};
  for (const c of completed) {
    if (new Date(c.completedAt) < monthAgo) continue;
    const name = (c.assignee || "Unassigned").trim() || "Unassigned";
    byCoder[name] = (byCoder[name] || 0) + 1;
  }
  const lb = document.getElementById("p-leaderboard");
  const sorted = Object.entries(byCoder).sort((a, b) => b[1] - a[1]);
  if (!sorted.length) {
    lb.innerHTML = '<li><span class="lb-name" style="color:var(--text-subtle);font-style:italic;font-weight:500">No completed charts in the last 30 days.</span></li>';
  } else {
    lb.innerHTML = sorted.map(([name, n]) => `
      <li>
        <span class="lb-name">${escapeHtml(name)}</span>
        <span class="lb-stat">${n} chart${n === 1 ? "" : "s"}</span>
      </li>`).join("");
  }
}

function renderHoursByCase(hoursByCase, entriesByCase) {
  const tbody = document.querySelector("#p-hours-by-case tbody");
  const countEl = document.getElementById("p-cases-worked-30");
  if (!tbody) return;
  const ids = Object.keys(hoursByCase);
  if (countEl) countEl.textContent = String(ids.length);
  if (!ids.length) {
    tbody.innerHTML = '<tr class="empty-row"><td colspan="5">No cases with logged time in the last 30 days. Pick a case in the Timesheet clock so entries link to it.</td></tr>';
    return;
  }
  const rows = ids
    .map((id) => {
      const c = state.cases.find((x) => x.id === id);
      return {
        id,
        c,
        hours: hoursByCase[id],
        entries: entriesByCase[id] || 0,
      };
    })
    .sort((a, b) => b.hours - a.hours);

  tbody.innerHTML = rows.map((r) => {
    const meta = r.c ? (STATUS_META[r.c.status] || STATUS_META.coding) : null;
    const name = r.c ? caseLabel(r.c) : `Deleted case ${r.id.slice(-4)}`;
    const account = r.c?.account || "—";
    const status = meta
      ? `<span class="status-pill ${meta.tone}">${meta.label}</span>`
      : '<span class="status-pill mute">—</span>';
    const link = r.c ? `<a href="#case/${r.c.id}">${escapeHtml(name)}</a>` : escapeHtml(name);
    return `
      <tr>
        <td>${link}</td>
        <td>${escapeHtml(account)}</td>
        <td>${status}</td>
        <td style="text-align: right; font-variant-numeric: tabular-nums;">${r.entries}</td>
        <td style="text-align: right; font-variant-numeric: tabular-nums; font-weight: 700; color: var(--gold-hover);">${hoursToHMS(r.hours)}</td>
      </tr>`;
  }).join("");
}

function renderProdBars(days) {
  const wrap = document.getElementById("p-bars");
  const totalEl = document.getElementById("p-bars-total");
  if (!wrap) return;
  const total = days.reduce((s, d) => s + d.count, 0);
  if (totalEl) totalEl.textContent = String(total);
  if (total === 0) { wrap.innerHTML = '<div class="chart-empty">No charts coded in the last 14 days.</div>'; return; }

  const W = 760, H = 220, padL = 24, padR = 16, padT = 18, padB = 32;
  const plotW = W - padL - padR, plotH = H - padT - padB;
  const max = Math.max(...days.map((d) => d.count), 1);
  const slot = plotW / days.length;
  const barW = Math.min(34, slot - 8);
  const grid = [0.25, 0.5, 0.75, 1].map((t) => {
    const y = padT + plotH * (1 - t);
    return `<line class="bar-grid" x1="${padL}" y1="${y.toFixed(1)}" x2="${W - padR}" y2="${y.toFixed(1)}"/>`;
  }).join("");
  const bars = days.map((d, i) => {
    const cx = padL + slot * i + slot / 2;
    const h = (d.count / max) * plotH;
    const y = padT + plotH - h;
    const cls = d.isToday ? "bar-rect today" : "bar-rect";
    const lbl = d.count > 0 ? `<text class="bar-label-v" x="${cx.toFixed(1)}" y="${(y - 6).toFixed(1)}">${d.count}</text>` : "";
    const dow = d.date.toLocaleDateString(undefined, { weekday: "short" }).slice(0, 3).toUpperCase();
    const dom = d.date.getDate();
    const xLbl = `<text class="bar-label-x" x="${cx.toFixed(1)}" y="${H - 16}">${dow}</text>
                  <text class="bar-label-x" x="${cx.toFixed(1)}" y="${H - 4}">${dom}</text>`;
    return `<rect class="${cls}" x="${(cx - barW/2).toFixed(1)}" y="${y.toFixed(1)}" width="${barW}" height="${Math.max(2, h).toFixed(1)}" rx="3"/>${lbl}${xLbl}`;
  }).join("");
  wrap.innerHTML = `
    <svg viewBox="0 0 ${W} ${H}" preserveAspectRatio="none">
      <defs>
        <linearGradient id="barGradient" x1="0" y1="0" x2="0" y2="1">
          <stop offset="0%" stop-color="#a855f7"/><stop offset="100%" stop-color="#6d28d9"/>
        </linearGradient>
        <linearGradient id="barGradientToday" x1="0" y1="0" x2="0" y2="1">
          <stop offset="0%" stop-color="#d8b4fe"/><stop offset="100%" stop-color="#7c3aed"/>
        </linearGradient>
      </defs>
      ${grid}${bars}
    </svg>`;
}

function renderProdLine(days) {
  const wrap = document.getElementById("p-line");
  const totalEl = document.getElementById("p-hours-total");
  if (!wrap) return;
  const total = days.reduce((s, d) => s + d.hours, 0);
  if (totalEl) totalEl.textContent = `${total.toFixed(2)}h`;
  if (total === 0) { wrap.innerHTML = '<div class="chart-empty">No hours logged in the last 14 days.</div>'; return; }

  const W = 760, H = 200, padL = 24, padR = 16, padT = 16, padB = 30;
  const plotW = W - padL - padR, plotH = H - padT - padB;
  const max = Math.max(...days.map((d) => d.hours), 1);
  const step = plotW / (days.length - 1);
  const points = days.map((d, i) => ({ ...d, x: padL + i * step, y: padT + plotH - (d.hours / max) * plotH }));
  const linePath = points.map((p, i) => `${i === 0 ? "M" : "L"} ${p.x.toFixed(1)} ${p.y.toFixed(1)}`).join(" ");
  const areaPath = `${linePath} L ${points[points.length-1].x.toFixed(1)} ${(padT + plotH).toFixed(1)} L ${points[0].x.toFixed(1)} ${(padT + plotH).toFixed(1)} Z`;
  const grid = [0.25, 0.5, 0.75].map((t) => {
    const y = padT + plotH * t;
    return `<line class="chart-grid" x1="${padL}" y1="${y.toFixed(1)}" x2="${W - padR}" y2="${y.toFixed(1)}"/>`;
  }).join("");
  const dots = points.map((p) => `<circle class="chart-dot${p.isToday ? ' today' : ''}" cx="${p.x.toFixed(1)}" cy="${p.y.toFixed(1)}" r="${p.isToday ? 5 : 3}"/>`).join("");
  const labels = points.map((p) => {
    const dow = p.date.toLocaleDateString(undefined, { weekday: "short" }).slice(0, 1).toUpperCase();
    return `<text class="chart-axis-label" x="${p.x.toFixed(1)}" y="${H - 8}">${dow}</text>`;
  }).join("");
  wrap.innerHTML = `
    <svg viewBox="0 0 ${W} ${H}" preserveAspectRatio="none">
      <defs>
        <linearGradient id="chartGradient" x1="0" y1="0" x2="0" y2="1">
          <stop offset="0%" stop-color="#9333ea" stop-opacity="0.35"/>
          <stop offset="100%" stop-color="#9333ea" stop-opacity="0"/>
        </linearGradient>
      </defs>
      ${grid}<path class="chart-area" d="${areaPath}"/><path class="chart-line" d="${linePath}"/>${dots}${labels}
    </svg>`;
}

/* ---------- Overview chart (last 7 days, inline SVG) ---------- */
function renderChart() {
  const wrap = document.getElementById("chart-wrap");
  const totalEl = document.getElementById("chart-total");
  if (!wrap) return;

  const today0 = startOfToday();
  const days = [];
  for (let i = 6; i >= 0; i--) {
    const d = new Date(today0); d.setDate(d.getDate() - i);
    const key = ymd(d);
    const hours = sumHours(state.timesheet.filter((e) => e.date === key));
    days.push({ date: d, key, hours, isToday: i === 0 });
  }
  const total = days.reduce((s, d) => s + d.hours, 0);
  if (totalEl) totalEl.textContent = `${total.toFixed(2)}h`;

  if (total === 0) {
    wrap.innerHTML = '<div class="chart-empty">No hours logged in the last 7 days.</div>';
    return;
  }

  const W = 720, H = 180;
  const padL = 24, padR = 16, padT = 16, padB = 30;
  const plotW = W - padL - padR;
  const plotH = H - padT - padB;
  const max = Math.max(...days.map((d) => d.hours), 1);
  const step = plotW / (days.length - 1);
  const points = days.map((d, i) => {
    const x = padL + i * step;
    const y = padT + plotH - (d.hours / max) * plotH;
    return { ...d, x, y };
  });
  const linePath = points.map((p, i) => `${i === 0 ? "M" : "L"} ${p.x.toFixed(1)} ${p.y.toFixed(1)}`).join(" ");
  const areaPath = `${linePath} L ${points[points.length-1].x.toFixed(1)} ${(padT + plotH).toFixed(1)} L ${points[0].x.toFixed(1)} ${(padT + plotH).toFixed(1)} Z`;

  const gridLines = [0.25, 0.5, 0.75].map((t) => {
    const y = padT + plotH * t;
    return `<line class="chart-grid" x1="${padL}" y1="${y.toFixed(1)}" x2="${W - padR}" y2="${y.toFixed(1)}"/>`;
  }).join("");
  const dots = points.map((p) => `<circle class="chart-dot${p.isToday ? ' today' : ''}" cx="${p.x.toFixed(1)}" cy="${p.y.toFixed(1)}" r="${p.isToday ? 5 : 3.5}"/>`).join("");
  const xLabels = points.map((p) => {
    const d = p.date.toLocaleDateString(undefined, { weekday: "short" }).slice(0, 3).toUpperCase();
    return `<text class="chart-axis-label" x="${p.x.toFixed(1)}" y="${H - 8}">${d}</text>`;
  }).join("");
  const valueLabels = points.map((p) => p.hours > 0
    ? `<text class="chart-value-label" x="${p.x.toFixed(1)}" y="${(p.y - 8).toFixed(1)}">${p.hours.toFixed(1)}</text>`
    : ""
  ).join("");

  wrap.innerHTML = `
    <svg viewBox="0 0 ${W} ${H}" preserveAspectRatio="none">
      <defs>
        <linearGradient id="chartGradient" x1="0" y1="0" x2="0" y2="1">
          <stop offset="0%"  stop-color="#9333ea" stop-opacity="0.35"/>
          <stop offset="100%" stop-color="#9333ea" stop-opacity="0"/>
        </linearGradient>
      </defs>
      ${gridLines}
      <path class="chart-area" d="${areaPath}"/>
      <path class="chart-line" d="${linePath}"/>
      ${dots}
      ${valueLabels}
      ${xLabels}
    </svg>`;
}

/* ---------- Overview ---------- */
function renderDueToday() {
  const ul = document.getElementById("due-today");
  const dateEl = document.getElementById("due-today-date");
  if (!ul) return;
  const today = new Date().toISOString().slice(0, 10);
  if (dateEl) {
    const d = new Date();
    dateEl.textContent = d.toLocaleDateString(undefined, {
      weekday: "long", month: "long", day: "numeric",
    });
  }
  const due = state.cases.filter((c) => c.dueDate === today && c.status !== "complete");
  ul.innerHTML = "";
  if (!due.length) {
    ul.innerHTML = '<li class="empty">Nothing due today.</li>';
    return;
  }
  for (const c of due) {
    const meta = STATUS_META[c.status] || STATUS_META.coding;
    const li = document.createElement("li");
    li.innerHTML = `
      <div>
        <div>${escapeHtml(caseLabel(c))} <span class="status-pill ${meta.tone}">${meta.label}</span></div>
        <div class="muted">${escapeHtml(c.assignee || "Unassigned")}</div>
      </div>
      <a href="#case/${c.id}" class="btn ghost sm">Open</a>`;
    ul.appendChild(li);
  }
}

function renderOverview() {
  document.getElementById("kpi-cases").textContent = state.cases.length;
  document.getElementById("kpi-coded-today").textContent = casesCodedSince(startOfToday());
  document.getElementById("kpi-hours-today").textContent = hoursToHMS(sumHours(filterEntriesSince(startOfToday())) + runningHoursSince(startOfToday()));
  document.getElementById("kpi-hours-week").textContent = hoursToHMS(sumHours(filterEntriesSince(startOfWeek())) + runningHoursSince(startOfWeek()));
  computeKpiTrends();
  renderChart();
  renderDueToday();

  const recentCases = document.getElementById("recent-cases");
  recentCases.innerHTML = "";
  const list = state.cases.slice(0, 5);
  if (!list.length) {
    recentCases.innerHTML = '<li class="empty">No cases yet.</li>';
  } else {
    for (const c of list) {
      const meta = STATUS_META[c.status] || STATUS_META.coding;
      const assignee = c.assignee ? ` · ${escapeHtml(c.assignee)}` : "";
      const li = document.createElement("li");
      li.innerHTML = `
        <div>
          <div>${escapeHtml(caseLabel(c))} <span class="status-pill ${meta.tone}">${meta.label}</span></div>
          <div class="muted">${escapeHtml(c.patient.dos || new Date(c.createdAt).toISOString().slice(0, 10))}${assignee}</div>
        </div>
        <a href="#case/${c.id}" class="btn ghost sm">Open</a>`;
      recentCases.appendChild(li);
    }
  }

  const recentEntries = document.getElementById("recent-entries");
  recentEntries.innerHTML = "";
  const entries = state.timesheet.slice(0, 5);
  if (!entries.length) {
    recentEntries.innerHTML = '<li class="empty">No time entries yet.</li>';
  } else {
    for (const e of entries) {
      const c = state.cases.find((x) => x.id === e.caseId);
      const li = document.createElement("li");
      li.innerHTML = `
        <div>
          <div>${escapeHtml(c ? caseLabel(c) : "Unassigned")}</div>
          <div class="muted">${escapeHtml(e.date)}</div>
        </div>
        <div><strong>${hoursToHMS(e.hours)}</strong></div>`;
      recentEntries.appendChild(li);
    }
  }
}

/* ---------- Cases index (gallery) ---------- */
function renderStatusFilterTabs() {
  const tabs = document.getElementById("status-filter");
  if (!tabs) return;
  const counts = {
    assigned: state.cases.filter((c) => c.status === "assigned").length,
    coding:   state.cases.filter((c) => (c.status || "coding") === "coding").length,
    review:   state.cases.filter((c) => c.status === "review").length,
    complete: state.cases.filter((c) => c.status === "complete").length,
  };
  const defs = [
    { key: "assigned", label: "Assigned" },
    { key: "coding",   label: "Coding" },
    { key: "review",   label: "In Review" },
    { key: "complete", label: "Complete" },
  ];
  tabs.innerHTML = "";
  for (const d of defs) {
    const btn = document.createElement("button");
    btn.className = "status-tab" + (state.caseStatusFilter === d.key ? " active" : "");
    btn.dataset.status = d.key;
    btn.innerHTML = `<span>${d.label}</span><span class="status-tab-count">${counts[d.key]}</span>`;
    btn.addEventListener("click", () => {
      state.caseStatusFilter = d.key;
      save();
      renderCasesIndex();
    });
    tabs.appendChild(btn);
  }
}

function renderCasesIndex() {
  renderStatusFilterTabs();

  const grid = document.getElementById("case-grid");
  const countEl = document.getElementById("cases-count");
  if (!grid) return;
  grid.innerHTML = "";

  const q = (state.caseSearch || "").toLowerCase();
  const filter = state.caseStatusFilter || "coding";
  const cases = state.cases.filter((c) => {
    const status = c.status || "coding";
    if (status !== filter) return false;
    if (!q) return true;
    const hay = `${c.patient.name} ${c.patient.mrn} ${c.patient.provider} ${c.patient.facility} ${c.assignee || ""}`.toLowerCase();
    return hay.includes(q);
  });

  if (countEl) {
    const shown = cases.length;
    const label = (STATUS_META[filter] || STATUS_META.coding).label.toLowerCase();
    countEl.textContent = `${shown} ${shown === 1 ? "case" : "cases"} · ${label}`;
  }

  if (!cases.length) {
    const label = (STATUS_META[filter] || STATUS_META.coding).label;
    const msg = state.cases.length
      ? (q ? "No cases match your search in this section." : `No cases in <strong>${label}</strong>.`)
      : 'Your library is empty. Click <strong>New Case</strong> to begin.';
    grid.innerHTML = `<div class="case-grid-empty">${msg}</div>`;
    return;
  }

  for (const c of cases) {
    const status = c.status || "coding";
    const meta = STATUS_META[status] || STATUS_META.coding;
    const name = caseLabel(c);
    const dos = c.patient.dos || new Date(c.createdAt).toISOString().slice(0, 10);
    const info = [c.account, c.patient.mrn && `MRN ${c.patient.mrn}`, c.patient.provider, c.patient.facility]
      .filter(Boolean)
      .join(" · ") || "No patient info yet";
    const assignee = c.assignee
      ? `<span class="case-assignee"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M20 21v-2a4 4 0 0 0-4-4H8a4 4 0 0 0-4 4v2"/><circle cx="12" cy="7" r="4"/></svg>${escapeHtml(c.assignee)}</span>`
      : `<span class="case-assignee unassigned">Unassigned</span>`;

    const card = document.createElement("a");
    card.className = "case-card";
    card.href = `#case/${c.id}`;
    card.innerHTML = `
      <div class="case-card-head">
        <div class="case-card-name">${escapeHtml(name)}</div>
        <span class="status-pill ${meta.tone}">${meta.label}</span>
      </div>
      <div class="case-card-meta">${escapeHtml(info)}</div>
      <div class="case-card-footer">
        ${assignee}
        <span class="case-card-date">${escapeHtml(dos)}</span>
      </div>
      <div class="case-card-stats">
        <span class="case-stat">
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M9 11H7a2 2 0 0 0-2 2v7a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2v-7a2 2 0 0 0-2-2h-2"/><path d="M9 11V7a3 3 0 0 1 6 0v4"/></svg>
          <strong>${c.cpts.length}</strong> CPT
        </span>
        <span class="case-stat">
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><polyline points="14 2 14 8 20 8"/></svg>
          <strong>${c.opDocs.length + c.hpDocs.length}</strong> docs
        </span>
      </div>`;
    grid.appendChild(card);
  }
}

function renderCaseDetail() {
  const c = getActive();
  if (!c) { navigate("cases"); return; }

  document.getElementById("case-title").textContent = caseLabel(c);
  const subParts = [];
  if (c.patient.mrn) subParts.push(`MRN ${c.patient.mrn}`);
  if (c.patient.dos) subParts.push(`DOS ${c.patient.dos}`);
  if (c.patient.provider) subParts.push(c.patient.provider);
  document.getElementById("case-subtitle").textContent = subParts.length ? subParts.join(" · ") : "Fill in patient info below.";

  // Status badge in header
  const badge = document.getElementById("case-status-badge");
  if (badge) {
    const meta = STATUS_META[c.status] || STATUS_META.coding;
    badge.className = `status-pill ${meta.tone}`;
    badge.textContent = meta.label;
  }

  document.querySelectorAll("[data-field]").forEach((el) => { el.value = c.patient[el.dataset.field] || ""; });
  const statusEl = document.getElementById("case-status");
  if (statusEl) statusEl.value = c.status || "coding";
  const assigneeEl = document.getElementById("case-assignee");
  if (assigneeEl) assigneeEl.value = c.assignee || "";
  const dueEl = document.getElementById("case-due-date");
  if (dueEl) dueEl.value = c.dueDate || "";
  const accountEl = document.getElementById("case-account");
  if (accountEl) accountEl.value = c.account || "";
  refreshAccountSuggestions();

  setDocLink("case-op-link", "case-op-open", c.opLink);
  setDocLink("case-hp-link", "case-hp-open", c.hpLink);
  renderDocList("op-list", c.opDocs, "op");
  renderDocList("hp-list", c.hpDocs, "hp");
  renderCptTable(c);
}

function setDocLink(inputId, openId, url) {
  const input = document.getElementById(inputId);
  const btn = document.getElementById(openId);
  if (input) input.value = url || "";
  if (btn) {
    const ok = isLikelyUrl(url);
    btn.hidden = !ok;
    if (ok) btn.href = url;
  }
}

function isLikelyUrl(s) {
  if (!s || typeof s !== "string") return false;
  try { const u = new URL(s); return u.protocol === "http:" || u.protocol === "https:"; }
  catch (_) { return false; }
}

function renderDocList(id, docs, kind) {
  const ul = document.getElementById(id);
  ul.innerHTML = "";
  if (!docs.length) {
    ul.innerHTML = '<li class="empty">No files uploaded</li>';
    return;
  }
  for (const d of docs) {
    const li = document.createElement("li");
    const thumb = d.type.startsWith("image/")
      ? `<img src="${d.dataUrl}" alt="" />`
      : `<div class="doc-thumb-pdf">PDF</div>`;
    const size = d.size ? ` · ${(d.size / 1024).toFixed(0)} KB` : "";
    li.title = "Click to open";
    li.innerHTML = `${thumb}<div class="doc-name">${escapeHtml(d.name)}<div class="doc-meta">${escapeHtml(d.type || "file")}${size}</div></div><span class="doc-open-hint">Open</span><button class="btn icon danger-ghost" title="Remove">${trashIcon}</button>`;
    li.addEventListener("click", (e) => {
      if (e.target.closest(".btn")) return;
      openDoc(d);
    });
    li.querySelector(".btn.icon").addEventListener("click", (e) => {
      e.stopPropagation();
      removeDoc(kind, d.id);
    });
    ul.appendChild(li);
  }
}

let currentViewerBlobUrl = null;

function dataUrlToBlob(dataUrl) {
  if (!dataUrl || !dataUrl.startsWith("data:")) return null;
  const commaIdx = dataUrl.indexOf(",");
  if (commaIdx < 0) return null;
  const meta = dataUrl.slice(5, commaIdx); // everything between "data:" and the comma
  const data = dataUrl.slice(commaIdx + 1);
  const parts = meta.split(";");
  const mime = parts[0] || "application/octet-stream";
  const isBase64 = parts.some((p) => p.toLowerCase() === "base64");
  try {
    const bytes = isBase64 ? atob(data) : decodeURIComponent(data);
    const arr = new Uint8Array(bytes.length);
    for (let i = 0; i < bytes.length; i++) arr[i] = bytes.charCodeAt(i);
    return new Blob([arr], { type: mime });
  } catch (e) {
    console.warn("dataUrlToBlob failed", e);
    return null;
  }
}

function openDoc(d) {
  const viewer = document.getElementById("doc-viewer");
  const title = document.getElementById("doc-viewer-title");
  const body = document.getElementById("doc-viewer-body");
  const dl = document.getElementById("doc-viewer-download");
  if (!viewer || !body) return;

  // Release any URL from a previous open
  if (currentViewerBlobUrl) {
    URL.revokeObjectURL(currentViewerBlobUrl);
    currentViewerBlobUrl = null;
  }

  title.textContent = d.name || "Document";
  body.innerHTML = "";

  const blob = dataUrlToBlob(d.dataUrl);
  const blobUrl = blob ? URL.createObjectURL(blob) : d.dataUrl;
  currentViewerBlobUrl = blob ? blobUrl : null;

  dl.href = blobUrl;
  dl.download = d.name || "document";

  if (d.type && d.type.startsWith("image/")) {
    const img = document.createElement("img");
    img.src = blobUrl;
    img.alt = d.name || "";
    body.appendChild(img);
  } else {
    const obj = document.createElement("object");
    obj.data = blobUrl;
    obj.type = d.type || "application/pdf";
    obj.setAttribute("width", "100%");
    obj.setAttribute("height", "100%");
    const fallback = document.createElement("div");
    fallback.className = "doc-viewer-fallback";
    fallback.innerHTML = `
      <p>Your browser can't render this PDF inline.</p>
      <a class="btn gold sm" href="${blobUrl}" target="_blank" rel="noopener">Open in new tab</a>`;
    obj.appendChild(fallback);
    body.appendChild(obj);
  }

  viewer.hidden = false;
  document.body.style.overflow = "hidden";
}

function closeDoc() {
  const viewer = document.getElementById("doc-viewer");
  if (!viewer) return;
  viewer.hidden = true;
  document.getElementById("doc-viewer-body").innerHTML = "";
  document.body.style.overflow = "";
  if (currentViewerBlobUrl) {
    URL.revokeObjectURL(currentViewerBlobUrl);
    currentViewerBlobUrl = null;
  }
}

const trashIcon = `<svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="3 6 5 6 21 6"/><path d="M19 6l-1 14a2 2 0 0 1-2 2H8a2 2 0 0 1-2-2L5 6"/><path d="M10 11v6M14 11v6"/><path d="M9 6V4a1 1 0 0 1 1-1h4a1 1 0 0 1 1 1v2"/></svg>`;

function renderCptTable(c) {
  const tbody = document.querySelector("#cpt-table tbody");
  tbody.innerHTML = "";
  if (!c.cpts.length) {
    tbody.innerHTML = '<tr class="empty-row"><td colspan="5">No CPT codes yet. Click "Add Code" to start.</td></tr>';
    return;
  }
  for (const r of c.cpts) {
    const tr = document.createElement("tr");
    tr.innerHTML = `
      <td><input data-f="code" value="${escapeAttr(r.code)}" placeholder="99213" /></td>
      <td><input data-f="description" value="${escapeAttr(r.description)}" placeholder="Description" /></td>
      <td><input data-f="modifiers" value="${escapeAttr(r.modifiers)}" placeholder="-25" /></td>
      <td><input data-f="units" type="number" min="0" step="1" value="${r.units}" /></td>
      <td><button class="btn icon danger-ghost" title="Remove">${trashIcon}</button></td>`;
    tr.querySelectorAll("input").forEach((inp) => {
      inp.addEventListener("input", (e) => updateCpt(r.id, e.target.dataset.f, e.target.value));
    });
    tr.querySelector(".btn.icon").addEventListener("click", () => removeCpt(r.id));
    tbody.appendChild(tr);
  }
}

/* ---------- Calendar ---------- */
function currentCalMonth() {
  if (state.calendarMonth) return state.calendarMonth;
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}`;
}

function shiftCalMonth(delta) {
  const [y, m] = currentCalMonth().split("-").map(Number);
  let ny = y, nm = m + delta;
  while (nm < 1)  { nm += 12; ny -= 1; }
  while (nm > 12) { nm -= 12; ny += 1; }
  state.calendarMonth = `${ny}-${String(nm).padStart(2, "0")}`;
  save();
  renderCalendar();
}

function renderCalendar() {
  const wrap = document.getElementById("calendar");
  const titleEl = document.getElementById("cal-title");
  if (!wrap || !titleEl) return;

  const ym = currentCalMonth();
  const [y, m] = ym.split("-").map(Number);
  const first = new Date(y, m - 1, 1);
  const lastDay = new Date(y, m, 0).getDate();
  const monthNames = ["January","February","March","April","May","June","July","August","September","October","November","December"];
  titleEl.textContent = `${monthNames[m - 1]} ${y}`;

  const dayHours = {};
  const dayEntryCounts = {};
  for (const e of state.timesheet) {
    if (typeof e.date !== "string" || !e.date.startsWith(ym)) continue;
    dayHours[e.date] = (dayHours[e.date] || 0) + (Number(e.hours) || 0);
    dayEntryCounts[e.date] = (dayEntryCounts[e.date] || 0) + 1;
  }

  const dayDue = {};
  for (const c of state.cases) {
    if (!c.dueDate || !c.dueDate.startsWith(ym)) continue;
    (dayDue[c.dueDate] ||= []).push(c);
  }

  const today = new Date().toISOString().slice(0, 10);
  const weekdays = ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"];

  let html = `<div class="cal-weekdays">${weekdays.map((d) => `<div>${d}</div>`).join("")}</div><div class="cal-grid">`;
  const firstDow = (first.getDay() + 6) % 7; // Mon = 0 … Sun = 6
  for (let i = 0; i < firstDow; i++) html += `<div class="cal-day cal-blank"></div>`;

  for (let day = 1; day <= lastDay; day++) {
    const iso = `${y}-${String(m).padStart(2, "0")}-${String(day).padStart(2, "0")}`;
    const h = dayHours[iso] || 0;
    const entries = dayEntryCounts[iso] || 0;
    const due = dayDue[iso] || [];
    const isToday = iso === today;

    const classes = ["cal-day"];
    if (isToday) classes.push("cal-today");
    if (h > 0) classes.push("cal-has-hours");
    if (due.length) classes.push("cal-has-due");

    const tooltipParts = [];
    if (h > 0) tooltipParts.push(`${hoursToHMS(h)} logged (${entries} ${entries === 1 ? "entry" : "entries"})`);
    if (due.length) tooltipParts.push(`${due.length} due: ${due.map((c) => caseLabel(c)).join(", ")}`);

    html += `
      <div class="${classes.join(" ")}" title="${escapeAttr(tooltipParts.join(" · "))}">
        <div class="cal-day-num">${day}</div>
        ${h > 0 ? `<div class="cal-hours">${hoursToHM(h)}</div>` : ""}
        ${due.length ? `<div class="cal-due-list">${due.slice(0, 2).map((c) => `<a class="cal-due-chip" href="#case/${c.id}">${escapeHtml(caseLabel(c))}</a>`).join("")}${due.length > 2 ? `<span class="cal-due-more">+${due.length - 2}</span>` : ""}</div>` : ""}
      </div>`;
  }

  html += "</div>";
  wrap.innerHTML = html;
}

/* ---------- Timesheet page ---------- */
function renderTimesheet() {
  populateCaseSelect("timer-case");
  const t = state.activeTimer;
  const caseEl = document.getElementById("timer-case");
  const empEl = document.getElementById("timer-employee");
  if (caseEl) { caseEl.value = t ? (t.caseId || "") : caseEl.value; caseEl.disabled = !!t; }
  if (empEl) {
    if (t) {
      empEl.value = t.employee || "";
    } else if (!empEl.value.trim()) {
      empEl.value = DEFAULT_USER;
    }
    empEl.disabled = !!t;
  }
  updateTimerDisplay();
  if (t && !timerInterval) startTimerLoop();
  renderCalendar();

  renderKpis();
  renderEntriesTable();
}

function renderKpis() {
  const today = sumHours(filterEntriesSince(startOfToday())) + runningHoursSince(startOfToday());
  const week = sumHours(filterEntriesSince(startOfWeek())) + runningHoursSince(startOfWeek());
  const month = sumHours(filterEntriesSince(startOfMonth())) + runningHoursSince(startOfMonth());
  const total = sumHours(state.timesheet) + runningHoursSince(null);
  const set = (id, val) => { const el = document.getElementById(id); if (el) el.textContent = hoursToHMS(val); };
  set("ts-today", today);
  set("ts-week", week);
  set("ts-month", month);
  set("ts-total", total);
}

function populateCaseSelect(id) {
  const sel = document.getElementById(id);
  if (!sel) return;
  const current = sel.value;
  sel.innerHTML = '<option value="">— None —</option>';
  for (const c of state.cases) {
    const opt = document.createElement("option");
    opt.value = c.id;
    opt.textContent = caseLabel(c);
    sel.appendChild(opt);
  }
  sel.value = current || "";
}


function renderEntriesTable() {
  const tbody = document.querySelector("#entries-table tbody");
  tbody.innerHTML = "";
  if (!state.timesheet.length) {
    tbody.innerHTML = '<tr class="empty-row"><td colspan="5">No time entries yet. Clock in above or add manually.</td></tr>';
    return;
  }
  for (const r of state.timesheet) {
    const tr = document.createElement("tr");
    const caseOptions = ['<option value="">—</option>']
      .concat(state.cases.map((c) => `<option value="${c.id}" ${r.caseId === c.id ? "selected" : ""}>${escapeHtml(caseLabel(c))}</option>`))
      .join("");
    tr.innerHTML = `
      <td><input data-f="date" type="date" value="${escapeAttr(r.date)}" /></td>
      <td><input data-f="hours" class="hms-input" value="${escapeAttr(hoursToHMS(r.hours))}" placeholder="HH:MM:SS" inputmode="numeric" /></td>
      <td><select data-f="caseId">${caseOptions}</select></td>
      <td><input data-f="employee" value="${escapeAttr(r.employee || "")}" placeholder="Employee" /></td>
      <td><button class="btn icon danger-ghost" title="Remove">${trashIcon}</button></td>`;
    tr.querySelectorAll("input, select").forEach((inp) => {
      inp.addEventListener("change", (e) => {
        updateEntry(r.id, e.target.dataset.f, e.target.value);
        // Reformat the hours cell back to canonical HH:MM:SS after edit
        if (e.target.dataset.f === "hours") {
          const updated = state.timesheet.find((x) => x.id === r.id);
          if (updated) e.target.value = hoursToHMS(updated.hours);
        }
      });
      if (inp.dataset.f !== "hours") {
        inp.addEventListener("input", (e) => updateEntry(r.id, e.target.dataset.f, e.target.value));
      }
    });
    tr.querySelector(".btn.icon").addEventListener("click", () => removeEntry(r.id));
    tbody.appendChild(tr);
  }
}

/* =================================================================
   PDF
================================================================= */
function getImageDimensions(dataUrl) {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.onload = () => resolve({ w: img.naturalWidth, h: img.naturalHeight });
    img.onerror = reject;
    img.src = dataUrl;
  });
}

async function buildPdf() {
  const c = getActive();
  if (!c) return;
  const { jsPDF } = window.jspdf;
  const doc = new jsPDF({ unit: "pt", format: "letter" });
  const pageW = doc.internal.pageSize.getWidth();
  const pageH = doc.internal.pageSize.getHeight();
  const margin = 40;

  doc.setFont("helvetica", "bold");
  doc.setFontSize(18);
  doc.text("Medical Coding Case File", margin, margin + 10);

  doc.setFont("helvetica", "normal");
  doc.setFontSize(11);
  let y = margin + 40;
  const p = c.patient;
  const lines = [
    `Patient Name: ${p.name || "-"}`,
    `Date of Birth: ${p.dob || "-"}`,
    `MRN: ${p.mrn || "-"}`,
    `Date of Service: ${p.dos || "-"}`,
    `Provider: ${p.provider || "-"}`,
    `Facility: ${p.facility || "-"}`,
  ];
  lines.forEach((l) => { doc.text(l, margin, y); y += 16; });
  if (p.notes) {
    y += 4;
    doc.text("Notes:", margin, y); y += 14;
    const wrap = doc.splitTextToSize(p.notes, pageW - margin * 2);
    doc.text(wrap, margin, y); y += wrap.length * 14;
  }

  if (c.opLink || c.hpLink) {
    y += 10;
    doc.setFont("helvetica", "bold");
    doc.text("Documents", margin, y);
    y += 14;
    doc.setFont("helvetica", "normal");
    if (c.opLink) {
      const wrap = doc.splitTextToSize(`Operative Report: ${c.opLink}`, pageW - margin * 2);
      doc.text(wrap, margin, y); y += wrap.length * 14;
    }
    if (c.hpLink) {
      const wrap = doc.splitTextToSize(`H&P Notes: ${c.hpLink}`, pageW - margin * 2);
      doc.text(wrap, margin, y); y += wrap.length * 14;
    }
  }

  if (c.cpts.length) {
    y += 10;
    doc.setFont("helvetica", "bold");
    doc.text("CPT Codes", margin, y);
    y += 16;
    doc.setFont("helvetica", "normal");
    c.cpts.forEach((r) => {
      const line = `${r.code || "-"}  ${r.description || ""}  [mod: ${r.modifiers || "-"}]  units: ${r.units}`;
      const wrap = doc.splitTextToSize(line, pageW - margin * 2);
      if (y + wrap.length * 14 > pageH - margin) { doc.addPage(); y = margin; }
      doc.text(wrap, margin, y);
      y += wrap.length * 14;
    });
  }

  const caseEntries = state.timesheet.filter((e) => e.caseId === c.id);
  if (caseEntries.length) {
    y += 10;
    if (y > pageH - margin * 2) { doc.addPage(); y = margin; }
    doc.setFont("helvetica", "bold");
    doc.text("Time Log", margin, y); y += 16;
    doc.setFont("helvetica", "normal");
    const totalH = sumHours(caseEntries);
    caseEntries.forEach((e) => {
      const line = `${e.date}  ${Number(e.hours).toFixed(2)}h`;
      const wrap = doc.splitTextToSize(line, pageW - margin * 2);
      if (y + wrap.length * 14 > pageH - margin) { doc.addPage(); y = margin; }
      doc.text(wrap, margin, y); y += wrap.length * 14;
    });
    doc.setFont("helvetica", "bold");
    doc.text(`Total: ${totalH.toFixed(2)} hrs`, margin, y + 4);
  }

  const allDocs = [
    ...c.opDocs.map((d) => ({ ...d, section: "Operative Report" })),
    ...c.hpDocs.map((d) => ({ ...d, section: "H&P Notes" })),
  ];
  for (const d of allDocs) {
    if (!d.type.startsWith("image/")) continue;
    doc.addPage();
    doc.setFont("helvetica", "bold");
    doc.setFontSize(13);
    doc.text(`${d.section}: ${d.name}`, margin, margin);
    const dims = await getImageDimensions(d.dataUrl);
    const maxW = pageW - margin * 2;
    const maxH = pageH - margin * 2 - 20;
    const ratio = Math.min(maxW / dims.w, maxH / dims.h);
    const w = dims.w * ratio;
    const h = dims.h * ratio;
    const fmt = d.type.includes("png") ? "PNG" : "JPEG";
    try { doc.addImage(d.dataUrl, fmt, margin, margin + 20, w, h); }
    catch (e) { doc.text("Could not embed image.", margin, margin + 40); }
  }

  const safeName = (p.name || "case").replace(/[^a-z0-9]+/gi, "_");
  const safeDos = (p.dos || new Date().toISOString().slice(0, 10));
  doc.save(`${safeName}_${safeDos}.pdf`);
}

/* =================================================================
   EXPORT / IMPORT
================================================================= */
function exportAll() {
  const blob = new Blob([JSON.stringify(state, null, 2)], { type: "application/json" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = `medcode_backup_${new Date().toISOString().slice(0, 10)}.json`;
  a.click();
  URL.revokeObjectURL(url);
}
async function importAll(file) {
  try {
    const text = await file.text();
    const parsed = JSON.parse(text);
    if (!parsed.cases) throw new Error("Invalid file");
    if (!confirm(`Replace current data with ${parsed.cases.length} cases from file?`)) return;
    Object.assign(state, { cases: parsed.cases || [], activeId: parsed.activeId || null, timesheet: parsed.timesheet || [], activeTimer: parsed.activeTimer || null });
    save();
    render();
  } catch (e) { alert("Import failed: " + e.message); }
}

/* =================================================================
   EVENT BINDINGS
================================================================= */
function bindEvents() {
  window.addEventListener("hashchange", onRouteChange);

  const signoutBtn = document.getElementById("topbar-signout");
  if (signoutBtn) signoutBtn.addEventListener("click", (e) => {
    e.stopPropagation();
    if (confirm("Sign out? You'll need the password to get back in.")) signOut();
  });

  document.querySelectorAll(".nav-item").forEach((n) => {
    n.addEventListener("click", (e) => { /* default anchor behavior sets hash */ });
  });

  document.getElementById("new-case-btn").addEventListener("click", createCase);

  const search = document.getElementById("case-search");
  if (search) {
    search.value = state.caseSearch || "";
    search.addEventListener("input", (e) => { state.caseSearch = e.target.value; renderCasesIndex(); });
  }

  const globalSearch = document.getElementById("global-search");
  if (globalSearch) {
    globalSearch.value = state.caseSearch || "";
    globalSearch.addEventListener("input", (e) => {
      state.caseSearch = e.target.value;
      if (search) search.value = e.target.value;
      navigate("cases");
      renderCasesIndex();
    });
  }

  document.querySelectorAll("[data-field]").forEach((el) => {
    el.addEventListener("input", () => {
      const c = getActive();
      if (!c) return;
      c.patient[el.dataset.field] = el.value;
      save();
      const f = el.dataset.field;
      if (f === "name" || f === "dos" || f === "mrn" || f === "provider") {
        const title = document.getElementById("case-title");
        const sub = document.getElementById("case-subtitle");
        if (title) title.textContent = caseLabel(c);
        if (sub) {
          const parts = [];
          if (c.patient.mrn) parts.push(`MRN ${c.patient.mrn}`);
          if (c.patient.dos) parts.push(`DOS ${c.patient.dos}`);
          if (c.patient.provider) parts.push(c.patient.provider);
          sub.textContent = parts.length ? parts.join(" · ") : "Fill in patient info below.";
        }
      }
    });
  });

  const statusSel = document.getElementById("case-status");
  if (statusSel) {
    statusSel.addEventListener("change", () => {
      const c = getActive();
      if (!c) return;
      const prev = c.status;
      c.status = statusSel.value;
      // Track when a case is marked complete; clear if it leaves complete.
      if (c.status === "complete" && prev !== "complete") {
        c.completedAt = new Date().toISOString();
      } else if (c.status !== "complete") {
        c.completedAt = "";
      }
      save();
      const badge = document.getElementById("case-status-badge");
      if (badge) {
        const meta = STATUS_META[c.status] || STATUS_META.coding;
        badge.className = `status-pill ${meta.tone}`;
        badge.textContent = meta.label;
      }
    });
  }
  const assigneeInput = document.getElementById("case-assignee");
  if (assigneeInput) {
    assigneeInput.addEventListener("input", () => {
      const c = getActive();
      if (!c) return;
      c.assignee = assigneeInput.value;
      save();
    });
  }
  const dueInput = document.getElementById("case-due-date");
  if (dueInput) {
    dueInput.addEventListener("input", () => {
      const c = getActive();
      if (!c) return;
      c.dueDate = dueInput.value;
      save();
    });
  }
  const accountInput = document.getElementById("case-account");
  if (accountInput) {
    accountInput.addEventListener("input", () => {
      const c = getActive();
      if (!c) return;
      c.account = accountInput.value;
      save();
    });
    accountInput.addEventListener("change", refreshAccountSuggestions);
  }

  document.getElementById("upload-op").addEventListener("change", (e) => {
    if (e.target.files.length) addDocs("op", e.target.files); e.target.value = "";
  });
  document.getElementById("upload-hp").addEventListener("change", (e) => {
    if (e.target.files.length) addDocs("hp", e.target.files); e.target.value = "";
  });

  const opLinkEl = document.getElementById("case-op-link");
  const hpLinkEl = document.getElementById("case-hp-link");
  if (opLinkEl) {
    opLinkEl.addEventListener("input", () => {
      const c = getActive(); if (!c) return;
      c.opLink = opLinkEl.value.trim();
      save();
      const btn = document.getElementById("case-op-open");
      if (btn) { const ok = isLikelyUrl(c.opLink); btn.hidden = !ok; if (ok) btn.href = c.opLink; }
    });
  }
  if (hpLinkEl) {
    hpLinkEl.addEventListener("input", () => {
      const c = getActive(); if (!c) return;
      c.hpLink = hpLinkEl.value.trim();
      save();
      const btn = document.getElementById("case-hp-open");
      if (btn) { const ok = isLikelyUrl(c.hpLink); btn.hidden = !ok; if (ok) btn.href = c.hpLink; }
    });
  }

  document.getElementById("add-cpt-btn").addEventListener("click", addCpt);
  document.getElementById("delete-case-btn").addEventListener("click", () => {
    const c = getActive();
    if (c) deleteCase(c.id);
  });

  const timerCase = document.getElementById("timer-case");
  if (timerCase) {
    timerCase.addEventListener("change", () => {
      const emp = document.getElementById("timer-employee");
      const c = state.cases.find((x) => x.id === timerCase.value);
      if (emp && !emp.value.trim() && c && c.assignee) emp.value = c.assignee;
    });
  }

  document.getElementById("clock-btn").addEventListener("click", () => {
    if (state.activeTimer) clockOut();
    else clockIn();
  });
  document.getElementById("add-entry-btn").addEventListener("click", addManualEntry);

  const newFbBtn = document.getElementById("new-feedback-btn");
  if (newFbBtn) newFbBtn.addEventListener("click", openFeedbackModal);
  const fbSave = document.getElementById("fb-save");
  if (fbSave) fbSave.addEventListener("click", saveFeedbackFromModal);
  document.querySelectorAll("#fb-modal [data-fb-close]").forEach((el) => {
    el.addEventListener("click", closeFeedbackModal);
  });
  document.addEventListener("keydown", (e) => {
    if (e.key === "Escape" && !document.getElementById("fb-modal").hidden) closeFeedbackModal();
  });

  const calPrev = document.getElementById("cal-prev");
  const calNext = document.getElementById("cal-next");
  const calToday = document.getElementById("cal-today");
  if (calPrev)  calPrev.addEventListener("click", () => shiftCalMonth(-1));
  if (calNext)  calNext.addEventListener("click", () => shiftCalMonth(+1));
  if (calToday) calToday.addEventListener("click", () => {
    state.calendarMonth = null;
    save();
    renderCalendar();
  });

  document.querySelectorAll("#doc-viewer [data-close]").forEach((el) => {
    el.addEventListener("click", closeDoc);
  });
  document.addEventListener("keydown", (e) => {
    if (e.key === "Escape" && !document.getElementById("doc-viewer").hidden) closeDoc();
  });
}

/* =================================================================
   INIT
================================================================= */
/* =================================================================
   FIREBASE AUTH (email / password, @jcatmedia.com only)
================================================================= */
function showLockScreen(mode) {
  const ls = document.getElementById("lock-screen");
  ls.hidden = false;
  ls.classList.add("ready");
  document.querySelector(".app").style.display = "none";
  // Reveal the card + footnote now that we know we're showing the sign-in UI.
  document.querySelectorAll("#lock-screen .lock-card, .lock-footnote").forEach((el) => {
    el.style.visibility = "";
  });
  const login = document.getElementById("lock-login");
  const reset = document.getElementById("lock-reset");
  if (login) login.hidden = mode === "reset";
  if (reset) reset.hidden = mode !== "reset";
  setTimeout(() => {
    const target = mode === "reset"
      ? document.getElementById("lock-reset-email")
      : document.getElementById("lock-email");
    target?.focus();
  }, 60);
}
function hideLockScreen() {
  document.getElementById("lock-screen").hidden = true;
  document.querySelector(".app").style.display = "";
}
function showLockError(id, msg) {
  const el = document.getElementById(id);
  if (!el) return;
  el.textContent = msg;
  el.hidden = false;
}
function clearLockError(id) {
  const el = document.getElementById(id);
  if (el) el.hidden = true;
}
function friendlyAuthError(e) {
  const code = (e && e.code) || "";
  if (code === "auth/invalid-email") return "That doesn't look like a valid email address.";
  if (code === "auth/user-not-found") return "No account found for that email. Ask your admin to create it in Firebase Auth.";
  if (code === "auth/wrong-password" || code === "auth/invalid-credential") return "Incorrect email or password.";
  if (code === "auth/too-many-requests") return "Too many attempts. Try again in a few minutes.";
  if (code === "auth/network-request-failed") return "Network error. Check your connection.";
  return (e && e.message) || "Sign-in failed. Please try again.";
}

function signOut() {
  auth.signOut().catch(() => {});
}

function bindLockEvents() {
  document.getElementById("lock-login-form").addEventListener("submit", async (e) => {
    e.preventDefault();
    clearLockError("lock-login-error");
    const email = document.getElementById("lock-email").value.trim();
    const pw = document.getElementById("lock-pw").value;
    const btn = document.getElementById("lock-signin-btn");
    if (btn) { btn.disabled = true; btn.textContent = "Signing in…"; }
    try {
      await auth.signInWithEmailAndPassword(email, pw);
      // onAuthStateChanged handles the rest.
    } catch (err) {
      showLockError("lock-login-error", friendlyAuthError(err));
      document.getElementById("lock-pw").select();
    } finally {
      if (btn) { btn.disabled = false; btn.textContent = "Sign in"; }
    }
  });
  document.getElementById("lock-reset-btn").addEventListener("click", () => {
    const email = document.getElementById("lock-email").value.trim();
    const resetEmailEl = document.getElementById("lock-reset-email");
    if (resetEmailEl && email) resetEmailEl.value = email;
    clearLockError("lock-reset-error");
    document.getElementById("lock-reset-info").hidden = true;
    showLockScreen("reset");
  });
  document.getElementById("lock-back-btn").addEventListener("click", () => {
    showLockScreen("login");
  });
  document.getElementById("lock-reset-form").addEventListener("submit", async (e) => {
    e.preventDefault();
    clearLockError("lock-reset-error");
    document.getElementById("lock-reset-info").hidden = true;
    const email = document.getElementById("lock-reset-email").value.trim();
    try {
      await auth.sendPasswordResetEmail(email);
      const info = document.getElementById("lock-reset-info");
      info.textContent = `Sent — check ${email} for the reset link.`;
      info.hidden = false;
    } catch (err) {
      showLockError("lock-reset-error", friendlyAuthError(err));
    }
  });
}

let appBooted = false;
function bootApp() {
  if (appBooted) return;
  appBooted = true;
  bindEvents();
  renderTopbar();
  subscribeFirestore(() => {
    // Once initial data is loaded (or Firestore is empty), migrate any
    // legacy localStorage blob in one shot.
    maybeMigrateLocalStorage();
  });
}

auth.onAuthStateChanged(async (user) => {
  currentUser = user || null;
  if (user) {
    hideLockScreen();
    if (!appBooted) bootApp();
    else {
      unsubscribeFirestore();
      subscribeFirestore();
    }
    renderTopbar();
  } else {
    unsubscribeFirestore();
    appBooted = false;
    showLockScreen("login");
  }
});

bindLockEvents();
// Keep both the app AND the lock screen hidden at load time.
// onAuthStateChanged will reveal exactly one of them once Firebase
// resolves the cached session. For signed-in users, the lock screen
// is never shown at all — no dark-purple flash.
document.querySelector(".app").style.display = "none";
document.getElementById("lock-screen").hidden = true;

function flushState() { try { save(); } catch (_) {} }
window.addEventListener("visibilitychange", () => {
  if (document.visibilityState === "hidden") flushState();
  else if (state.activeTimer && !timerInterval) startTimerLoop();
});
window.addEventListener("pagehide", flushState);
window.addEventListener("beforeunload", flushState);
