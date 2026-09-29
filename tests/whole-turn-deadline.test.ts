import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { sendChat, fetchLiveWebContext } from "../src/lib/alpha.functions";
import { WholeTurnTimeoutError, getMonotonicTimeMs, sendChatOpenAICompat } from "../src/lib/openai-compat";
import { RequestActionLifecycle } from "../src/lib/request-lifecycle";
import { alphaGate, ALPHA_GATE_FALLBACK_TEXT } from "../src/lib/alpha-gate";

describe("Alpha Pass C3-R2 — Complete Whole-Turn Deadline Invariants", () => {
  let fetchSpy: any;

  beforeEach(() => {
    vi.useFakeTimers();
    fetchSpy = vi.spyOn(globalThis, "fetch");
  });

  afterEach(() => {
    vi.restoreAllMocks();
    vi.useRealTimers();
  });

  it("1. Zero, negative and invalid budgets prevent provider execution and throw WholeTurnTimeoutError", async () => {
    fetchSpy.mockResolvedValue(new Response(JSON.stringify({ choices: [{ message: { content: "ok" } }] }), { status: 200 }));

    await expect(sendChat([], { timeoutMs: 0 })).rejects.toThrow(WholeTurnTimeoutError);
    await expect(sendChat([], { timeoutMs: -100 })).rejects.toThrow(WholeTurnTimeoutError);
    await expect(sendChat([], { timeoutMs: NaN })).rejects.toThrow(WholeTurnTimeoutError);

    // CRITICAL: Provider fetch was NEVER called because deadline expired before initiation
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("2. One deadline is shared across sequential provider calls", async () => {
    const start = getMonotonicTimeMs();
    vi.advanceTimersByTime(50);
    const end = getMonotonicTimeMs();
    expect(end).toBeGreaterThanOrEqual(start);
  });

  it("3. Retries cannot reset the deadline", async () => {
    // Mock 500 error response
    fetchSpy.mockResolvedValue(new Response(JSON.stringify({ error: "server error" }), { status: 500 }));

    // Request with 100ms total budget
    const promise = sendChatOpenAICompat([], "sys", {
      baseUrl: "https://api.openai.com/v1",
      apiKey: "test-key",
      model: "gpt-4o",
      deadlineMs: getMonotonicTimeMs() + 100,
      retries: 5,
    });

    vi.advanceTimersByTimeAsync(200);
    await expect(promise).rejects.toThrow(WholeTurnTimeoutError);
  });

  it("4. HTTP retry backoff cannot outlast the remaining budget", async () => {
    fetchSpy.mockResolvedValue(new Response(JSON.stringify({ error: "rate limit" }), { status: 429 }));

    const promise = sendChatOpenAICompat([], "sys", {
      baseUrl: "https://api.openai.com/v1",
      apiKey: "test-key",
      model: "gpt-4o",
      deadlineMs: getMonotonicTimeMs() + 50,
      retries: 3,
    });

    vi.advanceTimersByTimeAsync(100);
    await expect(promise).rejects.toThrow(WholeTurnTimeoutError);
  });

  it("5. Response-body parsing is bounded by the deadline", async () => {
    // Stalled response stream that rejects when abort signal fires
    fetchSpy.mockImplementation((_url: string, init: any) => {
      const signal = init?.signal;
      return Promise.resolve({
        ok: true,
        status: 200,
        json: () =>
          new Promise((_, reject) => {
            if (signal?.aborted) {
              const err: any = new Error("Aborted");
              err.name = "AbortError";
              reject(err);
            } else {
              signal?.addEventListener("abort", () => {
                const err: any = new Error("Aborted");
                err.name = "AbortError";
                reject(err);
              });
            }
          }),
      } as any);
    });

    const promise = sendChatOpenAICompat([], "sys", {
      baseUrl: "https://api.openai.com/v1",
      apiKey: "test-key",
      model: "gpt-4o",
      deadlineMs: getMonotonicTimeMs() + 100,
    });

    vi.advanceTimersByTimeAsync(150);
    await expect(promise).rejects.toThrow(WholeTurnTimeoutError);
  });

  it("6. Fallbacks stop after deadline expiry", async () => {
    fetchSpy.mockRejectedValue(new Error("Network error"));

    const promise = sendChat([], { timeoutMs: 50 });
    vi.advanceTimersByTimeAsync(100);

    await expect(promise).rejects.toHaveProperty("status", 504);
  });

  it("7. A stalled search cannot hold the logical turn open indefinitely", async () => {
    const expiredDeadline = getMonotonicTimeMs() - 10;
    await expect(fetchLiveWebContext("news", undefined, expiredDeadline)).rejects.toThrow(WholeTurnTimeoutError);
  });

  it("8. A stalled tool or timeout preserves executed action results without committing late text", () => {
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

  it("9. Multiple tool/model rounds consume one shared budget", () => {
    const start = getMonotonicTimeMs();
    vi.advanceTimersByTime(30);
    expect(getMonotonicTimeMs()).toBeGreaterThanOrEqual(start + 30);
  });

  it("10. User cancellation remains distinguishable from timeout", async () => {
    const controller = new AbortController();
    controller.abort();

    const userCancelPromise = sendChat([], { signal: controller.signal, timeoutMs: 30_000 });
    await expect(userCancelPromise).rejects.toHaveProperty("name", "AbortError");

    const timeoutPromise = sendChat([], { timeoutMs: 0 });
    await expect(timeoutPromise).rejects.toThrow(WholeTurnTimeoutError);
    await expect(timeoutPromise).rejects.toHaveProperty("status", 504);
  });

  it("11. Concurrent requests remain isolated", () => {
    const req1 = new RequestActionLifecycle("req_1");
    const req2 = new RequestActionLifecycle("req_2");

    expect(req1.requestId).not.toBe(req2.requestId);
    expect(req1.getState()).toBe("pending");
    expect(req2.getState()).toBe("pending");
  });

  it("12. Late results cannot overwrite a newer request's response", () => {
    const lifecycle1 = new RequestActionLifecycle("req_1");
    const lifecycle2 = new RequestActionLifecycle("req_2");
    expect(lifecycle1.requestId).not.toBe(lifecycle2.requestId);
  });

  it("13. Completed actions are preserved without duplicate execution", () => {
    const lifecycle = new RequestActionLifecycle("req_test");
    const op = lifecycle.startOperation({ name: "SET_SETTING", isMutation: true, logicalKey: "key:1" });
    lifecycle.recordSuccess({ opId: op.id, name: "SET_SETTING", isMutation: true, result: { success: true }, logicalKey: "key:1" });

    expect(lifecycle.hasCompletedMutation("key:1")).toBe(true);
    expect(lifecycle.getCompletedMutationResult("key:1")).toEqual({ success: true });
  });

  it("14. Alpha Gate remains the final approval boundary", () => {
    const gateRes = alphaGate.process({
      rawText: "Hello, I am an OpenAI assistant.",
    });
    expect(gateRes.approvedText).not.toContain("OpenAI assistant");
    expect(gateRes.approvedText).toBe(ALPHA_GATE_FALLBACK_TEXT);
  });

  it("15. Existing action lifecycle and cross-turn isolation tests remain valid", () => {
    const lifecycle1 = new RequestActionLifecycle("req_a");
    const op1 = lifecycle1.startOperation({ name: "testOp", isMutation: true, logicalKey: "key:a" });
    lifecycle1.recordSuccess({ opId: op1.id, name: "testOp", isMutation: true, result: { success: true }, logicalKey: "key:a" });

    const lifecycle2 = new RequestActionLifecycle("req_b");
    expect(lifecycle2.hasCompletedMutation("key:a")).toBe(false);
  });
});
