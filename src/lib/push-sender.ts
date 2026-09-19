// src/lib/push-sender.ts

if (typeof window !== 'undefined') {
  throw new Error('push-sender cannot be imported or executed in the client browser bundle.');
}

import webPush from 'web-push';
import { getServerConfig } from './config.server';

export interface PushPayload {
  type?: string;
  eventId: string;
  reminderId: string;
  userId: string;
  title: string;
  body: string;
  url?: string;
  notes?: string;
  metadata?: Record<string, unknown>;
}

export interface PushSendResult {
  success: boolean;
  endpoint: string;
  status: 'sent' | 'expired' | 'failed' | 'transient_failure';
  statusCode?: number;
  error?: string;
}

export async function sendWebPushToSubscription(
  subscription: {
    endpoint: string;
    keys: { p256dh: string; auth: string };
    userId?: string;
  },
  payload: PushPayload
): Promise<PushSendResult> {
  const publicKey = process.env.VAPID_PUBLIC_KEY;
  const privateKey = process.env.VAPID_PRIVATE_KEY;
  const subject = process.env.VAPID_SUBJECT || 'mailto:admin@alpha.app';

  if (!publicKey || !privateKey) {
    return {
      success: false,
      endpoint: subscription.endpoint,
      status: 'failed',
      error: 'VAPID public or private key is not configured on the server',
    };
  }

  try {
    webPush.setVapidDetails(subject, publicKey, privateKey);

    const pushSub = {
      endpoint: subscription.endpoint,
      keys: {
        p256dh: subscription.keys.p256dh,
        auth: subscription.keys.auth,
      },
    };

    const payloadString = JSON.stringify({
      type: payload.type || 'alpha_notification',
      eventId: payload.eventId,
      reminderId: payload.reminderId,
      title: payload.title,
      body: payload.body,
      url: payload.url || '/',
      notes: payload.notes,
      metadata: payload.metadata,
    });

    await webPush.sendNotification(pushSub, payloadString);

    return {
      success: true,
      endpoint: subscription.endpoint,
      status: 'sent',
    };
  } catch (err: any) {
    const statusCode = err?.statusCode || err?.status || 500;
    // 404 Not Found or 410 Gone indicates subscription has expired / become invalid
    if (statusCode === 404 || statusCode === 410) {
      return {
        success: false,
        endpoint: subscription.endpoint,
        status: 'expired',
        statusCode,
        error: 'Subscription has expired or is invalid (404/410)',
      };
    }

    const isTransient = statusCode >= 500 || statusCode === 429;
    return {
      success: false,
      endpoint: subscription.endpoint,
      status: isTransient ? 'transient_failure' : 'failed',
      statusCode,
      error: err?.message || 'Web push send failed',
    };
  }
}
