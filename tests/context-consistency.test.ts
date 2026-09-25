import { describe, it, expect, beforeEach, vi } from "vitest";
import { alphaStore } from "../src/lib/alpha-store";
import type { ChatMessage } from "../src/lib/alpha-store";
import { sendChat } from "../src/lib/alpha.functions";
import * as openaiCompat from "../src/lib/openai-compat";
import * as toolRegistryModule from "../src/lib/tool-registry";

describe("Context & State Consistency (alpha-store history boundaries)", () => {
  beforeEach(async () => {
    const storeMap = new Map<string, string>();
    vi.stubGlobal("navigator", { onLine: true });
    (globalThis as any).window = {
      navigator: { onLine: true },
      location: { origin: "https://alpha.local" },
      localStorage: {
        getItem: (key: string) => storeMap.get(key) || null,
        setItem: (key: string, val: string) => storeMap.set(key, val),
        removeItem: (key: string) => storeMap.delete(key),
        clear: () => storeMap.clear(),
        length: 0,
        key: (i: number) => Array.from(storeMap.keys())[i] || null,
      }
    };
    await alphaStore.clearChat();
  });

  it("A. Completed internal history is excluded from new independent model requests", async () => {
    const now = Date.now();
    const userMsg: ChatMessage = { id: "u1", role: "user", text: "Hello", ts: now };
    const modelMsg: ChatMessage = { id: "m1", role: "model", text: "Hi there", ts: now + 1 };
    const toolCallMsg: ChatMessage = { id: "t1", role: "model", tool_calls: [{ id: "call_1", name: "listReminders", arguments: {} }], intermediate: true, ts: now + 2 };
    const toolResultMsg: ChatMessage = { id: "r1", role: "tool", tool_call_id: "call_1", name: "listReminders", text: "[]", intermediate: true, ts: now + 3 };

    await alphaStore.appendChat(userMsg);
    await alphaStore.appendChat(modelMsg);
    await alphaStore.appendChat(toolCallMsg);
    await alphaStore.appendChat(toolResultMsg);

    // Get history for new independent model request
    const requestHistory = alphaStore.getCompleteHistory();

    // Verify visible conversation is included, but internal tool-call/tool-result messages are excluded
    expect(requestHistory.some((m) => m.id === "u1")).toBe(true);
    expect(requestHistory.some((m) => m.id === "m1")).toBe(true);
    expect(requestHistory.some((m) => m.id === "t1")).toBe(false);
    expect(requestHistory.some((m) => m.id === "r1")).toBe(false);
  });

  it("B. Active tool-loop history remains available within the same request execution", async () => {
    await alphaStore.setSettings({ openRouterKey: "mock-key" });
    let callCount = 0;
    let capturedSecondRoundHistory: any[] = [];

    const mockToolExecutionResult = {
      success: true,
      count: 1,
      reminders: [{ id: "mock_rem_1", title: "Deterministic Test Reminder" }],
    };

    vi.spyOn(toolRegistryModule, "getReminderTool").mockReturnValue({
      listReminders: vi.fn().mockResolvedValue(mockToolExecutionResult),
    } as any);

    vi.spyOn(openaiCompat, "sendChatOpenAICompat").mockImplementation(async (history, _sys, _opts) => {
      callCount++;
      if (callCount === 1) {
        return {
          finalText: "",
          toolCalls: [
            {
              id: "call_abc",
              type: "function",
              function: {
                name: "listReminders",
                arguments: "{}",
              },
            },
          ],
        };
      } else {
        capturedSecondRoundHistory = [...history];
        return {
          finalText: "Here are your reminders.",
        };
      }
    });

    const reply = await sendChat([]);
    expect(reply).toBe("Here are your reminders.");
    expect(callCount).toBe(2);

    // 1. The assistant "model" message containing the exact tool call ID "call_abc".
    const assistantMsg = capturedSecondRoundHistory.find(
      (m) => m.role === "model" && m.tool_calls?.some((t: any) => t.id === "call_abc")
    );
    expect(assistantMsg).toBeDefined();
    expect(assistantMsg?.tool_calls?.[0]?.id).toBe("call_abc");

    // 2. The "tool" message containing "tool_call_id === 'call_abc'".
    const toolMsg = capturedSecondRoundHistory.find(
      (m) => m.role === "tool" && m.tool_call_id === "call_abc"
    );
    expect(toolMsg).toBeDefined();
    expect(toolMsg?.tool_call_id).toBe("call_abc");

    // 3. The mocked tool execution result is represented in that tool message.
    expect(toolMsg?.text).toBeDefined();
    const parsedToolResult = JSON.parse(toolMsg!.text);
    expect(parsedToolResult).toEqual(mockToolExecutionResult);
  });

  it("C. History-window calculation is not polluted by stale internal tool messages", async () => {
    const now = Date.now();
    // Add many internal tool messages
    for (let i = 0; i < 50; i++) {
      await alphaStore.appendChat({
        id: `int_${i}`,
        role: "tool",
        tool_call_id: `call_${i}`,
        text: "data",
        intermediate: true,
        ts: now + i,
      });
    }

    // Add a few visible messages
    await alphaStore.appendChat({ id: "v1", role: "user", text: "What time is it?", ts: now + 100 });
    await alphaStore.appendChat({ id: "v2", role: "model", text: "It is 12:00 PM.", ts: now + 101 });

    const requestHistory = alphaStore.getCompleteHistory();

    // The conversational history window should only count visible messages (max 200), unpolluted by internal tool messages
    expect(requestHistory.length).toBe(2);
    expect(requestHistory[0].id).toBe("v1");
    expect(requestHistory[1].id).toBe("v2");
  });

  it("D. Internal history is still retained and retrievable via diagnostic retrieval path", async () => {
    const now = Date.now();
    const toolMsg: ChatMessage = { id: "diag_1", role: "tool", tool_call_id: "c9", name: "test", text: "result", intermediate: true, ts: now };

    await alphaStore.appendChat(toolMsg);

    // Verify diagnostic history path returns internal messages
    const diagnosticHistory = alphaStore.getDiagnosticHistory();
    expect(diagnosticHistory.some((m) => m.id === "diag_1")).toBe(true);
  });
});
