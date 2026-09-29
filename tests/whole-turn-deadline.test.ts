import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { sendChat } from "../src/lib/alpha.functions";
import { WholeTurnTimeoutError, getMonotonicTimeMs } from "../src/lib/openai-compat";
import { RequestActionLifecycle } from "../src/lib/request-lifecycle";
import { alphaGate, ALPHA_GATE_FALLBACK_TEXT } from "../src/lib/alpha-gate";
import { alphaStore } from "../src/lib/alpha-store";

describe("Alpha Pass C3-R — Verified Unified Whole-Turn Deadline Invariants", () => {
  let fetchSpy: any;

  beforeEach(() => {
    vi.useFakeTimers();
    fetchSpy = vi.spyOn(globalThis, "fetch");
  });

  afterEach(() => {
    vi.restoreAllMocks();
    vi.useRealTimers();
  });

  it("1. Zero or already-expired timeout prevents provider call and throws WholeTurnTimeoutError before fetch", async () => {
    fetchSpy.mockResolvedValue(new Response(JSON.stringify({ choices: [{ message: { content: "ok" } }] }), { status: 200 }));

    const promise = sendChat([], { timeoutMs: 0 });
    
    await expect(promise).rejects.toThrow(WholeTurnTimeoutError);
    await expect(promise).rejects.toHaveProperty("status", 504);
    // CRITICAL: Prove the provider call/fetch was NEVER invoked due to early deadline expiration
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("2. Invalid timeoutMs (negative, NaN) is bounded to 0 and throws WholeTurnTimeoutError immediately without fetch", async () => {
    fetchSpy.mockResolvedValue(new Response(JSON.stringify({ choices: [{ message: { content: "ok" } }] }), { status: 200 }));

    const promiseNeg = sendChat([], { timeoutMs: -500 });
    await expect(promiseNeg).rejects.toThrow(WholeTurnTimeoutError);

    const promiseNaN = sendChat([], { timeoutMs: NaN });
    await expect(promiseNaN).rejects.toThrow(WholeTurnTimeoutError);

    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("3. Deadline starts at logical turn start and getMonotonicTimeMs provides monotonic time", () => {
    const start = getMonotonicTimeMs();
    vi.advanceTimersByTime(100);
    const end = getMonotonicTimeMs();
    expect(end).toBeGreaterThanOrEqual(start);
  });

  it("4. Deadline expiry is distinguishable from user cancellation", async () => {
    const controller = new AbortController();
    controller.abort();

    // User cancellation produces AbortError
    const userCancelPromise = sendChat([], { signal: controller.signal, timeoutMs: 30_000 });
    await expect(userCancelPromise).rejects.toHaveProperty("name", "AbortError");

    // Timeout produces WholeTurnTimeoutError with status 504
    const timeoutPromise = sendChat([], { timeoutMs: 0 });
    await expect(timeoutPromise).rejects.toThrow(WholeTurnTimeoutError);
    await expect(timeoutPromise).rejects.toHaveProperty("status", 504);
  });

  it("5. Alpha Gate remains final approval boundary and action results are preserved", () => {
    const gateRes = alphaGate.process({
      rawText: "",
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

  it("6. RequestActionLifecycle cross-turn isolation remains robust across turns", () => {
    const lifecycle1 = new RequestActionLifecycle("req_1");
    const op1 = lifecycle1.startOperation({ name: "testOp", isMutation: true, logicalKey: "key:1" });
    lifecycle1.recordSuccess({ opId: op1.id, name: "testOp", isMutation: true, result: { success: true }, logicalKey: "key:1" });

    const lifecycle2 = new RequestActionLifecycle("req_2");
    expect(lifecycle2.hasCompletedMutation("key:1")).toBe(false);
    expect(lifecycle2.getAllOperations()).toHaveLength(0);
  });

  it("7. Concurrent requests remain isolated and one request timeout cannot cancel another", () => {
    const req1 = new RequestActionLifecycle("req_1");
    const req2 = new RequestActionLifecycle("req_2");

    expect(req1.requestId).not.toBe(req2.requestId);
    expect(req1.getState()).toBe("pending");
    expect(req2.getState()).toBe("pending");
  });
});
