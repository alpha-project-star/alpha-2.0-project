// src/lib/proactive-trigger.ts

import { alphaStore, uid, type ChatMessage } from './alpha-store';
import {
  waitForChatIdle,
  generateProactiveReminderResponse,
} from './alpha.functions';
import type { ReminderRepository } from './reminder-repo';
import {
  validateReminderDueEvent,
  type ReminderDueEvent,
} from './reminder-events';
import { withCrossContextLock } from './cross-context-lock';
import {
  notificationDelivery,
  NotificationDeliveryManager,
  type ProactiveResponseRecord,
} from './notification-delivery';

function extractEventField(raw: unknown, field: string): string {
  if (raw && typeof raw === 'object' && raw !== null && field in raw) {
    const val = (raw as Record<string, unknown>)[field];
    if (typeof val === 'string') return val;
  }
  return '';
}

export type ProactiveErrorCode =
  | 'INVALID_EVENT'
  | 'UNAUTHENTICATED'
  | 'USER_MISMATCH'
  | 'ALREADY_HANDLED'
  | 'CONCURRENT_PROCESSING'
  | 'MODEL_ERROR'
  | 'REPOSITORY_ERROR';

export type ProactiveTriggerResult =
  | {
      success: true;
      eventId: string;
      messageId: string;
      text: string;
    }
  | {
      success: false;
      eventId: string;
      error: {
        code: ProactiveErrorCode;
        message: string;
      };
    };

export interface ProactiveTriggerOptions {
  repo?: ReminderRepository;
  deliveryManager?: NotificationDeliveryManager;
  generateResponse?: (event: ReminderDueEvent) => Promise<string>;
  modelProvider?: (event: ReminderDueEvent) => Promise<string>;
  maxRetries?: number;
  leaseTimeoutMs?: number;
}

export class ProactiveTrigger {
  private inFlightEvents = new Set<string>();
  private retryCounts = new Map<string, number>();
  private queue: Promise<unknown> = Promise.resolve();

  constructor(private options: ProactiveTriggerOptions = {}) {}

  public setOptions(opts: Partial<ProactiveTriggerOptions>): void {
    this.options = { ...this.options, ...opts };
  }

  /**
   * Enqueues an operation into the sequential FIFO execution queue.
   * Prevents uncontrolled concurrent LLM executions when multiple reminders become due simultaneously.
   */
  private async enqueue<T>(task: () => Promise<T>): Promise<T> {
    const run = async () => task();
    const next = this.queue.then(run, run);
    this.queue = next.catch(() => {});
    return next;
  }

  /**
   * Handles an authoritative ReminderDueEvent and triggers a controlled conversational Alpha response.
   * 
   * Strict pipeline:
   * 1. Check authentication
   * 2. Validate event schema
   * 3. Enforce user identity match
   * 4. Check idempotency (chat store & repository)
   * 5. Protect against concurrency (in-flight set & cross-context claim lock)
   * 6. Defer if user is currently chatting
   * 7. Generate response using authoritative verified reminder details with zero tools
   * 8. Persist proactive message to store with origin: 'proactive'
   * 9. Update repository state to 'generated'
   */
  public async handleReminderDue(
    rawEvent: unknown,
    authenticatedUserId?: string,
  ): Promise<ProactiveTriggerResult> {
    const isExplicitAuthProvided = arguments.length >= 2;
    return this.enqueue(async () => {
      const effectiveUserId = isExplicitAuthProvided
        ? authenticatedUserId
        : extractEventField(rawEvent, 'userId');

      // 1. Authentication Check
      if (!effectiveUserId || typeof effectiveUserId !== 'string' || !effectiveUserId.trim()) {
        const fallbackId = extractEventField(rawEvent, 'eventId');
        return {
          success: false,
          eventId: fallbackId,
          error: {
            code: 'UNAUTHENTICATED',
            message: 'Authenticated user ID is required to process proactive events',
          },
        };
      }
      const authUser = effectiveUserId.trim();

      // 2. Event Schema Validation
      const validation = validateReminderDueEvent(rawEvent);
      if (!validation.success) {
        const fallbackId = extractEventField(rawEvent, 'eventId');
        return {
          success: false,
          eventId: fallbackId,
          error: {
            code: 'INVALID_EVENT',
            message: validation.error,
          },
        };
      }
      const event = validation.event;

      // 3. User Isolation / Identity Match
      if (event.userId !== authUser) {
        return {
          success: false,
          eventId: event.eventId,
          error: {
            code: 'USER_MISMATCH',
            message: `Event user ID (${event.userId}) does not match authenticated user ID (${authUser})`,
          },
        };
      }

      // 4. In-Flight Process Concurrency Lock
      if (this.inFlightEvents.has(event.eventId)) {
        return {
          success: false,
          eventId: event.eventId,
          error: {
            code: 'CONCURRENT_PROCESSING',
            message: `Event ${event.eventId} is currently being processed`,
          },
        };
      }

      // 5. Chat Store Idempotency Check
      const alreadyInStore = alphaStore
        .get()
        .chat.some((m) => m.proactiveEventId === event.eventId);
      if (alreadyInStore) {
        return {
          success: false,
          eventId: event.eventId,
          error: {
            code: 'ALREADY_HANDLED',
            message: `Proactive response for event ${event.eventId} already exists in conversation history`,
          },
        };
      }

      // 6 & 7. Repository Verification, Recovery Window Check, & Claiming via Cross-Context Lock
      let reminder = null;
      if (this.options.repo) {
        const lockName = `alpha_proactive_lock_${authUser}_${event.reminderId}`;
        const claimResult = await withCrossContextLock(lockName, async () => {
          let rem = null;
          try {
            rem = await this.options.repo!.getReminder(authUser, event.reminderId);
          } catch (err: any) {
            return {
              status: 'error' as const,
              result: {
                success: false,
                eventId: event.eventId,
                error: {
                  code: 'REPOSITORY_ERROR' as ProactiveErrorCode,
                  message: err?.message || 'Failed to fetch reminder from repository',
                },
              },
            };
          }

          if (!rem) {
            return {
              status: 'error' as const,
              result: {
                success: false,
                eventId: event.eventId,
                error: {
                  code: 'REPOSITORY_ERROR' as ProactiveErrorCode,
                  message: `Reminder ${event.reminderId} not found in repository`,
                },
              },
            };
          }

          if (rem.reminderState !== 'active') {
            return {
              status: 'error' as const,
              result: {
                success: false,
                eventId: event.eventId,
                error: {
                  code: 'INVALID_EVENT' as ProactiveErrorCode,
                  message: `Reminder is no longer active (state: ${rem.reminderState})`,
                },
              },
            };
          }

          if (rem.proactiveState === 'generated' && (!rem.proactiveEventId || rem.proactiveEventId === event.eventId)) {
            return {
              status: 'error' as const,
              result: {
                success: false,
                eventId: event.eventId,
                error: {
                  code: 'ALREADY_HANDLED' as ProactiveErrorCode,
                  message: `Proactive response has already been generated in repository for event ${event.eventId}`,
                },
              },
            };
          }

          if (rem.proactiveState === 'generating' && rem.proactiveEventId === event.eventId) {
            const leaseTimeout = this.options.leaseTimeoutMs ?? 30000;
            const elapsed = Date.now() - (rem.updatedAt || 0);
            // Stale-claim recovery after leaseTimeout is an operational heuristic for crashed/abandoned processing
            if (elapsed < leaseTimeout) {
              return {
                status: 'error' as const,
                result: {
                  success: false,
                  eventId: event.eventId,
                  error: {
                    code: 'CONCURRENT_PROCESSING' as ProactiveErrorCode,
                    message: `Proactive response is currently being generated by another instance (generation in progress)`,
                  },
                },
              };
            }
          }

          try {
            await this.options.repo!.updateReminder(authUser, event.reminderId, {
              proactiveState: 'generating',
              proactiveEventId: event.eventId,
              updatedAt: Date.now(),
            });
            return { status: 'success' as const, reminder: rem };
          } catch (err: any) {
            return {
              status: 'error' as const,
              result: {
                success: false,
                eventId: event.eventId,
                error: {
                  code: 'CONCURRENT_PROCESSING' as ProactiveErrorCode,
                  message: `Failed to claim generating state in repository: ${err?.message}`,
                },
              },
            };
          }
        });

        if (claimResult.status === 'error') {
          return claimResult.result;
        }
        reminder = claimResult.reminder;
      }

      this.inFlightEvents.add(event.eventId);

      // 8. Conversation Safety: Wait for any active user chat generation to finish cleanly
      try {
        await waitForChatIdle();
      } catch {
        // Proceed even if previous user chat had an error
      }

      // 9. Model Generation
      try {
        const generator =
          this.options.generateResponse ??
          this.options.modelProvider ??
          generateProactiveReminderResponse;
        const text = await generator(event);

        if (!text || typeof text !== 'string' || !text.trim()) {
          throw new Error('Model produced empty or invalid response');
        }

        const trimmed = text.trim();
        const messageId = uid();

        // 10. Update reminder repository state to 'generated'
        if (this.options.repo) {
          await this.options.repo.updateReminder(authUser, event.reminderId, {
            proactiveState: 'generated',
            proactiveEventId: event.eventId,
            proactiveHandledAt: Date.now(),
            proactiveMessageId: messageId,
            updatedAt: Date.now(),
          });
        }

        // 11. Create ProactiveResponseRecord & Deliver via NotificationDelivery Foundation
        const record: ProactiveResponseRecord = {
          eventId: event.eventId,
          reminderId: event.reminderId,
          userId: authUser,
          messageId,
          text: trimmed,
          generatedAt: Date.now(),
          title: event.title,
          dueAt: event.dueAt,
          notes: reminder?.notes || event.notes,
        };

        const deliveryMgr = this.options.deliveryManager ?? notificationDelivery;
        const deliveryResult = await deliveryMgr.deliverProactiveResponse({
          authenticatedUserId: authUser,
          record,
          channel: 'in_app',
        });

        if (!deliveryResult.success) {
          this.inFlightEvents.delete(event.eventId);
          return {
            success: false,
            eventId: event.eventId,
            error: {
              code: 'REPOSITORY_ERROR',
              message: deliveryResult.error.message,
            },
          };
        }

        this.inFlightEvents.delete(event.eventId);
        this.retryCounts.delete(event.eventId);

        return {
          success: true,
          eventId: event.eventId,
          messageId,
          text: trimmed,
        };
      } catch (err: any) {
        this.inFlightEvents.delete(event.eventId);

        // Mark repository state as failed so it remains recoverable
        if (this.options.repo) {
          try {
            await this.options.repo.updateReminder(authUser, event.reminderId, {
              proactiveState: 'failed',
              updatedAt: Date.now(),
            });
          } catch {
            // Ignore repository update error on failure cleanup
          }
        }

        // Never append a fake assistant message or technical error to the chat
        return {
          success: false,
          eventId: event.eventId,
          error: {
            code: 'MODEL_ERROR',
            message: err?.message || 'Failed to generate proactive response',
          },
        };
      }
    });
  }

  /**
   * Bounded retry mechanism for failed proactive event generations.
   * Respects idempotency, concurrency, and maximum retry limits.
   */
  public async retryReminderDue(
    rawEvent: unknown,
    authenticatedUserId?: string,
  ): Promise<ProactiveTriggerResult> {
    const eventId = extractEventField(rawEvent, 'eventId');
    if (!eventId) {
      return this.handleReminderDue(rawEvent, authenticatedUserId);
    }

    const currentRetries = this.retryCounts.get(eventId) || 0;
    const maxRetries = this.options.maxRetries ?? 2;

    if (currentRetries >= maxRetries) {
      return {
        success: false,
        eventId,
        error: {
          code: 'MODEL_ERROR',
          message: `Maximum retry attempts (${maxRetries}) exceeded for event ${eventId}`,
        },
      };
    }

    this.retryCounts.set(eventId, currentRetries + 1);
    return this.handleReminderDue(rawEvent, authenticatedUserId);
  }

  public getInFlightCount(): number {
    return this.inFlightEvents.size;
  }

  public isInFlight(eventId: string): boolean {
    return this.inFlightEvents.has(eventId);
  }

  public clearInFlight(): void {
    this.inFlightEvents.clear();
  }

  /**
   * Distinct generation stage: validates event and generates the response record without delivering.
   */
  public async generateResponseRecord(
    rawEvent: unknown,
    authenticatedUserId?: string,
  ): Promise<
    | { success: true; record: ProactiveResponseRecord }
    | { success: false; eventId: string; error: { code: ProactiveErrorCode; message: string } }
  > {
    if (!authenticatedUserId || typeof authenticatedUserId !== 'string' || !authenticatedUserId.trim()) {
      return {
        success: false,
        eventId: extractEventField(rawEvent, 'eventId'),
        error: { code: 'UNAUTHENTICATED', message: 'Authenticated user ID is required' },
      };
    }
    const validation = validateReminderDueEvent(rawEvent);
    if (!validation.success) {
      return {
        success: false,
        eventId: extractEventField(rawEvent, 'eventId'),
        error: { code: 'INVALID_EVENT', message: validation.error },
      };
    }
    const event = validation.event;
    if (event.userId !== authenticatedUserId) {
      return {
        success: false,
        eventId: event.eventId,
        error: { code: 'USER_MISMATCH', message: 'User mismatch' },
      };
    }

    try {
      const generator = this.options.generateResponse ?? generateProactiveReminderResponse;
      const text = await generator(event);
      if (!text || typeof text !== 'string' || !text.trim()) {
        throw new Error('Model produced empty or invalid response');
      }

      const messageId = uid();
      const record: ProactiveResponseRecord = {
        eventId: event.eventId,
        reminderId: event.reminderId,
        userId: authenticatedUserId,
        messageId,
        text: text.trim(),
        generatedAt: Date.now(),
        title: event.title,
        dueAt: event.dueAt,
        notes: event.notes,
      };

      return { success: true, record };
    } catch (err: any) {
      return {
        success: false,
        eventId: event.eventId,
        error: { code: 'MODEL_ERROR', message: err?.message || 'Generation failed' },
      };
    }
  }
}

export const proactiveTrigger = new ProactiveTrigger();

export async function handleReminderDue(
  rawEvent: unknown,
  authenticatedUserId?: string,
  options?: ProactiveTriggerOptions,
): Promise<ProactiveTriggerResult> {
  if (options) {
    const customTrigger = new ProactiveTrigger(options);
    return customTrigger.handleReminderDue(rawEvent, authenticatedUserId);
  }
  return proactiveTrigger.handleReminderDue(rawEvent, authenticatedUserId);
}
