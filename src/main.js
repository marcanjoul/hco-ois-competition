/*
  BEGINNER GUIDE
  This file controls app behavior.
  It decides what happens when someone clicks, types, loads data, or changes screens.

  Quick mental model:
  - `index.html` = what exists
  - `src/styles/*.css` = how it looks
  - `src/main.js` = what it does

  Helpful examples:
  - `welcome-start-btn` = the "Get Started" button
  - `pick-btn-log` = the "ADD OIS" button
  - `board-body` = the leaderboard results area
  - `info-modal` = the "Competition Rules" popup
*/
// src/main.js
import { db } from "./firebase.js";
import { ref, set, onValue, update, remove } from "firebase/database";
import { slugify, escapeHtml, formatLocalDate, shiftLocalDate, formatDate } from "./utils.js";

// App-wide constants.
// Example on the website: weekday labels and preview limits.
const ADMIN_PIN = import.meta.env.VITE_ADMIN_PIN;
const CROWN_ICON_URL = new URL("./assets/icons/crown-pixel-flaticon.svg", import.meta.url).href;
const DAYS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
const PREVIEW_COUNT = 5;

function getTodayDate() {
  return formatLocalDate(new Date());
}

// In-memory app state.
// Think of this as "everything the app currently remembers".
// Example on the website: which screen is open, who is selected, and which comp is active.
let _autoSelectAttempted = false;

function tryAutoSelectPlayer() {
  if (_autoSelectAttempted || state.currentUser) return;
  if (Object.keys(state.employees).length === 0) return;
  _autoSelectAttempted = true;
  const lastId = localStorage.getItem("lastPlayer");
  if (lastId && state.employees[lastId] && !state.employees[lastId].inactive) {
    enterAsDashboard(lastId);
  }
}

let state = {
  competitions: {},
  deletedCompetitions: {},
  employees: {},
  logs: {},
  settings: {},
  goals: {},
  currentComp: null,      // active comp shown on pick screen
  boardComp: null,        // comp selected on leaderboard
  currentUser: null,
  dashView: "logging",
  selectedDate: getTodayDate(),
  currentScreen: "welcome",
  adminUnlocked: false,
  searchDebounceTimer: null,
  endedRevealDismissedCompId: null,
  admin: {
    showAllComps: false,
    showAllEmps: false,
    showUnloggedPlayers: false,
    selectedEmp: null,
    selectedComp: null,
    editingCompId: null,
    compFilter: "all",
    selectedDate: getTodayDate(),
    empSearch: "",
    tab: "competitions",
  },
};

// Firebase database shortcuts.
// Example: `dbRef.emps()` points to the employees collection in the database.
const dbRef = {
  comps:    ()              => ref(db, "competitions"),
  comp:     (id)            => ref(db, `competitions/${id}`),
  emps:     ()              => ref(db, "employees"),
  emp:      (id)            => ref(db, `employees/${id}`),
  logs:     ()              => ref(db, "logs"),
  compLogs: (cId)           => ref(db, `logs/${cId}`),
  dateLog:  (cId, eId, date) => ref(db, `logs/${cId}/${eId}/${date}`),
  settings: ()              => ref(db, "settings"),
  goals:    ()              => ref(db, "goals"),
  deletedComps: ()         => ref(db, "deleted_competitions"),
  deletedComp:  (id)       => ref(db, `deleted_competitions/${id}`),
};

// ══════════════════════════════════════════════════════
// Bootstrap
// Runs on startup and makes sure required settings data exists.
// ══════════════════════════════════════════════════════

// slugify, escapeHtml, formatLocalDate, shiftLocalDate, formatDate
// imported from ./utils.js

// Optimistic local updates: after writing to Firebase we immediately patch
// state.logs so the UI reflects the change without waiting for the onValue
// listener to re-fire. The listener will still fire and overwrite with the
// server value, but the patch prevents a visible flicker between write and
// confirmation. If Firebase rejects the write the listener restores truth.
function upsertLocalLog(compId, empId, date, log) {
  if (!compId || !empId || !date) return;
  if (!state.logs[compId]) state.logs[compId] = {};
  if (!state.logs[compId][empId]) state.logs[compId][empId] = {};
  state.logs[compId][empId][date] = log;
}

function removeLocalLog(compId, empId, date) {
  if (!compId || !empId || !date) return;
  const empLogs = state.logs[compId]?.[empId];
  if (!empLogs) return;
  delete empLogs[date];
  if (Object.keys(empLogs).length === 0) delete state.logs[compId][empId];
  if (Object.keys(state.logs[compId] || {}).length === 0) delete state.logs[compId];
}

function countUp(el, target, { prefix = '', suffix = '', decimals = 0, duration = 430 } = {}) {
  const start = performance.now();
  function tick(now) {
    const t = Math.min((now - start) / duration, 1);
    const eased = 1 - Math.pow(1 - t, 3);
    el.textContent = prefix + (target * eased).toFixed(decimals) + suffix;
    if (t < 1) requestAnimationFrame(tick);
  }
  requestAnimationFrame(tick);
}

let statRowAnimated = false;

// Batches render calls that fire within the same animation frame.
// Multiple listeners can all request 'pick' and it only renders once.
const _renderQueue = new Map();
let _renderRaf = null;
function scheduleRender(key, fn) {
  _renderQueue.set(key, fn);
  if (!_renderRaf) {
    _renderRaf = requestAnimationFrame(() => {
      _renderRaf = null;
      const fns = Array.from(_renderQueue.values());
      _renderQueue.clear();
      fns.forEach(f => f());
    });
  }
}

function makeBtn(label, className, onclick) {
  const btn = document.createElement("button");
  btn.className = className; btn.textContent = label; btn.onclick = onclick;
  return btn;
}

function focusElementSoon(el, options = {}) {
  if (!el) return;
  window.requestAnimationFrame(() => el.focus(options));
}

function focusFirstEditablePickInput() {
  const salesInput = document.getElementById("pick-input-sales");
  const hoursInput = document.getElementById("pick-input-hours");
  const target = salesInput && !salesInput.readOnly && !salesInput.value
    ? salesInput
    : hoursInput && !hoursInput.readOnly && !hoursInput.value
      ? hoursInput
      : null;
  focusElementSoon(target, { preventScroll: true });
}

function closePickEmployeeGrid() {
  const empGrid = document.getElementById("pick-emp-grid");
  const empSelectorBtn = document.getElementById("pick-emp-selector");
  if (!empGrid || empGrid.classList.contains("hidden")) return;
  empGrid.classList.add("hidden");
  empSelectorBtn?.classList.remove("open");
}

// ══════════════════════════════════════════════════════
// Avatar helpers
// Example on the website: the player photo or letter icon shown beside names.
// ══════════════════════════════════════════════════════
function getAvatarPlaceholder(empIdOrStr) {
  const str = (empIdOrStr || "").toString().trim();
  if (!str) return "?";
  return str.charAt(0).toUpperCase();
}

function getAvatarHtml(emp, size = "", empId = "") {
  const sizeClass = size ? ` avatar-${size}` : "";
  const safeName = escapeHtml(emp?.name || empId || "Employee");
  if (emp.avatar && emp.avatar.startsWith("data:image/")) {
    return `<div class="avatar${sizeClass}"><img class="avatar-img" src="${emp.avatar}" alt="${safeName}" /></div>`;
  }
  const placeholder = getAvatarPlaceholder(emp.name || empId || emp.id);
  return `<div class="avatar${sizeClass}"><span class="avatar-placeholder">${placeholder}</span></div>`;
}

function getBoardAvatarHtml(emp, playerId, displayRank) {
  return `
    <div class="board-avatar-stack${displayRank === 1 ? " rank-1" : ""}">
      ${displayRank === 1 ? `<div class="board-avatar-crown"><img class="board-avatar-crown-icon" src="${CROWN_ICON_URL}" alt="Top player crown" /></div>` : ""}
      ${getAvatarHtml(emp || { name: playerId }, "board", playerId)}
    </div>
  `;
}

function fileToBase64(file) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(reader.result);
    reader.onerror = reject;
    reader.readAsDataURL(file);
  });
}

// Turns buttons on/off depending on whether an input has text.
// Example on the website: buttons that stay dim until the field has a value.
window.updateBtnState = function(inputId, btnId) {
  const input = document.getElementById(inputId);
  const btn = document.getElementById(btnId);
  if (!input || !btn) return;
  const hasValue = input.value.trim().length > 0;
  btn.disabled = !hasValue;
  btn.classList.toggle("btn-ghost", !hasValue);
};

// ══════════════════════════════════════════════════════
// Competition helpers
// Example on the website: deciding which competition is active and whether it has ended.
// ══════════════════════════════════════════════════════
function isCompEnded(comp) {
  if (!comp?.endDate) return false;
  const end = new Date(`${comp.endDate}T23:59:59.999`);
  return new Date() > end;
}

function isCompUpcoming(comp) {
  if (!comp?.startDate) return false;
  return comp.startDate > getTodayDate();
}

function getActiveComp() {
  // Find the most recent comp that hasn't ended yet
  const entries = Object.entries(state.competitions)
    .filter(([, c]) => !isCompEnded(c))
    .sort(([, a], [, b]) => (b.createdAt || 0) - (a.createdAt || 0));
  return entries[0]?.[0] || null;
}

function getNewCompetitionDateBlock() {
  const activeCompId = getActiveComp();
  const activeComp = activeCompId ? state.competitions[activeCompId] : null;
  if (!activeComp?.endDate || isCompEnded(activeComp)) return null;
  return {
    compId: activeCompId,
    compName: activeComp.name || "the current competition",
    endDate: activeComp.endDate,
    earliestStartDate: shiftLocalDate(activeComp.endDate, 1),
  };
}

function getLatestEndedCompId() {
  const entries = Object.entries(state.competitions)
    .filter(([, c]) => isCompEnded(c))
    .sort(([, a], [, b]) => (b.createdAt || 0) - (a.createdAt || 0));
  return entries[0]?.[0] || null;
}

async function checkAndAutoCloseComps() {
  for (const [id, comp] of Object.entries(state.competitions)) {
    if (!comp.winner && isCompEnded(comp)) {
      const ranked = getRankedPlayers(id);
      const winner = ranked.find(p => p.hours > 0);
      await update(dbRef.comp(id), {
        winner: winner ? winner.id : null,
      });
    }
  }
}

function getWeekForDate(dateStr) {
  // Returns { startDate, endDate, days: [{date, dayName, dayNum}, ...] } for the week containing dateStr
  const date = new Date(dateStr + "T00:00:00");
  const dayOfWeek = date.getDay();
  const startOfWeek = new Date(date);
  startOfWeek.setDate(date.getDate() - dayOfWeek); // Sunday

  const days = [];
  for (let i = 0; i < 7; i++) {
    const d = new Date(startOfWeek);
    d.setDate(startOfWeek.getDate() + i);
    const dateString = formatLocalDate(d);
    const dayName = DAYS[d.getDay()]; // 0=Sun, 1=Mon ... 6=Sat
    const dayNum = d.getDate();
    days.push({ date: dateString, dayName, dayNum });
  }
  return { days, startDate: days[0].date, endDate: days[6].date };
}

function prevWeek(dateStr) {
  return shiftLocalDate(dateStr, -7);
}

function nextWeek(dateStr) {
  return shiftLocalDate(dateStr, 7);
}

function daysRemaining(comp) {
  if (!comp?.endDate) return null;
  const end = new Date(comp.endDate);
  end.setHours(23, 59, 59, 999);
  return Math.ceil((end - new Date()) / (1000 * 60 * 60 * 24));
}

function getCompetitionCountdownStyle(comp) {
  if (!comp?.startDate || !comp?.endDate) return "";

  const start = new Date(comp.startDate + "T00:00:00").getTime();
  const end = new Date(comp.endDate + "T00:00:00").getTime();
  const today = new Date(getTodayDate() + "T00:00:00").getTime();

  if (!Number.isFinite(start) || !Number.isFinite(end)) return "";
  if (end <= start) {
    return "color:hsl(0 90% 60%);text-shadow:4px 4px 0 hsl(0 80% 28%);";
  }

  const progress = Math.min(1, Math.max(0, (today - start) / (end - start)));
  const hue = 120 * (1 - progress);
  const color = `hsl(${hue} 90% 62%)`;
  const shadow = `hsl(${hue} 80% 28%)`;
  return `color:${color};text-shadow:4px 4px 0 ${shadow};`;
}

function getCompetitionTimePct(comp) {
  if (!comp?.startDate || !comp?.endDate) return 0;

  const start = new Date(comp.startDate + "T00:00:00").getTime();
  const end = new Date(comp.endDate + "T23:59:59").getTime();
  const now = Date.now();

  if (!Number.isFinite(start) || !Number.isFinite(end) || end <= start) return 0;
  return Math.min(100, Math.max(0, ((end - now) / (end - start)) * 100));
}

function getCompetitionDayStrip(comp) {
  if (!comp?.startDate || !comp?.endDate) return "";

  const start = new Date(comp.startDate + "T00:00:00");
  const end = new Date(comp.endDate + "T00:00:00");
  const todayStr = getTodayDate();
  const days = [];

  if (!Number.isFinite(start.getTime()) || !Number.isFinite(end.getTime()) || end < start) return "";

  for (let d = new Date(start); d <= end && days.length < 21; d.setDate(d.getDate() + 1)) {
    const dateString = formatLocalDate(d);
    const stateClass = dateString < todayStr ? "past" : dateString === todayStr ? "today" : "future";
    days.push(`
      <span class="pick-countdown-day ${stateClass}">
        <span class="pick-countdown-day-name">${DAYS[d.getDay()]}</span>
        <span class="pick-countdown-day-num">${d.getDate()}</span>
      </span>
    `);
  }

  return days.join("");
}

function getCompetitionElapsedPct(comp) {
  if (!comp?.startDate || !comp?.endDate) return 0;

  const start = new Date(comp.startDate + "T00:00:00").getTime();
  const end = new Date(comp.endDate + "T23:59:59").getTime();
  const now = Date.now();

  if (!Number.isFinite(start) || !Number.isFinite(end) || end <= start) return 0;
  return Math.min(100, Math.max(0, ((now - start) / (end - start)) * 100));
}


// ══════════════════════════════════════════════════════
// Apply settings
// ══════════════════════════════════════════════════════
function applySettings(s = {}) {
  const color = s.accentColor || "#ff4fa3";
  if (/^#[0-9A-Fa-f]{6}$/.test(color)) {
    document.documentElement.style.setProperty("--accent-alt", color);
  }
  document.documentElement.style.setProperty("--accent", "#ffd84d");
  const banner = s.bannerMessage || "";
  const bannerEl = document.getElementById("site-banner");
  if (bannerEl) { bannerEl.textContent = banner; bannerEl.style.display = banner ? "block" : "none"; }
}

// ══════════════════════════════════════════════════════
// Listeners
// ══════════════════════════════════════════════════════

// Tracks which listeners have delivered their first value so we know when
// it's safe to run tasks that need all data (e.g. auto-close comps).
let _dataReady = false;
const _readySet = new Set();

function _markReady(name) {
  if (_readySet.has(name)) return;
  _readySet.add(name);
  if (_readySet.size < 6) return;
  _dataReady = true;
  checkAndAutoCloseComps();
  purgeExpiredDeletedComps();
}

function startListeners() {
  onValue(dbRef.comps(), snap => {
    state.competitions = snap.val() || {};
    state.currentComp = getActiveComp();
    if (state.currentComp) {
      state.endedRevealDismissedCompId = null;
      document.getElementById("competition-ended-modal")?.classList.remove("active");
    }
    if (!state.boardComp) state.boardComp = state.currentComp;
    if (state.boardComp && !state.competitions[state.boardComp]) {
      state.boardComp = state.currentComp;
    }
    if (_dataReady) checkAndAutoCloseComps();
    scheduleRender("pick", renderPickScreen);
    scheduleRender("boardCompSelect", renderBoardCompSelect);
    if (state.currentScreen === "board") scheduleRender("board", renderBoard);
    if (state.admin.tab === "competitions") scheduleRender("admin", renderAdminTab);
    _markReady("comps");
  });

  onValue(dbRef.emps(), snap => {
    state.employees = snap.val() || {};
    scheduleRender("pick", renderPickScreen);
    if (state.currentUser) {
      scheduleRender("dash", renderDash);
      scheduleRender("board", renderBoard);
    }
    if (state.admin.tab === "employees") scheduleRender("admin", renderAdminTab);
    if (state.admin.tab === "logs") scheduleRender("admin", renderAdminTab);
    _markReady("emps");
  });

  onValue(dbRef.logs(), snap => {
    state.logs = snap.val() || {};
    scheduleRender("pick", renderPickScreen);
    if (state.currentUser) {
      scheduleRender("dash", renderDash);
      scheduleRender("board", renderBoard);
    }
    if (state.admin.tab === "logs" && state.admin.selectedEmp) scheduleRender("adminDay", refreshAdminDayView);
    _markReady("logs");
  });

  onValue(dbRef.settings(), snap => {
    if (!snap.exists()) {
      set(dbRef.settings(), { accentColor: "#ff4fa3", rankingMetric: "sph" });
      _markReady("settings");
      return;
    }
    state.settings = snap.val() || {};
    applySettings(state.settings);
    _markReady("settings");
  });

  onValue(dbRef.goals(), snap => {
    state.goals = snap.val() || {};
    if (state.currentUser) scheduleRender("dash", renderDash);
    scheduleRender("pick", renderPickScreen);
    if (state.admin.tab === "competitions") scheduleRender("admin", renderAdminTab);
    _markReady("goals");
  });

  onValue(dbRef.deletedComps(), snap => {
    state.deletedCompetitions = snap.val() || {};
    if (state.admin.tab === "competitions") scheduleRender("admin", renderAdminTab);
    _markReady("deletedComps");
  });
}

async function purgeExpiredDeletedComps() {
  const SEVEN_DAYS = 7 * 24 * 60 * 60 * 1000;
  const now = Date.now();
  const purges = Object.entries(state.deletedCompetitions)
    .filter(([, d]) => now - (d.deletedAt || 0) > SEVEN_DAYS)
    .map(([id]) => remove(dbRef.deletedComp(id)));
  if (purges.length) await Promise.all(purges);
}

// ══════════════════════════════════════════════════════
// Goal helpers
// ══════════════════════════════════════════════════════
function getCompGoals(compId) { return state.goals[compId] || {}; }

function getPlayerSph(empId, compId) {
  const logs = (state.logs[compId] || {})[empId] || {};
  let total = 0, hours = 0;
  Object.values(logs).forEach(l => { total += l.sales || 0; hours += l.hours || 0; });
  return { total, hours, sph: hours > 0 ? total / hours : 0 };
}

function renderGoalBar(current, target, type) {
  const pct = Math.min(100, target > 0 ? (current / target) * 100 : 0);
  const isHit = current >= target;
  const label = type === "sph" ? `$${current.toFixed(2)}/hr` : `$${current.toFixed(2)}`;
  const targetLabel = type === "sph" ? `$${target.toFixed(2)}/hr` : `$${target.toFixed(2)}`;
  const progressLabel = `${label} / ${targetLabel}`;
  const percentLabel = `${Math.round(pct)}%`;
  return `
    <div class="goal-progress">
      <div class="goal-progress-copy">
        <span class="goal-current${isHit ? " goal-hit" : ""}">${progressLabel}</span>
      </div>
      <div class="goal-meter-row" aria-label="${label} raised toward ${targetLabel} goal">
        <div class="goal-bar-bg">
          <div class="goal-bar-fill${isHit ? " goal-hit-bar" : ""}" style="width:${pct}%"></div>
        </div>
        <span class="goal-percent-inline">${percentLabel}</span>
      </div>
    </div>
  `;
}

function getCompetitionGoalMarkup(compId) {
  const compGoals = getCompGoals(compId);
  const compLogs = state.logs[compId] || {};
  let storeTotalSales = 0;

  Object.values(compLogs).forEach(empLogs => {
    Object.values(empLogs || {}).forEach(log => {
      storeTotalSales += log.sales || 0;
    });
  });

  let goalsHtml = "";
  if (compGoals.competition?.value) {
    goalsHtml += `<div class="comp-detail"><div class="detail-label">Competition Goal</div>${renderGoalBar(storeTotalSales, compGoals.competition.value, "total")}</div>`;
  }
  return goalsHtml;
}

function renderCompetitionCard(container, compId, { collapsibleGoals = true } = {}) {
  if (!container) return;
  const comp = state.competitions[compId];
  if (!comp) {
    container.classList.add("hidden");
    container.innerHTML = "";
    return;
  }

  const ended = isCompEnded(comp);
  const days = daysRemaining(comp);
  const winner = comp.winner ? state.employees[comp.winner] : null;
  const goalsHtml = getCompetitionGoalMarkup(compId);
  const hasGoals = !!goalsHtml;
  const countdownNum = ended ? "END" : (days !== null ? (days <= 0 ? "0" : String(days)) : "—");
  const countdownLabel = ended ? "COMPETITION OVER" : (days === 1 ? "DAY LEFT" : "DAYS LEFT");
  const countdownClass = `pick-countdown-num${ended ? " ended" : ""}${days === 0 ? " last-day" : ""}`;
  const countdownStyle = ended ? "" : getCompetitionCountdownStyle(comp);

  container.classList.add("pick-comp-info");
  container.classList.remove("hidden");
  container.innerHTML = `
    <h2 class="pick-comp-name">${escapeHtml(comp.name)}</h2>
    <p class="pick-comp-dates">${comp.startDate && comp.endDate ? escapeHtml(`${formatDate(comp.startDate)} → ${formatDate(comp.endDate)}`) : ""}</p>
    <div class="pick-comp-hero-row">
      <div class="pick-countdown">
        <span class="${countdownClass}" style="${countdownStyle}">${countdownNum}</span>
        <span class="pick-countdown-label">${countdownLabel}</span>
      </div>
    </div>
    ${hasGoals ? `
      <div class="pick-comp-goals" style="display:block">
        ${collapsibleGoals ? `
          <button class="pick-goals-toggle">
            <span>PROGRESS</span>
            <span class="pick-goals-toggle-arrow">▼</span>
          </button>
          <div class="pick-goals-content">${goalsHtml}</div>
        ` : `
          <div class="pick-goals-content open">${goalsHtml}</div>
        `}
      </div>
    ` : ""}
    ${ended && winner ? `<p class="pick-winner-row" style="display:flex">🏆 <span>${escapeHtml(`${winner.name} won!`)}</span></p>` : ""}
  `;

  if (collapsibleGoals && hasGoals) {
    const toggle = container.querySelector(".pick-goals-toggle");
    const content = container.querySelector(".pick-goals-content");
    if (toggle && content) {
      toggle.onclick = () => {
        content.classList.toggle("open");
        toggle.classList.toggle("open");
      };
    }
  }
}

// ══════════════════════════════════════════════════════
// Vibe phrases
// ══════════════════════════════════════════════════════

async function logEntryFromPick() {
  const sales = parseFloat(document.getElementById("pick-input-sales").value);
  const hours = parseFloat(document.getElementById("pick-input-hours").value);
  if (isNaN(sales) || sales < 0) { showToast("Enter a valid sales amount"); return; }
  if (isNaN(hours) || hours <= 0) { showToast("Enter hours worked"); return; }
  if (!state.currentUser) { showToast("Select your name first"); return; }
  if (isCompEnded(state.competitions[state.currentComp])) { showToast("This competition has ended"); return; }

  const today = getTodayDate();
  if (state.selectedDate > today) { showToast("Can't log orders in the future"); return; }

  const existingLog = (state.logs[state.currentComp] || {})[state.currentUser]?.[state.selectedDate];
  if (existingLog && (existingLog.sales > 0 || existingLog.hours > 0)) {
    showToast("OIS Already Added - Manager Can Edit"); return;
  }

  // Loading state + haptic
  const logBtn = document.getElementById("pick-btn-log");
  if (logBtn) { logBtn.textContent = "LOGGING..."; logBtn.disabled = true; }
  if (navigator.vibrate) navigator.vibrate(40);

  const prevPlayers = getRankedPlayers(state.currentComp);
  const prevRank = prevPlayers.findIndex(p => p.id === state.currentUser) + 1;

  await set(dbRef.dateLog(state.currentComp, state.currentUser, state.selectedDate), { sales, hours });
  upsertLocalLog(state.currentComp, state.currentUser, state.selectedDate, { sales, hours });

  if (sales > 0) launchConfetti(Math.min(Math.sqrt(sales / 200), 1));

  // Compute stats for success panel
  const allMyLogs = { ...((state.logs[state.currentComp] || {})[state.currentUser] || {}), [state.selectedDate]: { sales, hours } };
  let totalSales = 0, totalHours = 0;
  Object.values(allMyLogs).forEach(l => { totalSales += l.sales || 0; totalHours += l.hours || 0; });
  const sph = totalHours > 0 ? totalSales / totalHours : 0;
  const allPlayers = getRankedPlayers(state.currentComp);
  const rank = allPlayers.findIndex(p => p.id === state.currentUser) + 1;

  // Fade out form, then reveal success panel
  const formSteps = document.getElementById("pick-form-steps");
  const successState = document.getElementById("pick-success-state");
  const successStats = document.getElementById("pick-success-stats");
  if (formSteps) {
    formSteps.classList.add("hiding");
    setTimeout(() => { formSteps.style.display = "none"; formSteps.classList.remove("hiding"); }, 140);
  }
  if (successStats) {
    let rankHtml = "";
    if (sph > 0 && rank > 0) {
      let rankLabel, rankClass;
      if (prevRank === 0) {
        rankLabel = `#${rank} NEW`;
        rankClass = "pick-success-stat-accent";
      } else if (rank < prevRank) {
        rankLabel = `↑ #${rank}`;
        rankClass = "pick-success-stat-gold";
      } else if (rank > prevRank) {
        rankLabel = `#${rank} ↓`;
        rankClass = "";
      } else {
        rankLabel = `#${rank} HELD`;
        rankClass = "pick-success-stat-gold";
      }
      rankHtml = `<div class="pick-success-stat"><div class="pick-success-stat-label">RANK</div><div class="pick-success-stat-value ${rankClass}">${rankLabel}</div></div>`;
    }
    successStats.innerHTML = `
      <div class="pick-success-stat"><div class="pick-success-stat-label">SALES</div><div class="pick-success-stat-value">$${sales.toFixed(2)}</div></div>
      <div class="pick-success-stat"><div class="pick-success-stat-label">$/HR</div><div class="pick-success-stat-value pick-success-stat-accent">$${sph.toFixed(2)}</div></div>
      ${rankHtml}
    `;
  }
  if (successState) setTimeout(() => successState.classList.add("visible"), 120);

  // Flip the logged day chip to green immediately
  renderPickDayRow();
  renderBoard();
}
function renderPickDayRow() {
  const dayRow = document.getElementById("pick-day-row");
  if (!dayRow) return;
  dayRow.innerHTML = `<button class="week-nav-btn" id="pick-prev-week-btn">←</button>`;

  const week = getWeekForDate(state.selectedDate);
  const myLogs = state.currentUser ? ((state.logs[state.currentComp] || {})[state.currentUser] || {}) : {};

  const today = getTodayDate();
  week.days.forEach(dayInfo => {
    const hasEntry = myLogs[dayInfo.date] && (myLogs[dayInfo.date].sales > 0 || myLogs[dayInfo.date].hours > 0);
    const isFutureDate = dayInfo.date > today;
    const isToday = dayInfo.date === today;
    const isSelected = state.selectedDate === dayInfo.date;
    const classes = ["day-btn"];
    if (isToday && !isSelected) classes.push("today");
    if (isSelected) classes.push("active");
    if (hasEntry) classes.push("logged");
    if (isFutureDate) classes.push("disabled");
    const btn = document.createElement("button");
    btn.className = classes.join(" ");
    btn.innerHTML = `<div class="day-btn-dayname">${dayInfo.dayName}</div><div class="day-btn-date">${dayInfo.dayNum}</div>`;

    if (!isFutureDate) {
      btn.onclick = () => {
        state.selectedDate = dayInfo.date;
        renderPickDayRow();
        updatePickLogBtnState();
      };
    } else {
      btn.disabled = true;
    }
    dayRow.appendChild(btn);
  });

  dayRow.appendChild(makeBtn("→", "week-nav-btn", () => { state.selectedDate = nextWeek(state.selectedDate); renderPickDayRow(); updatePickLogBtnState(); }));
  document.getElementById("pick-prev-week-btn").onclick = () => { state.selectedDate = prevWeek(state.selectedDate); renderPickDayRow(); updatePickLogBtnState(); };
}

function updatePickLogBtnState() {
  const btn = document.getElementById("pick-btn-log");
  const lockedMsg = document.getElementById("pick-log-locked-msg");
  const salesInput = document.getElementById("pick-input-sales");
  const hoursInput = document.getElementById("pick-input-hours");
  if (!btn) return;

  // Check if the selected date already has a log for this employee
  const existingLog = state.currentUser
    ? (state.logs[state.currentComp] || {})[state.currentUser]?.[state.selectedDate]
    : null;
  const isLocked = !!(existingLog && (existingLog.sales > 0 || existingLog.hours > 0));

  if (isLocked) {
    btn.disabled = true;
    btn.classList.remove("btn-ghost");
    btn.classList.add("btn-locked");
    btn.textContent = "OIS ADDED";
    if (lockedMsg) lockedMsg.classList.add("visible");
    if (salesInput) {
      salesInput.readOnly = true;
      salesInput.value = existingLog.sales;
      salesInput.classList.add("input-locked");
    }
    if (hoursInput) {
      hoursInput.readOnly = true;
      hoursInput.value = existingLog.hours;
      hoursInput.classList.add("input-locked");
    }
  } else {
    const wasSalesLocked = !!salesInput?.readOnly;
    const wasHoursLocked = !!hoursInput?.readOnly;

    btn.disabled = true;
    btn.classList.remove("btn-locked");
    btn.classList.add("btn-ghost");
    btn.textContent = "ADD OIS";
    if (lockedMsg) lockedMsg.classList.remove("visible");
    if (salesInput) {
      salesInput.readOnly = false;
      salesInput.classList.remove("input-locked");
      if (wasSalesLocked) salesInput.value = "";
    }
    if (hoursInput) {
      hoursInput.readOnly = false;
      hoursInput.classList.remove("input-locked");
      if (wasHoursLocked) hoursInput.value = "";
    }
    const sales = parseFloat(salesInput?.value);
    const hours = parseFloat(hoursInput?.value);
    const hasValues = !isNaN(sales) && sales >= 0 && !isNaN(hours) && hours > 0;
    const hasEmployee = !!state.currentUser;
    const ready = hasEmployee && hasValues;
    btn.disabled = !ready;
    btn.classList.toggle("btn-ghost", !ready);
  }
}
// ══════════════════════════════════════════════════════
function renderPickScreen(filterText = "") {
  tryAutoSelectPlayer();
  const searchInput = document.getElementById("input-search-employees");
  if (searchInput && searchInput.value !== filterText) searchInput.value = filterText;

  // Competition info card — show only active comp
  const compInfo = document.getElementById("pick-comp-info");
  const noCompsMsg = document.getElementById("no-comps-message");

  const compSkeleton = document.getElementById("pick-comp-skeleton");

  if (!state.currentComp) {
    // No active competition - hide log form, show big message
    if (compSkeleton) compSkeleton.classList.add("hidden");
    if (compInfo) compInfo.classList.add("hidden");
    if (noCompsMsg) noCompsMsg.classList.remove("hidden");
    const logCard = document.getElementById("pick-log-card");
    if (logCard) logCard.style.display = "none";
    if (state.currentScreen === "pick") maybeShowCompetitionEndedModal();
    return;
  } else if (compInfo && state.currentComp) {
    if (compSkeleton) compSkeleton.classList.add("hidden");
    const logCard = document.getElementById("pick-log-card");
    if (logCard) logCard.style.display = "block";
    if (noCompsMsg) noCompsMsg.classList.add("hidden");
    renderCompetitionCard(compInfo, state.currentComp, { collapsibleGoals: false });
  }

  const grid = document.getElementById("name-grid");
  if (!grid) return;
  grid.innerHTML = "";

  const hasLogs = hasLogsInComp(state.currentComp);
  const players = hasLogs ? getRankedPlayers(state.currentComp) : getAlphabeticalPlayers(state.currentComp);
  const activeEmps = Object.entries(state.employees).filter(([, emp]) => !emp.inactive);
  const filtered = activeEmps
    .filter(([, emp]) => emp.name.toLowerCase().includes(filterText.toLowerCase()));

  if (filtered.length === 0) {
    grid.classList.add("empty");
    grid.innerHTML = filterText ? "No players found" : "No players yet - add them in Wiregrass HQ";
    document.getElementById("search-results-info")?.classList.add("hidden");
    return;
  }

  grid.classList.remove("empty");
  const resultsInfo = document.getElementById("search-results-info");
  if (resultsInfo) {
    if (filterText) {
      resultsInfo.textContent = `${filtered.length} of ${activeEmps.length} employees`;
      resultsInfo.classList.remove("hidden");
    } else {
      resultsInfo.classList.add("hidden");
    }
  }

  filtered.forEach(([id, emp]) => {
    const rank = players.findIndex(p => p.id === id);
    const isTopThree = hasLogs && rank >= 0 && rank < 3;
    const isWinner = state.competitions[state.currentComp]?.winner === id;
    const safeName = escapeHtml(emp.name);
    const btn = document.createElement("button");
    btn.className = `name-btn${isWinner ? " name-btn-winner" : ""}`;
    btn.innerHTML = `
      ${isTopThree ? getBoardAvatarHtml(emp, id, rank + 1) : getAvatarHtml(emp, "small", id)}
      <div>
        ${isWinner ? "🏆 " : ""}${safeName}
      </div>
    `;
    btn.onclick = () => enterAsDashboard(id);
    grid.appendChild(btn);
  });
}

// ══════════════════════════════════════════════════════
// Screen management
// ══════════════════════════════════════════════════════

// Tracks screens that have already played their entrance animations.
// On revisit the static containers get .screen-revisit so CSS suppresses
// their animations; dynamically-created elements (cards, rows) still animate.
const _visitedScreens = new Set();

function showScreen(name) {
  document.querySelectorAll(".screen").forEach(s => s.classList.remove("active"));
  const el = document.getElementById(`screen-${name}`);
  if (el) {
    el.classList.add("active");
    if (_visitedScreens.has(name)) {
      el.classList.add("screen-revisit");
    } else {
      _visitedScreens.add(name);
      el.classList.remove("screen-revisit");
    }
  }
  state.currentScreen = name;
  window.scrollTo(0, 0);
  if (name === "dash") statRowAnimated = false;

  // Only show the persistent header on screens that need it.
  const header = document.getElementById("app-header");
  const hideHeader = (
    name === "pick" ||
    name === "board" ||
    name === "admin" ||
    name === "admin-gate" ||
    (name === "dash" && state.dashView === "profile")
  );
  if (hideHeader) {
    header.classList.add("hidden");
  } else {
    header.classList.remove("hidden");
  }

  const bottomNav = document.getElementById("bottom-nav");
  if (bottomNav) {
    bottomNav.classList.toggle("hidden", name === "welcome");
  }

  // Update nav active state
  document.querySelectorAll(".nav-btn").forEach(b => {
    const screen = b.dataset.screen;
    b.classList.toggle("active", screen === name || (name === "admin" && screen === "admin-gate"));
  });

  // Update header
  const headerName = document.getElementById("dash-name");
  const headerComp = document.getElementById("dash-comp-name");
  if (headerName && headerComp) {
    if (name === "board") {
      headerName.textContent = "LEADERBOARD";
      headerComp.textContent = state.competitions[state.boardComp]?.name || "";
    } else if (name === "dash") {
      const emp = state.employees[state.currentUser];
      if (emp) headerName.textContent = emp.name.toUpperCase();
      headerComp.textContent = state.competitions[state.currentComp]?.name || "";
    } else if (name === "admin") {
      headerName.textContent = "ADMIN";
      headerComp.textContent = "";
    } else if (name === "admin-gate") {
      headerName.textContent = "ADMIN";
      headerComp.textContent = "";
    }
  }
}

function enterAsDashboard(empId) {
  state.currentUser = empId;
  localStorage.setItem("lastPlayer", empId);
  state.dashView = "logging";
  state.selectedDate = getTodayDate();

  // Always start fresh when switching employees.
  // (If the selected day already has a log, updatePickLogBtnState will refill and lock these.)
  const salesInput = document.getElementById("pick-input-sales");
  const hoursInput = document.getElementById("pick-input-hours");
  if (salesInput) salesInput.value = "";
  if (hoursInput) hoursInput.value = "";

  const emp = state.employees[empId];

  // Update selector button to show name (collapsed style)
  const selectorWrap = document.querySelector(".pick-emp-selector-wrap");
  const selectorBtn = document.getElementById("pick-emp-selector");
  if (selectorWrap) selectorWrap.classList.add("hidden");
  if (selectorBtn) {
    selectorBtn.textContent = "👤 " + (emp?.name || "");
    selectorBtn.classList.add("has-selection");
    selectorBtn.classList.remove("open");
  }

  // Hide employee grid
  const empGrid = document.getElementById("pick-emp-grid");
  if (empGrid) empGrid.classList.add("hidden");

  // Hide success state if showing from a previous log
  const successState = document.getElementById("pick-success-state");
  if (successState) successState.classList.remove("visible");

  // Reveal form steps with animation
  const formSteps = document.getElementById("pick-form-steps");
  if (formSteps) {
    formSteps.style.display = "block";
    formSteps.classList.add("revealed");
  }

  showSelectedEmployeeProfile(empId, emp);
  renderPickDayRow();
  updatePickLogBtnState();
}

function resetPickEmployeeSelection({ openGrid = false } = {}) {
  state.currentUser = null;
  state.selectedDate = getTodayDate();

  const selectorWrap = document.querySelector(".pick-emp-selector-wrap");
  if (selectorWrap) selectorWrap.classList.remove("hidden");

  const selectorBtn = document.getElementById("pick-emp-selector");
  if (selectorBtn) {
    selectorBtn.textContent = "Choose player";
    selectorBtn.classList.remove("has-selection", "open");
  }

  const empGrid = document.getElementById("pick-emp-grid");
  if (empGrid) empGrid.classList.toggle("hidden", !openGrid);

  const searchEl = document.getElementById("pick-emp-search");
  if (searchEl) searchEl.value = "";
  if (openGrid) {
    renderPickEmpGrid();
    focusElementSoon(searchEl, { preventScroll: true });
  }

  const salesInput = document.getElementById("pick-input-sales");
  const hoursInput = document.getElementById("pick-input-hours");
  if (salesInput) {
    salesInput.value = "";
    salesInput.readOnly = false;
    salesInput.classList.remove("input-locked");
  }
  if (hoursInput) {
    hoursInput.value = "";
    hoursInput.readOnly = false;
    hoursInput.classList.remove("input-locked");
  }

  const formSteps = document.getElementById("pick-form-steps");
  if (formSteps) {
    formSteps.style.display = "none";
    formSteps.classList.remove("revealed");
  }

  const successState = document.getElementById("pick-success-state");
  if (successState) successState.classList.remove("visible");

  hideSelectedEmployeeProfile();
  updatePickLogBtnState();
}

function showSelectedEmployeeProfile(empId, emp) {
  let profileCard = document.getElementById("pick-emp-profile");
  if (!profileCard) {
    profileCard = document.createElement("div");
    profileCard.id = "pick-emp-profile";
    // Insert right after the selector wrap div
    const selectorWrap = document.querySelector(".pick-emp-selector-wrap");
    if (selectorWrap && selectorWrap.parentElement) {
      selectorWrap.parentElement.insertBefore(profileCard, selectorWrap.nextSibling);
    }
  }
  profileCard.style.display = "block";

  profileCard.innerHTML = `
    <div class="pick-selected-emp-card">
      <button class="pick-selected-avatar-btn" id="pick-emp-avatar-btn" type="button" title="Tap to edit avatar">
        ${getAvatarHtml(emp, "pick-large avatar-interactive", empId)}
        <span class="pick-avatar-edit-pill">Edit photo</span>
      </button>
      <div class="pick-selected-emp-copy">
        <div class="pick-selected-emp-name">${escapeHtml(emp.name)}</div>
      </div>
      <button class="pick-selected-clear-btn" id="pick-clear-emp-btn" type="button" title="Choose a different employee" aria-label="Choose a different employee">X</button>
    </div>
  `;

  // Make avatar clickable to edit (employees can only edit avatar)
  document.getElementById("pick-emp-avatar-btn").onclick = (e) => {
    e.stopPropagation();
    promptPickAvatarUpload(empId);
  };

  document.getElementById("pick-clear-emp-btn").onclick = (e) => {
    e.stopPropagation();
    resetPickEmployeeSelection({ openGrid: true });
  };
}

function hideSelectedEmployeeProfile() {
  const profileCard = document.getElementById("pick-emp-profile");
  if (profileCard) profileCard.style.display = "none";
}

function isIOSDevice() {
  const ua = navigator.userAgent || "";
  const platform = navigator.platform || "";
  const touchPoints = navigator.maxTouchPoints || 0;
  return /iPhone|iPad|iPod/i.test(ua) || (platform === "MacIntel" && touchPoints > 1);
}

function promptPickAvatarUpload(empId) {
  triggerAvatarFileInput(empId, { accept: "image/*,.heic,.heif,.png,.jpg,.jpeg,.webp" });
}

function closePickAvatarUploadModal() {
  const modal = document.getElementById("pick-avatar-upload-modal");
  if (modal) modal.classList.remove("active");
}

function getAdminLogEmptyState(message) {
  return `<div class="admin-log-empty-state admin-log-detail-empty">${escapeHtml(message)}</div>`;
}

function triggerAvatarFileInput(empId, { accept = "image/*", capture } = {}) {
  const fileInput = document.createElement("input");
  fileInput.type = "file";
  fileInput.accept = accept;
  if (capture) fileInput.capture = capture;
  fileInput.style.position = "absolute";
  fileInput.style.left = "-9999px";
  document.body.appendChild(fileInput);

  fileInput.onchange = async (e) => {
    const file = e.target.files?.[0];
    fileInput.remove();
    if (!file) return;
    closePickAvatarUploadModal();
    if (file.size > 5000000) {
      showToast("Image too large (max 5MB)");
      return;
    }

    const base64 = await fileToBase64(file);
    await update(dbRef.emp(empId), { avatar: base64 });
    showToast("Photo updated ✅");

    const updatedEmp = state.employees[empId];
    if (updatedEmp && state.currentUser === empId) {
      showSelectedEmployeeProfile(empId, updatedEmp);
    }
  };

  fileInput.click();
}

function renderPickEmpGrid(filterText = "") {
  const list = document.getElementById("pick-emp-list");
  const searchInfo = document.getElementById("pick-search-info");
  if (!list) return;

  const activeEmps = Object.entries(state.employees).filter(([, emp]) => !emp.inactive);
  const filtered = activeEmps
    .filter(([, emp]) => emp.name.toLowerCase().includes(filterText.toLowerCase()))
    .sort(([, a], [, b]) => a.name.localeCompare(b.name));

  if (searchInfo) {
    if (filterText) {
      searchInfo.textContent = `${filtered.length} of ${activeEmps.length} employees`;
      searchInfo.classList.remove("hidden");
    } else {
      searchInfo.classList.add("hidden");
    }
  }

  list.innerHTML = "";
  const hasLogs = hasLogsInComp(state.currentComp);
  const players = hasLogs ? getRankedPlayers(state.currentComp) : [];
  filtered.forEach(([id, emp]) => {
    const rankIdx = players.findIndex(p => p.id === id);
    const isTopThree = hasLogs && rankIdx >= 0 && rankIdx < 3;
    const isWinner = state.competitions[state.currentComp]?.winner === id;
    const safeName = escapeHtml(emp.name);
    const btn = document.createElement("button");
    btn.className = `name-btn${isWinner ? " name-btn-winner" : ""}`;
    btn.innerHTML = `${isTopThree ? getBoardAvatarHtml(emp, id, rankIdx + 1) : getAvatarHtml(emp, "small", id)} <span>${isWinner ? "🏆 " : ""}${safeName}</span>`;
    btn.onclick = () => {
      // Close the grid before entering dashboard
      const grid = document.getElementById("pick-emp-grid");
      if (grid) grid.classList.add("hidden");
      enterAsDashboard(id);
    };
    list.appendChild(btn);
  });
}

// ══════════════════════════════════════════════════════
// Dashboard
// ══════════════════════════════════════════════════════
function renderDash() {
  const emp = state.employees[state.currentUser];
  if (!emp) return;
  const isProfileView = state.dashView === "profile";
  const header = document.getElementById("app-header");
  const dashBody = document.querySelector("#screen-dash .dash-body");

  if (header) {
    header.classList.toggle("hidden", isProfileView);
  }
  if (dashBody) {
    dashBody.classList.toggle("dash-body-profile", isProfileView);
  }

  document.getElementById("dash-name").textContent = emp.name.toUpperCase();
  const viewingCompId = isProfileView ? (state.boardComp || state.currentComp) : state.currentComp;
  const comp = state.competitions[viewingCompId];
  document.getElementById("dash-comp-name").textContent = comp ? comp.name : "";

  const myLogs = (state.logs[viewingCompId] || {})[state.currentUser] || {};
  let totalSales = 0, totalHours = 0;
  Object.values(myLogs).forEach(d => { totalSales += d.sales || 0; totalHours += d.hours || 0; });
  const sph = totalHours > 0 ? totalSales / totalHours : 0;
  const hasLogs = Object.keys(myLogs).length > 0;
  const ranked = getRankedPlayers(viewingCompId);
  const myRank = ranked.findIndex(r => r.id === state.currentUser) + 1;

  const dashCompInfoEl = document.getElementById("dash-comp-info");
  let profileCard = document.getElementById("dash-profile-card");
  let profileBackBtn = document.getElementById("dash-profile-back-top");
  if (!profileBackBtn && dashCompInfoEl?.parentElement) {
    profileBackBtn = document.createElement("button");
    profileBackBtn.id = "dash-profile-back-top";
    profileBackBtn.className = "app-back-btn dash-profile-back-top hidden";
    profileBackBtn.type = "button";
    profileBackBtn.textContent = "← Back to Leaderboard";
    dashCompInfoEl.parentElement.insertBefore(profileBackBtn, dashCompInfoEl);
  }
  if (!profileCard && dashCompInfoEl?.parentElement) {
    profileCard = document.createElement("div");
    profileCard.id = "dash-profile-card";
    profileCard.className = "dash-profile-card hidden";
    dashCompInfoEl.parentElement.insertBefore(profileCard, dashCompInfoEl);
  }

  // Render competition info card on dashboard
  if (dashCompInfoEl && comp) {
    if (isProfileView) {
      dashCompInfoEl.classList.add("hidden");
    } else {
      renderCompetitionCard(dashCompInfoEl, viewingCompId, { collapsibleGoals: true });
    }
  } else if (dashCompInfoEl) {
    dashCompInfoEl.classList.add("hidden");
  }

  if (profileCard) {
    if (isProfileView) {
      const displayRank = myRank > 0 ? myRank : ranked.length + 1;
      profileBackBtn?.classList.remove("hidden");
      profileCard.classList.remove("hidden");
      profileCard.innerHTML = `
        <div class="dash-profile-hero">
          <div class="dash-profile-avatar">
            <button class="dash-profile-avatar-btn pick-selected-avatar-btn" id="dash-profile-avatar-btn" type="button" title="Tap to edit avatar">
              ${getBoardAvatarHtml(emp, state.currentUser, displayRank)}
              <span class="pick-avatar-edit-pill">Edit photo</span>
            </button>
          </div>
          <div class="dash-profile-copy">
            <div class="dash-profile-kicker">Player Profile</div>
            <div class="dash-profile-name-row">
              <h1 class="dash-profile-name">${escapeHtml(emp.name)}</h1>
              ${myRank > 0 ? `<div class="dash-profile-rank-badge">#${myRank}</div>` : ""}
            </div>
            <div class="dash-profile-stats">
              <div class="dash-profile-stat">
                <div class="dash-profile-stat-label">Sales/Hr</div>
                <div class="dash-profile-stat-value">$${sph.toFixed(2)}</div>
              </div>
              <div class="dash-profile-stat">
                <div class="dash-profile-stat-label">Total Sales</div>
                <div class="dash-profile-stat-value dash-profile-stat-value-total">$${totalSales.toFixed(2)}</div>
              </div>
              <div class="dash-profile-stat">
                <div class="dash-profile-stat-label">Hours Worked</div>
                <div class="dash-profile-stat-value">${totalHours.toFixed(1)}</div>
              </div>
              <div class="dash-profile-stat">
                <div class="dash-profile-stat-label"># of Orders</div>
                <div class="dash-profile-stat-value">${Object.keys(myLogs).length}</div>
              </div>
            </div>
          </div>
        </div>
      `;
      profileBackBtn.onclick = () => {
        state.dashView = "logging";
        showScreen("board");
      };
      document.getElementById("dash-profile-avatar-btn")?.addEventListener("click", () => {
        promptPickAvatarUpload(state.currentUser);
      });
    } else {
      profileBackBtn?.classList.add("hidden");
      profileCard.classList.add("hidden");
      profileCard.innerHTML = "";
    }
  }

  // Hide stat cards if no logs exist in the competition yet
  const statRow = document.querySelector(".stat-row");
  if (statRow) {
    const compHasLogs = hasLogsInComp(viewingCompId);
    const wasHidden = statRow.style.display !== "grid";
    statRow.style.display = compHasLogs && !isProfileView ? "grid" : "none";

    if (!compHasLogs || isProfileView) {
      statRowAnimated = false;
    } else if (compHasLogs) {
      if (wasHidden && !statRowAnimated) {
        statRowAnimated = true;
        countUp(document.getElementById("stat-sph"),   sph,        { prefix: '$', decimals: 2 });
        countUp(document.getElementById("stat-total"), totalSales, { prefix: '$', decimals: 2 });
        countUp(document.getElementById("stat-hours"), totalHours, { decimals: 1 });
        if (myRank > 0) countUp(document.getElementById("stat-rank"), myRank, { prefix: '#', decimals: 0 });
        else document.getElementById("stat-rank").textContent = "—";
      } else {
        document.getElementById("stat-sph").textContent   = `$${sph.toFixed(2)}`;
        document.getElementById("stat-total").textContent = `$${totalSales.toFixed(2)}`;
        document.getElementById("stat-hours").textContent = totalHours.toFixed(1);
        document.getElementById("stat-rank").textContent  = myRank > 0 ? `#${myRank}` : "—";
      }
    }
  }

  const winner = comp?.winner;
  const winnerBanner = document.getElementById("winner-banner");
  if (winnerBanner) {
    if (!isProfileView && winner && state.employees[winner]) {
      winnerBanner.innerHTML = `🏆 <strong>${escapeHtml(state.employees[winner].name)}</strong> won!`;
      winnerBanner.style.display = "block";
    } else {
      winnerBanner.style.display = "none";
    }
  }

  // Goals
  const goalsEl = document.getElementById("dash-goals");
  if (goalsEl) {
    const compGoals = getCompGoals(viewingCompId);
    let goalsHtml = "";
    if (compGoals.competition?.value) {
      const g = compGoals.competition;
      goalsHtml += `<div class="goal-block"><div class="goal-label">🎯 Competition Goal</div>${renderGoalBar(g.type === "sph" ? sph : totalSales, g.value, g.type)}</div>`;
    }
    goalsEl.innerHTML = goalsHtml;
    goalsEl.style.display = goalsHtml && !isProfileView ? "flex" : "none";
  }

  const historyList = document.getElementById("history-list");
  historyList.innerHTML = "";
  const hasAnyLogs = Object.keys(myLogs).length > 0;
  if (!hasAnyLogs) {
    historyList.innerHTML = `<div class="ui-empty-state history-empty-state">No logs yet this competition</div>`;
  } else {
    const sortedDates = Object.keys(myLogs).sort().reverse();
    sortedDates.forEach((date, idx) => {
      const log = myLogs[date];
      if (!log) return;
      const daySph = log.hours > 0 ? (log.sales / log.hours) : 0;
      const d = new Date(date + "T00:00:00");
      const dayName = DAYS[d.getDay()]; // 0=Sun, 1=Mon ... 6=Sat
      const dayNum = d.getDate();
      const item = document.createElement("div");
      item.className = "history-item";
      item.style.animationDelay = `${idx * 55}ms`;
      item.innerHTML = `
        <div class="history-day">
          <div class="history-day-name">${dayName}</div>
          <div class="history-day-num">${dayNum}</div>
        </div>
        <div class="history-info">
          <div class="history-sales">$${(log.sales || 0).toFixed(2)}</div>
          <div class="history-meta">${(log.hours || 0).toFixed(1)} hrs</div>
        </div>
        <div class="board-score history-score">
          <div class="board-sph">$${daySph.toFixed(2)}</div>
          <div class="board-sph-label">/HR</div>
        </div>
      `;
      historyList.appendChild(item);
    });
  }
}

// ══════════════════════════════════════════════════════
// Leaderboard
// ══════════════════════════════════════════════════════
function renderBoardCompSelect() {
  const picker = document.getElementById("board-comp-picker");
  const trigger = document.getElementById("board-comp-trigger");
  const menu = document.getElementById("board-comp-menu");
  const title = document.getElementById("board-screen-title");
  if (!picker || !trigger || !menu) return;
  menu.innerHTML = "";

  const nonArchivedComps = Object.entries(state.competitions)
    .sort(([, a], [, b]) => (b.createdAt || 0) - (a.createdAt || 0));

  if (nonArchivedComps.length === 0) {
    picker.style.display = "none";
    if (title) title.textContent = "LEADERBOARD";
    return;
  }

  picker.style.display = "block";
  nonArchivedComps.forEach(([id, comp]) => {
    const opt = document.createElement("button");
    opt.type = "button";
    opt.className = "board-comp-option";
    opt.dataset.compId = id;
    opt.setAttribute("role", "option");
    opt.setAttribute("aria-selected", id === state.boardComp ? "true" : "false");
    opt.textContent = comp.name;
    if (id === state.boardComp) opt.classList.add("active");
    opt.onclick = () => {
      state.boardComp = id;
      closeBoardCompMenu();
      renderBoardCompSelect();
      renderBoard();
      focusElementSoon(trigger, { preventScroll: true });
    };
    opt.onkeydown = (e) => {
      const options = Array.from(menu.querySelectorAll(".board-comp-option"));
      const index = options.indexOf(opt);
      if (e.key === "ArrowDown") {
        e.preventDefault();
        options[(index + 1) % options.length]?.focus();
      } else if (e.key === "ArrowUp") {
        e.preventDefault();
        options[(index - 1 + options.length) % options.length]?.focus();
      } else if (e.key === "Home") {
        e.preventDefault();
        options[0]?.focus();
      } else if (e.key === "End") {
        e.preventDefault();
        options[options.length - 1]?.focus();
      } else if (e.key === "Escape") {
        e.preventDefault();
        closeBoardCompMenu();
        focusElementSoon(trigger, { preventScroll: true });
      }
    };
    menu.appendChild(opt);
  });
  const activeComp = state.competitions[state.boardComp];
  trigger.textContent = activeComp?.name || nonArchivedComps[0]?.[1]?.name || "Select...";
  if (title) {
    title.textContent = activeComp ? `LEADERBOARD` : "LEADERBOARD";
  }
  trigger.onclick = () => {
    if (picker.classList.contains("open")) closeBoardCompMenu();
    else openBoardCompMenu();
  };
  trigger.onkeydown = (e) => {
    if (e.key === "ArrowDown" || e.key === "Enter" || e.key === " ") {
      e.preventDefault();
      openBoardCompMenu();
      focusElementSoon(menu.querySelector(".board-comp-option.active") || menu.querySelector(".board-comp-option"), { preventScroll: true });
    }
  };
}

function openBoardCompMenu() {
  const picker = document.getElementById("board-comp-picker");
  const trigger = document.getElementById("board-comp-trigger");
  const menu = document.getElementById("board-comp-menu");
  if (!picker || !trigger || !menu) return;
  picker.classList.add("open");
  menu.classList.remove("hidden");
  trigger.setAttribute("aria-expanded", "true");
}

function closeBoardCompMenu() {
  const picker = document.getElementById("board-comp-picker");
  const trigger = document.getElementById("board-comp-trigger");
  const menu = document.getElementById("board-comp-menu");
  if (!picker || !trigger || !menu) return;
  picker.classList.remove("open");
  menu.classList.add("hidden");
  trigger.setAttribute("aria-expanded", "false");
}

function renderBoardEndedPodium(compId, body) {
  const players = getRankedPlayers(compId);
  const ranked = players.filter(p => p.sph > 0);
  if (ranked.length === 0) return;

  const metric = state.settings.rankingMetric || "sph";
  const rankGroups = getLeaderboardRankGroups(ranked, metric);
  const podiumGroups = rankGroups.filter(g => g.rank <= 3);
  if (podiumGroups.length === 0) return;

  const scoreValue = (p) => metric === "sph" ? `$${p.sph.toFixed(2)}` : `$${p.total.toFixed(2)}`;
  const scoreLabel = metric === "sph" ? "/HR" : "TOTAL";

  const section = document.createElement("div");
  section.className = "board-ended-section";

  const kicker = document.createElement("div");
  kicker.className = "board-ended-kicker";
  kicker.textContent = "Competition Ended";
  section.appendChild(kicker);

  const podiumEl = document.createElement("div");
  podiumEl.className = "ended-podium";

  [1, 2, 3].forEach(rank => {
    const group = podiumGroups.find(g => g.rank === rank);
    if (!group) return;
    const tied = group.players.length > 1;

    const placeEl = document.createElement("div");
    placeEl.className = `ended-podium-place ended-podium-place-${rank}${tied ? " ended-podium-tie" : ""}`;

    const rankEl = document.createElement("div");
    rankEl.className = "ended-podium-rank";
    rankEl.textContent = `#${rank}${tied ? " TIE" : ""}`;
    placeEl.appendChild(rankEl);

    const playersEl = document.createElement("div");
    playersEl.className = "ended-podium-players";

    group.players.forEach(player => {
      const emp = state.employees[player.id] || { name: player.name };
      const btn = document.createElement("button");
      btn.type = "button";
      btn.className = "ended-podium-player board-ended-podium-player";
      btn.innerHTML = `
        ${getBoardAvatarHtml(emp, player.id, rank)}
        <div class="ended-podium-name">${escapeHtml(player.name)}</div>
        <div class="ended-podium-score">${scoreValue(player)} <span>${scoreLabel}</span></div>
      `;
      btn.onclick = () => {
        state.currentUser = player.id;
        state.dashView = "profile";
        renderDash();
        showScreen("dash");
      };
      playersEl.appendChild(btn);
    });

    placeEl.appendChild(playersEl);
    podiumEl.appendChild(placeEl);
  });

  section.appendChild(podiumEl);
  body.appendChild(section);
}

function renderBoard() {
  const compId = state.boardComp || state.currentComp;
  const body = document.getElementById("board-body");
  const noCompsMsg = document.getElementById("board-no-comps");
  if (!body) return;

  // If no competition, show message
  if (!compId || !state.competitions[compId]) {
    body.innerHTML = `
      <div class="board-empty-state">
        <div class="board-empty-icon board-empty-pixel-icon">★</div>
        <div class="board-empty-title">NO COMPETITION YET</div>
        <div class="board-empty-sub">Ask your manager to set up a competition.</div>
      </div>
    `;
    if (noCompsMsg) noCompsMsg.style.display = "none";
    return;
  }

  if (noCompsMsg) noCompsMsg.style.display = "none";
  const comp = state.competitions[compId];
  const hasLogs = hasLogsInComp(compId);
  body.innerHTML = "";

  if (!hasLogs) {
    body.innerHTML = `
      <div class="board-empty-state">
        <div class="board-empty-icon board-empty-pixel-icon">▶</div>
        <div class="board-empty-title">COMPETITION STARTS NOW</div>
        <div class="board-empty-sub">Be the first to log an order and claim the top spot!</div>
        <button class="board-empty-cta" onclick="document.getElementById('nav-home').click()">+ LOG AN ORDER</button>
      </div>
    `;
    return;
  }

  const players = getRankedPlayers(compId);
  if (players.length === 0) {
    body.innerHTML = `
      <div class="board-empty-state">
        <div class="board-empty-icon board-empty-pixel-icon">▶</div>
        <div class="board-empty-title">NO ORDERS YET</div>
        <div class="board-empty-sub">The scoreboard is empty. Log your first OIS and lead the pack!</div>
        <button class="board-empty-cta" onclick="document.getElementById('nav-home').click()">+ LOG AN ORDER</button>
      </div>
    `;
    return;
  }

  // Has logs - show ranked list
  const metric = state.settings.rankingMetric || "sph";
  const winner = comp?.winner;
  const movementById = getLeaderboardMovement(compId);

  const ranked = players.filter(p => p.sph > 0);
  const zeroes = players.filter(p => p.sph === 0);

  if (isCompEnded(comp)) {
    renderBoardEndedPodium(compId, body);
    if (ranked.length > 0) {
      const rankDivider = document.createElement("div");
      rankDivider.className = "board-section-header";
      rankDivider.innerHTML = `<span>FULL RANKINGS</span>`;
      body.appendChild(rankDivider);
    }
  }

  function makeBoardCard(player, index, tieGroupSize = 1, isZero = false) {
    const displayRank = isZero ? null : getLeaderboardDisplayRank(ranked, index, metric);
    const isWinner = winner === player.id;
    const emp = state.employees[player.id];
    const card = document.createElement("div");
    const isCurrentUser = state.currentUser === player.id;
    const movement = movementById.get(player.id) || { type: "same", label: "HOLD" };
    const rankClasses = ["board-card"];
    if (!isZero && displayRank <= 3) rankClasses.push(`rank-${displayRank}`);
    if (isZero) rankClasses.push("zero-sph");
    if (isWinner) rankClasses.push("winner-card");
    if (isCurrentUser) rankClasses.push("is-you");
    if (tieGroupSize > 1) rankClasses.push("tie-card");
    card.className = rankClasses.join(" ");
    card.style.animationDelay = `${index * 0.06}s`;
    const safePlayerName = escapeHtml(player.name);
    card.innerHTML = `
      <div class="board-rank-stack">
        <div class="board-rank-num">${isZero ? "—" : `#${displayRank}`}</div>
        ${isZero ? "" : `<div class="board-trend board-trend-${movement.type}">${movement.label}</div>`}
      </div>
      ${getBoardAvatarHtml(emp || { name: player.name }, player.id, isZero ? 99 : displayRank)}
      <div class="board-info">
        <div class="board-name-row">
          <div class="board-name">
            ${safePlayerName}${isWinner ? " <span class='winner-label'>WINNER</span>" : ""}${emp?.inactive ? " <span class='past-emp-label'>PAST</span>" : ""}
          </div>
        </div>
      </div>
      <div class="board-score">
        <div class="board-sph">$${player.sph.toFixed(2)}</div>
        <div class="board-sph-label">/HR</div>
        <div class="board-card-arrow">→</div>
      </div>
    `;
    card.setAttribute("role", "button");
    card.setAttribute("tabindex", "0");
    card.onclick = () => {
      state.currentUser = player.id;
      state.dashView = "profile";
      renderDash();
      showScreen("dash");
    };
    card.onkeydown = (e) => {
      if (e.key === "Enter" || e.key === " ") { e.preventDefault(); card.click(); }
    };
    return card;
  }

  for (let i = 0; i < ranked.length; i++) {
    const tieGroup = [ranked[i]];
    let j = i + 1;
    while (j < ranked.length && playersTiedOnLeaderboard(ranked[j - 1], ranked[j], metric)) {
      tieGroup.push(ranked[j]);
      j++;
    }

    if (tieGroup.length > 1) {
      const wrap = document.createElement("div");
      wrap.className = "board-tie-group";
      wrap.style.animationDelay = `${i * 0.06}s`;
      wrap.innerHTML = `<div class="board-tie-group-label">TIE AT #${getLeaderboardDisplayRank(ranked, i, metric)}</div>`;
      tieGroup.forEach((tiedPlayer, offset) => {
        wrap.appendChild(makeBoardCard(tiedPlayer, i + offset, tieGroup.length));
      });
      body.appendChild(wrap);
      i = j - 1;
      continue;
    }

    body.appendChild(makeBoardCard(ranked[i], i));
  }

  if (zeroes.length > 0) {
    const sep = document.createElement("div");
    sep.className = "board-zero-divider";
    sep.innerHTML = `<span>NO SALES</span>`;
    body.appendChild(sep);
    zeroes.forEach((player, idx) => {
      body.appendChild(makeBoardCard(player, ranked.length + idx, 1, true));
    });
  }
}

// ══════════════════════════════════════════════════════
// All-Time
// ══════════════════════════════════════════════════════
function renderAllTime() {
  // Placeholder - all-time screen removed
}

// ══════════════════════════════════════════════════════
// Helper
// ══════════════════════════════════════════════════════
function hasLogsInComp(compId) {
  const compLogs = state.logs[compId] || {};
  return Object.keys(compLogs).some(empId => {
    const empLogs = compLogs[empId];
    return Object.keys(empLogs || {}).length > 0;
  });
}

function getAlphabeticalPlayers(compId) {
  const compLogs = state.logs[compId] || {};
  return Object.entries(state.employees)
    .filter(([, emp]) => !emp.inactive)
    .map(([id, emp]) => {
      const empLogs = compLogs[id] || {};
      let total = 0, hours = 0;
      Object.values(empLogs).forEach(log => { total += log.sales || 0; hours += log.hours || 0; });
      return { id, name: emp.name, total, hours, sph: hours > 0 ? total / hours : 0 };
    })
    .sort((a, b) => a.name.localeCompare(b.name));
}

function getRankedPlayers(compId, logsSource = state.logs) {
  const compLogs = logsSource[compId] || {};
  const metric = state.settings.rankingMetric || "sph";
  return Object.entries(state.employees)
    .map(([id, emp]) => {
      const empLogs = compLogs[id] || {};
      let total = 0, hours = 0;
      Object.values(empLogs).forEach(log => { total += log.sales || 0; hours += log.hours || 0; });
      return { id, name: emp.name, total, hours, sph: hours > 0 ? total / hours : 0 };
    })
    .filter(player => player.total > 0 || player.hours > 0)
    .sort((a, b) => metric === "sph" ? b.sph - a.sph : b.total - a.total);
}

function getLeaderboardMetricValue(player, metric = state.settings.rankingMetric || "sph") {
  return metric === "sph" ? player.sph : player.total;
}

function playersTiedOnLeaderboard(a, b, metric = state.settings.rankingMetric || "sph") {
  if (!a || !b) return false;
  return Math.abs(getLeaderboardMetricValue(a, metric) - getLeaderboardMetricValue(b, metric)) < 0.001;
}

function getLeaderboardDisplayRank(players, index, metric = state.settings.rankingMetric || "sph") {
  if (index <= 0) return 1;
  return playersTiedOnLeaderboard(players[index], players[index - 1], metric)
    ? getLeaderboardDisplayRank(players, index - 1, metric)
    : index + 1;
}

function getLeaderboardRankGroups(players, metric = state.settings.rankingMetric || "sph") {
  const groups = [];
  for (let i = 0; i < players.length; i++) {
    const rank = getLeaderboardDisplayRank(players, i, metric);
    const lastGroup = groups[groups.length - 1];
    if (lastGroup && lastGroup.rank === rank) {
      lastGroup.players.push(players[i]);
    } else {
      groups.push({ rank, players: [players[i]] });
    }
  }
  return groups;
}

function renderCompetitionEndedModal(compId) {
  const modal = document.getElementById("competition-ended-modal");
  const body = document.getElementById("competition-ended-body");
  if (!modal || !body || !compId || !state.competitions[compId]) return;

  const comp = state.competitions[compId];
  const players = getRankedPlayers(compId);
  const metric = state.settings.rankingMetric || "sph";
  const rankGroups = getLeaderboardRankGroups(players, metric);
  const winnerGroup = rankGroups.find(group => group.rank === 1);
  const storedWinner = comp.winner ? state.employees[comp.winner] : null;
  const winnerNames = winnerGroup?.players?.length
    ? winnerGroup.players.map(player => player.name).join(" + ")
    : (storedWinner?.name || "No winner");
  const podiumGroups = rankGroups.filter(group => group.rank <= 3);
  const restGroups = rankGroups.filter(group => group.rank > 3);
  const podiumRankOrder = [2, 1, 3];
  const podiumOrder = podiumRankOrder
    .map(rank => podiumGroups.find(group => group.rank === rank))
    .filter(Boolean);

  const scoreLabel = metric === "sph" ? "/HR" : "TOTAL";
  const scoreValue = (player) => metric === "sph" ? `$${player.sph.toFixed(2)}` : `$${player.total.toFixed(2)}`;
  const podiumHtml = podiumOrder.map((group) => {
    const rank = group.rank;
    const tied = group.players.length > 1;
    const playerHtml = group.players.map((player) => {
      const emp = state.employees[player.id] || { name: player.name };
      return `
        <div class="ended-podium-player">
          ${getBoardAvatarHtml(emp, player.id, rank)}
          <div class="ended-podium-name">${escapeHtml(player.name)}</div>
          <div class="ended-podium-score">${scoreValue(player)} <span>${scoreLabel}</span></div>
        </div>
      `;
    }).join("");
    return `
      <div class="ended-podium-place ended-podium-place-${rank}${tied ? " ended-podium-tie" : ""}">
        <div class="ended-podium-rank">#${rank}${tied ? " TIE" : ""}</div>
        <div class="ended-podium-players">${playerHtml}</div>
      </div>
    `;
  }).join("");

  const restHtml = restGroups.flatMap((group) => (
    group.players.map((player) => `
        <div class="ended-rank-row${group.players.length > 1 ? " ended-rank-row-tie" : ""}">
          <span class="ended-rank-num">#${group.rank}</span>
          <span class="ended-rank-name">${escapeHtml(player.name)}</span>
          <span class="ended-rank-score">${scoreValue(player)}</span>
        </div>
      `)
  )).join("");

  body.innerHTML = `
    <div class="competition-ended-kicker">Competition Ended</div>
    <div class="competition-ended-title" id="competition-ended-title">${escapeHtml(comp.name || "Competition")}</div>
    <div class="competition-ended-winner">
      <span class="competition-ended-winner-label">${winnerGroup?.players?.length > 1 ? "Winners" : "Winner"}</span>
      <span class="competition-ended-winner-name">${escapeHtml(winnerNames)}</span>
    </div>
    ${podiumHtml ? `<div class="ended-podium">${podiumHtml}</div>` : `
      <div class="ended-empty">No orders were logged this round.</div>
    `}
    ${restHtml ? `<div class="ended-rank-list">${restHtml}</div>` : ""}
    <button class="competition-ended-board-btn" id="competition-ended-board-btn" type="button">View Leaderboard</button>
  `;

  modal.dataset.compId = compId;
  setModalInert(true);
  modal.classList.add("active");
  focusElementSoon(document.getElementById("competition-ended-close"), { preventScroll: true });

  document.getElementById("competition-ended-board-btn")?.addEventListener("click", () => {
    closeCompetitionEndedModal();
    state.boardComp = compId;
    renderBoard();
    showScreen("board");
  });
}

function closeCompetitionEndedModal() {
  const modal = document.getElementById("competition-ended-modal");
  if (!modal) return;
  if (modal.dataset.compId) state.endedRevealDismissedCompId = modal.dataset.compId;
  modal.classList.remove("active");
  setModalInert(false);
}

function maybeShowCompetitionEndedModal({ force = false } = {}) {
  let compId = null;
  if (state.currentComp && isCompEnded(state.competitions[state.currentComp])) {
    compId = state.currentComp;
  } else if (!state.currentComp) {
    compId = getLatestEndedCompId();
  }
  if (!compId) return;
  if (!force && state.endedRevealDismissedCompId === compId) return;
  if (force) state.endedRevealDismissedCompId = null;
  renderCompetitionEndedModal(compId);
}

function getCompetitionLogDates(compId, logsSource = state.logs) {
  const compLogs = logsSource[compId] || {};
  const dates = new Set();
  Object.values(compLogs).forEach(empLogs => {
    Object.keys(empLogs || {}).forEach(date => dates.add(date));
  });
  return Array.from(dates).sort();
}

function buildCompetitionLogsSnapshot(compId, cutoffDate, logsSource = state.logs) {
  const snapshot = { ...logsSource, [compId]: {} };
  const compLogs = logsSource[compId] || {};
  Object.entries(compLogs).forEach(([empId, empLogs]) => {
    snapshot[compId][empId] = Object.fromEntries(
      Object.entries(empLogs || {}).filter(([date]) => date <= cutoffDate)
    );
  });
  return snapshot;
}

function getLeaderboardMovement(compId) {
  const currentPlayers = getRankedPlayers(compId);
  const currentMetric = state.settings.rankingMetric || "sph";
  const logDates = getCompetitionLogDates(compId);
  if (logDates.length <= 1) {
    return new Map(currentPlayers.map(player => [player.id, { type: "new", label: "NE" }]));
  }

  const previousSnapshot = buildCompetitionLogsSnapshot(compId, logDates[logDates.length - 2]);
  const previousPlayers = getRankedPlayers(compId, previousSnapshot);
  const previousRankById = new Map(
    previousPlayers.map((player, index) => [
      player.id,
      getLeaderboardDisplayRank(previousPlayers, index, currentMetric)
    ])
  );

  return new Map(
    currentPlayers.map((player, index) => {
      const currentRank = getLeaderboardDisplayRank(currentPlayers, index, currentMetric);
      const previousRank = previousRankById.get(player.id);
      if (!previousRank) return [player.id, { type: "new", label: "NE" }];
      if (previousRank > currentRank) return [player.id, { type: "up", label: `↑${previousRank - currentRank}` }];
      if (previousRank < currentRank) return [player.id, { type: "down", label: `↓${currentRank - previousRank}` }];
      return [player.id, { type: "same", label: "—" }];
    })
  );
}


// ══════════════════════════════════════════════════════
// ADMIN — Tab system
// ══════════════════════════════════════════════════════
function renderAdminSummaryBar() {
  const bar = document.getElementById("admin-summary-bar");
  if (!bar) return;
  const empCount = Object.keys(state.employees).length;
  const today = getTodayDate();
  const compId = state.currentComp;
  let logsToday = 0;
  if (compId && state.logs[compId]) {
    Object.values(state.logs[compId]).forEach(empLogs => {
      if (empLogs[today]) logsToday++;
    });
  }
  const comp = compId ? state.competitions[compId] : null;
  const days = comp ? daysRemaining(comp) : null;
  const dayStr = days === null ? "" : days <= 0 ? "Ends today" : `${days}d left`;
}

function openAdminPanel() {
  state.admin.tab = "competitions";
  renderAdminTab();
  renderAdminTabBar();
  showScreen("admin");
}

function renderAdminTabBar() {
  const tabs = [
    { id: "competitions", label: "Competitions" },
    { id: "employees",    label: "Players" },
    { id: "logs",         label: "Orders" },
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
  const topBackBtn = document.getElementById("admin-back-top");
  if (topBackBtn) topBackBtn.classList.add("hidden");
  content.innerHTML = "";
  content.classList.toggle("admin-tab-content-compact", state.admin.tab === "competitions");
  switch (state.admin.tab) {
    case "competitions": renderAdminComps(content); break;
    case "employees":    renderAdminEmps(content); break;
    case "logs":         renderAdminLogs(content); break;
  }
}

// ══════════════════════════════════════════════════════
// ADMIN — Competitions
// ══════════════════════════════════════════════════════
function renderAdminComps(container) {
  container.innerHTML = `<div class="admin-section-title">MANAGE COMPETITIONS</div>`;
  const entries = Object.entries(state.competitions)
    .sort(([, a], [, b]) => (b.createdAt || 0) - (a.createdAt || 0));
  const filterOptions = [
    { id: "all", label: "All" },
    { id: "active", label: "Active" },
    { id: "ended", label: "Ended" },
  ];
  const filteredEntries = entries.filter(([, comp]) => {
    const ended = isCompEnded(comp);
    if (state.admin.compFilter === "active") return !ended;
    if (state.admin.compFilter === "ended") return ended;
    return true;
  });
  const toShow = state.admin.showAllComps ? filteredEntries : filteredEntries.slice(0, PREVIEW_COUNT);

  const filterBar = document.createElement("div");
  filterBar.className = "admin-comp-filter-bar";
  filterOptions.forEach(option => {
    const count = entries.filter(([, comp]) => {
      const ended = isCompEnded(comp);
      if (option.id === "active") return !ended;
      if (option.id === "ended") return ended;
      return true;
    }).length;
    const btn = document.createElement("button");
    btn.type = "button";
    btn.className = `admin-comp-filter-btn${state.admin.compFilter === option.id ? " active" : ""}`;
    btn.innerHTML = `<span>${option.label}</span><span class="admin-comp-filter-count">${count}</span>`;
    btn.onclick = () => {
      state.admin.compFilter = option.id;
      state.admin.showAllComps = false;
      state.admin.editingCompId = null;
      renderAdminTab();
    };
    filterBar.appendChild(btn);
  });
  container.appendChild(filterBar);

  const list = document.createElement("div");
  list.className = "admin-list";

  toShow.forEach(([id, comp]) => {
    const compWrap = document.createElement("div");
    compWrap.className = `admin-comp-row${state.admin.editingCompId === id ? " editing" : ""}`;

    const item = document.createElement("div");
    item.className = "admin-item admin-comp-item";
    item.id = `admin-comp-item-${id}`;
    const ended = isCompEnded(comp);
    const upcoming = isCompUpcoming(comp);

    const leftPart = document.createElement("div");
    leftPart.className = "admin-item-left";
    leftPart.innerHTML = `
      <span class="admin-item-name">${escapeHtml(comp.name)}</span>
      ${ended ? `<span class="comp-status-chip comp-status-ended">Ended</span>` : ""}
      ${upcoming ? `<span class="comp-status-chip comp-status-upcoming">Upcoming</span>` : ""}
    `;
    item.appendChild(leftPart);

    const rightPart = document.createElement("div");
    rightPart.className = "admin-item-actions";
    if (!ended) {
      rightPart.appendChild(makeBtn(state.admin.editingCompId === id ? "Close" : "Edit", "del-btn", () => {
        state.admin.editingCompId = state.admin.editingCompId === id ? null : id;
        renderAdminTab();
        requestAnimationFrame(() => {
          document.getElementById(`admin-comp-row-${id}`)?.scrollIntoView({ behavior: "smooth", block: "nearest" });
        });
      }));
    }
    item.appendChild(rightPart);

    compWrap.id = `admin-comp-row-${id}`;
    compWrap.appendChild(item);
    if (state.admin.editingCompId === id) {
      const inlineEdit = document.createElement("div");
      inlineEdit.className = "goal-admin-block admin-new-comp-form admin-edit-comp-form admin-inline-comp-edit";
      compWrap.appendChild(inlineEdit);
      renderCompEditForm(id, comp, inlineEdit, {
        onDone: () => {
          state.admin.editingCompId = null;
          renderAdminTab();
        },
      });
    }

    list.appendChild(compWrap);
  });
  if (filteredEntries.length === 0) {
    const empty = document.createElement("div");
    empty.className = "admin-list-empty-state admin-comp-empty-state";
    const emptyLabel = state.admin.compFilter === "active" ? "No active competitions" : "No ended competitions";
    empty.textContent = emptyLabel;
    list.appendChild(empty);
  }
  // New competition form
  const newCompSection = document.createElement("div");
  newCompSection.className = "goal-admin-block";
  newCompSection.classList.add("admin-new-comp-section");

  const toggleBtn = document.createElement("button");
  toggleBtn.className = "collapsible-toggle";
  toggleBtn.innerHTML = `+ NEW COMPETITION <span class="collapsible-toggle-icon">▼</span>`;

  const collapsibleContent = document.createElement("div");
  collapsibleContent.id = "new-comp-form";
  collapsibleContent.style.display = "none";
  collapsibleContent.className = "admin-new-comp-form";
  collapsibleContent.innerHTML = `
    <div class="admin-form-field-offset">
      <label class="field-label">NAME *</label>
      <input type="text" id="input-new-comp" class="log-input admin-form-input-spaced" placeholder="e.g.OIS Competition" />
    </div>
    <div class="log-fields admin-form-fields-spaced">
      <div class="log-field-wrap">
        <label class="field-label">START DATE *</label>
        <input type="date" id="input-new-comp-start" class="log-input" />
      </div>
      <div class="log-field-wrap">
        <label class="field-label">END DATE *</label>
        <input type="date" id="input-new-comp-end" class="log-input" />
      </div>
    </div>
    <div class="admin-form-field-offset">
      <label class="field-label">COMPETITION GOAL</label>
      <label class="goal-day-input-shell goal-admin-input-shell" for="input-new-comp-goal">
        <span class="goal-day-currency">$</span>
        <input type="number" id="input-new-comp-goal" class="log-input goal-day-input" placeholder="0" min="0" step="1" />
      </label>
    </div>
    <button class="log-btn btn-ghost" id="btn-add-comp" disabled>+ CREATE COMPETITION</button>
  `;

  const dateBlock = getNewCompetitionDateBlock();
  const blockMessage = dateBlock
    ? `"${dateBlock.compName}" ends on ${formatDate(dateBlock.endDate)}. New competitions must start on or after ${formatDate(dateBlock.earliestStartDate)}.`
    : "";

  newCompSection.appendChild(toggleBtn);
  newCompSection.appendChild(collapsibleContent);
  container.appendChild(newCompSection);

  // Toggle functionality
  toggleBtn.onclick = () => {
    const isHidden = collapsibleContent.style.display === "none";
    collapsibleContent.style.display = isHidden ? "block" : "none";
    toggleBtn.classList.toggle("expanded", isHidden);
  };

  const checkReady = () => {
    const name = document.getElementById("input-new-comp")?.value.trim();
    const start = document.getElementById("input-new-comp-start")?.value;
    const end = document.getElementById("input-new-comp-end")?.value;
    const btn = document.getElementById("btn-add-comp");
    if (!btn) return;
    const isAfterBlockedRange = !dateBlock || !start || start >= dateBlock.earliestStartDate;
    const ready = !!(name && start && end && start <= end && isAfterBlockedRange);
    btn.disabled = !ready;
    btn.classList.toggle("btn-ghost", !ready);
  };
  const newCompNameInput = document.getElementById("input-new-comp");
  const newCompStartInput = document.getElementById("input-new-comp-start");
  const newCompEndInput = document.getElementById("input-new-comp-end");
  let lastDateBlockAlertAt = 0;
  let dateBlockAlertShown = false;
  const showDateBlockAlert = (force = false) => {
    if (!dateBlock) return;
    if (!force && dateBlockAlertShown) return;
    const now = Date.now();
    if (now - lastDateBlockAlertAt < 600) return;
    lastDateBlockAlertAt = now;
    dateBlockAlertShown = true;
    showAppAlert({
      title: "Date Unavailable",
      message: blockMessage,
      confirmLabel: "Got it",
    });
  };
  if (dateBlock && newCompStartInput) {
    newCompStartInput.min = dateBlock.earliestStartDate;
    newCompStartInput.title = blockMessage;
  }
  if (dateBlock && newCompEndInput) {
    newCompEndInput.min = dateBlock.earliestStartDate;
  }
  newCompNameInput.oninput = checkReady;
  newCompStartInput.onfocus = showDateBlockAlert;
  newCompStartInput.onclick = showDateBlockAlert;
  newCompStartInput.onchange = () => {
    if (dateBlock && newCompStartInput.value && newCompStartInput.value < dateBlock.earliestStartDate) {
      newCompStartInput.value = "";
      showDateBlockAlert(true);
    }
    if (newCompEndInput) {
      newCompEndInput.min = newCompStartInput.value || dateBlock?.earliestStartDate || "";
      if (newCompEndInput.value && newCompStartInput.value && newCompEndInput.value < newCompStartInput.value) {
        newCompEndInput.value = "";
      }
    }
    checkReady();
  };
  newCompEndInput.onchange = checkReady;

  document.getElementById("btn-add-comp").onclick = async () => {
    const name = document.getElementById("input-new-comp").value.trim();
    const startDate = document.getElementById("input-new-comp-start").value;
    const endDate = document.getElementById("input-new-comp-end").value;
    const goalValue = parseFloat(document.getElementById("input-new-comp-goal").value);
    if (!name || !startDate || !endDate) return;
    const latestDateBlock = getNewCompetitionDateBlock();
    if (latestDateBlock && startDate < latestDateBlock.earliestStartDate) {
      await showAppAlert({
        title: "Date Unavailable",
        message: `"${latestDateBlock.compName}" ends on ${formatDate(latestDateBlock.endDate)}. New competitions must start on or after ${formatDate(latestDateBlock.earliestStartDate)}.`,
        confirmLabel: "Got it",
      });
      return;
    }
    const id = `comp_${Date.now()}`;
    await set(dbRef.comp(id), { name, startDate, endDate, createdAt: Date.now() });
    if (goalValue > 0) {
      await set(ref(db, `goals/${id}/competition`), { type: "total", value: goalValue });
    }
    showToast(`"${name}" created! 🏆`);
    ["input-new-comp","input-new-comp-start","input-new-comp-end","input-new-comp-goal"].forEach(i => {
      const el = document.getElementById(i);
      if (el) el.value = "";
    });
    checkReady();
  };

  container.appendChild(list);

  if (filteredEntries.length > PREVIEW_COUNT) {
    container.appendChild(makeBtn(
      state.admin.showAllComps ? "Show less ▲" : `View all ${filteredEntries.length} ▼`,
      "view-all-btn",
      () => { state.admin.showAllComps = !state.admin.showAllComps; renderAdminTab(); }
    ));
  }

  // Recently Deleted section
  const deletedEntries = Object.entries(state.deletedCompetitions)
    .sort(([, a], [, b]) => b.deletedAt - a.deletedAt);
  if (deletedEntries.length > 0) {
    const deletedSection = document.createElement("div");
    deletedSection.className = "goal-admin-block admin-recently-deleted-section";

    const deletedToggle = document.createElement("button");
    deletedToggle.className = "collapsible-toggle admin-recently-deleted-toggle";
    deletedToggle.innerHTML = `🗑 RECENTLY DELETED (${deletedEntries.length}) <span class="collapsible-toggle-icon">▼</span>`;

    const deletedContent = document.createElement("div");
    deletedContent.className = "admin-recently-deleted-list";
    deletedContent.style.display = "none";

    const SEVEN_DAYS = 7 * 24 * 60 * 60 * 1000;
    deletedEntries.forEach(([id, data]) => {
      const comp = data.comp || {};
      const daysLeft = Math.max(0, Math.ceil((SEVEN_DAYS - (Date.now() - data.deletedAt)) / (24 * 60 * 60 * 1000)));
      const row = document.createElement("div");
      row.className = "admin-item admin-deleted-comp-item";
      const left = document.createElement("div");
      left.className = "admin-item-left";
      left.innerHTML = `
        <span class="admin-item-name">${escapeHtml(comp.name || id)}</span>
        <span class="admin-deleted-expiry">Deleted · ${daysLeft}d left to restore</span>
      `;
      const right = document.createElement("div");
      right.className = "admin-item-actions";
      const restoreBtn = makeBtn("Restore", "del-btn admin-restore-btn", async () => {
        const ok = await showAppConfirm({
          title: "Restore Competition",
          message: `Restore "${comp.name}" and all its logs?`,
          confirmLabel: "Restore",
        });
        if (!ok) return;
        if (data.comp) await set(dbRef.comp(id), data.comp);
        if (data.logs) await set(ref(db, `logs/${id}`), data.logs);
        if (data.goals) await set(ref(db, `goals/${id}`), data.goals);
        await remove(dbRef.deletedComp(id));
        showToast(`"${comp.name}" restored ✅`);
      });
      right.appendChild(restoreBtn);
      row.appendChild(left);
      row.appendChild(right);
      deletedContent.appendChild(row);
    });

    deletedSection.appendChild(deletedToggle);
    deletedSection.appendChild(deletedContent);
    container.appendChild(deletedSection);

    deletedToggle.onclick = () => {
      const isHidden = deletedContent.style.display === "none";
      deletedContent.style.display = isHidden ? "flex" : "none";
      deletedToggle.classList.toggle("expanded", isHidden);
    };
  }
}

function renderCompEditForm(compId, comp, editForm, { onDone = null } = {}) {
  editForm.innerHTML = "";
  const changedFields = {};
  let saveAllBtn = null;

  const normalizeStringValue = (value) => String(value ?? "");
  const normalizeNumericGoalValue = (value) => {
    const num = Number.parseFloat(String(value ?? "").trim());
    if (!Number.isFinite(num) || num <= 0) return "";
    return String(num);
  };

  const getHighlightTarget = (el) => (
    el?.closest(".goal-day-input-shell") ||
    el?.closest(".admin-form-field-offset") ||
    el?.closest(".log-field-wrap") ||
    el
  );

  const updateSaveButtonState = () => {
    if (!saveAllBtn) return;
    const isDirty = Object.keys(changedFields).length > 0;
    saveAllBtn.disabled = !isDirty;
    saveAllBtn.classList.toggle("btn-ghost", !isDirty);
  };

  const highlightField = (id) => {
    const el = editForm.querySelector(`#${id}`);
    const target = getHighlightTarget(el);
    target?.classList.toggle("admin-field-changed", !!changedFields[id]);
    updateSaveButtonState();
  };

  const addChangeListener = (id, originalValue, compare = "string") => {
    const el = editForm.querySelector(`#${id}`);
    if (!el) return;
    const checkChange = () => {
      const currentValue = el.value;
      const normalizedCurrent = compare === "numeric-goal"
        ? normalizeNumericGoalValue(currentValue)
        : normalizeStringValue(currentValue);
      const normalizedOriginal = compare === "numeric-goal"
        ? normalizeNumericGoalValue(originalValue)
        : normalizeStringValue(originalValue);

      if (normalizedCurrent !== normalizedOriginal) changedFields[id] = true;
      else delete changedFields[id];
      highlightField(id);
    };
    el.addEventListener("input", checkChange);
    el.addEventListener("change", checkChange);
  };

  const compGoals = getCompGoals(compId);
  editForm.innerHTML = `
    <div class="admin-form-field-offset">
      <label class="field-label">NAME *</label>
      <input type="text" id="comp-edit-name" class="log-input admin-form-input-spaced" value="${escapeHtml(comp.name)}" placeholder="e.g.OIS Competition" />
    </div>
    <div class="log-fields admin-form-fields-spaced">
      <div class="log-field-wrap">
        <label class="field-label" for="comp-edit-startDate">START DATE *</label>
        <input type="date" id="comp-edit-startDate" class="log-input" value="${escapeHtml(comp.startDate || "")}" />
      </div>
      <div class="log-field-wrap">
        <label class="field-label" for="comp-edit-endDate">END DATE *</label>
        <input type="date" id="comp-edit-endDate" class="log-input" value="${escapeHtml(comp.endDate || "")}" />
      </div>
    </div>
    ${isCompEnded(comp) ? `
      <div class="admin-form-field-offset">
        <label class="field-label">WINNER</label>
        <div class="admin-readonly-field">${escapeHtml((comp.winner && state.employees[comp.winner]?.name) ? state.employees[comp.winner].name : "No winner set")}</div>
      </div>
    ` : ""}
    <div class="admin-form-field-offset">
      <label class="field-label">COMPETITION GOAL</label>
      <label class="goal-day-input-shell goal-admin-input-shell" for="goal-val-competition">
        <span class="goal-day-currency">$</span>
        <input type="number" id="goal-val-competition" class="log-input goal-day-input" placeholder="0" value="${compGoals.competition?.value || ""}" min="0" step="1" />
      </label>
    </div>
    <div class="admin-edit-actions">
      <button class="log-btn btn-ghost" id="admin-save-comp-edit-btn" disabled>SAVE ALL CHANGES</button>
      <button class="log-btn admin-danger-btn" id="admin-delete-comp-edit-btn">DELETE COMPETITION</button>
    </div>
  `;

  addChangeListener("comp-edit-name", comp.name);
  addChangeListener("comp-edit-startDate", comp.startDate || "");
  addChangeListener("comp-edit-endDate", comp.endDate || "");
  addChangeListener("goal-val-competition", compGoals.competition?.value || "", "numeric-goal");

  const startDateInput = editForm.querySelector("#comp-edit-startDate");
  const endDateInput = editForm.querySelector("#comp-edit-endDate");
  const updateDateRangeUI = () => {
    const startValue = startDateInput?.value || "";
    const endValue = endDateInput?.value || "";
    if (startDateInput) startDateInput.max = endValue || "";
    if (endDateInput) endDateInput.min = startValue || "";
  };
  startDateInput?.addEventListener("change", updateDateRangeUI);
  endDateInput?.addEventListener("change", updateDateRangeUI);
  startDateInput?.addEventListener("input", updateDateRangeUI);
  endDateInput?.addEventListener("input", updateDateRangeUI);
  updateDateRangeUI();

  saveAllBtn = editForm.querySelector("#admin-save-comp-edit-btn");
  saveAllBtn.onclick = async () => {
    await update(dbRef.comp(compId), {
      name: editForm.querySelector("#comp-edit-name").value.trim() || comp.name,
      startDate: editForm.querySelector("#comp-edit-startDate").value,
      endDate: editForm.querySelector("#comp-edit-endDate").value,
    });

    const compGoalValue = parseFloat(editForm.querySelector("#goal-val-competition").value);
    if (compGoalValue > 0) await set(ref(db, `goals/${compId}/competition`), { type: "total", value: compGoalValue });
    else await remove(ref(db, `goals/${compId}/competition`));

    showToast("All changes saved ✅");
    onDone?.();
  };

  editForm.querySelector("#admin-delete-comp-edit-btn").onclick = async () => {
    const confirmed = await showAppConfirm({
      title: "Delete Competition",
      message: `Delete "${comp.name}"? It will be kept in Recently Deleted for 7 days and can be restored.`,
      confirmLabel: "Delete Competition",
      confirmClassName: "log-btn admin-danger-btn",
    });
    if (!confirmed) return;
    const snapshot = {
      comp: { ...comp },
      logs: state.logs[compId] || null,
      goals: state.goals[compId] || null,
      deletedAt: Date.now(),
    };
    await set(dbRef.deletedComp(compId), snapshot);
    await remove(dbRef.comp(compId));
    await remove(ref(db, `logs/${compId}`));
    await remove(ref(db, `goals/${compId}`));
    delete state.logs[compId];
    showToast("Competition moved to Recently Deleted");
    onDone?.();
  };

  updateSaveButtonState();
}

function renderCompEditPanel(compId, comp) {
  const content = document.getElementById("admin-tab-content");
  const contentParent = content?.parentElement;
  let topBackBtn = document.getElementById("admin-back-top");
  if (!topBackBtn && contentParent) {
    topBackBtn = document.createElement("button");
    topBackBtn.id = "admin-back-top";
    topBackBtn.type = "button";
    topBackBtn.className = "app-back-btn admin-back-top hidden";
    contentParent.insertBefore(topBackBtn, content);
  }
  if (topBackBtn) {
    topBackBtn.textContent = "← Back";
    topBackBtn.classList.remove("hidden");
    topBackBtn.onclick = () => {
      state.admin.tab = "competitions";
      renderAdminTabBar();
      renderAdminTab();
    };
  }
  content.innerHTML = "";

  const title = document.createElement("div");
  title.className = "admin-section-title";
  title.style.margin = "12px 0";
  title.textContent = `EDITING: ${comp.name}`;
  content.appendChild(title);

  const editShell = document.createElement("div");
  editShell.className = "admin-edit-shell";
  content.appendChild(editShell);

  const editForm = document.createElement("div");
  editForm.className = "goal-admin-block admin-new-comp-form admin-edit-comp-form";
  editShell.appendChild(editForm);

  const changedFields = {};
  let saveAllBtn = null;

  const normalizeStringValue = (value) => String(value ?? "");
  const normalizeNumericGoalValue = (value) => {
    const num = Number.parseFloat(String(value ?? "").trim());
    if (!Number.isFinite(num) || num <= 0) return "";
    return String(num);
  };

  const getHighlightTarget = (el) => (
    el?.closest(".goal-day-input-shell") ||
    el?.closest(".admin-form-field-offset") ||
    el?.closest(".log-field-wrap") ||
    el
  );

  const updateSaveButtonState = () => {
    if (!saveAllBtn) return;
    const isDirty = Object.keys(changedFields).length > 0;
    saveAllBtn.disabled = !isDirty;
    saveAllBtn.classList.toggle("btn-ghost", !isDirty);
  };

  const highlightField = (id) => {
    const el = document.getElementById(id);
    const target = getHighlightTarget(el);
    target?.classList.toggle("admin-field-changed", !!changedFields[id]);
    updateSaveButtonState();
  };

  const addChangeListener = (id, originalValue, compare = "string") => {
    const el = document.getElementById(id);
    if (!el) return;
    const checkChange = () => {
      const currentValue = el.value;
      const normalizedCurrent = compare === "numeric-goal"
        ? normalizeNumericGoalValue(currentValue)
        : normalizeStringValue(currentValue);
      const normalizedOriginal = compare === "numeric-goal"
        ? normalizeNumericGoalValue(originalValue)
        : normalizeStringValue(originalValue);

      if (normalizedCurrent !== normalizedOriginal) {
        changedFields[id] = true;
      } else {
        delete changedFields[id];
      }
      highlightField(id);
    };
    el.addEventListener("input", checkChange);
    el.addEventListener("change", checkChange);
  };

  const nameWrap = document.createElement("div");
  nameWrap.className = "admin-form-field-offset";
  nameWrap.innerHTML = `<label class="field-label">NAME *</label><input type="text" id="comp-edit-name" class="log-input admin-form-input-spaced" value="${escapeHtml(comp.name)}" placeholder="e.g.OIS Competition" />`;
  editForm.appendChild(nameWrap);
  addChangeListener("comp-edit-name", comp.name);

  const dateRangeWrap = document.createElement("div");
  dateRangeWrap.className = "log-fields admin-form-fields-spaced";
  dateRangeWrap.innerHTML = `
      <div class="log-field-wrap">
        <label class="field-label" for="comp-edit-startDate">START DATE *</label>
        <input type="date" id="comp-edit-startDate" class="log-input" value="${escapeHtml(comp.startDate || "")}" />
      </div>
      <div class="log-field-wrap">
        <label class="field-label" for="comp-edit-endDate">END DATE *</label>
        <input type="date" id="comp-edit-endDate" class="log-input" value="${escapeHtml(comp.endDate || "")}" />
      </div>
  `;
  editForm.appendChild(dateRangeWrap);
  addChangeListener("comp-edit-startDate", comp.startDate || "");
  addChangeListener("comp-edit-endDate", comp.endDate || "");

  const startDateInput = document.getElementById("comp-edit-startDate");
  const endDateInput = document.getElementById("comp-edit-endDate");
  const updateDateRangeUI = () => {
    const startValue = startDateInput?.value || "";
    const endValue = endDateInput?.value || "";
    if (startDateInput) startDateInput.max = endValue || "";
    if (endDateInput) endDateInput.min = startValue || "";
  };
  startDateInput?.addEventListener("change", updateDateRangeUI);
  endDateInput?.addEventListener("change", updateDateRangeUI);
  startDateInput?.addEventListener("input", updateDateRangeUI);
  endDateInput?.addEventListener("input", updateDateRangeUI);
  updateDateRangeUI();

  if (isCompEnded(comp)) {
    const winnerDisplayText = (comp.winner && state.employees[comp.winner]?.name)
      ? state.employees[comp.winner].name
      : "No winner set";

    const winnerWrap = document.createElement("div");
    winnerWrap.className = "admin-form-field-offset";
    winnerWrap.innerHTML = `
      <label class="field-label">WINNER</label>
      <div class="admin-readonly-field">${escapeHtml(winnerDisplayText)}</div>
    `;
    editForm.appendChild(winnerWrap);
  }

  const compGoals = getCompGoals(compId);

  // Competition Total Goal
  const compGoalSection = document.createElement("div");
  compGoalSection.className = "admin-form-field-offset";
  compGoalSection.innerHTML = `
    <label class="field-label">COMPETITION GOAL</label>
    <label class="goal-day-input-shell goal-admin-input-shell" for="goal-val-competition">
      <span class="goal-day-currency">$</span>
      <input type="number" id="goal-val-competition" class="log-input goal-day-input" placeholder="0" value="${compGoals.competition?.value || ""}" min="0" step="1" />
    </label>
  `;
  editForm.appendChild(compGoalSection);
  addChangeListener("goal-val-competition", compGoals.competition?.value || "", "numeric-goal");

  // ═══ Save All Button ═══
  saveAllBtn = makeBtn("SAVE ALL CHANGES", "log-btn btn-ghost", async () => {
    // Save competition details
    await update(dbRef.comp(compId), {
      name: document.getElementById("comp-edit-name").value.trim() || comp.name,
      startDate: document.getElementById("comp-edit-startDate").value,
      endDate: document.getElementById("comp-edit-endDate").value,
    });

    // Save competition goal
    const compGoalValue = parseFloat(document.getElementById("goal-val-competition").value);
    if (compGoalValue > 0) {
      await set(ref(db, `goals/${compId}/competition`), { type: "total", value: compGoalValue });
    } else {
      await remove(ref(db, `goals/${compId}/competition`));
    }

    showToast("All changes saved ✅");
    state.admin.tab = "competitions"; renderAdminTabBar(); renderAdminTab();
  });
  const actionsWrap = document.createElement("div");
  actionsWrap.className = "admin-edit-actions";
  editForm.appendChild(actionsWrap);
  actionsWrap.appendChild(saveAllBtn);

  const delBtn = makeBtn("DELETE COMPETITION", "log-btn admin-danger-btn", async () => {
    const confirmed = await showAppConfirm({
      title: "Delete Competition",
      message: `Delete "${comp.name}"? It will be kept in Recently Deleted for 7 days and can be restored.`,
      confirmLabel: "Delete Competition",
      confirmClassName: "log-btn admin-danger-btn",
    });
    if (!confirmed) return;
    const snapshot = {
      comp: { ...comp },
      logs: state.logs[compId] || null,
      goals: state.goals[compId] || null,
      deletedAt: Date.now(),
    };
    await set(dbRef.deletedComp(compId), snapshot);
    await remove(dbRef.comp(compId));
    await remove(ref(db, `logs/${compId}`));
    await remove(ref(db, `goals/${compId}`));
    delete state.logs[compId];
    showToast("Competition moved to Recently Deleted");
    state.admin.tab = "competitions"; renderAdminTabBar(); renderAdminTab();
  });
  actionsWrap.appendChild(delBtn);
  updateSaveButtonState();
}

// ══════════════════════════════════════════════════════
// ADMIN — Employees
// ══════════════════════════════════════════════════════

function renderAdminEmpsList() {
  const listContainer = document.getElementById("admin-emp-list-container");
  if (!listContainer) return;

  const search = state.admin.empSearch.toLowerCase();
  const allActive = Object.entries(state.employees)
    .filter(([, emp]) => !emp.inactive)
    .sort(([, a], [, b]) => a.name.localeCompare(b.name));
  const allPast = Object.entries(state.employees)
    .filter(([, emp]) => emp.inactive)
    .sort(([, a], [, b]) => a.name.localeCompare(b.name));

  const filtered = search ? allActive.filter(([, emp]) => emp.name.toLowerCase().includes(search)) : allActive;
  const toShow = state.admin.showAllEmps ? filtered : filtered.slice(0, PREVIEW_COUNT);

  listContainer.innerHTML = "";
  const list = document.createElement("div");
  list.className = "admin-list admin-emp-list";

  if (toShow.length === 0) {
    list.innerHTML = `<div class="ui-empty-state admin-list-empty-state">No employees found</div>`;
  } else {
    toShow.forEach(([id, emp]) => {
      const item = document.createElement("div");
      item.className = "admin-item admin-emp-item";
      item.id = `admin-emp-item-${id}`;

      const leftPart = document.createElement("div");
      leftPart.className = "admin-item-left";
      leftPart.innerHTML = `${getAvatarHtml(emp, "small", id)} <span class="admin-item-name">${escapeHtml(emp.name)}</span>`;
      item.appendChild(leftPart);

      const rightPart = document.createElement("div");
      rightPart.className = "admin-item-actions";
      rightPart.appendChild(makeBtn("Edit", "del-btn", () => openEditEmpModal(id, emp)));
      rightPart.appendChild(makeBtn("✕", "del-btn danger", async () => {
        if (confirm(`Remove "${emp.name}"? They'll move to Past Players.`)) {
          await update(dbRef.emp(id), { inactive: true, removedAt: Date.now() });
        }
      }));
      item.appendChild(rightPart);

      list.appendChild(item);
    });
  }
  listContainer.appendChild(list);

  if (filtered.length > PREVIEW_COUNT) {
    listContainer.appendChild(makeBtn(
      state.admin.showAllEmps ? "Show less ▲" : `View all ${filtered.length} employees ▼`,
      "view-all-btn",
      () => { state.admin.showAllEmps = !state.admin.showAllEmps; renderAdminEmpsList(); }
    ));
  }

  // Past Players section
  if (allPast.length > 0) {
    const pastSection = document.createElement("div");
    pastSection.className = "goal-admin-block admin-past-emps-section";

    const pastToggle = document.createElement("button");
    pastToggle.className = "collapsible-toggle";
    pastToggle.innerHTML = `👤 PAST PLAYERS (${allPast.length}) <span class="collapsible-toggle-icon">▼</span>`;

    const pastContent = document.createElement("div");
    pastContent.style.display = "none";

    const pastList = document.createElement("div");
    pastList.className = "admin-list admin-emp-list";
    allPast.forEach(([id, emp]) => {
      const item = document.createElement("div");
      item.className = "admin-item admin-emp-item";

      const leftPart = document.createElement("div");
      leftPart.className = "admin-item-left";
      leftPart.innerHTML = `${getAvatarHtml(emp, "small", id)} <span class="admin-item-name">${escapeHtml(emp.name)}</span>`;
      item.appendChild(leftPart);

      const rightPart = document.createElement("div");
      rightPart.className = "admin-item-actions";
      rightPart.appendChild(makeBtn("Restore", "del-btn", async () => {
        await update(dbRef.emp(id), { inactive: false, removedAt: null });
      }));
      item.appendChild(rightPart);

      pastList.appendChild(item);
    });

    pastContent.appendChild(pastList);
    pastSection.appendChild(pastToggle);
    pastSection.appendChild(pastContent);
    listContainer.appendChild(pastSection);

    pastToggle.onclick = () => {
      const isHidden = pastContent.style.display === "none";
      pastContent.style.display = isHidden ? "block" : "none";
      pastToggle.classList.toggle("expanded", isHidden);
    };
  }
}

function renderAdminEmps(container) {
  container.innerHTML = `<div class="admin-section-title">MANAGE PLAYERS</div>`;
  const employeeCount = Object.values(state.employees || {}).filter(e => !e.inactive).length;

  const toolsWrap = document.createElement("div");
  toolsWrap.className = "admin-team-tools";
  toolsWrap.innerHTML = `
    <div class="admin-team-tools-header">
      <div class="admin-team-tools-title-row">
        <div class="admin-team-tools-title">Players</div>
        <div class="admin-team-tools-count">${employeeCount} active</div>
      </div>
    </div>
    <div class="admin-team-controls">
      <label class="admin-team-field admin-team-search-wrap">
        <span class="admin-team-field-label">Search players</span>
        <div class="admin-team-input-shell">
          <input type="text" id="admin-emp-search" class="log-input admin-team-input" placeholder="Search..." />
        </div>
      </label>
      <label class="admin-team-field admin-team-add-wrap">
        <span class="admin-team-field-label">Quick add</span>
        <div class="admin-new-row admin-new-row-top">
          <input type="text" id="input-new-emp" class="log-input admin-team-input" placeholder="Add a new player..." oninput="updateBtnState('input-new-emp','btn-add-emp')" />
          <button class="mini-btn btn-ghost" id="btn-add-emp" disabled>Add</button>
        </div>
      </label>
    </div>
  `;
  container.appendChild(toolsWrap);

  const searchInput = document.getElementById("admin-emp-search");
  searchInput.value = state.admin.empSearch;
  searchInput.oninput = (e) => {
    state.admin.empSearch = e.target.value;
    state.admin.showAllEmps = false;
    renderAdminEmpsList();
  };

  // Create container for list (will be updated by renderAdminEmpsList)
  const listContainer = document.createElement("div");
  listContainer.id = "admin-emp-list-container";
  container.appendChild(listContainer);
  
  // Render the list
  renderAdminEmpsList();
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

// ══════════════════════════════════════════════════════
// ADMIN — Edit Players Modal
// ══════════════════════════════════════════════════════

// Employees can only edit their own avatar
function openEditAvatarModal(empId, emp) {
  let modal = document.getElementById("edit-avatar-employee-modal");
  if (!modal) {
    modal = document.createElement("div");
    modal.id = "edit-avatar-employee-modal";
    modal.className = "admin-edit-emp-modal";
    document.body.appendChild(modal);
    modal.addEventListener("click", (e) => {
      if (e.target === modal) closeEditAvatarModal();
    });
  }

  const isCustomAvatar = emp.avatar && emp.avatar.startsWith("data:");

  modal.innerHTML = `
    <div class="admin-edit-emp-modal-content">
      <div class="admin-edit-emp-modal-header">
        <div>Edit Your Avatar</div>
        <button class="admin-edit-emp-modal-close">✕</button>
      </div>

      <div class="admin-edit-emp-avatar-section">
        <div id="edit-avatar-preview" class="admin-edit-emp-avatar-large">
          ${getAvatarHtml(emp, "large", empId)}
        </div>
        <div class="avatar-upload">
          <input type="file" id="edit-avatar-file-input" accept="image/*" />
          <button class="avatar-upload-btn">📸 Upload Photo</button>
        </div>
        ${isCustomAvatar ? `<button class="mini-btn del-btn danger">Remove Avatar</button>` : ""}
      </div>

      <div class="admin-btn-row">
        <button class="log-btn" id="avatar-save-btn">SAVE AVATAR</button>
        <button class="btn-secondary" id="avatar-cancel-btn">CANCEL</button>
      </div>
    </div>
  `;

  modal.classList.add("active");

  // Close button handler
  modal.querySelector(".admin-edit-emp-modal-close").onclick = closeEditAvatarModal;

  // Upload button
  const uploadBtn = modal.querySelector(".avatar-upload-btn");
  const fileInput = modal.querySelector("#edit-avatar-file-input");
  uploadBtn.onclick = () => fileInput.click();

  // File input change
  fileInput.onchange = async (e) => {
    const file = e.target.files[0];
    if (!file) return;
    if (file.size > 5000000) { showToast("Image too large (max 5MB)"); return; }
    const base64 = await fileToBase64(file);
    const preview = modal.querySelector("#edit-avatar-preview");
    preview.innerHTML = `<div class="avatar avatar-large"><img class="avatar-img" src="${base64}" alt="preview" /></div>`;
    window.editAvatarData = base64;
  };

  // Remove avatar button
  const removeBtn = modal.querySelector(".mini-btn.del-btn.danger");
  if (removeBtn) {
    removeBtn.onclick = () => {
      if (confirm("Remove your avatar?")) {
        window.editAvatarData = null;
        const preview = modal.querySelector("#edit-avatar-preview");
        if (preview) preview.innerHTML = `<div class="avatar avatar-large">${getAvatarPlaceholder(empId)}</div>`;
      }
    };
  }

  // Save button
  modal.querySelector("#avatar-save-btn").onclick = async () => {
    if (window.editAvatarData === undefined) {
      closeEditAvatarModal();
      return;
    }
    await update(dbRef.emp(empId), { avatar: window.editAvatarData || null });
    showToast("Avatar updated ✅");
    closeEditAvatarModal();
    const updatedEmp = state.employees[empId];
    if (updatedEmp && state.currentUser === empId) {
      showSelectedEmployeeProfile(empId, updatedEmp);
    }
  };

  // Cancel button
  modal.querySelector("#avatar-cancel-btn").onclick = closeEditAvatarModal;
}

function closeEditAvatarModal() {
  const modal = document.getElementById("edit-avatar-employee-modal");
  if (modal) modal.classList.remove("active");
  window.editAvatarData = undefined;
}

// Managers can edit both name and avatar
function openEditEmpModal(empId, emp) {
  let modal = document.getElementById("admin-edit-emp-modal");
  if (!modal) {
    modal = document.createElement("div");
    modal.id = "admin-edit-emp-modal";
    modal.className = "admin-edit-emp-modal";
    document.body.appendChild(modal);
    modal.addEventListener("click", (e) => {
      if (e.target === modal) closeEditEmpModal();
    });
  }

  const isCustomAvatar = emp.avatar && emp.avatar.startsWith("data:");

  modal.innerHTML = `
    <div class="admin-edit-emp-modal-content">
      <div class="admin-edit-emp-modal-header">
        <div>Edit Employee</div>
        <button class="admin-edit-emp-modal-close">✕</button>
      </div>

      <div class="admin-edit-emp-section">
        <label class="field-label">NAME</label>
        <input type="text" id="edit-emp-name" class="log-input" value="${escapeHtml(emp.name)}" placeholder="Employee name" />
      </div>

      <div class="admin-edit-emp-avatar-section">
        <div id="edit-emp-avatar-preview" class="admin-edit-emp-avatar-large">
          ${getAvatarHtml(emp, "large", empId)}
        </div>
        <div class="avatar-upload">
          <input type="file" id="edit-emp-avatar-input" accept="image/*" />
          <button class="avatar-upload-btn">📸 Upload Photo</button>
        </div>
        ${isCustomAvatar ? `<button class="mini-btn del-btn danger">Remove Avatar</button>` : ""}
      </div>

      <div class="admin-btn-row">
        <button class="log-btn" id="emp-save-btn">SAVE CHANGES</button>
        <button class="btn-secondary" id="emp-cancel-btn">CANCEL</button>
      </div>
    </div>
  `;

  modal.classList.add("active");

  // Close button handler
  modal.querySelector(".admin-edit-emp-modal-close").onclick = closeEditEmpModal;

  // Upload button
  const uploadBtn = modal.querySelector(".avatar-upload-btn");
  const fileInput = modal.querySelector("#edit-emp-avatar-input");
  uploadBtn.onclick = () => fileInput.click();

  // File input change
  fileInput.onchange = async (e) => {
    const file = e.target.files[0];
    if (!file) return;
    if (file.size > 5000000) { showToast("Image too large (max 5MB)"); return; }
    const base64 = await fileToBase64(file);
    const preview = modal.querySelector("#edit-emp-avatar-preview");
    preview.innerHTML = `<div class="avatar avatar-large"><img class="avatar-img" src="${base64}" alt="preview" /></div>`;
    window.editEmpAvatarData = base64;
  };

  // Remove avatar button
  const removeBtn = modal.querySelector(".mini-btn.del-btn.danger");
  if (removeBtn) {
    removeBtn.onclick = () => {
      if (confirm("Remove avatar for this employee?")) {
        window.editEmpAvatarData = null;
        const preview = modal.querySelector("#edit-emp-avatar-preview");
        if (preview) preview.innerHTML = `<div class="avatar avatar-large">${getAvatarPlaceholder(empId)}</div>`;
      }
    };
  }

  // Save button
  modal.querySelector("#emp-save-btn").onclick = async () => {
    const newName = modal.querySelector("#edit-emp-name").value.trim();
    if (!newName) { showToast("Enter a name"); return; }

    const updates = { name: newName };
    if (window.editEmpAvatarData !== undefined) {
      updates.avatar = window.editEmpAvatarData || null;
    }

    await update(dbRef.emp(empId), updates);
    showToast("Employee updated ✅");
    closeEditEmpModal();

    const updatedEmp = state.employees[empId];
    if (updatedEmp && state.currentUser === empId) {
      showSelectedEmployeeProfile(empId, updatedEmp);
    }

    renderAdminTab();
  };

  // Cancel button
  modal.querySelector("#emp-cancel-btn").onclick = closeEditEmpModal;
}

function closeEditEmpModal() {
  const modal = document.getElementById("admin-edit-emp-modal");
  if (modal) modal.classList.remove("active");
  window.editEmpAvatarData = undefined;
}

function inlineRenameEmp(empId, currentName) {
  openEditEmpModal(empId, state.employees[empId]);
}

// ══════════════════════════════════════════════════════
// ADMIN — Orders
// ══════════════════════════════════════════════════════
function renderAdminLogs(container) {
  // Default selected date to today
  if (!state.admin.selectedDate) state.admin.selectedDate = getTodayDate();
  if (!state.admin.selectedComp) state.admin.selectedComp = state.currentComp || Object.keys(state.competitions)[0] || null;
  container.innerHTML = `<div class="admin-section-title">MANAGE ORDERS</div>`;

  const compWrap = document.createElement("div");
  compWrap.style.marginBottom = "10px";
  compWrap.innerHTML = `<label class="field-label">COMPETITION</label>`;
  const compSel = document.createElement("select");
  compSel.className = "log-input"; compSel.id = "admin-logs-comp";
  compSel.innerHTML = `<option value="" disabled>— Select competition —</option>`;
  Object.entries(state.competitions).forEach(([id, comp]) => {
    const opt = document.createElement("option");
    opt.value = id; opt.textContent = comp.name;
    if (id === (state.admin.selectedComp || state.currentComp)) opt.selected = true;
    compSel.appendChild(opt);
  });
  compSel.onchange = () => {
    state.admin.selectedComp = compSel.value;
    state.admin.selectedEmp = null;
    refreshAdminDayView();
  };
  compWrap.appendChild(compSel);
  container.appendChild(compWrap);

  const dayLabel = document.createElement("label");
  dayLabel.className = "field-label"; dayLabel.style.marginBottom = "8px"; dayLabel.textContent = "WEEK";
  container.appendChild(dayLabel);
  const daysContainer = document.createElement("div");
  daysContainer.className = "admin-day-buttons"; daysContainer.id = "admin-logs-days";
  container.appendChild(daysContainer);

  const playerDayWrap = document.createElement("div");
  playerDayWrap.className = "admin-log-player-wrap";
  playerDayWrap.innerHTML = `
    <div class="admin-log-player-header">
      <div class="admin-log-player-title">PLAYERS FOR DAY</div>
    </div>
    <div class="admin-log-player-status" id="admin-logs-player-status"></div>
    <div class="admin-log-player-list" id="admin-logs-player-list"></div>
  `;
  container.appendChild(playerDayWrap);

  refreshAdminDayView();
}

function refreshAdminDayView() {
  const compId = state.admin.selectedComp || state.currentComp;
  const dayContainer = document.getElementById("admin-logs-days");
  const playerList = document.getElementById("admin-logs-player-list");
  const playerStatus = document.getElementById("admin-logs-player-status");
  if (!dayContainer || !playerList || !playerStatus) return;

  const comp = state.competitions[compId];
  if (!comp) {
    dayContainer.innerHTML = "";
    playerList.innerHTML = `<div class="admin-log-empty-state">Select a competition to manage its logs</div>`;
    playerStatus.textContent = "";
    return;
  }

  const clampCompetitionDate = (dateStr) => {
    if (!dateStr) return comp.startDate || comp.endDate || getTodayDate();
    if (comp.startDate && dateStr < comp.startDate) return comp.startDate;
    if (comp.endDate && dateStr > comp.endDate) return comp.endDate;
    return dateStr;
  };
  state.admin.selectedDate = clampCompetitionDate(state.admin.selectedDate);
  const week = getWeekForDate(state.admin.selectedDate);

  dayContainer.innerHTML = `<button class="week-nav-btn" id="admin-prev-week-btn">←</button>`;

  week.days.forEach(dayInfo => {
    const logsForDay = Object.values((state.logs[compId] || {})).filter(empLogs => !!empLogs?.[dayInfo.date]);
    const hasLog = logsForDay.length > 0;
    const isFutureDate = dayInfo.date > getTodayDate();
    const isOutOfComp = (comp.startDate && dayInfo.date < comp.startDate) || (comp.endDate && dayInfo.date > comp.endDate);
    const btn = document.createElement("button");
    const isSelected = state.admin.selectedDate === dayInfo.date;
    const classes = ["day-btn"];
    if (isSelected) classes.push("active");
    if (hasLog) classes.push("logged");
    if (isFutureDate || isOutOfComp) classes.push("disabled");
    btn.className = classes.join(" ");
    btn.innerHTML = `<div class="day-btn-dayname">${dayInfo.dayName}</div><div class="day-btn-date">${dayInfo.dayNum}</div>`;
    btn.title = hasLog ? `${logsForDay.length} order${logsForDay.length === 1 ? "" : "s"} on this day` : "No orders on this day";
    if (!isFutureDate && !isOutOfComp) {
      btn.onclick = () => {
        state.admin.selectedDate = dayInfo.date;
        state.admin.selectedEmp = null;
        refreshAdminDayView();
      };
    } else {
      btn.disabled = true;
      btn.onclick = () => showToast(isOutOfComp ? "That day is outside this competition" : "Can't log future dates 🔮");
    }
    dayContainer.appendChild(btn);
  });

  dayContainer.appendChild(makeBtn("→", "week-nav-btn", () => {
    state.admin.selectedDate = clampCompetitionDate(nextWeek(state.admin.selectedDate));
    state.admin.selectedEmp = null;
    refreshAdminDayView();
  }));
  document.getElementById("admin-prev-week-btn").onclick = () => {
    state.admin.selectedDate = clampCompetitionDate(prevWeek(state.admin.selectedDate));
    state.admin.selectedEmp = null;
    refreshAdminDayView();
  };

  const autoBtnIndex = week.days.findIndex(d => d.date === state.admin.selectedDate) + 1;
  const autoBtn = dayContainer.children[autoBtnIndex];
  if (autoBtn) autoBtn.classList.add("active");

  const selectedDate = state.admin.selectedDate;
  const playersForDay = Object.entries(state.employees)
    .sort(([, a], [, b]) => a.name.localeCompare(b.name))
    .map(([id, emp]) => {
      const log = (state.logs[compId] || {})[id]?.[selectedDate] || null;
      return { id, emp, log };
    });
  const loggedCount = playersForDay.filter(p => p.log).length;
  playerStatus.textContent = loggedCount === 0 ? "No players logged" : "";

  if (!playersForDay.length) {
    playerList.innerHTML = `<div class="admin-log-empty-state">No players found for this day</div>`;
    playerStatus.textContent = "";
    return;
  }

  if (!playersForDay.some(p => p.id === state.admin.selectedEmp)) {
    state.admin.selectedEmp = null;
  }

  const loggedPlayers = playersForDay.filter(p => p.log);
  const unloggedPlayers = playersForDay.filter(p => !p.log);
  playerList.innerHTML = "";
  const renderPlayerCard = ({ id, emp, log }) => {
    const wrap = document.createElement("div");
    wrap.className = `admin-log-player-card-wrap${state.admin.selectedEmp === id ? " active" : ""}`;

    const btn = document.createElement("button");
    btn.type = "button";
    btn.className = `admin-log-player-card${log ? " has-log" : ""}${state.admin.selectedEmp === id ? " active" : ""}`;
    btn.innerHTML = `
      <div class="admin-log-player-main">
        <div class="admin-log-player-name">${escapeHtml(emp.name)}</div>
        <div class="admin-log-player-meta">${log ? `$${log.sales.toFixed(2)} · ${log.hours.toFixed(1)} hrs` : "No log yet"}</div>
      </div>
      ${state.admin.selectedEmp === id ? '<div class="admin-log-player-badge close">Close</div>' : (log ? '<div class="admin-log-player-badge edit">Edit</div>' : '<div class="admin-log-player-badge open">Add</div>')}
    `;
    btn.onclick = () => {
      state.admin.selectedEmp = state.admin.selectedEmp === id ? null : id;
      refreshAdminDayView();
      if (state.admin.selectedEmp) {
        requestAnimationFrame(() => {
          document.querySelector(".admin-log-player-card-wrap.active")?.scrollIntoView({ behavior: "smooth", block: "nearest" });
        });
      }
    };
    wrap.appendChild(btn);

    if (state.admin.selectedEmp === id) {
      const inlineDetail = document.createElement("div");
      inlineDetail.className = "admin-log-inline-detail";
      wrap.appendChild(inlineDetail);
      if (log) renderAdminLogEdit(id, compId, selectedDate, log, inlineDetail);
      else renderAdminLogCreate(id, compId, selectedDate, inlineDetail);
    }

    return wrap;
  };

  if (loggedPlayers.length) {
    const loggedSection = document.createElement("div");
    loggedSection.className = "admin-log-player-section";
    loggedSection.innerHTML = `
      <div class="admin-log-player-section-header">
        <div class="admin-log-player-section-title">Orders Today</div>
        <div class="admin-log-player-section-count">${loggedPlayers.length}</div>
      </div>
    `;
    const loggedList = document.createElement("div");
    loggedList.className = "admin-log-player-list";
    loggedPlayers.forEach(player => loggedList.appendChild(renderPlayerCard(player)));
    loggedSection.appendChild(loggedList);
    playerList.appendChild(loggedSection);
  }

  if (unloggedPlayers.length) {
    const openSection = document.createElement("div");
    openSection.className = "admin-log-player-section";
    const openHeader = document.createElement("button");
    openHeader.type = "button";
    openHeader.className = `admin-log-player-toggle${state.admin.showUnloggedPlayers ? " expanded" : ""}`;
    openHeader.innerHTML = `
      <span class="admin-log-player-section-title">Other Players</span>
      <span class="admin-log-player-toggle-meta">${unloggedPlayers.length} more</span>
      <span class="admin-log-player-toggle-icon">${state.admin.showUnloggedPlayers ? "▲" : "▼"}</span>
    `;
    const openList = document.createElement("div");
    openList.className = `admin-log-player-list${state.admin.showUnloggedPlayers ? "" : " hidden"}`;
    unloggedPlayers.forEach(player => openList.appendChild(renderPlayerCard(player)));
    openHeader.onclick = () => {
      state.admin.showUnloggedPlayers = !state.admin.showUnloggedPlayers;
      refreshAdminDayView();
    };
    openSection.appendChild(openHeader);
    openSection.appendChild(openList);
    playerList.appendChild(openSection);
  }
}

function renderAdminLogDetail(empId, compId, date, log) {
  const detail = document.getElementById("admin-logs-detail");
  if (!detail) return;
  const sph = log.hours > 0 ? (log.sales / log.hours).toFixed(2) : "—";
  const d = new Date(date + "T00:00:00");
  const dayName = DAYS[d.getDay()];
  detail.innerHTML = `
    <div class="admin-log-header">
      <div class="admin-log-header-info">
        <div class="admin-log-header-name">${escapeHtml(state.employees[empId]?.name || "")}</div>
        <div class="admin-log-header-sub">${escapeHtml(`${dayName} ${date} · ${state.competitions[compId]?.name || ""}`)}</div>
      </div>
      <div class="admin-log-header-badge logged">Logged</div>
    </div>
    <div class="admin-log-stats">
      <div class="admin-log-stat"><div class="admin-log-stat-label">SALES</div><div class="admin-log-stat-value">$${log.sales.toFixed(2)}</div></div>
      <div class="admin-log-stat"><div class="admin-log-stat-label">HOURS</div><div class="admin-log-stat-value">${log.hours.toFixed(1)}</div></div>
      <div class="admin-log-stat accent"><div class="admin-log-stat-label">$/HR</div><div class="admin-log-stat-value">$${sph}</div></div>
    </div>
    <div class="admin-log-actions-row">
      <button class="admin-action-edit" id="admin-edit-log-btn">Edit</button>
      <button class="admin-action-delete" id="admin-delete-log-btn">🗑️ Delete</button>
    </div>
  `;
  document.getElementById("admin-edit-log-btn").onclick = () => renderAdminLogEdit(empId, compId, date, log);
  document.getElementById("admin-delete-log-btn").onclick = () => confirmAndDeleteAdminLog(empId, compId, date);
}

async function confirmAndDeleteAdminLog(empId, compId, date) {
  const empName = state.employees[empId]?.name || "this player";
  const confirmed = await showAppConfirm({
    title: "Delete Order",
    message: `Delete ${empName}'s order for ${date}?`,
    confirmLabel: "DELETE",
    confirmClassName: "log-btn admin-danger-btn",
  });
  if (!confirmed) return;

  await remove(dbRef.dateLog(compId, empId, date));
  removeLocalLog(compId, empId, date);
  state.admin.selectedEmp = null;
  showToast("Order deleted");
  refreshAdminDayView();
  if (state.currentUser === empId) { renderDash(); renderBoard(); renderAllTime(); }
}

function renderAdminLogCreate(empId, compId, date, target = null) {
  const detail = target || document.getElementById("admin-logs-detail");
  if (!detail) return;
  const d = new Date(date + "T00:00:00");
  const dayName = DAYS[d.getDay()];
  detail.innerHTML = `
    <div class="admin-log-header">
      <div class="admin-log-header-info">
        <div class="admin-log-header-name">${escapeHtml(state.employees[empId]?.name || "")}</div>
        <div class="admin-log-header-sub">${escapeHtml(`${dayName} ${date} · ${state.competitions[compId]?.name || ""}`)}</div>
      </div>
      <div class="admin-log-header-badge not-logged">✗ No Log Yet</div>
    </div>
    <div class="log-fields admin-log-form-fields">
      <div class="log-field-wrap"><label class="field-label">SALES ($)</label><input type="number" id="admin-create-sales" class="log-input" placeholder="0.00" min="0" step="0.01" /></div>
      <div class="log-field-wrap"><label class="field-label">HOURS</label><input type="number" id="admin-create-hours" class="log-input" placeholder="0.0" min="0" step="0.5" /></div>
    </div>
    <button class="log-btn btn-ghost admin-log-form-submit" id="admin-create-log-btn" disabled>+ CREATE LOG</button>
  `;
  const s = detail.querySelector("#admin-create-sales");
  const h = detail.querySelector("#admin-create-hours");
  const checkReady = () => {
    const ready = s.value.trim() !== "" && h.value.trim() !== "";
    const btn = detail.querySelector("#admin-create-log-btn");
    if (btn) { btn.disabled = !ready; btn.classList.toggle("btn-ghost", !ready); }
  };
  s.oninput = checkReady; h.oninput = checkReady;
  detail.querySelector("#admin-create-log-btn").onclick = async () => {
    const sales = parseFloat(s.value);
    const hours = parseFloat(h.value);
    if (isNaN(sales) || sales < 0) { showToast("Enter valid sales amount"); return; }
    if (isNaN(hours) || hours <= 0) { showToast("Enter hours worked"); return; }
    if (date > getTodayDate()) { showToast("Can't create logs for future dates 🔮"); return; }
    await set(dbRef.dateLog(compId, empId, date), { sales, hours });
    upsertLocalLog(compId, empId, date, { sales, hours });
    state.admin.selectedEmp = null;
    showToast("Log created ✅");
    refreshAdminDayView();
    if (state.currentUser === empId) { renderDash(); renderBoard(); renderAllTime(); }
  };
}

function renderAdminLogEdit(empId, compId, date, log, target = null) {
  const detail = target || document.getElementById("admin-logs-detail");
  if (!detail) return;
  detail.innerHTML = `
    <div class="log-fields admin-log-form-fields admin-log-edit-fields">
      <div class="log-field-wrap"><label class="field-label">SALES ($)</label><input type="number" id="admin-edit-sales" class="log-input" value="${log.sales}" min="0" step="0.01" /></div>
      <div class="log-field-wrap"><label class="field-label">HOURS</label><input type="number" id="admin-edit-hours" class="log-input" value="${log.hours}" min="0" step="0.5" /></div>
    </div>
    <div class="admin-btn-row admin-log-edit-actions">
      <button class="log-btn" id="admin-save-edit-btn">SAVE</button>
      <button class="admin-action-delete" id="admin-delete-edit-btn">DELETE</button>
    </div>
  `;
  detail.querySelector("#admin-save-edit-btn").onclick = async () => {
    const sales = parseFloat(detail.querySelector("#admin-edit-sales").value);
    const hours = parseFloat(detail.querySelector("#admin-edit-hours").value);
    if (isNaN(sales) || sales < 0) { showToast("Enter valid sales amount"); return; }
    if (isNaN(hours) || hours <= 0) { showToast("Enter hours worked"); return; }
    await set(dbRef.dateLog(compId, empId, date), { sales, hours });
    upsertLocalLog(compId, empId, date, { sales, hours });
    state.admin.selectedEmp = null;
    showToast("Log updated ✅");
    refreshAdminDayView();
    if (state.currentUser === empId) { renderDash(); renderBoard(); renderAllTime(); }
  };
  detail.querySelector("#admin-delete-edit-btn").onclick = async () => {
    await confirmAndDeleteAdminLog(empId, compId, date);
  };
}

// ══════════════════════════════════════════════════════
// Utility
// ══════════════════════════════════════════════════════

let toastTimer;
function showToast(msg, duration = 2200) {
  const toast = document.getElementById("toast");
  toast.textContent = msg;
  toast.classList.remove("hidden", "toast-exit");
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => {
    toast.classList.add("toast-exit");
    setTimeout(() => toast.classList.add("hidden"), 200);
  }, duration);
}

function showAppConfirm({
  title = "Confirm",
  message = "Are you sure?",
  confirmLabel = "Confirm",
  cancelLabel = "Cancel",
  confirmClassName = "log-btn",
} = {}) {
  return new Promise((resolve) => {
    const returnFocusEl = document.activeElement;
    let modal = document.getElementById("app-confirm-modal");
    if (!modal) {
      modal = document.createElement("div");
      modal.id = "app-confirm-modal";
      modal.className = "info-modal app-confirm-modal";
      document.body.appendChild(modal);
      modal.addEventListener("click", (e) => {
        if (e.target === modal) close(false);
      });
    }

    const close = (result) => {
      modal.classList.remove("active");
      setModalInert(false);
      focusElementSoon(returnFocusEl, { preventScroll: true });
      resolve(result);
    };

    modal.innerHTML = `
      <div class="info-modal-content app-confirm-content" role="dialog" aria-modal="true" aria-labelledby="app-confirm-title">
        <div class="info-modal-header app-confirm-header">
          <div class="info-modal-title app-confirm-title" id="app-confirm-title">${escapeHtml(title)}</div>
          <button class="info-modal-close app-confirm-close" type="button" aria-label="Close">✕</button>
        </div>
        <div class="info-modal-body app-confirm-body">
          <p class="app-confirm-message">${escapeHtml(message)}</p>
          <div class="app-confirm-actions">
            <button class="log-btn btn-ghost app-confirm-cancel" type="button">${escapeHtml(cancelLabel)}</button>
            <button class="${escapeHtml(confirmClassName)} app-confirm-confirm" type="button">${escapeHtml(confirmLabel)}</button>
          </div>
        </div>
      </div>
    `;

    modal.querySelector(".app-confirm-close")?.addEventListener("click", () => close(false));
    modal.querySelector(".app-confirm-cancel")?.addEventListener("click", () => close(false));
    modal.querySelector(".app-confirm-confirm")?.addEventListener("click", () => close(true));
    setModalInert(true);
    modal.classList.add("active");
    focusElementSoon(modal.querySelector(".app-confirm-cancel") || modal.querySelector(".app-confirm-confirm"), { preventScroll: true });
  });
}

function showAppAlert({
  title = "Notice",
  message = "",
  confirmLabel = "OK",
  confirmClassName = "log-btn",
} = {}) {
  return new Promise((resolve) => {
    const returnFocusEl = document.activeElement;
    let modal = document.getElementById("app-alert-modal");
    if (!modal) {
      modal = document.createElement("div");
      modal.id = "app-alert-modal";
      modal.className = "info-modal app-confirm-modal";
      document.body.appendChild(modal);
      modal.addEventListener("click", (e) => {
        if (e.target === modal) close();
      });
    }

    const close = () => {
      modal.classList.remove("active");
      setModalInert(false);
      focusElementSoon(returnFocusEl, { preventScroll: true });
      resolve(true);
    };

    modal.innerHTML = `
      <div class="info-modal-content app-confirm-content" role="dialog" aria-modal="true" aria-labelledby="app-alert-title">
        <div class="info-modal-header app-confirm-header">
          <div class="info-modal-title app-confirm-title" id="app-alert-title">${escapeHtml(title)}</div>
          <button class="info-modal-close app-confirm-close" type="button" aria-label="Close">✕</button>
        </div>
        <div class="info-modal-body app-confirm-body">
          <p class="app-confirm-message">${escapeHtml(message)}</p>
          <div class="app-confirm-actions">
            <button class="${escapeHtml(confirmClassName)} app-confirm-confirm" type="button">${escapeHtml(confirmLabel)}</button>
          </div>
        </div>
      </div>
    `;

    modal.querySelector(".app-confirm-close")?.addEventListener("click", close);
    modal.querySelector(".app-confirm-confirm")?.addEventListener("click", close);
    setModalInert(true);
    modal.classList.add("active");
    focusElementSoon(modal.querySelector(".app-confirm-confirm"), { preventScroll: true });
  });
}

function launchConfetti(intensity = 1) {
  const canvas = document.getElementById("confetti-canvas");
  const ctx = canvas.getContext("2d");
  canvas.width = window.innerWidth; canvas.height = window.innerHeight;
  const count = Math.round(18 + intensity * 82); // 18 pieces at min → 100 at max
  const pieces = Array.from({ length: count }, () => ({
    x: Math.random() * canvas.width, y: -20,
    r: Math.random() * (3 + intensity * 8) + 3,
    color: ["#1A6FF4","#4D9EFA","#60B5FF","#3FB950","#F5A623"][Math.floor(Math.random()*5)],
    vx: (Math.random() - 0.5) * (2 + intensity * 4),
    vy: Math.random() * (2 + intensity * 4) + 2,
    spin: Math.random() * 0.2 - 0.1, angle: 0, life: 1,
  }));
  const decay = 0.007 + (1 - intensity) * 0.008; // lighter = fades faster
  let frame;
  function draw() {
    ctx.clearRect(0, 0, canvas.width, canvas.height);
    let alive = false;
    pieces.forEach(p => {
      p.x += p.vx; p.y += p.vy; p.angle += p.spin; p.life -= decay;
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
// Info Modal
// ══════════════════════════════════════════════════════
function setModalInert(active) {
  [
    document.getElementById("main-content"),
    document.getElementById("app-header"),
    document.getElementById("bottom-nav"),
  ].forEach(el => {
    if (!el) return;
    if (active) el.setAttribute("inert", "");
    else el.removeAttribute("inert");
  });
}

let infoModalReturnFocusEl = null;
function openInfoModal(returnFocusEl = document.activeElement) {
  const modal = document.getElementById("info-modal");
  if (!modal) return;
  infoModalReturnFocusEl = returnFocusEl;
  setModalInert(true);
  modal.classList.add("active");
  focusElementSoon(document.getElementById("btn-close-info"), { preventScroll: true });
}

function closeInfoModal() {
  const modal = document.getElementById("info-modal");
  if (modal) modal.classList.remove("active");
  setModalInert(false);
  focusElementSoon(infoModalReturnFocusEl, { preventScroll: true });
  infoModalReturnFocusEl = null;
}
document.addEventListener("DOMContentLoaded", () => {
  // Start Firebase listeners immediately — they load all data in parallel over
  // a single WebSocket connection and re-render whenever data changes.
  startListeners();

  if (sessionStorage.getItem("adminUnlocked") === "1") state.adminUnlocked = true;

  // Show the welcome screen right away; data arrives in the background.
  showScreen(state.currentScreen);

  // Mobile touch press feedback — iOS/Android don't fire :active reliably.
  // A global touchstart/end handler adds .touching so every button responds instantly.
  document.addEventListener("touchstart", e => {
    e.target.closest("button")?.classList.add("touching");
  }, { passive: true });
  ["touchend", "touchcancel"].forEach(evt =>
    document.addEventListener(evt, e => {
      const btn = e.target.closest("button");
      if (btn) setTimeout(() => btn.classList.remove("touching"), 80);
    }, { passive: true })
  );

  // Boot sequence — auto-advances to pick screen after animation completes.
  // Tapping anywhere on the welcome screen skips immediately.
  function advanceFromBoot() {
    if (state.currentScreen !== "welcome") return;
    showScreen("pick");
    maybeShowCompetitionEndedModal({ force: true });
  }

  // Swap LOADING → READY when bar finishes filling (0.70s delay + 0.85s fill = 1.55s)
  setTimeout(() => {
    document.getElementById("boot-loading-text")?.style.setProperty("display", "none");
    const readyEl = document.getElementById("boot-ready-text");
    if (readyEl) readyEl.style.display = "inline";
  }, 1560);

  setTimeout(advanceFromBoot, 2100);

  // Tap anywhere to skip
  document.getElementById("screen-welcome")
    ?.addEventListener("click", advanceFromBoot, { once: true });

  const searchInput = document.getElementById("input-search-employees");
  if (searchInput) {
    searchInput.oninput = () => {
      clearTimeout(state.searchDebounceTimer);
      state.searchDebounceTimer = setTimeout(() => {
        renderPickScreen(searchInput.value);
      }, 150);
    };
  }

  // Admin lock button
  const adminLockBtn = document.getElementById("admin-lock-btn");
  if (adminLockBtn) {
    adminLockBtn.onclick = () => {
      state.adminUnlocked = false;
      sessionStorage.removeItem("adminUnlocked");
      document.getElementById("input-pin").value = "";
      document.getElementById("pin-error").classList.add("hidden");
      showScreen("admin-gate");
    };
  }

  // Success state buttons
  const successBoardBtn = document.getElementById("pick-success-board-btn");
  if (successBoardBtn) {
    successBoardBtn.onclick = () => { renderBoard(); showScreen("board"); };
  }
  const successResetBtn = document.getElementById("pick-success-reset-btn");
  if (successResetBtn) {
    successResetBtn.onclick = () => {
      resetPickEmployeeSelection();
    };
  }

  // Pick screen employee selector
  const empSelectorBtn = document.getElementById("pick-emp-selector");
  const empGrid = document.getElementById("pick-emp-grid");
  if (empSelectorBtn && empGrid) {
    empSelectorBtn.onclick = () => {
      const isOpening = empGrid.classList.contains("hidden");
      empGrid.classList.toggle("hidden");
      empSelectorBtn.classList.toggle("open", isOpening);
      if (isOpening) {
        renderPickEmpGrid();
      }
    };
    empSelectorBtn.onkeydown = (e) => {
      if (e.key === "ArrowDown") {
        e.preventDefault();
        if (empGrid.classList.contains("hidden")) empSelectorBtn.click();
        focusElementSoon(document.getElementById("pick-emp-search"), { preventScroll: true });
      }
    };
  }

  // Pick screen employee search
  const pickEmpSearch = document.getElementById("pick-emp-search");
  if (pickEmpSearch) {
    pickEmpSearch.oninput = () => {
      clearTimeout(state.searchDebounceTimer);
      state.searchDebounceTimer = setTimeout(() => {
        renderPickEmpGrid(pickEmpSearch.value);
      }, 150);
    };
  }

  // Pick screen log form input listeners
  const pickSalesInput = document.getElementById("pick-input-sales");
  const pickHoursInput = document.getElementById("pick-input-hours");
  if (pickSalesInput) pickSalesInput.oninput = updatePickLogBtnState;
  if (pickHoursInput) pickHoursInput.oninput = updatePickLogBtnState;
  if (pickSalesInput) {
    pickSalesInput.addEventListener("keydown", (e) => {
      if (e.key !== "Enter") return;
      e.preventDefault();
      focusElementSoon(pickHoursInput, { preventScroll: true });
    });
  }
  if (pickHoursInput) {
    pickHoursInput.addEventListener("keydown", (e) => {
      if (e.key !== "Enter") return;
      e.preventDefault();
      const logBtn = document.getElementById("pick-btn-log");
      if (logBtn && !logBtn.disabled) logBtn.click();
    });
  }

  // Pick screen log button
  document.getElementById("pick-btn-log").onclick = logEntryFromPick;

  // Bottom nav
  document.getElementById("nav-home").onclick = () => {
    showScreen("pick");
    maybeShowCompetitionEndedModal({ force: true });
  };
  document.getElementById("nav-board").onclick = () => { renderBoard(); showScreen("board"); };
  document.getElementById("nav-admin").onclick = () => {
    if (state.adminUnlocked) {
      openAdminPanel();
    } else {
      document.getElementById("input-pin").value = "";
      document.getElementById("pin-error").classList.add("hidden");
      showScreen("admin-gate");
    }
  };

  // Info modal
  const infoBtnBtn = document.getElementById("btn-info");
  const closeInfoBtn = document.getElementById("btn-close-info");
  const infoModal = document.getElementById("info-modal");

  if (infoBtnBtn) {
    infoBtnBtn.onclick = () => openInfoModal(infoBtnBtn);
  }
  if (closeInfoBtn) {
    closeInfoBtn.onclick = closeInfoModal;
  }
  if (infoModal) {
    infoModal.addEventListener("click", (e) => {
      if (e.target === infoModal) closeInfoModal();
    });
  }

  const endedModal = document.getElementById("competition-ended-modal");
  const endedModalClose = document.getElementById("competition-ended-close");
  if (endedModalClose) endedModalClose.onclick = closeCompetitionEndedModal;
  if (endedModal) {
    endedModal.addEventListener("click", (e) => {
      if (e.target === endedModal) closeCompetitionEndedModal();
    });
  }

  document.addEventListener("click", (e) => {
    const picker = document.getElementById("board-comp-picker");
    if (picker && !picker.contains(e.target)) closeBoardCompMenu();

    const empSelectorWrap = document.querySelector(".pick-emp-selector-wrap");
    const empGrid = document.getElementById("pick-emp-grid");
    if (
      empGrid &&
      !empGrid.classList.contains("hidden") &&
      !empGrid.contains(e.target) &&
      !empSelectorWrap?.contains(e.target)
    ) {
      closePickEmployeeGrid();
    }
  });

  document.addEventListener("keydown", (e) => {
    if (e.key === "Escape") {
      closeBoardCompMenu();
      closePickEmployeeGrid();
      closeInfoModal();
      closeCompetitionEndedModal();
    }
  });

  // PIN submit
  const pinInput = document.getElementById("input-pin");
  const pinSubmitBtn = document.getElementById("btn-pin-submit");
  if (!pinInput || !pinSubmitBtn) return;

  pinSubmitBtn.disabled = true;
  pinSubmitBtn.classList.add("btn-ghost");

  pinSubmitBtn.onclick = () => {
    if (pinInput.value.trim() === ADMIN_PIN) {
      state.adminUnlocked = true;
      sessionStorage.setItem("adminUnlocked", "1");
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

  pinInput.addEventListener("input", () => {
    const hasValue = pinInput.value.trim().length > 0;
    pinSubmitBtn.disabled = !hasValue;
    pinSubmitBtn.classList.toggle("btn-ghost", !hasValue);
  });

  pinInput.addEventListener("keydown", e => {
    if (e.key === "Enter" && !pinSubmitBtn.disabled) pinSubmitBtn.click();
  });

  const pinRevealBtn = document.getElementById("btn-pin-reveal");
  const eyeOpen = document.getElementById("icon-eye-open");
  const eyeClosed = document.getElementById("icon-eye-closed");
  if (pinRevealBtn) {
    pinRevealBtn.addEventListener("click", () => {
      const isPassword = pinInput.type === "password";
      pinInput.type = isPassword ? "text" : "password";
      eyeOpen.style.display = isPassword ? "none" : "";
      eyeClosed.style.display = isPassword ? "" : "none";
    });
  }
});
