// src/lib/push-subscription.ts

import { doc, setDoc, getDoc, deleteDoc, collection, getDocs } from 'firebase/firestore';
import { db } from './firebase';

export interface PushSubscriptionRecord {
  subscriptionId: string;
  userId: string;
  endpoint: string;
  keys: {
    p256dh: string;
    auth: string;
  };
  expirationTime?: number | null;
  createdAt: number;
  updatedAt: number;
  userAgent?: string;
}

export function isPushSupported(): boolean {
  try {
    if (typeof window === 'undefined') return false;
    return 'PushManager' in window && 'serviceWorker' in navigator;
  } catch {
    return false;
  }
}

export function urlBase64ToUint8Array(base64String: string): Uint8Array {
  const padding = '='.repeat((4 - (base64String.length % 4)) % 4);
  const base64 = (base64String + padding).replace(/-/g, '+').replace(/_/g, '/');
  const rawData = window.atob(base64);
  const outputArray = new Uint8Array(rawData.length);
  for (let i = 0; i < rawData.length; ++i) {
    outputArray[i] = rawData.charCodeAt(i);
  }
  return outputArray;
}

export async function getActiveServiceWorkerRegistration(): Promise<ServiceWorkerRegistration | null> {
  if (!isPushSupported()) return null;
  try {
    const reg = await navigator.serviceWorker.ready;
    return reg || null;
  } catch {
    return null;
  }
}

export async function getExistingPushSubscription(): Promise<PushSubscription | null> {
  const reg = await getActiveServiceWorkerRegistration();
  if (!reg || !reg.pushManager) return null;
  try {
    return await reg.pushManager.getSubscription();
  } catch {
    return null;
  }
}

export interface PushSubscriptionResult {
  success: boolean;
  subscription?: PushSubscriptionRecord;
  error?: {
    code: string;
    message: string;
  };
}

/**
 * Subscribes the browser to push notifications and securely persists the subscription to Firestore.
 */
export async function registerPushSubscription(
  authenticatedUserId: string,
  vapidPublicKey: string
): Promise<PushSubscriptionResult> {
  if (!authenticatedUserId || !authenticatedUserId.trim()) {
    return {
      success: false,
      error: { code: 'UNAUTHENTICATED', message: 'Authenticated user ID is required for push subscription' },
    };
  }
  const userId = authenticatedUserId.trim();

  if (!isPushSupported()) {
    return {
      success: false,
      error: { code: 'PUSH_UNSUPPORTED', message: 'Push API or ServiceWorker is not supported in this environment' },
    };
  }

  if (!vapidPublicKey || !vapidPublicKey.trim()) {
    return {
      success: false,
      error: { code: 'INVALID_VAPID_KEY', message: 'VAPID public key is missing or invalid' },
    };
  }

  try {
    const reg = await getActiveServiceWorkerRegistration();
    if (!reg) {
      return {
        success: false,
        error: { code: 'SERVICE_WORKER_UNAVAILABLE', message: 'Active ServiceWorker registration not found' },
      };
    }

    let sub = await reg.pushManager.getSubscription();
    if (!sub) {
      const convertedKey = urlBase64ToUint8Array(vapidPublicKey.trim());
      sub = await reg.pushManager.subscribe({
        userVisibleOnly: true,
        applicationServerKey: convertedKey as any,
      });
    }

    const json = sub.toJSON();
    const endpoint = json.endpoint || '';
    const keys = json.keys || { p256dh: '', auth: '' };
    
    // Create a deterministic subscription ID from endpoint hash or identifier
    const subscriptionId = btoa(endpoint).replace(/[/+=]/g, '_').substring(0, 64);
    const now = Date.now();

    const record: PushSubscriptionRecord = {
      subscriptionId,
      userId,
      endpoint,
      keys: {
        p256dh: keys.p256dh || '',
        auth: keys.auth || '',
      },
      expirationTime: json.expirationTime || null,
      createdAt: now,
      updatedAt: now,
      userAgent: typeof navigator !== 'undefined' ? navigator.userAgent : 'unknown',
    };

    // Save to Firestore: users/{userId}/pushSubscriptions/{subscriptionId}
    const subRef = doc(db, 'users', userId, 'pushSubscriptions', subscriptionId);
    await setDoc(subRef, record, { merge: true });

    return {
      success: true,
      subscription: record,
    };
  } catch (err: any) {
    return {
      success: false,
      error: {
        code: 'PUSH_SUBSCRIPTION_FAILED',
        message: err?.message || 'Failed to create push subscription',
      },
    };
  }
}

export async function unregisterPushSubscription(authenticatedUserId: string): Promise<{ success: boolean; error?: string }> {
  if (!authenticatedUserId || !authenticatedUserId.trim()) {
    return { success: false, error: 'Unauthenticated' };
  }
  const userId = authenticatedUserId.trim();

  try {
    const sub = await getExistingPushSubscription();
    if (sub) {
      const endpoint = sub.endpoint;
      const subscriptionId = btoa(endpoint).replace(/[/+=]/g, '_').substring(0, 64);
      await sub.unsubscribe();

      const subRef = doc(db, 'users', userId, 'pushSubscriptions', subscriptionId);
      await deleteDoc(subRef).catch(() => {});
    }
    return { success: true };
  } catch (err: any) {
    return { success: false, error: err?.message || 'Failed to unsubscribe' };
  }
}
