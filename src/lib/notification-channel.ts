// src/lib/notification-channel.ts

/**
 * Phase 3J — External Notification Channel Architecture
 *
 * Defines the contract, capability model, permission abstraction,
 * and delivery protocol for notification channels.
 */

export type NotificationChannelId = 'in_app' | string;

/**
 * Permission states representing authorization level for external channels.
 */
export type PermissionState =
  | 'not_required'
  | 'unknown'
  | 'granted'
  | 'denied'
  | 'unavailable';

/**
 * High-level capabilities exposed by a notification channel provider.
 */
export interface NotificationChannelCapabilities {
  available: boolean;
  backgroundDelivery: boolean;
  requiresPermission: boolean;
  supportsRichContent: boolean;
  supportsActions: boolean;
  supportsSound: boolean;
}

/**
 * Status values distinguishing channel availability and authorization dimensions.
 */
export interface ChannelAvailabilityReport {
  supported: boolean;
  available: boolean;
  permission: PermissionState;
  enabled: boolean;
}

/**
 * Incoming request payload passed to a channel provider.
 */
export interface NotificationChannelRequest {
  eventId: string;
  reminderId: string;
  userId: string;
  title: string;
  body: string;
  notificationId?: string;
  messageId?: string;
  dueAt?: number;
  createdAt?: number;
  notes?: string;
  metadata?: Record<string, unknown>;
  channel?: string;
}

/**
 * Structured delivery status reported by a notification channel.
 */
export type ChannelDeliveryStatus =
  | 'delivered'
  | 'already_delivered'
  | 'unavailable'
  | 'unsupported'
  | 'unauthenticated'
  | 'invalid_input'
  | 'temporary_failure'
  | 'permanent_failure';

/**
 * Structured delivery result returned by a channel provider.
 */
export interface ChannelDeliveryResult {
  success: boolean;
  channel: string;
  status: ChannelDeliveryStatus;
  deliveryId?: string;
  eventId: string;
  messageId?: string;
  deliveredAt?: number;
  error?: {
    code: string;
    message: string;
    retryable?: boolean;
  };
}

/**
 * Architecture-only representation for future channel preferences.
 */
export interface NotificationChannelPreference {
  channel: NotificationChannelId;
  enabled: boolean;
}

/**
 * Provider interface that each delivery channel must implement.
 */
export interface NotificationChannelProvider {
  readonly id: string;
  readonly displayName: string;
  getCapabilities(): NotificationChannelCapabilities;
  getPermissionState(userId?: string): Promise<PermissionState> | PermissionState;
  isAvailable(userId?: string): Promise<boolean> | boolean;
  deliver(
    request: NotificationChannelRequest,
    authenticatedUserId: string
  ): Promise<ChannelDeliveryResult>;
}

/**
 * Validates an incoming channel request payload for structural correctness.
 */
export function validateChannelRequest(
  data: unknown
): { success: true; request: NotificationChannelRequest } | { success: false; error: string } {
  if (!data || typeof data !== 'object') {
    return { success: false, error: 'Channel request payload must be a non-null object' };
  }

  const req = data as Partial<NotificationChannelRequest>;

  if (!req.eventId || typeof req.eventId !== 'string' || !req.eventId.trim()) {
    return { success: false, error: 'Non-empty string eventId is required' };
  }
  if (!req.reminderId || typeof req.reminderId !== 'string' || !req.reminderId.trim()) {
    return { success: false, error: 'Non-empty string reminderId is required' };
  }
  if (!req.userId || typeof req.userId !== 'string' || !req.userId.trim()) {
    return { success: false, error: 'Non-empty string userId is required' };
  }
  if (req.title === undefined || typeof req.title !== 'string') {
    return { success: false, error: 'String title is required' };
  }
  if (req.body === undefined || typeof req.body !== 'string') {
    return { success: false, error: 'String body is required' };
  }
  if (req.metadata !== undefined && (typeof req.metadata !== 'object' || req.metadata === null || Array.isArray(req.metadata))) {
    return { success: false, error: 'metadata must be a record object if provided' };
  }

  return {
    success: true,
    request: {
      eventId: req.eventId.trim(),
      reminderId: req.reminderId.trim(),
      userId: req.userId.trim(),
      title: req.title,
      body: req.body,
      notificationId: req.notificationId,
      messageId: req.messageId,
      dueAt: req.dueAt,
      createdAt: req.createdAt || Date.now(),
      notes: req.notes,
      metadata: req.metadata,
      channel: req.channel,
    },
  };
}

/**
 * Deterministically constructs a unique delivery identity for a given event and channel.
 */
export function generateDeliveryId(eventId: string, channel = 'in_app'): string {
  const cleanEvent = (eventId || '').trim();
  const cleanChannel = (channel || 'in_app').trim().toLowerCase();
  return `${cleanEvent}:${cleanChannel}`;
}
