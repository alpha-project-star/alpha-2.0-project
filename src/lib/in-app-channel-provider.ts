// src/lib/in-app-channel-provider.ts

import {
  NotificationChannelProvider,
  NotificationChannelCapabilities,
  PermissionState,
  NotificationChannelRequest,
  ChannelDeliveryResult,
  validateChannelRequest,
} from './notification-channel';
import {
  NotificationDeliveryManager,
  notificationDelivery,
  generateDeliveryId,
} from './notification-delivery';

export class InAppNotificationChannelProvider implements NotificationChannelProvider {
  public readonly id = 'in_app';
  public readonly displayName = 'In-App Notification';

  private deliveryManager?: NotificationDeliveryManager;

  constructor(deliveryManager?: NotificationDeliveryManager) {
    this.deliveryManager = deliveryManager;
  }

  public setDeliveryManager(manager: NotificationDeliveryManager): void {
    this.deliveryManager = manager;
  }

  public getCapabilities(): NotificationChannelCapabilities {
    return {
      available: true,
      backgroundDelivery: false,
      requiresPermission: false,
      supportsRichContent: true,
      supportsActions: true,
      supportsSound: false,
    };
  }

  public getPermissionState(_userId?: string): PermissionState {
    return 'not_required';
  }

  public isAvailable(_userId?: string): boolean {
    return true;
  }

  public async deliver(
    request: NotificationChannelRequest,
    authenticatedUserId: string
  ): Promise<ChannelDeliveryResult> {
    const deliveryId = generateDeliveryId(request.eventId, this.id);

    // 1. Authentication & Security Check
    if (!authenticatedUserId || typeof authenticatedUserId !== 'string' || !authenticatedUserId.trim()) {
      return {
        success: false,
        channel: this.id,
        status: 'unauthenticated',
        deliveryId,
        eventId: request?.eventId || '',
        error: {
          code: 'UNAUTHENTICATED',
          message: 'Authenticated user ID is required for notification delivery',
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

    // 4. Delegate to In-App Delivery Execution
    const manager = this.deliveryManager || notificationDelivery;
    const result = await manager.deliverProactiveResponse({
      authenticatedUserId: authUser,
      channel: this.id,
      record: {
        eventId: validated.eventId,
        reminderId: validated.reminderId,
        userId: authUser,
        messageId: validated.messageId || `msg-${validated.eventId}`,
        text: validated.body,
        title: validated.title,
        dueAt: validated.dueAt,
        notes: validated.notes,
      },
    });

    if (result.success) {
      return {
        success: true,
        channel: this.id,
        status: result.status === 'already_delivered' ? 'already_delivered' : 'delivered',
        deliveryId: result.deliveryId,
        eventId: result.eventId,
        messageId: result.messageId,
        deliveredAt: result.deliveredAt,
      };
    }

    // Map delivery manager error codes to channel delivery status
    let status: ChannelDeliveryResult['status'] = 'temporary_failure';
    if (result.error.code === 'UNAUTHENTICATED' || result.error.code === 'USER_MISMATCH') {
      status = 'unauthenticated';
    } else if (result.error.code === 'INVALID_INPUT') {
      status = 'invalid_input';
    } else if (result.error.code === 'UNSUPPORTED_CHANNEL') {
      status = 'unsupported';
    } else if (result.error.code === 'PERSISTENCE_FAILURE') {
      status = 'permanent_failure';
    }

    return {
      success: false,
      channel: this.id,
      status,
      deliveryId: result.deliveryId || deliveryId,
      eventId: result.eventId,
      messageId: result.messageId,
      error: {
        code: result.error.code,
        message: result.error.message,
      },
    };
  }
}
