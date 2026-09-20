// src/lib/notification-delivery.ts

import { alphaStore, getStorage, type ChatMessage } from './alpha-store';
import { waitForChatIdle } from './alpha.functions';
import { reminderContextManager } from './reminder-context';
import { notificationAcknowledgementManager } from './notification-acknowledgement';
import { notificationChannelRegistry } from './notification-channel-registry';
import { withCrossContextLock } from './cross-context-lock';

export type NotificationChannel = 'in_app' | string;

export type DeliveryStatus =
  | 'pending'
  | 'delivering'
  | 'delivered'
  | 'already_delivered'
  | 'failed'
  | 'rejected';

export type DeliveryRecordStatus = 'pending' | 'delivering' | 'delivered' | 'failed';

export type DeliveryErrorCode =
  | 'INVALID_INPUT'
  | 'UNAUTHENTICATED'
  | 'USER_MISMATCH'
  | 'UNSUPPORTED_CHANNEL'
  | 'CHANNEL_UNAVAILABLE'
  | 'ALREADY_DELIVERED'
  | 'DELIVERY_IN_PROGRESS'
  | 'DELIVERY_FAILED'
  | 'PERSISTENCE_FAILURE';

export interface ProactiveResponseRecord {
  eventId: string;
  reminderId: string;
  userId: string;
  messageId: string;
  text: string;
  generatedAt?: number;
  title?: string;
  dueAt?: number;
  notes?: string;
}

export interface DeliveryRecord {
  deliveryId: string;
  eventId: string;
  reminderId: string;
  userId: string;
  messageId: string;
  channel: NotificationChannel;
  status: DeliveryRecordStatus;
  createdAt: number;
  updatedAt: number;
  deliveredAt?: number;
  failedAt?: number;
  retryCount: number;
  error?: string;
}

export interface DeliverProactiveInput {
  authenticatedUserId?: string;
  record: ProactiveResponseRecord;
  channel?: NotificationChannel | string;
}

export interface NotificationDeliverySuccess {
  success: true;
  deliveryId: string;
  eventId: string;
  messageId: string;
  channel: NotificationChannel;
  status: 'delivered' | 'already_delivered';
  deliveredAt: number;
}

export interface NotificationDeliveryFailure {
  success: false;
  deliveryId?: string;
  eventId: string;
  messageId?: string;
  channel?: string;
  status: 'failed' | 'rejected';
  error: {
    code: DeliveryErrorCode;
    message: string;
  };
}

export type NotificationDeliveryResult =
  | NotificationDeliverySuccess
  | NotificationDeliveryFailure;

export interface DeliveryRepository {
  getDelivery(userId: string, deliveryId: string): Promise<DeliveryRecord | null>;
  saveDelivery(userId: string, delivery: DeliveryRecord): Promise<void>;
  updateDelivery(userId: string, deliveryId: string, patch: Partial<DeliveryRecord>): Promise<void>;
  listDeliveries(userId: string): Promise<DeliveryRecord[]>;
}

export class InMemoryDeliveryRepository implements DeliveryRepository {
  private store = new Map<string, DeliveryRecord>();
  public shouldFail = false;
  public failureError = 'Simulated delivery persistence failure';

  private key(userId: string, deliveryId: string): string {
    return `${userId}:${deliveryId}`;
  }

  async getDelivery(userId: string, deliveryId: string): Promise<DeliveryRecord | null> {
    if (this.shouldFail) throw new Error(this.failureError);
    const item = this.store.get(this.key(userId, deliveryId));
    return item ? { ...item } : null;
  }

  async saveDelivery(userId: string, delivery: DeliveryRecord): Promise<void> {
    if (this.shouldFail) throw new Error(this.failureError);
    if (delivery.userId !== userId) throw new Error('User isolation mismatch on delivery save');
    this.store.set(this.key(userId, delivery.deliveryId), { ...delivery });
  }

  async updateDelivery(userId: string, deliveryId: string, patch: Partial<DeliveryRecord>): Promise<void> {
    if (this.shouldFail) throw new Error(this.failureError);
    const k = this.key(userId, deliveryId);
    const item = this.store.get(k);
    if (!item) throw new Error(`Delivery record not found: ${deliveryId}`);
    this.store.set(k, { ...item, ...patch, updatedAt: Date.now() });
  }

  async listDeliveries(userId: string): Promise<DeliveryRecord[]> {
    if (this.shouldFail) throw new Error(this.failureError);
    const prefix = `${userId}:`;
    const results: DeliveryRecord[] = [];
    for (const [k, v] of this.store.entries()) {
      if (k.startsWith(prefix)) {
        results.push({ ...v });
      }
    }
    return results;
  }

  clear(): void {
    this.store.clear();
  }
}

export type NotificationDeliveryRepository = DeliveryRepository;
export class InMemoryNotificationDeliveryRepository extends InMemoryDeliveryRepository {}

const STORAGE_PREFIX = 'alpha.deliveries.v1';

export class LocalDeliveryRepository implements DeliveryRepository {
  private inMemoryFallback = new Map<string, DeliveryRecord>();

  private getStorageKey(userId: string): string {
    return `${STORAGE_PREFIX}.${userId}`;
  }

  async getDelivery(userId: string, deliveryId: string): Promise<DeliveryRecord | null> {
    const storage = getStorage();
    if (!storage) {
      const item = this.inMemoryFallback.get(`${userId}:${deliveryId}`);
      return item ? { ...item } : null;
    }
    try {
      const raw = storage.getItem(this.getStorageKey(userId));
      if (!raw) return null;
      const parsed = JSON.parse(raw);
      if (Array.isArray(parsed)) {
        const found = parsed.find((d: DeliveryRecord) => d.deliveryId === deliveryId && d.userId === userId);
        return found ? { ...found } : null;
      }
      return null;
    } catch {
      return null;
    }
  }

  async saveDelivery(userId: string, delivery: DeliveryRecord): Promise<void> {
    if (delivery.userId !== userId) throw new Error('User isolation mismatch on delivery save');
    const storage = getStorage();
    if (!storage) {
      this.inMemoryFallback.set(`${userId}:${delivery.deliveryId}`, { ...delivery });
      return;
    }
    await withCrossContextLock(`alpha_delivery_repo_${userId}`, async () => {
      const key = this.getStorageKey(userId);
      let list: DeliveryRecord[] = [];
      try {
        const raw = storage.getItem(key);
        if (raw) {
          const parsed = JSON.parse(raw);
          if (Array.isArray(parsed)) list = parsed;
        }
      } catch {}
      const idx = list.findIndex((d) => d.deliveryId === delivery.deliveryId);
      if (idx >= 0) {
        list[idx] = { ...delivery };
      } else {
        list.push({ ...delivery });
      }
      storage.setItem(key, JSON.stringify(list));
    });
  }

  async updateDelivery(userId: string, deliveryId: string, patch: Partial<DeliveryRecord>): Promise<void> {
    const storage = getStorage();
    if (!storage) {
      const item = this.inMemoryFallback.get(`${userId}:${deliveryId}`);
      if (!item) throw new Error(`Delivery record not found: ${deliveryId}`);
      const updated = { ...item, ...patch, updatedAt: Date.now() };
      this.inMemoryFallback.set(`${userId}:${deliveryId}`, updated);
      return;
    }
    await withCrossContextLock(`alpha_delivery_repo_${userId}`, async () => {
      const key = this.getStorageKey(userId);
      let list: DeliveryRecord[] = [];
      try {
        const raw = storage.getItem(key);
        if (raw) {
          const parsed = JSON.parse(raw);
          if (Array.isArray(parsed)) list = parsed;
        }
      } catch {}
      const idx = list.findIndex((d) => d.deliveryId === deliveryId && d.userId === userId);
      if (idx < 0) throw new Error(`Delivery record not found: ${deliveryId}`);
      list[idx] = { ...list[idx], ...patch, updatedAt: Date.now() };
      storage.setItem(key, JSON.stringify(list));
    });
  }

  async listDeliveries(userId: string): Promise<DeliveryRecord[]> {
    const storage = getStorage();
    if (!storage) {
      const results: DeliveryRecord[] = [];
      for (const [k, v] of this.inMemoryFallback.entries()) {
        if (k.startsWith(`${userId}:`)) results.push({ ...v });
      }
      return results;
    }
    try {
      const raw = storage.getItem(this.getStorageKey(userId));
      if (!raw) return [];
      const parsed = JSON.parse(raw);
      return Array.isArray(parsed) ? parsed : [];
    } catch {
      return [];
    }
  }

  clear(): void {
    this.inMemoryFallback.clear();
    const storage = getStorage();
    if (storage) {
      const keysToRemove: string[] = [];
      for (let i = 0; i < storage.length; i++) {
        const k = storage.key(i);
        if (k && k.startsWith(STORAGE_PREFIX)) keysToRemove.push(k);
      }
      keysToRemove.forEach((k) => storage.removeItem(k));
    }
  }
}

export function generateDeliveryId(eventId: string, channel: string): string {
  return `${eventId}:${channel}`;
}

export interface NotificationDeliveryOptions {
  repo?: DeliveryRepository;
  leaseTimeoutMs?: number;
}

export class NotificationDeliveryManager {
  private repo?: DeliveryRepository;
  private leaseTimeoutMs: number;
  private inFlightClaims = new Set<string>();

  constructor(options: NotificationDeliveryOptions = {}) {
    this.repo = options.repo ?? new LocalDeliveryRepository();
    this.leaseTimeoutMs = options.leaseTimeoutMs ?? 30000;
  }

  public setRepository(repo: DeliveryRepository): void {
    this.repo = repo;
  }

  public getRepository(): DeliveryRepository | undefined {
    return this.repo;
  }

  /**
   * Authoritatively delivers a generated proactive Alpha response record to the requested channel.
   * Enforces authentication, user isolation, idempotency, atomic claiming, and safe in-app store commit.
   */
  public async deliverProactiveResponse(
    input: DeliverProactiveInput,
  ): Promise<NotificationDeliveryResult> {
    const rawAuth = input?.authenticatedUserId;
    const rawChannel = input?.channel;

    // Normalize flat record structure if provided
    let rawRecord = input?.record;
    if (!rawRecord && input && typeof input === 'object' && ('eventId' in input || 'reminderId' in input)) {
      const flat = input as Record<string, unknown>;
      rawRecord = {
        eventId: typeof flat.eventId === 'string' ? flat.eventId : '',
        reminderId: typeof flat.reminderId === 'string' ? flat.reminderId : '',
        userId: typeof flat.userId === 'string' ? flat.userId : (rawAuth || ''),
        messageId: typeof flat.messageId === 'string' ? flat.messageId : `msg-${flat.eventId || flat.reminderId}`,
        text: typeof flat.text === 'string' ? flat.text : (typeof flat.proactiveText === 'string' ? flat.proactiveText : ''),
        title: typeof flat.title === 'string' ? flat.title : undefined,
        dueAt: typeof flat.dueAt === 'number' ? flat.dueAt : undefined,
        notes: typeof flat.notes === 'string' ? flat.notes : undefined,
      };
    }

    // 1. Authentication Check
    if (!rawAuth || typeof rawAuth !== 'string' || !rawAuth.trim()) {
      return {
        success: false,
        eventId: rawRecord?.eventId || '',
        messageId: rawRecord?.messageId,
        channel: typeof rawChannel === 'string' ? rawChannel : undefined,
        status: 'rejected',
        error: {
          code: 'UNAUTHENTICATED',
          message: 'Authenticated user ID is required for notification delivery',
        },
      };
    }
    const authUser = rawAuth.trim();

    // 2. Input Validation
    if (
      !rawRecord ||
      typeof rawRecord !== 'object' ||
      !rawRecord.eventId ||
      typeof rawRecord.eventId !== 'string' ||
      !rawRecord.reminderId ||
      typeof rawRecord.reminderId !== 'string' ||
      !rawRecord.userId ||
      typeof rawRecord.userId !== 'string' ||
      !rawRecord.messageId ||
      typeof rawRecord.messageId !== 'string' ||
      !rawRecord.text ||
      typeof rawRecord.text !== 'string' ||
      !rawRecord.text.trim()
    ) {
      return {
        success: false,
        eventId: rawRecord?.eventId || '',
        messageId: rawRecord?.messageId,
        channel: typeof rawChannel === 'string' ? rawChannel : undefined,
        status: 'rejected',
        error: {
          code: 'INVALID_INPUT',
          message: 'Valid ProactiveResponseRecord with non-empty eventId, reminderId, userId, messageId, and text is required',
        },
      };
    }

    // 3. User Isolation / Identity Match
    if (rawRecord.userId !== authUser) {
      return {
        success: false,
        eventId: rawRecord.eventId,
        messageId: rawRecord.messageId,
        channel: typeof rawChannel === 'string' ? rawChannel : undefined,
        status: 'rejected',
        error: {
          code: 'USER_MISMATCH',
          message: `User isolation violation: record user ${rawRecord.userId} does not match authenticated user ${authUser}`,
        },
      };
    }

    // 4. Channel Validation & Registry Resolution
    const requestedChannel = rawChannel ?? 'in_app';
    if (!requestedChannel || typeof requestedChannel !== 'string' || !requestedChannel.trim()) {
      return {
        success: false,
        eventId: rawRecord.eventId,
        messageId: rawRecord.messageId,
        channel: String(requestedChannel || ''),
        status: 'rejected',
        error: {
          code: 'UNSUPPORTED_CHANNEL',
          message: `Channel "${requestedChannel}" is not supported. Active channel: in_app`,
        },
      };
    }

    const channel = requestedChannel.trim().toLowerCase();
    const resolution = await notificationChannelRegistry.resolveChannel(channel, authUser);

    if (resolution.status === 'unsupported') {
      return {
        success: false,
        eventId: rawRecord.eventId,
        messageId: rawRecord.messageId,
        channel,
        status: 'rejected',
        error: {
          code: 'UNSUPPORTED_CHANNEL',
          message: resolution.error || `Channel "${channel}" is not supported. Active channel: in_app`,
        },
      };
    }

    if (resolution.status === 'unavailable') {
      return {
        success: false,
        eventId: rawRecord.eventId,
        messageId: rawRecord.messageId,
        channel,
        status: 'rejected',
        error: {
          code: 'CHANNEL_UNAVAILABLE',
          message: resolution.error || `Channel "${channel}" is currently unavailable in this environment.`,
        },
      };
    }

    const deliveryId = generateDeliveryId(rawRecord.eventId, channel);

    // If a non-in_app channel provider is resolved, delegate directly to the provider
    if (channel !== 'in_app' && resolution.provider) {
      const providerObj = resolution.provider as unknown as Record<string, unknown>;
      if (this.repo && typeof providerObj.setDeliveryRepo === 'function') {
        (providerObj.setDeliveryRepo as (repo: DeliveryRepository) => void)(this.repo);
      }
      const channelResult = await resolution.provider.deliver(
        {
          eventId: rawRecord.eventId,
          reminderId: rawRecord.reminderId,
          userId: rawRecord.userId,
          title: rawRecord.title || '',
          body: rawRecord.text || '',
          messageId: rawRecord.messageId,
          dueAt: rawRecord.dueAt,
          notes: rawRecord.notes,
          channel,
        },
        authUser
      );

      if (!channelResult.success) {
        return {
          success: false,
          deliveryId: channelResult.deliveryId || deliveryId,
          eventId: channelResult.eventId,
          messageId: channelResult.messageId || rawRecord.messageId,
          channel,
          status: 'rejected',
          error: {
            code: (channelResult.error?.code as DeliveryErrorCode) || 'DELIVERY_FAILED',
            message: channelResult.error?.message || 'Delivery failed',
          },
        };
      }

      return {
        success: true,
        deliveryId: channelResult.deliveryId || deliveryId,
        eventId: channelResult.eventId,
        messageId: channelResult.messageId || rawRecord.messageId,
        channel,
        status: channelResult.status === 'already_delivered' ? 'already_delivered' : 'delivered',
        deliveredAt: channelResult.deliveredAt || Date.now(),
      };
    }

    // 5. In-flight local process concurrency check
    if (this.inFlightClaims.has(deliveryId)) {
      return {
        success: false,
        deliveryId,
        eventId: rawRecord.eventId,
        messageId: rawRecord.messageId,
        channel,
        status: 'rejected',
        error: {
          code: 'DELIVERY_IN_PROGRESS',
          message: `Delivery for ${deliveryId} is currently in progress`,
        },
      };
    }

    // 6, 7, 8. Check Durable State, Idempotency, and Acquire Claim Atomically via Cross-Context Lock
    const lockName = `alpha_delivery_lock_${authUser}_${deliveryId}`;
    const claimResult = await withCrossContextLock(lockName, async () => {
      if (this.repo) {
        try {
          const existing = await this.repo.getDelivery(authUser, deliveryId);
          if (existing) {
            if (existing.status === 'delivered') {
              const inChat = alphaStore.get().chat.some((m) => m.proactiveEventId === rawRecord.eventId);
              if (!inChat) {
                const chatMsg: ChatMessage = {
                  id: existing.messageId || rawRecord.messageId,
                  role: 'model',
                  origin: 'proactive',
                  proactiveEventId: rawRecord.eventId,
                  text: rawRecord.text,
                  ts: existing.deliveredAt || Date.now(),
                };
                alphaStore.appendChat(chatMsg);
              }
              return {
                status: 'resolved' as const,
                result: {
                  success: true,
                  deliveryId,
                  eventId: rawRecord.eventId,
                  messageId: existing.messageId || rawRecord.messageId,
                  channel,
                  status: 'already_delivered',
                  deliveredAt: existing.deliveredAt || Date.now(),
                },
              };
            }

            if (existing.status === 'delivering') {
              const elapsed = Date.now() - (existing.updatedAt || 0);
              if (elapsed < this.leaseTimeoutMs) {
                return {
                  status: 'resolved' as const,
                  result: {
                    success: false,
                    deliveryId,
                    eventId: rawRecord.eventId,
                    messageId: rawRecord.messageId,
                    channel,
                    status: 'rejected',
                    error: {
                      code: 'DELIVERY_IN_PROGRESS',
                      message: 'Delivery claim is actively held by another process (lease active)',
                    },
                  },
                };
              }
            }
          }
        } catch (err: any) {
          return {
            status: 'resolved' as const,
            result: {
              success: false,
              deliveryId,
              eventId: rawRecord.eventId,
              messageId: rawRecord.messageId,
              channel,
              status: 'failed',
              error: {
                code: 'PERSISTENCE_FAILURE',
                message: `Failed reading delivery repository: ${err?.message}`,
              },
            },
          };
        }
      }

      const chatMsg = alphaStore.get().chat.find((m) => m.proactiveEventId === rawRecord.eventId);
      if (chatMsg) {
        if (this.repo) {
          try {
            const existing = await this.repo.getDelivery(authUser, deliveryId);
            if (!existing) {
              await this.repo.saveDelivery(authUser, {
                deliveryId,
                eventId: rawRecord.eventId,
                reminderId: rawRecord.reminderId,
                userId: authUser,
                messageId: chatMsg.id,
                channel,
                status: 'delivered',
                createdAt: chatMsg.ts,
                updatedAt: Date.now(),
                deliveredAt: chatMsg.ts,
                retryCount: 0,
              });
            } else if (existing.status !== 'delivered') {
              await this.repo.updateDelivery(authUser, deliveryId, {
                status: 'delivered',
                deliveredAt: chatMsg.ts,
                updatedAt: Date.now(),
              });
            }
          } catch {}
        }
        return {
          status: 'resolved' as const,
          result: {
            success: true,
            deliveryId,
            eventId: rawRecord.eventId,
            messageId: chatMsg.id,
            channel,
            status: 'already_delivered',
            deliveredAt: chatMsg.ts,
          },
        };
      }

      const now = Date.now();
      if (this.repo) {
        try {
          const existing = await this.repo.getDelivery(authUser, deliveryId);
          if (!existing) {
            await this.repo.saveDelivery(authUser, {
              deliveryId,
              eventId: rawRecord.eventId,
              reminderId: rawRecord.reminderId,
              userId: authUser,
              messageId: rawRecord.messageId,
              channel,
              status: 'delivering',
              createdAt: now,
              updatedAt: now,
              retryCount: 0,
            });
          } else {
            await this.repo.updateDelivery(authUser, deliveryId, {
              status: 'delivering',
              updatedAt: now,
              retryCount: (existing.retryCount || 0) + 1,
            });
          }
        } catch (repoErr: any) {
          return {
            status: 'resolved' as const,
            result: {
              success: false,
              deliveryId,
              eventId: rawRecord.eventId,
              messageId: rawRecord.messageId,
              channel,
              status: 'failed',
              error: {
                code: 'PERSISTENCE_FAILURE',
                message: `Failed to acquire durable delivery claim: ${repoErr?.message}`,
              },
            },
          };
        }
      }

      return { status: 'acquired' as const };
    });

    if (claimResult.status === 'resolved') {
      return claimResult.result;
    }

    this.inFlightClaims.add(deliveryId);

    // 9. Execute Delivery into In-App Store
    try {
      // Non-interference: Wait cleanly if active user chat completion is underway
      try {
        await waitForChatIdle();
      } catch {
        // Proceed even if previous user turn had an error
      }

      // Re-check chat store after idle wait to prevent double-insert race
      const lateCheck = alphaStore.get().chat.find((m) => m.proactiveEventId === rawRecord.eventId);
      if (lateCheck) {
        if (this.repo) {
          await this.repo.updateDelivery(authUser, deliveryId, {
            status: 'delivered',
            deliveredAt: lateCheck.ts,
            updatedAt: Date.now(),
          });
        }
        this.inFlightClaims.delete(deliveryId);
        return {
          success: true,
          deliveryId,
          eventId: rawRecord.eventId,
          messageId: lateCheck.id,
          channel,
          status: 'already_delivered',
          deliveredAt: lateCheck.ts,
        };
      }

      const deliveredAt = Date.now();
      const messageToAppend: ChatMessage = {
        id: rawRecord.messageId,
        role: 'model',
        origin: 'proactive',
        proactiveEventId: rawRecord.eventId,
        text: rawRecord.text,
        ts: deliveredAt,
      };

      alphaStore.appendChat(messageToAppend);

      // Update delivery record to 'delivered'
      if (this.repo) {
        await this.repo.updateDelivery(authUser, deliveryId, {
          status: 'delivered',
          deliveredAt,
          updatedAt: deliveredAt,
        });
      }

      // Record durable acknowledgement tracking in delivered state
      try {
        await notificationAcknowledgementManager.recordDelivery({
          authenticatedUserId: authUser,
          eventId: rawRecord.eventId,
          reminderId: rawRecord.reminderId,
          channel: 'in_app',
          title: rawRecord.title,
          dueAt: rawRecord.dueAt,
        });
      } catch {
        // Safe degraded fallback: delivery to chat already succeeded
      }

      // Maintain conversational continuity context
      reminderContextManager.setContext(authUser, {
        id: rawRecord.reminderId,
        title: rawRecord.title || 'Reminder',
        dueAt: rawRecord.dueAt || deliveredAt,
        userId: authUser,
        notes: rawRecord.notes,
      });

      this.inFlightClaims.delete(deliveryId);

      return {
        success: true,
        deliveryId,
        eventId: rawRecord.eventId,
        messageId: rawRecord.messageId,
        channel,
        status: 'delivered',
        deliveredAt,
      };
    } catch (deliveryErr: any) {
      this.inFlightClaims.delete(deliveryId);

      if (this.repo) {
        try {
          await this.repo.updateDelivery(authUser, deliveryId, {
            status: 'failed',
            failedAt: Date.now(),
            updatedAt: Date.now(),
            error: deliveryErr?.message || 'Delivery execution failed',
          });
        } catch {
          // Non-blocking on secondary cleanup error
        }
      }

      return {
        success: false,
        deliveryId,
        eventId: rawRecord.eventId,
        messageId: rawRecord.messageId,
        channel,
        status: 'failed',
        error: {
          code: 'DELIVERY_FAILED',
          message: deliveryErr?.message || 'In-app notification delivery failed',
        },
      };
    }
  }

  /**
   * Queries delivery status without mutating or creating records.
   */
  public async getDeliveryStatus(
    userId: string,
    deliveryId: string,
  ): Promise<DeliveryRecord | null> {
    if (!this.repo || !userId || !deliveryId) return null;
    return this.repo.getDelivery(userId, deliveryId);
  }

  /**
   * Recovers stale claims where a delivering lease expired without completion.
   */
  public async recoverStaleClaims(
    userId: string,
    leaseTimeoutMs?: number,
    nowTimeOverride?: number,
  ): Promise<string[]> {
    if (!this.repo || !userId) return [];
    const now = typeof nowTimeOverride === 'number' ? nowTimeOverride : Date.now();
    const timeout = typeof leaseTimeoutMs === 'number' ? leaseTimeoutMs : this.leaseTimeoutMs;
    const deliveries = await this.repo.listDeliveries(userId);
    const recovered: string[] = [];

    const targetStatus = typeof leaseTimeoutMs === 'number' ? 'pending' : 'failed';
    const errorMsg =
      targetStatus === 'pending'
        ? 'Claim lease expired (recovered to pending)'
        : 'Claim lease expired (recovered)';

    for (const d of deliveries) {
      if (d.status === 'delivering') {
        const elapsed = now - (d.updatedAt || 0);
        if (elapsed > timeout) {
          await this.repo.updateDelivery(userId, d.deliveryId, {
            status: targetStatus,
            error: errorMsg,
            updatedAt: now,
          });
          recovered.push(d.deliveryId);
        }
      }
    }

    return recovered;
  }

  public isInFlight(deliveryId: string): boolean {
    return this.inFlightClaims.has(deliveryId);
  }

  public clearInFlight(): void {
    this.inFlightClaims.clear();
  }

  /**
   * Dispatches delivery across multiple specified channels independently.
   * Isolates failures so that one channel failure does not affect or rollback other channels.
   */
  public async deliverProactiveResponseToChannels(
    input: MultiChannelDeliveryInput
  ): Promise<MultiChannelDeliveryResult> {
    const rawChannels = input.channels && input.channels.length > 0 ? input.channels : ['in_app'];
    const results: Record<string, NotificationDeliveryResult> = {};
    const deliveredChannels: string[] = [];
    const failedChannels: string[] = [];

    for (const ch of rawChannels) {
      const channelResult = await this.deliverProactiveResponse({
        authenticatedUserId: input.authenticatedUserId,
        record: input.record,
        channel: ch,
      });
      results[ch] = channelResult;
      if (channelResult.success) {
        deliveredChannels.push(ch);
      } else {
        failedChannels.push(ch);
      }
    }

    return {
      eventId: input.record?.eventId || '',
      reminderId: input.record?.reminderId || '',
      userId: input.authenticatedUserId || input.record?.userId || '',
      results,
      overallSuccess: deliveredChannels.length > 0,
      deliveredChannels,
      failedChannels,
    };
  }
}

export interface MultiChannelDeliveryInput {
  authenticatedUserId?: string;
  record: ProactiveResponseRecord;
  channels?: (NotificationChannel | string)[];
}

export interface MultiChannelDeliveryResult {
  eventId: string;
  reminderId: string;
  userId: string;
  results: Record<string, NotificationDeliveryResult>;
  overallSuccess: boolean;
  deliveredChannels: string[];
  failedChannels: string[];
}

export const notificationDelivery = new NotificationDeliveryManager();

export async function deliverProactiveResponse(
  input: DeliverProactiveInput,
  options?: NotificationDeliveryOptions,
): Promise<NotificationDeliveryResult> {
  if (options) {
    const manager = new NotificationDeliveryManager(options);
    return manager.deliverProactiveResponse(input);
  }
  return notificationDelivery.deliverProactiveResponse(input);
}

export async function deliverProactiveResponseToChannels(
  input: MultiChannelDeliveryInput,
  options?: NotificationDeliveryOptions
): Promise<MultiChannelDeliveryResult> {
  if (options) {
    const manager = new NotificationDeliveryManager(options);
    return manager.deliverProactiveResponseToChannels(input);
  }
  return notificationDelivery.deliverProactiveResponseToChannels(input);
}
