const DAILY_WATER_GOAL_DEFAULT = 2000;
const REMINDER_INTERVAL_MINUTES = 120;
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
                waterGoal: DAILY_WATER_GOAL_DEFAULT,
                history: []
            };
        }
        const parsed = JSON.parse(raw);
        if (!parsed.currentDate) parsed.currentDate = todayKey();
        if (!Array.isArray(parsed.history)) parsed.history = [];
        if (!parsed.waterGoal || typeof parsed.waterGoal !== "number") {
            parsed.waterGoal = DAILY_WATER_GOAL_DEFAULT;
        }
        return parsed;
    } catch (e) {
        console.error("Failed to load state", e);
        return {
            currentDate: todayKey(),
            stepsToday: 0,
            waterToday: 0,
            waterGoal: DAILY_WATER_GOAL_DEFAULT,
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
    if (appState.stepsToday > 0 || appState.waterToday > 0) {
        appState.history.push({
            date: appState.currentDate,
            steps: appState.stepsToday,
            water: appState.waterToday
        });
    }
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

let stepsTodayEl,
    stepStatusTag,
    stepHintEl,
    sensorInfoEl,
    btnToggleStepTracking,
    waterTodayEl,
    waterGoalLabelEl,
    waterGoalTagEl,
    waterPercentLabelEl,
    waterProgressEl,
    waterGoalInputEl,
    btnSaveGoal,
    reminderToggleEl,
    reminderStatusTag,
    historyEmptyEl,
    historyTableEl,
    historyTbodyEl,
    reminderModalEl,
    btnLogFromReminder,
    btnDismissReminder;

let reminderTimerId = null;

let isTracking = false;
let motionListener = null;
let lastStepTime = 0;

const STEP_BASE_G = 1.0;
const STEP_DIFF_THRESHOLD = 0.28;
const STEP_MIN_INTERVAL_MS = 450;
let motionBaselineG = STEP_BASE_G;

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

function getWaterGoal() {
    if (!appState.waterGoal || typeof appState.waterGoal !== "number") {
        appState.waterGoal = DAILY_WATER_GOAL_DEFAULT;
    }
    return appState.waterGoal;
}

function init() {
    stepsTodayEl = document.getElementById("stepsToday");
    stepStatusTag = document.getElementById("stepStatusTag");
    stepHintEl = document.getElementById("stepHint");
    sensorInfoEl = document.getElementById("sensorInfo");
    btnToggleStepTracking = document.getElementById("btnToggleStepTracking");

    waterTodayEl = document.getElementById("waterToday");
    waterGoalLabelEl = document.getElementById("waterGoalLabel");
    waterGoalTagEl = document.getElementById("waterGoalTag");
    waterPercentLabelEl = document.getElementById("waterPercentLabel");
    waterProgressEl = document.getElementById("waterProgress");
    waterGoalInputEl = document.getElementById("waterGoalInput");
    btnSaveGoal = document.getElementById("btnSaveGoal");

    reminderToggleEl = document.getElementById("reminderToggle");
    reminderStatusTag = document.getElementById("reminderStatusTag");

    historyEmptyEl = document.getElementById("historyEmpty");
    historyTableEl = document.getElementById("historyTable");
    historyTbodyEl = document.getElementById("historyTbody");

    reminderModalEl = document.getElementById("reminderModal");
    btnLogFromReminder = document.getElementById("btnLogFromReminder");
    btnDismissReminder = document.getElementById("btnDismissReminder");

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

    btnSaveGoal.addEventListener("click", onSaveGoalClicked);

    const goal = getWaterGoal();
    waterGoalInputEl.value = goal.toString();

    updateUi();
    updateReminderStatusLabel();
    startReminderTimerIfEnabled();

    if (!("DeviceMotionEvent" in window)) {
        sensorInfoEl.textContent =
            "Motion sensor not available in this browser/webview. Steps can only be tracked in compatible environments.";
    }
}

function updateUi() {
    rollDateIfNeeded();
    const goal = getWaterGoal();

    stepsTodayEl.textContent = appState.stepsToday.toString();
    waterTodayEl.textContent = `${appState.waterToday} ml`;
    waterGoalLabelEl.textContent = `/ ${goal} ml`;
    if (waterGoalTagEl) {
        waterGoalTagEl.textContent = `Goal: ${goal} ml`;
    }

    const pct = Math.max(
        0,
        Math.min(100, Math.round((appState.waterToday / goal) * 100))
    );
    waterPercentLabelEl.textContent = `${pct}%`;
    waterProgressEl.style.width = `${pct}%`;

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

function onSaveGoalClicked() {
    const raw = waterGoalInputEl.value.trim();
    const v = parseInt(raw, 10);
    if (!Number.isFinite(v) || v < 500 || v > 6000) {
        alert("Please enter a goal between 500 and 6000 ml.");
        waterGoalInputEl.value = getWaterGoal().toString();
        return;
    }
    appState.waterGoal = v;
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
    motionBaselineG = STEP_BASE_G;

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

    const magnitudeG = Math.sqrt(ax * ax + ay * ay + az * az) / 9.81;
    const alpha = 0.02;
    motionBaselineG = motionBaselineG * (1 - alpha) + magnitudeG * alpha;

    const diff = Math.abs(magnitudeG - motionBaselineG);
    const now = Date.now();

    if (diff > STEP_DIFF_THRESHOLD && now - lastStepTime > STEP_MIN_INTERVAL_MS) {
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
        } catch (e) {}
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
