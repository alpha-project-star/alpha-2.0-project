/**
 * Vision Ambient — opt-in loop that watches the camera and only calls the
 * vision model when the scene actually changes. Debounced + hard-capped.
 */
import { alphaStore, uid, getStorage } from "./alpha-store";
import { captureFrame, isActive as eyeActive, subscribeBrightness } from "./vision-stream";
import { sendChat } from "./alpha.functions";
import { speakWith } from "./voice";

let running = false;
let unsub: (() => void) | null = null;
let lastFireAt = 0;
let momentum = 0;

const HARD_CAP_PER_HOUR = 12;
const AMBIENT_COUNTER_KEY = "alpha_ambient_hourly_counter";
const AMBIENT_RESET_KEY = "alpha_ambient_hourly_reset_at";

let heartbeatInterval: number | null = null;
let isLeader = false;
const tabId = Math.random().toString(36).slice(2);
let currentAmbientExecutionId = 0;

function getHourlyState(): { count: number; resetAt: number } {
  try {
    const storage = getStorage();
    if (!storage) return { count: 0, resetAt: 0 };
    const count = Number(storage.getItem(AMBIENT_COUNTER_KEY) || "0");
    const resetAt = Number(storage.getItem(AMBIENT_RESET_KEY) || "0");
    return { count, resetAt };
  } catch {
    return { count: 0, resetAt: 0 };
  }
}

function updateHourlyState(count: number, resetAt: number) {
  try {
    const storage = getStorage();
    if (!storage) return;
    storage.setItem(AMBIENT_COUNTER_KEY, String(count));
    storage.setItem(AMBIENT_RESET_KEY, String(resetAt));
  } catch {}
}

function startLeadershipTick() {
  if (heartbeatInterval != null) return;
  
  const tick = () => {
    if (!running) return;
    const now = Date.now();
    const storage = getStorage();
    if (!storage) return;
    const leaderId = storage.getItem("alpha_ambient_leader_id");
    const leaderHb = Number(storage.getItem("alpha_ambient_leader_heartbeat") || "0");
    
    if (!leaderId || now - leaderHb > 5000 || leaderId === tabId) {
      try {
        storage.setItem("alpha_ambient_leader_id", tabId);
        storage.setItem("alpha_ambient_leader_heartbeat", String(now));
        isLeader = true;
      } catch {}
    } else {
      isLeader = false;
    }
  };
  
  tick();
  heartbeatInterval = window.setInterval(tick, 2000) as unknown as number;
}

function stopLeadershipTick() {
  if (heartbeatInterval != null) {
    clearInterval(heartbeatInterval);
    heartbeatInterval = null;
  }
  isLeader = false;
  try {
    const storage = getStorage();
    if (storage && storage.getItem("alpha_ambient_leader_id") === tabId) {
      storage.removeItem("alpha_ambient_leader_id");
      storage.removeItem("alpha_ambient_leader_heartbeat");
    }
  } catch {}
}

export function startVisionAmbient(): void {
  if (running || !eyeActive()) return;
  running = true;
  momentum = 0;
  
  startLeadershipTick();
  
  unsub = subscribeBrightness((s) => {
    // Exponential momentum on motion so momentary spikes don't trigger.
    momentum = momentum * 0.7 + s.motion * 0.3;
    void maybeFire();
  });
}

export function stopVisionAmbient(): void {
  running = false;
  currentAmbientExecutionId = 0; // Invalidate any running queries
  stopLeadershipTick();
  if (unsub) { unsub(); unsub = null; }
}

export function isVisionAmbient(): boolean { return running; }

async function maybeFire() {
  if (!running || !isLeader) return;
  const now = Date.now();
  const interval = Math.max(15, alphaStore.get().settings.visionAmbientIntervalSec || 30) * 1000;
  if (now - lastFireAt < interval) return;
  if (momentum < 0.18) return; // Not enough real change.

  // Load and check hourly limit from persistent storage
  let { count, resetAt } = getHourlyState();
  if (now - resetAt > 3600000) {
    resetAt = now;
    count = 0;
    updateHourlyState(count, resetAt);
  }

  if (count >= HARD_CAP_PER_HOUR) {
    // Gracefully disable ambient vision when cap is reached
    stopVisionAmbient();
    alphaStore.setSettings({ visionAmbientEnabled: false });
    
    const limitMsg = "Ambient vision has been paused because it reached the hourly limit of 12 scans.";
    alphaStore.appendChat({
      id: uid(),
      role: "system",
      text: `⚠️ ${limitMsg}`,
      ts: Date.now()
    });
    
    void speakWith(limitMsg, { auto: true });
    return;
  }

  // Increment and persist counter BEFORE we make the request
  count++;
  updateHourlyState(count, resetAt);

  lastFireAt = now;
  const executionId = ++currentAmbientExecutionId;
  momentum = 0;

  const frame = captureFrame(512, 0.68);
  if (!frame) return;

  try {
    const reply = await sendChat([
      {
        id: uid(),
        role: "user",
        ts: now,
        text: "Ambient frame observation: In one short sentence (under 18 words) describe only what MEANINGFULLY changed in view. If nothing important changed, reply exactly: NOTHING.",
        images: [frame]
      }
    ], { task: "fast", disableTools: true });

    // Stale completion check: if disabled or superseded while in-flight, discard!
    if (executionId !== currentAmbientExecutionId || !running) {
      return;
    }

    let trimmed = (reply || "").trim();
    if (!trimmed) return;

    // Action Tag Filtering: Ambient vision is completely forbidden from running action tags.
    trimmed = trimmed.replace(/\[\[[\s\S]*?\]\]/g, "").trim();
    if (!trimmed || /^nothing\b/i.test(trimmed)) return;

    alphaStore.appendChat({ id: uid(), role: "model", text: `👁 ${trimmed}`, ts: Date.now() });
    
    // Speak using canonical Phase 2 speech manager and respect autoSpeak!
    void speakWith(trimmed, { auto: true });
  } catch {
    /* silent — ambient */
  }
}
