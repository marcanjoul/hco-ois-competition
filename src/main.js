// src/main.js
import { db } from "./firebase.js";
import { ref, set, get, onValue, update, remove } from "firebase/database";

// ─────────────────────────────────────────────────────
// STEP 1 ▸ Add your employee names here
// ─────────────────────────────────────────────────────
const DEFAULT_EMPLOYEES = [
"adam",
"Ajla",
];

// ─────────────────────────────────────────────────────
// STEP 2 ▸ Set your admin PIN here
// ─────────────────────────────────────────────────────
const ADMIN_PIN = "1234"; // Change this!

// ══════════════════════════════════════════════════════
// Constants
// ══════════════════════════════════════════════════════
const DAYS = ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"];

// ── State ──────────────────────────────────────────
let state = {
  competitions: {},
  employees: {},
  logs: {},
  currentComp: null,
  currentUser: null,
  selectedDay: DAYS[new Date().getDay() === 0 ? 6 : new Date().getDay() - 1],
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
    DEFAULT_EMPLOYEES.forEach(name => {
      empUpdates[slugify(name)] = { name };
    });
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
    renderAdminEditSelects();
    populateAdminViewEmp();
  });

  onValue(dbRef.logs(), snap => {
    state.logs = snap.val() || {};
    renderPickScreen();
    if (state.currentUser) {
      renderDash();
      renderBoard();
      renderAllTime();
    }
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

  // Update search input
  const searchInput = document.getElementById("input-search-employees");
  if (searchInput && searchInput.value !== filterText) {
    searchInput.value = filterText;
  }

  const grid = document.getElementById("name-grid");
  if (!grid) return;
  grid.innerHTML = "";

  const ranked = getRankedPlayers(state.currentComp);

  // Filter employees by search text
  const filtered = Object.entries(state.employees).filter(([id, emp]) =>
    emp.name.toLowerCase().includes(filterText.toLowerCase())
  );

  // Handle empty results
  if (filtered.length === 0) {
    grid.classList.add("empty");
    grid.innerHTML = filterText ? "No employees found 🔍" : "No employees loaded";
    document.getElementById("search-results-info").classList.add("hidden");
    return;
  }

  grid.classList.remove("empty");

  // Update results info
  const resultsInfo = document.getElementById("search-results-info");
  if (filterText) {
    resultsInfo.textContent = `${filtered.length} of ${Object.keys(state.employees).length} employees`;
    resultsInfo.classList.remove("hidden");
  } else {
    resultsInfo.classList.add("hidden");
  }

  // Render filtered employees
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
  renderDash();
  renderBoard();
  renderAllTime();
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
  Object.values(myLogs).forEach(d => {
    totalSales += d.sales || 0;
    totalHours += d.hours || 0;
  });
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
  Object.entries(state.employees).forEach(([id, emp]) => {
    totals[id] = { id, name: emp.name, total: 0, hours: 0 };
  });

  Object.entries(state.logs).forEach(([, compLogs]) => {
    Object.entries(compLogs || {}).forEach(([empId, empLogs]) => {
      if (!totals[empId]) return;
      Object.values(empLogs || {}).forEach(log => {
        totals[empId].total += log.sales || 0;
        totals[empId].hours += log.hours || 0;
      });
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
// Log entry
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
// Admin renders
// ══════════════════════════════════════════════════════
function renderAdminComps() {
  const list = document.getElementById("admin-comp-list");
  if (!list) return;
  list.innerHTML = "";
  Object.entries(state.competitions).forEach(([id, comp]) => {
    const item = document.createElement("div");
    item.className = "admin-item";
    item.id = `admin-comp-${id}`;
    item.innerHTML = `<span class="admin-item-name">${comp.name}</span>`;

    const editBtn = document.createElement("button");
    editBtn.className = "del-btn";
    editBtn.textContent = "✏️ Edit";
    editBtn.onclick = () => editAdminComp(id);

    const delBtn = document.createElement("button");
    delBtn.className = "del-btn";
    delBtn.textContent = "✕ Delete";
    delBtn.onclick = async () => {
      if (confirm(`Delete "${comp.name}"? All its logs will be removed too.`)) {
        await remove(dbRef.comp(id));
        await remove(dbRef.compLogs(id));
        if (state.currentComp === id) state.currentComp = null;
      }
    };

    item.appendChild(editBtn);
    item.appendChild(delBtn);
    list.appendChild(item);
  });
}

function editAdminComp(compId) {
  const comp = state.competitions[compId];
  if (!comp) return;

  const itemEl = document.getElementById(`admin-comp-${compId}`);
  if (!itemEl) return;

  const currentName = comp.name;
  itemEl.innerHTML = "";

  const input = document.createElement("input");
  input.type = "text";
  input.className = "log-input";
  input.value = currentName;
  input.style.marginRight = "8px";

  const saveBtn = document.createElement("button");
  saveBtn.className = "mini-btn";
  saveBtn.textContent = "Save";
  saveBtn.onclick = async () => {
    const newName = input.value.trim();
    if (!newName) {
      showToast("Enter a competition name");
      return;
    }
    if (newName === currentName) {
      renderAdminComps();
      return;
    }
    await update(dbRef.comp(compId), { name: newName });
    showToast("Competition renamed ✅");
  };

  const cancelBtn = document.createElement("button");
  cancelBtn.className = "mini-btn";
  cancelBtn.style.background = "var(--bg)";
  cancelBtn.style.color = "var(--text2)";
  cancelBtn.style.borderColor = "var(--border)";
  cancelBtn.textContent = "Cancel";
  cancelBtn.onclick = renderAdminComps;

  const inputWrapper = document.createElement("div");
  inputWrapper.style.display = "flex";
  inputWrapper.style.gap = "8px";
  inputWrapper.appendChild(input);
  inputWrapper.appendChild(saveBtn);
  inputWrapper.appendChild(cancelBtn);

  itemEl.appendChild(inputWrapper);
  input.focus();
  input.select();
}

function renderAdminEmps() {
  const list = document.getElementById("admin-emp-list");
  if (!list) return;
  list.innerHTML = "";
  Object.entries(state.employees).forEach(([id, emp]) => {
    const item = document.createElement("div");
    item.className = "admin-item";
    item.innerHTML = `<span class="admin-item-name">${emp.name}</span>`;
    const del = document.createElement("button");
    del.className = "del-btn";
    del.textContent = "✕ Remove";
    del.onclick = async () => {
      if (confirm(`Remove "${emp.name}" from the roster?`)) await remove(dbRef.emp(id));
    };
    item.appendChild(del);
    list.appendChild(item);
  });
}

function renderAdminEditSelects() {
  const empSel = document.getElementById("admin-edit-emp");
  const daySel = document.getElementById("admin-edit-day");
  if (!empSel || !daySel) return;
  
  empSel.innerHTML = "";
  Object.entries(state.employees).forEach(([id, emp]) => {
    const opt = document.createElement("option");
    opt.value = id; opt.textContent = emp.name;
    empSel.appendChild(opt);
  });
  
  daySel.innerHTML = "";
  DAYS.forEach(d => {
    const opt = document.createElement("option");
    opt.value = d; opt.textContent = d;
    daySel.appendChild(opt);
  });

  function fillExisting() {
    const empId = empSel.value;
    const day = daySel.value;
    const existing = (state.logs[state.currentComp] || {})[empId]?.[day];
    document.getElementById("admin-edit-sales").value = existing ? existing.sales : "";
    document.getElementById("admin-edit-hours").value = existing ? existing.hours : "";
  }

  empSel.onchange = fillExisting;
  daySel.onchange = fillExisting;
  fillExisting();
}

// ══════════════════════════════════════════════════════
// Admin day-based log management
// ══════════════════════════════════════════════════════
function renderAdminDayButtons(empId, compId) {
  const container = document.getElementById("admin-day-buttons");
  if (!container) return;
  container.innerHTML = "";

  const empLogs = (state.logs[compId] || {})[empId] || {};

  DAYS.forEach((day, idx) => {
    const btn = document.createElement("button");
    btn.className = "admin-day-btn";
    if (idx === 0) btn.classList.add("active");
    if (empLogs[day]) btn.classList.add("has-log");

    btn.textContent = day;
    btn.onclick = () => selectAdminDay(empId, compId, day);
    container.appendChild(btn);
  });

  // Show first day by default
  selectAdminDay(empId, compId, DAYS[0]);
}

function selectAdminDay(empId, compId, day) {
  // Update active day button
  document.querySelectorAll(".admin-day-btn").forEach(btn => {
    btn.classList.toggle("active", btn.textContent === day);
  });

  const log = (state.logs[compId] || {})[empId]?.[day];

  if (log) {
    renderAdminLogDetail(empId, compId, day, log);
  } else {
    renderAdminCreateFormForDay(empId, compId, day);
  }
}

function renderAdminCreateFormForDay(empId, compId, day) {
  const detail = document.getElementById("admin-log-detail");
  if (!detail) return;

  const compName = state.competitions[compId]?.name || compId;

  detail.innerHTML = `
    <p class="modal-sub" style="margin-top:0;margin-bottom:10px">Create new log for ${day}</p>
    <div class="log-fields">
      <div class="log-field-wrap">
        <label class="field-label">COMPETITION</label>
        <div style="padding:10px 12px; background:var(--bg); border:2px solid var(--border); border-radius:10px; color:var(--text); font-weight:700; font-size:0.9rem">${compName}</div>
      </div>
      <div class="log-field-wrap">
        <label class="field-label">DAY</label>
        <div style="padding:10px 12px; background:var(--bg); border:2px solid var(--border); border-radius:10px; color:var(--text); font-weight:700; font-size:0.9rem">${day}</div>
      </div>
    </div>
    <div class="log-fields">
      <div class="log-field-wrap">
        <label class="field-label">SALES ($)</label>
        <input type="number" id="temp-admin-sales" class="log-input" placeholder="0.00" min="0" step="0.01" />
      </div>
      <div class="log-field-wrap">
        <label class="field-label">HOURS</label>
        <input type="number" id="temp-admin-hours" class="log-input" placeholder="0.0" min="0" step="0.5" />
      </div>
    </div>
    <button class="log-btn" style="margin-top:8px">CREATE LOG</button>
  `;

  const btn = detail.querySelector(".log-btn");
  btn.onclick = async () => {
    const sales = parseFloat(document.getElementById("temp-admin-sales").value);
    const hours = parseFloat(document.getElementById("temp-admin-hours").value);

    if (isNaN(sales) || sales < 0) {
      showToast("Enter valid sales amount");
      return;
    }
    if (isNaN(hours) || hours <= 0) {
      showToast("Enter hours worked");
      return;
    }

    await set(dbRef.dayLog(compId, empId, day), { sales, hours });
    showToast("Log created ✅");
    renderAdminDayButtons(empId, compId);
  };
}

function renderAdminLogDetail(empId, compId, day, log) {
  const detail = document.getElementById("admin-log-detail");
  if (!detail) return;

  const sph = log.hours > 0 ? (log.sales / log.hours).toFixed(0) : "—";
  const compName = state.competitions[compId]?.name || compId;

  detail.innerHTML = `
    <div style="display:flex; justify-content:space-between; align-items:center; margin-bottom:14px">
      <div>
        <p class="modal-sub" style="margin:0;margin-bottom:4px">${day} in "${compName}"</p>
      </div>
    </div>
    <div class="admin-log-display">
      <div class="admin-log-value">
        <div class="admin-log-value-label">SALES</div>
        <div class="admin-log-value-amount">$${log.sales.toFixed(2)}</div>
      </div>
      <div class="admin-log-value">
        <div class="admin-log-value-label">HOURS</div>
        <div class="admin-log-value-amount">${log.hours.toFixed(1)}</div>
      </div>
      <div class="admin-log-value">
        <div class="admin-log-value-label">$/HR</div>
        <div class="admin-log-value-amount">$${sph}</div>
      </div>
    </div>
    <div class="admin-log-actions">
      <button class="admin-log-edit-btn">✏️ Edit</button>
      <button class="admin-log-delete-btn">🗑️ Delete</button>
    </div>
  `;

  const editBtn = detail.querySelector(".admin-log-edit-btn");
  const deleteBtn = detail.querySelector(".admin-log-delete-btn");

  editBtn.onclick = () => renderAdminEditFormForDay(empId, compId, day, log);

  deleteBtn.onclick = () => {
    if (confirm(`Delete ${day} log from "${compName}"?`)) {
      remove(dbRef.dayLog(compId, empId, day));
      showToast("Log deleted ✅");
      renderAdminDayButtons(empId, compId);
    }
  };
}

function renderAdminEditFormForDay(empId, compId, day, log) {
  const detail = document.getElementById("admin-log-detail");
  if (!detail) return;

  const compName = state.competitions[compId]?.name || compId;

  detail.innerHTML = `
    <p class="modal-sub" style="margin-top:0;margin-bottom:10px">Edit log for ${day}</p>
    <div class="log-fields">
      <div class="log-field-wrap">
        <label class="field-label">SALES ($)</label>
        <input type="number" id="temp-edit-sales" class="log-input" value="${log.sales}" min="0" step="0.01" />
      </div>
      <div class="log-field-wrap">
        <label class="field-label">HOURS</label>
        <input type="number" id="temp-edit-hours" class="log-input" value="${log.hours}" min="0" step="0.5" />
      </div>
    </div>
    <div style="display:flex; gap:8px; margin-top:8px">
      <button class="log-btn" style="flex:1">SAVE</button>
      <button class="log-btn" style="flex:1; background:var(--bg); color:var(--text2); border:2px solid var(--border)">CANCEL</button>
    </div>
  `;

  const buttons = detail.querySelectorAll(".log-btn");
  const saveBtn = buttons[0];
  const cancelBtn = buttons[1];

  saveBtn.onclick = async () => {
    const sales = parseFloat(document.getElementById("temp-edit-sales").value);
    const hours = parseFloat(document.getElementById("temp-edit-hours").value);

    if (isNaN(sales) || sales < 0) {
      showToast("Enter valid sales amount");
      return;
    }
    if (isNaN(hours) || hours <= 0) {
      showToast("Enter hours worked");
      return;
    }

    await set(dbRef.dayLog(compId, empId, day), { sales, hours });
    showToast("Log updated ✅");
    renderAdminDayButtons(empId, compId);
  };

  cancelBtn.onclick = () => {
    renderAdminLogDetail(empId, compId, day, log);
  };
}

function populateAdminCompDropdown() {
  const select = document.getElementById("admin-view-comp");
  if (!select) return;

  select.innerHTML = "";
  Object.entries(state.competitions).forEach(([id, comp]) => {
    const opt = document.createElement("option");
    opt.value = id;
    opt.textContent = comp.name;
    select.appendChild(opt);
  });

  select.onchange = () => {
    const empId = document.getElementById("admin-view-emp").value;
    renderAdminDayButtons(empId, select.value);
  };
}

// ══════════════════════════════════════════════════════
// ══════════════════════════════════════════════════════
function empHasLogsInCurrentComp(empId) {
  const empLogs = (state.logs[state.currentComp] || {})[empId] || {};
  return Object.keys(empLogs).length > 0;
}

function toggleCreateLogForm(empId) {
  const createForm = document.querySelector(".admin-create-form");
  if (!createForm) return;

  if (empHasLogsInCurrentComp(empId)) {
    createForm.style.display = "none";
  } else {
    createForm.style.display = "block";
  }
}
function renderAdminLogList(empId, viewAllComps = false) {
  const list = document.getElementById("admin-log-list");
  if (!list) return;
  list.innerHTML = "";

  const logsToShow = {};

  if (viewAllComps) {
    // Collect logs from all competitions for this employee
    Object.entries(state.logs).forEach(([compId, compLogs]) => {
      const empLogs = (compLogs || {})[empId] || {};
      const compName = state.competitions[compId]?.name || compId;
      Object.entries(empLogs).forEach(([day, log]) => {
        const key = `${compId}-${day}`;
        logsToShow[key] = { ...log, day, compId, compName };
      });
    });
  } else {
    // Only show logs from current competition
    const empLogs = (state.logs[state.currentComp] || {})[empId] || {};
    Object.entries(empLogs).forEach(([day, log]) => {
      const key = `${state.currentComp}-${day}`;
      logsToShow[key] = { ...log, day, compId: state.currentComp, compName: state.competitions[state.currentComp]?.name };
    });
  }

  if (Object.keys(logsToShow).length === 0) {
    list.innerHTML = `<div class="admin-log-empty">No logs for this employee</div>`;
    return;
  }

  // Sort by day of week, then by competition
  const sortedLogs = Object.entries(logsToShow).sort(([, a], [, b]) => {
    const dayOrder = DAYS.indexOf(a.day) - DAYS.indexOf(b.day);
    return dayOrder !== 0 ? dayOrder : (a.compName || "").localeCompare(b.compName || "");
  });

  sortedLogs.forEach(([key, log]) => {
    const item = document.createElement("div");
    item.className = "admin-log-item";
    item.id = `admin-log-${key}`;

    const sph = log.hours > 0 ? (log.sales / log.hours).toFixed(0) : "—";

    item.innerHTML = `
      <div class="admin-log-item-header">
        <div>
          <span class="admin-log-item-day">${log.day}</span>
          ${viewAllComps ? `<span class="admin-log-item-comp">${log.compName}</span>` : ""}
        </div>
      </div>
      <div class="admin-log-item-details">
        <div class="admin-log-detail">
          <div class="admin-log-detail-label">SALES</div>
          <div class="admin-log-detail-value">$${log.sales.toFixed(2)}</div>
        </div>
        <div class="admin-log-detail">
          <div class="admin-log-detail-label">HOURS</div>
          <div class="admin-log-detail-value">${log.hours.toFixed(1)}</div>
        </div>
        <div class="admin-log-detail">
          <div class="admin-log-detail-label">$/HR</div>
          <div class="admin-log-detail-value">$${sph}</div>
        </div>
      </div>
      <div class="admin-log-item-actions">
        <button class="admin-edit-btn" onclick="window.editAdminLog('${log.compId}', '${empId}', '${log.day}')">Edit</button>
        <button class="admin-delete-btn" onclick="window.deleteAdminLog('${log.compId}', '${empId}', '${log.day}')">Delete</button>
      </div>
    `;
    list.appendChild(item);
  });
}

function editAdminLog(compId, empId, day) {
  const itemId = `admin-log-${compId}-${day}`;
  const item = document.getElementById(itemId);
  if (!item) return;

  const existing = (state.logs[compId] || {})[empId]?.[day] || {};

  item.classList.add("editing");
  item.innerHTML = `
    <div class="admin-log-item-edit-form">
      <div class="admin-log-detail">
        <div class="admin-log-detail-label">${day} - ${state.competitions[compId]?.name}</div>
      </div>
      <div class="log-fields">
        <div class="log-field-wrap">
          <label class="field-label">SALES ($)</label>
          <input type="number" class="log-input edit-sales" value="${existing.sales || 0}" step="0.01" />
        </div>
        <div class="log-field-wrap">
          <label class="field-label">HOURS</label>
          <input type="number" class="log-input edit-hours" value="${existing.hours || 0}" step="0.5" />
        </div>
      </div>
      <div class="admin-log-item-edit-actions">
        <button class="admin-log-save-btn">Save</button>
        <button class="admin-log-cancel-btn">Cancel</button>
      </div>
    </div>
  `;

  const saveBtn = item.querySelector(".admin-log-save-btn");
  const cancelBtn = item.querySelector(".admin-log-cancel-btn");
  const salesInput = item.querySelector(".edit-sales");
  const hoursInput = item.querySelector(".edit-hours");

  saveBtn.onclick = async () => {
    const sales = parseFloat(salesInput.value);
    const hours = parseFloat(hoursInput.value);
    if (isNaN(sales) || isNaN(hours)) {
      showToast("Please enter valid numbers");
      return;
    }
    await set(dbRef.dayLog(compId, empId, day), { sales, hours });
    showToast("Log updated ✅");
    renderAdminLogList(empId, document.getElementById("scope-all").classList.contains("active"));
  };

  cancelBtn.onclick = () => {
    renderAdminLogList(empId, document.getElementById("scope-all").classList.contains("active"));
  };
}

function deleteAdminLog(compId, empId, day) {
  const compName = state.competitions[compId]?.name;
  if (!confirm(`Delete ${day} log from "${compName}"?`)) return;

  remove(dbRef.dayLog(compId, empId, day));
  showToast("Log deleted ✅");
  renderAdminLogList(empId, document.getElementById("scope-all").classList.contains("active"));
}

// Make functions accessible globally for inline onclick handlers
window.editAdminLog = editAdminLog;
window.deleteAdminLog = deleteAdminLog;

// ══════════════════════════════════════════════════════
// Admin log creation
// ══════════════════════════════════════════════════════
function populateAdminCreateSelects() {
  const compSel = document.getElementById("admin-create-comp");
  const daySel = document.getElementById("admin-create-day");
  if (!compSel || !daySel) return;

  // Populate competitions
  compSel.innerHTML = "";
  Object.entries(state.competitions).forEach(([id, comp]) => {
    const opt = document.createElement("option");
    opt.value = id;
    opt.textContent = comp.name;
    compSel.appendChild(opt);
  });

  // Populate days
  daySel.innerHTML = "";
  DAYS.forEach(d => {
    const opt = document.createElement("option");
    opt.value = d;
    opt.textContent = d;
    daySel.appendChild(opt);
  });

  // Clear input fields
  document.getElementById("admin-create-sales").value = "";
  document.getElementById("admin-create-hours").value = "";
}

async function createAdminLog(empId) {
  const compId = document.getElementById("admin-create-comp").value;
  const day = document.getElementById("admin-create-day").value;
  const sales = parseFloat(document.getElementById("admin-create-sales").value);
  const hours = parseFloat(document.getElementById("admin-create-hours").value);

  // Validation
  if (!compId || !day) {
    showToast("Select competition and day");
    return;
  }
  if (isNaN(sales) || sales < 0) {
    showToast("Enter valid sales amount");
    return;
  }
  if (isNaN(hours) || hours <= 0) {
    showToast("Enter hours worked");
    return;
  }

  // Check if log already exists
  const existing = (state.logs[compId] || {})[empId]?.[day];
  if (existing) {
    if (!confirm(`A ${day} log already exists. Overwrite it?`)) return;
  }

  // Create the log
  await set(dbRef.dayLog(compId, empId, day), { sales, hours });

  // Refresh the log list if viewing that competition
  const viewAllComps = document.getElementById("scope-all").classList.contains("active");
  renderAdminLogList(empId, viewAllComps);

  // If employee is currently viewing the dashboard, update it immediately
  if (state.currentUser === empId) {
    // If viewing same competition, show confirmation
    if (state.currentComp === compId) {
      showToast("Log created and visible on dashboard ✅");
      renderDash();
      renderBoard();
      renderAllTime();
    } else {
      // Different competition - inform user
      const empName = state.employees[empId]?.name || empId;
      const compName = state.competitions[compId]?.name || compId;
      showToast(`Log created for ${empName} in "${compName}" (not current view)`, 3000);
    }
  } else {
    showToast("Log created ✅");
  }

  // Clear form
  document.getElementById("admin-create-sales").value = "";
  document.getElementById("admin-create-hours").value = "";

  // Hide create form if employee now has logs in this competition
  toggleCreateLogForm(empId);
}
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
      ctx.save();
      ctx.globalAlpha = p.life;
      ctx.translate(p.x, p.y);
      ctx.rotate(p.angle);
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

  // Employee search
  const searchInput = document.getElementById("input-search-employees");
  if (searchInput) {
    searchInput.oninput = () => renderPickScreen(searchInput.value);
  }

  // Nav
  const navMap = { "nav-dash": "dash", "nav-board": "board", "nav-alltime": "alltime",
                   "nav-dash-2": "dash", "nav-board-2": "board", "nav-alltime-2": "alltime",
                   "nav-dash-3": "dash", "nav-board-3": "board", "nav-alltime-3": "alltime" };
  Object.entries(navMap).forEach(([btnId, screen]) => {
    document.getElementById(btnId).onclick = () => { showScreen(screen); setActiveNav(screen); };
  });

  // Admin modal
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
      renderAdminComps(); renderAdminEmps(); renderAdminEditSelects(); populateAdminViewEmp();
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

  document.getElementById("btn-admin-save-log").onclick = async () => {
    const empId = document.getElementById("admin-edit-emp").value;
    const day   = document.getElementById("admin-edit-day").value;
    const sales = parseFloat(document.getElementById("admin-edit-sales").value);
    const hours = parseFloat(document.getElementById("admin-edit-hours").value);
    if (!empId || !day || isNaN(sales) || isNaN(hours)) { showToast("Fill in all fields"); return; }
    await set(dbRef.dayLog(state.currentComp, empId, day), { sales, hours });
    showToast("Log updated ✅");
  };

  // Admin view/edit logs
  function populateAdminViewEmp() {
    const select = document.getElementById("admin-view-emp");
    if (!select) return;
    select.innerHTML = "";
    Object.entries(state.employees).forEach(([id, emp]) => {
      const opt = document.createElement("option");
      opt.value = id;
      opt.textContent = emp.name;
      select.appendChild(opt);
    });
    if (select.options.length > 0) {
      select.value = select.options[0].value;
      const viewAllComps = document.getElementById("scope-all").classList.contains("active");
      if (viewAllComps) {
        document.getElementById("admin-comp-selector").classList.remove("hidden");
        populateAdminCompDropdown();
      } else {
        document.getElementById("admin-comp-selector").classList.add("hidden");
        renderAdminDayButtons(select.value, state.currentComp);
      }
    }
  }

  const adminViewEmp = document.getElementById("admin-view-emp");
  if (adminViewEmp) {
    adminViewEmp.onchange = () => {
      const viewAllComps = document.getElementById("scope-all").classList.contains("active");
      if (viewAllComps) {
        document.getElementById("admin-comp-selector").classList.remove("hidden");
        populateAdminCompDropdown();
      } else {
        document.getElementById("admin-comp-selector").classList.add("hidden");
        renderAdminDayButtons(adminViewEmp.value, state.currentComp);
      }
    };
  }

  const scopeCurrentBtn = document.getElementById("scope-current");
  const scopeAllBtn = document.getElementById("scope-all");
  if (scopeCurrentBtn && scopeAllBtn) {
    scopeCurrentBtn.onclick = () => {
      scopeCurrentBtn.classList.add("active");
      scopeAllBtn.classList.remove("active");
      document.getElementById("admin-comp-selector").classList.add("hidden");
      const empId = adminViewEmp.value;
      renderAdminDayButtons(empId, state.currentComp);
    };
    scopeAllBtn.onclick = () => {
      scopeAllBtn.classList.add("active");
      scopeCurrentBtn.classList.remove("active");
      document.getElementById("admin-comp-selector").classList.remove("hidden");
      populateAdminCompDropdown();
    };
  }

  // When admin panel opens, populate the view/edit section
  const originalAdminOpen = document.getElementById("btn-admin-open").onclick;
  document.getElementById("btn-admin-open").onclick = () => {
    populateAdminViewEmp();
    originalAdminOpen();
  };
});
