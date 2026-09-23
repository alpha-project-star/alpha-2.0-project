/**
 * Vision Ambient — opt-in loop that watches the camera and only calls the
 * vision model when the scene actually changes. Debounced + hard-capped.
 *
 * Multi-Tab Coordination Architecture:
 * 1. Mutual Exclusion Guarantee:
 *    Cross-context coordination requires the browser-standard Web Locks API (navigator.locks).
 *    Because localStorage lacks an atomic Compare-And-Swap (CAS) primitive, localStorage-based
 *    coordination cannot provide a mathematically sound mutual-exclusion guarantee.
 * 2. Deliberate Architectural Policy:
 *    - In environments where Web Locks is available, Alpha establishes an origin-wide leader
 *      via `navigator.locks.request(LEADER_LOCK_NAME, ...)` and enforces non-overlapping
 *      execution via `navigator.locks.request(EXECUTION_LOCK_NAME, { mode: "exclusive", ifAvailable: true })`.
 *    - In environments where Web Locks is unavailable (navigator.locks === undefined),
 *      ambient multi-tab execution is explicitly disabled (graceful unsupported state)
 *      to prevent dangerous duplicate execution and API quota exhaustion.
 */
import { alphaStore, uid, getStorage, getKey, getCurrentStoreUser, isKeyForUid } from "./alpha-store";
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

export const LEADER_LOCK_NAME = "alpha_vision_ambient_leader";
export const EXECUTION_LOCK_NAME = "alpha_vision_ambient_execution";

let isLeader = false;
let leaderAbortController: AbortController | null = null;
export const tabId =
  typeof crypto !== "undefined" && crypto.randomUUID
    ? crypto.randomUUID()
    : Math.random().toString(36).slice(2) + Date.now().toString(36);
let currentAmbientExecutionId = 0;

/**
 * Checks if the Web Locks API is supported by the current environment.
 */
export function isWebLocksSupported(): boolean {
  return (
    typeof navigator !== "undefined" &&
    typeof navigator.locks !== "undefined" &&
    typeof navigator.locks.request === "function"
  );
}

/**
 * Ambient vision requires Web Locks for cross-context mutual exclusion.
 */
export function isVisionAmbientSupported(): boolean {
  return isWebLocksSupported();
}

export function isVisionAmbientLeader(): boolean {
  return isLeader;
}

export function isVisionAmbient(): boolean {
  return running;
}

export function getHourlyState(ownerUid?: string | null): { count: number; resetAt: number } {
  try {
    const storage = getStorage();
    if (!storage) return { count: 0, resetAt: 0 };

    const targetUid = ownerUid !== undefined ? ownerUid : getCurrentStoreUser();
    // Invariant: No authenticated UID => no shared ambient quota storage
    if (!targetUid) {
      return { count: 0, resetAt: 0 };
    }

    const currentUid = getCurrentStoreUser();
    if (targetUid !== currentUid) {
      // Must not read or cross into a different user's quota namespace
      return { count: 0, resetAt: 0 };
    }

    const counterKey = getKey(AMBIENT_COUNTER_KEY);
    const resetKey = getKey(AMBIENT_RESET_KEY);

    // Validate that keys strictly adhere to canonical Alpha user namespace
    if (!isKeyForUid(counterKey, targetUid) || !isKeyForUid(resetKey, targetUid)) {
      return { count: 0, resetAt: 0 };
    }

    const rawCount = storage.getItem(counterKey);
    const rawResetAt = storage.getItem(resetKey);
    const count = Number(rawCount || "0");
    const resetAt = Number(rawResetAt || "0");
    if (isNaN(count) || count < 0) return { count: 0, resetAt: isNaN(resetAt) ? 0 : resetAt };
    if (isNaN(resetAt) || resetAt < 0) return { count, resetAt: 0 };
    return { count, resetAt };
  } catch {
    return { count: 0, resetAt: 0 };
  }
}

export function updateHourlyState(count: number, resetAt: number, ownerUid?: string | null): void {
  try {
    const storage = getStorage();
    if (!storage) return;

    const targetUid = ownerUid !== undefined ? ownerUid : getCurrentStoreUser();
    // Invariant: No authenticated UID => no persistent quota write
    if (!targetUid) {
      return;
    }

    const currentUid = getCurrentStoreUser();
    if (targetUid !== currentUid) {
      // Cross-user write forbidden: do not charge new or different user
      return;
    }

    const counterKey = getKey(AMBIENT_COUNTER_KEY);
    const resetKey = getKey(AMBIENT_RESET_KEY);

    // Validate that keys strictly adhere to canonical Alpha user namespace
    if (!isKeyForUid(counterKey, targetUid) || !isKeyForUid(resetKey, targetUid)) {
      return;
    }

    storage.setItem(counterKey, String(Math.max(0, count)));
    storage.setItem(resetKey, String(Math.max(0, resetAt)));
  } catch {}
}

export function revalidateLeadership(): boolean {
  if (!isWebLocksSupported()) {
    isLeader = false;
    return false;
  }
  if (!leaderAbortController || leaderAbortController.signal.aborted) {
    isLeader = false;
    return false;
  }
  return isLeader;
}

async function startLeadershipWebLocks(): Promise<void> {
  if (!isWebLocksSupported()) {
    isLeader = false;
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

        // Hold leadership lock until aborted or stopped
        await new Promise<void>((resolve) => {
          if (signal.aborted) {
            resolve();
            return;
          }
          signal.addEventListener("abort", () => resolve(), { once: true });
        });
      }
    );
  } catch (err: unknown) {
    const isAbort = err instanceof Error && err.name === "AbortError";
    if (!isAbort) {
      // Non-abort error: ensure leader state is false
      isLeader = false;
    }
  } finally {
    isLeader = false;
  }
}

export function startVisionAmbient(): boolean {
  if (running) return true;
  if (!eyeActive()) return false;

  if (!isWebLocksSupported()) {
    console.warn(
      "[AmbientVision] Web Locks API is unavailable in this environment. Ambient vision is disabled to prevent duplicate executions."
    );
    running = false;
    isLeader = false;
    return false;
  }

  running = true;
  momentum = 0;

  void startLeadershipWebLocks();

  unsub = subscribeBrightness((s) => {
    // Exponential momentum on motion so momentary spikes don't trigger.
    momentum = momentum * 0.7 + s.motion * 0.3;
    void maybeFire();
  });

  return true;
}

export function stopVisionAmbient(): void {
  running = false;
  isLeader = false;
  lastFireAt = 0;
  momentum = 0;
  currentAmbientExecutionId = 0; // Invalidate any running queries

  if (leaderAbortController) {
    leaderAbortController.abort();
    leaderAbortController = null;
  }

  if (unsub) {
    unsub();
    unsub = null;
  }
}

export async function maybeFire(): Promise<void> {
  if (!running || !isLeader || !revalidateLeadership() || !isWebLocksSupported()) {
    return;
  }

  // Exclusive non-blocking execution lock
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
}

async function executeAmbientScan(): Promise<void> {
  if (!running || !isLeader || !revalidateLeadership()) return;

  // 1. Establish the authenticated user identity that owns that execution at the beginning
  const executionOwnerUid = getCurrentStoreUser();

  const now = Date.now();
  const interval = Math.max(15, alphaStore.get().settings.visionAmbientIntervalSec || 30) * 1000;
  if (now - lastFireAt < interval) return;
  if (momentum < 0.18) return; // Not enough real change.

  // Load and check hourly limit from persistent storage for this execution's owner
  let { count, resetAt } = getHourlyState(executionOwnerUid);
  if (executionOwnerUid && (now - resetAt > 3600000 || resetAt === 0)) {
    resetAt = now;
    count = 0;
    updateHourlyState(count, resetAt, executionOwnerUid);
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

  lastFireAt = now;
  const executionId = ++currentAmbientExecutionId;
  momentum = 0;

  const frame = captureFrame(512, 0.68);
  // Capture failed: 0 quota consumption
  if (!frame) return;

  // 2. Account ownership invariant: captureOwnerUid === quotaOwnerUid
  // If the authenticated user changed while capture was in progress:
  // A starts capture -> A to B account switch -> capture completes: do NOT charge B!
  const currentUid = getCurrentStoreUser();
  if (currentUid !== executionOwnerUid) {
    // Discard the capture without charging the new user
    return;
  }

  // 3. Capture succeeded: EXACTLY ONE quota unit consumed
  count++;
  updateHourlyState(count, resetAt, executionOwnerUid);

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

    // Stale completion check: if disabled, superseded, lost leadership, or account changed while in-flight, discard!
    if (
      executionId !== currentAmbientExecutionId ||
      !running ||
      !isLeader ||
      !revalidateLeadership() ||
      getCurrentStoreUser() !== executionOwnerUid
    ) {
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

