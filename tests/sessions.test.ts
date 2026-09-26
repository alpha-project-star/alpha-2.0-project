import { describe, it, expect, beforeEach, vi } from "vitest";
import { alphaStore, type ChatMessage } from "../src/lib/alpha-store";

describe("Neural Chat Sessions & Editable Titles Subsystem", () => {
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
      },
    };
    await alphaStore.clearChat();
  });

  it("A. Initializes with a default active session", () => {
    const state = alphaStore.get();
    expect(state.sessions).toBeDefined();
    expect(state.sessions.length).toBeGreaterThanOrEqual(1);
    expect(state.activeSessionId).toBeDefined();
  });

  it("B. Creates a new session and isolates previous session history", async () => {
    const msg1: ChatMessage = { id: "m1", role: "user", text: "Alpha Project Roadmap", ts: Date.now() };
    await alphaStore.appendChat(msg1);

    expect(alphaStore.get().chat.length).toBe(1);

    // Create a new session
    const newSessionId = await alphaStore.createSession("Research Thread");
    expect(newSessionId).toBeDefined();
    expect(alphaStore.get().activeSessionId).toBe(newSessionId);
    expect(alphaStore.get().chat.length).toBe(0);

    // Append message in new session
    const msg2: ChatMessage = { id: "m2", role: "user", text: "Quantum Computing Papers", ts: Date.now() };
    await alphaStore.appendChat(msg2);
    expect(alphaStore.get().chat.length).toBe(1);
    expect(alphaStore.get().chat[0].text).toBe("Quantum Computing Papers");

    // Switch back to original session
    const originalSessionId = alphaStore.get().sessions.find((s) => s.id !== newSessionId)!.id;
    await alphaStore.switchSession(originalSessionId);
    expect(alphaStore.get().activeSessionId).toBe(originalSessionId);
    expect(alphaStore.get().chat.length).toBe(1);
    expect(alphaStore.get().chat[0].text).toBe("Alpha Project Roadmap");
  });

  it("C. Allows editing and renaming session titles", async () => {
    const sessionId = await alphaStore.createSession("Initial Title");
    expect(alphaStore.get().sessions.find((s) => s.id === sessionId)?.title).toBe("Initial Title");

    // Rename session
    await alphaStore.renameSession(sessionId, "Updated Neural Analysis Plan");
    expect(alphaStore.get().sessions.find((s) => s.id === sessionId)?.title).toBe("Updated Neural Analysis Plan");
  });

  it("D. Deletes a session and safely switches to remaining session", async () => {
    const s1 = await alphaStore.createSession("Session 1");
    const s2 = await alphaStore.createSession("Session 2");

    expect(alphaStore.get().sessions.some((s) => s.id === s2)).toBe(true);

    // Delete active session s2
    await alphaStore.deleteSession(s2);
    expect(alphaStore.get().sessions.some((s) => s.id === s2)).toBe(false);
    expect(alphaStore.get().activeSessionId).not.toBe(s2);
    expect(alphaStore.get().sessions.length).toBeGreaterThanOrEqual(1);
  });
});
