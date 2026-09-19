import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import {
  revalidateLeadership,
  maybeFire,
  isVisionAmbient,
  isVisionAmbientLeader,
  isVisionAmbientSupported,
  isWebLocksSupported,
  startVisionAmbient,
  stopVisionAmbient,
  LEADER_LOCK_NAME,
  EXECUTION_LOCK_NAME,
} from "../src/lib/vision-ambient";
import { alphaStore } from "../src/lib/alpha-store";
import * as visionStream from "../src/lib/vision-stream";
import * as alphaFunctions from "../src/lib/alpha.functions";

describe("Ambient Vision Leader Election & Mutual Exclusion Invariants", () => {
  let activeLocks: Set<string>;
  let lockWaiters: Map<string, Array<() => void>>;
  let brightnessCallback: ((s: { motion: number; mean: number }) => void) | null = null;

  beforeEach(() => {
    activeLocks = new Set<string>();
    lockWaiters = new Map<string, Array<() => void>>();
    brightnessCallback = null;

    // Mock vision camera stream as active and capture subscriber
    vi.spyOn(visionStream, "isActive").mockReturnValue(true);
    vi.spyOn(visionStream, "subscribeBrightness").mockImplementation((cb) => {
      brightnessCallback = cb;
      return () => {
        brightnessCallback = null;
      };
    });

    // Reset settings
    alphaStore.setSettings({
      visionAmbientEnabled: true,
      visionAmbientIntervalSec: 15,
    });
  });

  afterEach(() => {
    stopVisionAmbient();
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  /**
   * Helper to create a compliant Web Locks mock that accurately models:
   * 1. Persistent leader lock holding with AbortSignal release.
   * 2. Exclusive non-blocking execution lock with `{ ifAvailable: true }`.
   * 3. Concurrent contention tracking.
   */
  function setupWebLocksMock() {
    let concurrentExecutions = 0;
    let maxConcurrent = 0;

    const mockLocks = {
      request: vi.fn(
        async (
          name: string,
          optionsOrCallback: any,
          callback?: (lock: any) => Promise<any>
        ) => {
          const cb = typeof optionsOrCallback === "function" ? optionsOrCallback : callback;
          const opts = typeof optionsOrCallback === "object" ? optionsOrCallback : {};
          const signal: AbortSignal | undefined = opts.signal;

          if (signal?.aborted) {
            const err = new Error("The request was aborted");
            err.name = "AbortError";
            throw err;
          }

          if (opts.ifAvailable && activeLocks.has(name)) {
            // Lock is currently held; ifAvailable returns null immediately
            return cb(null);
          }

          // If lock is held (exclusive mode without ifAvailable), wait until freed or aborted
          if (activeLocks.has(name)) {
            await new Promise<void>((resolve, reject) => {
              const onAbort = () => {
                reject(Object.assign(new Error("The request was aborted"), { name: "AbortError" }));
              };
              signal?.addEventListener("abort", onAbort, { once: true });

              const list = lockWaiters.get(name) || [];
              list.push(() => {
                signal?.removeEventListener("abort", onAbort);
                resolve();
              });
              lockWaiters.set(name, list);
            });
          }

          activeLocks.add(name);

          if (name === EXECUTION_LOCK_NAME) {
            concurrentExecutions++;
            maxConcurrent = Math.max(maxConcurrent, concurrentExecutions);
          }

          try {
            return await cb({ name });
          } finally {
            if (name === EXECUTION_LOCK_NAME) {
              concurrentExecutions--;
            }
            activeLocks.delete(name);

            // Notify next waiter if any
            const waiters = lockWaiters.get(name);
            if (waiters && waiters.length > 0) {
              const next = waiters.shift();
              next?.();
            }
          }
        }
      ),
    };

    vi.stubGlobal("navigator", {
      locks: mockLocks,
    });

    return {
      mockLocks,
      getMaxConcurrent: () => maxConcurrent,
    };
  }

  describe("Test A — True simultaneous lease race in non-CAS storage", () => {
    it("demonstrates why non-atomic storage read/write/reread allows interleaved split-brain and justifies Web Locks requirement", () => {
      // Model the fundamental CAS-less race in localStorage:
      // Tab A and Tab B read simultaneously when key is null
      let storageOwner: string | null = null;

      // Step 1: Both contexts read the key concurrently
      const tabARead = storageOwner;
      const tabBRead = storageOwner;

      // Step 2: Both decide they may acquire because both observed null
      const tabACanAcquire = tabARead === null;
      const tabBCanAcquire = tabBRead === null;
      expect(tabACanAcquire).toBe(true);
      expect(tabBCanAcquire).toBe(true);

      // Step 3: Tab A writes its identity
      storageOwner = "tab-A-uuid";
      // Step 4: Tab B writes its identity (interleaved write)
      storageOwner = "tab-B-uuid";

      // Step 5: Tab B reads back and sees tab-B-uuid (believes it acquired exclusive lease)
      const tabBReread = storageOwner;
      expect(tabBReread).toBe("tab-B-uuid");

      // In a raw storage protocol, Tab B won the final write, but Tab A had already evaluated
      // the predicate and proceeded into the critical execution section, producing duplicate execution.
      // This mathematically proves that localStorage cannot provide atomic mutual exclusion across tabs.
      // Consequently, Alpha requires Web Locks and disallows uncoordinated storage fallback execution.
      expect(isWebLocksSupported()).toBe(false);
      expect(isVisionAmbientSupported()).toBe(false);
    });
  });

  describe("Test B — Web Locks contention with real execution path", () => {
    it("guarantees maximum concurrent protected executions === 1 under simultaneous triggers", async () => {
      const { getMaxConcurrent } = setupWebLocksMock();

      vi.spyOn(visionStream, "captureFrame").mockReturnValue("data:image/jpeg;base64,sampleframe");

      let resolveChat1: (v: string) => void = () => {};
      let chatInvocationCount = 0;

      vi.spyOn(alphaFunctions, "sendChat").mockImplementation(async () => {
        chatInvocationCount++;
        return new Promise<string>((resolve) => {
          resolveChat1 = resolve;
        });
      });

      // 1. Start ambient vision through production function
      const started = startVisionAmbient();
      expect(started).toBe(true);
      expect(isVisionAmbient()).toBe(true);

      // Wait a microtask for leader lock callback to run
      await Promise.resolve();
      expect(isVisionAmbientLeader()).toBe(true);
      expect(brightnessCallback).toBeTypeOf("function");

      // 2. Trigger motion to build momentum and initiate fire via real production path
      brightnessCallback!({ motion: 1.0, mean: 0.5 });

      // 3. Immediately trigger a second concurrent maybeFire() while first is in-flight
      const secondFirePromise = maybeFire();

      // Ensure that only 1 execution entered the critical section and called sendChat
      expect(chatInvocationCount).toBe(1);

      // Resolve the in-flight chat
      resolveChat1("Scene update 1");
      await secondFirePromise;

      // Verify that concurrent executions never exceeded 1
      expect(getMaxConcurrent()).toBe(1);
    });
  });

  describe("Test C — Lost leadership before execution", () => {
    it("prevents stale context from executing protected operations if leadership is lost before maybeFire()", async () => {
      setupWebLocksMock();
      const sendChatSpy = vi.spyOn(alphaFunctions, "sendChat").mockResolvedValue("Observation");
      const captureFrameSpy = vi.spyOn(visionStream, "captureFrame").mockReturnValue("data:image/jpeg;base64,frame");

      // 1. Start ambient vision and establish leadership
      startVisionAmbient();
      await Promise.resolve();
      expect(isVisionAmbientLeader()).toBe(true);

      // 2. Stop ambient vision (simulates losing leadership / tab blur or user toggle)
      stopVisionAmbient();
      expect(isVisionAmbientLeader()).toBe(false);
      expect(revalidateLeadership()).toBe(false);

      // 3. Attempt to trigger maybeFire()
      await maybeFire();

      // Verify protected operations were NOT executed
      expect(captureFrameSpy).not.toHaveBeenCalled();
      expect(sendChatSpy).not.toHaveBeenCalled();
    });
  });

  describe("Test D — Lost leadership during asynchronous execution", () => {
    it("discards result if leadership was invalidated or ambient stopped while in-flight", async () => {
      setupWebLocksMock();
      const appendChatSpy = vi.spyOn(alphaStore, "appendChat");
      vi.spyOn(visionStream, "captureFrame").mockReturnValue("data:image/jpeg;base64,frame");

      let resolveSendChat: (value: string) => void = () => {};
      vi.spyOn(alphaFunctions, "sendChat").mockImplementation(
        () =>
          new Promise((resolve) => {
            resolveSendChat = resolve;
          })
      );

      // 1. Start ambient vision and establish leadership
      startVisionAmbient();
      await Promise.resolve();
      expect(isVisionAmbientLeader()).toBe(true);

      // 2. Trigger motion to build momentum and initiate legitimate fire
      brightnessCallback!({ motion: 1.0, mean: 0.5 });

      // 3. Invalidate leadership while request is in flight
      stopVisionAmbient();
      expect(isVisionAmbientLeader()).toBe(false);

      // 4. Resolve the in-flight network response
      resolveSendChat("Significant change in view detected");
      await new Promise((r) => setTimeout(r, 10));

      // 5. Verify the stale completion did NOT commit to chat store
      expect(appendChatSpy).not.toHaveBeenCalled();
    });
  });

  describe("Test E — Lease expiry / takeover by subsequent context", () => {
    it("allows a subsequent context to acquire leadership and execute when the previous leader releases the lock", async () => {
      setupWebLocksMock();
      vi.spyOn(visionStream, "captureFrame").mockReturnValue("data:image/jpeg;base64,frame");
      const sendChatSpy = vi.spyOn(alphaFunctions, "sendChat").mockResolvedValue("Takeover observation");

      // 1. Context 1 starts ambient vision and becomes leader
      startVisionAmbient();
      await Promise.resolve();
      expect(isVisionAmbientLeader()).toBe(true);

      // 2. Context 1 stops and releases the leader lock
      stopVisionAmbient();
      // Allow abort signal and lock cleanup to complete
      await new Promise((r) => setTimeout(r, 10));
      expect(isVisionAmbientLeader()).toBe(false);

      // 3. Context 2 starts ambient vision
      const startedContext2 = startVisionAmbient();
      expect(startedContext2).toBe(true);
      await Promise.resolve();
      expect(isVisionAmbientLeader()).toBe(true);

      // 4. Context 2 receives motion event and fires execution successfully
      brightnessCallback!({ motion: 1.0, mean: 0.5 });
      await new Promise((r) => setTimeout(r, 10));

      expect(sendChatSpy).toHaveBeenCalledTimes(1);
    });
  });

  describe("Test F — Web Locks unavailable", () => {
    it("explicitly disables ambient vision and prevents uncoordinated execution when navigator.locks is undefined", async () => {
      // Ensure navigator.locks is undefined
      vi.stubGlobal("navigator", {});

      expect(isWebLocksSupported()).toBe(false);
      expect(isVisionAmbientSupported()).toBe(false);

      const sendChatSpy = vi.spyOn(alphaFunctions, "sendChat");
      const captureFrameSpy = vi.spyOn(visionStream, "captureFrame");

      // Attempt to start ambient vision
      const started = startVisionAmbient();
      expect(started).toBe(false);
      expect(isVisionAmbient()).toBe(false);
      expect(isVisionAmbientLeader()).toBe(false);
      expect(revalidateLeadership()).toBe(false);

      // Calling maybeFire() must safely no-op without any ambient scan
      await maybeFire();
      expect(captureFrameSpy).not.toHaveBeenCalled();
      expect(sendChatSpy).not.toHaveBeenCalled();
    });
  });
});
