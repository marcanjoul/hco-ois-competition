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
const ADMIN_PIN = "1234";

// ══════════════════════════════════════════════════════
const DAYS = ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"];
const PREVIEW_COUNT = 5;

let state = {
  competitions: {},
  employees: {},
  logs: {},
  settings: {},   // site-wide settings
  goals: {},      // { compId: { competition: {type,value}, weekly: {type,value}, daily: {type,value}, perAssociate: {empId: {type,value}} } }
  currentComp: null,
  currentUser: null,
  selectedDay: DAYS[new Date().getDay() === 0 ? 6 : new Date().getDay() - 1],
  admin: {
    showAllComps: false,
    showAllEmps: false,
    selectedEmp: null,
    selectedComp: null,
    empSearch: "",
    tab: "competitions", // competitions | employees | logs | goals | site
  },
};

const dbRef = {
  comps:    ()              => ref(db, "competitions"),
  comp:     (id)            => ref(db, `competitions/${id}`),
  emps:     ()              => ref(db, "employees"),
  emp:      (id)            => ref(db, `employees/${id}`),
  logs:     ()              => ref(db, "logs"),
  compLogs: (cId)           => ref(db, `logs/${cId}`),
  dayLog:   (cId, eId, day) => ref(db, `logs/${cId}/${eId}/${day}`),
  settings: ()              => ref(db, "settings"),
  goals:    ()              => ref(db, "goals"),
  compGoals:(cId)           => ref(db, `goals/${cId}`),
};

// ══════════════════════════════════════════════════════
// Bootstrap
// ══════════════════════════════════════════════════════
async function bootstrap() {
  const [empSnap, compSnap, settingsSnap] = await Promise.all([
    get(dbRef.emps()), get(dbRef.comps()), get(dbRef.settings()),
  ]);
  if (!empSnap.exists()) {
    const u = {};
    DEFAULT_EMPLOYEES.forEach(name => { u[slugify(name)] = { name, active: true }; });
    await update(dbRef.emps(), u);
  }
  if (!compSnap.exists()) {
    const id = `comp_${Date.now()}`;
    await set(dbRef.comp(id), { name: "Week 1", createdAt: Date.now(), status: "active" });
  }
  if (!settingsSnap.exists()) {
    await set(dbRef.settings(), { storeName: "Hollister", accentColor: "#FF4D1C", bannerMessage: "", rankingMetric: "sph", showHours: true });
  }
}

function slugify(str) {
  return str.toLowerCase().replace(/\s+/g, "_").replace(/[^a-z0-9_]/g, "");
}

// ══════════════════════════════════════════════════════
// Reactive button helper
// ══════════════════════════════════════════════════════
window.updateBtnState = function(inputId, btnId) {
  const input = document.getElementById(inputId);
  const btn = document.getElementById(btnId);
  if (!input || !btn) return;
  const hasValue = input.value.trim().length > 0;
  btn.disabled = !hasValue;
  btn.classList.toggle("btn-ghost", !hasValue);
};

// ══════════════════════════════════════════════════════
// Apply site settings
// ══════════════════════════════════════════════════════
function applySettings(s = {}) {
  const name = s.storeName || "Hollister";
  const color = s.accentColor || "#FF4D1C";
  const banner = s.bannerMessage || "";
  document.querySelectorAll(".store-name").forEach(el => el.textContent = name);
  document.documentElement.style.setProperty("--accent", color);
  // derive accent2 (lighten slightly)
  document.documentElement.style.setProperty("--accent2", color + "CC");
  const bannerEl = document.getElementById("site-banner");
  if (bannerEl) {
    bannerEl.textContent = banner;
    bannerEl.style.display = banner ? "block" : "none";
  }
}

// ══════════════════════════════════════════════════════
// Listeners
// ══════════════════════════════════════════════════════
function startListeners() {
  onValue(dbRef.comps(), snap => {
    state.competitions = snap.val() || {};
    if (!state.currentComp || !state.competitions[state.currentComp]) {
      const ids = Object.keys(state.competitions);
      if (ids.length) state.currentComp = ids[ids.length - 1];
    }
    renderPickScreen();
    if (state.admin.tab === "competitions") renderAdminTab();
    if (state.admin.tab === "goals") renderAdminTab();
  });

  onValue(dbRef.emps(), snap => {
    state.employees = snap.val() || {};
    renderPickScreen();
    if (state.admin.tab === "employees") renderAdminTab();
    if (state.admin.tab === "logs") renderAdminTab();
    if (state.admin.tab === "goals") renderAdminTab();
  });

  onValue(dbRef.logs(), snap => {
    state.logs = snap.val() || {};
    renderPickScreen();
    if (state.currentUser) { renderDash(); renderBoard(); renderAllTime(); }
    if (state.admin.tab === "logs" && state.admin.selectedEmp) refreshAdminDayView();
  });

  onValue(dbRef.settings(), snap => {
    state.settings = snap.val() || {};
    applySettings(state.settings);
  });

  onValue(dbRef.goals(), snap => {
    state.goals = snap.val() || {};
    if (state.currentUser) renderDash();
    if (state.admin.tab === "goals") renderAdminTab();
  });
}

// ══════════════════════════════════════════════════════
// Goal helpers
// ══════════════════════════════════════════════════════
function getCompGoals(compId) {
  return state.goals[compId] || {};
}

function getPlayerSph(empId, compId) {
  const logs = (state.logs[compId] || {})[empId] || {};
  let total = 0, hours = 0;
  Object.values(logs).forEach(l => { total += l.sales || 0; hours += l.hours || 0; });
  return { total, hours, sph: hours > 0 ? total / hours : 0 };
}

function getWeekSph(empId, compId) {
  // For now week = same as comp (one comp = one week)
  return getPlayerSph(empId, compId);
}

function getTodaySph(empId, compId) {
  const today = state.selectedDay;
  const log = (state.logs[compId] || {})[empId]?.[today];
  if (!log) return { total: 0, hours: 0, sph: 0 };
  return { total: log.sales || 0, hours: log.hours || 0, sph: log.hours > 0 ? (log.sales / log.hours) : 0 };
}

function renderGoalBar(current, target, type) {
  const pct = Math.min(100, target > 0 ? (current / target) * 100 : 0);
  const isHit = current >= target;
  const label = type === "sph" ? `$${current.toFixed(0)}/hr` : `$${current.toFixed(0)}`;
  const targetLabel = type === "sph" ? `$${target}/hr` : `$${target}`;
  return `
    <div class="goal-progress">
      <div class="goal-progress-top">
        <span class="goal-current${isHit ? " goal-hit" : ""}">${label}</span>
        <span class="goal-target">Goal: ${targetLabel}</span>
      </div>
      <div class="goal-bar-bg">
        <div class="goal-bar-fill${isHit ? " goal-hit-bar" : ""}" style="width:${pct}%"></div>
      </div>
    </div>
  `;
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
// Pick Screen
// ══════════════════════════════════════════════════════
function renderPickScreen(filterText = "") {
  const tabsEl = document.getElementById("comp-tabs");
  if (tabsEl) {
    tabsEl.innerHTML = "";
    Object.entries(state.competitions)
      .filter(([, c]) => c.status !== "archived")
      .forEach(([id, comp]) => {
        const btn = document.createElement("button");
        btn.className = `comp-tab${state.currentComp === id ? " active" : ""}`;
        btn.textContent = comp.name + (comp.status === "closed" ? " 🔒" : "");
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
  const filtered = Object.entries(state.employees)
    .filter(([, emp]) => emp.active !== false && emp.name.toLowerCase().includes(filterText.toLowerCase()));

  if (filtered.length === 0) {
    grid.classList.add("empty");
    grid.innerHTML = filterText ? "No employees found 🔍" : "No employees loaded";
    document.getElementById("search-results-info")?.classList.add("hidden");
    return;
  }

  grid.classList.remove("empty");
  const resultsInfo = document.getElementById("search-results-info");
  if (resultsInfo) {
    if (filterText) {
      resultsInfo.textContent = `${filtered.length} of ${Object.values(state.employees).filter(e => e.active !== false).length} employees`;
      resultsInfo.classList.remove("hidden");
    } else {
      resultsInfo.classList.add("hidden");
    }
  }

  filtered.forEach(([id, emp]) => {
    const rank = ranked.findIndex(r => r.id === id);
    const pip = rank === 0 ? "👑" : rank === 1 ? "🥈" : rank === 2 ? "🥉" : "";
    const compGoals = getCompGoals(state.currentComp);
    const winner = state.competitions[state.currentComp]?.winner;
    const isWinner = winner === id;
    const btn = document.createElement("button");
    btn.className = `name-btn${isWinner ? " name-btn-winner" : ""}`;
    btn.innerHTML = `${pip ? `<span class="rank-pip">${pip}</span>` : ""}${isWinner ? "🏆 " : ""}${emp.name}`;
    btn.onclick = () => enterAsDashboard(id);
    grid.appendChild(btn);
  });
}

// ══════════════════════════════════════════════════════
// Dashboard
// ══════════════════════════════════════════════════════
function enterAsDashboard(empId) {
  state.currentUser = empId;
  document.getElementById("input-search-employees").value = "";
  showScreen("dash");
  renderDash(); renderBoard(); renderAllTime();
}

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

  // Winner banner
  const winner = comp?.winner;
  const winnerBanner = document.getElementById("winner-banner");
  if (winnerBanner) {
    if (winner && state.employees[winner]) {
      const prize = comp?.prize || "";
      winnerBanner.innerHTML = `🏆 <strong>${state.employees[winner].name}</strong> won${prize ? ` — ${prize}` : ""}!`;
      winnerBanner.style.display = "block";
    } else {
      winnerBanner.style.display = "none";
    }
  }

  // Goals section
  const goalsEl = document.getElementById("dash-goals");
  if (goalsEl) {
    const compGoals = getCompGoals(state.currentComp);
    const empGoal = compGoals.perAssociate?.[state.currentUser] || compGoals.globalAssociate;
    let goalsHtml = "";

    if (compGoals.competition?.value) {
      const g = compGoals.competition;
      const current = g.type === "sph" ? sph : totalSales;
      goalsHtml += `<div class="goal-block"><div class="goal-label">🎯 Competition Goal</div>${renderGoalBar(current, g.value, g.type)}</div>`;
    }
    if (compGoals.weekly?.value) {
      const g = compGoals.weekly;
      const w = getWeekSph(state.currentUser, state.currentComp);
      const current = g.type === "sph" ? w.sph : w.total;
      goalsHtml += `<div class="goal-block"><div class="goal-label">📅 Weekly Goal</div>${renderGoalBar(current, g.value, g.type)}</div>`;
    }
    if (compGoals.daily?.value) {
      const g = compGoals.daily;
      const d = getTodaySph(state.currentUser, state.currentComp);
      const current = g.type === "sph" ? d.sph : d.total;
      goalsHtml += `<div class="goal-block"><div class="goal-label">☀️ Daily Goal</div>${renderGoalBar(current, g.value, g.type)}</div>`;
    }
    if (empGoal?.value) {
      const current = empGoal.type === "sph" ? sph : totalSales;
      goalsHtml += `<div class="goal-block"><div class="goal-label">👤 Your Personal Goal</div>${renderGoalBar(current, empGoal.value, empGoal.type)}</div>`;
    }

    goalsEl.innerHTML = goalsHtml;
    goalsEl.style.display = goalsHtml ? "flex" : "none";
  }

  // Day buttons
  const dayRow = document.getElementById("day-row");
  dayRow.innerHTML = "";
  DAYS.forEach(d => {
    const btn = document.createElement("button");
    const hasEntry = myLogs[d] && (myLogs[d].sales > 0 || myLogs[d].hours > 0);
    btn.className = `day-btn${state.selectedDay === d ? " active" : ""}${hasEntry ? " logged" : ""}`;
    btn.textContent = d + (hasEntry ? " ✓" : "");
    btn.onclick = () => { state.selectedDay = d; renderDash(); };
    dayRow.appendChild(btn);
  });

  const existing = myLogs[state.selectedDay];
  const isLocked = !!(existing && (existing.sales > 0 || existing.hours > 0));
  const salesInput = document.getElementById("input-sales");
  const hoursInput = document.getElementById("input-hours");
  const logBtn = document.getElementById("btn-log");

  salesInput.value = existing ? existing.sales || "" : "";
  hoursInput.value = existing ? existing.hours || "" : "";

  if (isLocked) {
    salesInput.readOnly = true; hoursInput.readOnly = true;
    salesInput.classList.add("input-locked"); hoursInput.classList.add("input-locked");
    logBtn.disabled = true; logBtn.classList.add("btn-disabled");
    logBtn.textContent = "✓ Already Logged — See Admin to Edit";
  } else {
    salesInput.readOnly = false; hoursInput.readOnly = false;
    salesInput.classList.remove("input-locked"); hoursInput.classList.remove("input-locked");
    logBtn.disabled = false; logBtn.classList.remove("btn-disabled");
    logBtn.textContent = "+ LOG IT";
  }

  // History
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
// Leaderboard
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

  const metric = state.settings.rankingMetric || "sph";
  const topVal = metric === "sph" ? (ranked[0]?.sph || 1) : (ranked[0]?.total || 1);
  const winner = comp?.winner;

  ranked.forEach((player, i) => {
    const rankLabel = i === 0 ? "👑" : i === 1 ? "🥈" : i === 2 ? "🥉" : `#${i + 1}`;
    const val = metric === "sph" ? player.sph : player.total;
    const pct = topVal > 0 ? Math.max(4, (val / topVal) * 100) : 4;
    const isWinner = winner === player.id;
    const card = document.createElement("div");
    card.className = `board-card${i < 3 ? ` rank-${i + 1}` : ""}${isWinner ? " winner-card" : ""}`;
    card.style.animationDelay = `${i * 0.05}s`;
    card.innerHTML = `
      <div class="board-rank">${isWinner ? "🏆" : rankLabel}</div>
      <div class="board-info">
        <div class="board-name">${player.name}${isWinner ? " <span class='winner-label'>WINNER</span>" : ""}</div>
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
// All-Time
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
  const metric = state.settings.rankingMetric || "sph";
  return Object.entries(state.employees)
    .filter(([, emp]) => emp.active !== false)
    .map(([id, emp]) => {
      const empLogs = compLogs[id] || {};
      let total = 0, hours = 0;
      Object.values(empLogs).forEach(log => { total += log.sales || 0; hours += log.hours || 0; });
      return { id, name: emp.name, total, hours, sph: hours > 0 ? total / hours : 0 };
    })
    .sort((a, b) => metric === "sph" ? b.sph - a.sph : b.total - a.total);
}

// ══════════════════════════════════════════════════════
// Log entry
// ══════════════════════════════════════════════════════
async function logEntry() {
  const sales = parseFloat(document.getElementById("input-sales").value);
  const hours = parseFloat(document.getElementById("input-hours").value);
  if (isNaN(sales) || sales < 0) { showToast("Enter a valid sales amount 💸"); return; }
  if (isNaN(hours) || hours <= 0) { showToast("Enter hours worked ⏱️"); return; }
  if (state.competitions[state.currentComp]?.status === "closed") { showToast("This competition is closed 🔒"); return; }
  await set(dbRef.dayLog(state.currentComp, state.currentUser, state.selectedDay), { sales, hours });
  const reaction = getBigOrderReaction(sales);
  if (reaction) { showToast(reaction, 3500); launchConfetti(); }
  else showToast("Logged! Keep grinding 💪");
}

// ══════════════════════════════════════════════════════
// ADMIN — Tab system
// ══════════════════════════════════════════════════════
function openAdminPanel() {
  state.admin.tab = "competitions";
  renderAdminTab();
  renderAdminTabBar();
}

function renderAdminTabBar() {
  const tabs = [
    { id: "competitions", label: "🏆 Comps" },
    { id: "employees",   label: "👥 Team" },
    { id: "logs",        label: "📋 Logs" },
    { id: "goals",       label: "🎯 Goals" },
    { id: "site",        label: "⚙️ Site" },
  ];
  const bar = document.getElementById("admin-tab-bar");
  if (!bar) return;
  bar.innerHTML = "";
  tabs.forEach(t => {
    const btn = document.createElement("button");
    btn.className = `admin-tab-btn${state.admin.tab === t.id ? " active" : ""}`;
    btn.textContent = t.label;
    btn.onclick = () => { state.admin.tab = t.id; renderAdminTabBar(); renderAdminTab(); };
    bar.appendChild(btn);
  });
}

function renderAdminTab() {
  const content = document.getElementById("admin-tab-content");
  if (!content) return;
  content.innerHTML = "";
  switch (state.admin.tab) {
    case "competitions": renderAdminComps(content); break;
    case "employees":    renderAdminEmps(content); break;
    case "logs":         renderAdminLogs(content); break;
    case "goals":        renderAdminGoals(content); break;
    case "site":         renderAdminSite(content); break;
  }
}

// ══════════════════════════════════════════════════════
// ADMIN — Competitions tab
// ══════════════════════════════════════════════════════
function renderAdminComps(container) {
  const entries = Object.entries(state.competitions);
  const toShow = state.admin.showAllComps ? entries : entries.slice(0, PREVIEW_COUNT);

  let html = `<div class="admin-section-title" style="margin-bottom:12px;">COMPETITIONS</div>`;
  container.innerHTML = html;

  const list = document.createElement("div");
  list.className = "admin-list";
  list.id = "admin-comp-list";

  toShow.forEach(([id, comp]) => {
    const item = document.createElement("div");
    item.className = "admin-item";
    item.id = `admin-comp-item-${id}`;
    const statusDot = comp.status === "closed" ? "🔒" : comp.status === "archived" ? "📦" : "🟢";
    item.innerHTML = `<span class="admin-item-name">${statusDot} ${comp.name}</span>`;

    const editBtn = makeBtn("✏️ Edit", "del-btn", () => renderCompEditPanel(id, comp));
    item.appendChild(editBtn);
    list.appendChild(item);
  });

  container.appendChild(list);

  // View all toggle
  if (entries.length > PREVIEW_COUNT) {
    const btn = makeBtn(
      state.admin.showAllComps ? "Show less ▲" : `View all ${entries.length} ▼`,
      "view-all-btn",
      () => { state.admin.showAllComps = !state.admin.showAllComps; renderAdminTab(); }
    );
    container.appendChild(btn);
  }

  // Add new
  const addRow = document.createElement("div");
  addRow.className = "admin-new-row";
  addRow.style.marginTop = "12px";
  addRow.innerHTML = `
    <input type="text" id="input-new-comp" class="log-input" placeholder="New competition name" oninput="updateBtnState('input-new-comp','btn-add-comp')" />
    <button class="mini-btn btn-ghost" id="btn-add-comp" disabled>+ Add</button>
  `;
  container.appendChild(addRow);
  document.getElementById("btn-add-comp").onclick = async () => {
    const name = document.getElementById("input-new-comp").value.trim();
    if (!name) return;
    const id = `comp_${Date.now()}`;
    await set(dbRef.comp(id), { name, createdAt: Date.now(), status: "active" });
    state.currentComp = id;
    document.getElementById("input-new-comp").value = "";
    updateBtnState("input-new-comp", "btn-add-comp");
    showToast(`"${name}" created! 🏆`);
  };
}

function renderCompEditPanel(compId, comp) {
  const content = document.getElementById("admin-tab-content");
  content.innerHTML = "";

  const backBtn = makeBtn("← Back", "del-btn", () => { state.admin.tab = "competitions"; renderAdminTabBar(); renderAdminTab(); });
  content.appendChild(backBtn);

  const title = document.createElement("div");
  title.className = "admin-section-title";
  title.style.margin = "12px 0";
  title.textContent = `EDIT: ${comp.name}`;
  content.appendChild(title);

  const fields = [
    { label: "Competition Name", key: "name", type: "text", value: comp.name },
    { label: "Prize / Reward", key: "prize", type: "text", value: comp.prize || "" },
    { label: "Start Date", key: "startDate", type: "date", value: comp.startDate || "" },
    { label: "End Date", key: "endDate", type: "date", value: comp.endDate || "" },
  ];

  fields.forEach(f => {
    const wrap = document.createElement("div");
    wrap.style.marginBottom = "10px";
    wrap.innerHTML = `<label class="field-label">${f.label}</label><input type="${f.type}" id="comp-edit-${f.key}" class="log-input" value="${f.value}" placeholder="${f.label}" />`;
    content.appendChild(wrap);
  });

  // Status
  const statusWrap = document.createElement("div");
  statusWrap.style.marginBottom = "10px";
  statusWrap.innerHTML = `<label class="field-label">STATUS</label>`;
  const statusSel = document.createElement("select");
  statusSel.className = "log-input";
  statusSel.id = "comp-edit-status";
  ["active", "closed", "archived"].forEach(s => {
    const opt = document.createElement("option");
    opt.value = s; opt.textContent = s.charAt(0).toUpperCase() + s.slice(1);
    if (comp.status === s) opt.selected = true;
    statusSel.appendChild(opt);
  });
  statusWrap.appendChild(statusSel);
  content.appendChild(statusWrap);

  // Winner
  const winnerWrap = document.createElement("div");
  winnerWrap.style.marginBottom = "10px";
  winnerWrap.innerHTML = `<label class="field-label">WINNER (optional)</label>`;
  const winnerSel = document.createElement("select");
  winnerSel.className = "log-input";
  winnerSel.id = "comp-edit-winner";
  const noWin = document.createElement("option");
  noWin.value = ""; noWin.textContent = "— No winner set —";
  winnerSel.appendChild(noWin);
  Object.entries(state.employees)
    .filter(([, e]) => e.active !== false)
    .sort(([, a], [, b]) => a.name.localeCompare(b.name))
    .forEach(([id, emp]) => {
      const opt = document.createElement("option");
      opt.value = id; opt.textContent = emp.name;
      if (comp.winner === id) opt.selected = true;
      winnerSel.appendChild(opt);
    });
  winnerWrap.appendChild(winnerSel);
  content.appendChild(winnerWrap);

  const saveBtn = makeBtn("SAVE CHANGES", "log-btn", async () => {
    const updates = {
      name: document.getElementById("comp-edit-name").value.trim() || comp.name,
      prize: document.getElementById("comp-edit-prize").value.trim(),
      startDate: document.getElementById("comp-edit-startDate").value,
      endDate: document.getElementById("comp-edit-endDate").value,
      status: document.getElementById("comp-edit-status").value,
      winner: document.getElementById("comp-edit-winner").value || null,
    };
    await update(dbRef.comp(compId), updates);
    showToast("Competition updated ✅");
    state.admin.tab = "competitions";
    renderAdminTabBar();
    renderAdminTab();
  });
  saveBtn.style.marginTop = "12px";
  content.appendChild(saveBtn);

  const delBtn = makeBtn("🗑️ Delete Competition", "del-btn danger", async () => {
    if (confirm(`Delete "${comp.name}"? All logs will be removed.`)) {
      await remove(dbRef.comp(compId));
      await remove(ref(db, `logs/${compId}`));
      if (state.currentComp === compId) state.currentComp = null;
      state.admin.tab = "competitions";
      renderAdminTabBar();
      renderAdminTab();
    }
  });
  delBtn.style.marginTop = "8px";
  content.appendChild(delBtn);
}

// ══════════════════════════════════════════════════════
// ADMIN — Employees tab
// ══════════════════════════════════════════════════════
function renderAdminEmps(container) {
  container.innerHTML = `<div class="admin-section-title" style="margin-bottom:12px;">TEAM</div>`;

  // Search
  const searchWrap = document.createElement("div");
  searchWrap.innerHTML = `<input type="text" id="admin-emp-search" class="log-input" placeholder="🔍 Search employees..." style="margin-bottom:10px;" value="${state.admin.empSearch}" />`;
  container.appendChild(searchWrap);
  document.getElementById("admin-emp-search").oninput = (e) => {
    state.admin.empSearch = e.target.value;
    state.admin.showAllEmps = false;
    renderAdminTab();
  };

  const search = state.admin.empSearch.toLowerCase();
  const allEntries = Object.entries(state.employees).sort(([, a], [, b]) => a.name.localeCompare(b.name));
  const filtered = search ? allEntries.filter(([, emp]) => emp.name.toLowerCase().includes(search)) : allEntries;
  const toShow = state.admin.showAllEmps ? filtered : filtered.slice(0, PREVIEW_COUNT);

  const list = document.createElement("div");
  list.className = "admin-list";

  if (toShow.length === 0) {
    list.innerHTML = `<div style="color:var(--text3);font-size:0.8rem;text-align:center;padding:16px;">No employees found</div>`;
  } else {
    toShow.forEach(([id, emp]) => {
      const item = document.createElement("div");
      item.className = "admin-item";
      item.id = `admin-emp-item-${id}`;
      const inactive = emp.active === false;
      item.innerHTML = `<span class="admin-item-name${inactive ? " inactive-emp" : ""}">${inactive ? "😴 " : ""}${emp.name}</span>`;

      const editBtn = makeBtn("✏️ Rename", "del-btn", () => inlineRenameEmp(id, emp.name));
      const toggleBtn = makeBtn(inactive ? "✅ Activate" : "😴 Deactivate", "del-btn", async () => {
        await update(dbRef.emp(id), { active: inactive ? true : false });
        showToast(inactive ? `${emp.name} activated` : `${emp.name} deactivated`);
      });
      const delBtn = makeBtn("✕", "del-btn danger", async () => {
        if (confirm(`Remove "${emp.name}" from the roster?`)) await remove(dbRef.emp(id));
      });
      item.appendChild(editBtn);
      item.appendChild(toggleBtn);
      item.appendChild(delBtn);
      list.appendChild(item);
    });
  }
  container.appendChild(list);

  if (filtered.length > PREVIEW_COUNT) {
    const btn = makeBtn(
      state.admin.showAllEmps ? "Show less ▲" : `View all ${filtered.length} employees ▼`,
      "view-all-btn",
      () => { state.admin.showAllEmps = !state.admin.showAllEmps; renderAdminTab(); }
    );
    container.appendChild(btn);
  }

  const addRow = document.createElement("div");
  addRow.className = "admin-new-row";
  addRow.style.marginTop = "12px";
  addRow.innerHTML = `
    <input type="text" id="input-new-emp" class="log-input" placeholder="New employee name" oninput="updateBtnState('input-new-emp','btn-add-emp')" />
    <button class="mini-btn btn-ghost" id="btn-add-emp" disabled>+ Add</button>
  `;
  container.appendChild(addRow);
  document.getElementById("btn-add-emp").onclick = async () => {
    const name = document.getElementById("input-new-emp").value.trim();
    if (!name) return;
    const id = `${slugify(name)}_${Date.now()}`;
    await set(dbRef.emp(id), { name, active: true });
    document.getElementById("input-new-emp").value = "";
    updateBtnState("input-new-emp", "btn-add-emp");
    showToast(`${name} added!`);
  };
}

function inlineRenameEmp(empId, currentName) {
  const item = document.getElementById(`admin-emp-item-${empId}`);
  if (!item) return;
  item.innerHTML = "";
  const wrap = document.createElement("div");
  wrap.style.cssText = "display:flex;gap:8px;flex:1;align-items:center;";
  const input = document.createElement("input");
  input.type = "text"; input.className = "log-input"; input.value = currentName; input.style.flex = "1";
  const saveBtn = makeBtn("Save", "mini-btn", async () => {
    const newName = input.value.trim();
    if (!newName) { showToast("Enter a name"); return; }
    await update(dbRef.emp(empId), { name: newName });
    showToast("Renamed ✅");
  });
  const cancelBtn = makeBtn("Cancel", "mini-btn", () => renderAdminTab());
  cancelBtn.style.cssText += "background:var(--bg);color:var(--text2);border:2px solid var(--border);";
  wrap.appendChild(input); wrap.appendChild(saveBtn); wrap.appendChild(cancelBtn);
  item.appendChild(wrap);
  input.focus(); input.select();
}

// ══════════════════════════════════════════════════════
// ADMIN — Logs tab
// ══════════════════════════════════════════════════════
function renderAdminLogs(container) {
  container.innerHTML = `<div class="admin-section-title" style="margin-bottom:12px;">MANAGE LOGS</div>`;

  // Employee select — only active, live from state
  const empWrap = document.createElement("div");
  empWrap.style.marginBottom = "10px";
  empWrap.innerHTML = `<label class="field-label">EMPLOYEE</label>`;
  const empSel = document.createElement("select");
  empSel.className = "log-input"; empSel.id = "admin-logs-emp";
  empSel.innerHTML = `<option value="">— Select employee —</option>`;
  Object.entries(state.employees)
    .filter(([, e]) => e.active !== false)
    .sort(([, a], [, b]) => a.name.localeCompare(b.name))
    .forEach(([id, emp]) => {
      const opt = document.createElement("option");
      opt.value = id; opt.textContent = emp.name;
      if (state.admin.selectedEmp === id) opt.selected = true;
      empSel.appendChild(opt);
    });
  empSel.onchange = () => { state.admin.selectedEmp = empSel.value || null; refreshAdminDayView(); };
  empWrap.appendChild(empSel);
  container.appendChild(empWrap);

  // Comp select
  const compWrap = document.createElement("div");
  compWrap.style.marginBottom = "10px";
  compWrap.innerHTML = `<label class="field-label">COMPETITION</label>`;
  const compSel = document.createElement("select");
  compSel.className = "log-input"; compSel.id = "admin-logs-comp";
  Object.entries(state.competitions).forEach(([id, comp]) => {
    const opt = document.createElement("option");
    opt.value = id; opt.textContent = comp.name;
    const target = state.admin.selectedComp || state.currentComp;
    if (id === target) opt.selected = true;
    compSel.appendChild(opt);
  });
  compSel.onchange = () => { state.admin.selectedComp = compSel.value; refreshAdminDayView(); };
  compWrap.appendChild(compSel);
  container.appendChild(compWrap);

  // Day buttons container
  const dayLabel = document.createElement("label");
  dayLabel.className = "field-label"; dayLabel.style.marginBottom = "8px"; dayLabel.textContent = "DAY";
  container.appendChild(dayLabel);
  const daysContainer = document.createElement("div");
  daysContainer.className = "admin-day-buttons"; daysContainer.id = "admin-logs-days";
  container.appendChild(daysContainer);

  // Detail container
  const detail = document.createElement("div");
  detail.className = "admin-log-detail-wrap"; detail.id = "admin-logs-detail";
  detail.style.marginTop = "14px";
  detail.innerHTML = `<p style="color:var(--text3);font-size:0.8rem;text-align:center;padding:20px;">Select an employee to view & manage their logs</p>`;
  container.appendChild(detail);

  // Trigger if previously selected
  if (state.admin.selectedEmp && state.employees[state.admin.selectedEmp]) {
    if (!state.admin.selectedComp) state.admin.selectedComp = state.currentComp;
    refreshAdminDayView();
  }
}

function refreshAdminDayView() {
  const empId = state.admin.selectedEmp;
  const compId = state.admin.selectedComp || state.currentComp;
  const dayContainer = document.getElementById("admin-logs-days");
  const dayDetail = document.getElementById("admin-logs-detail");
  if (!dayContainer || !dayDetail) return;

  if (!empId || !state.employees[empId]) {
    dayContainer.innerHTML = "";
    dayDetail.innerHTML = `<p style="color:var(--text3);font-size:0.8rem;text-align:center;padding:20px;">Select an employee above</p>`;
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

  const today = state.selectedDay;
  const autoDay = empLogs[today] ? today : (DAYS.find(d => empLogs[d]) || DAYS[0]);
  const autoBtn = dayContainer.children[DAYS.indexOf(autoDay)];
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
  detail.innerHTML = `
    <div class="admin-log-header">
      <div class="admin-log-header-info">
        <div class="admin-log-header-name">${state.employees[empId]?.name || ""}</div>
        <div class="admin-log-header-sub">${day} · ${state.competitions[compId]?.name || ""}</div>
      </div>
      <div class="admin-log-header-badge logged">✓ Logged</div>
    </div>
    <div class="admin-log-stats">
      <div class="admin-log-stat"><div class="admin-log-stat-label">SALES</div><div class="admin-log-stat-value">$${log.sales.toFixed(2)}</div></div>
      <div class="admin-log-stat"><div class="admin-log-stat-label">HOURS</div><div class="admin-log-stat-value">${log.hours.toFixed(1)}</div></div>
      <div class="admin-log-stat accent"><div class="admin-log-stat-label">$/HR</div><div class="admin-log-stat-value">$${sph}</div></div>
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
  detail.innerHTML = `
    <div class="admin-log-header">
      <div class="admin-log-header-info">
        <div class="admin-log-header-name">${state.employees[empId]?.name || ""}</div>
        <div class="admin-log-header-sub">${day} · ${state.competitions[compId]?.name || ""}</div>
      </div>
      <div class="admin-log-header-badge not-logged">✗ No Log Yet</div>
    </div>
    <div class="log-fields" style="margin-top:14px;">
      <div class="log-field-wrap"><label class="field-label">SALES ($)</label><input type="number" id="admin-create-sales" class="log-input" placeholder="0.00" min="0" step="0.01" /></div>
      <div class="log-field-wrap"><label class="field-label">HOURS</label><input type="number" id="admin-create-hours" class="log-input" placeholder="0.0" min="0" step="0.5" /></div>
    </div>
    <button class="log-btn btn-ghost" id="admin-create-log-btn" style="margin-top:10px;" disabled>+ CREATE LOG</button>
  `;
  const s = document.getElementById("admin-create-sales");
  const h = document.getElementById("admin-create-hours");
  const checkReady = () => {
    const ready = s.value.trim() !== "" && h.value.trim() !== "";
    const btn = document.getElementById("admin-create-log-btn");
    if (btn) { btn.disabled = !ready; btn.classList.toggle("btn-ghost", !ready); }
  };
  s.oninput = checkReady; h.oninput = checkReady;
  document.getElementById("admin-create-log-btn").onclick = async () => {
    const sales = parseFloat(s.value);
    const hours = parseFloat(h.value);
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
  detail.innerHTML = `
    <div class="admin-log-header">
      <div class="admin-log-header-info">
        <div class="admin-log-header-name">${state.employees[empId]?.name || ""}</div>
        <div class="admin-log-header-sub">Editing ${day} · ${state.competitions[compId]?.name || ""}</div>
      </div>
    </div>
    <div class="log-fields" style="margin-top:14px;">
      <div class="log-field-wrap"><label class="field-label">SALES ($)</label><input type="number" id="admin-edit-sales" class="log-input" value="${log.sales}" min="0" step="0.01" /></div>
      <div class="log-field-wrap"><label class="field-label">HOURS</label><input type="number" id="admin-edit-hours" class="log-input" value="${log.hours}" min="0" step="0.5" /></div>
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
  document.getElementById("admin-cancel-edit-btn").onclick = () => renderAdminLogDetail(empId, compId, day, log);
}

// ══════════════════════════════════════════════════════
// ADMIN — Goals tab
// ══════════════════════════════════════════════════════
function renderAdminGoals(container) {
  container.innerHTML = `<div class="admin-section-title" style="margin-bottom:12px;">GOALS</div>`;

  // Comp picker
  const compWrap = document.createElement("div");
  compWrap.style.marginBottom = "14px";
  compWrap.innerHTML = `<label class="field-label">COMPETITION</label>`;
  const compSel = document.createElement("select");
  compSel.className = "log-input"; compSel.id = "goals-comp-sel";
  Object.entries(state.competitions).forEach(([id, comp]) => {
    const opt = document.createElement("option");
    opt.value = id; opt.textContent = comp.name;
    if (id === (state.admin.selectedComp || state.currentComp)) opt.selected = true;
    compSel.appendChild(opt);
  });
  compSel.onchange = () => { state.admin.selectedComp = compSel.value; renderAdminTab(); };
  compWrap.appendChild(compSel);
  container.appendChild(compWrap);

  const compId = state.admin.selectedComp || state.currentComp;
  const compGoals = getCompGoals(compId);

  // Global goals
  const globalGoals = [
    { key: "competition", label: "🎯 Competition Total Goal", hint: "Overall target for the whole competition" },
    { key: "weekly",      label: "📅 Weekly Goal",            hint: "Target for this week" },
    { key: "daily",       label: "☀️ Daily Goal",             hint: "Target per shift/day" },
  ];

  globalGoals.forEach(g => {
    const existing = compGoals[g.key] || {};
    const section = document.createElement("div");
    section.className = "goal-admin-block";
    section.innerHTML = `
      <div class="goal-admin-label">${g.label}</div>
      <div class="goal-admin-hint">${g.hint}</div>
      <div class="log-fields" style="margin-top:8px;">
        <div class="log-field-wrap">
          <label class="field-label">TYPE</label>
          <select id="goal-type-${g.key}" class="log-input">
            <option value="sph"${existing.type === "sph" ? " selected" : ""}>$/hr</option>
            <option value="total"${existing.type === "total" ? " selected" : ""}>Total $</option>
          </select>
        </div>
        <div class="log-field-wrap">
          <label class="field-label">TARGET VALUE</label>
          <input type="number" id="goal-val-${g.key}" class="log-input" placeholder="e.g. 150" value="${existing.value || ""}" min="0" step="1" />
        </div>
      </div>
      <div style="display:flex;gap:8px;margin-top:8px;">
        <button class="mini-btn" id="goal-save-${g.key}">Save</button>
        <button class="mini-btn" style="background:var(--bg);color:var(--text2);border:2px solid var(--border);" id="goal-clear-${g.key}">Clear</button>
      </div>
    `;
    container.appendChild(section);

    document.getElementById(`goal-save-${g.key}`).onclick = async () => {
      const type = document.getElementById(`goal-type-${g.key}`).value;
      const value = parseFloat(document.getElementById(`goal-val-${g.key}`).value);
      if (isNaN(value) || value <= 0) { showToast("Enter a valid target"); return; }
      await set(ref(db, `goals/${compId}/${g.key}`), { type, value });
      showToast("Goal saved ✅");
    };
    document.getElementById(`goal-clear-${g.key}`).onclick = async () => {
      await remove(ref(db, `goals/${compId}/${g.key}`));
      document.getElementById(`goal-val-${g.key}`).value = "";
      showToast("Goal cleared");
    };
  });

  // Global per-associate goal
  const perAssocExisting = compGoals.globalAssociate || {};
  const paSection = document.createElement("div");
  paSection.className = "goal-admin-block";
  paSection.innerHTML = `
    <div class="goal-admin-label">👤 Global Per-Associate Goal</div>
    <div class="goal-admin-hint">Same target for all associates (overridden by individual goals)</div>
    <div class="log-fields" style="margin-top:8px;">
      <div class="log-field-wrap">
        <label class="field-label">TYPE</label>
        <select id="goal-type-globalAssociate" class="log-input">
          <option value="sph"${perAssocExisting.type === "sph" ? " selected" : ""}>$/hr</option>
          <option value="total"${perAssocExisting.type === "total" ? " selected" : ""}>Total $</option>
        </select>
      </div>
      <div class="log-field-wrap">
        <label class="field-label">TARGET VALUE</label>
        <input type="number" id="goal-val-globalAssociate" class="log-input" placeholder="e.g. 120" value="${perAssocExisting.value || ""}" min="0" step="1" />
      </div>
    </div>
    <div style="display:flex;gap:8px;margin-top:8px;">
      <button class="mini-btn" id="goal-save-globalAssociate">Save</button>
      <button class="mini-btn" style="background:var(--bg);color:var(--text2);border:2px solid var(--border);" id="goal-clear-globalAssociate">Clear</button>
    </div>
  `;
  container.appendChild(paSection);
  document.getElementById("goal-save-globalAssociate").onclick = async () => {
    const type = document.getElementById("goal-type-globalAssociate").value;
    const value = parseFloat(document.getElementById("goal-val-globalAssociate").value);
    if (isNaN(value) || value <= 0) { showToast("Enter a valid target"); return; }
    await set(ref(db, `goals/${compId}/globalAssociate`), { type, value });
    showToast("Global associate goal saved ✅");
  };
  document.getElementById("goal-clear-globalAssociate").onclick = async () => {
    await remove(ref(db, `goals/${compId}/globalAssociate`));
    document.getElementById("goal-val-globalAssociate").value = "";
    showToast("Cleared");
  };

  // Individual per-associate goals
  const indivTitle = document.createElement("div");
  indivTitle.style.cssText = "font-family:'Bebas Neue',sans-serif;font-size:0.95rem;letter-spacing:2px;color:var(--text2);margin:16px 0 10px;border-top:2px solid var(--border);padding-top:14px;";
  indivTitle.textContent = "INDIVIDUAL GOALS";
  container.appendChild(indivTitle);

  Object.entries(state.employees)
    .filter(([, e]) => e.active !== false)
    .sort(([, a], [, b]) => a.name.localeCompare(b.name))
    .forEach(([empId, emp]) => {
      const indivExisting = compGoals.perAssociate?.[empId] || {};
      const empSection = document.createElement("div");
      empSection.className = "goal-admin-block";
      empSection.innerHTML = `
        <div class="goal-admin-label">${emp.name}</div>
        <div class="log-fields" style="margin-top:6px;">
          <div class="log-field-wrap">
            <label class="field-label">TYPE</label>
            <select id="goal-type-emp-${empId}" class="log-input">
              <option value="sph"${indivExisting.type === "sph" ? " selected" : ""}>$/hr</option>
              <option value="total"${indivExisting.type === "total" ? " selected" : ""}>Total $</option>
            </select>
          </div>
          <div class="log-field-wrap">
            <label class="field-label">TARGET</label>
            <input type="number" id="goal-val-emp-${empId}" class="log-input" placeholder="optional" value="${indivExisting.value || ""}" min="0" step="1" />
          </div>
        </div>
        <div style="display:flex;gap:8px;margin-top:6px;">
          <button class="mini-btn" id="goal-save-emp-${empId}">Save</button>
          <button class="mini-btn" style="background:var(--bg);color:var(--text2);border:2px solid var(--border);" id="goal-clear-emp-${empId}">Clear</button>
        </div>
      `;
      container.appendChild(empSection);
      document.getElementById(`goal-save-emp-${empId}`).onclick = async () => {
        const type = document.getElementById(`goal-type-emp-${empId}`).value;
        const value = parseFloat(document.getElementById(`goal-val-emp-${empId}`).value);
        if (isNaN(value) || value <= 0) { showToast("Enter a valid target"); return; }
        await set(ref(db, `goals/${compId}/perAssociate/${empId}`), { type, value });
        showToast(`${emp.name}'s goal saved ✅`);
      };
      document.getElementById(`goal-clear-emp-${empId}`).onclick = async () => {
        await remove(ref(db, `goals/${compId}/perAssociate/${empId}`));
        document.getElementById(`goal-val-emp-${empId}`).value = "";
        showToast("Cleared");
      };
    });
}

// ══════════════════════════════════════════════════════
// ADMIN — Site settings tab
// ══════════════════════════════════════════════════════
function renderAdminSite(container) {
  const s = state.settings;
  container.innerHTML = `<div class="admin-section-title" style="margin-bottom:12px;">SITE SETTINGS</div>`;

  const fields = [
    { label: "Store Name", id: "site-store-name", type: "text", value: s.storeName || "Hollister", placeholder: "e.g. Hollister" },
    { label: "Banner Message (shown on home screen)", id: "site-banner-msg", type: "text", value: s.bannerMessage || "", placeholder: "e.g. Good luck team! 🔥 (optional)" },
  ];

  fields.forEach(f => {
    const wrap = document.createElement("div");
    wrap.style.marginBottom = "12px";
    wrap.innerHTML = `<label class="field-label">${f.label}</label><input type="${f.type}" id="${f.id}" class="log-input" value="${f.value}" placeholder="${f.placeholder}" />`;
    container.appendChild(wrap);
  });

  // Accent color picker
  const colorWrap = document.createElement("div");
  colorWrap.style.marginBottom = "12px";
  colorWrap.innerHTML = `<label class="field-label">ACCENT COLOR</label><div class="color-swatches" id="color-swatches"></div>`;
  container.appendChild(colorWrap);

  const colors = [
    { name: "Orange", value: "#FF4D1C" },
    { name: "Blue",   value: "#0096FF" },
    { name: "Green",  value: "#1DB954" },
    { name: "Purple", value: "#7C3AED" },
    { name: "Pink",   value: "#E91E8C" },
    { name: "Teal",   value: "#0D9488" },
  ];

  const swatches = document.getElementById("color-swatches");
  colors.forEach(c => {
    const swatch = document.createElement("button");
    swatch.className = `color-swatch${(s.accentColor || "#FF4D1C") === c.value ? " active" : ""}`;
    swatch.style.background = c.value;
    swatch.title = c.name;
    swatch.onclick = () => {
      document.querySelectorAll(".color-swatch").forEach(s => s.classList.remove("active"));
      swatch.classList.add("active");
    };
    swatches.appendChild(swatch);
  });

  // Ranking metric
  const metricWrap = document.createElement("div");
  metricWrap.style.marginBottom = "12px";
  metricWrap.innerHTML = `
    <label class="field-label">LEADERBOARD RANKING METRIC</label>
    <select id="site-ranking-metric" class="log-input">
      <option value="sph"${(s.rankingMetric || "sph") === "sph" ? " selected" : ""}>Sales per Hour ($/hr)</option>
      <option value="total"${s.rankingMetric === "total" ? " selected" : ""}>Total Sales ($)</option>
    </select>
  `;
  container.appendChild(metricWrap);

  const saveBtn = makeBtn("SAVE SETTINGS", "log-btn", async () => {
    const activeSwatch = document.querySelector(".color-swatch.active");
    const updates = {
      storeName: document.getElementById("site-store-name").value.trim() || "Hollister",
      bannerMessage: document.getElementById("site-banner-msg").value.trim(),
      accentColor: activeSwatch ? activeSwatch.style.background : (s.accentColor || "#FF4D1C"),
      rankingMetric: document.getElementById("site-ranking-metric").value,
    };
    await update(dbRef.settings(), updates);
    showToast("Settings saved ✅");
  });
  saveBtn.style.marginTop = "8px";
  container.appendChild(saveBtn);
}

// ══════════════════════════════════════════════════════
// Utility
// ══════════════════════════════════════════════════════
function makeBtn(label, className, onclick) {
  const btn = document.createElement("button");
  btn.className = className; btn.textContent = label; btn.onclick = onclick;
  return btn;
}

function showScreen(name) {
  document.querySelectorAll(".screen").forEach(s => s.classList.remove("active"));
  document.getElementById(`screen-${name}`).classList.add("active");
  window.scrollTo(0, 0);
}

function setActiveNav(tab) {
  document.querySelectorAll(".nav-btn").forEach(b => b.classList.toggle("active", b.dataset.tab === tab));
}

let toastTimer;
function showToast(msg, duration = 2200) {
  const toast = document.getElementById("toast");
  toast.textContent = msg;
  toast.classList.remove("hidden");
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => toast.classList.add("hidden"), duration);
}

function launchConfetti() {
  const canvas = document.getElementById("confetti-canvas");
  const ctx = canvas.getContext("2d");
  canvas.width = window.innerWidth; canvas.height = window.innerHeight;
  const pieces = Array.from({ length: 80 }, () => ({
    x: Math.random() * canvas.width, y: -20, r: Math.random() * 8 + 4,
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
      ctx.save(); ctx.globalAlpha = p.life; ctx.translate(p.x, p.y); ctx.rotate(p.angle);
      ctx.fillStyle = p.color; ctx.fillRect(-p.r/2, -p.r/2, p.r, p.r * 0.6); ctx.restore();
    });
    if (alive) frame = requestAnimationFrame(draw);
    else ctx.clearRect(0, 0, canvas.width, canvas.height);
  }
  cancelAnimationFrame(frame); draw();
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
      openAdminPanel();
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
});