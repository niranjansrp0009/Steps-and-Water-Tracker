// Simple local-storage based state + hydration reminders
const DAILY_WATER_GOAL = 2000;
const REMINDER_INTERVAL_MINUTES = 120; // 2 hours

const stateKey = "swt_state_v1";

function todayKey() {
    const d = new Date();
    const y = d.getFullYear();
    const m = String(d.getMonth() + 1).padStart(2, "0");
    const day = String(d.getDate()).padStart(2, "0");
    return `${y}-${m}-${day}`;
}

function loadState() {
    try {
        const raw = localStorage.getItem(stateKey);
        if (!raw) {
            return {
                currentDate: todayKey(),
                stepsToday: 0,
                waterToday: 0,
                history: [] // { date, steps, water }
            };
        }
        const parsed = JSON.parse(raw);
        if (!parsed.currentDate) parsed.currentDate = todayKey();
        if (!Array.isArray(parsed.history)) parsed.history = [];
        return parsed;
    } catch (e) {
        console.error("Failed to load state", e);
        return {
            currentDate: todayKey(),
            stepsToday: 0,
            waterToday: 0,
            history: []
        };
    }
}

function saveState() {
    try {
        localStorage.setItem(stateKey, JSON.stringify(appState));
    } catch (e) {
        console.warn("Unable to save state", e);
    }
}

function rollDateIfNeeded() {
    const today = todayKey();
    if (appState.currentDate === today) return;
    // Move previous day into history
    if (appState.stepsToday > 0 || appState.waterToday > 0) {
        appState.history.push({
            date: appState.currentDate,
            steps: appState.stepsToday,
            water: appState.waterToday
        });
    }
    // Keep only last 7 entries
    if (appState.history.length > 7) {
        appState.history = appState.history.slice(-7);
    }
    appState.currentDate = today;
    appState.stepsToday = 0;
    appState.waterToday = 0;
    saveState();
}

let appState = loadState();
rollDateIfNeeded();

// DOM refs
let stepsTodayEl,
    stepStatusTag,
    stepHintEl,
    sensorInfoEl,
    btnToggleStepTracking,
    waterTodayEl,
    waterGoalLabelEl,
    waterPercentLabelEl,
    waterProgressEl,
    reminderToggleEl,
    reminderStatusTag,
    historyEmptyEl,
    historyTableEl,
    historyTbodyEl,
    reminderModalEl,
    btnLogFromReminder,
    btnDismissReminder;

let reminderTimerId = null;

// Step tracking via DeviceMotion
let isTracking = false;
let motionListener = null;
let lastStepTime = 0;

const STEP_THRESHOLD = 1.1; // tweak as needed (in g's approx)
const STEP_MIN_INTERVAL_MS = 350;

function canUseNotifications() {
    return typeof Notification !== "undefined";
}

async function ensureNotificationPermission() {
    if (!canUseNotifications()) return false;
    if (Notification.permission === "granted") return true;
    if (Notification.permission === "denied") return false;
    try {
        const result = await Notification.requestPermission();
        return result === "granted";
    } catch (e) {
        console.warn("Notification permission error", e);
        return false;
    }
}

function updateReminderStatusLabel() {
    if (!reminderStatusTag || !reminderToggleEl) return;
    if (!reminderToggleEl.checked) {
        reminderStatusTag.textContent = "Reminders off";
        return;
    }
    if (!canUseNotifications()) {
        reminderStatusTag.textContent = "Every 2 hours (in-app only)";
        return;
    }
    if (Notification.permission === "granted") {
        reminderStatusTag.textContent = "Every 2 hours (notification + in-app)";
    } else if (Notification.permission === "denied") {
        reminderStatusTag.textContent = "Every 2 hours (in-app only)";
    } else {
        reminderStatusTag.textContent = "Every 2 hours (tap Allow for notifications)";
    }
}

function init() {
    stepsTodayEl = document.getElementById("stepsToday");
    stepStatusTag = document.getElementById("stepStatusTag");
    stepHintEl = document.getElementById("stepHint");
    sensorInfoEl = document.getElementById("sensorInfo");
    btnToggleStepTracking = document.getElementById("btnToggleStepTracking");

    waterTodayEl = document.getElementById("waterToday");
    waterGoalLabelEl = document.getElementById("waterGoalLabel");
    waterPercentLabelEl = document.getElementById("waterPercentLabel");
    waterProgressEl = document.getElementById("waterProgress");

    reminderToggleEl = document.getElementById("reminderToggle");
    reminderStatusTag = document.getElementById("reminderStatusTag");

    historyEmptyEl = document.getElementById("historyEmpty");
    historyTableEl = document.getElementById("historyTable");
    historyTbodyEl = document.getElementById("historyTbody");

    reminderModalEl = document.getElementById("reminderModal");
    btnLogFromReminder = document.getElementById("btnLogFromReminder");
    btnDismissReminder = document.getElementById("btnDismissReminder");

    // Button listeners
    btnToggleStepTracking.addEventListener("click", onToggleStepTracking);
    document.querySelectorAll("[data-water]").forEach((btn) => {
        btn.addEventListener("click", () => {
            const amount = parseInt(btn.getAttribute("data-water"), 10) || 0;
            addWater(amount);
        });
    });

    reminderToggleEl.addEventListener("change", onReminderToggleChanged);
    btnLogFromReminder.addEventListener("click", () => {
        addWater(150);
        hideReminderModal();
    });
    btnDismissReminder.addEventListener("click", hideReminderModal);

    // Initial render
    waterGoalLabelEl.textContent = `/ ${DAILY_WATER_GOAL} ml`;
    updateUi();
    updateReminderStatusLabel();
    startReminderTimerIfEnabled();

    // Attempt auto-detection support
    if (!("DeviceMotionEvent" in window)) {
        sensorInfoEl.textContent =
            "Motion sensor not available in this browser/webview. Steps can only be tracked in compatible environments.";
    }
}

function updateUi() {
    rollDateIfNeeded();
    stepsTodayEl.textContent = appState.stepsToday.toString();
    waterTodayEl.textContent = `${appState.waterToday} ml`;

    const pct = Math.max(
        0,
        Math.min(100, Math.round((appState.waterToday / DAILY_WATER_GOAL) * 100))
    );
    waterPercentLabelEl.textContent = `${pct}%`;
    waterProgressEl.style.width = `${pct}%`;

    // History
    renderHistory();
}

function renderHistory() {
    const today = {
        date: appState.currentDate,
        steps: appState.stepsToday,
        water: appState.waterToday
    };

    const all = [...appState.history, today].filter((d) => !!d.date);
    if (!all.length) {
        historyEmptyEl.classList.remove("hidden");
        historyTableEl.classList.add("hidden");
        return;
    }

    historyEmptyEl.classList.add("hidden");
    historyTableEl.classList.remove("hidden");

    // sort by date ascending then render, but highlight today
    all.sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : 0));

    historyTbodyEl.innerHTML = "";
    all.forEach((entry) => {
        const tr = document.createElement("tr");
        if (entry.date === todayKey()) {
            tr.classList.add("highlight-today");
        }
        const tdDate = document.createElement("td");
        const tdSteps = document.createElement("td");
        const tdWater = document.createElement("td");

        tdDate.textContent = entry.date;
        tdSteps.textContent = entry.steps.toString();
        tdWater.textContent = entry.water.toString();

        tr.appendChild(tdDate);
        tr.appendChild(tdSteps);
        tr.appendChild(tdWater);
        historyTbodyEl.appendChild(tr);
    });
}

function addSteps(count) {
    appState.stepsToday += count;
    if (appState.stepsToday < 0) appState.stepsToday = 0;
    saveState();
    updateUi();
}

function addWater(amount) {
    appState.waterToday += amount;
    if (appState.waterToday < 0) appState.waterToday = 0;
    saveState();
    updateUi();
}

async function onToggleStepTracking() {
    if (isTracking) {
        stopStepTracking();
    } else {
        await startStepTracking();
    }
}

async function startStepTracking() {
    if (!("DeviceMotionEvent" in window)) {
        stepStatusTag.textContent = "Sensor: not supported";
        stepStatusTag.style.color = "#f97373";
        stepHintEl.textContent =
            "This browser/webview does not expose motion sensors. Steps cannot be captured automatically here.";
        return;
    }

    // iOS 13+ requires explicit permission
    try {
        if (typeof DeviceMotionEvent.requestPermission === "function") {
            const permissionState = await DeviceMotionEvent.requestPermission();
            if (permissionState !== "granted") {
                stepStatusTag.textContent = "Sensor: permission denied";
                stepStatusTag.style.color = "#f97373";
                stepHintEl.textContent =
                    "Motion permission was denied. You can re-enable it in browser/app settings.";
                return;
            }
        }
    } catch (e) {
        console.warn("Permission request error", e);
    }

    if (!motionListener) {
        motionListener = handleMotionEvent;
    }

    window.addEventListener("devicemotion", motionListener);
    isTracking = true;
    lastStepTime = Date.now();

    stepStatusTag.textContent = "Sensor: tracking";
    stepStatusTag.style.color = "#4ade80";
    btnToggleStepTracking.textContent = "Stop tracking";
    stepHintEl.textContent =
        "Tracking active. Keep the phone with you while walking. Tracking only works while the app is open.";
}

function stopStepTracking() {
    if (motionListener) {
        window.removeEventListener("devicemotion", motionListener);
    }
    isTracking = false;
    btnToggleStepTracking.textContent = "Start tracking";
    stepStatusTag.textContent = "Sensor: idle";
    stepStatusTag.style.color = "";
    stepHintEl.textContent =
        "Tap Start tracking and keep your phone in pocket while walking.";
}

function handleMotionEvent(event) {
    if (!event.accelerationIncludingGravity) return;

    const ax = event.accelerationIncludingGravity.x || 0;
    const ay = event.accelerationIncludingGravity.y || 0;
    const az = event.accelerationIncludingGravity.z || 0;

    const magnitude = Math.sqrt(ax * ax + ay * ay + az * az) / 9.81; // approx in g

    const now = Date.now();
    if (magnitude > STEP_THRESHOLD && now - lastStepTime > STEP_MIN_INTERVAL_MS) {
        lastStepTime = now;
        addSteps(1);
    }
}

async function onReminderToggleChanged() {
    const enabled = reminderToggleEl.checked;
    if (!enabled) {
        if (reminderTimerId) {
            clearInterval(reminderTimerId);
            reminderTimerId = null;
        }
        updateReminderStatusLabel();
        return;
    }

    // Optionally request permission when enabling
    await ensureNotificationPermission();
    updateReminderStatusLabel();
    startReminderTimerIfEnabled();
}

function startReminderTimerIfEnabled() {
    if (!reminderToggleEl.checked) return;
    if (reminderTimerId) {
        clearInterval(reminderTimerId);
    }
    const intervalMs = REMINDER_INTERVAL_MINUTES * 60 * 1000;
    reminderTimerId = setInterval(() => {
        handleReminderTick();
    }, intervalMs);
}

async function handleReminderTick() {
    if (!reminderToggleEl.checked) return;

    if (!canUseNotifications()) {
        showReminderModal();
        updateReminderStatusLabel();
        return;
    }

    if (Notification.permission === "default") {
        const granted = await ensureNotificationPermission();
        updateReminderStatusLabel();
        if (!granted) {
            showReminderModal();
            return;
        }
    } else if (Notification.permission === "denied") {
        updateReminderStatusLabel();
        showReminderModal();
        return;
    }

    try {
        showSystemNotification();
    } catch (e) {
        console.warn("Notification error, falling back to modal", e);
        showReminderModal();
    }
}

function showSystemNotification() {
    if (!canUseNotifications() || Notification.permission !== "granted") {
        throw new Error("Notifications not allowed");
    }
    const title = "Time to drink water 💧";
    const body = "Take a few sips now and log your intake.";
    const notification = new Notification(title, {
        body,
        tag: "water-reminder"
    });
    notification.onclick = () => {
        try {
            window.focus();
        } catch (e) {
            // ignore
        }
        notification.close();
    };
}

function showReminderModal() {
    reminderModalEl.classList.remove("hidden");
}

function hideReminderModal() {
    reminderModalEl.classList.add("hidden");
}

document.addEventListener("DOMContentLoaded", init);
