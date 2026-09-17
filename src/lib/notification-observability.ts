// src/lib/notification-observability.ts

import { getFirestore, doc, getDoc, setDoc, collection, getDocs, query, orderBy } from 'firebase/firestore';

export type DiagnosticStage =
  | 'scheduler'
  | 'due_event'
  | 'event_delivery'
  | 'generation'
  | 'notification_delivery'
  | 'channel'
  | 'browser'
  | 'push'
  | 'acknowledgement'
  | 'recovery'
  | 'reconciliation';

export type DiagnosticAction =
  | 'started'
  | 'completed'
  | 'failed'
  | 'claimed'
  | 'lease_recovered'
  | 'already_processed'
  | 'skipped'
  | 'expired'
  | 'permission_denied'
  | 'unavailable'
  | 'retry_scheduled'
  | 'retry_exhausted'
  | 'acknowledged'
  | 'detected_stuck';

export type DiagnosticStatus = 'success' | 'failure' | 'pending' | 'skipped' | 'recovered';

export interface NotificationDiagnosticEvent {
  diagnosticId: string;
  userId: string;
  eventId?: string;
  reminderId?: string;
  deliveryId?: string;
  acknowledgementId?: string;
  correlationId: string;
  stage: DiagnosticStage;
  action: DiagnosticAction;
  status: DiagnosticStatus;
  timestamp: number;
  durationMs?: number;
  attempt?: number;
  errorCode?: string;
  channelId?: string;
  metadata?: Record<string, unknown>;
}

export interface NotificationHealth {
  status: 'healthy' | 'degraded' | 'attention_required';
  checkedAt: number;
  pendingCount: number;
  failedCount: number;
  stuckCount: number;
  channelHealth: {
    [channelId: string]: {
      available: boolean;
      permission: string;
      recentFailures: number;
    };
  };
}

export interface StuckNotificationItem {
  reminderId?: string;
  eventId?: string;
  deliveryId?: string;
  reason: string;
  staleSince: number;
}

const SENSITIVE_KEYS = new Set([
  'authorization',
  'token',
  'accesstoken',
  'refreshtoken',
  'apikey',
  'secret',
  'privatekey',
  'vapidprivatekey',
  'auth',
  'p256dh',
  'password',
  'key',
]);

/**
 * Sanitizes diagnostic metadata to prevent leakage of secrets, tokens, or oversized payloads.
 */
export function sanitizeDiagnosticMetadata(
  metadata?: Record<string, unknown>,
  depth: number = 0
): Record<string, unknown> | undefined {
  if (!metadata || typeof metadata !== 'object') return undefined;
  if (depth > 3) return { _truncated: 'max_depth_exceeded' };

  const sanitized: Record<string, unknown> = {};
  let keysCount = 0;

  for (const [key, value] of Object.entries(metadata)) {
    if (keysCount >= 30) {
      sanitized._truncated_keys = true;
      break;
    }
    const lowerKey = key.toLowerCase();
    if (SENSITIVE_KEYS.has(lowerKey) || lowerKey.includes('secret') || lowerKey.includes('token') || lowerKey.includes('key')) {
      sanitized[key] = '[REDACTED]';
      keysCount++;
      continue;
    }

    if (value === null || value === undefined) {
      sanitized[key] = value;
      keysCount++;
    } else if (typeof value === 'string') {
      sanitized[key] = value.length > 500 ? value.slice(0, 500) + '...[truncated]' : value;
      keysCount++;
    } else if (typeof value === 'number' || typeof value === 'boolean') {
      sanitized[key] = value;
      keysCount++;
    } else if (Array.isArray(value)) {
      sanitized[key] = value.slice(0, 20).map((item) =>
        typeof item === 'object' && item !== null
          ? sanitizeDiagnosticMetadata(item as Record<string, unknown>, depth + 1)
          : typeof item === 'string' && item.length > 200
          ? item.slice(0, 200) + '...'
          : item
      );
      keysCount++;
    } else if (typeof value === 'object') {
      sanitized[key] = sanitizeDiagnosticMetadata(value as Record<string, unknown>, depth + 1);
      keysCount++;
    }
  }

  return sanitized;
}

export interface NotificationDiagnosticRepository {
  getDiagnostic(userId: string, diagnosticId: string): Promise<NotificationDiagnosticEvent | null>;
  saveDiagnostic(userId: string, event: NotificationDiagnosticEvent): Promise<void>;
  listDiagnostics(userId: string, correlationId?: string): Promise<NotificationDiagnosticEvent[]>;
}

export class InMemoryNotificationDiagnosticRepository implements NotificationDiagnosticRepository {
  private store = new Map<string, NotificationDiagnosticEvent>();
  public shouldFail = false;
  public failureError = 'Simulated diagnostic repository failure';

  private key(userId: string, diagnosticId: string): string {
    return `${userId}:${diagnosticId}`;
  }

  async getDiagnostic(userId: string, diagnosticId: string): Promise<NotificationDiagnosticEvent | null> {
    if (this.shouldFail) throw new Error(this.failureError);
    const item = this.store.get(this.key(userId, diagnosticId));
    return item ? { ...item } : null;
  }

  async saveDiagnostic(userId: string, event: NotificationDiagnosticEvent): Promise<void> {
    if (this.shouldFail) throw new Error(this.failureError);
    if (event.userId !== userId) throw new Error('User isolation mismatch on diagnostic save');
    this.store.set(this.key(userId, event.diagnosticId), { ...event });
  }

  async listDiagnostics(userId: string, correlationId?: string): Promise<NotificationDiagnosticEvent[]> {
    if (this.shouldFail) throw new Error(this.failureError);
    const prefix = `${userId}:`;
    const results: NotificationDiagnosticEvent[] = [];
    for (const [k, v] of this.store.entries()) {
      if (k.startsWith(prefix)) {
        if (!correlationId || v.correlationId === correlationId) {
          results.push({ ...v });
        }
      }
    }
    results.sort((a, b) => {
      if (a.timestamp !== b.timestamp) return a.timestamp - b.timestamp;
      return a.diagnosticId.localeCompare(b.diagnosticId);
    });
    return results;
  }

  clear(): void {
    this.store.clear();
  }
}

export class FirestoreNotificationDiagnosticRepository implements NotificationDiagnosticRepository {
  async getDiagnostic(userId: string, diagnosticId: string): Promise<NotificationDiagnosticEvent | null> {
    if (!userId || !diagnosticId) return null;
    try {
      const db = getFirestore();
      const ref = doc(db, 'users', userId, 'notificationDiagnostics', diagnosticId);
      const snap = await getDoc(ref);
      if (!snap.exists()) return null;
      return snap.data() as NotificationDiagnosticEvent;
    } catch {
      return null;
    }
  }

  async saveDiagnostic(userId: string, event: NotificationDiagnosticEvent): Promise<void> {
    if (!userId || !event) return;
    if (event.userId !== userId) throw new Error('User isolation mismatch in Firestore diagnostic save');
    const db = getFirestore();
    const ref = doc(db, 'users', userId, 'notificationDiagnostics', event.diagnosticId);
    await setDoc(ref, event);
  }

  async listDiagnostics(userId: string, correlationId?: string): Promise<NotificationDiagnosticEvent[]> {
    if (!userId) return [];
    try {
      const db = getFirestore();
      const colRef = collection(db, 'users', userId, 'notificationDiagnostics');
      const q = query(colRef, orderBy('timestamp', 'asc'));
      const snap = await getDocs(q);
      const list: NotificationDiagnosticEvent[] = [];
      snap.forEach((docSnap) => {
        const data = docSnap.data() as NotificationDiagnosticEvent;
        if (!correlationId || data.correlationId === correlationId) {
          list.push(data);
        }
      });
      list.sort((a, b) => {
        if (a.timestamp !== b.timestamp) return a.timestamp - b.timestamp;
        return a.diagnosticId.localeCompare(b.diagnosticId);
      });
      return list;
    } catch {
      return [];
    }
  }
}

export interface NotificationObservabilityOptions {
  repo?: NotificationDiagnosticRepository;
}

export class NotificationObservabilityManager {
  private repo: NotificationDiagnosticRepository;

  constructor(options: NotificationObservabilityOptions = {}) {
    this.repo = options.repo ?? (typeof window !== 'undefined' ? new FirestoreNotificationDiagnosticRepository() : new InMemoryNotificationDiagnosticRepository());
  }

  public setRepository(repo: NotificationDiagnosticRepository): void {
    this.repo = repo;
  }

  public getRepository(): NotificationDiagnosticRepository {
    return this.repo;
  }

  public generateDiagnosticId(): string {
    return 'diag_' + Math.random().toString(36).substring(2, 11) + '_' + Date.now();
  }

  public generateCorrelationId(eventId?: string, reminderId?: string): string {
    if (eventId) return eventId.trim();
    if (reminderId) return reminderId.trim();
    return 'corr_' + Math.random().toString(36).substring(2, 11) + '_' + Date.now();
  }

  public async recordNotificationDiagnostic(input: {
    authenticatedUserId?: string;
    diagnosticId?: string;
    userId: string;
    eventId?: string;
    reminderId?: string;
    deliveryId?: string;
    acknowledgementId?: string;
    correlationId?: string;
    stage: DiagnosticStage;
    action: DiagnosticAction;
    status: DiagnosticStatus;
    timestamp?: number;
    durationMs?: number;
    attempt?: number;
    errorCode?: string;
    channelId?: string;
    metadata?: Record<string, unknown>;
  }): Promise<{ success: boolean; diagnosticId: string; error?: string }> {
    try {
      const authUserId = input.authenticatedUserId;
      if (!authUserId) {
        return { success: false, diagnosticId: '', error: 'UNAUTHENTICATED' };
      }
      if (input.userId !== authUserId) {
        return { success: false, diagnosticId: '', error: 'USER_MISMATCH' };
      }

      const validStages: DiagnosticStage[] = [
        'scheduler',
        'due_event',
        'event_delivery',
        'generation',
        'notification_delivery',
        'channel',
        'browser',
        'push',
        'acknowledgement',
        'recovery',
        'reconciliation',
      ];
      const validActions: DiagnosticAction[] = [
        'started',
        'completed',
        'failed',
        'claimed',
        'lease_recovered',
        'already_processed',
        'skipped',
        'expired',
        'permission_denied',
        'unavailable',
        'retry_scheduled',
        'retry_exhausted',
        'acknowledged',
        'detected_stuck',
      ];
      const validStatuses: DiagnosticStatus[] = ['success', 'failure', 'pending', 'skipped', 'recovered'];

      if (!validStages.includes(input.stage) || !validActions.includes(input.action) || !validStatuses.includes(input.status)) {
        return { success: false, diagnosticId: '', error: 'INVALID_INPUT' };
      }

      const diagnosticId = input.diagnosticId || this.generateDiagnosticId();
      const correlationId = input.correlationId || this.generateCorrelationId(input.eventId, input.reminderId);
      const timestamp = input.timestamp || Date.now();
      const sanitizedMetadata = sanitizeDiagnosticMetadata(input.metadata);

      const event: NotificationDiagnosticEvent = {
        diagnosticId,
        userId: authUserId,
        eventId: input.eventId,
        reminderId: input.reminderId,
        deliveryId: input.deliveryId,
        acknowledgementId: input.acknowledgementId,
        correlationId,
        stage: input.stage,
        action: input.action,
        status: input.status,
        timestamp,
        durationMs: input.durationMs,
        attempt: input.attempt,
        errorCode: input.errorCode,
        channelId: input.channelId,
        metadata: sanitizedMetadata,
      };

      await this.repo.saveDiagnostic(authUserId, event);
      return { success: true, diagnosticId };
    } catch (err: any) {
      // Failure isolation: diagnostic write failure does not disrupt authoritative workflow
      return { success: false, diagnosticId: input.diagnosticId || '', error: err?.message || 'DIAGNOSTIC_SAVE_FAILED' };
    }
  }

  public async getNotificationTimeline(
    userId: string,
    correlationIdOrEventId: string
  ): Promise<NotificationDiagnosticEvent[]> {
    if (!userId || !correlationIdOrEventId) return [];
    try {
      const diagnostics = await this.repo.listDiagnostics(userId, correlationIdOrEventId);
      return diagnostics;
    } catch {
      return [];
    }
  }

  public async getNotificationHealth(
    userId: string,
    reminders: Array<{ id: string; notificationState?: string; proactiveState?: string; updatedAt?: number }> = [],
    deliveries: Array<{ status: string; channel: string }> = []
  ): Promise<NotificationHealth> {
    const checkedAt = Date.now();
    let pendingCount = 0;
    let failedCount = 0;
    let stuckCount = 0;

    for (const r of reminders) {
      if (r.notificationState === 'pending' || r.proactiveState === 'pending' || r.proactiveState === 'generating') {
        pendingCount++;
        // Check if stuck (> 5 minutes old)
        if (r.updatedAt && checkedAt - r.updatedAt > 300000) {
          stuckCount++;
        }
      } else if (r.notificationState === 'failed' || r.proactiveState === 'failed') {
        failedCount++;
      }
    }

    for (const d of deliveries) {
      if (d.status === 'failed') {
        failedCount++;
      }
    }

    let status: 'healthy' | 'degraded' | 'attention_required' = 'healthy';
    if (failedCount > 0 || stuckCount > 0) {
      status = failedCount >= 2 || stuckCount >= 1 ? 'attention_required' : 'degraded';
    }

    const channelHealth = {
      in_app: { available: true, permission: 'granted', recentFailures: 0 },
      browser: {
        available: typeof window !== 'undefined' && 'Notification' in window,
        permission: typeof window !== 'undefined' && 'Notification' in window ? (Notification.permission || 'unknown') : 'unavailable',
        recentFailures: failedCount,
      },
      push: {
        available: typeof window !== 'undefined' && 'PushManager' in window && 'serviceWorker' in navigator,
        permission: 'granted',
        recentFailures: 0,
      },
    };

    return {
      status,
      checkedAt,
      pendingCount,
      failedCount,
      stuckCount,
      channelHealth,
    };
  }

  public findStuckNotifications(
    userId: string,
    reminders: Array<{ id: string; notificationState?: string; proactiveState?: string; updatedAt?: number }> = [],
    deliveries: Array<{ deliveryId?: string; eventId?: string; status: string; updatedAt?: number }> = [],
    now: number = Date.now(),
    leaseTimeoutMs: number = 300000
  ): StuckNotificationItem[] {
    const stuck: StuckNotificationItem[] = [];

    for (const r of reminders) {
      // Only classify as stuck if actively generating or processing past timeout lease
      if ((r.proactiveState === 'generating' || r.notificationState === 'claimed') && r.updatedAt && now - r.updatedAt > leaseTimeoutMs) {
        stuck.push({
          reminderId: r.id,
          reason: `Stale ${r.proactiveState === 'generating' ? 'generation' : 'delivery'} lease exceeded timeout`,
          staleSince: r.updatedAt,
        });
      }
    }

    for (const d of deliveries) {
      if (d.status === 'delivering' && d.updatedAt && now - d.updatedAt > leaseTimeoutMs) {
        stuck.push({
          deliveryId: d.deliveryId,
          eventId: d.eventId,
          reason: 'Stale delivery claim lease exceeded timeout',
          staleSince: d.updatedAt,
        });
      }
    }

    return stuck;
  }
}

export const notificationObservabilityManager = new NotificationObservabilityManager();
