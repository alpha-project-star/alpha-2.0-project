/**
 * Vision Ambient — opt-in loop that watches the camera and only calls the
 * vision model when the scene actually changes. Debounced + hard-capped.
 *
 * Multi-Tab Coordination Architecture:
 * 1. Primary: Browser-native Web Locks API (navigator.locks) provides origin-wide
 *    exclusive mutual exclusion for both leadership election and critical execution sections.
 * 2. Fallback: Storage lease protocol with read-write-verify, heartbeat renewal,
 *    and storage event cancellation for environments without Web Locks.
 */
import { alphaStore, uid, getStorage } from "./alpha-store";
import { captureFrame, isActive as eyeActive, subscribeBrightness } from "./vision-stream";
import { sendChat } from "./alpha.functions";
import { speakWith } from "./voice";

let running = false;
let unsub: (() => void) | null = null;
let lastFireAt = 0;
let momentum = 0;

export const HARD_CAP_PER_HOUR = 12;
export const AMBIENT_COUNTER_KEY = "alpha_ambient_hourly_counter";
export const AMBIENT_RESET_KEY = "alpha_ambient_hourly_reset_at";
export const LEASE_OWNER_KEY = "alpha_ambient_lease_owner";
export const LEASE_EXPIRES_KEY = "alpha_ambient_lease_expires_at";
export const LEASE_DURATION_MS = 6000;

export const LEADER_LOCK_NAME = "alpha_vision_ambient_leader";
export const EXECUTION_LOCK_NAME = "alpha_vision_ambient_execution";

let heartbeatInterval: number | null = null;
let isLeader = false;
let leaderAbortController: AbortController | null = null;
export const tabId =
  typeof crypto !== "undefined" && crypto.randomUUID
    ? crypto.randomUUID()
    : Math.random().toString(36).slice(2) + Date.now().toString(36);
let currentAmbientExecutionId = 0;

export function isVisionAmbientLeader(): boolean {
  return isLeader;
}

export function getHourlyState(): { count: number; resetAt: number } {
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

export function updateHourlyState(count: number, resetAt: number) {
  try {
    const storage = getStorage();
    if (!storage) return;
    storage.setItem(AMBIENT_COUNTER_KEY, String(count));
    storage.setItem(AMBIENT_RESET_KEY, String(resetAt));
  } catch {}
}

export function tryAcquireOrRenewLease(): boolean {
  const storage = getStorage();
  if (!storage) return false;
  const now = Date.now();
  const currentOwner = storage.getItem(LEASE_OWNER_KEY);
  const expiresAt = Number(storage.getItem(LEASE_EXPIRES_KEY) || "0");

  const leaseExpired = isNaN(expiresAt) || now > expiresAt;
  const isOwner = currentOwner === tabId;

  if (isOwner) {
    try {
      storage.setItem(LEASE_EXPIRES_KEY, String(now + LEASE_DURATION_MS));
      return storage.getItem(LEASE_OWNER_KEY) === tabId;
    } catch {
      return false;
    }
  }

  if (leaseExpired || !currentOwner) {
    try {
      storage.setItem(LEASE_OWNER_KEY, tabId);
      storage.setItem(LEASE_EXPIRES_KEY, String(now + LEASE_DURATION_MS));
      // Re-read to confirm our write succeeded and was not clobbered by a racing tab
      const confirmedOwner = storage.getItem(LEASE_OWNER_KEY);
      return confirmedOwner === tabId;
    } catch {
      return false;
    }
  }
  return false;
}

export function revalidateLeadership(): boolean {
  // If Web Locks is active and we are leader, verify lock is not aborted
  if (leaderAbortController && !leaderAbortController.signal.aborted && isLeader) {
    return true;
  }

  const storage = getStorage();
  if (!storage) return false;
  const now = Date.now();
  const currentOwner = storage.getItem(LEASE_OWNER_KEY);
  const expiresAt = Number(storage.getItem(LEASE_EXPIRES_KEY) || "0");

  if (currentOwner !== tabId || isNaN(expiresAt) || now > expiresAt) {
    isLeader = false;
    return false;
  }
  try {
    storage.setItem(LEASE_EXPIRES_KEY, String(now + LEASE_DURATION_MS));
    const confirmedOwner = storage.getItem(LEASE_OWNER_KEY);
    if (confirmedOwner !== tabId) {
      isLeader = false;
      return false;
    }
    isLeader = true;
    return true;
  } catch {
    isLeader = false;
    return false;
  }
}

export function releaseLease() {
  try {
    const storage = getStorage();
    if (storage && storage.getItem(LEASE_OWNER_KEY) === tabId) {
      storage.removeItem(LEASE_OWNER_KEY);
      storage.removeItem(LEASE_EXPIRES_KEY);
    }
  } catch {}
}

if (typeof window !== "undefined") {
  window.addEventListener("storage", (e) => {
    if (e.key === LEASE_OWNER_KEY && e.newValue !== tabId) {
      isLeader = false;
    }
  });
  window.addEventListener("beforeunload", () => {
    if (isLeader) releaseLease();
  });
  window.addEventListener("pagehide", () => {
    if (isLeader) releaseLease();
  });
}

function startLeadershipTickFallback() {
  if (heartbeatInterval != null) return;
  
  const tick = () => {
    if (!running) return;
    isLeader = tryAcquireOrRenewLease();
  };
  
  tick();
  heartbeatInterval = window.setInterval(tick, 2000) as unknown as number;
}

function stopLeadershipTickFallback() {
  if (heartbeatInterval != null) {
    clearInterval(heartbeatInterval);
    heartbeatInterval = null;
  }
  isLeader = false;
  releaseLease();
}

async function startLeadershipWebLocks(): Promise<void> {
  if (typeof navigator === "undefined" || !navigator.locks) {
    startLeadershipTickFallback();
    return;
  }

  leaderAbortController = new AbortController();
  const signal = leaderAbortController.signal;

  try {
    await navigator.locks.request(
      LEADER_LOCK_NAME,
      { signal },
      async () => {
        if (!running || signal.aborted) return;
        isLeader = true;
        tryAcquireOrRenewLease();

        // Maintain leadership state and lease renewal while holding the lock
        await new Promise<void>((resolve) => {
          const interval = setInterval(() => {
            if (!running || signal.aborted) {
              clearInterval(interval);
              resolve();
              return;
            }
            tryAcquireOrRenewLease();
          }, 2000);

          signal.addEventListener("abort", () => {
            clearInterval(interval);
            resolve();
          });
        });
      }
    );
  } catch (err: unknown) {
    const isAbort = err instanceof Error && err.name === "AbortError";
    if (!isAbort && running) {
      // If Web Locks throws unexpectedly, fallback to lease protocol
      startLeadershipTickFallback();
    }
  } finally {
    isLeader = false;
    releaseLease();
  }
}

export function startVisionAmbient(): void {
  if (running || !eyeActive()) return;
  running = true;
  momentum = 0;
  
  if (typeof navigator !== "undefined" && navigator.locks) {
    void startLeadershipWebLocks();
  } else {
    startLeadershipTickFallback();
  }
  
  unsub = subscribeBrightness((s) => {
    // Exponential momentum on motion so momentary spikes don't trigger.
    momentum = momentum * 0.7 + s.motion * 0.3;
    void maybeFire();
  });
}

export function stopVisionAmbient(): void {
  running = false;
  currentAmbientExecutionId = 0; // Invalidate any running queries
  
  if (leaderAbortController) {
    leaderAbortController.abort();
    leaderAbortController = null;
  }
  stopLeadershipTickFallback();
  
  if (unsub) {
    unsub();
    unsub = null;
  }
}

export function isVisionAmbient(): boolean {
  return running;
}

export async function maybeFire(): Promise<void> {
  if (!running || !isLeader || !revalidateLeadership()) return;

  // If Web Locks API is available, use exclusive non-blocking execution lock
  if (typeof navigator !== "undefined" && navigator.locks) {
    await navigator.locks.request(
      EXECUTION_LOCK_NAME,
      { mode: "exclusive", ifAvailable: true },
      async (lock) => {
        if (!lock) {
          // Another ambient execution is actively in-flight
          return;
        }
        await executeAmbientScan();
      }
    );
  } else {
    await executeAmbientScan();
  }
}

async function executeAmbientScan(): Promise<void> {
  if (!running || !isLeader || !revalidateLeadership()) return;
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
      ts: Date.now(),
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
        images: [frame],
      },
    ], { task: "fast", disableTools: true });

    // Stale completion check: if disabled or superseded while in-flight, discard!
    if (executionId !== currentAmbientExecutionId || !running || !isLeader) {
      return;
    }

    let trimmed = (reply || "").trim();
    if (!trimmed) return;

    // Action Tag Filtering: Ambient vision is completely forbidden from running action tags.
    trimmed = trimmed.replace(/\[\[[\s\S]*?\]\]/g, "").trim();
    if (!trimmed || /^nothing\b/i.test(trimmed)) return;

    alphaStore.appendChat({ id: uid(), role: "model", text: `👁 ${trimmed}`, ts: Date.now() });
    
    // Speak using canonical speech manager and respect autoSpeak!
    void speakWith(trimmed, { auto: true });
  } catch {
    /* silent — ambient */
  }
}

