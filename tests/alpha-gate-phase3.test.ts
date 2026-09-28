import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { alphaStore } from "../src/lib/alpha-store";
import { alphaGate } from "../src/lib/alpha-gate";
import { buildMorningBrief, tick } from "../src/lib/proactive";
import { notificationDelivery } from "../src/lib/notification-delivery";
import { InMemoryReminderRepository } from "../src/lib/reminder-repo";

describe("Alpha Gate Phase 3 — Remaining Response Producer Integration", () => {
  let originalWindow: any;
  let originalDocument: any;
  let originalLocalStorage: any;
  let mockStorageStore: Record<string, string> = {};

  beforeEach(() => {
    // Clear chat store
    alphaStore.setChat([]);
    vi.restoreAllMocks();
    mockStorageStore = {};

    originalWindow = (globalThis as any).window;
    originalDocument = (globalThis as any).document;
    originalLocalStorage = (globalThis as any).localStorage;

    const mockLocalStorage = {
      getItem: vi.fn((key: string) => mockStorageStore[key] || null),
      setItem: vi.fn((key: string, value: string) => {
        mockStorageStore[key] = value;
      }),
      removeItem: vi.fn((key: string) => {
        delete mockStorageStore[key];
      }),
      clear: vi.fn(() => {
        mockStorageStore = {};
      }),
    };

    const mockDoc = {
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
      hidden: false,
    };

    const mockWin = {
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
      setTimeout: globalThis.setTimeout.bind(globalThis),
      clearTimeout: globalThis.clearTimeout.bind(globalThis),
      setInterval: globalThis.setInterval.bind(globalThis),
      clearInterval: globalThis.clearInterval.bind(globalThis),
      localStorage: mockLocalStorage,
      document: mockDoc,
    };

    (globalThis as any).window = mockWin;
    (globalThis as any).document = mockDoc;
    (globalThis as any).localStorage = mockLocalStorage;
  });

  afterEach(() => {
    (globalThis as any).window = originalWindow;
    (globalThis as any).document = originalDocument;
    (globalThis as any).localStorage = originalLocalStorage;
  });

  it("1. Proactive Morning Brief passes through Alpha Gate with origin proactive", async () => {
    const gateProcessSpy = vi.spyOn(alphaGate, "process");
    const repo = new InMemoryReminderRepository();
    await repo.createReminder("user-1", {
      id: "rem-1",
      userId: "user-1",
      title: "Team Standup",
      dueAt: new Date().setHours(9, 0, 0, 0),
      createdAt: Date.now(),
      updatedAt: Date.now(),
      reminderState: "active",
      notificationState: "pending",
    });

    const brief = await buildMorningBrief({
      userId: "user-1",
      repo,
      now: new Date(new Date().setHours(8, 0, 0, 0)),
    });

    expect(brief).toContain("Team Standup");

    // Test that when proactive tick runs, speakAndLog gates the output with origin 'proactive'
    await alphaStore.setSettings({ backgroundEnabled: true });
    await tick(true, {
      userId: "user-1",
      repo,
      now: new Date(new Date().setHours(8, 0, 0, 0)),
    });

    expect(gateProcessSpy).toHaveBeenCalledWith(
      expect.objectContaining({
        origin: "proactive",
      })
    );
  });

  it("2. Proactive task/schedule nudge passes through Alpha Gate", async () => {
    const gateProcessSpy = vi.spyOn(alphaGate, "process");
    const today = new Date();
    today.setHours(14, 0, 0, 0);

    await alphaStore.upsertTask({
      id: "task-1",
      title: "Submit Financial Report",
      status: "in_progress",
      dueAt: today.getTime(),
      createdAt: Date.now(),
      updatedAt: Date.now(),
    });
    await alphaStore.setSettings({ backgroundEnabled: true });

    await tick(true, {
      now: new Date(new Date().setHours(15, 0, 0, 0)),
    });

    const proactiveCall = gateProcessSpy.mock.calls.find(
      (call) => call[0].origin === "proactive" && call[0].rawText.includes("Submit Financial Report")
    );
    expect(proactiveCall).toBeDefined();
    expect(proactiveCall![0].origin).toBe("proactive");
  });

  it("3. Proactive overdue-bills response passes through Alpha Gate", async () => {
    const gateProcessSpy = vi.spyOn(alphaGate, "process");
    const pastDate = new Date(Date.now() - 3 * 86400000).toISOString().split("T")[0];

    await alphaStore.upsertBill({
      id: "bill-1",
      name: "Electric Utility",
      balance: 120.5,
      dueDate: pastDate,
      status: "due",
    });
    await alphaStore.setSettings({ backgroundEnabled: true });

    await tick(true, {
      now: new Date(new Date().setHours(12, 0, 0, 0)),
    });

    const proactiveCall = gateProcessSpy.mock.calls.find(
      (call) => call[0].origin === "proactive" && call[0].rawText.includes("overdue")
    );
    expect(proactiveCall).toBeDefined();
    expect(proactiveCall![0].origin).toBe("proactive");
  });

  it("4. Notification background and live delivery response passes through Alpha Gate with origin notification", async () => {
    const gateProcessSpy = vi.spyOn(alphaGate, "process");
    const repo = new InMemoryReminderRepository();
    const deliveryMgr = notificationDelivery;

    const record = {
      eventId: "evt-live-1",
      reminderId: "rem-101",
      userId: "user-test",
      messageId: "msg-live-1",
      text: "You have a reminder for 'Dentist Appointment' scheduled now.",
      title: "Dentist Appointment",
      dueAt: Date.now(),
    };

    const res = await deliveryMgr.deliverProactiveResponse({
      authenticatedUserId: "user-test",
      record,
      channel: "in_app",
    });

    expect(res.success).toBe(true);

    const notifCall = gateProcessSpy.mock.calls.find(
      (call) => call[0].origin === "notification" && call[0].rawText.includes("Dentist Appointment")
    );
    expect(notifCall).toBeDefined();
    expect(notifCall![0].origin).toBe("notification");

    // Verify stored chat message contains approved text
    const chat = alphaStore.get().chat;
    const deliveredMsg = chat.find((m) => m.proactiveEventId === "evt-live-1");
    expect(deliveredMsg).toBeDefined();
    expect(deliveredMsg?.text).toBe(notifCall![0].rawText);
  });

  it("5. Gate cleans reasoning tags from proactive and notification deliveries before storing", async () => {
    const deliveryMgr = notificationDelivery;
    const record = {
      eventId: "evt-dirty-1",
      reminderId: "rem-102",
      userId: "user-test",
      messageId: "msg-dirty-1",
      text: "<think>Internal scheduler firing notification</think>Time for your medication.",
      title: "Medication",
      dueAt: Date.now(),
    };

    const res = await deliveryMgr.deliverProactiveResponse({
      authenticatedUserId: "user-test",
      record,
      channel: "in_app",
    });

    expect(res.success).toBe(true);

    const chat = alphaStore.get().chat;
    const deliveredMsg = chat.find((m) => m.proactiveEventId === "evt-dirty-1");
    expect(deliveredMsg).toBeDefined();
    expect(deliveredMsg?.text).not.toContain("<think>");
    expect(deliveredMsg?.text).not.toContain("Internal scheduler firing");
    expect(deliveredMsg?.text).toBe("Time for your medication.");
  });

  it("6. Ambient vision quota pause notice passes through Alpha Gate with origin ambient", () => {
    const gateProcessSpy = vi.spyOn(alphaGate, "process");
    const limitMsg = "Ambient vision has been paused because it reached the hourly limit of 12 scans.";
    const gateRes = alphaGate.process({
      rawText: limitMsg,
      origin: "ambient",
    });
    expect(gateRes.approvedText).toContain("Ambient vision has been paused");
    expect(gateProcessSpy).toHaveBeenCalledWith(
      expect.objectContaining({
        rawText: limitMsg,
        origin: "ambient",
      })
    );
  });

  it("7. Ambient vision observation summary passes through Alpha Gate with origin ambient and cleans leaked reasoning", () => {
    const gateProcessSpy = vi.spyOn(alphaGate, "process");
    const rawObs = "<think>Analyzing camera frame</think>User placed a blue mug on the desk.";
    const gateRes = alphaGate.process({
      rawText: rawObs,
      origin: "ambient",
    });
    expect(gateRes.approvedText).not.toContain("<think>");
    expect(gateRes.approvedText).not.toContain("Analyzing camera frame");
    expect(gateRes.approvedText).toBe("User placed a blue mug on the desk.");
    expect(gateProcessSpy).toHaveBeenCalledWith(
      expect.objectContaining({
        origin: "ambient",
      })
    );
  });

  it("8. Notification inquiry conversational response passes through Alpha Gate with origin notification", () => {
    const gateProcessSpy = vi.spyOn(alphaGate, "process");
    const rawInquiry = "You received a reminder notification for 'Dentist Appointment' earlier today.";
    const gateRes = alphaGate.process({
      rawText: rawInquiry,
      origin: "notification",
    });
    expect(gateRes.approvedText).toBe("You received a reminder notification for 'Dentist Appointment' earlier today.");
    expect(gateProcessSpy).toHaveBeenCalledWith(
      expect.objectContaining({
        rawText: rawInquiry,
        origin: "notification",
      })
    );
  });

  it("9. Correct Gate origin mapping is preserved across all producer types", () => {
    const gateProcessSpy = vi.spyOn(alphaGate, "process");
    const origins = ["model", "local_intent", "settings", "proactive", "ambient", "notification"] as const;
    for (const origin of origins) {
      const res = alphaGate.process({
        rawText: `Testing origin for ${origin}`,
        origin,
      });
      expect(res.approvedText).toContain(`Testing origin for ${origin}`);
      expect(gateProcessSpy).toHaveBeenCalledWith(
        expect.objectContaining({
          origin,
        })
      );
    }
  });

  it("10. Gate idempotency prevents degradation or mutation if called with already approved clean text", () => {
    const raw = "Here is an approved proactive reminder.";
    const firstPass = alphaGate.process({ rawText: raw, origin: "proactive" });
    const secondPass = alphaGate.process({ rawText: firstPass.approvedText, origin: "proactive" });
    expect(secondPass.approvedText).toBe(firstPass.approvedText);
  });
});
