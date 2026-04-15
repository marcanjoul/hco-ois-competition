// src/main.js
import { db } from "./firebase.js";
import { ref, set, get, onValue, update, remove } from "firebase/database";

const DEFAULT_EMPLOYEES = ["adam", "Ajla"];
const ADMIN_PIN = import.meta.env.VITE_ADMIN_PIN;
const DAYS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
const PREVIEW_COUNT = 5;

function getTodayDate() {
  // Use local time, not UTC — avoids date being "tomorrow" in evening hours
  const d = new Date();
  const year = d.getFullYear();
  const month = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");
  return `${year}-${month}-${day}`;
}

let state = {
  competitions: {},
  employees: {},
  logs: {},
  settings: {},
  goals: {},
  currentComp: null,      // active comp shown on pick screen
  boardComp: null,        // comp selected on leaderboard
  currentUser: null,
  selectedDate: getTodayDate(),
  currentScreen: "pick",
  adminUnlocked: false,
  searchDebounceTimer: null,
  admin: {
    showAllComps: false,
    showAllEmps: false,
    selectedEmp: null,
    selectedComp: null,
    selectedDate: getTodayDate(),
    empSearch: "",
    tab: "competitions",
  },
};

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
};

// ══════════════════════════════════════════════════════
// Bootstrap
// ══════════════════════════════════════════════════════
async function bootstrap() {
  const [empSnap, settingsSnap] = await Promise.all([
    get(dbRef.emps()), get(dbRef.settings()),
  ]);
  if (!empSnap.exists()) {
    const u = {};
    DEFAULT_EMPLOYEES.forEach(name => { u[slugify(name)] = { name, active: true }; });
    await update(dbRef.emps(), u);
  }
  if (!settingsSnap.exists()) {
    await set(dbRef.settings(), { accentColor: "#FF4D1C", rankingMetric: "sph" });
  }
}

function slugify(str) {
  return str.toLowerCase().replace(/\s+/g, "_").replace(/[^a-z0-9_]/g, "");
}

function escapeHtml(str) {
  const map = { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#039;" };
  return str.replace(/[&<>"']/g, c => map[c]);
}

// ══════════════════════════════════════════════════════
// Avatar helpers
// ══════════════════════════════════════════════════════
const CUTE_PLACEHOLDERS = ["👤", "👤", "👤", "👤", "👤", "👤", "👤", "👤", "👤", "👤"];

function getAvatarPlaceholder(empIdOrStr) {
  // Deterministic placeholder based on employee ID
  const str = (empIdOrStr || "").toString();
  if (!str) return CUTE_PLACEHOLDERS[0];
  const index = str.charCodeAt(0) % CUTE_PLACEHOLDERS.length;
  return CUTE_PLACEHOLDERS[index];
}

function getAvatarHtml(emp, size = "", empId = "") {
  const sizeClass = size ? ` avatar-${size}` : "";
  if (emp.avatar && emp.avatar.startsWith("data:")) {
    return `<div class="avatar${sizeClass}"><img class="avatar-img" src="${emp.avatar}" alt="${emp.name}" /></div>`;
  }
  const placeholder = getAvatarPlaceholder(empId || emp.id || emp.name);
  return `<div class="avatar${sizeClass}"><span class="avatar-placeholder">${placeholder}</span></div>`;
}

function fileToBase64(file) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(reader.result);
    reader.onerror = reject;
    reader.readAsDataURL(file);
  });
}

window.updateBtnState = function(inputId, btnId) {
  const input = document.getElementById(inputId);
  const btn = document.getElementById(btnId);
  if (!input || !btn) return;
  const hasValue = input.value.trim().length > 0;
  btn.disabled = !hasValue;
  btn.classList.toggle("btn-ghost", !hasValue);
};

function setupPrizeFormatButtons(textareaId) {
  const textarea = document.getElementById(textareaId);
  if (!textarea) return;

  const toolbar = textarea.previousElementSibling;
  if (!toolbar || !toolbar.classList.contains("prize-format-toolbar")) return;

  const buttons = toolbar.querySelectorAll(".prize-format-btn");
  buttons.forEach(btn => {
    btn.addEventListener("click", (e) => {
      e.preventDefault();
      const action = btn.dataset.action;
      const start = textarea.selectionStart;
      const end = textarea.selectionEnd;
      const selected = textarea.value.substring(start, end);
      const before = textarea.value.substring(0, start);
      const after = textarea.value.substring(end);

      let inserted = "";
      if (action === "bullet") {
        inserted = selected ? `• ${selected}` : "• ";
      } else if (action === "indent") {
        inserted = selected ? `   - ${selected}` : "   - ";
      } else if (action === "emphasis") {
        inserted = selected ? `→ ${selected}` : "→ ";
      }

      textarea.value = before + inserted + after;
      textarea.focus();
      textarea.setSelectionRange(start + inserted.length, start + inserted.length);
    });
  });
}

// ══════════════════════════════════════════════════════
// Competition helpers
// ══════════════════════════════════════════════════════
function isCompEnded(comp) {
  if (!comp?.endDate) return false;
  const end = new Date(comp.endDate);
  end.setHours(23, 59, 59, 999);
  return new Date() > end;
}

function getActiveComp() {
  // Find the most recent non-archived, non-closed comp that is active or not yet ended
  const entries = Object.entries(state.competitions)
    .filter(([, c]) => c.status !== "archived" && c.status !== "closed" && !isCompEnded(c))
    .sort(([, a], [, b]) => (b.createdAt || 0) - (a.createdAt || 0));
  return entries[0]?.[0] || null;
}

async function checkAndAutoCloseComps() {
  for (const [id, comp] of Object.entries(state.competitions)) {
    if (comp.status === "active" && isCompEnded(comp)) {
      const ranked = getRankedPlayers(id);
      const winner = ranked.find(p => p.hours > 0);
      await update(dbRef.comp(id), {
        status: "closed",
        winner: winner ? winner.id : null,
        autoClosedAt: Date.now(),
      });
    }
  }
}

function formatDate(dateStr) {
  if (!dateStr) return "";
  const d = new Date(dateStr + "T00:00:00");
  return d.toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric" });
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
    const dateString = d.toISOString().split("T")[0];
    const dayName = DAYS[d.getDay()]; // 0=Sun, 1=Mon ... 6=Sat
    const dayNum = d.getDate();
    days.push({ date: dateString, dayName, dayNum });
  }
  return { days, startDate: days[0].date, endDate: days[6].date };
}

function prevWeek(dateStr) {
  const date = new Date(dateStr + "T00:00:00");
  date.setDate(date.getDate() - 7);
  return date.toISOString().split("T")[0];
}

function nextWeek(dateStr) {
  const date = new Date(dateStr + "T00:00:00");
  date.setDate(date.getDate() + 7);
  return date.toISOString().split("T")[0];
}

function daysRemaining(comp) {
  if (!comp?.endDate) return null;
  const end = new Date(comp.endDate);
  end.setHours(23, 59, 59, 999);
  return Math.ceil((end - new Date()) / (1000 * 60 * 60 * 24));
}

// ══════════════════════════════════════════════════════
// Apply settings
// ══════════════════════════════════════════════════════
function applySettings(s = {}) {
  const color = s.accentColor || "#1A6FF4";
  if (/^#[0-9A-Fa-f]{6}$/.test(color)) {
    document.documentElement.style.setProperty("--accent", color);
  }
  const banner = s.bannerMessage || "";
  const bannerEl = document.getElementById("site-banner");
  if (bannerEl) { bannerEl.textContent = banner; bannerEl.style.display = banner ? "block" : "none"; }
}

// ══════════════════════════════════════════════════════
// Listeners
// ══════════════════════════════════════════════════════
function startListeners() {
  onValue(dbRef.comps(), snap => {
    state.competitions = snap.val() || {};
    state.currentComp = getActiveComp();
    if (!state.boardComp) state.boardComp = state.currentComp;
    // Reset boardComp if the competition was deleted
    if (state.boardComp && !state.competitions[state.boardComp]) {
      state.boardComp = state.currentComp;
    }
    checkAndAutoCloseComps();
    renderPickScreen();
    renderBoardCompSelect();
    if (state.currentScreen === "board") renderBoard();
    if (state.admin.tab === "competitions") renderAdminTab();
  });

  onValue(dbRef.emps(), snap => {
    state.employees = snap.val() || {};
    renderPickScreen();
    if (state.currentUser) { renderDash(); renderBoard(); }
    if (state.admin.tab === "employees") renderAdminTab();
    if (state.admin.tab === "logs") renderAdminTab();
  });

  onValue(dbRef.logs(), snap => {
    state.logs = snap.val() || {};
    renderPickScreen();
    if (state.currentUser) { renderDash(); renderBoard(); }
    if (state.admin.tab === "logs" && state.admin.selectedEmp) refreshAdminDayView();
  });

  onValue(dbRef.settings(), snap => {
    state.settings = snap.val() || {};
    applySettings(state.settings);
  });

  onValue(dbRef.goals(), snap => {
    state.goals = snap.val() || {};
    if (state.currentUser) renderDash();
    renderPickScreen();
    if (state.admin.tab === "competitions") renderAdminTab();
  });
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

function getTodaySph(empId, compId) {
  const log = (state.logs[compId] || {})[empId]?.[getTodayDate()];
  if (!log) return { total: 0, hours: 0, sph: 0 };
  return { total: log.sales || 0, hours: log.hours || 0, sph: log.hours > 0 ? (log.sales / log.hours) : 0 };
}

function pickGoalHype(current, target, pct, isHit) {
  const remaining = Math.max(0, target - current);
  const roundedRemaining = `$${remaining.toFixed(0)}`;
  const pools = isHit
    ? [
        "Goal cleared. Y'all are actually cooking.",
        "Okayyyy this goal got smoked.",
        "Ate that goal up. Keep going.",
        "Mission complete. Still room to flex."
      ]
    : pct >= 85
      ? [
          `So close. ${roundedRemaining} more and it's yours.`,
          `${roundedRemaining} left. Finish the job.`,
          `Locked in. Just ${roundedRemaining} to go.`,
          `${roundedRemaining} more and this goal is done done.`
        ]
      : pct >= 50
        ? [
            "Halfway there. Momentum is looking real nice.",
            "You're in your bag now. Keep stacking.",
            "This is a strong run. Don't let up.",
            "Mid-game heat. A few more orders changes everything."
          ]
        : pct > 0
          ? [
              "Solid start. Let's build on it.",
              "On the board. Now start stacking.",
              "Good first push. Keep the pressure on.",
              "We're moving. One more order can change the vibe."
            ]
          : [
              "No pressure, but first order could go crazy.",
              "Fresh slate. Time to start a run.",
              "First order energy starts now.",
              "Lock in and get this bar moving."
            ];

  const seed = `${target}|${current.toFixed(2)}|${Math.round(pct)}|${isHit}`;
  const hash = Array.from(seed).reduce((acc, ch) => acc + ch.charCodeAt(0), 0);
  return pools[hash % pools.length];
}

function renderGoalBar(current, target, type) {
  const pct = Math.min(100, target > 0 ? (current / target) * 100 : 0);
  const isHit = current >= target;
  const label = type === "sph" ? `$${current.toFixed(0)}/hr` : `$${current.toFixed(0)}`;
  const percentLabel = `${Math.round(pct)}%`;
  const hype = pickGoalHype(current, target, pct, isHit);
  return `
    <div class="goal-progress">
      <div class="goal-progress-top">
        <div class="goal-progress-copy">
          <span class="goal-current${isHit ? " goal-hit" : ""}">${label}</span>
        </div>
        <span class="goal-percent${isHit ? " goal-percent-hit" : ""}">${percentLabel}</span>
      </div>
      <div class="goal-hype${isHit ? " goal-hype-hit" : ""}">${hype}</div>
      <div class="goal-bar-bg">
        <div class="goal-bar-fill${isHit ? " goal-hit-bar" : ""}" style="width:${pct}%"></div>
      </div>
    </div>
  `;
}

// ══════════════════════════════════════════════════════
// Vibe phrases
// ══════════════════════════════════════════════════════
function getVibe(sph, total, hasLogs, name = "") {
  const greeting = name ? name : "You";
  if (!hasLogs) return `Hey ${greeting}! Log your first OIS. You got this! 🚀`;
  if (sph >= 25) return `You're crushing it ${greeting}!!!`;
  if (sph >= 20) return `Yo ${greeting}, you're on another level today. Keep it going!`;
  if (sph >= 15) return `You're killing it ${greeting}.`;
  if (sph >= 10) return `Let's go ${greeting}! `;
  if (sph >= 5)  return `Nice ${greeting}! Keep that energy and you'll be unstoppable.`;
  return                `Keep pushing ${greeting}!`;
}

function getBigOrderReaction(amount) {
  if (amount >= 500) return `$${amount.toFixed(0)} ORDER?! They said take their whole wallet!`;
  if (amount >= 300) return `$${amount.toFixed(0)}! Okay you did NOT have to go that hard!`;
  if (amount >= 200) return `$${amount.toFixed(0)}! You're out here COLLECTING.`;
  if (amount >= 100) return `$${amount.toFixed(0)} order just dropped. Keep stacking!`;
  return null;
}

async function logEntryFromPick() {
  const sales = parseFloat(document.getElementById("pick-input-sales").value);
  const hours = parseFloat(document.getElementById("pick-input-hours").value);
  if (isNaN(sales) || sales < 0) { showToast("Enter a valid sales amount 💸"); return; }
  if (isNaN(hours) || hours <= 0) { showToast("Enter hours worked ⏱️"); return; }
  if (!state.currentUser) { showToast("Select your name first 👤"); return; }
  if (state.competitions[state.currentComp]?.status === "closed") { showToast("This competition is closed 🔒"); return; }

  const today = getTodayDate();
  if (state.selectedDate > today) { showToast("Can't log orders in the future 🔮"); return; }

  const existingLog = (state.logs[state.currentComp] || {})[state.currentUser]?.[state.selectedDate];
  if (existingLog && (existingLog.sales > 0 || existingLog.hours > 0)) {
    showToast("Already logged for this day — see a manager to edit 🔒"); return;
  }

  await set(dbRef.dateLog(state.currentComp, state.currentUser, state.selectedDate), { sales, hours });

  const reaction = getBigOrderReaction(sales);
  if (reaction) { launchConfetti(); }

  // Compute stats for success panel
  const allMyLogs = { ...((state.logs[state.currentComp] || {})[state.currentUser] || {}), [state.selectedDate]: { sales, hours } };
  let totalSales = 0, totalHours = 0;
  Object.values(allMyLogs).forEach(l => { totalSales += l.sales || 0; totalHours += l.hours || 0; });
  const sph = totalHours > 0 ? totalSales / totalHours : 0;
  const allPlayers = getRankedPlayers(state.currentComp);
  const rank = allPlayers.findIndex(p => p.id === state.currentUser) + 1;

  // Show success state — flip the log card
  const formSteps = document.getElementById("pick-form-steps");
  const successState = document.getElementById("pick-success-state");
  const successStats = document.getElementById("pick-success-stats");
  if (formSteps) formSteps.style.display = "none";
  if (successStats) {
    const rankDisplay = rank > 0 ? `#${rank}` : "—";
    successStats.innerHTML = `
      <div class="pick-success-stat"><div class="pick-success-stat-label">SALES</div><div class="pick-success-stat-value">$${sales.toFixed(0)}</div></div>
      <div class="pick-success-stat"><div class="pick-success-stat-label">$/HR</div><div class="pick-success-stat-value" style="color:var(--accent)">$${sph.toFixed(0)}</div></div>
      <div class="pick-success-stat"><div class="pick-success-stat-label">RANK</div><div class="pick-success-stat-value" style="color:var(--gold)">${rankDisplay}</div></div>
    `;
  }
  if (successState) successState.classList.add("visible");

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
    btn.innerHTML = `<div class="day-btn-dayname">${dayInfo.dayName}</div><div class="day-btn-date">${dayInfo.dayNum}</div>${hasEntry ? '<div class="day-btn-checkmark">✓</div>' : ''}`;

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
    btn.textContent = "✓ Already Logged";
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
    btn.textContent = "+ LOG IT";
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
  const searchInput = document.getElementById("input-search-employees");
  if (searchInput && searchInput.value !== filterText) searchInput.value = filterText;

  // Competition info card — show only active comp
  const compInfo = document.getElementById("pick-comp-info");
  const noCompsMsg = document.getElementById("no-comps-message");

  if (!state.currentComp) {
    // No active competition - hide log form, show big message
    if (compInfo) compInfo.classList.add("hidden");
    if (noCompsMsg) noCompsMsg.classList.remove("hidden");
    const logCard = document.getElementById("pick-log-card");
    if (logCard) logCard.style.display = "none";
    return;
  } else if (compInfo && state.currentComp) {
    const logCard = document.getElementById("pick-log-card");
    if (logCard) logCard.style.display = "block";
    if (noCompsMsg) noCompsMsg.classList.add("hidden");
    const comp = state.competitions[state.currentComp];
    if (comp) {
      const ended = isCompEnded(comp);
      const days = daysRemaining(comp);
      const winner = comp.winner ? state.employees[comp.winner] : null;

      // Competition name
      const nameEl = document.getElementById("pick-comp-name");
      if (nameEl) nameEl.textContent = comp.name;

      // Countdown number — urgent color if < 3 days, ended state
      const cntNum = document.getElementById("pick-countdown-num");
      const cntLabel = document.getElementById("pick-countdown-label");
      if (cntNum && cntLabel) {
        if (ended) {
          cntNum.textContent = "END";
          cntNum.className = "pick-countdown-num ended";
          cntLabel.textContent = "COMPETITION OVER";
        } else if (days !== null) {
          cntNum.textContent = days <= 0 ? "0" : days;
          cntNum.className = "pick-countdown-num" + (days <= 3 ? " urgent" : "");
          cntLabel.textContent = days === 1 ? "DAY LEFT" : "DAYS LEFT";
        }
      }

      // Prize pill
      const prizePill = document.getElementById("pick-prize-pill");
      const prizeText = document.getElementById("pick-prize-text");
      if (prizePill && comp.prize) {
        const firstLine = comp.prize.split("\n")[0].replace(/^[•→\-\s]+/, "").trim();
        if (prizeText) prizeText.textContent = firstLine.substring(0, 40) + (firstLine.length > 40 ? "…" : "");
        prizePill.style.display = "flex";
      } else if (prizePill) {
        prizePill.style.display = "none";
      }

      // Dates
      const datesEl = document.getElementById("pick-comp-dates");
      if (datesEl && comp.startDate && comp.endDate) {
        datesEl.textContent = `${formatDate(comp.startDate)} → ${formatDate(comp.endDate)}`;
      }

      // Winner row
      const winnerRow = document.getElementById("pick-winner-row");
      const winnerText = document.getElementById("pick-winner-text");
      if (winnerRow) {
        if (ended && winner) {
          if (winnerText) winnerText.textContent = `${winner.name} won!`;
          winnerRow.style.display = "flex";
        } else {
          winnerRow.style.display = "none";
        }
      }

      // Goal bars (collapsible)
      const goalsSection = document.getElementById("pick-comp-goals");
      const goalsContent = document.getElementById("pick-goals-content");
      const compGoals = getCompGoals(state.currentComp);
      const todayDate = getTodayDate();
      const todayGoal = compGoals[`daily_${todayDate}`];
      const compLogs = state.logs[state.currentComp] || {};
      let storeTotalSales = 0, storeTodaySales = 0;
      Object.values(compLogs).forEach(empLogs => {
        Object.entries(empLogs || {}).forEach(([date, log]) => {
          storeTotalSales += log.sales || 0;
          if (date === todayDate) storeTodaySales += log.sales || 0;
        });
      });
      let goalsHtml = "";
      if (compGoals.competition?.value) {
        goalsHtml += `<div class="comp-detail"><div class="detail-label">Competition Goal: <span class="detail-label-goal">$${compGoals.competition.value}</span></div>${renderGoalBar(storeTotalSales, compGoals.competition.value, "total")}</div>`;
      }
      if (todayGoal?.value) {
        goalsHtml += `<div class="comp-detail" style="margin-top:12px"><div class="detail-label">Today's Goal: <span class="detail-label-goal">$${todayGoal.value}</span></div>${renderGoalBar(storeTodaySales, todayGoal.value, "total")}</div>`;
      }
      if (goalsSection) goalsSection.style.display = goalsHtml ? "block" : "none";
      if (goalsContent) goalsContent.innerHTML = goalsHtml;

      compInfo.classList.remove("hidden");
    }
  }

  // Daily goals are now shown in competition info card, hide this duplicate
  const goalsEl = document.getElementById("pick-goals");
  if (goalsEl) {
    goalsEl.classList.add("hidden");
  }

  const grid = document.getElementById("name-grid");
  if (!grid) return;
  grid.innerHTML = "";

  const hasLogs = hasLogsInComp(state.currentComp);
  const players = hasLogs ? getRankedPlayers(state.currentComp) : getAlphabeticalPlayers(state.currentComp);
  const filtered = Object.entries(state.employees)
    .filter(([, emp]) => emp.name.toLowerCase().includes(filterText.toLowerCase()));

  if (filtered.length === 0) {
    grid.classList.add("empty");
    grid.innerHTML = filterText ? "No employees found" : "No employees yet — add them in Manager";
    document.getElementById("search-results-info")?.classList.add("hidden");
    return;
  }

  grid.classList.remove("empty");
  const resultsInfo = document.getElementById("search-results-info");
  if (resultsInfo) {
    if (filterText) {
      resultsInfo.textContent = `${filtered.length} of ${Object.keys(state.employees).length} employees`;
      resultsInfo.classList.remove("hidden");
    } else {
      resultsInfo.classList.add("hidden");
    }
  }

  filtered.forEach(([id, emp]) => {
    const rank = players.findIndex(p => p.id === id);
    const pip = hasLogs && (rank === 0 ? "👑" : rank === 1 ? "🥈" : rank === 2 ? "🥉" : "");
    const isWinner = state.competitions[state.currentComp]?.winner === id;
    const btn = document.createElement("button");
    btn.className = `name-btn${isWinner ? " name-btn-winner" : ""}`;
    btn.innerHTML = `
      ${getAvatarHtml(emp, "small", id)}
      <div>
        ${pip ? `<span class="rank-pip">${pip}</span>` : ""}${isWinner ? "🏆 " : ""}${emp.name}
      </div>
    `;
    btn.onclick = () => enterAsDashboard(id);
    grid.appendChild(btn);
  });
}

// ══════════════════════════════════════════════════════
// Screen management
// ══════════════════════════════════════════════════════
function showScreen(name) {
  document.querySelectorAll(".screen").forEach(s => s.classList.remove("active"));
  const el = document.getElementById(`screen-${name}`);
  if (el) el.classList.add("active");
  state.currentScreen = name;
  window.scrollTo(0, 0);

  // Hide header on home page
  const header = document.getElementById("app-header");
  if (name === "pick") {
    header.classList.add("hidden");
  } else {
    header.classList.remove("hidden");
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
    selectorBtn.textContent = "Tap to select your name...";
    selectorBtn.classList.remove("has-selection");
  }

  const empGrid = document.getElementById("pick-emp-grid");
  if (empGrid) empGrid.classList.toggle("hidden", !openGrid);

  const searchEl = document.getElementById("pick-emp-search");
  if (searchEl) searchEl.value = "";
  if (openGrid) {
    renderPickEmpGrid();
    if (searchEl) searchEl.focus();
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
        <div class="pick-selected-emp-name">${emp.name}</div>
      </div>
      <button class="pick-selected-clear-btn" id="pick-clear-emp-btn" type="button" title="Choose a different employee" aria-label="Choose a different employee">✕</button>
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

function promptPickAvatarUpload(empId) {
  let modal = document.getElementById("pick-avatar-upload-modal");
  if (!modal) {
    modal = document.createElement("div");
    modal.id = "pick-avatar-upload-modal";
    modal.className = "pick-avatar-upload-modal";
    document.body.appendChild(modal);
    modal.addEventListener("click", (e) => {
      if (e.target === modal) closePickAvatarUploadModal();
    });
  }

  modal.innerHTML = `
    <div class="pick-avatar-upload-sheet">
      <div class="pick-avatar-upload-header">
        <div class="pick-avatar-upload-title">Update Photo</div>
        <button class="pick-avatar-upload-close" id="pick-avatar-upload-close" type="button" aria-label="Close upload options">✕</button>
      </div>
      <div class="pick-avatar-upload-subtitle">Choose how you want to upload your avatar.</div>
      <div class="pick-avatar-upload-actions">
        <button class="pick-avatar-upload-option" id="pick-avatar-take-photo" type="button">
          <span class="pick-avatar-upload-option-icon">📸</span>
          <span class="pick-avatar-upload-option-copy">
            <strong>Take photo</strong>
            <span>Open the camera</span>
          </span>
        </button>
        <button class="pick-avatar-upload-option" id="pick-avatar-choose-photo" type="button">
          <span class="pick-avatar-upload-option-icon">🖼️</span>
          <span class="pick-avatar-upload-option-copy">
            <strong>Choose photo</strong>
            <span>Pick from your photos</span>
          </span>
        </button>
        <button class="pick-avatar-upload-option" id="pick-avatar-choose-file" type="button">
          <span class="pick-avatar-upload-option-icon">📁</span>
          <span class="pick-avatar-upload-option-copy">
            <strong>Choose from files</strong>
            <span>Browse files on this device</span>
          </span>
        </button>
      </div>
    </div>
  `;

  modal.classList.add("active");
  modal.querySelector("#pick-avatar-upload-close").onclick = closePickAvatarUploadModal;
  modal.querySelector("#pick-avatar-take-photo").onclick = () => triggerAvatarFileInput(empId, { accept: "image/*", capture: "environment" });
  modal.querySelector("#pick-avatar-choose-photo").onclick = () => triggerAvatarFileInput(empId, { accept: "image/*" });
  modal.querySelector("#pick-avatar-choose-file").onclick = () => triggerAvatarFileInput(empId, { accept: "image/*,.heic,.heif,.png,.jpg,.jpeg,.webp" });
}

function closePickAvatarUploadModal() {
  const modal = document.getElementById("pick-avatar-upload-modal");
  if (modal) modal.classList.remove("active");
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

  const filtered = Object.entries(state.employees)
    .filter(([, emp]) => emp.name.toLowerCase().includes(filterText.toLowerCase()))
    .sort(([, a], [, b]) => a.name.localeCompare(b.name));

  if (searchInfo) {
    if (filterText) {
      searchInfo.textContent = `${filtered.length} of ${Object.keys(state.employees).length} employees`;
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
    const pip = hasLogs && rankIdx >= 0 ? (rankIdx === 0 ? "👑" : rankIdx === 1 ? "🥈" : rankIdx === 2 ? "🥉" : "") : "";
    const isWinner = state.competitions[state.currentComp]?.winner === id;
    const btn = document.createElement("button");
    btn.className = `name-btn${isWinner ? " name-btn-winner" : ""}`;
    btn.innerHTML = `${getAvatarHtml(emp, "small", id)} <span>${pip ? `<span class="rank-pip">${pip}</span> ` : ""}${emp.name}</span>`;
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

  document.getElementById("dash-name").textContent = emp.name.toUpperCase();
  const comp = state.competitions[state.currentComp];
  document.getElementById("dash-comp-name").textContent = comp ? comp.name : "";

  // Render competition info card on dashboard
  const dashCompInfoEl = document.getElementById("dash-comp-info");
  if (dashCompInfoEl && comp) {
    const ended = isCompEnded(comp);
    const days = daysRemaining(comp);
    const winner = comp.winner ? state.employees[comp.winner] : null;

    let statusHtml = "";
    if (ended && winner) {
      statusHtml = `<div class="status-badge winner">🏆</div><div class="status-text">${winner.name} won!</div>`;
    } else if (!ended && days !== null) {
      const dayText = days <= 0 ? "Ends today" : `${days} day${days !== 1 ? "s" : ""} left`;
      statusHtml = `<div class="status-badge active">⏱️</div><div class="status-text">${dayText}</div>`;
    }

    let metaHtml = "";
    if (comp.startDate && comp.endDate) {
      metaHtml += `<span>${formatDate(comp.startDate)} → ${formatDate(comp.endDate)}</span>`;
    }

    const compGoals = getCompGoals(state.currentComp);
    let detailsHtml = "";
    if (compGoals.competition?.value) {
      const g = compGoals.competition;
      const sph = getPlayerSph(state.currentUser, state.currentComp);
      const current = g.type === "sph" ? sph.sph : sph.total;
      detailsHtml = `
        <div class="dash-comp-details">
          <div class="comp-detail">
            <div class="detail-label">COMPETITION GOAL</div>
            ${renderGoalBar(current, g.value, g.type)}
          </div>
        </div>
      `;
    }

    dashCompInfoEl.innerHTML = `
      <div class="dash-comp-info-header">
        <div>
          <div class="dash-comp-name">${comp.name}</div>
          <div class="dash-comp-meta">${metaHtml}</div>
        </div>
        <div class="dash-comp-status-badge">${statusHtml}</div>
      </div>
      ${detailsHtml}
    `;
    dashCompInfoEl.classList.remove("hidden");
  } else if (dashCompInfoEl) {
    dashCompInfoEl.classList.add("hidden");
  }

  const myLogs = (state.logs[state.currentComp] || {})[state.currentUser] || {};
  let totalSales = 0, totalHours = 0;
  Object.values(myLogs).forEach(d => { totalSales += d.sales || 0; totalHours += d.hours || 0; });
  const sph = totalHours > 0 ? totalSales / totalHours : 0;
  const hasLogs = Object.keys(myLogs).length > 0;

  // Hide stat cards if no logs exist in the competition yet
  const statRow = document.querySelector(".stat-row");
  if (statRow) {
    const compHasLogs = hasLogsInComp(state.currentComp);
    statRow.style.display = compHasLogs ? "grid" : "none";

    if (compHasLogs) {
      document.getElementById("stat-sph").textContent   = `$${sph.toFixed(0)}`;
      document.getElementById("stat-total").textContent = `$${totalSales.toFixed(0)}`;
      const ranked = getRankedPlayers(state.currentComp);
      const myRank = ranked.findIndex(r => r.id === state.currentUser) + 1;
      document.getElementById("stat-rank").textContent = myRank > 0 ? `#${myRank}` : "—";
    }
  }

  const vibe = getVibe(sph, totalSales, hasLogs, emp.name);
  document.getElementById("vibe-emoji").textContent = "🔥";
  document.getElementById("vibe-text").textContent  = vibe;

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

  // Goals
  const goalsEl = document.getElementById("dash-goals");
  if (goalsEl) {
    const compGoals = getCompGoals(state.currentComp);
    let goalsHtml = "";
    if (compGoals.competition?.value) {
      const g = compGoals.competition;
      goalsHtml += `<div class="goal-block"><div class="goal-label">🎯 Competition Goal</div>${renderGoalBar(g.type === "sph" ? sph : totalSales, g.value, g.type)}</div>`;
    }
    if (compGoals.daily?.value) {
      const g = compGoals.daily;
      const d = getTodaySph(state.currentUser, state.currentComp);
      goalsHtml += `<div class="goal-block"><div class="goal-label">☀️ Daily Goal</div>${renderGoalBar(d.total, g.value, "total")}</div>`;
    }
    goalsEl.innerHTML = goalsHtml;
    goalsEl.style.display = goalsHtml ? "flex" : "none";
  }

  // Week view with dates
  const week = getWeekForDate(state.selectedDate);
  const dayRow = document.getElementById("day-row");
  dayRow.innerHTML = `<button class="week-nav-btn" id="prev-week-btn">←</button>`;

  const todayStr = getTodayDate();
  week.days.forEach(dayInfo => {
    const hasEntry = myLogs[dayInfo.date] && (myLogs[dayInfo.date].sales > 0 || myLogs[dayInfo.date].hours > 0);
    const isFutureDate = dayInfo.date > todayStr;
    const isToday = dayInfo.date === todayStr;
    const isSelected = state.selectedDate === dayInfo.date;
    const classes = ["day-btn"];
    if (isToday && !isSelected) classes.push("today");
    if (isSelected) classes.push("active");
    if (hasEntry) classes.push("logged");
    if (isFutureDate) classes.push("disabled");
    const btn = document.createElement("button");
    btn.className = classes.join(" ");
    btn.innerHTML = `<div class="day-btn-dayname">${dayInfo.dayName}</div><div class="day-btn-date">${dayInfo.dayNum}</div>${hasEntry ? '<div class="day-btn-checkmark">✓</div>' : ''}`;

    if (!isFutureDate) {
      btn.onclick = () => { state.selectedDate = dayInfo.date; renderDash(); };
    } else {
      btn.disabled = true;
    }
    dayRow.appendChild(btn);
  });

  dayRow.appendChild(makeBtn("→", "week-nav-btn", () => { state.selectedDate = nextWeek(state.selectedDate); renderDash(); }));
  document.getElementById("prev-week-btn").onclick = () => { state.selectedDate = prevWeek(state.selectedDate); renderDash(); };

  const existing = myLogs[state.selectedDate];
  const isLocked = !!(existing && (existing.sales > 0 || existing.hours > 0));
  const salesInput = document.getElementById("input-sales");
  const hoursInput = document.getElementById("input-hours");
  const logBtn = document.getElementById("btn-log");

  salesInput.value = existing ? existing.sales || "" : "";
  hoursInput.value = existing ? existing.hours || "" : "";

  if (isLocked) {
    salesInput.readOnly = true; hoursInput.readOnly = true;
    salesInput.classList.add("input-locked"); hoursInput.classList.add("input-locked");
    logBtn.disabled = true;
    logBtn.classList.remove("btn-disabled");
    logBtn.classList.add("btn-locked");
    logBtn.textContent = "✓ Logged — See Manager to Edit";
  } else {
    salesInput.readOnly = false; hoursInput.readOnly = false;
    salesInput.classList.remove("input-locked"); hoursInput.classList.remove("input-locked");
    logBtn.disabled = false;
    logBtn.classList.remove("btn-locked");
    logBtn.classList.remove("btn-disabled");
    logBtn.textContent = "+ LOG IT";
  }

  const historyList = document.getElementById("history-list");
  historyList.innerHTML = "";
  const hasAnyLogs = Object.keys(myLogs).length > 0;
  if (!hasAnyLogs) {
    historyList.innerHTML = `<p style="color:var(--text3);font-size:0.8rem;text-align:center;padding:16px">No logs yet this competition</p>`;
  } else {
    const sortedDates = Object.keys(myLogs).sort().reverse();
    sortedDates.forEach(date => {
      const log = myLogs[date];
      if (!log) return;
      const daySph = log.hours > 0 ? (log.sales / log.hours) : 0;
      const d = new Date(date + "T00:00:00");
      const dayName = DAYS[d.getDay()]; // 0=Sun, 1=Mon ... 6=Sat
      const dayNum = d.getDate();
      const item = document.createElement("div");
      item.className = "history-item";
      item.innerHTML = `
        <div class="history-day">${dayName} ${dayNum}</div>
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
function renderBoardCompSelect() {
  const sel = document.getElementById("board-comp-select");
  if (!sel) return;
  sel.innerHTML = "";

  const nonArchivedComps = Object.entries(state.competitions)
    .filter(([, c]) => c.status !== "archived")
    .sort(([, a], [, b]) => (b.createdAt || 0) - (a.createdAt || 0));

  if (nonArchivedComps.length === 0) {
    sel.style.display = "none";
    return;
  }

  sel.style.display = "block";
  nonArchivedComps.forEach(([id, comp]) => {
    const opt = document.createElement("option");
    opt.value = id;
    opt.textContent = comp.name;
    if (id === state.boardComp) opt.selected = true;
    sel.appendChild(opt);
  });
  sel.onchange = () => { state.boardComp = sel.value; renderBoard(); };
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
        <div class="board-empty-icon">🏆</div>
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
        <div class="board-empty-icon">🏁</div>
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
        <div class="board-empty-icon">🏁</div>
        <div class="board-empty-title">NO ORDERS YET</div>
        <div class="board-empty-sub">The scoreboard is empty. Log your first OIS and lead the pack!</div>
        <button class="board-empty-cta" onclick="document.getElementById('nav-home').click()">+ LOG AN ORDER</button>
      </div>
    `;
    return;
  }

  // Has logs - show ranked list
  const metric = state.settings.rankingMetric || "sph";
  const topVal = metric === "sph" ? (players[0]?.sph || 1) : (players[0]?.total || 1);
  const winner = comp?.winner;
  const tiedByMetric = (a, b) => {
    if (!a || !b) return false;
    const aVal = metric === "sph" ? a.sph : a.total;
    const bVal = metric === "sph" ? b.sph : b.total;
    return Math.abs(aVal - bVal) < 0.001;
  };
  const getDisplayRank = (index) => {
    if (index <= 0) return 1;
    return tiedByMetric(players[index], players[index - 1]) ? getDisplayRank(index - 1) : index + 1;
  };

  function makeBoardCard(player, index, tieGroupSize = 1) {
    const displayRank = getDisplayRank(index);
    const rankLabel = index === 0 ? "👑" : displayRank <= 3
      ? (displayRank === 2 ? "🥈" : "🥉")
      : `#${displayRank}`;
    const val = metric === "sph" ? player.sph : player.total;
    const pct = topVal > 0 ? Math.max(4, (val / topVal) * 100) : 4;
    const isWinner = winner === player.id;
    const emp = state.employees[player.id];
    const card = document.createElement("div");
    const isCurrentUser = state.currentUser === player.id;
    const rankClasses = ["board-card"];
    if (displayRank <= 3) rankClasses.push(`rank-${displayRank}`);
    if (isWinner) rankClasses.push("winner-card");
    if (isCurrentUser) rankClasses.push("is-you");
    if (tieGroupSize > 1) rankClasses.push("tie-card");
    card.className = rankClasses.join(" ");
    card.style.animationDelay = `${index * 0.06}s`;
    card.innerHTML = `
      <div class="board-rank">${isWinner ? "🏆" : rankLabel}</div>
      <div class="board-info">
        <div class="board-name-row">
          ${getAvatarHtml(emp || { name: player.name }, "small", player.id)}
          <div class="board-name">
            ${player.name}${isWinner ? " <span class='winner-label'>WINNER</span>" : ""}
          </div>
        </div>
        <div class="board-meta">$${player.total.toFixed(2)} total · ${player.hours.toFixed(1)} hrs</div>
        <div class="board-bar-wrap"><div class="board-bar" style="width:${pct}%"></div></div>
      </div>
      <div>
        <div class="board-sph">$${player.sph.toFixed(0)}</div>
        <div class="board-sph-label">/HR</div>
      </div>
    `;
    card.onclick = () => {
      if (state.currentUser !== player.id) {
        state.currentUser = player.id;
        renderDash();
      }
      showScreen("dash");
    };
    return card;
  }

  for (let i = 0; i < players.length; i++) {
    const tieGroup = [players[i]];
    let j = i + 1;
    while (j < players.length && tiedByMetric(players[j - 1], players[j])) {
      tieGroup.push(players[j]);
      j++;
    }

    if (tieGroup.length > 1) {
      const wrap = document.createElement("div");
      wrap.className = "board-tie-group";
      wrap.innerHTML = `<div class="board-tie-group-label">Tied at #${getDisplayRank(i)}</div>`;
      tieGroup.forEach((tiedPlayer, offset) => {
        wrap.appendChild(makeBoardCard(tiedPlayer, i + offset, tieGroup.length));
      });
      body.appendChild(wrap);
      i = j - 1;
      continue;
    }

    body.appendChild(makeBoardCard(players[i], i));
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
    .map(([id, emp]) => {
      const empLogs = compLogs[id] || {};
      let total = 0, hours = 0;
      Object.values(empLogs).forEach(log => { total += log.sales || 0; hours += log.hours || 0; });
      return { id, name: emp.name, total, hours, sph: hours > 0 ? total / hours : 0 };
    })
    .sort((a, b) => a.name.localeCompare(b.name));
}

function getRankedPlayers(compId) {
  const compLogs = state.logs[compId] || {};
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

// ══════════════════════════════════════════════════════
// Log entry
// ══════════════════════════════════════════════════════
async function logEntry() {
  const sales = parseFloat(document.getElementById("input-sales").value);
  const hours = parseFloat(document.getElementById("input-hours").value);
  if (isNaN(sales) || sales < 0) { showToast("Enter a valid sales amount 💸"); return; }
  if (isNaN(hours) || hours <= 0) { showToast("Enter hours worked ⏱️"); return; }
  if (state.competitions[state.currentComp]?.status === "closed") { showToast("This competition is closed 🔒"); return; }

  const today = getTodayDate();
  if (state.selectedDate > today) { showToast("Can't log orders in the future 🔮"); return; }

  // Block overwriting an existing log
  const existingLog = (state.logs[state.currentComp] || {})[state.currentUser]?.[state.selectedDate];
  if (existingLog && (existingLog.sales > 0 || existingLog.hours > 0)) {
    showToast("Already logged for this day — see a manager to edit 🔒"); return;
  }

  await set(dbRef.dateLog(state.currentComp, state.currentUser, state.selectedDate), { sales, hours });
  const reaction = getBigOrderReaction(sales);
  if (reaction) { showToast(reaction, 3500); launchConfetti(); }
  else showToast("Logged! Keep grinding 💪");
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
  renderAdminSummaryBar();
  renderAdminTab();
  renderAdminTabBar();
  showScreen("admin");
}

function renderAdminTabBar() {
  const tabs = [
    { id: "competitions", label: "🏆 Comps" },
    { id: "employees",    label: "👥 Team" },
    { id: "logs",         label: "📋 Logs" },
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
  }
}

// ══════════════════════════════════════════════════════
// ADMIN — Competitions
// ══════════════════════════════════════════════════════
function renderAdminComps(container) {
  container.innerHTML = `<div class="admin-section-title" style="margin-bottom:12px;">COMPETITIONS</div>`;
  const entries = Object.entries(state.competitions);
  const toShow = state.admin.showAllComps ? entries : entries.slice(0, PREVIEW_COUNT);
  const list = document.createElement("div");
  list.className = "admin-list";

  toShow.forEach(([id, comp]) => {
    const item = document.createElement("div");
    item.className = "admin-item";
    item.id = `admin-comp-item-${id}`;
    const dot = isCompEnded(comp) ? "🏁" : comp.status === "closed" ? "🔒" : comp.status === "archived" ? "📦" : "🟢";
    
    const leftPart = document.createElement("div");
    leftPart.className = "admin-item-left";
    leftPart.innerHTML = `<span class="admin-item-name">${dot} ${comp.name}</span>`;
    item.appendChild(leftPart);
    
    const rightPart = document.createElement("div");
    rightPart.className = "admin-item-actions";
    rightPart.appendChild(makeBtn("✏️ Edit", "del-btn", () => renderCompEditPanel(id, comp)));
    item.appendChild(rightPart);
    
    list.appendChild(item);
  });
  container.appendChild(list);

  if (entries.length > PREVIEW_COUNT) {
    container.appendChild(makeBtn(
      state.admin.showAllComps ? "Show less ▲" : `View all ${entries.length} ▼`,
      "view-all-btn",
      () => { state.admin.showAllComps = !state.admin.showAllComps; renderAdminTab(); }
    ));
  }

  // New competition form
  const newCompSection = document.createElement("div");
  newCompSection.className = "goal-admin-block";
  newCompSection.style.marginTop = "14px";

  const toggleBtn = document.createElement("button");
  toggleBtn.className = "collapsible-toggle";
  toggleBtn.innerHTML = `+ NEW COMPETITION <span class="collapsible-toggle-icon">▼</span>`;

  const collapsibleContent = document.createElement("div");
  collapsibleContent.id = "new-comp-form";
  collapsibleContent.style.display = "none";
  collapsibleContent.style.marginTop = "8px";
  collapsibleContent.innerHTML = `
    <div style="margin-top:8px;">
      <label class="field-label">NAME *</label>
      <input type="text" id="input-new-comp" class="log-input" placeholder="e.g.OIS Competition" style="margin-bottom:8px;" />
    </div>
    <div style="margin-top:4px;">
      <label class="field-label">PRIZES</label>
      <div class="prize-format-toolbar">
        <button type="button" class="prize-format-btn" data-action="bullet">• Bullet</button>
        <button type="button" class="prize-format-btn" data-action="indent">   - Sub-item</button>
        <button type="button" class="prize-format-btn" data-action="emphasis">→ Emphasis</button>
      </div>
      <textarea id="input-new-comp-prize" class="prize-textarea" placeholder="e.g. • $50 gift card&#10;   - Redeemable anytime&#10;• Extra shifts"></textarea>
    </div>
    <div class="log-fields" style="margin-bottom:8px;">
      <div class="log-field-wrap">
        <label class="field-label">START DATE *</label>
        <input type="date" id="input-new-comp-start" class="log-input" />
      </div>
      <div class="log-field-wrap">
        <label class="field-label">END DATE *</label>
        <input type="date" id="input-new-comp-end" class="log-input" />
      </div>
    </div>
    <button class="log-btn btn-ghost" id="btn-add-comp" disabled>+ CREATE COMPETITION</button>
  `;

  newCompSection.appendChild(toggleBtn);
  newCompSection.appendChild(collapsibleContent);
  container.appendChild(newCompSection);

  // Toggle functionality
  toggleBtn.onclick = () => {
    const isHidden = collapsibleContent.style.display === "none";
    collapsibleContent.style.display = isHidden ? "block" : "none";
    toggleBtn.classList.toggle("expanded", isHidden);
  };

  // Setup formatting buttons for new competition
  setupPrizeFormatButtons("input-new-comp-prize");

  const checkReady = () => {
    const name = document.getElementById("input-new-comp")?.value.trim();
    const start = document.getElementById("input-new-comp-start")?.value;
    const end = document.getElementById("input-new-comp-end")?.value;
    const btn = document.getElementById("btn-add-comp");
    if (!btn) return;
    const ready = !!(name && start && end && start <= end);
    btn.disabled = !ready;
    btn.classList.toggle("btn-ghost", !ready);
  };
  document.getElementById("input-new-comp").oninput = checkReady;
  document.getElementById("input-new-comp-start").onchange = checkReady;
  document.getElementById("input-new-comp-end").onchange = checkReady;

  document.getElementById("btn-add-comp").onclick = async () => {
    const name = document.getElementById("input-new-comp").value.trim();
    const prize = document.getElementById("input-new-comp-prize").value.trim();
    const startDate = document.getElementById("input-new-comp-start").value;
    const endDate = document.getElementById("input-new-comp-end").value;
    if (!name || !startDate || !endDate) return;
    const id = `comp_${Date.now()}`;
    await set(dbRef.comp(id), { name, prize, startDate, endDate, createdAt: Date.now(), status: "active" });
    showToast(`"${name}" created! 🏆`);
    ["input-new-comp","input-new-comp-prize","input-new-comp-start","input-new-comp-end"].forEach(i => {
      const el = document.getElementById(i);
      if (el) el.value = "";
    });
    checkReady();
  };
}

function renderCompEditPanel(compId, comp) {
  const content = document.getElementById("admin-tab-content");
  content.innerHTML = "";
  content.appendChild(makeBtn("← Back", "del-btn", () => { state.admin.tab = "competitions"; renderAdminTabBar(); renderAdminTab(); }));

  const title = document.createElement("div");
  title.className = "admin-section-title";
  title.style.margin = "12px 0";
  title.textContent = `EDIT: ${comp.name}`;
  content.appendChild(title);

  // Track original values and changes
  const originalValues = {
    name: comp.name,
    startDate: comp.startDate || "",
    endDate: comp.endDate || "",
    prize: comp.prize || "",
    status: comp.status,
    winner: comp.winner || "",
    competitionGoal: getCompGoals(compId).competition?.value || "",
  };

  const changedFields = {};
  const dailyGoalChanges = {};

  const highlightField = (id) => {
    const el = document.getElementById(id);
    if (el && changedFields[id]) {
      el.style.borderColor = "var(--accent)";
      el.style.borderWidth = "2px";
    } else if (el) {
      el.style.borderColor = "";
      el.style.borderWidth = "";
    }
  };

  const addChangeListener = (id, originalValue) => {
    const el = document.getElementById(id);
    if (!el) return;
    const checkChange = () => {
      const currentValue = el.value;
      if (currentValue !== originalValue) {
        changedFields[id] = true;
      } else {
        delete changedFields[id];
      }
      highlightField(id);
    };
    el.addEventListener("input", checkChange);
    el.addEventListener("change", checkChange);
  };

  [
    { label: "Competition Name", key: "name", type: "text", value: comp.name },
    { label: "Start Date", key: "startDate", type: "date", value: comp.startDate || "" },
    { label: "End Date", key: "endDate", type: "date", value: comp.endDate || "" },
  ].forEach(f => {
    const wrap = document.createElement("div");
    wrap.style.marginBottom = "10px";
    wrap.innerHTML = `<label class="field-label">${f.label}</label><input type="${f.type}" id="comp-edit-${f.key}" class="log-input" value="${f.value}" placeholder="${f.label}" />`;
    content.appendChild(wrap);
    addChangeListener(`comp-edit-${f.key}`, f.value);
  });

  // Prize field with formatting toolbar
  const prizeWrap = document.createElement("div");
  prizeWrap.style.marginBottom = "10px";
  prizeWrap.innerHTML = `
    <label class="field-label">PRIZES</label>
    <div class="prize-format-toolbar">
      <button type="button" class="prize-format-btn" data-action="bullet">• Bullet</button>
      <button type="button" class="prize-format-btn" data-action="indent">   - Sub-item</button>
      <button type="button" class="prize-format-btn" data-action="emphasis">→ Emphasis</button>
    </div>
    <textarea id="comp-edit-prize" class="prize-textarea">${escapeHtml(comp.prize || "")}</textarea>
  `;
  content.appendChild(prizeWrap);
  setupPrizeFormatButtons("comp-edit-prize");
  addChangeListener("comp-edit-prize", comp.prize || "");

  const statusWrap = document.createElement("div");
  statusWrap.style.marginBottom = "10px";
  statusWrap.innerHTML = `<label class="field-label">STATUS</label>`;
  const statusSel = document.createElement("select");
  statusSel.className = "log-input"; statusSel.id = "comp-edit-status";
  ["draft", "active", "closed"].forEach(s => {
    const opt = document.createElement("option");
    opt.value = s; opt.textContent = s.charAt(0).toUpperCase() + s.slice(1);
    if (comp.status === s) opt.selected = true;
    statusSel.appendChild(opt);
  });
  statusWrap.appendChild(statusSel);
  content.appendChild(statusWrap);
  addChangeListener("comp-edit-status", comp.status);

  const winnerWrap = document.createElement("div");
  winnerWrap.style.marginBottom = "10px";
  winnerWrap.innerHTML = `<label class="field-label">WINNER (auto-set when ended, or override)</label>`;
  const winnerSel = document.createElement("select");
  winnerSel.className = "log-input"; winnerSel.id = "comp-edit-winner";
  const noWin = document.createElement("option");
  noWin.value = ""; noWin.textContent = "— Auto / No winner set —";
  winnerSel.appendChild(noWin);
  Object.entries(state.employees)
    .sort(([, a], [, b]) => a.name.localeCompare(b.name))
    .forEach(([id, emp]) => {
      const opt = document.createElement("option");
      opt.value = id; opt.textContent = emp.name;
      if (comp.winner === id) opt.selected = true;
      winnerSel.appendChild(opt);
    });
  winnerWrap.appendChild(winnerSel);
  content.appendChild(winnerWrap);
  addChangeListener("comp-edit-winner", comp.winner || "");

  // ═══ Goals Section ═══
  const goalsTitle = document.createElement("div");
  goalsTitle.className = "admin-section-title";
  goalsTitle.style.margin = "20px 0 12px 0";
  goalsTitle.textContent = "GOALS";
  content.appendChild(goalsTitle);

  const compGoals = getCompGoals(compId);

  // Competition Total Goal
  const compGoalSection = document.createElement("div");
  compGoalSection.className = "goal-admin-block";
  compGoalSection.innerHTML = `
    <div class="goal-admin-label">🎯 Competition Total Goal</div>
    <div class="goal-admin-hint">Overall total sales target</div>
    <div style="display:flex;align-items:center;margin-top:8px;gap:8px;">
      <label class="field-label" style="margin:0;min-width:60px;">TYPE</label>
      <span style="color:var(--text2);font-weight:500;">Total Sales</span>
    </div>
    <div style="margin-top:8px;">
      <label class="field-label">TARGET</label>
      <input type="number" id="goal-val-competition" class="log-input" placeholder="e.g. 5000" value="${compGoals.competition?.value || ""}" min="0" step="1" />
    </div>
  `;
  content.appendChild(compGoalSection);
  addChangeListener("goal-val-competition", compGoals.competition?.value || "");

  // Daily Goals by Week
  const dailyGoalsSection = document.createElement("div");
  dailyGoalsSection.className = "goal-admin-block";
  dailyGoalsSection.style.marginTop = "16px";
  dailyGoalsSection.innerHTML = `<div class="goal-admin-label" style="margin-bottom:8px;">☀️ Daily Goals by Week</div>`;
  content.appendChild(dailyGoalsSection);

  const weekPickerWrap = document.createElement("div");
  weekPickerWrap.style.marginBottom = "12px";
  weekPickerWrap.innerHTML = `
    <label class="field-label">SELECT WEEK</label>
    <input type="date" id="daily-goal-week-picker" class="log-input" value="${comp.startDate || ""}" />
  `;
  dailyGoalsSection.appendChild(weekPickerWrap);

  const daysOfWeek = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];
  const dailyGoalsGrid = document.createElement("div");
  dailyGoalsGrid.id = "daily-goals-grid";
  dailyGoalsGrid.style.marginTop = "12px";
  dailyGoalsSection.appendChild(dailyGoalsGrid);

  const renderDailyGoalsForWeek = (dateStr) => {
    const baseDate = new Date(dateStr + "T00:00:00");
    const dayOfWeek = baseDate.getDay();
    const startOfWeek = new Date(baseDate);
    startOfWeek.setDate(baseDate.getDate() - dayOfWeek);

    dailyGoalsGrid.innerHTML = "";
    for (let i = 0; i < 7; i++) {
      const d = new Date(startOfWeek);
      d.setDate(startOfWeek.getDate() + i);
      const dateString = d.toISOString().split("T")[0];
      const isInRange = dateString >= comp.startDate && dateString <= comp.endDate;

      if (!isInRange) continue;

      const dayGoal = compGoals[`daily_${dateString}`] || {};
      const fieldId = `daily-goal-${dateString}`;

      const dayCard = document.createElement("div");
      dayCard.className = "goal-day-card";
      dayCard.style.cssText = `
        padding:8px;
        border:2px solid var(--border);
        border-radius:8px;
      `;
      dayCard.innerHTML = `
        <div style="font-size:12px;color:var(--text2);margin-bottom:4px;font-weight:700;">${daysOfWeek[i]}</div>
        <div style="font-size:11px;color:var(--text3);margin-bottom:6px;">${dateString}</div>
        <div style="display:flex;align-items:center;gap:4px;">
          <input type="number" id="${fieldId}" data-date="${dateString}" class="daily-goal-input log-input" placeholder="0" value="${dayGoal.value || ""}" min="0" step="1" style="font-size:12px;padding:4px;width:40px;text-align:center;" />
          <span style="font-size:11px;color:var(--text2);">$/hr</span>
        </div>
      `;
      dailyGoalsGrid.appendChild(dayCard);

      // Track daily goal changes
      const input = document.getElementById(fieldId);
      input.addEventListener("input", () => {
        const value = input.value;
        if (value !== (dayGoal.value || "")) {
          dailyGoalChanges[dateString] = value ? parseFloat(value) : null;
          input.style.borderColor = "var(--accent)";
          input.style.borderWidth = "2px";
        } else {
          delete dailyGoalChanges[dateString];
          input.style.borderColor = "";
          input.style.borderWidth = "";
        }
      });
    }
  };

  const weekPicker = document.getElementById("daily-goal-week-picker");
  weekPicker.onchange = () => renderDailyGoalsForWeek(weekPicker.value);
  renderDailyGoalsForWeek(comp.startDate || getTodayDate());

  // ═══ Save All Button ═══
  const saveAllBtn = makeBtn("SAVE ALL CHANGES", "log-btn", async () => {
    // Save competition details
    await update(dbRef.comp(compId), {
      name: document.getElementById("comp-edit-name").value.trim() || comp.name,
      prize: document.getElementById("comp-edit-prize").value.trim(),
      startDate: document.getElementById("comp-edit-startDate").value,
      endDate: document.getElementById("comp-edit-endDate").value,
      status: document.getElementById("comp-edit-status").value,
      winner: document.getElementById("comp-edit-winner").value || null,
    });

    // Save competition goal
    const compGoalValue = parseFloat(document.getElementById("goal-val-competition").value);
    if (compGoalValue > 0) {
      await set(ref(db, `goals/${compId}/competition`), { type: "total", value: compGoalValue });
    } else {
      await remove(ref(db, `goals/${compId}/competition`));
    }

    // Save daily goals
    for (const [dateStr, value] of Object.entries(dailyGoalChanges)) {
      if (value > 0) {
        await set(ref(db, `goals/${compId}/daily_${dateStr}`), { type: "sph", value });
      } else {
        await remove(ref(db, `goals/${compId}/daily_${dateStr}`));
      }
    }

    showToast("All changes saved ✅");
    state.admin.tab = "competitions"; renderAdminTabBar(); renderAdminTab();
  });
  saveAllBtn.style.marginTop = "20px";
  content.appendChild(saveAllBtn);

  const delBtn = makeBtn("🗑️ Delete Competition", "del-btn danger", async () => {
    if (confirm(`Delete "${comp.name}"? All logs will be removed.`)) {
      await remove(dbRef.comp(compId));
      await remove(ref(db, `logs/${compId}`));
      delete state.logs[compId];
      state.admin.tab = "competitions"; renderAdminTabBar(); renderAdminTab();
    }
  });
  delBtn.style.marginTop = "8px";
  content.appendChild(delBtn);
}

// ══════════════════════════════════════════════════════
// ADMIN — Employees
// ══════════════════════════════════════════════════════

function renderAdminEmpsList() {
  const listContainer = document.getElementById("admin-emp-list-container");
  if (!listContainer) return;
  
  const search = state.admin.empSearch.toLowerCase();
  const allEntries = Object.entries(state.employees).sort(([, a], [, b]) => a.name.localeCompare(b.name));
  const filtered = search ? allEntries.filter(([, emp]) => emp.name.toLowerCase().includes(search)) : allEntries;
  const toShow = state.admin.showAllEmps ? filtered : filtered.slice(0, PREVIEW_COUNT);
  
  listContainer.innerHTML = "";
  const list = document.createElement("div");
  list.className = "admin-list";

  if (toShow.length === 0) {
    list.innerHTML = `<div style="color:var(--text3);font-size:0.8rem;text-align:center;padding:16px;">No employees found</div>`;
  } else {
    const today = getTodayDate();
    const compId = state.currentComp;
    toShow.forEach(([id, emp]) => {
      const item = document.createElement("div");
      item.className = "admin-item";
      item.id = `admin-emp-item-${id}`;

      const loggedToday = compId && !!(state.logs[compId]?.[id]?.[today]);
      
      const leftPart = document.createElement("div");
      leftPart.className = "admin-item-left";
      leftPart.innerHTML = `${getAvatarHtml(emp, "small", id)} <span class="admin-item-name">${emp.name}</span><div class="admin-today-dot ${loggedToday ? "logged" : "not-logged"}" title="${loggedToday ? "Logged today" : "Not logged yet"}"></div>`;
      item.appendChild(leftPart);
      
      const rightPart = document.createElement("div");
      rightPart.className = "admin-item-actions";
      rightPart.appendChild(makeBtn("✏️ Edit", "del-btn", () => openEditEmpModal(id, emp)));
      rightPart.appendChild(makeBtn("✕", "del-btn danger", async () => {
        if (confirm(`Remove "${emp.name}"?`)) await remove(dbRef.emp(id));
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
}

function renderAdminEmps(container) {
  container.innerHTML = `<div class="admin-section-title" style="margin-bottom:12px;">TEAM</div>`;
  
  // Check if search input already exists in DOM
  let searchInput = document.getElementById("admin-emp-search");
  if (!searchInput) {
    const searchWrap = document.createElement("div");
    searchWrap.innerHTML = `<input type="text" id="admin-emp-search" class="log-input" placeholder="Search employees..." style="margin-bottom:10px;" />`;
    container.appendChild(searchWrap);
    searchInput = document.getElementById("admin-emp-search");
    // Only attach listener once, not on every render
    searchInput.oninput = (e) => {
      state.admin.empSearch = e.target.value;
      state.admin.showAllEmps = false;
      renderAdminEmpsList(); // Call list-only render, not full tab render
    };
  } else {
    // Move existing search input to container
    container.insertBefore(searchInput, container.firstChild.nextSibling);
  }
  searchInput.value = state.admin.empSearch;

  // Create container for list (will be updated by renderAdminEmpsList)
  const listContainer = document.createElement("div");
  listContainer.id = "admin-emp-list-container";
  container.appendChild(listContainer);
  
  // Render the list
  renderAdminEmpsList();

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

// ══════════════════════════════════════════════════════
// ADMIN — Edit Employee Modal
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

      <div style="display:flex;gap:8px;margin-top:16px;">
        <button class="log-btn" id="avatar-save-btn">SAVE AVATAR</button>
        <button class="log-btn" id="avatar-cancel-btn" style="background:var(--bg);color:var(--text2);border:2px solid var(--border);box-shadow:none;">CANCEL</button>
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
        <input type="text" id="edit-emp-name" class="log-input" value="${emp.name}" placeholder="Employee name" />
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

      <div style="display:flex;gap:8px;margin-top:16px;">
        <button class="log-btn" id="emp-save-btn">SAVE CHANGES</button>
        <button class="log-btn" id="emp-cancel-btn" style="background:var(--bg);color:var(--text2);border:2px solid var(--border);box-shadow:none;">CANCEL</button>
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
// ADMIN — Logs
// ══════════════════════════════════════════════════════
function renderAdminLogs(container) {
  // Default selected date to today
  if (!state.admin.selectedDate) state.admin.selectedDate = getTodayDate();
  container.innerHTML = `<div class="admin-section-title" style="margin-bottom:12px;">MANAGE LOGS</div>`;

  const empWrap = document.createElement("div");
  empWrap.style.marginBottom = "10px";
  empWrap.innerHTML = `<label class="field-label">EMPLOYEE</label>`;
  const empSel = document.createElement("select");
  empSel.className = "log-input"; empSel.id = "admin-logs-emp";
  empSel.innerHTML = `<option value="">— Select employee —</option>`;
  Object.entries(state.employees)
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
  compSel.onchange = () => { state.admin.selectedComp = compSel.value; refreshAdminDayView(); };
  compWrap.appendChild(compSel);
  container.appendChild(compWrap);

  const dayLabel = document.createElement("label");
  dayLabel.className = "field-label"; dayLabel.style.marginBottom = "8px"; dayLabel.textContent = "DAY";
  container.appendChild(dayLabel);
  const daysContainer = document.createElement("div");
  daysContainer.className = "admin-day-buttons"; daysContainer.id = "admin-logs-days";
  container.appendChild(daysContainer);

  const detail = document.createElement("div");
  detail.className = "admin-log-detail-wrap"; detail.id = "admin-logs-detail";
  detail.style.marginTop = "14px";
  detail.innerHTML = `<p style="color:var(--text3);font-size:0.8rem;text-align:center;padding:20px;">Select an employee to view & manage their logs</p>`;
  container.appendChild(detail);

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
  const week = getWeekForDate(state.admin.selectedDate);

  dayContainer.innerHTML = `<button class="week-nav-btn" id="admin-prev-week-btn">←</button>`;

  week.days.forEach(dayInfo => {
    const hasLog = !!empLogs[dayInfo.date];
    const isFutureDate = dayInfo.date > getTodayDate();
    const btn = document.createElement("button");
    btn.className = `admin-day-btn${hasLog ? " has-log" : ""}${isFutureDate ? " disabled" : ""}`;
    btn.innerHTML = `<div class="admin-day-btn-dayname">${dayInfo.dayName}</div><div class="admin-day-btn-date">${dayInfo.dayNum}</div>${hasLog ? '<div style="font-size:8px;color:var(--green)">✓</div>' : ''}`;
    btn.title = hasLog ? `$${empLogs[dayInfo.date].sales} / ${empLogs[dayInfo.date].hours}hrs` : "No log yet";
    if (!isFutureDate) {
      btn.onclick = () => {
        document.querySelectorAll("#admin-logs-days .admin-day-btn").forEach(b => b.classList.remove("active"));
        btn.classList.add("active");
        if (hasLog) renderAdminLogDetail(empId, compId, dayInfo.date, empLogs[dayInfo.date]);
        else renderAdminLogCreate(empId, compId, dayInfo.date);
      };
    } else {
      btn.disabled = true;
      btn.onclick = () => showToast("Can't log future dates 🔮");
    }
    dayContainer.appendChild(btn);
  });

  const nextBtn = makeBtn("→", "week-nav-btn", () => {
    state.admin.selectedDate = nextWeek(state.admin.selectedDate);
    refreshAdminDayView();
  });
  nextBtn.id = "admin-next-week-btn";
  dayContainer.appendChild(nextBtn);

  document.getElementById("admin-prev-week-btn").onclick = () => {
    state.admin.selectedDate = prevWeek(state.admin.selectedDate);
    refreshAdminDayView();
  };

  // Auto-select the first logged date or the current selected date
  const autoDate = empLogs[state.admin.selectedDate] ? state.admin.selectedDate : (Object.keys(empLogs)[0] || week.days[0]?.date);
  const autoBtnIndex = week.days.findIndex(d => d.date === autoDate) + 1; // +1 for prev button
  const autoBtn = dayContainer.children[autoBtnIndex];
  if (autoBtn) {
    autoBtn.classList.add("active");
    const autoLog = empLogs[autoDate];
    if (autoLog) renderAdminLogDetail(empId, compId, autoDate, autoLog);
    else renderAdminLogCreate(empId, compId, autoDate);
  }
}

function renderAdminLogDetail(empId, compId, date, log) {
  const detail = document.getElementById("admin-logs-detail");
  if (!detail) return;
  const sph = log.hours > 0 ? (log.sales / log.hours).toFixed(0) : "—";
  const d = new Date(date + "T00:00:00");
  const dayName = DAYS[d.getDay()];
  detail.innerHTML = `
    <div class="admin-log-header">
      <div class="admin-log-header-info">
        <div class="admin-log-header-name">${state.employees[empId]?.name || ""}</div>
        <div class="admin-log-header-sub">${dayName} ${date} · ${state.competitions[compId]?.name || ""}</div>
      </div>
      <div class="admin-log-header-badge logged">Logged</div>
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
  document.getElementById("admin-edit-log-btn").onclick = () => renderAdminLogEdit(empId, compId, date, log);
  document.getElementById("admin-delete-log-btn").onclick = async () => {
    if (confirm(`Delete log for ${state.employees[empId]?.name} on ${date}?`)) {
      await remove(dbRef.dateLog(compId, empId, date));
      showToast("Log deleted ✅");
    }
  };
}

function renderAdminLogCreate(empId, compId, date) {
  const detail = document.getElementById("admin-logs-detail");
  if (!detail) return;
  const d = new Date(date + "T00:00:00");
  const dayName = DAYS[d.getDay()];
  detail.innerHTML = `
    <div class="admin-log-header">
      <div class="admin-log-header-info">
        <div class="admin-log-header-name">${state.employees[empId]?.name || ""}</div>
        <div class="admin-log-header-sub">${dayName} ${date} · ${state.competitions[compId]?.name || ""}</div>
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
    if (date > getTodayDate()) { showToast("Can't create logs for future dates 🔮"); return; }
    await set(dbRef.dateLog(compId, empId, date), { sales, hours });
    showToast("Log created ✅");
    if (state.currentUser === empId) { renderDash(); renderBoard(); renderAllTime(); }
  };
}

function renderAdminLogEdit(empId, compId, date, log) {
  const detail = document.getElementById("admin-logs-detail");
  if (!detail) return;
  const d = new Date(date + "T00:00:00");
  const dayName = DAYS[d.getDay()];
  detail.innerHTML = `
    <div class="admin-log-header">
      <div class="admin-log-header-info">
        <div class="admin-log-header-name">${state.employees[empId]?.name || ""}</div>
        <div class="admin-log-header-sub">Editing ${dayName} ${date} · ${state.competitions[compId]?.name || ""}</div>
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
    await set(dbRef.dateLog(compId, empId, date), { sales, hours });
    showToast("Log updated ✅");
    if (state.currentUser === empId) { renderDash(); renderBoard(); renderAllTime(); }
  };
  document.getElementById("admin-cancel-edit-btn").onclick = () => renderAdminLogDetail(empId, compId, date, log);
}

// ══════════════════════════════════════════════════════
// Utility
// ══════════════════════════════════════════════════════
function makeBtn(label, className, onclick) {
  const btn = document.createElement("button");
  btn.className = className; btn.textContent = label; btn.onclick = onclick;
  return btn;
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
    color: ["#1A6FF4","#4D9EFA","#60B5FF","#3FB950","#F5A623"][Math.floor(Math.random()*5)],
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
// Info Modal
// ══════════════════════════════════════════════════════
function openInfoModal() {
  const modal = document.getElementById("info-modal");
  if (modal) modal.classList.add("active");
}

function closeInfoModal() {
  const modal = document.getElementById("info-modal");
  if (modal) modal.classList.remove("active");
}
document.addEventListener("DOMContentLoaded", async () => {
  await bootstrap();
  startListeners();

  document.getElementById("btn-log").onclick = logEntry;

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

  // Goals toggle
  const goalsToggle = document.getElementById("pick-goals-toggle");
  if (goalsToggle) {
    goalsToggle.onclick = () => {
      const content = document.getElementById("pick-goals-content");
      const isOpen = content.classList.contains("open");
      content.classList.toggle("open");
      goalsToggle.classList.toggle("open");
    };
  }

  // Pick screen employee selector
  const empSelectorBtn = document.getElementById("pick-emp-selector");
  const empGrid = document.getElementById("pick-emp-grid");
  if (empSelectorBtn && empGrid) {
    empSelectorBtn.onclick = () => {
      const isOpening = empGrid.classList.contains("hidden");
      empGrid.classList.toggle("hidden");
      if (isOpening) {
        renderPickEmpGrid();
        const searchEl = document.getElementById("pick-emp-search");
        if (searchEl) searchEl.focus();
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

  // Pick screen log button
  document.getElementById("pick-btn-log").onclick = logEntryFromPick;

  // Bottom nav
  document.getElementById("nav-home").onclick = () => showScreen("pick");
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

  // Set home button as active on initial load
  document.getElementById("nav-home").classList.add("active");

  // Info modal
  const infoBtnBtn = document.getElementById("btn-info");
  const closeInfoBtn = document.getElementById("btn-close-info");
  const infoModal = document.getElementById("info-modal");

  if (infoBtnBtn) {
    infoBtnBtn.onclick = openInfoModal;
  }
  if (closeInfoBtn) {
    closeInfoBtn.onclick = closeInfoModal;
  }
  if (infoModal) {
    infoModal.addEventListener("click", (e) => {
      if (e.target === infoModal) closeInfoModal();
    });
  }

  // PIN submit
  const pinInput = document.getElementById("input-pin");
  const pinSubmitBtn = document.getElementById("btn-pin-submit");

  pinSubmitBtn.disabled = true;
  pinSubmitBtn.classList.add("btn-ghost");

  pinSubmitBtn.onclick = () => {
    if (pinInput.value.trim() === ADMIN_PIN) {
      state.adminUnlocked = true;
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
});
