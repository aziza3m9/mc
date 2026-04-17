const STORAGE_KEY = "mc_dashboard_v2";

const state = {
  cases: [],
  activeId: null,
  timesheet: [],   // {id, date, hours, task, caseId}
  activeTimer: null, // {startedAt, task, caseId}
  caseSearch: "",
};

let timerInterval = null;

/* =================================================================
   STORAGE + MIGRATION
================================================================= */
function load() {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (raw) {
      const parsed = JSON.parse(raw);
      Object.assign(state, parsed);
    } else {
      const legacy = localStorage.getItem("mc_dashboard_v1");
      if (legacy) {
        const old = JSON.parse(legacy);
        state.cases = old.cases || [];
        state.activeId = old.activeId || null;
        state.timesheet = [];
        for (const c of state.cases) {
          if (Array.isArray(c.hours)) {
            for (const h of c.hours) {
              state.timesheet.push({
                id: uid(), date: h.date, hours: Number(h.hours) || 0,
                task: h.task || "", caseId: c.id,
              });
            }
            delete c.hours;
          }
        }
      }
    }
  } catch (e) { console.warn("Failed to load", e); }
  if (!Array.isArray(state.cases)) state.cases = [];
  if (!Array.isArray(state.timesheet)) state.timesheet = [];
  if (typeof state.caseSearch !== "string") state.caseSearch = "";
  for (const c of state.cases) {
    if (!c.patient || typeof c.patient !== "object") {
      c.patient = { name: "", dob: "", mrn: "", dos: "", provider: "", facility: "", notes: "" };
    }
    if (!Array.isArray(c.opDocs)) c.opDocs = [];
    if (!Array.isArray(c.dxDocs)) c.dxDocs = [];
    if (!Array.isArray(c.cpts)) c.cpts = [];
    if (!c.createdAt) c.createdAt = new Date().toISOString();
    if (!c.id) c.id = uid();
  }
}

function save() { localStorage.setItem(STORAGE_KEY, JSON.stringify(state)); }
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
    opDocs: [], dxDocs: [], cpts: [],
  };
  state.cases.unshift(c);
  state.activeId = c.id;
  save();
  navigate("cases");
  render();
}

function deleteCase(id) {
  if (!confirm("Delete this case permanently? Time entries tied to it will remain but lose the case link.")) return;
  state.cases = state.cases.filter((c) => c.id !== id);
  for (const e of state.timesheet) if (e.caseId === id) e.caseId = "";
  if (state.activeId === id) state.activeId = state.cases[0]?.id || null;
  save();
  render();
}

function caseLabel(c) {
  if (!c) return "—";
  return c.patient.name || `Case ${c.id.slice(-4)}`;
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

function blobToDataURL(blob) {
  return new Promise((resolve, reject) => {
    const r = new FileReader();
    r.onload = () => resolve(r.result);
    r.onerror = reject;
    r.readAsDataURL(blob);
  });
}

async function imagesToPdfDoc(files) {
  const { jsPDF } = window.jspdf;
  const doc = new jsPDF({ unit: "pt", format: "letter" });
  const pageW = doc.internal.pageSize.getWidth();
  const pageH = doc.internal.pageSize.getHeight();
  const margin = 24;
  for (let i = 0; i < files.length; i++) {
    const file = files[i];
    const dataUrl = await fileToDataURL(file);
    const dims = await getImageDimensions(dataUrl);
    const maxW = pageW - margin * 2;
    const maxH = pageH - margin * 2;
    const ratio = Math.min(maxW / dims.w, maxH / dims.h);
    const w = dims.w * ratio;
    const h = dims.h * ratio;
    const x = (pageW - w) / 2;
    const y = (pageH - h) / 2;
    const fmt = file.type.includes("png") ? "PNG" : "JPEG";
    if (i > 0) doc.addPage();
    try { doc.addImage(dataUrl, fmt, x, y, w, h); } catch (e) { /* skip */ }
  }
  return doc.output("blob");
}

async function addDocs(kind, fileList) {
  const c = getActive();
  if (!c) return;
  const target = kind === "op" ? c.opDocs : c.dxDocs;
  const files = Array.from(fileList);
  const images = files.filter((f) => f.type.startsWith("image/"));
  const rest = files.filter((f) => !f.type.startsWith("image/"));

  if (images.length) {
    const pages = [];
    for (const f of images) {
      pages.push({ name: f.name, type: f.type, dataUrl: await fileToDataURL(f) });
    }
    const pdfBlob = await imagesToPdfDoc(images);
    const pdfDataUrl = await blobToDataURL(pdfBlob);
    const stamp = new Date().toISOString().slice(0, 10);
    const label = kind === "op" ? "Operative_Report" : "HP_Note";
    const base = images.length === 1
      ? images[0].name.replace(/\.[^/.]+$/, "")
      : `${label}_${stamp}`;
    target.push({
      id: uid(),
      name: `${base}.pdf`,
      type: "application/pdf",
      size: pdfBlob.size,
      dataUrl: pdfDataUrl,
      pages,
    });
  }
  for (const file of rest) {
    const dataUrl = await fileToDataURL(file);
    target.push({ id: uid(), name: file.name, type: file.type, size: file.size, dataUrl });
  }
  save();
  render();
}

function removeDoc(kind, docId) {
  const c = getActive();
  if (!c) return;
  if (kind === "op") c.opDocs = c.opDocs.filter((d) => d.id !== docId);
  else c.dxDocs = c.dxDocs.filter((d) => d.id !== docId);
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
  const task = document.getElementById("timer-task").value.trim();
  const caseId = document.getElementById("timer-case").value;
  state.activeTimer = { startedAt: Date.now(), task, caseId };
  save();
  renderTimesheet();
  renderNavBadges();
  startTimerLoop();
}

function clockOut() {
  const t = state.activeTimer;
  if (!t) return;
  const elapsedMs = Date.now() - t.startedAt;
  const hours = +(elapsedMs / 3600000).toFixed(4);
  if (hours > 0) {
    state.timesheet.unshift({
      id: uid(),
      date: new Date(t.startedAt).toISOString().slice(0, 10),
      hours,
      task: t.task,
      caseId: t.caseId || "",
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
  const s = Math.floor(ms / 1000);
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const sec = s % 60;
  return `${String(h).padStart(2, "0")}:${String(m).padStart(2, "0")}:${String(sec).padStart(2, "0")}`;
}

function addManualEntry() {
  const today = new Date().toISOString().slice(0, 10);
  state.timesheet.unshift({ id: uid(), date: today, hours: 0, task: "", caseId: "" });
  save();
  renderTimesheet();
}
function updateEntry(id, field, value) {
  const row = state.timesheet.find((r) => r.id === id);
  if (!row) return;
  row[field] = field === "hours" ? Number(value) || 0 : value;
  save();
  renderKpis();
  renderNavBadges();
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

/* =================================================================
   ROUTING
================================================================= */
function currentRoute() {
  const h = (location.hash || "#overview").replace("#", "");
  return ["overview", "cases", "timesheet"].includes(h) ? h : "overview";
}
function navigate(route) { location.hash = route; }
function onRouteChange() {
  const r = currentRoute();
  document.querySelectorAll(".page").forEach((p) => { p.hidden = p.id !== `page-${r}`; });
  document.querySelectorAll(".nav-item").forEach((n) => {
    n.classList.toggle("active", n.dataset.route === r);
  });
  if (r === "overview") renderOverview();
  if (r === "cases") renderCasesPage();
  if (r === "timesheet") renderTimesheet();
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

/* ---------- Overview ---------- */
function renderOverview() {
  document.getElementById("kpi-cases").textContent = state.cases.length;
  document.getElementById("kpi-hours-today").textContent = sumHours(filterEntriesSince(startOfToday())).toFixed(2);
  document.getElementById("kpi-hours-week").textContent = sumHours(filterEntriesSince(startOfWeek())).toFixed(2);
  document.getElementById("kpi-cpts").textContent = state.cases.reduce((s, c) => s + c.cpts.length, 0);

  const recentCases = document.getElementById("recent-cases");
  recentCases.innerHTML = "";
  const list = state.cases.slice(0, 5);
  if (!list.length) {
    recentCases.innerHTML = '<li class="empty">No cases yet.</li>';
  } else {
    for (const c of list) {
      const li = document.createElement("li");
      li.innerHTML = `
        <div>
          <div>${escapeHtml(caseLabel(c))}</div>
          <div class="muted">${escapeHtml(c.patient.dos || new Date(c.createdAt).toISOString().slice(0, 10))} · ${c.cpts.length} CPT</div>
        </div>
        <a href="#cases" class="btn ghost sm">Open</a>`;
      li.querySelector("a").addEventListener("click", () => { state.activeId = c.id; save(); });
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
          <div>${escapeHtml(e.task || "(no task)")}</div>
          <div class="muted">${escapeHtml(e.date)}${c ? " · " + escapeHtml(caseLabel(c)) : ""}</div>
        </div>
        <div><strong>${Number(e.hours).toFixed(2)}h</strong></div>`;
      recentEntries.appendChild(li);
    }
  }
}

/* ---------- Cases page ---------- */
function renderCasesPage() {
  renderCaseList();
  renderCaseDetail();
}

function renderCaseList() {
  const ul = document.getElementById("case-list");
  if (!ul) return;
  ul.innerHTML = "";
  const q = (state.caseSearch || "").toLowerCase();
  const cases = state.cases.filter((c) => {
    if (!q) return true;
    const hay = `${c.patient.name} ${c.patient.mrn} ${c.patient.provider} ${c.patient.facility}`.toLowerCase();
    return hay.includes(q);
  });
  if (!cases.length) {
    ul.innerHTML = `<li class="empty">${state.cases.length ? "No cases match your search." : "No cases yet. Click \"New Case\"."}</li>`;
    return;
  }
  for (const c of cases) {
    const li = document.createElement("li");
    if (c.id === state.activeId) li.classList.add("active");
    const name = caseLabel(c);
    const dos = c.patient.dos || new Date(c.createdAt).toISOString().slice(0, 10);
    li.innerHTML = `<div class="case-name">${escapeHtml(name)}</div><div class="case-sub">${escapeHtml(dos)} · ${c.cpts.length} CPT · ${c.opDocs.length + c.dxDocs.length} docs</div>`;
    li.addEventListener("click", () => { state.activeId = c.id; save(); render(); });
    ul.appendChild(li);
  }
}

function renderCaseDetail() {
  const c = getActive();
  const view = document.getElementById("case-view");
  const empty = document.getElementById("case-empty");
  if (!c) {
    view.hidden = true;
    empty.hidden = false;
    return;
  }
  view.hidden = false;
  empty.hidden = true;

  document.getElementById("case-title").textContent = caseLabel(c);
  const subParts = [];
  if (c.patient.mrn) subParts.push(`MRN ${c.patient.mrn}`);
  if (c.patient.dos) subParts.push(`DOS ${c.patient.dos}`);
  if (c.patient.provider) subParts.push(c.patient.provider);
  document.getElementById("case-subtitle").textContent = subParts.length ? subParts.join(" · ") : "Fill in patient info below.";

  document.querySelectorAll("[data-field]").forEach((el) => { el.value = c.patient[el.dataset.field] || ""; });
  renderDocList("op-list", c.opDocs, "op");
  renderDocList("dx-list", c.dxDocs, "dx");
  renderCptTable(c);
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
    li.innerHTML = `${thumb}<div class="doc-name">${escapeHtml(d.name)}<div class="doc-meta">${escapeHtml(d.type || "file")}${size}</div></div><button class="btn icon danger-ghost" title="Remove">${trashIcon}</button>`;
    li.querySelector(".btn.icon").addEventListener("click", () => removeDoc(kind, d.id));
    ul.appendChild(li);
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

/* ---------- Timesheet page ---------- */
function renderTimesheet() {
  populateCaseSelect("timer-case");
  const t = state.activeTimer;
  const taskEl = document.getElementById("timer-task");
  const caseEl = document.getElementById("timer-case");
  if (taskEl) { taskEl.value = t ? t.task : taskEl.value; taskEl.disabled = !!t; }
  if (caseEl) { caseEl.value = t ? (t.caseId || "") : caseEl.value; caseEl.disabled = !!t; }
  updateTimerDisplay();
  if (t && !timerInterval) startTimerLoop();

  renderKpis();
  renderEntriesTable();
}

function renderKpis() {
  const today = sumHours(filterEntriesSince(startOfToday()));
  const week = sumHours(filterEntriesSince(startOfWeek()));
  const month = sumHours(filterEntriesSince(startOfMonth()));
  const total = sumHours(state.timesheet);
  const set = (id, val) => { const el = document.getElementById(id); if (el) el.textContent = val.toFixed(2); };
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
      <td><input data-f="hours" type="number" min="0" step="0.25" value="${r.hours}" /></td>
      <td><input data-f="task" value="${escapeAttr(r.task)}" placeholder="Task / notes" /></td>
      <td><select data-f="caseId">${caseOptions}</select></td>
      <td><button class="btn icon danger-ghost" title="Remove">${trashIcon}</button></td>`;
    tr.querySelectorAll("input, select").forEach((inp) => {
      inp.addEventListener("input", (e) => updateEntry(r.id, e.target.dataset.f, e.target.value));
      inp.addEventListener("change", (e) => updateEntry(r.id, e.target.dataset.f, e.target.value));
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
      const line = `${e.date}  ${Number(e.hours).toFixed(2)}h  ${e.task || ""}`;
      const wrap = doc.splitTextToSize(line, pageW - margin * 2);
      if (y + wrap.length * 14 > pageH - margin) { doc.addPage(); y = margin; }
      doc.text(wrap, margin, y); y += wrap.length * 14;
    });
    doc.setFont("helvetica", "bold");
    doc.text(`Total: ${totalH.toFixed(2)} hrs`, margin, y + 4);
  }

  const allDocs = [
    ...c.opDocs.map((d) => ({ ...d, section: "Operative Report" })),
    ...c.dxDocs.map((d) => ({ ...d, section: "H&P Note" })),
  ];
  const addImagePage = async (section, name, page) => {
    doc.addPage();
    doc.setFont("helvetica", "bold");
    doc.setFontSize(13);
    doc.text(`${section}: ${name}`, margin, margin);
    try {
      const dims = await getImageDimensions(page.dataUrl);
      const maxW = pageW - margin * 2;
      const maxH = pageH - margin * 2 - 20;
      const ratio = Math.min(maxW / dims.w, maxH / dims.h);
      const w = dims.w * ratio;
      const h = dims.h * ratio;
      const fmt = (page.type || "").includes("png") ? "PNG" : "JPEG";
      doc.addImage(page.dataUrl, fmt, margin, margin + 20, w, h);
    } catch (e) {
      doc.text("Could not embed image.", margin, margin + 40);
    }
  };
  for (const d of allDocs) {
    if (d.type.startsWith("image/")) {
      await addImagePage(d.section, d.name, d);
    } else if (Array.isArray(d.pages) && d.pages.length) {
      for (const pg of d.pages) {
        await addImagePage(d.section, d.name, pg);
      }
    }
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

  document.querySelectorAll(".nav-item").forEach((n) => {
    n.addEventListener("click", (e) => { /* default anchor behavior sets hash */ });
  });

  document.getElementById("new-case-btn").addEventListener("click", createCase);
  document.getElementById("export-all-btn").addEventListener("click", exportAll);
  document.getElementById("import-all").addEventListener("change", (e) => {
    if (e.target.files[0]) importAll(e.target.files[0]);
    e.target.value = "";
  });

  const search = document.getElementById("case-search");
  if (search) {
    search.value = state.caseSearch || "";
    search.addEventListener("input", (e) => { state.caseSearch = e.target.value; renderCaseList(); });
  }

  document.querySelectorAll("[data-field]").forEach((el) => {
    el.addEventListener("input", () => {
      const c = getActive();
      if (!c) return;
      c.patient[el.dataset.field] = el.value;
      save();
      const f = el.dataset.field;
      if (f === "name" || f === "dos" || f === "mrn" || f === "provider") {
        renderCaseList();
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

  document.getElementById("upload-op").addEventListener("change", (e) => {
    if (e.target.files.length) addDocs("op", e.target.files); e.target.value = "";
  });
  document.getElementById("upload-dx").addEventListener("change", (e) => {
    if (e.target.files.length) addDocs("dx", e.target.files); e.target.value = "";
  });
  document.getElementById("build-pdf-btn").addEventListener("click", buildPdf);

  document.getElementById("add-cpt-btn").addEventListener("click", addCpt);
  document.getElementById("delete-case-btn").addEventListener("click", () => {
    const c = getActive();
    if (c) deleteCase(c.id);
  });

  document.getElementById("clock-btn").addEventListener("click", () => {
    if (state.activeTimer) clockOut();
    else clockIn();
  });
  document.getElementById("add-entry-btn").addEventListener("click", addManualEntry);
}

/* =================================================================
   INIT
================================================================= */
load();
bindEvents();
render();
if (state.activeTimer) startTimerLoop();
