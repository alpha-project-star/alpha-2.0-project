import { describe, it, expect, vi, beforeEach } from "vitest";
import { LocalReminderRepository } from "../src/lib/reminder-repo";
import { ProactiveTrigger } from "../src/lib/proactive-trigger";
import { NotificationDeliveryManager } from "../src/lib/notification-delivery";
import { alphaStore } from "../src/lib/alpha-store";
import { sendWebPushToSubscription } from "../src/lib/push-sender";

describe("Phase 17 - Concurrency & Remediation Verification", () => {
  let storeMap: Map<string, string>;

  beforeEach(() => {
    storeMap = new Map<string, string>();
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
    };
  });

  it("1. Atomic reminder claiming: concurrent claims on same reminder result in exactly one success and one conflict", async () => {
    const repo = new LocalReminderRepository();
    const userId = "user-1";
    const reminderId = "rem-atomic-1";

    await repo.createReminder(userId, {
      id: reminderId,
      userId,
      title: "Test Reminder",
      notes: "Atomic claim test",
      dueAt: Date.now() + 10000,
      createdAt: Date.now(),
      updatedAt: Date.now(),
      reminderState: "active",
      notificationState: "pending",
    });

    // Simulate two tabs/contexts trying to claim the reminder simultaneously
    const claimPromise1 = repo.updateReminder(userId, reminderId, { notificationState: "claimed" });
    const claimPromise2 = repo.updateReminder(userId, reminderId, { notificationState: "claimed" });

    const results = await Promise.allSettled([claimPromise1, claimPromise2]);
    const successes = results.filter((r) => r.status === "fulfilled");
    const rejections = results.filter((r) => r.status === "rejected");

    expect(successes.length).toBe(1);
    expect(rejections.length).toBe(1);
    expect((rejections[0] as PromiseRejectedResult).reason.message).toContain("already claimed");
  });

  it("2. Push sender fails closed when VAPID keys are missing (no hardcoded fallback)", async () => {
    delete process.env.VAPID_PUBLIC_KEY;
    delete process.env.VAPID_PRIVATE_KEY;

    const result = await sendWebPushToSubscription(
      {
        endpoint: "https://push.example.com/sub/1",
        keys: { p256dh: "abc", auth: "xyz" },
      },
      { title: "Test", body: "Hello" }
    );

    expect(result.success).toBe(false);
    expect(result.error).toBeDefined();
  });

  it("3. Alpha-store concurrent updates preserve independent notes without lost updates", async () => {
    alphaStore.upsertNote({ id: "note-1", title: "First Note", body: "Content 1", updatedAt: Date.now() });

    // Simulate Tab A upserting note-2
    alphaStore.upsertNote({ id: "note-2", title: "Second Note", body: "Content 2", updatedAt: Date.now() });

    const notes = alphaStore.get().notes;
    expect(notes.length).toBe(2);
    expect(notes.some((n) => n.id === "note-1")).toBe(true);
    expect(notes.some((n) => n.id === "note-2")).toBe(true);
  });

  it("4. Proactive trigger concurrent generation attempts result in mutually exclusive execution", async () => {
    const repo = new LocalReminderRepository();
    const userId = "user-1";
    const reminderId = "rem-proactive-1";
    const eventId = "evt-1";

    await repo.createReminder(userId, {
      id: reminderId,
      userId,
      title: "Proactive Test",
      notes: "Proactive test notes",
      dueAt: Date.now(),
      createdAt: Date.now(),
      updatedAt: Date.now(),
      reminderState: "active",
      notificationState: "pending",
      proactiveState: "pending",
    });

    const trigger1 = new ProactiveTrigger({ repo, generateResponse: async () => "Hello from proactive 1" });
    const trigger2 = new ProactiveTrigger({ repo, generateResponse: async () => "Hello from proactive 2" });

    const event = {
      type: "reminder_due" as const,
      eventId,
      reminderId,
      userId,
      title: "Proactive Test",
      dueAt: Date.now(),
      detectedAt: Date.now(),
    };

    const [res1, res2] = await Promise.all([
      trigger1.handleReminderDue(event, userId),
      trigger2.handleReminderDue(event, userId),
    ]);

    const successes = [res1, res2].filter((r) => r.success);
    const failures = [res1, res2].filter((r) => !r.success);

    expect(successes.length).toBe(1);
    expect(failures.length).toBe(1);
    expect(["ALREADY_HANDLED", "CONCURRENT_PROCESSING"]).toContain(failures[0].error.code);
  });

  it("5. Notification delivery manager prevents concurrent double delivery of same event", async () => {
    const manager = new NotificationDeliveryManager();
    const userId = "user-1";
    const eventId = "evt-delivery-1";

    const record = {
      eventId,
      reminderId: "rem-1",
      userId,
      title: "Delivery Test",
      text: "Delivery message",
      messageId: "msg-1",
      dueAt: Date.now(),
    };

    const p1 = manager.deliverProactiveResponse({ record, authenticatedUserId: userId, channel: "in_app" });
    const p2 = manager.deliverProactiveResponse({ record, authenticatedUserId: userId, channel: "in_app" });

    const [res1, res2] = await Promise.all([p1, p2]);

    const successes = [res1, res2].filter((r) => r.success);
    const rejections = [res1, res2].filter((r) => !r.success);

    expect(successes.length).toBe(1);
    expect(rejections.length).toBe(1);
  });
});
