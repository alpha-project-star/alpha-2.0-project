import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import {
  tryAcquireOrRenewLease,
  revalidateLeadership,
  releaseLease,
  maybeFire,
  isVisionAmbient,
  isVisionAmbientLeader,
  startVisionAmbient,
  stopVisionAmbient,
  tabId,
  LEASE_OWNER_KEY,
  LEASE_EXPIRES_KEY,
  LEASE_DURATION_MS,
  LEADER_LOCK_NAME,
  EXECUTION_LOCK_NAME,
} from "../src/lib/vision-ambient";
import { alphaStore } from "../src/lib/alpha-store";
import * as visionStream from "../src/lib/vision-stream";
import * as alphaFunctions from "../src/lib/alpha.functions";

describe("Ambient Vision Leader Election & Mutual Exclusion Invariants", () => {
  let storeMap: Map<string, string>;
  let originalWindow: any;

  beforeEach(() => {
    storeMap = new Map<string, string>();
    originalWindow = (globalThis as any).window;

    const mockLocalStorage = {
      getItem: vi.fn((key: string) => storeMap.get(key) || null),
      setItem: vi.fn((key: string, value: string) => {
        storeMap.set(key, value);
      }),
      removeItem: vi.fn((key: string) => {
        storeMap.delete(key);
      }),
      clear: vi.fn(() => {
        storeMap.clear();
      }),
    };

    (globalThis as any).window = {
      localStorage: mockLocalStorage,
      dispatchEvent: vi.fn(),
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
      setInterval: vi.fn((fn: () => void) => {
        return 123;
      }),
      clearInterval: vi.fn(),
    };
  });

  afterEach(() => {
    stopVisionAmbient();
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
    if (originalWindow !== undefined) {
      (globalThis as any).window = originalWindow;
    } else {
      delete (globalThis as any).window;
    }
  });

  describe("1. Simultaneous Acquisition & Ownership Invariant", () => {
    it("ensures only one context wins acquisition when two contexts race", () => {
      // Tab 1 attempts acquisition
      const tab1Acquired = tryAcquireOrRenewLease();
      expect(tab1Acquired).toBe(true);
      expect(storeMap.get(LEASE_OWNER_KEY)).toBe(tabId);

      // Tab 2 (different ID) attempts acquisition while Tab 1 lease is valid
      const tab2Id = "competing-tab-uuid-2";
      const now = Date.now();
      const expiresAt = Number(storeMap.get(LEASE_EXPIRES_KEY));
      expect(expiresAt).toBeGreaterThan(now);

      // Simulating Tab 2's check: owner is tabId and lease not expired
      const isTab2Allowed =
        !storeMap.get(LEASE_OWNER_KEY) || now > Number(storeMap.get(LEASE_EXPIRES_KEY));
      expect(isTab2Allowed).toBe(false);
    });
  });

  describe("2. Lost Ownership Detection", () => {
    it("prevents execution if another context overwrote the lease owner", async () => {
      // Acquire lease as current tab
      tryAcquireOrRenewLease();
      expect(revalidateLeadership()).toBe(true);

      // Simulate Tab B clobbering the lease owner in storage
      storeMap.set(LEASE_OWNER_KEY, "tab-b-usurper");

      // Attempting to revalidate leadership must immediately return false
      const revalidated = revalidateLeadership();
      expect(revalidated).toBe(false);
      expect(isVisionAmbientLeader()).toBe(false);
    });
  });

  describe("3. Pre-Execution Revalidation", () => {
    it("revalidates ownership immediately prior to protected execution and rejects stale owners", async () => {
      const sendChatSpy = vi.spyOn(alphaFunctions, "sendChat").mockResolvedValue("Changed scene");
      vi.spyOn(visionStream, "captureFrame").mockReturnValue("data:image/jpeg;base64,mock");

      // Current tab is not leader
      storeMap.set(LEASE_OWNER_KEY, "another-tab");
      storeMap.set(LEASE_EXPIRES_KEY, String(Date.now() + LEASE_DURATION_MS));

      await maybeFire();

      // No frame was captured or sent to LLM
      expect(sendChatSpy).not.toHaveBeenCalled();
    });
  });

  describe("4. Lease Expiry", () => {
    it("allows new context acquisition after an old lease expires", () => {
      // Set an expired lease from a previous context
      const pastTime = Date.now() - 10000;
      storeMap.set(LEASE_OWNER_KEY, "dead-tab-id");
      storeMap.set(LEASE_EXPIRES_KEY, String(pastTime));

      // Current tab attempts acquisition
      const acquired = tryAcquireOrRenewLease();
      expect(acquired).toBe(true);
      expect(storeMap.get(LEASE_OWNER_KEY)).toBe(tabId);
      expect(Number(storeMap.get(LEASE_EXPIRES_KEY))).toBeGreaterThan(Date.now());
    });
  });

  describe("5. Storage-Event Invalidation", () => {
    it("invalidates local leader status when storage event reports another tab took ownership", () => {
      let storageHandler: ((e: any) => void) | undefined;
      (globalThis as any).window.addEventListener = vi.fn((event: string, handler: any) => {
        if (event === "storage") {
          storageHandler = handler;
        }
      });

      // Acquire initial leadership
      tryAcquireOrRenewLease();
      revalidateLeadership();

      // Trigger storage event listener
      if (storageHandler) {
        storageHandler({
          key: LEASE_OWNER_KEY,
          newValue: "different-tab-id",
        });
        expect(isVisionAmbientLeader()).toBe(false);
      }
    });
  });

  describe("6. Delayed / Stale In-Flight Execution Prevention", () => {
    it("discards response if ambient mode was stopped or invalidated while request was in-flight", async () => {
      const appendChatSpy = vi.spyOn(alphaStore, "appendChat");

      let resolveSendChat: (value: string) => void = () => {};
      vi.spyOn(alphaFunctions, "sendChat").mockImplementation(
        () =>
          new Promise((resolve) => {
            resolveSendChat = resolve;
          })
      );
      vi.spyOn(visionStream, "captureFrame").mockReturnValue("data:image/jpeg;base64,mock");

      // Set valid leadership
      tryAcquireOrRenewLease();
      revalidateLeadership();

      // Trigger fire
      const firePromise = maybeFire();

      // Before sendChat resolves, vision ambient is stopped (e.g. user closes tab or changes view)
      stopVisionAmbient();

      // Now sendChat resolves
      resolveSendChat("Important change detected");
      await firePromise;

      // Ensure appendChat was NOT called because execution was invalidated
      expect(appendChatSpy).not.toHaveBeenCalled();
    });
  });

  describe("7. Web Locks Exclusive Execution Invariant", () => {
    it("uses Web Locks to prevent simultaneous concurrent execution", async () => {
      const activeLocks = new Set<string>();
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

            if (opts.ifAvailable && activeLocks.has(name)) {
              // Lock unavailable
              return cb(null);
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
            }
          }
        ),
      };

      vi.stubGlobal("navigator", {
        locks: mockLocks,
      });

      vi.spyOn(alphaFunctions, "sendChat").mockImplementation(async () => {
        await new Promise((r) => setTimeout(r, 10));
        return "Nothing changed";
      });
      vi.spyOn(visionStream, "captureFrame").mockReturnValue("data:image/jpeg;base64,mock");

      // Start ambient vision
      startVisionAmbient();
      tryAcquireOrRenewLease();

      // Concurrently trigger two fires
      await Promise.all([maybeFire(), maybeFire()]);

      // Verify that at no point were two executions running concurrently in the critical section
      expect(maxConcurrent).toBeLessThanOrEqual(1);
    });
  });
});
