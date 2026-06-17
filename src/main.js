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
// Tracks whether the user has actually tapped a day in step 2 — until they
// do, no day (including today) should appear pre-selected.
let _dayExplicitlySelected = false;

function tryAutoSelectPlayer() {
  if (_autoSelectAttempted || state.currentUser) return;
  if (Object.keys(state.players).length === 0) return;
  _autoSelectAttempted = true;
  const lastId = localStorage.getItem("lastPlayer");
  if (lastId && state.players[lastId] && !state.players[lastId].inactive) {
    enterAsDashboard(lastId);
  }
}

let state = {
  competitions: {},
  deletedCompetitions: {},
  players: {},
  logs: {},
  settings: {},
  goals: {},
  currentComp: null,      // active comp shown on pick screen
  boardComp: null,        // comp selected on leaderboard
  currentUser: null,
  dashView: "logging",
  profileReturnScreen: "board", // which screen the back button on a profile view returns to
  selectedDate: getTodayDate(),
  currentScreen: "welcome",
  adminUnlocked: false,
  searchDebounceTimer: null,
  endedRevealDismissedCompId: null,
  admin: {
    showAllComps: false,
    showAllPlayers: false,
    showUnloggedPlayers: false,
    selectedPlayer: null,
    selectedComp: null,
    editingCompId: null,
    selectedDate: getTodayDate(),
    playerSearch: "",
    tab: "competitions",
  },
};

// Firebase database shortcuts.
// Example: `dbRef.players()` points to the players collection in the database.
const dbRef = {
  comps:    ()              => ref(db, "competitions"),
  comp:     (id)            => ref(db, `competitions/${id}`),
  // Note: the DB path stays "employees" for backward compatibility with existing data.
  players:     ()              => ref(db, "employees"),
  player:      (id)            => ref(db, `employees/${id}`),
  logs:     ()              => ref(db, "logs"),
  compLogs: (cId)           => ref(db, `logs/${cId}`),
  dateLog:  (cId, pId, date) => ref(db, `logs/${cId}/${pId}/${date}`),
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
function upsertLocalLog(compId, playerId, date, log) {
  if (!compId || !playerId || !date) return;
  if (!state.logs[compId]) state.logs[compId] = {};
  if (!state.logs[compId][playerId]) state.logs[compId][playerId] = {};
  state.logs[compId][playerId][date] = log;
}

function removeLocalLog(compId, playerId, date) {
  if (!compId || !playerId || !date) return;
  const playerLogs = state.logs[compId]?.[playerId];
  if (!playerLogs) return;
  delete playerLogs[date];
  if (Object.keys(playerLogs).length === 0) delete state.logs[compId][playerId];
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

function closePickPlayerResults() {
  const results = document.getElementById("pick-player-results");
  if (!results || !results.classList.contains("has-results")) return;
  results.innerHTML = "";
  results.classList.remove("has-results");
}

// ══════════════════════════════════════════════════════
// Avatar helpers
// Example on the website: the player photo or letter icon shown beside names.
// ══════════════════════════════════════════════════════
function getAvatarPlaceholder(playerIdOrStr) {
  const str = (playerIdOrStr || "").toString().trim();
  if (!str) return "?";
  return str.charAt(0).toUpperCase();
}

function getAvatarHtml(player, size = "", playerId = "") {
  const sizeClass = size ? ` avatar-${size}` : "";
  const safeName = escapeHtml(player?.name || playerId || "Player");
  if (player.avatar && player.avatar.startsWith("data:image/")) {
    return `<div class="avatar${sizeClass}"><img class="avatar-img" src="${player.avatar}" alt="${safeName}" /></div>`;
  }
  const placeholder = getAvatarPlaceholder(player.name || playerId || player.id);
  return `<div class="avatar${sizeClass}"><span class="avatar-placeholder">${placeholder}</span></div>`;
}

function getBoardAvatarHtml(player, playerId, displayRank) {
  return `
    <div class="board-avatar-stack${displayRank === 1 ? " rank-1" : ""}">
      ${displayRank === 1 ? `<div class="board-avatar-crown"><img class="board-avatar-crown-icon" src="${CROWN_ICON_URL}" alt="Top player crown" /></div>` : ""}
      ${getAvatarHtml(player || { name: playerId }, "board", playerId)}
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

  onValue(dbRef.players(), snap => {
    state.players = snap.val() || {};
    scheduleRender("pick", renderPickScreen);
    if (state.currentUser) {
      scheduleRender("dash", renderDash);
      scheduleRender("board", renderBoard);
    }
    if (state.admin.tab === "players") scheduleRender("admin", renderAdminTab);
    if (state.admin.tab === "logs") scheduleRender("admin", renderAdminTab);
    _markReady("players");
  });

  onValue(dbRef.logs(), snap => {
    state.logs = snap.val() || {};
    scheduleRender("pick", renderPickScreen);
    if (state.currentUser) {
      scheduleRender("dash", renderDash);
      scheduleRender("board", renderBoard);
    }
    if (state.admin.tab === "logs" && state.admin.selectedPlayer) scheduleRender("adminDay", refreshAdminDayView);
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

function getPlayerSph(playerId, compId) {
  const logs = (state.logs[compId] || {})[playerId] || {};
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

  Object.values(compLogs).forEach(playerLogs => {
    Object.values(playerLogs || {}).forEach(log => {
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
  const winner = comp.winner ? state.players[comp.winner] : null;
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
    ${ended && winner ? `<p class="pick-winner-row" style="display:flex">★ <span>${escapeHtml(`${winner.name} won!`)}</span></p>` : ""}
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

  const compStart = state.competitions[state.currentComp]?.startDate;
  if (compStart && state.selectedDate < compStart) { showToast("Competition hadn't started on that date"); return; }

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
  setOisStep("success");
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
  const compStart = state.competitions[state.currentComp]?.startDate;
  week.days.forEach(dayInfo => {
    const hasEntry = myLogs[dayInfo.date] && (myLogs[dayInfo.date].sales > 0 || myLogs[dayInfo.date].hours > 0);
    const isFutureDate = dayInfo.date > today;
    const isBeforeStart = compStart && dayInfo.date < compStart;
    const isDisabled = isFutureDate || isBeforeStart;
    const isToday = dayInfo.date === today;
    const isSelected = _dayExplicitlySelected && state.selectedDate === dayInfo.date;
    const classes = ["day-btn"];
    if (isToday && !isSelected) classes.push("today");
    if (isSelected) classes.push("active");
    if (hasEntry) classes.push("logged");
    if (isDisabled) classes.push("disabled");
    const btn = document.createElement("button");
    btn.className = classes.join(" ");
    btn.innerHTML = `<div class="day-btn-dayname">${dayInfo.dayName}</div><div class="day-btn-date">${dayInfo.dayNum}</div>`;

    if (!isDisabled) {
      btn.onclick = () => {
        state.selectedDate = dayInfo.date;
        _dayExplicitlySelected = true;
        renderPickDayRow();
        updatePickLogBtnState();
        const step3 = document.getElementById("pick-step-3");
        if (step3) step3.classList.remove("step-3-locked");
        updateOisArrowState();
        updateOisSummary(2, `${dayInfo.dayName} ${dayInfo.dayNum}`);
        const summaryDate2 = document.getElementById("ois-summary-date-2");
        if (summaryDate2) {
          summaryDate2.innerHTML = `
            <div class="day-btn ois-summary-day-btn">
              <div class="day-btn-dayname">${dayInfo.dayName}</div>
              <div class="day-btn-date">${dayInfo.dayNum}</div>
              <span class="ois-summary-pencil" aria-hidden="true">×</span>
            </div>
          `;
        }
        setOisStep(3);
      };
    } else {
      btn.disabled = true;
    }
    dayRow.appendChild(btn);
  });

  // Dim prev when already at the competition start week.
  // Dim next only when the entire next week falls outside the competition window.
  const compEnd = state.competitions[state.currentComp]?.endDate;
  const upperBound = compEnd || today;
  const nextWeekStart = getWeekForDate(nextWeek(state.selectedDate)).startDate;
  const prevDisabled = !!compStart && week.startDate <= compStart;
  const nextDisabled = nextWeekStart > upperBound;

  const nextBtn = makeBtn("→", "week-nav-btn", () => { state.selectedDate = nextWeek(state.selectedDate); renderPickDayRow(); updatePickLogBtnState(); });
  if (nextDisabled) nextBtn.disabled = true;
  dayRow.appendChild(nextBtn);

  const prevBtn = document.getElementById("pick-prev-week-btn");
  if (prevDisabled) {
    prevBtn.disabled = true;
  } else {
    prevBtn.onclick = () => { state.selectedDate = prevWeek(state.selectedDate); renderPickDayRow(); updatePickLogBtnState(); };
  }
  syncPickStep3Lock();
}

function updatePickLogBtnState() {
  const btn = document.getElementById("pick-btn-log");
  const lockedMsg = document.getElementById("pick-log-locked-msg");
  const salesInput = document.getElementById("pick-input-sales");
  const hoursInput = document.getElementById("pick-input-hours");
  if (!btn) return;

  // Check if the selected date already has a log for this player
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
    const hasPlayer = !!state.currentUser;
    const ready = hasPlayer && hasValues;
    btn.disabled = !ready;
    btn.classList.toggle("btn-ghost", !ready);
  }
}

function updateOisSummary(panel, text) {
  const el = document.getElementById(`ois-summary-text-${panel}`);
  if (el) el.textContent = text;
}

function setOisStep(step) {
  const card = document.getElementById("pick-log-card");
  const trigger = document.getElementById("pick-card-toggle");
  const successState = document.getElementById("pick-success-state");
  if (!card) return;

  const nextStep = parseInt(step) || 0;

  card.dataset.oisStep = String(step);
  card.classList.remove("collapsed");
  if (trigger) trigger.setAttribute("aria-expanded", "true");
  if (successState && String(step) !== "success") successState.classList.remove("visible");

  // Mark the step as visited; choose animation based on whether it's the first visit
  if (nextStep >= 1 && nextStep <= 3) {
    const panelEl = document.querySelector(`.ois-step[data-ois-panel="${nextStep}"]`);
    const newCard = document.getElementById(`ois-card-${nextStep}`);
    const isFirstVisit = panelEl && !panelEl.classList.contains("ois-visited");

    if (panelEl) panelEl.classList.add("ois-visited");

    if (newCard) {
      newCard.classList.remove("ois-entering", "ois-reopening");
      void newCard.offsetWidth;
      newCard.classList.add(isFirstVisit ? "ois-entering" : "ois-reopening");
      setTimeout(() => newCard.classList.remove("ois-entering", "ois-reopening"), 420);
    }
  }

  updateOisArrowState();
}

function collapseOisFlow() {
  const card = document.getElementById("pick-log-card");
  const trigger = document.getElementById("pick-card-toggle");
  if (!card) return;

  card.classList.add("collapsed");
  if (trigger) trigger.setAttribute("aria-expanded", "false");
  updateOisArrowState();
}

function initOisSwipeDismiss() {
  const logCard = document.getElementById("pick-log-card");
  if (!logCard) return;

  let swipeState = null;

  function isInteractiveTarget(el) {
    return !!el.closest("button, input, select, textarea, a, #pick-player-results, .day-row");
  }

  document.addEventListener("pointerdown", (e) => {
    if (isInteractiveTarget(e.target)) return;
    const step = parseInt(logCard.dataset.oisStep) || 0;
    if (step < 1) return;
    const card = document.getElementById(`ois-card-${step}`);
    if (!card || !card.contains(e.target)) return;

    swipeState = {
      startY: e.clientY,
      startX: e.clientX,
      startTime: Date.now(),
      committed: false,
      step,
      card,
      pointerId: e.pointerId,
    };
  }, { passive: true });

  document.addEventListener("pointermove", (e) => {
    if (!swipeState || e.pointerId !== swipeState.pointerId) return;
    const dy = e.clientY - swipeState.startY;
    const dx = e.clientX - swipeState.startX;

    if (!swipeState.committed) {
      if (Math.abs(dy) < 6 && Math.abs(dx) < 6) return;
      if (dy > 0 && dy > Math.abs(dx) * 1.2) {
        swipeState.committed = true;
      } else {
        swipeState = null;
        return;
      }
    }

    if (dy <= 0) {
      swipeState.card.style.transform = "";
      return;
    }
    // Damped follow: resistance increases with distance
    const damped = Math.pow(dy, 0.68) * 2.6;
    swipeState.card.style.transform = `translateY(${damped}px)`;
  }, { passive: true });

  document.addEventListener("pointerup", (e) => {
    if (!swipeState || e.pointerId !== swipeState.pointerId) {
      swipeState = null;
      return;
    }
    if (!swipeState.committed) { swipeState = null; return; }

    const dy = e.clientY - swipeState.startY;
    const elapsed = Math.max(1, Date.now() - swipeState.startTime);
    const velocity = dy / elapsed; // px/ms
    const { card, step } = swipeState;
    swipeState = null;

    if (dy > 55 || velocity > 0.35) {
      // Commit dismiss: slide card down and out, then go back
      card.style.transition = "transform 200ms cubic-bezier(0.23,1,0.32,1), opacity 180ms ease-out";
      card.style.transform = "translateY(60px)";
      card.style.opacity = "0";
      setTimeout(() => {
        card.style.transition = "";
        card.style.transform = "";
        card.style.opacity = "";
        if (step > 1) {
          setOisStep(step - 1);
        } else {
          collapseOisFlow();
        }
      }, 210);
    } else {
      // Spring back — bouncy easing signals "not enough"
      card.style.transition = "transform 500ms cubic-bezier(0.34,1.25,0.64,1)";
      card.style.transform = "";
      setTimeout(() => { card.style.transition = ""; }, 520);
    }
  });

  document.addEventListener("pointercancel", (e) => {
    if (!swipeState || e.pointerId !== swipeState.pointerId) return;
    const { card } = swipeState;
    swipeState = null;
    card.style.transition = "transform 420ms cubic-bezier(0.34,1.25,0.64,1)";
    card.style.transform = "";
    setTimeout(() => { card.style.transition = ""; }, 440);
  });
}

function canEnterOisStep(step) {
  if (Number(step) === 2) return !!state.currentUser;
  if (Number(step) === 3) {
    const step3 = document.getElementById("pick-step-3");
    return !!state.currentUser && !step3?.classList.contains("step-3-locked");
  }
  return true;
}

function isSelectedPickDateLoggable() {
  const today = getTodayDate();
  const comp = state.competitions[state.currentComp];
  const selectedDate = state.selectedDate;
  if (!selectedDate || selectedDate > today) return false;
  if (comp?.startDate && selectedDate < comp.startDate) return false;
  if (comp?.endDate && selectedDate > comp.endDate) return false;
  return true;
}

function updateOisArrowState() {
  document.querySelectorAll("[data-ois-next]").forEach(btn => {
    btn.disabled = !canEnterOisStep(btn.dataset.oisNext);
  });
}

function syncPickStep3Lock() {
  const step3 = document.getElementById("pick-step-3");
  if (!step3) return;
  step3.classList.toggle("step-3-locked", !state.currentUser || !isSelectedPickDateLoggable());
  updateOisArrowState();
}
// ══════════════════════════════════════════════════════
function renderPickScreen(filterText = "") {
  const searchInput = document.getElementById("input-search-players");
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
  const activePlayers = Object.entries(state.players).filter(([, player]) => !player.inactive);
  const filtered = activePlayers
    .filter(([, player]) => player.name.toLowerCase().includes(filterText.toLowerCase()));

  if (filtered.length === 0) {
    grid.classList.add("empty");
    grid.innerHTML = filterText ? "No players found" : "No players yet - add them in Manager";
    document.getElementById("search-results-info")?.classList.add("hidden");
    return;
  }

  grid.classList.remove("empty");
  const resultsInfo = document.getElementById("search-results-info");
  if (resultsInfo) {
    if (filterText) {
      resultsInfo.textContent = `${filtered.length} of ${activePlayers.length} players`;
      resultsInfo.classList.remove("hidden");
    } else {
      resultsInfo.classList.add("hidden");
    }
  }

  filtered.forEach(([id, player]) => {
    const rank = players.findIndex(p => p.id === id);
    const isTopThree = hasLogs && rank >= 0 && rank < 3;
    const isWinner = state.competitions[state.currentComp]?.winner === id;
    const safeName = escapeHtml(player.name);
    const btn = document.createElement("button");
    btn.className = `name-btn${isWinner ? " name-btn-winner" : ""}`;
    btn.innerHTML = `
      ${isTopThree ? getBoardAvatarHtml(player, id, rank + 1) : getAvatarHtml(player, "small", id)}
      <div>
        ${isWinner ? "★ " : ""}${safeName}
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
      const player = state.players[state.currentUser];
      if (player) headerName.textContent = player.name.toUpperCase();
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

function enterAsDashboard(playerId) {
  state.currentUser = playerId;
  localStorage.setItem("lastPlayer", playerId);
  state.dashView = "logging";
  state.selectedDate = getTodayDate();
  _dayExplicitlySelected = false;

  // Always start fresh when switching players.
  // (If the selected day already has a log, updatePickLogBtnState will refill and lock these.)
  const salesInput = document.getElementById("pick-input-sales");
  const hoursInput = document.getElementById("pick-input-hours");
  if (salesInput) salesInput.value = "";
  if (hoursInput) hoursInput.value = "";

  const player = state.players[playerId];

  // Hide success state if showing from a previous log
  const successState = document.getElementById("pick-success-state");
  if (successState) successState.classList.remove("visible");

  const formSteps = document.getElementById("pick-form-steps");
  if (formSteps) {
    formSteps.style.display = "";
    formSteps.classList.remove("steps-locked");
  }

  const step3 = document.getElementById("pick-step-3");
  if (step3) {
    step3.classList.toggle("step-3-locked", !isSelectedPickDateLoggable());
  }

  showSelectedPlayerProfile(playerId, player);
  renderPickDayRow();
  updatePickLogBtnState();
  updateOisArrowState();
  updateOisSummary(1, player?.name || playerId);
  updateOisSummary(2, "Pick the Day");
  const summaryAvatar1 = document.getElementById("ois-summary-avatar-1");
  if (summaryAvatar1) {
    summaryAvatar1.innerHTML = `
      <span class="ois-summary-avatar-frame">
        ${getAvatarHtml(player || { name: playerId }, "small", playerId)}
        <button type="button" class="ois-summary-clear" aria-label="Clear selected player" title="Clear selected player">×</button>
      </span>
      <button type="button" class="ois-summary-view-profile pick-avatar-edit-pill">View profile</button>
    `;
  }
  // Mark step 1 visited directly — entering via auto-select (e.g. on page load)
  // never passes through setOisStep(1), so its collapsed avatar would otherwise
  // never become visible.
  const panel1 = document.querySelector(".ois-step[data-ois-panel='1']");
  if (panel1) panel1.classList.add("ois-visited");
  // Clear step 3 visited — new player means day+sales need to be re-entered
  const panel3 = document.querySelector(".ois-step[data-ois-panel='3']");
  if (panel3) panel3.classList.remove("ois-visited");
  setOisStep(2);
}

function resetPickPlayerSelection({ openGrid = false } = {}) {
  state.currentUser = null;
  state.selectedDate = getTodayDate();
  _dayExplicitlySelected = false;

  const searchEl = document.getElementById("pick-player-search");
  if (searchEl) searchEl.value = "";
  closePickPlayerResults();

  const step3 = document.getElementById("pick-step-3");
  if (step3) step3.classList.add("step-3-locked");

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
    formSteps.style.display = "";
    formSteps.classList.add("steps-locked");
  }

  const successState = document.getElementById("pick-success-state");
  if (successState) successState.classList.remove("visible");

  hideSelectedPlayerProfile();
  renderPickDayRow();
  updateOisArrowState();
  updateOisSummary(1, "Search Player");
  updateOisSummary(2, "Pick the Day");
  const summaryAvatar1 = document.getElementById("ois-summary-avatar-1");
  if (summaryAvatar1) summaryAvatar1.innerHTML = "";
  const summaryDate2 = document.getElementById("ois-summary-date-2");
  if (summaryDate2) summaryDate2.innerHTML = "";
  // Clear visited state for steps 2 and 3 (full reset)
  [2, 3].forEach(i => {
    const panel = document.querySelector(`.ois-step[data-ois-panel="${i}"]`);
    if (panel) panel.classList.remove("ois-visited");
  });
  setOisStep(1);
  if (openGrid) focusElementSoon(searchEl, { preventScroll: true });
  updatePickLogBtnState();
}

function showSelectedPlayerProfile(playerId, player) {
  const profileCard = document.getElementById("pick-player-profile");
  if (!profileCard) return;

  const searchWrap = document.getElementById("pick-search-wrap");
  if (searchWrap) searchWrap.style.display = "none";

  profileCard.style.display = "block";

  profileCard.innerHTML = `
    <div class="pick-selected-player-card">
      <button class="pick-selected-avatar-btn" id="pick-player-avatar-btn" type="button" title="Tap to edit avatar">
        ${getAvatarHtml(player, "pick-large avatar-interactive", playerId)}
        <span class="pick-avatar-edit-pill">Edit Avatar</span>
      </button>
      <div class="pick-selected-player-copy">
        <div class="pick-selected-player-name">${escapeHtml(player.name)}</div>
      </div>
      <button class="pick-selected-clear-btn" id="pick-clear-player-btn" type="button" title="Choose a different player" aria-label="Choose a different player">X</button>
    </div>
  `;

  // Make avatar clickable to edit (players can only edit avatar)
  document.getElementById("pick-player-avatar-btn").onclick = (e) => {
    e.stopPropagation();
    promptPickAvatarUpload(playerId);
  };

  document.getElementById("pick-clear-player-btn").onclick = (e) => {
    e.stopPropagation();
    resetPickPlayerSelection({ openGrid: true });
  };
}

function hideSelectedPlayerProfile() {
  const profileCard = document.getElementById("pick-player-profile");
  if (profileCard) profileCard.style.display = "none";
  const searchWrap = document.getElementById("pick-search-wrap");
  if (searchWrap) searchWrap.style.display = "";
}

function isIOSDevice() {
  const ua = navigator.userAgent || "";
  const platform = navigator.platform || "";
  const touchPoints = navigator.maxTouchPoints || 0;
  return /iPhone|iPad|iPod/i.test(ua) || (platform === "MacIntel" && touchPoints > 1);
}

function promptPickAvatarUpload(playerId) {
  triggerAvatarFileInput(playerId, { accept: "image/*,.heic,.heif,.png,.jpg,.jpeg,.webp" });
}

function closePickAvatarUploadModal() {
  const modal = document.getElementById("pick-avatar-upload-modal");
  if (modal) modal.classList.remove("active");
}

function getAdminLogEmptyState(message) {
  return `<div class="admin-log-empty-state admin-log-detail-empty">${escapeHtml(message)}</div>`;
}

function triggerAvatarFileInput(playerId, { accept = "image/*", capture } = {}) {
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
    await update(dbRef.player(playerId), { avatar: base64 });
    showToast("Photo updated ✓");

    const updatedPlayer = state.players[playerId];
    if (updatedPlayer && state.currentUser === playerId) {
      showSelectedPlayerProfile(playerId, updatedPlayer);
    }
  };

  fileInput.click();
}

function renderPickSearchResults(filterText = "") {
  const results = document.getElementById("pick-player-results");
  if (!results) return;

  const trimmed = filterText.trim();
  if (!trimmed) {
    results.innerHTML = "";
    results.classList.remove("has-results");
    return;
  }

  const activePlayers = Object.entries(state.players)
    .filter(([, player]) => !player.inactive)
    .filter(([, player]) => player.name.toLowerCase().includes(trimmed.toLowerCase()))
    .sort(([, a], [, b]) => a.name.localeCompare(b.name));

  results.classList.add("has-results");

  if (activePlayers.length === 0) {
    results.innerHTML = `<div class="pick-search-no-results">No players found</div>`;
    return;
  }

  results.innerHTML = "";
  activePlayers.forEach(([id, player]) => {
    const btn = document.createElement("button");
    btn.type = "button";
    btn.className = "pick-result-btn";
    btn.innerHTML = `${getAvatarHtml(player, "small", id)}<span>${escapeHtml(player.name)}</span>`;
    btn.onclick = () => {
      closePickPlayerResults();
      enterAsDashboard(id);
    };
    results.appendChild(btn);
  });
}

// ══════════════════════════════════════════════════════
// Dashboard
// ══════════════════════════════════════════════════════
function renderDash() {
  const player = state.players[state.currentUser];
  if (!player) return;
  const isProfileView = state.dashView === "profile";
  const header = document.getElementById("app-header");
  const dashBody = document.querySelector("#screen-dash .dash-body");

  if (header) {
    header.classList.toggle("hidden", isProfileView);
  }
  if (dashBody) {
    dashBody.classList.toggle("dash-body-profile", isProfileView);
  }

  document.getElementById("dash-name").textContent = player.name.toUpperCase();
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
      const profileReturn = state.profileReturnScreen === "pick"
        ? { label: "Back to Home", screen: "pick" }
        : { label: "Back to Leaderboard", screen: "board" };
      if (profileBackBtn) {
        profileBackBtn.innerHTML = `<span class="back-arrow">←</span> ${profileReturn.label}`;
        profileBackBtn.onclick = () => {
          state.dashView = "logging";
          showScreen(profileReturn.screen);
        };
      }
      profileBackBtn?.classList.remove("hidden");
      profileCard.classList.remove("hidden");
      profileCard.innerHTML = `
        <div class="dash-profile-hero">
          <div class="dash-profile-avatar">
            <button class="dash-profile-avatar-btn pick-selected-avatar-btn" id="dash-profile-avatar-btn" type="button" title="Tap to edit avatar">
              ${getBoardAvatarHtml(player, state.currentUser, displayRank)}
              <span class="pick-avatar-edit-pill">Edit Avatar</span>
            </button>
          </div>
          <div class="dash-profile-copy">
            <div class="dash-profile-kicker">Player Profile</div>
            <div class="dash-profile-name-row">
              <h1 class="dash-profile-name">${escapeHtml(player.name)}</h1>
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
                <div class="dash-profile-stat-label">OIS Entered</div>
                <div class="dash-profile-stat-value">${Object.keys(myLogs).length}</div>
              </div>
            </div>
          </div>
        </div>
      `;
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
    if (!isProfileView && winner && state.players[winner]) {
      winnerBanner.innerHTML = `★ <strong>${escapeHtml(state.players[winner].name)}</strong> won!`;
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
      goalsHtml += `<div class="goal-block"><div class="goal-label">▸ Competition Goal</div>${renderGoalBar(g.type === "sph" ? sph : totalSales, g.value, g.type)}</div>`;
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
  const nameEl = document.getElementById("board-comp-name");
  const prevBtn = document.getElementById("board-comp-prev");
  const nextBtn = document.getElementById("board-comp-next");
  const title = document.getElementById("board-screen-title");
  if (!picker || !nameEl || !prevBtn || !nextBtn) return;

  // Chronological order (by competition start date) so the arrows move
  // forward/backward through time, not creation order.
  const sortedComps = Object.entries(state.competitions)
    .sort(([, a], [, b]) => (a.startDate || "").localeCompare(b.startDate || "") || (a.createdAt || 0) - (b.createdAt || 0));

  if (sortedComps.length === 0) {
    picker.style.display = "none";
    if (title) title.textContent = "LEADERBOARD";
    return;
  }

  picker.style.display = "flex";
  if (title) title.textContent = "LEADERBOARD";

  let index = sortedComps.findIndex(([id]) => id === state.boardComp);
  if (index === -1) index = sortedComps.length - 1;
  const [activeId, activeComp] = sortedComps[index];
  state.boardComp = activeId;
  nameEl.textContent = activeComp.name;

  prevBtn.style.visibility = index > 0 ? "visible" : "hidden";
  nextBtn.style.visibility = index < sortedComps.length - 1 ? "visible" : "hidden";

  prevBtn.onclick = () => {
    if (index <= 0) return;
    state.boardComp = sortedComps[index - 1][0];
    renderBoardCompSelect();
    renderBoard();
  };
  nextBtn.onclick = () => {
    if (index >= sortedComps.length - 1) return;
    state.boardComp = sortedComps[index + 1][0];
    renderBoardCompSelect();
    renderBoard();
  };
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

  const podiumEl = document.createElement("div");
  podiumEl.className = "ended-podium";

  [1, 2, 3].forEach(rank => {
    const group = podiumGroups.find(g => g.rank === rank);
    if (!group) return;
    const tied = group.players.length > 1;

    const placeEl = document.createElement("div");
    placeEl.className = `ended-podium-place ended-podium-place-${rank}${tied ? " ended-podium-tie" : ""}`;

    const playersEl = document.createElement("div");
    playersEl.className = "ended-podium-players";

    if (tied) {
      const tieBadge = document.createElement("div");
      tieBadge.className = "ended-podium-tie-badge";
      tieBadge.textContent = "TIE";
      playersEl.appendChild(tieBadge);
    }

    group.players.forEach(player => {
      const playerRecord = state.players[player.id] || { name: player.name };
      const btn = document.createElement("button");
      btn.type = "button";
      btn.className = "ended-podium-player board-ended-podium-player";
      btn.innerHTML = `
        ${getBoardAvatarHtml(playerRecord, player.id, rank)}
        <div class="ended-podium-name">${escapeHtml(player.name)}</div>
        <div class="ended-podium-score">${scoreValue(player)} <span>${scoreLabel}</span></div>
      `;
      btn.onclick = () => {
        state.currentUser = player.id;
        state.dashView = "profile";
        state.profileReturnScreen = "board";
        renderDash();
        showScreen("dash");
      };
      playersEl.appendChild(btn);
    });

    const riserEl = document.createElement("div");
    riserEl.className = "ended-podium-riser";
    riserEl.innerHTML = `<span class="ended-podium-riser-num">${rank}</span>`;

    placeEl.appendChild(playersEl);
    placeEl.appendChild(riserEl);
    podiumEl.appendChild(placeEl);
  });

  section.appendChild(podiumEl);

  const baseEl = document.createElement("div");
  baseEl.className = "ended-podium-base";
  section.appendChild(baseEl);

  body.appendChild(section);
}

function renderBoard() {
  const compId = state.boardComp || state.currentComp;
  const body = document.getElementById("board-body");
  const noCompsMsg = document.getElementById("board-no-comps");
  const statusEl = document.getElementById("board-comp-status");
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
    if (statusEl) statusEl.style.display = "none";
    return;
  }

  if (noCompsMsg) noCompsMsg.style.display = "none";
  const comp = state.competitions[compId];
  const hasLogs = hasLogsInComp(compId);
  body.innerHTML = "";

  if (statusEl) {
    if (isCompEnded(comp)) {
      statusEl.textContent = "Competition Ended";
      statusEl.style.display = "block";
    } else {
      statusEl.style.display = "none";
    }
  }

  if (!hasLogs) {
    body.innerHTML = `
      <div class="board-empty-state">
        <div class="board-empty-icon board-empty-pixel-icon">▶</div>
        <div class="board-empty-title">COMPETITION STARTS NOW</div>
        <div class="board-empty-sub">Be the first to insert an OIS and claim the top spot!</div>
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
    const hasMoreBelowPodium = ranked.some((_, idx) => getLeaderboardDisplayRank(ranked, idx, metric) >= 4) || zeroes.length > 0;
    if (hasMoreBelowPodium) {
      const rankDivider = document.createElement("div");
      rankDivider.className = "board-section-header";
      body.appendChild(rankDivider);
    }
  }

  function makeBoardCard(player, index, tieGroupSize = 1, isZero = false) {
    const displayRank = isZero ? null : getLeaderboardDisplayRank(ranked, index, metric);
    const isWinner = winner === player.id;
    const playerRecord = state.players[player.id];
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
      ${getBoardAvatarHtml(playerRecord || { name: player.name }, player.id, isZero ? 99 : displayRank)}
      <div class="board-info">
        <div class="board-name-row">
          <div class="board-name">${safePlayerName}</div>
          ${isWinner ? "<span class='winner-label'>WINNER</span>" : ""}${playerRecord?.inactive ? "<span class='past-player-label'>PAST PLAYER</span>" : ""}
        </div>
      </div>
      <div class="board-score">
        <div class="board-sph">$${player.sph.toFixed(2)}</div>
        <div class="board-sph-label">/HR</div>
      </div>
    `;
    card.setAttribute("role", "button");
    card.setAttribute("tabindex", "0");
    card.onclick = () => {
      state.currentUser = player.id;
      state.dashView = "profile";
      state.profileReturnScreen = "board";
      renderDash();
      showScreen("dash");
    };
    card.onkeydown = (e) => {
      if (e.key === "Enter" || e.key === " ") { e.preventDefault(); card.click(); }
    };
    return card;
  }

  const minRank = isCompEnded(comp) ? 4 : 1;

  for (let i = 0; i < ranked.length; i++) {
    const rank = getLeaderboardDisplayRank(ranked, i, metric);
    if (rank < minRank) continue;

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
  return Object.keys(compLogs).some(playerId => {
    const playerLogs = compLogs[playerId];
    return Object.keys(playerLogs || {}).length > 0;
  });
}

function getAlphabeticalPlayers(compId) {
  const compLogs = state.logs[compId] || {};
  return Object.entries(state.players)
    .filter(([, player]) => !player.inactive)
    .map(([id, player]) => {
      const playerLogs = compLogs[id] || {};
      let total = 0, hours = 0;
      Object.values(playerLogs).forEach(log => { total += log.sales || 0; hours += log.hours || 0; });
      return { id, name: player.name, total, hours, sph: hours > 0 ? total / hours : 0 };
    })
    .sort((a, b) => a.name.localeCompare(b.name));
}

function getRankedPlayers(compId, logsSource = state.logs) {
  const compLogs = logsSource[compId] || {};
  const metric = state.settings.rankingMetric || "sph";
  return Object.entries(state.players)
    .map(([id, player]) => {
      const playerLogs = compLogs[id] || {};
      let total = 0, hours = 0;
      Object.values(playerLogs).forEach(log => { total += log.sales || 0; hours += log.hours || 0; });
      return { id, name: player.name, total, hours, sph: hours > 0 ? total / hours : 0 };
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
  const storedWinner = comp.winner ? state.players[comp.winner] : null;
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
      const playerRecord = state.players[player.id] || { name: player.name };
      return `
        <div class="ended-podium-player">
          ${getBoardAvatarHtml(playerRecord, player.id, rank)}
          <div class="ended-podium-name">${escapeHtml(player.name)}</div>
          <div class="ended-podium-score">${scoreValue(player)} <span>${scoreLabel}</span></div>
        </div>
      `;
    }).join("");
    return `
      <div class="ended-podium-place ended-podium-place-${rank}${tied ? " ended-podium-tie" : ""}">
        <div class="ended-podium-players">
          ${tied ? `<div class="ended-podium-tie-badge">TIE</div>` : ""}
          ${playerHtml}
        </div>
        <div class="ended-podium-riser"><span class="ended-podium-riser-num">${rank}</span></div>
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
    ${podiumHtml ? `<div class="ended-podium">${podiumHtml}</div><div class="ended-podium-base"></div>` : `
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
  Object.values(compLogs).forEach(playerLogs => {
    Object.keys(playerLogs || {}).forEach(date => dates.add(date));
  });
  return Array.from(dates).sort();
}

function buildCompetitionLogsSnapshot(compId, cutoffDate, logsSource = state.logs) {
  const snapshot = { ...logsSource, [compId]: {} };
  const compLogs = logsSource[compId] || {};
  Object.entries(compLogs).forEach(([playerId, playerLogs]) => {
    snapshot[compId][playerId] = Object.fromEntries(
      Object.entries(playerLogs || {}).filter(([date]) => date <= cutoffDate)
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
  const playerCount = Object.keys(state.players).length;
  const today = getTodayDate();
  const compId = state.currentComp;
  let logsToday = 0;
  if (compId && state.logs[compId]) {
    Object.values(state.logs[compId]).forEach(playerLogs => {
      if (playerLogs[today]) logsToday++;
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
    { id: "players",    label: "Players" },
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
    case "players":    renderAdminPlayers(content); break;
    case "logs":         renderAdminLogs(content); break;
  }
}

// ══════════════════════════════════════════════════════
// ADMIN — Competitions
// ══════════════════════════════════════════════════════
function renderAdminComps(container) {
  container.innerHTML = `<div class="admin-section-title">MANAGE COMPETITIONS</div>`;
  // Only one competition is ever active at a time, so there's nothing
  // meaningful to filter — just show every competition, newest first.
  const filteredEntries = Object.entries(state.competitions)
    .sort(([, a], [, b]) => (b.createdAt || 0) - (a.createdAt || 0));
  const toShow = state.admin.showAllComps ? filteredEntries : filteredEntries.slice(0, PREVIEW_COUNT);

  const list = document.createElement("div");
  // While a competition's edit form is open, let the box grow to fit it
  // instead of forcing the user to scroll inside the small 4-row box.
  list.className = `admin-list admin-comp-list${state.admin.editingCompId ? " is-editing" : ""}`;

  toShow.forEach(([id, comp]) => {
    const compWrap = document.createElement("div");
    compWrap.className = `admin-comp-row${state.admin.editingCompId === id ? " editing" : ""}`;

    const ended = isCompEnded(comp);
    const upcoming = isCompUpcoming(comp);
    const item = document.createElement("div");
    item.className = `admin-item admin-comp-item${ended ? " admin-comp-item-ended" : ""}`;
    item.id = `admin-comp-item-${id}`;

    const leftPart = document.createElement("div");
    leftPart.className = "admin-item-left";
    leftPart.innerHTML = `
      <span class="admin-item-name">${escapeHtml(comp.name)}</span>
      ${ended ? `<span class="comp-status-chip comp-status-ended">Ended</span>` : ""}
      ${upcoming ? `<span class="comp-status-chip comp-status-upcoming">Upcoming</span>` : ""}
    `;
    if (!ended) {
      const editBtn = document.createElement("button");
      editBtn.type = "button";
      editBtn.className = "comp-status-chip comp-status-edit";
      editBtn.textContent = state.admin.editingCompId === id ? "Close" : "Edit";
      editBtn.onclick = () => {
        state.admin.editingCompId = state.admin.editingCompId === id ? null : id;
        renderAdminTab();
        requestAnimationFrame(() => {
          document.getElementById(`admin-comp-row-${id}`)?.scrollIntoView({ behavior: "smooth", block: "nearest" });
        });
      };
      leftPart.appendChild(editBtn);
    }
    item.appendChild(leftPart);

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
    empty.textContent = "No competitions yet";
    list.appendChild(empty);
  }
  // New competition form
  const newCompSection = document.createElement("div");
  newCompSection.className = "goal-admin-block";
  newCompSection.classList.add("admin-new-comp-section");

  const toggleBtn = document.createElement("button");
  toggleBtn.className = "collapsible-toggle collapsible-toggle-cta";
  toggleBtn.innerHTML = `<span class="ois-trigger-icon">+</span> NEW COMPETITION`;

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
    showToast(`"${name}" created! ★`);
    ["input-new-comp","input-new-comp-start","input-new-comp-end","input-new-comp-goal"].forEach(i => {
      const el = document.getElementById(i);
      if (el) el.value = "";
    });
    checkReady();
  };

  container.appendChild(list);

  if (filteredEntries.length > PREVIEW_COUNT) {
    const viewAllBtn = makeBtn("", "view-all-btn", () => { state.admin.showAllComps = !state.admin.showAllComps; renderAdminTab(); });
    viewAllBtn.innerHTML = state.admin.showAllComps
      ? `Show less <span class="view-all-btn-icon">▲</span>`
      : `View all ${filteredEntries.length} <span class="view-all-btn-icon">▼</span>`;
    container.appendChild(viewAllBtn);
  }

  // Recently Deleted section
  const deletedEntries = Object.entries(state.deletedCompetitions)
    .sort(([, a], [, b]) => b.deletedAt - a.deletedAt);
  if (deletedEntries.length > 0) {
    const deletedSection = document.createElement("div");
    deletedSection.className = "goal-admin-block admin-recently-deleted-section";

    const deletedToggle = document.createElement("button");
    deletedToggle.className = "collapsible-toggle admin-recently-deleted-toggle";
    deletedToggle.innerHTML = `✕ RECENTLY DELETED (${deletedEntries.length}) <span class="collapsible-toggle-icon">▼</span>`;

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
        showToast(`"${comp.name}" restored ✓`);
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
        <div class="admin-readonly-field">${escapeHtml((comp.winner && state.players[comp.winner]?.name) ? state.players[comp.winner].name : "No winner set")}</div>
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

    showToast("All changes saved ✓");
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
    topBackBtn.innerHTML = `<span class="back-arrow">←</span> Back`;
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
    const winnerDisplayText = (comp.winner && state.players[comp.winner]?.name)
      ? state.players[comp.winner].name
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

    showToast("All changes saved ✓");
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
// ADMIN — Players
// ══════════════════════════════════════════════════════

function renderAdminPlayersList() {
  const listContainer = document.getElementById("admin-player-list-container");
  if (!listContainer) return;

  const search = state.admin.playerSearch.toLowerCase();
  const allActive = Object.entries(state.players)
    .filter(([, player]) => !player.inactive)
    .sort(([, a], [, b]) => a.name.localeCompare(b.name));
  const allPast = Object.entries(state.players)
    .filter(([, player]) => player.inactive)
    .sort(([, a], [, b]) => a.name.localeCompare(b.name));

  const filtered = search ? allActive.filter(([, player]) => player.name.toLowerCase().includes(search)) : allActive;
  const toShow = state.admin.showAllPlayers ? filtered : filtered.slice(0, PREVIEW_COUNT);

  listContainer.innerHTML = "";
  const list = document.createElement("div");
  list.className = "admin-list admin-player-list";

  if (toShow.length === 0) {
    list.innerHTML = `<div class="ui-empty-state admin-list-empty-state">No players found</div>`;
  } else {
    toShow.forEach(([id, player]) => {
      const item = document.createElement("div");
      item.className = "admin-item admin-player-item";
      item.id = `admin-player-item-${id}`;

      const leftPart = document.createElement("div");
      leftPart.className = "admin-item-left";
      leftPart.innerHTML = `${getAvatarHtml(player, "small", id)} <span class="admin-item-name">${escapeHtml(player.name)}</span>`;

      const editBtn = document.createElement("button");
      editBtn.type = "button";
      editBtn.className = "comp-status-chip comp-status-edit";
      editBtn.textContent = "Edit";
      editBtn.onclick = () => openEditPlayerModal(id, player);
      leftPart.appendChild(editBtn);

      const delBtn = document.createElement("button");
      delBtn.type = "button";
      delBtn.className = "comp-status-chip comp-status-delete";
      delBtn.textContent = "✕";
      delBtn.onclick = async () => {
        if (confirm(`Remove "${player.name}"? They'll move to Past Players.`)) {
          await update(dbRef.player(id), { inactive: true, removedAt: Date.now() });
        }
      };
      leftPart.appendChild(delBtn);

      item.appendChild(leftPart);

      list.appendChild(item);
    });
  }
  listContainer.appendChild(list);

  if (filtered.length > PREVIEW_COUNT) {
    const viewAllPlayersBtn = makeBtn("", "view-all-btn view-all-btn-boxed", () => { state.admin.showAllPlayers = !state.admin.showAllPlayers; renderAdminPlayersList(); });
    viewAllPlayersBtn.innerHTML = state.admin.showAllPlayers
      ? `Show less <span class="view-all-btn-icon">▲</span>`
      : `View all ${filtered.length} players <span class="view-all-btn-icon">▼</span>`;
    listContainer.appendChild(viewAllPlayersBtn);
  }

  // Past Players section
  if (allPast.length > 0) {
    const pastSection = document.createElement("div");
    pastSection.className = "goal-admin-block admin-past-players-section";

    const pastToggle = document.createElement("button");
    pastToggle.className = "collapsible-toggle";
    pastToggle.innerHTML = `▢ PAST PLAYERS (${allPast.length}) <span class="collapsible-toggle-icon">▼</span>`;

    const pastContent = document.createElement("div");
    pastContent.style.display = "none";

    const pastList = document.createElement("div");
    pastList.className = "admin-list admin-player-list";
    allPast.forEach(([id, player]) => {
      const item = document.createElement("div");
      item.className = "admin-item admin-player-item";

      const leftPart = document.createElement("div");
      leftPart.className = "admin-item-left";
      leftPart.innerHTML = `${getAvatarHtml(player, "small", id)} <span class="admin-item-name">${escapeHtml(player.name)}</span>`;
      item.appendChild(leftPart);

      const rightPart = document.createElement("div");
      rightPart.className = "admin-item-actions";
      rightPart.appendChild(makeBtn("Restore", "del-btn", async () => {
        await update(dbRef.player(id), { inactive: false, removedAt: null });
      }));
      rightPart.appendChild(makeBtn("Delete", "del-btn danger", async () => {
        const confirmed = await showAppConfirm({
          title: "Delete Player Permanently",
          message: `Permanently delete "${player.name}"? This removes them from all leaderboards and competition history. This cannot be undone.`,
          confirmLabel: "Delete",
          confirmClassName: "log-btn admin-danger-btn",
        });
        if (!confirmed) return;
        // Best-effort: try to wipe the player's logs in every competition,
        // one date-leaf at a time (the backend may restrict broader writes to
        // the logs tree). This must not block the actual delete (allSettled).
        await Promise.allSettled(
          Object.keys(state.logs || {}).flatMap(compId => {
            const dates = state.logs[compId]?.[id];
            if (!dates) return [];
            return Object.keys(dates).map(date => remove(ref(db, `logs/${compId}/${id}/${date}`)));
          })
        );
        // Removing the player record is what drops them from every leaderboard.
        try {
          await remove(dbRef.player(id));
          showToast(`"${player.name}" deleted`);
        } catch (err) {
          console.error("Failed to delete player", err);
          showToast("Couldn't delete player — check permissions");
        }
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

function renderAdminPlayers(container) {
  container.innerHTML = `<div class="admin-section-title">MANAGE PLAYERS</div>`;
  const playerCount = Object.values(state.players || {}).filter(e => !e.inactive).length;

  const toolsWrap = document.createElement("div");
  toolsWrap.className = "admin-team-tools";
  toolsWrap.innerHTML = `
    <div class="admin-team-tools-header">
      <div class="admin-team-tools-title-row">
        <div class="admin-team-tools-title">Players</div>
        <div class="admin-team-tools-count">${playerCount} active</div>
      </div>
    </div>
    <div class="admin-team-controls">
      <label class="admin-team-field admin-team-search-wrap">
        <span class="admin-team-field-label">Search players</span>
        <div class="admin-team-input-shell">
          <input type="text" id="admin-player-search" class="log-input admin-team-input" placeholder="Search..." />
        </div>
      </label>
      <label class="admin-team-field admin-team-add-wrap">
        <span class="admin-team-field-label">Quick add</span>
        <div class="admin-new-row admin-new-row-top">
          <input type="text" id="input-new-player" class="log-input admin-team-input" placeholder="Add a new player..." oninput="updateBtnState('input-new-player','btn-add-player')" />
          <button class="mini-btn btn-ghost" id="btn-add-player" disabled>Add</button>
        </div>
      </label>
    </div>
  `;
  container.appendChild(toolsWrap);

  const searchInput = document.getElementById("admin-player-search");
  searchInput.value = state.admin.playerSearch;
  searchInput.oninput = (e) => {
    state.admin.playerSearch = e.target.value;
    state.admin.showAllPlayers = false;
    renderAdminPlayersList();
  };

  // Create container for list (will be updated by renderAdminPlayersList)
  const listContainer = document.createElement("div");
  listContainer.id = "admin-player-list-container";
  container.appendChild(listContainer);
  
  // Render the list
  renderAdminPlayersList();
  document.getElementById("btn-add-player").onclick = async () => {
    const name = document.getElementById("input-new-player").value.trim();
    if (!name) return;
    if (findDuplicatePlayerName(name)) {
      showToast(`We already have someone named ${name} — try adding a last name initial`);
      return;
    }
    const id = `${slugify(name)}_${Date.now()}`;
    await set(dbRef.player(id), { name, active: true });
    document.getElementById("input-new-player").value = "";
    updateBtnState("input-new-player", "btn-add-player");
    showToast(`${name} added!`);
  };
}

// Returns the id of an existing player whose name matches (case-insensitive),
// or null if none. Pass excludeId to skip the player currently being edited.
function findDuplicatePlayerName(name, excludeId = null) {
  const target = name.trim().toLowerCase();
  const match = Object.entries(state.players).find(
    ([id, player]) => id !== excludeId && !player.inactive && (player.name || "").trim().toLowerCase() === target
  );
  return match ? match[0] : null;
}

// ══════════════════════════════════════════════════════
// ADMIN — Edit Players Modal
// ══════════════════════════════════════════════════════

// Players can only edit their own avatar
function openEditAvatarModal(playerId, player) {
  let modal = document.getElementById("edit-avatar-player-modal");
  if (!modal) {
    modal = document.createElement("div");
    modal.id = "edit-avatar-player-modal";
    modal.className = "admin-edit-player-modal";
    document.body.appendChild(modal);
    modal.addEventListener("click", (e) => {
      if (e.target === modal) closeEditAvatarModal();
    });
  }

  const isCustomAvatar = player.avatar && player.avatar.startsWith("data:");

  modal.innerHTML = `
    <div class="admin-edit-player-modal-content">
      <div class="admin-edit-player-modal-header">
        <div>Edit Your Avatar</div>
        <button class="admin-edit-player-modal-close">✕</button>
      </div>

      <div class="admin-edit-player-avatar-section">
        <div id="edit-avatar-preview" class="admin-edit-player-avatar-large">
          ${getAvatarHtml(player, "large", playerId)}
        </div>
        <div class="avatar-upload">
          <input type="file" id="edit-avatar-file-input" accept="image/*" />
          <button class="avatar-upload-btn">▣ Upload Photo</button>
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
  modal.querySelector(".admin-edit-player-modal-close").onclick = closeEditAvatarModal;

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
        if (preview) preview.innerHTML = `<div class="avatar avatar-large">${getAvatarPlaceholder(playerId)}</div>`;
      }
    };
  }

  // Save button
  modal.querySelector("#avatar-save-btn").onclick = async () => {
    if (window.editAvatarData === undefined) {
      closeEditAvatarModal();
      return;
    }
    await update(dbRef.player(playerId), { avatar: window.editAvatarData || null });
    showToast("Avatar updated ✓");
    closeEditAvatarModal();
    const updatedPlayer = state.players[playerId];
    if (updatedPlayer && state.currentUser === playerId) {
      showSelectedPlayerProfile(playerId, updatedPlayer);
    }
  };

  // Cancel button
  modal.querySelector("#avatar-cancel-btn").onclick = closeEditAvatarModal;
}

function closeEditAvatarModal() {
  const modal = document.getElementById("edit-avatar-player-modal");
  if (modal) modal.classList.remove("active");
  window.editAvatarData = undefined;
}

// Managers can edit both name and avatar
function openEditPlayerModal(playerId, player) {
  let modal = document.getElementById("admin-edit-player-modal");
  if (!modal) {
    modal = document.createElement("div");
    modal.id = "admin-edit-player-modal";
    modal.className = "admin-edit-player-modal";
    document.body.appendChild(modal);
    modal.addEventListener("click", (e) => {
      if (e.target === modal) closeEditPlayerModal();
    });
  }

  const isCustomAvatar = player.avatar && player.avatar.startsWith("data:");

  modal.innerHTML = `
    <div class="admin-edit-player-modal-content">
      <div class="admin-edit-player-modal-header">
        <div>Edit Player</div>
        <button class="admin-edit-player-modal-close">✕</button>
      </div>

      <div class="admin-edit-player-section">
        <label class="field-label">NAME</label>
        <input type="text" id="edit-player-name" class="log-input" value="${escapeHtml(player.name)}" placeholder="Player name" />
      </div>

      <div class="admin-edit-player-avatar-section">
        <div id="edit-player-avatar-preview" class="admin-edit-player-avatar-large">
          ${getAvatarHtml(player, "large", playerId)}
        </div>
        <div class="avatar-upload">
          <input type="file" id="edit-player-avatar-input" accept="image/*" />
          <button class="avatar-upload-btn">▣ Upload Photo</button>
        </div>
        ${isCustomAvatar ? `<button class="mini-btn del-btn danger">Remove Avatar</button>` : ""}
      </div>

      <div class="admin-btn-row">
        <button class="log-btn" id="player-save-btn">SAVE CHANGES</button>
        <button class="btn-secondary" id="player-cancel-btn">CANCEL</button>
      </div>
    </div>
  `;

  modal.classList.add("active");

  // Close button handler
  modal.querySelector(".admin-edit-player-modal-close").onclick = closeEditPlayerModal;

  // Upload button
  const uploadBtn = modal.querySelector(".avatar-upload-btn");
  const fileInput = modal.querySelector("#edit-player-avatar-input");
  uploadBtn.onclick = () => fileInput.click();

  // File input change
  fileInput.onchange = async (e) => {
    const file = e.target.files[0];
    if (!file) return;
    if (file.size > 5000000) { showToast("Image too large (max 5MB)"); return; }
    const base64 = await fileToBase64(file);
    const preview = modal.querySelector("#edit-player-avatar-preview");
    preview.innerHTML = `<div class="avatar avatar-large"><img class="avatar-img" src="${base64}" alt="preview" /></div>`;
    window.editPlayerAvatarData = base64;
  };

  // Remove avatar button
  const removeBtn = modal.querySelector(".mini-btn.del-btn.danger");
  if (removeBtn) {
    removeBtn.onclick = () => {
      if (confirm("Remove avatar for this player?")) {
        window.editPlayerAvatarData = null;
        const preview = modal.querySelector("#edit-player-avatar-preview");
        if (preview) preview.innerHTML = `<div class="avatar avatar-large">${getAvatarPlaceholder(playerId)}</div>`;
      }
    };
  }

  // Save button
  modal.querySelector("#player-save-btn").onclick = async () => {
    const newName = modal.querySelector("#edit-player-name").value.trim();
    if (!newName) { showToast("Enter a name"); return; }
    if (findDuplicatePlayerName(newName, playerId)) {
      showToast(`We already have someone named ${newName} — try adding a last name initial`);
      return;
    }

    const updates = { name: newName };
    if (window.editPlayerAvatarData !== undefined) {
      updates.avatar = window.editPlayerAvatarData || null;
    }

    await update(dbRef.player(playerId), updates);
    showToast("Player updated ✓");
    closeEditPlayerModal();

    const updatedPlayer = state.players[playerId];
    if (updatedPlayer && state.currentUser === playerId) {
      showSelectedPlayerProfile(playerId, updatedPlayer);
    }

    renderAdminTab();
  };

  // Cancel button
  modal.querySelector("#player-cancel-btn").onclick = closeEditPlayerModal;
}

function closeEditPlayerModal() {
  const modal = document.getElementById("admin-edit-player-modal");
  if (modal) modal.classList.remove("active");
  window.editPlayerAvatarData = undefined;
}

function inlineRenamePlayer(playerId, currentName) {
  openEditPlayerModal(playerId, state.players[playerId]);
}

// ══════════════════════════════════════════════════════
// ADMIN — Orders
// ══════════════════════════════════════════════════════
function renderAdminLogs(container) {
  // Default selected date to today
  if (!state.admin.selectedDate) state.admin.selectedDate = getTodayDate();
  if (!state.admin.selectedComp) state.admin.selectedComp = state.currentComp || Object.keys(state.competitions)[0] || null;
  container.innerHTML = `<div class="admin-section-title">MANAGE ORDERS</div>`;

  const compLabel = document.createElement("label");
  compLabel.className = "field-label"; compLabel.style.marginBottom = "8px"; compLabel.textContent = "COMPETITION";
  container.appendChild(compLabel);

  const compWrap = document.createElement("div");
  compWrap.className = "board-comp-picker admin-logs-comp-picker";
  compWrap.innerHTML = `
    <button class="board-comp-arrow" id="admin-logs-comp-prev" type="button" aria-label="Previous competition">←</button>
    <span class="board-comp-name" id="admin-logs-comp-name"></span>
    <button class="board-comp-arrow" id="admin-logs-comp-next" type="button" aria-label="Next competition">→</button>
  `;
  container.appendChild(compWrap);
  renderAdminLogsCompPicker();

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
      <div class="admin-log-player-title">PLAYERS FOR THE DAY</div>
    </div>
    <div class="admin-log-player-status" id="admin-logs-player-status"></div>
    <div class="admin-log-player-list" id="admin-logs-player-list"></div>
  `;
  container.appendChild(playerDayWrap);

  refreshAdminDayView();
}

function renderAdminLogsCompPicker() {
  const nameEl = document.getElementById("admin-logs-comp-name");
  const prevBtn = document.getElementById("admin-logs-comp-prev");
  const nextBtn = document.getElementById("admin-logs-comp-next");
  if (!nameEl || !prevBtn || !nextBtn) return;

  const sortedComps = Object.entries(state.competitions)
    .sort(([, a], [, b]) => (a.startDate || "").localeCompare(b.startDate || "") || (a.createdAt || 0) - (b.createdAt || 0));

  if (sortedComps.length === 0) {
    nameEl.textContent = "No competitions";
    prevBtn.style.visibility = "hidden";
    nextBtn.style.visibility = "hidden";
    return;
  }

  let index = sortedComps.findIndex(([id]) => id === state.admin.selectedComp);
  if (index === -1) index = sortedComps.length - 1;
  const [activeId, activeComp] = sortedComps[index];
  state.admin.selectedComp = activeId;
  nameEl.textContent = activeComp.name;

  prevBtn.style.visibility = index > 0 ? "visible" : "hidden";
  nextBtn.style.visibility = index < sortedComps.length - 1 ? "visible" : "hidden";

  prevBtn.onclick = () => {
    if (index <= 0) return;
    state.admin.selectedComp = sortedComps[index - 1][0];
    state.admin.selectedPlayer = null;
    renderAdminLogsCompPicker();
    refreshAdminDayView();
  };
  nextBtn.onclick = () => {
    if (index >= sortedComps.length - 1) return;
    state.admin.selectedComp = sortedComps[index + 1][0];
    state.admin.selectedPlayer = null;
    renderAdminLogsCompPicker();
    refreshAdminDayView();
  };
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
    const logsForDay = Object.values((state.logs[compId] || {})).filter(playerLogs => !!playerLogs?.[dayInfo.date]);
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
        state.admin.selectedPlayer = null;
        refreshAdminDayView();
      };
    } else {
      btn.disabled = true;
      btn.onclick = () => showToast(isOutOfComp ? "That day is outside this competition" : "Can't log future dates ✕");
    }
    dayContainer.appendChild(btn);
  });

  // Dim the week arrows at the competition bounds: can't go before the start,
  // and can't go past today or the competition end (no loggable days there).
  const adminToday = getTodayDate();
  const upperBound = (comp.endDate && comp.endDate < adminToday) ? comp.endDate : adminToday;
  const prevDisabled = !!comp.startDate && week.startDate <= comp.startDate;
  const nextDisabled = week.endDate >= upperBound;

  const nextBtn = makeBtn("→", "week-nav-btn", () => {
    state.admin.selectedDate = clampCompetitionDate(nextWeek(state.admin.selectedDate));
    state.admin.selectedPlayer = null;
    refreshAdminDayView();
  });
  if (nextDisabled) nextBtn.disabled = true;
  dayContainer.appendChild(nextBtn);

  const adminPrevBtn = document.getElementById("admin-prev-week-btn");
  if (prevDisabled) {
    adminPrevBtn.disabled = true;
  } else {
    adminPrevBtn.onclick = () => {
      state.admin.selectedDate = clampCompetitionDate(prevWeek(state.admin.selectedDate));
      state.admin.selectedPlayer = null;
      refreshAdminDayView();
    };
  }

  const autoBtnIndex = week.days.findIndex(d => d.date === state.admin.selectedDate) + 1;
  const autoBtn = dayContainer.children[autoBtnIndex];
  if (autoBtn) autoBtn.classList.add("active");

  const selectedDate = state.admin.selectedDate;
  const playersForDay = Object.entries(state.players)
    .sort(([, a], [, b]) => a.name.localeCompare(b.name))
    .map(([id, player]) => {
      const log = (state.logs[compId] || {})[id]?.[selectedDate] || null;
      return { id, player, log };
    });
  const loggedCount = playersForDay.filter(p => p.log).length;
  playerStatus.textContent = loggedCount === 0 ? "No players entered an OIS today" : "";

  if (!playersForDay.length) {
    playerList.innerHTML = `<div class="admin-log-empty-state">No players found for this day</div>`;
    playerStatus.textContent = "";
    return;
  }

  if (!playersForDay.some(p => p.id === state.admin.selectedPlayer)) {
    state.admin.selectedPlayer = null;
  }

  const loggedPlayers = playersForDay.filter(p => p.log);
  const unloggedPlayers = playersForDay.filter(p => !p.log);
  playerList.innerHTML = "";
  const renderPlayerCard = ({ id, player, log }) => {
    const wrap = document.createElement("div");
    wrap.className = `admin-log-player-card-wrap${state.admin.selectedPlayer === id ? " active" : ""}`;

    const btn = document.createElement("button");
    btn.type = "button";
    btn.className = `admin-log-player-card${log ? " has-log" : ""}${state.admin.selectedPlayer === id ? " active" : ""}`;
    btn.innerHTML = `
      <div class="admin-log-player-main">
        <div class="admin-log-player-name">${escapeHtml(player.name)}</div>
        ${log ? `<div class="admin-log-player-meta">$${(log.sales || 0).toFixed(2)} · ${(log.hours || 0).toFixed(1)} hrs</div>` : ""}
      </div>
      ${state.admin.selectedPlayer === id ? '<div class="admin-log-player-badge close">Close</div>' : (log ? '<div class="admin-log-player-badge edit">Edit</div>' : '<div class="admin-log-player-badge open">Add</div>')}
    `;
    btn.onclick = () => {
      state.admin.selectedPlayer = state.admin.selectedPlayer === id ? null : id;
      refreshAdminDayView();
      if (state.admin.selectedPlayer) {
        requestAnimationFrame(() => {
          document.querySelector(".admin-log-player-card-wrap.active")?.scrollIntoView({ behavior: "smooth", block: "nearest" });
        });
      }
    };
    wrap.appendChild(btn);

    if (state.admin.selectedPlayer === id) {
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

function renderAdminLogDetail(playerId, compId, date, log) {
  const detail = document.getElementById("admin-logs-detail");
  if (!detail) return;
  const sph = log.hours > 0 ? (log.sales / log.hours).toFixed(2) : "—";
  const d = new Date(date + "T00:00:00");
  const dayName = DAYS[d.getDay()];
  detail.innerHTML = `
    <div class="admin-log-header">
      <div class="admin-log-header-info">
        <div class="admin-log-header-name">${escapeHtml(state.players[playerId]?.name || "")}</div>
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
      <button class="admin-action-delete" id="admin-delete-log-btn">✕ Delete</button>
    </div>
  `;
  document.getElementById("admin-edit-log-btn").onclick = () => renderAdminLogEdit(playerId, compId, date, log);
  document.getElementById("admin-delete-log-btn").onclick = () => confirmAndDeleteAdminLog(playerId, compId, date);
}

async function confirmAndDeleteAdminLog(playerId, compId, date) {
  const playerName = state.players[playerId]?.name || "this player";
  const confirmed = await showAppConfirm({
    title: "Delete Order",
    message: `Delete ${playerName}'s order for ${date}?`,
    confirmLabel: "DELETE",
    confirmClassName: "log-btn admin-danger-btn",
  });
  if (!confirmed) return;

  await remove(dbRef.dateLog(compId, playerId, date));
  removeLocalLog(compId, playerId, date);
  state.admin.selectedPlayer = null;
  showToast("Order deleted");
  refreshAdminDayView();
  if (state.currentUser === playerId) { renderDash(); renderBoard(); renderAllTime(); }
}

function renderAdminLogCreate(playerId, compId, date, target = null) {
  const detail = target || document.getElementById("admin-logs-detail");
  if (!detail) return;
  const d = new Date(date + "T00:00:00");
  const dayName = DAYS[d.getDay()];
  detail.innerHTML = `
    <div class="admin-log-header">
      <div class="admin-log-header-info">
        <div class="admin-log-header-name">${escapeHtml(state.players[playerId]?.name || "")}</div>
        <div class="admin-log-header-sub">${escapeHtml(`${dayName} ${date} · ${state.competitions[compId]?.name || ""}`)}</div>
      </div>
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
    if (isNaN(sales) || sales < 0) { showToast("Enter sales amount"); return; }
    if (isNaN(hours) || hours <= 0) { showToast("Enter hours worked"); return; }
    if (date > getTodayDate()) { showToast("Can't create OIS for future dates"); return; }
    await set(dbRef.dateLog(compId, playerId, date), { sales, hours });
    upsertLocalLog(compId, playerId, date, { sales, hours });
    state.admin.selectedPlayer = null;
    showToast("OIS Entered");
    refreshAdminDayView();
    if (state.currentUser === playerId) { renderDash(); renderBoard(); renderAllTime(); }
  };
}

function renderAdminLogEdit(playerId, compId, date, log, target = null) {
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
    await set(dbRef.dateLog(compId, playerId, date), { sales, hours });
    upsertLocalLog(compId, playerId, date, { sales, hours });
    state.admin.selectedPlayer = null;
    showToast("Log updated ✓");
    refreshAdminDayView();
    if (state.currentUser === playerId) { renderDash(); renderBoard(); renderAllTime(); }
  };
  detail.querySelector("#admin-delete-edit-btn").onclick = async () => {
    await confirmAndDeleteAdminLog(playerId, compId, date);
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

    // Tag the pick screen so CSS plays the split entrance instead of card-soft-in.
    const pickScreen = document.getElementById("screen-pick");
    pickScreen?.classList.add("boot-entering");

    showScreen("pick");

    // Stagger the bottom nav buttons up after the cards have landed.
    const nav = document.getElementById("bottom-nav");
    if (nav) {
      nav.classList.add("boot-nav-enter");
      setTimeout(() => nav.classList.remove("boot-nav-enter"), 1400);
    }

    // Remove boot-entering after all split animations have finished (~1s total).
    setTimeout(() => pickScreen?.classList.remove("boot-entering"), 1100);

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

  const searchInput = document.getElementById("input-search-players");
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
      resetPickPlayerSelection();
    };
  }

  // INSERT OIS collapsible toggle
  const cardToggle = document.getElementById("pick-card-toggle");
  if (cardToggle) {
    cardToggle.onclick = () => {
      const card = document.getElementById("pick-log-card");
      if (!card) return;
      if (card.classList.contains("collapsed")) {
        setOisStep(1);
      } else {
        resetPickPlayerSelection();
        document.querySelectorAll(".ois-step.ois-visited").forEach(el => el.classList.remove("ois-visited"));
        collapseOisFlow();
      }
    };
  }

  document.querySelectorAll("[data-ois-back]").forEach(btn => {
    btn.addEventListener("click", () => setOisStep(btn.dataset.oisBack));
  });

  // Step 1's collapsed summary is a div (not a button) so it can hold nested
  // buttons: the X clears the selected player, View Profile opens their
  // profile page. The avatar picture itself is decorative (not clickable).
  // Anything else in the row falls back to going back to step 1.
  const summary1 = document.getElementById("ois-summary-1");
  if (summary1) {
    summary1.addEventListener("click", (e) => {
      if (e.target.closest(".ois-summary-clear")) {
        resetPickPlayerSelection();
        return;
      }
      if (e.target.closest(".ois-summary-view-profile")) {
        state.dashView = "profile";
        state.profileReturnScreen = "pick";
        renderDash();
        showScreen("dash");
        return;
      }
      if (e.target.closest(".ois-summary-avatar-frame")) {
        return;
      }
      setOisStep(1);
    });
    summary1.addEventListener("keydown", (e) => {
      if (e.key === "Enter" || e.key === " ") { e.preventDefault(); summary1.click(); }
    });
  }

  document.querySelectorAll("[data-ois-close]").forEach(btn => {
    btn.addEventListener("click", collapseOisFlow);
  });
  updateOisArrowState();
  initOisSwipeDismiss();

  // Pick screen player search
  const pickPlayerSearch = document.getElementById("pick-player-search");
  if (pickPlayerSearch) {
    pickPlayerSearch.oninput = () => {
      clearTimeout(state.searchDebounceTimer);
      state.searchDebounceTimer = setTimeout(() => {
        renderPickSearchResults(pickPlayerSearch.value);
      }, 120);
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
    const playerResults = document.getElementById("pick-player-results");
    const searchWrap = document.getElementById("pick-search-wrap");
    if (playerResults?.classList.contains("has-results") && !searchWrap?.contains(e.target)) {
      closePickPlayerResults();
    }
  });

  document.addEventListener("keydown", (e) => {
    if (e.key === "Escape") {
      closePickPlayerResults();
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
      state.admin.showAllPlayers = false;
      state.admin.selectedPlayer = null;
      state.admin.selectedComp = state.currentComp;
      state.admin.playerSearch = "";
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
