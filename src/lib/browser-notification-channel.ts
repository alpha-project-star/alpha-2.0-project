// src/lib/browser-notification-channel.ts

/**
 * Phase 3K — Browser / System Notification Channel
 *
 * Implements the browser/system notification delivery provider conforming
 * to the Phase 3J NotificationChannelProvider contract.
 *
 * Features:
 * - Safe runtime feature detection (SSR, Node, Vitest, unsupported WebViews)
 * - Clean permission state abstraction (not_required, unknown, granted, denied, unavailable)
 * - Explicit user-triggered permission request flow (no auto-prompt on startup)
 * - Deterministic, idempotent delivery identity (`${eventId}:browser`)
 * - Cross-context mutual exclusion and delivery claim tracking via delivery repository under cross-context locks
 * - Complete failure isolation preventing rollback of in-app delivery
 * - Strict decoupling between delivery, visibility, and acknowledgement
 */

import {
  NotificationChannelProvider,
  NotificationChannelCapabilities,
  PermissionState,
  NotificationChannelRequest,
  ChannelDeliveryResult,
  validateChannelRequest,
  generateDeliveryId,
} from './notification-channel';
import {
  type NotificationDeliveryManager,
  type NotificationDeliveryRepository,
  type DeliveryRecord,
  LocalDeliveryRepository,
} from './notification-delivery';
import { withCrossContextLock } from './cross-context-lock';

/**
 * Safely detects if standard browser Notifications are supported in the current runtime.
 * Never accesses window.Notification at module evaluation time.
 */
export function isBrowserNotificationSupported(): boolean {
  try {
    if (typeof window === 'undefined') return false;
    return 'Notification' in window && typeof (window as any).Notification === 'function';
  } catch {
    return false;
  }
}

/**
 * Safely detects if Service Worker is supported in the current environment.
 */
export function isServiceWorkerSupported(): boolean {
  try {
    if (typeof navigator === 'undefined') return false;
    return 'serviceWorker' in navigator && typeof navigator.serviceWorker !== 'undefined';
  } catch {
    return false;
  }
}

/**
 * Evaluates the current permission state without triggering a prompt.
 */
export function getBrowserNotificationPermission(): PermissionState {
  if (!isBrowserNotificationSupported()) {
    return 'unavailable';
  }
  try {
    const raw = (window as any).Notification.permission;
    if (raw === 'granted') return 'granted';
    if (raw === 'denied') return 'denied';
    return 'unknown'; // 'default'
  } catch {
    return 'unavailable';
  }
}

export interface RequestPermissionResult {
  state: PermissionState;
  requested: boolean;
  error?: string;
}

/**
 * Requests browser notification permission only upon explicit user action.
 */
export async function requestBrowserNotificationPermission(): Promise<RequestPermissionResult> {
  if (!isBrowserNotificationSupported()) {
    return {
      state: 'unavailable',
      requested: false,
      error: 'Browser notifications are not supported in this environment',
    };
  }

  const current = getBrowserNotificationPermission();
  if (current === 'granted') {
    return { state: 'granted', requested: false };
  }
  if (current === 'denied') {
    return {
      state: 'denied',
      requested: false,
      error: 'Notification permission is blocked. Please adjust browser site settings manually.',
    };
  }

  try {
    const raw = await (window as any).Notification.requestPermission();
    const mapped: PermissionState =
      raw === 'granted' ? 'granted' : raw === 'denied' ? 'denied' : 'unknown';
    return { state: mapped, requested: true };
  } catch (err: any) {
    return {
      state: 'unavailable',
      requested: true,
      error: err?.message || 'Failed to request notification permission',
    };
  }
}

export interface BrowserNotificationChannelOptions {
  deliveryRepo?: NotificationDeliveryRepository;
  deliveryManager?: NotificationDeliveryManager;
  leaseTimeoutMs?: number;
  onNotificationCreated?: (notification: any) => void;
}

export class BrowserNotificationChannelProvider implements NotificationChannelProvider {
  public readonly id = 'browser';
  public readonly displayName = 'Browser / System Notification';

  private deliveryRepo?: NotificationDeliveryRepository;
  private deliveryManager?: NotificationDeliveryManager;
  private leaseTimeoutMs: number;
  private inFlightClaims = new Set<string>();
  private onNotificationCreated?: (notification: any) => void;

  constructor(options: BrowserNotificationChannelOptions = {}) {
    this.deliveryRepo = options.deliveryRepo;
    this.deliveryManager = options.deliveryManager;
    this.leaseTimeoutMs = options.leaseTimeoutMs ?? 30000;
    this.onNotificationCreated = options.onNotificationCreated;
  }

  public getDeliveryRepo(): NotificationDeliveryRepository {
    if (!this.deliveryRepo) {
      this.deliveryRepo = new LocalDeliveryRepository();
    }
    return this.deliveryRepo;
  }

  public setDeliveryRepo(repo: NotificationDeliveryRepository): void {
    this.deliveryRepo = repo;
  }

  public setDeliveryManager(manager: NotificationDeliveryManager): void {
    this.deliveryManager = manager;
  }

  /**
   * Reports capabilities accurately according to current runtime environment.
   */
  public getCapabilities(): NotificationChannelCapabilities {
    const supported = isBrowserNotificationSupported();
    const swSupported = isServiceWorkerSupported();
    return {
      available: supported,
      backgroundDelivery: supported && swSupported,
      requiresPermission: true,
      supportsRichContent: false,
      supportsActions: false,
      supportsSound: false,
    };
  }

  /**
   * Dynamically checks permission state without caching or triggering prompts.
   */
  public getPermissionState(_userId?: string): PermissionState {
    return getBrowserNotificationPermission();
  }

  /**
   * Requests permission explicitly.
   */
  public async requestPermission(): Promise<RequestPermissionResult> {
    return requestBrowserNotificationPermission();
  }

  /**
   * Reports whether this channel is fully available and authorized to deliver now.
   */
  public isAvailable(_userId?: string): boolean {
    if (!isBrowserNotificationSupported()) return false;
    return this.getPermissionState() === 'granted';
  }

  /**
   * Delivers a browser notification for an authoritative reminder event.
   *
   * Enforces:
   * - Authentication & User isolation
   * - Structural schema validation
   * - Environment & Permission verification
   * - Cross-context mutual exclusion & delivery claim tracking via delivery repo under cross-context lock
   * - Decoupling from acknowledgement (delivery != acknowledgement)
   */
  public async deliver(
    request: NotificationChannelRequest,
    authenticatedUserId: string
  ): Promise<ChannelDeliveryResult> {
    const deliveryId = generateDeliveryId(request?.eventId || '', this.id);

    // 1. Authentication Check
    if (!authenticatedUserId || typeof authenticatedUserId !== 'string' || !authenticatedUserId.trim()) {
      return {
        success: false,
        channel: this.id,
        status: 'unauthenticated',
        deliveryId,
        eventId: request?.eventId || '',
        error: {
          code: 'UNAUTHENTICATED',
          message: 'Authenticated user ID is required for browser notification delivery',
        },
      };
    }
    const authUser = authenticatedUserId.trim();

    // 2. Structural Request Validation
    const validation = validateChannelRequest(request);
    if (!validation.success) {
      return {
        success: false,
        channel: this.id,
        status: 'invalid_input',
        deliveryId,
        eventId: request?.eventId || '',
        error: {
          code: 'INVALID_INPUT',
          message: validation.error,
        },
      };
    }
    const validated = validation.request;

    // 3. User Isolation Check
    if (validated.userId !== authUser) {
      return {
        success: false,
        channel: this.id,
        status: 'unauthenticated',
        deliveryId,
        eventId: validated.eventId,
        error: {
          code: 'USER_MISMATCH',
          message: `User isolation violation: record user ${validated.userId} does not match authenticated user ${authUser}`,
        },
      };
    }

    // 4. Feature Detection & Permission Verification
    if (!isBrowserNotificationSupported()) {
      return {
        success: false,
        channel: this.id,
        status: 'unavailable',
        deliveryId,
        eventId: validated.eventId,
        error: {
          code: 'UNSUPPORTED_BROWSER',
          message: 'Browser Notification API is not supported in this environment',
        },
      };
    }

    const currentPermission = this.getPermissionState(authUser);
    if (currentPermission !== 'granted') {
      return {
        success: false,
        channel: this.id,
        status: 'unavailable',
        deliveryId,
        eventId: validated.eventId,
        error: {
          code: currentPermission === 'denied' ? 'PERMISSION_DENIED' : 'PERMISSION_NOT_GRANTED',
          message: `Browser notification permission is not granted (current state: ${currentPermission})`,
        },
      };
    }

    // 5. In-flight Concurrency Check (Local Tab)
    if (this.inFlightClaims.has(deliveryId)) {
      return {
        success: false,
        channel: this.id,
        status: 'rejected' as any,
        deliveryId,
        eventId: validated.eventId,
        error: {
          code: 'DELIVERY_IN_PROGRESS',
          message: `Browser delivery for ${deliveryId} is currently in progress`,
        },
      };
    }

    // 6 & 7. Read authoritative claim state and acquire execution claim under cross-context lock
    const repo = this.getDeliveryRepo();
    const lockName = `alpha_browser_delivery_lock_${authUser}_${deliveryId}`;
    const claimResult = await withCrossContextLock(lockName, async () => {
      let existing: DeliveryRecord | null = null;
      try {
        existing = await repo.getDelivery(authUser, deliveryId);
        if (existing) {
          if (existing.status === 'delivered') {
            return {
              status: 'resolved' as const,
              result: {
                success: true,
                channel: this.id,
                status: 'already_delivered' as const,
                deliveryId,
                eventId: validated.eventId,
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
                  channel: this.id,
                  status: 'rejected' as const,
                  deliveryId,
                  eventId: validated.eventId,
                  error: {
                    code: 'DELIVERY_IN_PROGRESS',
                    message: 'Browser delivery claim actively held by another process (delivery in progress)',
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
            channel: this.id,
            status: 'temporary_failure' as const,
            deliveryId,
            eventId: validated.eventId,
            error: {
              code: 'PERSISTENCE_FAILURE',
              message: `Failed reading delivery repository: ${err?.message}`,
              retryable: true,
            },
          },
        };
      }

      const now = Date.now();
      try {
        if (!existing) {
          await repo.saveDelivery(authUser, {
            deliveryId,
            eventId: validated.eventId,
            reminderId: validated.reminderId,
            userId: authUser,
            messageId: validated.messageId || `msg-${validated.eventId}`,
            channel: this.id,
            status: 'delivering',
            createdAt: now,
            updatedAt: now,
            retryCount: 0,
          });
        } else {
          await repo.updateDelivery(authUser, deliveryId, {
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
            channel: this.id,
            status: 'temporary_failure' as const,
            deliveryId,
            eventId: validated.eventId,
            error: {
              code: 'PERSISTENCE_FAILURE',
              message: `Failed acquiring browser delivery claim: ${repoErr?.message}`,
              retryable: true,
            },
          },
        };
      }

      return { status: 'acquired' as const };
    });

    if (claimResult.status === 'resolved') {
      return claimResult.result;
    }

    this.inFlightClaims.add(deliveryId);

    // 8. Execute Browser Notification Display
    try {
      const title = `🔔 Alpha: ${validated.title}`;
      const notificationOptions: NotificationOptions = {
        body: validated.body,
        tag: validated.eventId,
        icon: '/icon-192.png',
        data: {
          eventId: validated.eventId,
          reminderId: validated.reminderId,
          url: '/',
          notes: validated.notes,
          metadata: validated.metadata,
        },
      };

      let notificationInstance: any = null;

      // Try Service Worker showNotification if active; otherwise use standard window.Notification
      if (
        typeof navigator !== 'undefined' &&
        'serviceWorker' in navigator &&
        navigator.serviceWorker.controller
      ) {
        try {
          const reg = await navigator.serviceWorker.ready;
          if (reg && typeof reg.showNotification === 'function') {
            await reg.showNotification(title, notificationOptions);
          } else {
            notificationInstance = new (window as any).Notification(title, notificationOptions);
          }
        } catch {
          notificationInstance = new (window as any).Notification(title, notificationOptions);
        }
      } else {
        notificationInstance = new (window as any).Notification(title, notificationOptions);
      }

      if (notificationInstance) {
        notificationInstance.onclick = (event: any) => {
          try {
            event?.preventDefault?.();
            window.focus?.();
          } catch {}
        };
        if (this.onNotificationCreated) {
          this.onNotificationCreated(notificationInstance);
        }
      }

      const deliveredAt = Date.now();

      // Update delivery repository to 'delivered'
      await repo.updateDelivery(authUser, deliveryId, {
        status: 'delivered',
        deliveredAt,
        updatedAt: deliveredAt,
      });

      this.inFlightClaims.delete(deliveryId);

      return {
        success: true,
        channel: this.id,
        status: 'delivered',
        deliveryId,
        eventId: validated.eventId,
        messageId: validated.messageId,
        deliveredAt,
      };
    } catch (deliveryErr: any) {
      this.inFlightClaims.delete(deliveryId);

      try {
        await repo.updateDelivery(authUser, deliveryId, {
          status: 'failed',
          failedAt: Date.now(),
          updatedAt: Date.now(),
          error: deliveryErr?.message || 'Browser notification creation failed',
        });
      } catch {
        // Non-blocking on cleanup error
      }

      return {
        success: false,
        channel: this.id,
        status: 'temporary_failure',
        deliveryId,
        eventId: validated.eventId,
        messageId: validated.messageId,
        error: {
          code: 'DELIVERY_FAILED',
          message: deliveryErr?.message || 'Browser notification creation failed',
        },
      };
    }
  }
}

export const browserNotificationChannelProvider = new BrowserNotificationChannelProvider();
