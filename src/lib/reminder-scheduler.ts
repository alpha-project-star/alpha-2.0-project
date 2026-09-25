// src/lib/reminder-scheduler.ts

import { FirestoreReminder, ReminderRepository, InMemoryReminderRepository } from './reminder-repo';
import { temporal } from './temporal';
import { alphaStore } from './alpha-store';
import { ReminderDueEvent, generateReminderEventId } from './reminder-events';
import { ReminderEventDelivery, reminderEventDelivery } from './reminder-event-delivery';
import { fireAlarm } from './alarm-engine';
import { withCrossContextLock } from './cross-context-lock';
import { handleReminderDue } from './proactive-trigger';
import { notificationAcknowledgementManager } from './notification-acknowledgement';

export { InMemoryReminderRepository };
export type { ReminderDueEvent };

export interface SchedulerOptions {
  pollingIntervalMs?: number;
  repo?: ReminderRepository;
  eventDelivery?: ReminderEventDelivery;
  onReminderDue?: (event: ReminderDueEvent) => Promise<void> | void;
  onError?: (error: Error) => void;
  enableProactive?: boolean;
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
      this.eventDelivery = options.eventDelivery;
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
      this.eventDelivery = options.eventDelivery;
    }
  }

  public setUser(userId?: string, repo?: ReminderRepository): void {
    this.userId = userId;
    if (repo) {
      this.repo = repo;
      this.getEventDelivery().setRepo(repo);
      notificationAcknowledgementManager.setReminderRepository(repo);
    }
  }

  public getEventDelivery(): ReminderEventDelivery {
    if (!this.eventDelivery) {
      this.eventDelivery = new ReminderEventDelivery(this.repo);
    } else if (this.repo) {
      this.eventDelivery.setRepo(this.repo);
    }
    return this.eventDelivery;
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
            const lockName = `alpha_scheduler_lock_${userId}_${r.id}`;
            await withCrossContextLock(lockName, async () => {
              const fresh = await this.repo!.getReminder(userId, r.id);
              if (fresh && fresh.notificationState === 'claimed') {
                const freshUpdate = fresh.updatedAt || fresh.createdAt || 0;
                if (nowTime - freshUpdate >= leaseTimeoutMs) {
                  await this.repo!.updateReminder(userId, r.id, {
                    notificationState: 'pending',
                    legacyFiredAt: undefined,
                    updatedAt: nowTime,
                  });
                  recoveredCount++;
                }
              }
            });
          }
        }
      }
    } catch {
      // Safe boundary
    }
    return recoveredCount;
  }

  public async markPassedReminders(userId: string, now: number): Promise<void> {
    if (!this.repo) return;
    const reminders = await this.repo.listReminders(userId);
    for (const r of reminders) {
      if (r.reminderState === 'active' && r.dueAt < now) {
         await this.repo.updateReminder(userId, r.id, { reminderState: 'passed', updatedAt: now });
      }
    }
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

      // 3. Must not be already acknowledged (processed)
      // (This is now handled by checking notificationAcknowledgementManager)
      // if (r.notificationState && r.notificationState !== 'pending') return false;

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
      // await this.markPassedReminders(activeUser, now);
      const reminders = await this.repo.listReminders(activeUser);
      const dueReminders = await this.evaluateDueReminders(reminders, now, activeUser);

      // Handle Repetition
      for (const reminder of reminders) {
        if (
          reminder.reminderState === 'active' &&
          reminder.nextRepeatAt &&
          now >= reminder.nextRepeatAt
        ) {
          const ackStatus = await notificationAcknowledgementManager.getAcknowledgementStatus(activeUser, generateReminderEventId(reminder.id, reminder.dueAt));
          if (ackStatus !== 'acknowledged') {
            // Schedule repetition
            dueReminders.push(reminder);
          } else {
             // Already acknowledged, clear repeat fields
             await this.repo.updateReminder(activeUser, reminder.id, {
                nextRepeatAt: undefined,
                repetitionCount: 0,
                updatedAt: now
             });
          }
        }
      }

      for (const reminder of dueReminders) {
        if (this.processingIds.has(reminder.id)) continue;
        this.processingIds.add(reminder.id);

        try {
          const lockName = `alpha_scheduler_lock_${activeUser}_${reminder.id}`;
          await withCrossContextLock(lockName, async () => {
            // Concurrency & Idempotency check:
            const fresh = await this.repo!.getReminder(activeUser, reminder.id);
            if (!fresh || fresh.reminderState !== 'active') {
              return;
            }

            const event: ReminderDueEvent = {
              type: 'reminder_due',
              eventId: generateReminderEventId(reminder.id, reminder.dueAt),
              reminderId: reminder.id,
              userId: activeUser,
              dueAt: reminder.dueAt,
              detectedAt: now,
              title: reminder.title,
            };

            const ackStatus = await notificationAcknowledgementManager.getAcknowledgementStatus(activeUser, event.eventId);
            if (ackStatus === 'acknowledged') {
                this.processingIds.delete(reminder.id);
                return;
            }

            const consumerFn = async (evt: ReminderDueEvent): Promise<void> => {
              if (this.options.onReminderDue) {
                await this.options.onReminderDue(evt);
              } else if (this.options.enableProactive) {
                const proactiveRes = await handleReminderDue(evt, activeUser, { repo: this.repo });
                if (!proactiveRes.success) {
                  if (proactiveRes.error.code === 'ALREADY_HANDLED') {
                    return;
                  }
                  throw new Error(`Proactive handling failed: ${proactiveRes.error.message}`);
                }
              } else {
                fireAlarm(evt.title, reminder.notes || "");
              }
            };

            const delivery = this.getEventDelivery();
            const deliveryResult = await delivery.consumeEvent(event, consumerFn);

            if (deliveryResult.success) {
              events.push(event);
            } else if (deliveryResult.status === 'failed') {
              if (this.options.onError) {
                this.options.onError(new Error(`Reminder event consumption failed: ${deliveryResult.error}`));
              }
            }
          });
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


