// src/lib/reminder-event-delivery.ts

import { ReminderDueEvent, validateReminderDueEvent } from './reminder-events';
import { ReminderRepository, FirestoreReminder } from './reminder-repo';
import { temporal } from './temporal';
import { withCrossContextLock } from './cross-context-lock';

export type ConsumptionStatus = 
  | 'consumed'
  | 'already_consumed'
  | 'rejected'
  | 'failed'
  | 'locked';

export interface ConsumptionResult {
  status: ConsumptionStatus;
  eventId: string;
  error?: string;
}

export type EventSubscriber = (event: ReminderDueEvent) => Promise<void> | void;

export class ReminderEventDelivery {
  private repo?: ReminderRepository;
  private subscribers = new Set<EventSubscriber>();
  private inFlightClaims = new Set<string>();

  constructor(repoOrOptions?: ReminderRepository | { repo?: ReminderRepository }) {
    if (repoOrOptions && 'repo' in repoOrOptions && typeof (repoOrOptions as any).getReminder !== 'function') {
      this.repo = (repoOrOptions as any).repo;
    } else {
      this.repo = repoOrOptions as ReminderRepository | undefined;
    }
  }

  public setRepo(repo?: ReminderRepository): void {
    this.repo = repo;
  }

  /**
   * Registers an event subscriber to receive due reminder events.
   * Returns an unsubscribe callback.
   */
  public subscribe(handler: EventSubscriber): () => void {
    this.subscribers.add(handler);
    return () => {
      this.subscribers.delete(handler);
    };
  }

  /**
   * Dispatches an authoritative reminder_due event to all registered consumers.
   * Validates the event schema and user ownership boundary.
   */
  public async emitReminderDueEvent(
    rawEvent: unknown, 
    authenticatedUserId?: string
  ): Promise<{ deliveredCount: number; errors: Error[] }> {
    const validation = validateReminderDueEvent(rawEvent);
    if (!validation.success) {
      throw new Error(validation.error);
    }
    const event = validation.event;

    // Security: Validate user isolation
    if (authenticatedUserId && event.userId !== authenticatedUserId) {
      throw new Error(`User isolation violation: event user ${event.userId} does not match authenticated user ${authenticatedUserId}`);
    }

    const errors: Error[] = [];
    let deliveredCount = 0;

    for (const sub of Array.from(this.subscribers)) {
      try {
        await sub(event);
        deliveredCount++;
      } catch (err: any) {
        errors.push(err instanceof Error ? err : new Error(String(err)));
      }
    }

    return { deliveredCount, errors };
  }

  /**
   * Consumes an event safely:
   * 1. Validates event structure and user isolation.
   * 2. Checks authoritative reminder state in repository to avoid duplicate consumption.
   * 3. Executes consumer function if provided.
   * 4. Upon consumer success, authoritatively updates notificationState to 'accepted'.
   * 5. If consumer fails, leaves event unacknowledged for future retry.
   */
  public async consumeEvent(
    arg1: string | ReminderDueEvent,
    arg2?: unknown,
    arg3?: (event: ReminderDueEvent) => Promise<void>
  ): Promise<ConsumptionResult & { success?: boolean }> {
    let authenticatedUserId: string;
    let rawEvent: unknown;
    let consumerFn: ((event: ReminderDueEvent) => Promise<void>) | undefined;

    if (typeof arg1 === 'string') {
      authenticatedUserId = arg1;
      rawEvent = arg2;
      consumerFn = arg3;
    } else {
      rawEvent = arg1;
      authenticatedUserId = (arg1 as ReminderDueEvent)?.userId || '';
      consumerFn = typeof arg2 === 'function' ? (arg2 as any) : undefined;
    }

    if (!authenticatedUserId) {
      return { success: false, status: 'rejected', eventId: '', error: 'Authenticated user ID is required' };
    }

    const validation = validateReminderDueEvent(rawEvent);
    if (!validation.success) {
      return { 
        success: false,
        status: 'rejected', 
        eventId: (rawEvent as any)?.eventId || '', 
        error: validation.error 
      };
    }

    const event = validation.event;

    // Strict User Isolation Check
    if (event.userId !== authenticatedUserId) {
      return {
        success: false,
        status: 'rejected',
        eventId: event.eventId,
        error: `Access denied: Event belongs to ${event.userId}, caller is ${authenticatedUserId}`
      };
    }

    const lockName = `alpha_delivery_lock_${authenticatedUserId}_${event.reminderId}`;

    return await withCrossContextLock(lockName, async () => {
      // In-flight concurrency lock per event (same JS execution context)
      if (this.inFlightClaims.has(event.eventId)) {
        return {
          success: false,
          status: 'locked',
          eventId: event.eventId,
          error: 'Event is currently being processed by another consumer'
        };
      }

      this.inFlightClaims.add(event.eventId);

      try {
        if (this.repo) {
          // READ AUTHORITATIVE CURRENT REMINDER STATE INSIDE LOCK
          const reminder = await this.repo.getReminder(authenticatedUserId, event.reminderId);
          
          // Reminder existence check
          if (!reminder) {
            return {
              success: false,
              status: 'rejected',
              eventId: event.eventId,
              error: `Reminder ${event.reminderId} not found`
            };
          }

          // Active state check
          if (reminder.reminderState !== 'active') {
            return {
              success: false,
              status: 'rejected',
              eventId: event.eventId,
              error: `Reminder is in non-active state: ${reminder.reminderState}`
            };
          }

          // Already-consumed check (notificationState === 'accepted')
          if (reminder.notificationState === 'accepted') {
            return {
              success: true,
              status: 'already_consumed',
              eventId: event.eventId
            };
          }

          // Check if actively claimed by another context within lease
          if (reminder.notificationState === 'claimed') {
            const claimTime = reminder.updatedAt || 0;
            const now = temporal.now().getTime();
            if (now - claimTime < 30000) {
              return {
                success: false,
                status: 'locked',
                eventId: event.eventId,
                error: 'Event is currently claimed by another consumer'
              };
            }
          }

          // CLAIM / ADVANCE NOTIFICATION STATE
          await this.repo.updateReminder(authenticatedUserId, event.reminderId, {
            notificationState: 'claimed',
            updatedAt: Date.now()
          });
        }

        // EXECUTE CONSUMER ACTION
        if (consumerFn) {
          await consumerFn(event);
        }

        // FINALIZE PERSISTENT NOTIFICATION STATE
        // if (this.repo) {
        //   await this.repo.updateReminder(authenticatedUserId, event.reminderId, {
        //     notificationState: 'accepted',
        //     updatedAt: Date.now()
        //   });
        // }

        return {
          success: true,
          status: 'consumed',
          eventId: event.eventId
        };
      } catch (err: any) {
        if (this.repo) {
          try {
            await this.repo.updateReminder(authenticatedUserId, event.reminderId, {
              notificationState: 'pending',
              updatedAt: Date.now()
            });
          } catch {}
        }
        return {
          success: false,
          status: 'failed',
          eventId: event.eventId,
          error: err?.message || 'Consumer execution failed'
        };
      } finally {
        this.inFlightClaims.delete(event.eventId);
      }
    });
  }

  /**
   * Scans for claimed reminders whose processing lease has expired (e.g. consumer crashed).
   * Allows recovery without losing overdue events.
   */
  public async recoverStaleClaims(authenticatedUserId: string, leaseTimeoutMs = 30000): Promise<string[]> {
    if (!this.repo || !authenticatedUserId) return [];

    const now = temporal.now().getTime();
    const reminders = await this.repo.listReminders(authenticatedUserId);
    const recoveredIds: string[] = [];

    for (const r of reminders) {
      if (r.notificationState === 'claimed') {
        const claimTime = r.updatedAt || r.legacyFiredAt || 0;
        if (now - claimTime > leaseTimeoutMs) {
          const lockName = `alpha_delivery_lock_${authenticatedUserId}_${r.id}`;
          await withCrossContextLock(lockName, async () => {
            const fresh = await this.repo!.getReminder(authenticatedUserId, r.id);
            if (fresh && fresh.notificationState === 'claimed') {
              const freshClaimTime = fresh.updatedAt || fresh.legacyFiredAt || 0;
              if (now - freshClaimTime > leaseTimeoutMs) {
                // Stale claim detected: reset to pending so scheduler or consumer can reclaim
                await this.repo!.updateReminder(authenticatedUserId, r.id, {
                  notificationState: 'pending',
                  updatedAt: now
                });
                recoveredIds.push(r.id);
              }
            }
          });
        }
      }
    }

    return recoveredIds;
  }
}

export const reminderEventDelivery = new ReminderEventDelivery();
