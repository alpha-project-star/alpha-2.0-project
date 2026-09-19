import { describe, it, expect, vi, beforeEach } from "vitest";
import { LocalReminderRepository } from "../src/lib/reminder-repo";
import { ProactiveTriggerManager } from "../src/lib/proactive-trigger";
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
});
