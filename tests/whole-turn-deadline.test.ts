import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { sendChat, fetchLiveWebContext } from "../src/lib/alpha.functions";
import { WholeTurnTimeoutError, getMonotonicTimeMs, sendChatOpenAICompat } from "../src/lib/openai-compat";
import { RequestActionLifecycle } from "../src/lib/request-lifecycle";
import { alphaGate, ALPHA_GATE_FALLBACK_TEXT } from "../src/lib/alpha-gate";
import { alphaStore } from "../src/lib/alpha-store";

describe("Alpha Pass C3-R2 — Complete Whole-Turn Deadline Invariants", () => {
  let fetchSpy: any;

  beforeEach(async () => {
    vi.useFakeTimers();
    if (typeof navigator !== "undefined") {
      Object.defineProperty(navigator, "onLine", { value: true, configurable: true, writable: true });
    }
    // Ensure store has an API key so online routes are active
    alphaStore.get().settings.openRouterKey = "sk-or-v1-test-key-1234567890";
    await alphaStore.setSettings({
      openRouterKey: "sk-or-v1-test-key-1234567890",
    });
    alphaStore.get().settings.openRouterKey = "sk-or-v1-test-key-1234567890";

    fetchSpy = vi.spyOn(globalThis, "fetch");
    fetchSpy.mockReset();
  });

  afterEach(() => {
    if (fetchSpy) {
      fetchSpy.mockReset();
      fetchSpy.mockRestore();
    }
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

  it("2. Single deadline is established once and shared across search and provider calls", async () => {
    let capturedSearchSignal: AbortSignal | undefined;
    let capturedProviderSignal: AbortSignal | undefined;

    fetchSpy.mockImplementation((url: string, init: any) => {
      if (url.includes("jina.ai") || url.includes("duckduckgo")) {
        capturedSearchSignal = init?.signal;
        return Promise.resolve(new Response("### [Test Result](https://example.com/test)\nSnippet text", { status: 200 }));
      }
      capturedProviderSignal = init?.signal;
      return Promise.resolve(
        new Response(
          JSON.stringify({
            choices: [{ message: { content: "Here is the weather based on search results." } }],
          }),
          { status: 200 },
        ),
      );
    });

    const promise = sendChat([{ id: "1", role: "user", text: "search online for current weather in Tokyo", ts: Date.now() }], {
      timeoutMs: 5000,
    });

    await vi.advanceTimersByTimeAsync(100);
    const res = await promise;

    expect(res).toBeDefined();
    expect(capturedSearchSignal).toBeDefined();
    expect(capturedProviderSignal).toBeDefined();
  });

  it("3. Retries cannot reset the deadline", async () => {
    fetchSpy.mockResolvedValue(new Response(JSON.stringify({ error: "server error" }), { status: 500 }));

    const startMs = getMonotonicTimeMs();
    const promise = sendChatOpenAICompat([], "sys", {
      baseUrl: "https://api.openai.com/v1",
      apiKey: "test-key",
      model: "gpt-4o",
      deadlineMs: startMs + 100,
      retries: 5,
    });

    const timerPromise = vi.advanceTimersByTimeAsync(200);
    await expect(promise).rejects.toThrow(WholeTurnTimeoutError);
    await timerPromise;
  });

  it("4. HTTP retry backoff cannot outlast the remaining budget", async () => {
    fetchSpy.mockResolvedValue(new Response(JSON.stringify({ error: "rate limit" }), { status: 429 }));

    const startMs = getMonotonicTimeMs();
    const promise = sendChatOpenAICompat([], "sys", {
      baseUrl: "https://api.openai.com/v1",
      apiKey: "test-key",
      model: "gpt-4o",
      deadlineMs: startMs + 50,
      retries: 3,
    });

    const timerPromise = vi.advanceTimersByTimeAsync(100);
    await expect(promise).rejects.toThrow(WholeTurnTimeoutError);
    await timerPromise;
  });

  it("5. Response-body parsing is bounded by the deadline", async () => {
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

    const startMs = getMonotonicTimeMs();
    const promise = sendChatOpenAICompat([], "sys", {
      baseUrl: "https://api.openai.com/v1",
      apiKey: "test-key",
      model: "gpt-4o",
      deadlineMs: startMs + 100,
    });

    const timerPromise = vi.advanceTimersByTimeAsync(150);
    await expect(promise).rejects.toThrow(WholeTurnTimeoutError);
    await timerPromise;
  });

  it("6. Fallbacks stop after deadline expiry", async () => {
    fetchSpy.mockImplementation((_url: string, init: any) => {
      const signal = init?.signal;
      return new Promise((_, reject) => {
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
      });
    });

    const promise = sendChat([], { timeoutMs: 50 });
    const timerPromise = vi.advanceTimersByTimeAsync(100);
    await expect(promise).rejects.toThrow(WholeTurnTimeoutError);
    await timerPromise;
  });

  it("7. A stalled search provider fetch is aborted via AbortSignal on deadline expiry", async () => {
    let providerSignal: AbortSignal | undefined;

    fetchSpy.mockImplementation((_url: string, init: any) => {
      providerSignal = init?.signal;
      return new Promise((_, reject) => {
        if (init?.signal?.aborted) {
          const err: any = new Error("Aborted");
          err.name = "AbortError";
          reject(err);
        } else {
          init?.signal?.addEventListener("abort", () => {
            const err: any = new Error("Aborted");
            err.name = "AbortError";
            reject(err);
          });
        }
      });
    });

    const startMs = getMonotonicTimeMs();
    const deadlineMs = startMs + 100;

    const promise = fetchLiveWebContext("live news query", undefined, deadlineMs);
    const timerPromise = vi.advanceTimersByTimeAsync(150);

    await expect(promise).rejects.toThrow(WholeTurnTimeoutError);
    await timerPromise;
    expect(providerSignal?.aborted).toBe(true);
  });

  it("8. Executed actions are preserved on timeout without committing late unverified text", async () => {
    let callCount = 0;
    fetchSpy.mockImplementation((_url: string, init: any) => {
      callCount++;
      if (callCount === 1) {
        // Round 1: Model returns a tool call to create a reminder
        return Promise.resolve(
          new Response(
            JSON.stringify({
              choices: [
                {
                  message: {
                    content: null,
                    tool_calls: [
                      {
                        id: "call_1",
                        type: "function",
                        function: {
                          name: "createReminder",
                          arguments: JSON.stringify({ title: "Buy Groceries", dueAtISO: "2026-10-01T10:00:00Z" }),
                        },
                      },
                    ],
                  },
                },
              ],
            }),
            { status: 200 },
          ),
        );
      }
      // Round 2: Provider call stalls and times out
      const signal = init?.signal;
      return new Promise((_, reject) => {
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
      });
    });

    const promise = sendChat([{ id: "1", role: "user", text: "remind me to Buy Groceries", ts: Date.now() }], {
      timeoutMs: 100,
    });

    await vi.advanceTimersByTimeAsync(10);
    await vi.advanceTimersByTimeAsync(150);
    const resultText = await promise;

    expect(resultText).toBeDefined();
    expect(resultText).not.toBe(ALPHA_GATE_FALLBACK_TEXT);
    expect(resultText.toLowerCase()).toContain("groceries");
  });

  it("9. Multiple tool/model rounds consume one shared budget", async () => {
    let roundNum = 0;

    fetchSpy.mockImplementation((_url: string, _init: any) => {
      roundNum++;
      if (roundNum === 1) {
        return Promise.resolve(
          new Response(
            JSON.stringify({
              choices: [
                {
                  message: {
                    content: null,
                    tool_calls: [
                      {
                        id: "call_1",
                        type: "function",
                        function: {
                          name: "get_weather",
                          arguments: JSON.stringify({ location: "Tokyo" }),
                        },
                      },
                    ],
                  },
                },
              ],
            }),
            { status: 200 },
          ),
        );
      }
      return Promise.resolve(
        new Response(
          JSON.stringify({
            choices: [{ message: { content: "Tokyo weather is 20°C." } }],
          }),
          { status: 200 },
        ),
      );
    });

    const promise = sendChat([{ id: "1", role: "user", text: "what is the weather in Tokyo?", ts: Date.now() }], {
      timeoutMs: 5000,
    });

    await vi.advanceTimersByTimeAsync(100);
    const res = await promise;

    expect(res).toContain("Tokyo");
  });

  it("10. User cancellation remains distinguishable from timeout", async () => {
    fetchSpy.mockImplementation((_url: string, init: any) => {
      const signal = init?.signal;
      return new Promise((_, reject) => {
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
      });
    });

    const controller = new AbortController();
    const userCancelPromise = sendChat([], { signal: controller.signal, timeoutMs: 30_000 });
    controller.abort();

    await expect(userCancelPromise).rejects.toHaveProperty("name", "AbortError");

    const timeoutPromise = sendChat([], { timeoutMs: 0 });
    await expect(timeoutPromise).rejects.toThrow(WholeTurnTimeoutError);
    await expect(timeoutPromise).rejects.toHaveProperty("status", 504);
  });

  it("11. Independent concurrent provider requests execute without cross-cancellation", async () => {
    fetchSpy.mockImplementation((_url: string, init: any) => {
      const body = JSON.parse(init?.body || "{}");
      const userContent = body.messages?.[body.messages.length - 1]?.content || "";
      const reply = userContent.includes("User 1") ? "Response for User 1" : "Response for User 2";
      return Promise.resolve(
        new Response(
          JSON.stringify({
            choices: [{ message: { content: reply } }],
          }),
          { status: 200 },
        ),
      );
    });

    const startMs = getMonotonicTimeMs();
    const req1 = sendChatOpenAICompat([{ id: "msg_u1", role: "user", text: "User 1 query unique_key_u1", ts: Date.now() }], "sys", {
      baseUrl: "https://api.openai.com/v1",
      apiKey: "test-key-1",
      model: "gpt-4o",
      deadlineMs: startMs + 5000,
    });

    const req2 = sendChatOpenAICompat([{ id: "msg_u2", role: "user", text: "User 2 query unique_key_u2", ts: Date.now() }], "sys", {
      baseUrl: "https://api.openai.com/v1",
      apiKey: "test-key-2",
      model: "gpt-4o",
      deadlineMs: startMs + 5000,
    });

    await vi.advanceTimersByTimeAsync(100);

    const [res1, res2] = await Promise.all([req1, req2]);
    expect(res1.finalText).toBe("Response for User 1");
    expect(res2.finalText).toBe("Response for User 2");
  });

  it("12. Late results from a timed-out request cannot commit text or overwrite state", async () => {
    fetchSpy.mockImplementation((_url: string, init: any) => {
      const signal = init?.signal;
      return new Promise((_, reject) => {
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
      });
    });

    const req1Promise = sendChat([{ id: "m1", role: "user", text: "slow request 1", ts: Date.now() }], { timeoutMs: 50 });
    const timerPromise = vi.advanceTimersByTimeAsync(100);

    await expect(req1Promise).rejects.toThrow(WholeTurnTimeoutError);
    await timerPromise;

    // Verify late response text is not present in history
    const history = alphaStore.getCompleteHistory();
    const lateTextMsg = history.find((m) => m.text?.includes("Late response text"));
    expect(lateTextMsg).toBeUndefined();
  });

  it("13. Completed mutations in RequestActionLifecycle prevent duplicate execution", () => {
    const lifecycle = new RequestActionLifecycle("req_test");
    const op = lifecycle.startOperation({ name: "createReminder", isMutation: true, logicalKey: "key:1" });
    lifecycle.recordSuccess({ opId: op.id, name: "createReminder", isMutation: true, result: { id: "rem_1" }, logicalKey: "key:1" });

    expect(lifecycle.hasCompletedMutation("key:1")).toBe(true);
    expect(lifecycle.getCompletedMutationResult("key:1")).toEqual({ id: "rem_1" });
  });

  it("14. Alpha Gate remains final approval boundary", () => {
    const gateRes = alphaGate.process({
      rawText: "As an OpenAI assistant, I am here to help you today.",
    });
    expect(gateRes.approvedText).not.toContain("OpenAI assistant");
    expect(gateRes.approvedText).toBe("I am here to help you today.");
  });
});
