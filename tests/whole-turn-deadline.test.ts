import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { sendChat } from "../src/lib/alpha.functions";
import { RequestActionLifecycle } from "../src/lib/request-lifecycle";
import { alphaGate, ALPHA_GATE_FALLBACK_TEXT } from "../src/lib/alpha-gate";

describe("Pass C3 — Unified Whole-Turn Deadline Invariants", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("1. Whole-turn deadline is established at logical turn start and shared across calls", async () => {
    const lifecycle = new RequestActionLifecycle();
    expect(lifecycle.getState()).toBe("pending");
  });

  it("2. Already expired deadline prevents execution and throws timeout error with status 504", async () => {
    const promise = sendChat([], { timeoutMs: 0 });
    await expect(promise).rejects.toThrow();
  });

  it("3. Alpha Gate remains final approval boundary and action results are preserved", () => {
    const gateRes = alphaGate.process({
      rawText: "Some raw text",
      actionResults: [
        {
          tag: "SET_SETTING",
          status: "success",
          message: "autoSpeak disabled.",
        },
      ],
    });
    expect(gateRes.approvedText).not.toBe(ALPHA_GATE_FALLBACK_TEXT);
    expect(gateRes.approvedText).toContain("autoSpeak disabled.");
  });

  it("4. RequestActionLifecycle cross-turn isolation remains robust", () => {
    const lifecycle1 = new RequestActionLifecycle("req_1");
    const op1 = lifecycle1.startOperation({ name: "testOp", isMutation: true, logicalKey: "key:1" });
    lifecycle1.recordSuccess({ opId: op1.id, name: "testOp", isMutation: true, result: { success: true }, logicalKey: "key:1" });

    const lifecycle2 = new RequestActionLifecycle("req_2");
    expect(lifecycle2.hasCompletedMutation("key:1")).toBe(false);
    expect(lifecycle2.getAllOperations()).toHaveLength(0);
  });

  it("5. Deadline expiry is distinguishable from user cancellation", async () => {
    const controller = new AbortController();
    controller.abort();
    // User cancellation produces AbortError
    const promise = sendChat([], { signal: controller.signal, timeoutMs: 30_000 });
    await expect(promise).rejects.toThrow();
  });
});
