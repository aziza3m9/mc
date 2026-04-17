const STORAGE_KEY = "mc_dashboard_v1";

const state = {
  cases: [],
  activeId: null,
};

function load() {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (raw) {
      const parsed = JSON.parse(raw);
      state.cases = parsed.cases || [];
      state.activeId = parsed.activeId || null;
    }
  } catch (e) {
    console.warn("Failed to load state", e);
  }
}

function save() {
  localStorage.setItem(STORAGE_KEY, JSON.stringify(state));
}

function uid() {
  return Date.now().toString(36) + Math.random().toString(36).slice(2, 8);
}

function getActive() {
  return state.cases.find((c) => c.id === state.activeId) || null;
}

function createCase() {
  const c = {
    id: uid(),
    createdAt: new Date().toISOString(),
    patient: { name: "", dob: "", mrn: "", dos: "", provider: "", facility: "", notes: "" },
    opDocs: [],
    dxDocs: [],
    cpts: [],
    hours: [],
  };
  state.cases.unshift(c);
  state.activeId = c.id;
  save();
  render();
}

function deleteCase(id) {
  if (!confirm("Delete this case permanently?")) return;
  state.cases = state.cases.filter((c) => c.id !== id);
  if (state.activeId === id) state.activeId = state.cases[0]?.id || null;
  save();
  render();
}

function fileToDataURL(file) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(reader.result);
    reader.onerror = reject;
    reader.readAsDataURL(file);
  });
}

async function addDocs(kind, fileList) {
  const c = getActive();
  if (!c) return;
  const target = kind === "op" ? c.opDocs : c.dxDocs;
  for (const file of fileList) {
    const dataUrl = await fileToDataURL(file);
    target.push({
      id: uid(),
      name: file.name,
      type: file.type,
      size: file.size,
      dataUrl,
    });
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

function addHours() {
  const c = getActive();
  if (!c) return;
  const today = new Date().toISOString().slice(0, 10);
  c.hours.push({ id: uid(), date: today, hours: 0, task: "" });
  save();
  render();
}

function updateHours(id, field, value) {
  const c = getActive();
  const row = c.hours.find((r) => r.id === id);
  if (!row) return;
  row[field] = field === "hours" ? Number(value) || 0 : value;
  save();
  renderHoursTotal();
}

function removeHours(id) {
  const c = getActive();
  c.hours = c.hours.filter((r) => r.id !== id);
  save();
  render();
}

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

  const allDocs = [
    ...c.opDocs.map((d) => ({ ...d, section: "Operative Report" })),
    ...c.dxDocs.map((d) => ({ ...d, section: "Diagnostics" })),
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
    try {
      doc.addImage(d.dataUrl, fmt, margin, margin + 20, w, h);
    } catch (e) {
      doc.setFont("helvetica", "normal");
      doc.setFontSize(10);
      doc.text("Could not embed image.", margin, margin + 40);
    }
  }

  const safeName = (p.name || "case").replace(/[^a-z0-9]+/gi, "_");
  const safeDos = (p.dos || new Date().toISOString().slice(0, 10));
  doc.save(`${safeName}_${safeDos}.pdf`);
}

function render() {
  renderCaseList();
  renderActiveCase();
}

function renderCaseList() {
  const ul = document.getElementById("case-list");
  ul.innerHTML = "";
  if (!state.cases.length) {
    ul.innerHTML = '<li style="color:var(--muted);cursor:default">No cases yet</li>';
    return;
  }
  for (const c of state.cases) {
    const li = document.createElement("li");
    if (c.id === state.activeId) li.classList.add("active");
    const name = c.patient.name || "Untitled Case";
    const dos = c.patient.dos || new Date(c.createdAt).toISOString().slice(0, 10);
    li.innerHTML = `<div class="case-name">${escapeHtml(name)}</div><div class="case-sub">${escapeHtml(dos)} · ${c.cpts.length} CPT · ${c.opDocs.length + c.dxDocs.length} docs</div>`;
    li.addEventListener("click", () => { state.activeId = c.id; save(); render(); });
    ul.appendChild(li);
  }
}

function renderActiveCase() {
  const c = getActive();
  const view = document.getElementById("case-view");
  const empty = document.getElementById("empty-state");
  if (!c) {
    view.hidden = true;
    empty.hidden = false;
    return;
  }
  view.hidden = false;
  empty.hidden = true;

  document.querySelectorAll("[data-field]").forEach((el) => {
    const f = el.dataset.field;
    el.value = c.patient[f] || "";
  });

  renderDocList("op-list", c.opDocs, "op");
  renderDocList("dx-list", c.dxDocs, "dx");
  renderCptTable(c);
  renderHoursTable(c);
  renderHoursTotal();
}

function renderDocList(id, docs, kind) {
  const ul = document.getElementById(id);
  ul.innerHTML = "";
  if (!docs.length) {
    ul.innerHTML = '<li style="color:var(--muted)">None uploaded</li>';
    return;
  }
  for (const d of docs) {
    const li = document.createElement("li");
    const thumb = d.type.startsWith("image/")
      ? `<img src="${d.dataUrl}" alt="" />`
      : `<div style="width:40px;height:40px;background:#475569;border-radius:4px;display:flex;align-items:center;justify-content:center;font-size:10px;">PDF</div>`;
    li.innerHTML = `${thumb}<span class="doc-name">${escapeHtml(d.name)}</span><button class="doc-remove" title="Remove">&times;</button>`;
    li.querySelector(".doc-remove").addEventListener("click", () => removeDoc(kind, d.id));
    ul.appendChild(li);
  }
}

function renderCptTable(c) {
  const tbody = document.querySelector("#cpt-table tbody");
  tbody.innerHTML = "";
  for (const r of c.cpts) {
    const tr = document.createElement("tr");
    tr.innerHTML = `
      <td><input data-f="code" value="${escapeAttr(r.code)}" placeholder="e.g. 99213" /></td>
      <td><input data-f="description" value="${escapeAttr(r.description)}" placeholder="Description" /></td>
      <td><input data-f="modifiers" value="${escapeAttr(r.modifiers)}" placeholder="-25" /></td>
      <td><input data-f="units" type="number" min="0" step="1" value="${r.units}" style="width:60px" /></td>
      <td><button class="row-remove" title="Remove">&times;</button></td>
    `;
    tr.querySelectorAll("input").forEach((inp) => {
      inp.addEventListener("input", (e) => updateCpt(r.id, e.target.dataset.f, e.target.value));
    });
    tr.querySelector(".row-remove").addEventListener("click", () => removeCpt(r.id));
    tbody.appendChild(tr);
  }
}

function renderHoursTable(c) {
  const tbody = document.querySelector("#hours-table tbody");
  tbody.innerHTML = "";
  for (const r of c.hours) {
    const tr = document.createElement("tr");
    tr.innerHTML = `
      <td><input data-f="date" type="date" value="${escapeAttr(r.date)}" /></td>
      <td><input data-f="hours" type="number" min="0" step="0.25" value="${r.hours}" style="width:80px" /></td>
      <td><input data-f="task" value="${escapeAttr(r.task)}" placeholder="Task / notes" /></td>
      <td><button class="row-remove" title="Remove">&times;</button></td>
    `;
    tr.querySelectorAll("input").forEach((inp) => {
      inp.addEventListener("input", (e) => updateHours(r.id, e.target.dataset.f, e.target.value));
    });
    tr.querySelector(".row-remove").addEventListener("click", () => removeHours(r.id));
    tbody.appendChild(tr);
  }
}

function renderHoursTotal() {
  const c = getActive();
  if (!c) return;
  const total = c.hours.reduce((s, r) => s + (Number(r.hours) || 0), 0);
  document.getElementById("hours-total").textContent = total.toFixed(2);
}

function escapeHtml(s) {
  return String(s ?? "").replace(/[&<>"']/g, (m) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[m]));
}
function escapeAttr(s) { return escapeHtml(s); }

function exportAll() {
  const blob = new Blob([JSON.stringify(state, null, 2)], { type: "application/json" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = `medical_coding_backup_${new Date().toISOString().slice(0, 10)}.json`;
  a.click();
  URL.revokeObjectURL(url);
}

async function importAll(file) {
  try {
    const text = await file.text();
    const parsed = JSON.parse(text);
    if (!parsed.cases) throw new Error("Invalid file");
    if (!confirm(`Replace current data with ${parsed.cases.length} cases from file?`)) return;
    state.cases = parsed.cases;
    state.activeId = parsed.activeId || parsed.cases[0]?.id || null;
    save();
    render();
  } catch (e) {
    alert("Import failed: " + e.message);
  }
}

function bindEvents() {
  document.getElementById("new-case-btn").addEventListener("click", createCase);
  document.getElementById("export-all-btn").addEventListener("click", exportAll);
  document.getElementById("import-all").addEventListener("change", (e) => {
    if (e.target.files[0]) importAll(e.target.files[0]);
    e.target.value = "";
  });

  document.querySelectorAll("[data-field]").forEach((el) => {
    el.addEventListener("input", (e) => {
      const c = getActive();
      if (!c) return;
      c.patient[el.dataset.field] = e.target.value;
      save();
      if (el.dataset.field === "name" || el.dataset.field === "dos") renderCaseList();
    });
  });

  document.getElementById("upload-op").addEventListener("change", (e) => {
    if (e.target.files.length) addDocs("op", e.target.files);
    e.target.value = "";
  });
  document.getElementById("upload-dx").addEventListener("change", (e) => {
    if (e.target.files.length) addDocs("dx", e.target.files);
    e.target.value = "";
  });
  document.getElementById("build-pdf-btn").addEventListener("click", buildPdf);

  document.getElementById("add-cpt-btn").addEventListener("click", addCpt);
  document.getElementById("add-hours-btn").addEventListener("click", addHours);
  document.getElementById("delete-case-btn").addEventListener("click", () => {
    const c = getActive();
    if (c) deleteCase(c.id);
  });
}

load();
bindEvents();
render();
