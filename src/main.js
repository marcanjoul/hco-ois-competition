// src/main.js
import { db } from "./firebase.js";
import { ref, set, get, onValue, update, remove } from "firebase/database";

// ─────────────────────────────────────────────────────
// STEP 1 ▸ Add your employee names here
// ─────────────────────────────────────────────────────
const DEFAULT_EMPLOYEES = [
  "adam",
  "Ajla",
  // Add more names...
];

// ─────────────────────────────────────────────────────
// STEP 2 ▸ Set your admin PIN here
// ─────────────────────────────────────────────────────
const ADMIN_PIN = "1234"; // Change this!

// ══════════════════════════════════════════════════════
// Constants
// ══════════════════════════════════════════════════════
const DAYS = ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"];
const PREVIEW_COUNT = 5;

// ── State ──────────────────────────────────────────
let state = {
  competitions: {},
  employees: {},
  logs: {},
  currentComp: null,
  currentUser: null,
  selectedDay: DAYS[new Date().getDay() === 0 ? 6 : new Date().getDay() - 1],
  admin: {
    showAllComps: false,
    showAllEmps: false,
    selectedEmp: null,
    selectedComp: null,
    empSearch: "",
  },
};

// ── Firebase refs ───────────────────────────────────
const dbRef = {
  comps:    ()              => ref(db, "competitions"),
  comp:     (id)            => ref(db, `competitions/${id}`),
  emps:     ()              => ref(db, "employees"),
  emp:      (id)            => ref(db, `employees/${id}`),
  logs:     ()              => ref(db, "logs"),
  compLogs: (cId)           => ref(db, `logs/${cId}`),
  empLog:   (cId, eId)      => ref(db, `logs/${cId}/${eId}`),
  dayLog:   (cId, eId, day) => ref(db, `logs/${cId}/${eId}/${day}`),
};

// ══════════════════════════════════════════════════════
// Bootstrap
// ══════════════════════════════════════════════════════
async function bootstrap() {
  const [empSnap, compSnap] = await Promise.all([
    get(dbRef.emps()),
    get(dbRef.comps()),
  ]);
  if (!empSnap.exists()) {
    const empUpdates = {};
    DEFAULT_EMPLOYEES.forEach(name => { empUpdates[slugify(name)] = { name }; });
    await update(dbRef.emps(), empUpdates);
  }
  if (!compSnap.exists()) {
    const id = `comp_${Date.now()}`;
    await set(dbRef.comp(id), { name: "Week 1", createdAt: Date.now() });
  }
}

function slugify(str) {
  return str.toLowerCase().replace(/\s+/g, "_").replace(/[^a-z0-9_]/g, "");
}

// ══════════════════════════════════════════════════════
// Realtime listeners
// ══════════════════════════════════════════════════════
function startListeners() {
  onValue(dbRef.comps(), snap => {
    state.competitions = snap.val() || {};
    if (!state.currentComp) {
      const ids = Object.keys(state.competitions);
      if (ids.length) state.currentComp = ids[ids.length - 1];
    }
    renderPickScreen();
    renderAdminComps();
  });

  onValue(dbRef.emps(), snap => {
    state.employees = snap.val() || {};
    renderPickScreen();
    renderAdminEmps();
  });

  onValue(dbRef.logs(), snap => {
    state.logs = snap.val() || {};
    renderPickScreen();
    if (state.currentUser) { renderDash(); renderBoard(); renderAllTime(); }
    if (state.admin.selectedEmp) refreshAdminDayView();
  });
}

// ══════════════════════════════════════════════════════
// Vibe phrases
// ══════════════════════════════════════════════════════
function getVibe(sph, total, hasLogs) {
  if (!hasLogs) return { emoji: "👋", text: "Tap 'Log It' to get on the board. Let's go!" };
  if (sph >= 200) return { emoji: "🔥", text: "BRO. You're literally on fire rn. Unreal numbers." };
  if (sph >= 150) return { emoji: "💰", text: "Okay bestie, you're EATING. Keep that energy up." };
  if (sph >= 100) return { emoji: "⚡", text: "Solid numbers. You're built different fr." };
  if (sph >= 60)  return { emoji: "📈", text: "Not bad at all! Push a little harder and you're top 3." };
  if (sph >= 30)  return { emoji: "🤔", text: "You got this, but the board is calling your name. Wake up!" };
  return           { emoji: "😬", text: "Bestie... we need to talk. Grind time." };
}

function getBigOrderReaction(amount) {
  if (amount >= 500) return `💀 $${amount.toFixed(0)} ORDER?! They said take their whole wallet!`;
  if (amount >= 300) return `🤑 $${amount.toFixed(0)} — okay they did NOT have to go that hard!`;
  if (amount >= 200) return `🔥 $${amount.toFixed(0)} — sheesh! You're out here COLLECTING.`;
  if (amount >= 100) return `💪 $${amount.toFixed(0)} order just dropped. Keep stacking!`;
  return null;
}

// ══════════════════════════════════════════════════════
// RENDER — Pick Screen
// ══════════════════════════════════════════════════════
function renderPickScreen(filterText = "") {
  const tabsEl = document.getElementById("comp-tabs");
  if (tabsEl) {
    tabsEl.innerHTML = "";
    Object.entries(state.competitions).forEach(([id, comp]) => {
      const btn = document.createElement("button");
      btn.className = `comp-tab${state.currentComp === id ? " active" : ""}`;
      btn.textContent = comp.name;
      btn.onclick = () => { state.currentComp = id; renderPickScreen(filterText); };
      tabsEl.appendChild(btn);
    });
  }

  const searchInput = document.getElementById("input-search-employees");
  if (searchInput && searchInput.value !== filterText) searchInput.value = filterText;

  const grid = document.getElementById("name-grid");
  if (!grid) return;
  grid.innerHTML = "";

  const ranked = getRankedPlayers(state.currentComp);
  const filtered = Object.entries(state.employees).filter(([, emp]) =>
    emp.name.toLowerCase().includes(filterText.toLowerCase())
  );

  if (filtered.length === 0) {
    grid.classList.add("empty");
    grid.innerHTML = filterText ? "No employees found 🔍" : "No employees loaded";
    document.getElementById("search-results-info").classList.add("hidden");
    return;
  }

  grid.classList.remove("empty");
  const resultsInfo = document.getElementById("search-results-info");
  if (filterText) {
    resultsInfo.textContent = `${filtered.length} of ${Object.keys(state.employees).length} employees`;
    resultsInfo.classList.remove("hidden");
  } else {
    resultsInfo.classList.add("hidden");
  }

  filtered.forEach(([id, emp]) => {
    const rank = ranked.findIndex(r => r.id === id);
    const pip = rank === 0 ? "👑" : rank === 1 ? "🥈" : rank === 2 ? "🥉" : "";
    const btn = document.createElement("button");
    btn.className = "name-btn";
    btn.innerHTML = `${pip ? `<span class="rank-pip">${pip}</span>` : ""}${emp.name}`;
    btn.onclick = () => enterAsDashboard(id);
    grid.appendChild(btn);
  });
}

// ══════════════════════════════════════════════════════
// Enter dashboard
// ══════════════════════════════════════════════════════
function enterAsDashboard(empId) {
  state.currentUser = empId;
  document.getElementById("input-search-employees").value = "";
  showScreen("dash");
  renderDash(); renderBoard(); renderAllTime();
}

// ══════════════════════════════════════════════════════
// RENDER — Dashboard
// ══════════════════════════════════════════════════════
function renderDash() {
  const emp = state.employees[state.currentUser];
  if (!emp) return;

  document.getElementById("dash-name").textContent = emp.name.toUpperCase();
  const comp = state.competitions[state.currentComp];
  document.getElementById("dash-comp-name").textContent = comp ? comp.name : "";

  const myLogs = (state.logs[state.currentComp] || {})[state.currentUser] || {};
  let totalSales = 0, totalHours = 0;
  Object.values(myLogs).forEach(d => { totalSales += d.sales || 0; totalHours += d.hours || 0; });
  const sph = totalHours > 0 ? totalSales / totalHours : 0;
  const hasLogs = Object.keys(myLogs).length > 0;

  document.getElementById("stat-sph").textContent   = `$${sph.toFixed(0)}`;
  document.getElementById("stat-total").textContent = `$${totalSales.toFixed(0)}`;

  const ranked = getRankedPlayers(state.currentComp);
  const myRank = ranked.findIndex(r => r.id === state.currentUser) + 1;
  document.getElementById("stat-rank").textContent = myRank > 0 ? `#${myRank}` : "—";

  const vibe = getVibe(sph, totalSales, hasLogs);
  document.getElementById("vibe-emoji").textContent = vibe.emoji;
  document.getElementById("vibe-text").textContent  = vibe.text;

  const dayRow = document.getElementById("day-row");
  dayRow.innerHTML = "";
  DAYS.forEach(d => {
    const btn = document.createElement("button");
    const hasEntry = myLogs[d] && (myLogs[d].sales > 0 || myLogs[d].hours > 0);
    btn.className = `day-btn${state.selectedDay === d ? " active" : ""}`;
    btn.textContent = d + (hasEntry ? " ✓" : "");
    btn.onclick = () => { state.selectedDay = d; renderDash(); };
    dayRow.appendChild(btn);
  });

  const existing = myLogs[state.selectedDay];
  document.getElementById("input-sales").value = existing ? existing.sales || "" : "";
  document.getElementById("input-hours").value = existing ? existing.hours || "" : "";

  const historyList = document.getElementById("history-list");
  historyList.innerHTML = "";
  const hasAnyLogs = DAYS.some(d => myLogs[d]);
  if (!hasAnyLogs) {
    historyList.innerHTML = `<p style="color:var(--text3);font-size:0.8rem;text-align:center;padding:16px">No logs yet this competition</p>`;
  } else {
    DAYS.forEach(day => {
      const log = myLogs[day];
      if (!log) return;
      const daySph = log.hours > 0 ? (log.sales / log.hours) : 0;
      const item = document.createElement("div");
      item.className = "history-item";
      item.innerHTML = `
        <div class="history-day">${day}</div>
        <div class="history-info">
          <div class="history-sales">$${(log.sales || 0).toFixed(2)}</div>
          <div class="history-meta">${log.hours || 0} hrs worked</div>
        </div>
        <div class="history-sph">$${daySph.toFixed(0)}/hr</div>
      `;
      historyList.appendChild(item);
    });
  }
}

// ══════════════════════════════════════════════════════
// RENDER — Leaderboard
// ══════════════════════════════════════════════════════
function renderBoard() {
  const comp = state.competitions[state.currentComp];
  document.getElementById("board-comp-badge").textContent = comp ? comp.name : "";
  const ranked = getRankedPlayers(state.currentComp);
  const body = document.getElementById("board-body");
  body.innerHTML = "";

  if (ranked.length === 0) {
    body.innerHTML = `<p style="color:var(--text3);text-align:center;padding:40px;font-size:0.85rem">No logs yet — be the first! 🔥</p>`;
    return;
  }

  const topSph = ranked[0]?.sph || 1;
  ranked.forEach((player, i) => {
    const rankLabel = i === 0 ? "👑" : i === 1 ? "🥈" : i === 2 ? "🥉" : `#${i + 1}`;
    const pct = topSph > 0 ? Math.max(4, (player.sph / topSph) * 100) : 4;
    const card = document.createElement("div");
    card.className = `board-card${i < 3 ? ` rank-${i + 1}` : ""}`;
    card.style.animationDelay = `${i * 0.05}s`;
    card.innerHTML = `
      <div class="board-rank">${rankLabel}</div>
      <div class="board-info">
        <div class="board-name">${player.name}</div>
        <div class="board-meta">$${player.total.toFixed(2)} total · ${player.hours.toFixed(1)} hrs</div>
        <div class="board-bar-wrap"><div class="board-bar" style="width:${pct}%"></div></div>
      </div>
      <div>
        <div class="board-sph" style="color:${i === 0 ? "var(--accent)" : "var(--text)"}">$${player.sph.toFixed(0)}</div>
        <div class="board-sph-label">/HR</div>
      </div>
    `;
    card.onclick = () => { state.currentUser = player.id; showScreen("dash"); renderDash(); setActiveNav("dash"); };
    body.appendChild(card);
  });
}

// ══════════════════════════════════════════════════════
// RENDER — All-Time
// ══════════════════════════════════════════════════════
function renderAllTime() {
  const body = document.getElementById("alltime-body");
  body.innerHTML = "";
  const totals = {};
  Object.entries(state.employees).forEach(([id, emp]) => { totals[id] = { id, name: emp.name, total: 0, hours: 0 }; });
  Object.entries(state.logs).forEach(([, compLogs]) => {
    Object.entries(compLogs || {}).forEach(([empId, empLogs]) => {
      if (!totals[empId]) return;
      Object.values(empLogs || {}).forEach(log => { totals[empId].total += log.sales || 0; totals[empId].hours += log.hours || 0; });
    });
  });
  const ranked = Object.values(totals)
    .map(p => ({ ...p, sph: p.hours > 0 ? p.total / p.hours : 0 }))
    .filter(p => p.total > 0 || p.hours > 0)
    .sort((a, b) => b.sph - a.sph);

  if (ranked.length === 0) {
    body.innerHTML = `<p style="color:var(--text3);text-align:center;padding:40px;font-size:0.85rem">No all-time data yet. Start logging! 🏆</p>`;
    return;
  }
  const topSph = ranked[0]?.sph || 1;
  ranked.forEach((player, i) => {
    const rankLabel = i === 0 ? "👑" : i === 1 ? "🥈" : i === 2 ? "🥉" : `#${i + 1}`;
    const pct = topSph > 0 ? Math.max(4, (player.sph / topSph) * 100) : 4;
    const card = document.createElement("div");
    card.className = `board-card${i < 3 ? ` rank-${i + 1}` : ""}`;
    card.style.animationDelay = `${i * 0.05}s`;
    card.innerHTML = `
      <div class="board-rank">${rankLabel}</div>
      <div class="board-info">
        <div class="board-name">${player.name}</div>
        <div class="board-meta">$${player.total.toFixed(2)} total · ${player.hours.toFixed(1)} hrs all-time</div>
        <div class="board-bar-wrap"><div class="board-bar" style="width:${pct}%"></div></div>
      </div>
      <div>
        <div class="board-sph" style="color:${i === 0 ? "var(--accent)" : "var(--text)"}">$${player.sph.toFixed(0)}</div>
        <div class="board-sph-label">/HR</div>
      </div>
    `;
    body.appendChild(card);
  });
}

// ══════════════════════════════════════════════════════
// Helper
// ══════════════════════════════════════════════════════
function getRankedPlayers(compId) {
  const compLogs = state.logs[compId] || {};
  return Object.entries(state.employees)
    .map(([id, emp]) => {
      const empLogs = compLogs[id] || {};
      let total = 0, hours = 0;
      Object.values(empLogs).forEach(log => { total += log.sales || 0; hours += log.hours || 0; });
      return { id, name: emp.name, total, hours, sph: hours > 0 ? total / hours : 0 };
    })
    .sort((a, b) => b.sph - a.sph);
}

// ══════════════════════════════════════════════════════
// Log entry (employee)
// ══════════════════════════════════════════════════════
async function logEntry() {
  const sales = parseFloat(document.getElementById("input-sales").value);
  const hours = parseFloat(document.getElementById("input-hours").value);
  if (isNaN(sales) || sales < 0) { showToast("Enter a valid sales amount 💸"); return; }
  if (isNaN(hours) || hours <= 0) { showToast("Enter hours worked ⏱️"); return; }
  await set(dbRef.dayLog(state.currentComp, state.currentUser, state.selectedDay), { sales, hours });
  const reaction = getBigOrderReaction(sales);
  if (reaction) { showToast(reaction, 3500); launchConfetti(); }
  else showToast("Logged! Keep grinding 💪");
}

// ══════════════════════════════════════════════════════
// ADMIN — Competitions
// ══════════════════════════════════════════════════════
function renderAdminComps() {
  const list = document.getElementById("admin-comp-list");
  if (!list) return;
  list.innerHTML = "";
  const entries = Object.entries(state.competitions);
  const toShow = state.admin.showAllComps ? entries : entries.slice(0, PREVIEW_COUNT);

  toShow.forEach(([id, comp]) => {
    const item = document.createElement("div");
    item.className = "admin-item";
    item.id = `admin-comp-item-${id}`;
    item.innerHTML = `<span class="admin-item-name">${comp.name}</span>`;
    const editBtn = document.createElement("button");
    editBtn.className = "del-btn";
    editBtn.textContent = "✏️ Rename";
    editBtn.onclick = () => inlineRenameComp(id, comp.name);
    const delBtn = document.createElement("button");
    delBtn.className = "del-btn danger";
    delBtn.textContent = "✕";
    delBtn.onclick = async () => {
      if (confirm(`Delete "${comp.name}"? All logs will be removed.`)) {
        await remove(dbRef.comp(id));
        await remove(dbRef.compLogs(id));
        if (state.currentComp === id) state.currentComp = null;
      }
    };
    item.appendChild(editBtn);
    item.appendChild(delBtn);
    list.appendChild(item);
  });

  const toggleWrap = document.getElementById("admin-comp-toggle");
  if (toggleWrap) {
    toggleWrap.innerHTML = "";
    if (entries.length > PREVIEW_COUNT) {
      const btn = document.createElement("button");
      btn.className = "view-all-btn";
      btn.textContent = state.admin.showAllComps ? "Show less ▲" : `View all ${entries.length} ▼`;
      btn.onclick = () => { state.admin.showAllComps = !state.admin.showAllComps; renderAdminComps(); };
      toggleWrap.appendChild(btn);
    }
  }
}

function inlineRenameComp(compId, currentName) {
  const item = document.getElementById(`admin-comp-item-${compId}`);
  if (!item) return;
  item.innerHTML = "";
  const wrap = document.createElement("div");
  wrap.style.cssText = "display:flex;gap:8px;flex:1;align-items:center;";
  const input = document.createElement("input");
  input.type = "text"; input.className = "log-input"; input.value = currentName; input.style.flex = "1";
  const saveBtn = document.createElement("button");
  saveBtn.className = "mini-btn"; saveBtn.textContent = "Save";
  saveBtn.onclick = async () => {
    const newName = input.value.trim();
    if (!newName) { showToast("Enter a name"); return; }
    await update(dbRef.comp(compId), { name: newName });
    showToast("Renamed ✅");
  };
  const cancelBtn = document.createElement("button");
  cancelBtn.className = "mini-btn";
  cancelBtn.style.cssText = "background:var(--bg);color:var(--text2);border:2px solid var(--border);";
  cancelBtn.textContent = "Cancel";
  cancelBtn.onclick = renderAdminComps;
  wrap.appendChild(input); wrap.appendChild(saveBtn); wrap.appendChild(cancelBtn);
  item.appendChild(wrap);
  input.focus(); input.select();
}

// ══════════════════════════════════════════════════════
// ADMIN — Employees
// ══════════════════════════════════════════════════════
function renderAdminEmps() {
  const list = document.getElementById("admin-emp-list");
  if (!list) return;
  list.innerHTML = "";

  const search = state.admin.empSearch.toLowerCase();
  const allEntries = Object.entries(state.employees).sort(([, a], [, b]) => a.name.localeCompare(b.name));
  const filtered = search ? allEntries.filter(([, emp]) => emp.name.toLowerCase().includes(search)) : allEntries;
  const toShow = state.admin.showAllEmps ? filtered : filtered.slice(0, PREVIEW_COUNT);

  if (toShow.length === 0) {
    list.innerHTML = `<div style="color:var(--text3);font-size:0.8rem;text-align:center;padding:16px;">No employees found</div>`;
  } else {
    toShow.forEach(([id, emp]) => {
      const item = document.createElement("div");
      item.className = "admin-item";
      item.innerHTML = `<span class="admin-item-name">${emp.name}</span>`;
      const del = document.createElement("button");
      del.className = "del-btn danger"; del.textContent = "✕ Remove";
      del.onclick = async () => {
        if (confirm(`Remove "${emp.name}" from the roster?`)) await remove(dbRef.emp(id));
      };
      item.appendChild(del);
      list.appendChild(item);
    });
  }

  const toggleWrap = document.getElementById("admin-emp-toggle");
  if (toggleWrap) {
    toggleWrap.innerHTML = "";
    if (filtered.length > PREVIEW_COUNT) {
      const btn = document.createElement("button");
      btn.className = "view-all-btn";
      btn.textContent = state.admin.showAllEmps ? "Show less ▲" : `View all ${filtered.length} employees ▼`;
      btn.onclick = () => { state.admin.showAllEmps = !state.admin.showAllEmps; renderAdminEmps(); };
      toggleWrap.appendChild(btn);
    }
  }
}

// ══════════════════════════════════════════════════════
// ADMIN — Logs section
// ══════════════════════════════════════════════════════
function renderAdminLogsSection() {
  const empSel = document.getElementById("admin-logs-emp");
  if (!empSel) return;

  empSel.innerHTML = `<option value="">— Select employee —</option>`;
  Object.entries(state.employees)
    .sort(([, a], [, b]) => a.name.localeCompare(b.name))
    .forEach(([id, emp]) => {
      const opt = document.createElement("option");
      opt.value = id; opt.textContent = emp.name;
      empSel.appendChild(opt);
    });

  if (state.admin.selectedEmp && state.employees[state.admin.selectedEmp]) {
    empSel.value = state.admin.selectedEmp;
  } else {
    state.admin.selectedEmp = null;
  }

  const compSel = document.getElementById("admin-logs-comp");
  if (compSel) {
    compSel.innerHTML = "";
    Object.entries(state.competitions).forEach(([id, comp]) => {
      const opt = document.createElement("option");
      opt.value = id; opt.textContent = comp.name;
      compSel.appendChild(opt);
    });
    const targetComp = state.admin.selectedComp || state.currentComp;
    if (targetComp) { compSel.value = targetComp; state.admin.selectedComp = targetComp; }
  }

  refreshAdminDayView();
}

function refreshAdminDayView() {
  const empId = state.admin.selectedEmp;
  const compId = state.admin.selectedComp || state.currentComp;
  const dayContainer = document.getElementById("admin-logs-days");
  const dayDetail = document.getElementById("admin-logs-detail");
  if (!dayContainer || !dayDetail) return;

  if (!empId) {
    dayContainer.innerHTML = "";
    dayDetail.innerHTML = `<p style="color:var(--text3);font-size:0.8rem;text-align:center;padding:20px;">Select an employee above to view & manage their logs</p>`;
    return;
  }

  const empLogs = (state.logs[compId] || {})[empId] || {};
  dayContainer.innerHTML = "";

  DAYS.forEach(day => {
    const hasLog = !!empLogs[day];
    const btn = document.createElement("button");
    btn.className = `admin-day-btn${hasLog ? " has-log" : ""}`;
    btn.textContent = day;
    btn.title = hasLog ? `$${empLogs[day].sales} / ${empLogs[day].hours}hrs` : "No log yet";
    btn.onclick = () => {
      document.querySelectorAll("#admin-logs-days .admin-day-btn").forEach(b => b.classList.remove("active"));
      btn.classList.add("active");
      if (hasLog) renderAdminLogDetail(empId, compId, day, empLogs[day]);
      else renderAdminLogCreate(empId, compId, day);
    };
    dayContainer.appendChild(btn);
  });

  // Auto-select today or first logged day
  const today = state.selectedDay;
  const autoDay = empLogs[today] ? today : (DAYS.find(d => empLogs[d]) || DAYS[0]);
  const autoIdx = DAYS.indexOf(autoDay);
  const autoBtn = dayContainer.children[autoIdx];
  if (autoBtn) {
    autoBtn.classList.add("active");
    if (empLogs[autoDay]) renderAdminLogDetail(empId, compId, autoDay, empLogs[autoDay]);
    else renderAdminLogCreate(empId, compId, autoDay);
  }
}

function renderAdminLogDetail(empId, compId, day, log) {
  const detail = document.getElementById("admin-logs-detail");
  if (!detail) return;
  const sph = log.hours > 0 ? (log.sales / log.hours).toFixed(0) : "—";
  const empName = state.employees[empId]?.name || "";
  const compName = state.competitions[compId]?.name || "";

  detail.innerHTML = `
    <div class="admin-log-header">
      <div class="admin-log-header-info">
        <div class="admin-log-header-name">${empName}</div>
        <div class="admin-log-header-sub">${day} · ${compName}</div>
      </div>
      <div class="admin-log-header-badge logged">✓ Logged</div>
    </div>
    <div class="admin-log-stats">
      <div class="admin-log-stat">
        <div class="admin-log-stat-label">SALES</div>
        <div class="admin-log-stat-value">$${log.sales.toFixed(2)}</div>
      </div>
      <div class="admin-log-stat">
        <div class="admin-log-stat-label">HOURS</div>
        <div class="admin-log-stat-value">${log.hours.toFixed(1)}</div>
      </div>
      <div class="admin-log-stat accent">
        <div class="admin-log-stat-label">$/HR</div>
        <div class="admin-log-stat-value">$${sph}</div>
      </div>
    </div>
    <div class="admin-log-actions-row">
      <button class="admin-action-edit" id="admin-edit-log-btn">✏️ Edit</button>
      <button class="admin-action-delete" id="admin-delete-log-btn">🗑️ Delete</button>
    </div>
  `;

  document.getElementById("admin-edit-log-btn").onclick = () => renderAdminLogEdit(empId, compId, day, log);
  document.getElementById("admin-delete-log-btn").onclick = async () => {
    if (confirm(`Delete ${day} log for ${state.employees[empId]?.name}?`)) {
      await remove(dbRef.dayLog(compId, empId, day));
      showToast("Log deleted ✅");
    }
  };
}

function renderAdminLogCreate(empId, compId, day) {
  const detail = document.getElementById("admin-logs-detail");
  if (!detail) return;
  const empName = state.employees[empId]?.name || "";
  const compName = state.competitions[compId]?.name || "";

  detail.innerHTML = `
    <div class="admin-log-header">
      <div class="admin-log-header-info">
        <div class="admin-log-header-name">${empName}</div>
        <div class="admin-log-header-sub">${day} · ${compName}</div>
      </div>
      <div class="admin-log-header-badge not-logged">✗ No Log Yet</div>
    </div>
    <div class="log-fields" style="margin-top:14px;">
      <div class="log-field-wrap">
        <label class="field-label">SALES ($)</label>
        <input type="number" id="admin-create-sales" class="log-input" placeholder="0.00" min="0" step="0.01" />
      </div>
      <div class="log-field-wrap">
        <label class="field-label">HOURS</label>
        <input type="number" id="admin-create-hours" class="log-input" placeholder="0.0" min="0" step="0.5" />
      </div>
    </div>
    <button class="log-btn" id="admin-create-log-btn" style="margin-top:10px;">+ CREATE LOG</button>
  `;

  document.getElementById("admin-create-log-btn").onclick = async () => {
    const sales = parseFloat(document.getElementById("admin-create-sales").value);
    const hours = parseFloat(document.getElementById("admin-create-hours").value);
    if (isNaN(sales) || sales < 0) { showToast("Enter valid sales amount"); return; }
    if (isNaN(hours) || hours <= 0) { showToast("Enter hours worked"); return; }
    await set(dbRef.dayLog(compId, empId, day), { sales, hours });
    showToast("Log created ✅");
    if (state.currentUser === empId) { renderDash(); renderBoard(); renderAllTime(); }
  };
}

function renderAdminLogEdit(empId, compId, day, log) {
  const detail = document.getElementById("admin-logs-detail");
  if (!detail) return;
  const empName = state.employees[empId]?.name || "";
  const compName = state.competitions[compId]?.name || "";

  detail.innerHTML = `
    <div class="admin-log-header">
      <div class="admin-log-header-info">
        <div class="admin-log-header-name">${empName}</div>
        <div class="admin-log-header-sub">Editing ${day} · ${compName}</div>
      </div>
    </div>
    <div class="log-fields" style="margin-top:14px;">
      <div class="log-field-wrap">
        <label class="field-label">SALES ($)</label>
        <input type="number" id="admin-edit-sales" class="log-input" value="${log.sales}" min="0" step="0.01" />
      </div>
      <div class="log-field-wrap">
        <label class="field-label">HOURS</label>
        <input type="number" id="admin-edit-hours" class="log-input" value="${log.hours}" min="0" step="0.5" />
      </div>
    </div>
    <div style="display:flex;gap:8px;margin-top:10px;">
      <button class="log-btn" id="admin-save-edit-btn">SAVE</button>
      <button class="log-btn" id="admin-cancel-edit-btn" style="background:var(--bg);color:var(--text2);border:2px solid var(--border);box-shadow:none;">CANCEL</button>
    </div>
  `;

  document.getElementById("admin-save-edit-btn").onclick = async () => {
    const sales = parseFloat(document.getElementById("admin-edit-sales").value);
    const hours = parseFloat(document.getElementById("admin-edit-hours").value);
    if (isNaN(sales) || sales < 0) { showToast("Enter valid sales amount"); return; }
    if (isNaN(hours) || hours <= 0) { showToast("Enter hours worked"); return; }
    await set(dbRef.dayLog(compId, empId, day), { sales, hours });
    showToast("Log updated ✅");
    if (state.currentUser === empId) { renderDash(); renderBoard(); renderAllTime(); }
  };

  document.getElementById("admin-cancel-edit-btn").onclick = () =>
    renderAdminLogDetail(empId, compId, day, log);
}

// ══════════════════════════════════════════════════════
// Screen management
// ══════════════════════════════════════════════════════
function showScreen(name) {
  document.querySelectorAll(".screen").forEach(s => s.classList.remove("active"));
  document.getElementById(`screen-${name}`).classList.add("active");
  window.scrollTo(0, 0);
}

function setActiveNav(tab) {
  document.querySelectorAll(".nav-btn").forEach(b => {
    b.classList.toggle("active", b.dataset.tab === tab);
  });
}

// ══════════════════════════════════════════════════════
// Toast
// ══════════════════════════════════════════════════════
let toastTimer;
function showToast(msg, duration = 2200) {
  const toast = document.getElementById("toast");
  toast.textContent = msg;
  toast.classList.remove("hidden");
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => toast.classList.add("hidden"), duration);
}

// ══════════════════════════════════════════════════════
// Confetti
// ══════════════════════════════════════════════════════
function launchConfetti() {
  const canvas = document.getElementById("confetti-canvas");
  const ctx = canvas.getContext("2d");
  canvas.width = window.innerWidth;
  canvas.height = window.innerHeight;
  const pieces = Array.from({ length: 80 }, () => ({
    x: Math.random() * canvas.width, y: -20,
    r: Math.random() * 8 + 4,
    color: ["#FF4D1C","#FF8C00","#F5A623","#1DB954","#0096FF"][Math.floor(Math.random()*5)],
    vx: (Math.random() - 0.5) * 4, vy: Math.random() * 4 + 3,
    spin: Math.random() * 0.2 - 0.1, angle: 0, life: 1,
  }));
  let frame;
  function draw() {
    ctx.clearRect(0, 0, canvas.width, canvas.height);
    let alive = false;
    pieces.forEach(p => {
      p.x += p.vx; p.y += p.vy; p.angle += p.spin; p.life -= 0.012;
      if (p.life <= 0 || p.y > canvas.height) return;
      alive = true;
      ctx.save(); ctx.globalAlpha = p.life;
      ctx.translate(p.x, p.y); ctx.rotate(p.angle);
      ctx.fillStyle = p.color;
      ctx.fillRect(-p.r/2, -p.r/2, p.r, p.r * 0.6);
      ctx.restore();
    });
    if (alive) frame = requestAnimationFrame(draw);
    else ctx.clearRect(0, 0, canvas.width, canvas.height);
  }
  cancelAnimationFrame(frame);
  draw();
}

// ══════════════════════════════════════════════════════
// Event wiring
// ══════════════════════════════════════════════════════
document.addEventListener("DOMContentLoaded", async () => {
  await bootstrap();
  startListeners();

  document.getElementById("btn-back").onclick        = () => { document.getElementById("input-search-employees").value = ""; showScreen("pick"); };
  document.getElementById("btn-back-board").onclick  = () => { document.getElementById("input-search-employees").value = ""; showScreen("pick"); };
  document.getElementById("btn-back-alltime").onclick = () => { document.getElementById("input-search-employees").value = ""; showScreen("pick"); };
  document.getElementById("btn-log").onclick         = logEntry;

  const searchInput = document.getElementById("input-search-employees");
  if (searchInput) searchInput.oninput = () => renderPickScreen(searchInput.value);

  const navMap = {
    "nav-dash": "dash", "nav-board": "board", "nav-alltime": "alltime",
    "nav-dash-2": "dash", "nav-board-2": "board", "nav-alltime-2": "alltime",
    "nav-dash-3": "dash", "nav-board-3": "board", "nav-alltime-3": "alltime",
  };
  Object.entries(navMap).forEach(([btnId, screen]) => {
    document.getElementById(btnId).onclick = () => { showScreen(screen); setActiveNav(screen); };
  });

  document.getElementById("btn-admin-open").onclick = () => {
    document.getElementById("modal-admin").classList.remove("hidden");
    document.getElementById("admin-pin-wrap").classList.remove("hidden");
    document.getElementById("admin-panel").classList.add("hidden");
    document.getElementById("input-pin").value = "";
    document.getElementById("pin-error").classList.add("hidden");
  };

  document.getElementById("btn-pin-submit").onclick = () => {
    if (document.getElementById("input-pin").value.trim() === ADMIN_PIN) {
      document.getElementById("admin-pin-wrap").classList.add("hidden");
      document.getElementById("admin-panel").classList.remove("hidden");
      state.admin.showAllComps = false;
      state.admin.showAllEmps = false;
      state.admin.selectedEmp = null;
      state.admin.selectedComp = state.currentComp;
      state.admin.empSearch = "";
      const empSearchEl = document.getElementById("admin-emp-search");
      if (empSearchEl) empSearchEl.value = "";
      renderAdminComps();
      renderAdminEmps();
      renderAdminLogsSection();
    } else {
      document.getElementById("pin-error").classList.remove("hidden");
    }
  };

  document.getElementById("input-pin").addEventListener("keydown", e => {
    if (e.key === "Enter") document.getElementById("btn-pin-submit").click();
  });

  document.getElementById("btn-admin-close").onclick = () =>
    document.getElementById("modal-admin").classList.add("hidden");

  document.getElementById("modal-admin").onclick = (e) => {
    if (e.target === document.getElementById("modal-admin"))
      document.getElementById("modal-admin").classList.add("hidden");
  };

  document.getElementById("btn-add-comp").onclick = async () => {
    const name = document.getElementById("input-new-comp").value.trim();
    if (!name) return;
    const id = `comp_${Date.now()}`;
    await set(dbRef.comp(id), { name, createdAt: Date.now() });
    state.currentComp = id;
    document.getElementById("input-new-comp").value = "";
    showToast(`"${name}" created! 🏆`);
  };

  document.getElementById("btn-add-emp").onclick = async () => {
    const name = document.getElementById("input-new-emp").value.trim();
    if (!name) return;
    const id = `${slugify(name)}_${Date.now()}`;
    await set(dbRef.emp(id), { name });
    document.getElementById("input-new-emp").value = "";
    showToast(`${name} added!`);
  };

  const adminEmpSearch = document.getElementById("admin-emp-search");
  if (adminEmpSearch) {
    adminEmpSearch.oninput = () => {
      state.admin.empSearch = adminEmpSearch.value;
      state.admin.showAllEmps = false;
      renderAdminEmps();
    };
  }

  const adminLogsEmp = document.getElementById("admin-logs-emp");
  if (adminLogsEmp) {
    adminLogsEmp.onchange = () => {
      state.admin.selectedEmp = adminLogsEmp.value || null;
      refreshAdminDayView();
    };
  }

  const adminLogsComp = document.getElementById("admin-logs-comp");
  if (adminLogsComp) {
    adminLogsComp.onchange = () => {
      state.admin.selectedComp = adminLogsComp.value;
      refreshAdminDayView();
    };
  }
});