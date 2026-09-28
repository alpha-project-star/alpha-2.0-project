import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { alphaStore, uid, type ChatMessage } from "../src/lib/alpha-store";
import { alphaGate } from "../src/lib/alpha-gate";
import { buildMorningBrief, tick } from "../src/lib/proactive";
import { notificationDelivery } from "../src/lib/notification-delivery";
import { InMemoryReminderRepository } from "../src/lib/reminder-repo";
import { sendChat, finalizeReply } from "../src/lib/alpha.functions";
import { notificationRecoveryManager } from "../src/lib/notification-recovery";
import { notificationAcknowledgementManager } from "../src/lib/notification-acknowledgement";
import { auth } from "../src/lib/firebase";

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

  it("1. Proactive Morning Brief producer path passes through Alpha Gate with origin proactive", async () => {
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

    // Execute real tick() producer path
    await alphaStore.setSettings({ backgroundEnabled: true });
    await tick(true, {
      userId: "user-1",
      repo,
      now: new Date(new Date().setHours(8, 0, 0, 0)),
    });

    const proactiveCall = gateProcessSpy.mock.calls.find(
      (call) => call[0].origin === "proactive" && call[0].rawText.includes("Team Standup")
    );
    expect(proactiveCall).toBeDefined();
    expect(proactiveCall![0].origin).toBe("proactive");

    // Confirm chat storage received approved text
    const chat = alphaStore.get().chat;
    const briefMsg = chat.find((m) => m.text.includes("Team Standup"));
    expect(briefMsg).toBeDefined();
  });

  it("2. Proactive task/schedule nudge producer path passes through Alpha Gate", async () => {
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

    const chat = alphaStore.get().chat;
    const taskMsg = chat.find((m) => m.text.includes("Submit Financial Report"));
    expect(taskMsg).toBeDefined();
  });

  it("3. Proactive overdue-bills producer path passes through Alpha Gate", async () => {
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

    const chat = alphaStore.get().chat;
    const billMsg = chat.find((m) => m.text.includes("overdue"));
    expect(billMsg).toBeDefined();
  });

  it("4. Notification delivery real-path passes through Alpha Gate with origin notification", async () => {
    const gateProcessSpy = vi.spyOn(alphaGate, "process");
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

  it("5. Notification delivery cleans reasoning tags through Gate before storing", async () => {
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

  it("6. Ambient vision response producer uses origin ambient and cleans leaked reasoning", async () => {
    const gateProcessSpy = vi.spyOn(alphaGate, "process");

    const rawAmbientOutput = "<think>Analyzing visual camera frame</think>User placed a coffee cup on the desk.";
    const approved = await finalizeReply(rawAmbientOutput, "", undefined, { origin: "ambient" });

    expect(approved).not.toContain("<think>");
    expect(approved).not.toContain("Analyzing visual camera frame");
    expect(approved).toBe("User placed a coffee cup on the desk.");

    const ambientCall = gateProcessSpy.mock.calls.find(
      (call) => call[0].origin === "ambient" && call[0].rawText.includes("coffee cup")
    );
    expect(ambientCall).toBeDefined();
    expect(ambientCall![0].origin).toBe("ambient");
  });

  it("7. Ambient vision response producer has EXACTLY ONE Alpha Gate boundary (no double-gating)", async () => {
    const gateProcessSpy = vi.spyOn(alphaGate, "process");

    const rawAmbientOutput = "Movement detected in the kitchen doorway.";
    const approved = await finalizeReply(rawAmbientOutput, "", undefined, { origin: "ambient" });

    expect(approved).toBe("Movement detected in the kitchen doorway.");

    // Filter calls for this specific text
    const relevantCalls = gateProcessSpy.mock.calls.filter(
      (call) => call[0].rawText.includes("Movement detected in the kitchen doorway")
    );
    // MUST BE EXACTLY ONE
    expect(relevantCalls.length).toBe(1);
    expect(relevantCalls[0][0].origin).toBe("ambient");
  });

  it("8. Notification inquiry conversational response passes through Alpha Gate with origin notification", async () => {
    const gateProcessSpy = vi.spyOn(alphaGate, "process");
    (auth as any).currentUser = { uid: "test-user-id" };

    // Setup an inquiry reply through the notification recovery manager
    vi.spyOn(notificationRecoveryManager, "handleConversationalInquiry").mockResolvedValue(
      "You had a reminder for 'Team Standup' at 9:00 AM."
    );

    // Append user inquiry to history (phrased so it does not match local CRUD list/delete intents)
    await alphaStore.appendChat({
      id: uid(),
      role: "user",
      text: "tell me about my missed notification alert from earlier",
      ts: Date.now(),
    });

    const reply = await sendChat(alphaStore.get().chat);

    expect(reply).toBe("You had a reminder for 'Team Standup' at 9:00 AM.");

    const notifCall = gateProcessSpy.mock.calls.find(
      (call) => call[0].origin === "notification" && call[0].rawText.includes("Team Standup")
    );
    expect(notifCall).toBeDefined();
    expect(notifCall![0].origin).toBe("notification");
  });

  it("9. Notification acknowledgement conversational response passes through Alpha Gate with origin notification", async () => {
    const gateProcessSpy = vi.spyOn(alphaGate, "process");
    (auth as any).currentUser = { uid: "test-user-id" };

    vi.spyOn(notificationAcknowledgementManager, "acknowledgeFromUserUtterance").mockResolvedValue({
      success: true,
      status: "acknowledged",
      acknowledgedEvents: ["evt-ack-1"],
      conversationalReply: "Acknowledged your 'Medication' reminder.",
    });

    await alphaStore.appendChat({
      id: uid(),
      role: "user",
      text: "I finished that reminder, thanks",
      ts: Date.now(),
    });

    const reply = await sendChat(alphaStore.get().chat);

    expect(reply).toBe("Acknowledged your 'Medication' reminder.");

    const ackCall = gateProcessSpy.mock.calls.find(
      (call) => call[0].origin === "notification" && call[0].rawText.includes("Acknowledged your 'Medication'")
    );
    expect(ackCall).toBeDefined();
    expect(ackCall![0].origin).toBe("notification");
  });

  it("10. Recovery delivery path for already-delivered reminders passes through Gate with origin notification", async () => {
    const gateProcessSpy = vi.spyOn(alphaGate, "process");
    const deliveryMgr = notificationDelivery;

    // Simulate recovery delivery when already delivered in repo but missing in chat
    const record = {
      eventId: "evt-rec-1",
      reminderId: "rem-rec-1",
      userId: "user-test",
      messageId: "msg-rec-1",
      text: "Reminder: Take evening vitamins.",
      title: "Take evening vitamins",
      dueAt: Date.now(),
    };

    // First delivery
    await deliveryMgr.deliverProactiveResponse({
      authenticatedUserId: "user-test",
      record,
      channel: "in_app",
    });

    // Clear chat to simulate missing in chat
    alphaStore.setChat([]);
    gateProcessSpy.mockClear();

    // Re-deliver (recovery path)
    const res = await deliveryMgr.deliverProactiveResponse({
      authenticatedUserId: "user-test",
      record,
      channel: "in_app",
    });

    expect(res.success).toBe(true);

    const recCall = gateProcessSpy.mock.calls.find(
      (call) => call[0].origin === "notification" && call[0].rawText.includes("Take evening vitamins")
    );
    expect(recCall).toBeDefined();
    expect(recCall![0].origin).toBe("notification");

    const chat = alphaStore.get().chat;
    const restoredMsg = chat.find((m) => m.proactiveEventId === "evt-rec-1");
    expect(restoredMsg).toBeDefined();
    expect(restoredMsg?.text).toBe(recCall![0].rawText);
  });
});
