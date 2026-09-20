// src/lib/reminder-scheduler.ts

import { FirestoreReminder, ReminderRepository, InMemoryReminderRepository } from './reminder-repo';
import { temporal } from './temporal';
import { alphaStore } from './alpha-store';
import { ReminderDueEvent, generateReminderEventId } from './reminder-events';
import { ReminderEventDelivery } from './reminder-event-delivery';
import { fireAlarm } from './alarm-engine';

export { InMemoryReminderRepository };
export type { ReminderDueEvent };

export interface SchedulerOptions {
  pollingIntervalMs?: number;
  repo?: ReminderRepository;
  eventDelivery?: ReminderEventDelivery;
  onReminderDue?: (event: ReminderDueEvent) => void;
  onError?: (error: Error) => void;
}

export class ReminderScheduler {
  private repo?: ReminderRepository;
  private userId?: string;
  private eventDelivery?: ReminderEventDelivery;
  private options: SchedulerOptions;
  private timer: NodeJS.Timeout | null = null;
  private isRunning = false;
  private processingIds = new Set<string>();

  constructor(
    userIdOrOptions?: string | SchedulerOptions,
    repo?: ReminderRepository,
    options: SchedulerOptions = {},
  ) {
    if (typeof userIdOrOptions === 'string') {
      if (userIdOrOptions === '') throw new Error('userId is required for ReminderScheduler');
      this.userId = userIdOrOptions;
      this.repo = repo;
      this.options = {
        pollingIntervalMs: 5000,
        ...options,
      };
    } else if (typeof userIdOrOptions === 'object' && userIdOrOptions !== null) {
      this.options = {
        pollingIntervalMs: 5000,
        ...userIdOrOptions,
      };
      this.repo = userIdOrOptions.repo || repo;
      this.eventDelivery = userIdOrOptions.eventDelivery;
    } else {
      this.options = {
        pollingIntervalMs: 5000,
        ...options,
      };
      this.repo = repo;
    }
  }

  public setUser(userId?: string, repo?: ReminderRepository): void {
    this.userId = userId;
    if (repo) {
      this.repo = repo;
    }
  }

  public getUserId(): string | undefined {
    return this.userId;
  }

  public getRepo(): ReminderRepository | undefined {
    return this.repo;
  }

  /**
   * Application-level recovery: resets stale claims whose ownership window has expired
   * (e.g. after an interrupted worker or closed tab).
   * Note: This timeout-based heuristic does not provide an unbreakable lease or absolute consensus guarantee,
   * but allows recovery of abandoned claims.
   */
  public async recoverStaleClaims(
    userId: string,
    leaseTimeoutMs: number = 60000,
    nowTime: number = Date.now(),
  ): Promise<number> {
    if (!this.repo || !userId) return 0;
    let recoveredCount = 0;
    try {
      const reminders = await this.repo.listReminders(userId);
      for (const r of reminders) {
        if (
          r.userId === userId &&
          r.reminderState === 'active' &&
          r.notificationState === 'claimed'
        ) {
          const lastUpdate = r.updatedAt || r.createdAt || 0;
          if (nowTime - lastUpdate >= leaseTimeoutMs) {
            await this.repo.updateReminder(userId, r.id, {
              notificationState: 'pending',
              legacyFiredAt: undefined,
              updatedAt: nowTime,
            });
            recoveredCount++;
          }
        }
      }
    } catch {
      // Safe boundary
    }
    return recoveredCount;
  }

  /**
   * Evaluates reminders for a given user and current time deterministically.
   * Returns reminders that are due and eligible for firing.
   * Supports both synchronous evaluation of a reminder array and asynchronous evaluation for a userId string.
   */
  public evaluateDueReminders(
    remindersOrUserId: FirestoreReminder[] | string,
    nowTime?: number,
    userIdOverride?: string,
  ): FirestoreReminder[] | Promise<FirestoreReminder[]> {
    const targetTime = typeof nowTime === 'number' ? nowTime : temporal.now().getTime();

    if (typeof remindersOrUserId === 'string') {
      const targetUser = remindersOrUserId;
      if (!this.repo) return Promise.resolve([]);
      return (async () => {
        const list = await this.repo!.listReminders(targetUser);
        return this.evaluateDueReminders(list, targetTime, targetUser) as FirestoreReminder[];
      })();
    }

    const reminders = remindersOrUserId;
    let targetUser = userIdOverride || this.userId;
    if (!targetUser && Array.isArray(reminders) && reminders.length > 0) {
      targetUser = reminders[0].userId;
    }

    return (reminders || []).filter((r) => {
      // 1. User isolation check
      if (targetUser && r.userId !== targetUser) return false;

      // 2. Must be active (not completed or cancelled)
      if (r.reminderState !== 'active') return false;

      // 3. Must not be already claimed or accepted (processed)
      if (r.notificationState && r.notificationState !== 'pending') return false;

      // 4. Must have valid timestamp
      if (typeof r.dueAt !== 'number' || isNaN(r.dueAt) || r.dueAt <= 0) return false;

      // 5. Must be due (dueAt <= targetTime)
      if (r.dueAt > targetTime) return false;

      return true;
    });
  }

  /**
   * Executes a single scheduler tick: fetches reminders, evaluates due ones,
   * claims them under cross-context lock, and emits due events.
   */
  public async runTick(userIdOverride?: string, nowTimeOverride?: number): Promise<ReminderDueEvent[]> {
    const activeUser = userIdOverride || this.userId;
    if (!activeUser || !this.repo) return [];
    const now = typeof nowTimeOverride === 'number' ? nowTimeOverride : temporal.now().getTime();
    const events: ReminderDueEvent[] = [];

    try {
      const reminders = await this.repo.listReminders(activeUser);
      const dueReminders = await this.evaluateDueReminders(reminders, now, activeUser);

      for (const reminder of dueReminders) {
        if (this.processingIds.has(reminder.id)) continue;
        this.processingIds.add(reminder.id);

        try {
          // Concurrency & Idempotency check:
          const fresh = await this.repo.getReminder(activeUser, reminder.id);
          if (
            !fresh ||
            fresh.reminderState !== 'active' ||
            (fresh.notificationState && fresh.notificationState !== 'pending')
          ) {
            this.processingIds.delete(reminder.id);
            continue;
          }

          // Claim the reminder under cross-context lock
          await this.repo.updateReminder(activeUser, reminder.id, {
            notificationState: 'claimed',
            legacyFiredAt: now,
            updatedAt: Date.now(),
          });

          const event: ReminderDueEvent = {
            type: 'reminder_due',
            eventId: generateReminderEventId(reminder.id, reminder.dueAt),
            reminderId: reminder.id,
            userId: activeUser,
            dueAt: reminder.dueAt,
            detectedAt: now,
            title: reminder.title,
          };

          events.push(event);

          if (this.eventDelivery) {
            await this.eventDelivery.consumeEvent(event).catch(() => {});
          }

          if (this.options.onReminderDue) {
            this.options.onReminderDue(event);
          } else {
            fireAlarm(event.title, reminder.notes || "");
          }
        } catch (claimErr: any) {
          if (this.options.onError) {
            this.options.onError(claimErr);
          }
        } finally {
          this.processingIds.delete(reminder.id);
        }
      }
    } catch (tickErr: any) {
      if (this.options.onError) {
        this.options.onError(tickErr);
      }
    }

    return events;
  }

  public start(): void {
    if (this.isRunning) return;
    this.isRunning = true;
    const interval = this.options.pollingIntervalMs || 5000;
    this.timer = setInterval(() => {
      if (this.userId && this.repo) {
        this.runTick().catch((err) => {
          if (this.options.onError) this.options.onError(err);
        });
      }
    }, interval);
  }

  public stop(): void {
    if (!this.isRunning) return;
    this.isRunning = false;
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
  }

  public isActive(): boolean {
    return this.isRunning;
  }
}

export const reminderScheduler = new ReminderScheduler();


