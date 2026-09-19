import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { LocalReminderRepository, InMemoryReminderRepository } from "../src/lib/reminder-repo";
import { executeActionTagsAsync } from "../src/lib/actions";
import { activity } from "../src/lib/activity";
import { fireAlarm } from "../src/lib/alarm-engine";
import { alphaStore, PersistenceError } from "../src/lib/alpha-store";
import { restoreAlphaData, importAlphaData } from "../src/lib/data-portability";
import * as voiceModule from "../src/lib/voice";

describe("Foundation Hardening - Workstreams Verification", () => {
  let originalWindow: any;
  let storeMap: Map<string, string>;

  beforeEach(() => {
    originalWindow = (globalThis as any).window;
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
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
    };
  });

  afterEach(() => {
    vi.restoreAllMocks();
    if (originalWindow !== undefined) {
      (globalThis as any).window = originalWindow;
    } else {
      delete (globalThis as any).window;
    }
  });

  describe("Workstream 1 & 2: LocalReminderRepository (Local-First Authority)", () => {
    it("creates, retrieves, updates, and deletes reminders locally without Firebase", async () => {
      const repo = new LocalReminderRepository();
      const userId = "local-user";
      const reminderId = "rem-foundation-1";

      // Create reminder
      await repo.createReminder(userId, {
        id: reminderId,
        userId,
        title: "Buy groceries",
        notes: "Milk and bread",
        dueAt: Date.now() + 3600000,
        createdAt: Date.now(),
        updatedAt: Date.now(),
        reminderState: "active",
        notificationState: "pending",
      });

      const retrieved = await repo.getReminder(userId, reminderId);
      expect(retrieved).not.toBeNull();
      expect(retrieved?.id).toBe(reminderId);
      expect(retrieved?.title).toBe("Buy groceries");
      expect(retrieved?.reminderState).toBe("active");

      // Verify it's persisted in local storage
      const persistedRaw = storeMap.get("alpha.reminders.v1.local-user");
      expect(persistedRaw).toBeDefined();
      expect(persistedRaw).toContain("Buy groceries");

      // List reminders
      const list = await repo.listReminders(userId);
      expect(list.length).toBe(1);
      expect(list[0].id).toBe(reminderId);

      // Update reminder
      await repo.updateReminder(userId, reminderId, {
        title: "Buy groceries and fruit",
      });
      const updated = await repo.getReminder(userId, reminderId);
      expect(updated?.title).toBe("Buy groceries and fruit");

      // Complete reminder
      await repo.updateReminder(userId, reminderId, { reminderState: "completed" });
      const completed = await repo.getReminder(userId, reminderId);
      expect(completed?.reminderState).toBe("completed");

      // Delete reminder
      await repo.deleteReminder(userId, reminderId);
      const remaining = await repo.listReminders(userId);
      expect(remaining.length).toBe(0);
    });

    it("valid canonical reminder loads successfully", async () => {
      const repo = new LocalReminderRepository();
      storeMap.set(
        "alpha.reminders.v1.local-user",
        JSON.stringify([
          {
            id: "rem-1",
            userId: "local-user",
            title: "Doctor",
            notes: "Checkup",
            dueAt: 1700000000000,
            createdAt: 1690000000000,
            updatedAt: 1690000000000,
            reminderState: "active",
            notificationState: "pending",
          },
        ])
      );
      const reminders = await repo.listReminders("local-user");
      expect(reminders.length).toBe(1);
      expect(reminders[0].id).toBe("rem-1");
    });

    it("missing userId fails with PersistenceError", async () => {
      const repo = new LocalReminderRepository();
      storeMap.set(
        "alpha.reminders.v1.local-user",
        JSON.stringify([
          {
            id: "rem-1",
            title: "Doctor",
            notes: "Checkup",
            dueAt: 1700000000000,
            createdAt: 1690000000000,
            updatedAt: 1690000000000,
            reminderState: "active",
            notificationState: "pending",
          },
        ])
      );
      await expect(repo.listReminders("local-user")).rejects.toThrow(PersistenceError);
    });

    it("missing createdAt fails with PersistenceError", async () => {
      const repo = new LocalReminderRepository();
      storeMap.set(
        "alpha.reminders.v1.local-user",
        JSON.stringify([
          {
            id: "rem-1",
            userId: "local-user",
            title: "Doctor",
            notes: "Checkup",
            dueAt: 1700000000000,
            updatedAt: 1690000000000,
            reminderState: "active",
            notificationState: "pending",
          },
        ])
      );
      await expect(repo.listReminders("local-user")).rejects.toThrow(PersistenceError);
    });

    it("missing updatedAt fails with PersistenceError", async () => {
      const repo = new LocalReminderRepository();
      storeMap.set(
        "alpha.reminders.v1.local-user",
        JSON.stringify([
          {
            id: "rem-1",
            userId: "local-user",
            title: "Doctor",
            notes: "Checkup",
            dueAt: 1700000000000,
            createdAt: 1690000000000,
            reminderState: "active",
            notificationState: "pending",
          },
        ])
      );
      await expect(repo.listReminders("local-user")).rejects.toThrow(PersistenceError);
    });

    it("missing notes fails if required by canonical type", async () => {
      const repo = new LocalReminderRepository();
      storeMap.set(
        "alpha.reminders.v1.local-user",
        JSON.stringify([
          {
            id: "rem-1",
            userId: "local-user",
            title: "Doctor",
            dueAt: 1700000000000,
            createdAt: 1690000000000,
            updatedAt: 1690000000000,
            reminderState: "active",
            notificationState: "pending",
          },
        ])
      );
      await expect(repo.listReminders("local-user")).rejects.toThrow(PersistenceError);
    });

    it("invalid dueAt fails with PersistenceError", async () => {
      const repo = new LocalReminderRepository();
      storeMap.set(
        "alpha.reminders.v1.local-user",
        JSON.stringify([
          {
            id: "rem-1",
            userId: "local-user",
            title: "Doctor",
            notes: "",
            dueAt: "tomorrow",
            createdAt: 1690000000000,
            updatedAt: 1690000000000,
            reminderState: "active",
            notificationState: "pending",
          },
        ])
      );
      await expect(repo.listReminders("local-user")).rejects.toThrow(PersistenceError);
    });

    it("invalid reminderState fails with PersistenceError", async () => {
      const repo = new LocalReminderRepository();
      storeMap.set(
        "alpha.reminders.v1.local-user",
        JSON.stringify([
          {
            id: "rem-1",
            userId: "local-user",
            title: "Doctor",
            notes: "",
            dueAt: 1700000000000,
            createdAt: 1690000000000,
            updatedAt: 1690000000000,
            reminderState: "not_a_valid_state",
            notificationState: "pending",
          },
        ])
      );
      await expect(repo.listReminders("local-user")).rejects.toThrow(PersistenceError);
    });

    it("invalid notificationState fails with PersistenceError", async () => {
      const repo = new LocalReminderRepository();
      storeMap.set(
        "alpha.reminders.v1.local-user",
        JSON.stringify([
          {
            id: "rem-1",
            userId: "local-user",
            title: "Doctor",
            notes: "",
            dueAt: 1700000000000,
            createdAt: 1690000000000,
            updatedAt: 1690000000000,
            reminderState: "active",
            notificationState: "unknown_state",
          },
        ])
      );
      await expect(repo.listReminders("local-user")).rejects.toThrow(PersistenceError);
    });

    it("duplicate reminder IDs fail with PersistenceError", async () => {
      const repo = new LocalReminderRepository();
      storeMap.set(
        "alpha.reminders.v1.local-user",
        JSON.stringify([
          {
            id: "rem-dup",
            userId: "local-user",
            title: "Doctor",
            notes: "",
            dueAt: 1700000000000,
            createdAt: 1690000000000,
            updatedAt: 1690000000000,
            reminderState: "active",
            notificationState: "pending",
          },
          {
            id: "rem-dup",
            userId: "local-user",
            title: "Dentist",
            notes: "",
            dueAt: 1700000000000,
            createdAt: 1690000000000,
            updatedAt: 1690000000000,
            reminderState: "active",
            notificationState: "pending",
          },
        ])
      );
      await expect(repo.listReminders("local-user")).rejects.toThrow(PersistenceError);
    });

    it("wrong-user reminder fails with PersistenceError", async () => {
      const repo = new LocalReminderRepository();
      storeMap.set(
        "alpha.reminders.v1.user-alice",
        JSON.stringify([
          {
            id: "rem-wrong-user",
            userId: "user-bob",
            title: "Doctor",
            notes: "",
            dueAt: 1700000000000,
            createdAt: 1690000000000,
            updatedAt: 1690000000000,
            reminderState: "active",
            notificationState: "pending",
          },
        ])
      );
      await expect(repo.listReminders("user-alice")).rejects.toThrow(PersistenceError);
    });

    it("malformed persisted data does not become an empty reminder collection", async () => {
      const repo = new LocalReminderRepository();
      storeMap.set("alpha.reminders.v1.local-user", "{ corrupted json syntax");
      await expect(repo.listReminders("local-user")).rejects.toThrow(PersistenceError);
    });

    it("missing storage still correctly represents an empty collection", async () => {
      const repo = new LocalReminderRepository();
      const empty = await repo.listReminders("local-user");
      expect(empty).toEqual([]);
    });
  });

  describe("Workstream 3: Strict Reminder Input Parsing (No Invented Times)", () => {
    it("rejects ADD_REMINDER tag when time cannot be parsed and does NOT create a reminder", async () => {
      const repo = new LocalReminderRepository();
      const input = "[[ADD_REMINDER: Call doctor | not-a-valid-time-string-ever | checkup]]";

      const { text, results } = await executeActionTagsAsync(input, {
        userId: "local-user",
        repo,
      });

      expect(results.length).toBe(1);
      expect(["failed", "invalid"]).toContain(results[0].status);
      expect(results[0].message).toContain("couldn't understand when to remind");

      // Verify no reminder was created
      const reminders = await repo.listReminders("local-user");
      expect(reminders.length).toBe(0);
    });

    it("accepts ADD_REMINDER tag when time is valid and persists the reminder", async () => {
      const repo = new LocalReminderRepository();
      const validIso = new Date(Date.now() + 7200000).toISOString();
      const input = `[[ADD_REMINDER: Dentist appointment | ${validIso} | Routine cleaning]]`;

      const { results } = await executeActionTagsAsync(input, {
        userId: "local-user",
        repo,
      });

      expect(results.length).toBe(1);
      expect(results[0].status).toBe("success");

      const reminders = await repo.listReminders("local-user");
      expect(reminders.length).toBe(1);
      expect(reminders[0].title).toBe("Dentist appointment");
    });

    it("rejects UPDATE_REMINDER tag when new time is invalid and does not update targetTime", async () => {
      const repo = new LocalReminderRepository();
      const initialTime = Date.now() + 7200000;
      await repo.createReminder("local-user", {
        id: "rem-standup-1",
        userId: "local-user",
        title: "Team Standup",
        notes: "",
        dueAt: initialTime,
        createdAt: Date.now(),
        updatedAt: Date.now(),
        reminderState: "active",
        notificationState: "pending",
      });

      const input = `[[UPDATE_REMINDER: Team Standup | invalid-time-random-words]]`;
      const { results } = await executeActionTagsAsync(input, {
        userId: "local-user",
        repo,
      });

      expect(results.length).toBe(1);
      expect(["failed", "invalid"]).toContain(results[0].status);
      expect(results[0].message).toContain("nothing was changed");

      // Ensure the reminder's dueAt remains unchanged
      const current = await repo.getReminder("local-user", "rem-standup-1");
      expect(current?.dueAt).toBe(initialTime);
    });
  });

  describe("Workstream 5: Activity Lifecycle Protection & Interruption", () => {
    it("newer session prevents older session from clearing or overwriting activity", () => {
      activity.reset();
      const session1 = activity.start("thinking", "First pass");
      expect(activity.get().kind).toBe("thinking");

      // Start a second newer session
      const session2 = activity.start("calling_tool", "Tool pass");
      expect(activity.get().kind).toBe("calling_tool");

      // Older session1 tries to clear activity — should be ignored!
      session1.clear();
      expect(activity.get().kind).toBe("calling_tool");

      // Older session1 tries to set new state — should be ignored!
      session1.set("listening");
      expect(activity.get().kind).toBe("calling_tool");

      // Newer session2 clears — should succeed!
      session2.clear();
      expect(activity.get().kind).toBe("idle");
    });

    it("activity.interrupt resets activity immediately and increments generation", () => {
      const session = activity.start("thinking");
      expect(activity.get().kind).toBe("thinking");

      activity.interrupt();
      expect(activity.get().kind).toBe("idle");

      // In-flight operation from previous session cannot mutate
      session.set("speaking");
      expect(activity.get().kind).toBe("idle");
    });
  });

  describe("Workstream 6: Unified Voice & Alarm Authority", () => {
    it("fireAlarm preempts ongoing speech using stopSpeaking", () => {
      const stopSpy = vi.spyOn(voiceModule, "stopSpeaking").mockImplementation(() => {});
      const speakSpy = vi.spyOn(voiceModule, "speakWith").mockImplementation(() => Promise.resolve());

      // Ensure voice is enabled
      alphaStore.setSettings({ voiceEnabled: true });

      fireAlarm("Medicine time", "Take antibiotics");

      expect(stopSpy).toHaveBeenCalled();
      expect(speakSpy).toHaveBeenCalledWith("Excuse me — reminder: Medicine time. Take antibiotics");
    });

    it("fireAlarm respects mute setting and does not speak or chime when voiceEnabled is false", () => {
      const stopSpy = vi.spyOn(voiceModule, "stopSpeaking").mockImplementation(() => {});
      const speakSpy = vi.spyOn(voiceModule, "speakWith").mockImplementation(() => Promise.resolve());

      // Mute voice
      alphaStore.setSettings({ voiceEnabled: false });

      fireAlarm("Medicine time", "Take antibiotics");

      expect(stopSpy).not.toHaveBeenCalled();
      expect(speakSpy).not.toHaveBeenCalled();

      // Reset setting
      alphaStore.setSettings({ voiceEnabled: true });
    });
  });

  describe("Workstream 8: Persistence Truthfulness (Persist Before Commit)", () => {
    it("fails cleanly and does not mutate in-memory notes if storage write throws", () => {
      const initialNotesCount = alphaStore.get().notes.length;

      // Make storage throw on setItem
      (globalThis as any).window.localStorage.setItem = vi.fn(() => {
        throw new Error("Disk full / Quota exceeded");
      });

      expect(() => {
        alphaStore.upsertNote({
          id: "note-fail-test",
          title: "Important note",
          body: "Should not be persisted or retained in memory",
          updatedAt: Date.now(),
        });
      }).toThrow(PersistenceError);

      // Verify in-memory state was NOT mutated
      expect(alphaStore.get().notes.length).toBe(initialNotesCount);
      expect(alphaStore.get().notes.some((n) => n.id === "note-fail-test")).toBe(false);
    });

    it("fails cleanly and does not mutate in-memory bills if storage write throws", () => {
      const initialBillsCount = alphaStore.get().bills.length;

      (globalThis as any).window.localStorage.setItem = vi.fn(() => {
        throw new Error("Quota exceeded");
      });

      expect(() => {
        alphaStore.upsertBill({
          id: "bill-fail-test",
          name: "Water Bill",
          amount: 50,
          dueDate: "2026-10-01",
          balance: 50,
          status: "due",
        });
      }).toThrow(PersistenceError);

      expect(alphaStore.get().bills.length).toBe(initialBillsCount);
      expect(alphaStore.get().bills.some((b) => b.id === "bill-fail-test")).toBe(false);
    });
  });

  describe("Foundation Repair: Reminder Import & Lookup Invariants", () => {
    it("rejects reminder import when reminder userId does not match currentUid", async () => {
      const now = Date.now();
      const backupData = {
        version: 2,
        exportedAt: new Date().toISOString(),
        localStorage: {},
        reminders: [
          {
            id: "rem-user-mismatch-1",
            userId: "foreign-user-id-999",
            title: "Foreign task",
            notes: "",
            dueAt: now + 60000,
            createdAt: now,
            updatedAt: now,
            reminderState: "active",
            notificationState: "pending",
          },
        ],
      };

      await expect(importAlphaData(JSON.stringify(backupData))).rejects.toThrow(
        /does not match authenticated user/i,
      );
    });

    it("rejects reminder import when duplicate reminder IDs are present in the import payload", async () => {
      const now = Date.now();
      const currentUid = "local-user";
      const backupData = {
        version: 2,
        exportedAt: new Date().toISOString(),
        localStorage: {},
        reminders: [
          {
            id: "duplicate-rem-id",
            userId: currentUid,
            title: "First task",
            notes: "",
            dueAt: now + 60000,
            createdAt: now,
            updatedAt: now,
            reminderState: "active",
            notificationState: "pending",
          },
          {
            id: "duplicate-rem-id",
            userId: currentUid,
            title: "Second task with same ID",
            notes: "",
            dueAt: now + 120000,
            createdAt: now,
            updatedAt: now,
            reminderState: "active",
            notificationState: "pending",
          },
        ],
      };

      await expect(importAlphaData(JSON.stringify(backupData))).rejects.toThrow(
        /duplicate reminder ID "duplicate-rem-id"/i,
      );
    });

    it("propagates repository lookup failure in executeActionTagsAsync for UPDATE_REMINDER", async () => {
      const failingRepo = new InMemoryReminderRepository();
      failingRepo.listReminders = vi.fn().mockRejectedValue(new Error("Storage disk corrupted"));

      const res = await executeActionTagsAsync("[[UPDATE_REMINDER: dentist | when: tomorrow 9am]]", {
        repo: failingRepo,
        userId: "local-user",
      });

      expect(res.results.length).toBe(1);
      expect(res.results[0].status).toBe("failed");
      expect(res.results[0].message).toContain("Could not access reminders: Storage disk corrupted");
    });

    it("propagates repository lookup failure in executeActionTagsAsync for DELETE_REMINDER", async () => {
      const failingRepo = new InMemoryReminderRepository();
      failingRepo.listReminders = vi.fn().mockRejectedValue(new Error("Storage disk corrupted"));

      const res = await executeActionTagsAsync("[[DELETE_REMINDER: dentist]]", {
        repo: failingRepo,
        userId: "local-user",
      });

      expect(res.results.length).toBe(1);
      expect(res.results[0].status).toBe("failed");
      expect(res.results[0].message).toContain("Could not access reminders: Storage disk corrupted");
    });
  });
});
