import { useEffect, useState, useCallback, useMemo } from 'react';
import { auth } from './firebase';
import {
  AcknowledgementRecord,
  AcknowledgementStatus,
  notificationAcknowledgementManager,
} from './notification-acknowledgement';
import {
  notificationRecoveryManager,
  OutstandingAcknowledgementRecord,
} from './notification-recovery';
import { formatReminderDate } from './reminder-date-utils';
import { LocalReminderRepository } from './reminder-repo';

const reminderRepo = new LocalReminderRepository();

export type NotificationDisplayStatus =
  | 'awaiting_acknowledgement'
  | 'acknowledged'
  | 'completed'
  | 'unknown';

export interface NotificationCardViewModel {
  eventId: string;
  reminderId: string;
  title: string;
  dueAt?: number;
    status: NotificationDisplayStatus;
  deliveredAt?: number;
  acknowledgedAt?: number;
  messageId: string;
  messageText: string;
}

/**
 * Resolves the true authoritative status of a notification event for an authenticated user.
 * Distinct states:
 * - 'completed': underlying reminder is marked done/completed
 * - 'acknowledged': user explicitly acknowledged notification
 * - 'awaiting_acknowledgement': notification was delivered but has not been acknowledged
 * - 'unknown': no record found or unauthenticated
 */
export async function resolveNotificationStatus(
  userId: string,
  eventId: string,
  reminderId?: string,
): Promise<NotificationDisplayStatus> {
  if (!userId || !eventId) return 'unknown';

  const cleanUid = userId.trim();
  const cleanEventId = eventId.trim();

  // 1. Check if underlying reminder is completed in authoritative repository
  if (reminderId) {
    try {
      const durableMatch = await reminderRepo.getReminder(cleanUid, reminderId);
      if (durableMatch && durableMatch.reminderState === 'completed') {
        return 'completed';
      }
    } catch {
      // Safe boundary
    }
  }

  // 2. Query acknowledgement status
  try {
    const repo = notificationAcknowledgementManager.getRepository();
    const ackRecord = await repo.getAcknowledgementByEventId(cleanUid, cleanEventId);
    if (ackRecord && ackRecord.userId === cleanUid) {
      if (ackRecord.status === 'acknowledged') {
        return 'acknowledged';
      }
      if (ackRecord.status === 'delivered' || ackRecord.status === 'pending') {
        return 'awaiting_acknowledgement';
      }
    }

    // Fallback: check recovery manager
    const recRes = await notificationRecoveryManager.getOutstandingAcknowledgementForEvent(cleanUid, cleanEventId);
    if (recRes.success && recRes.status === 'success' && recRes.count > 0) {
      return 'awaiting_acknowledgement';
    }

    return 'unknown';
  } catch {
    return 'unknown';
  }
}

/**
 * Authoritatively acknowledges a delivered reminder event from the UI.
 * Does NOT generate LLM messages or duplicate proactive messages.
 * Does NOT auto-complete the reminder.
 */
export async function acknowledgeNotificationFromUI(
  userId: string,
  eventId: string,
  reminderId?: string,
): Promise<{ success: boolean; error?: string }> {
  if (!userId || !eventId) {
    return {
      success: false,
      error: "Authentication required to acknowledge notification.",
    };
  }

  try {
    const result = await notificationAcknowledgementManager.acknowledgeReminder({
      authenticatedUserId: userId.trim(),
      eventId: eventId.trim(),
      reminderId: reminderId?.trim(),
      channel: 'in_app',
      userConfirmationText: 'Explicit UI acknowledgement',
    });

    if (result.success || (result as any).status === 'already_acknowledged' || (result as any).status === 'concurrency_conflict') {
      return { success: true };
    }

    return {
      success: false,
      error: "I couldn't save that acknowledgement. Try again.",
    };
  } catch (err: any) {
    return {
      success: false,
      error: "I couldn't save that acknowledgement. Try again.",
    };
  }
}

/**
 * Custom React hook for tracking user notification state in the UI.
 * Respects strict user isolation and deterministic ordering.
 */
export function useNotificationUIState() {
  const [currentUserId, setCurrentUserId] = useState<string | null>(() => auth.currentUser?.uid || null);
  const [outstandingRecords, setOutstandingRecords] = useState<OutstandingAcknowledgementRecord[]>([]);
  const [completedReminderIds, setCompletedReminderIds] = useState<Set<string>>(new Set());
  const [ackMap, setAckMap] = useState<Record<string, AcknowledgementStatus>>({});
  const [loading, setLoading] = useState(false);
  const [actionError, setActionError] = useState<string | null>(null);

  // Re-sync when auth state changes
  useEffect(() => {
    const unsub = auth.onAuthStateChanged((user) => {
      const newUid = user?.uid || null;
      setCurrentUserId((prevUid) => {
        if (prevUid !== newUid) {
          setOutstandingRecords([]);
          setCompletedReminderIds(new Set());
          setAckMap({});
          if (prevUid) {
            notificationAcknowledgementManager.clearUserContext(prevUid);
          }
        }
        return newUid;
      });
      if (!newUid) {
        setOutstandingRecords([]);
        setCompletedReminderIds(new Set());
        setAckMap({});
      }
    });
    return unsub;
  }, []);

  const refreshCompletedReminders = useCallback(async (uid?: string | null) => {
    const targetUid = uid !== undefined ? uid : currentUserId;
    if (!targetUid) {
      setCompletedReminderIds(new Set());
      return;
    }
    try {
      const allReminders = await reminderRepo.listReminders(targetUid);
      const doneIds = new Set(
        allReminders
          .filter((r) => r.reminderState === 'completed')
          .map((r) => r.id),
      );
      setCompletedReminderIds(doneIds);
    } catch {
      // Safe boundary
    }
  }, [currentUserId]);

  const refreshOutstanding = useCallback(async (uid?: string | null) => {
    const targetUid = uid !== undefined ? uid : currentUserId;
    if (!targetUid) {
      setOutstandingRecords([]);
      return;
    }

    setLoading(true);
    try {
      const res = await notificationRecoveryManager.getOutstandingAcknowledgements(targetUid);
      if (res.success && res.status === 'success') {
        setOutstandingRecords(res.records);
      } else {
        setOutstandingRecords([]);
      }
    } catch {
      setOutstandingRecords([]);
    } finally {
      setLoading(false);
    }
  }, [currentUserId]);

  // Initial fetch and listener subscription
  useEffect(() => {
    if (!currentUserId) {
      setOutstandingRecords([]);
      setCompletedReminderIds(new Set());
      return;
    }

    refreshOutstanding(currentUserId);
    refreshCompletedReminders(currentUserId);

    const unsubAck = notificationAcknowledgementManager.subscribe((record) => {
      if (record.userId === currentUserId) {
        setAckMap((prev) => ({ ...prev, [record.eventId]: record.status }));
        refreshOutstanding(currentUserId);
      }
    });

    const handleRemindersChange = () => {
      refreshCompletedReminders(currentUserId);
    };
    if (typeof window !== "undefined") {
      window.addEventListener('alpha:reminders-changed', handleRemindersChange);
    }

    return () => {
      unsubAck();
      if (typeof window !== "undefined") {
        window.removeEventListener('alpha:reminders-changed', handleRemindersChange);
      }
    };
  }, [currentUserId, refreshOutstanding, refreshCompletedReminders]);

  const getStatusForEvent = useCallback(
    (eventId: string, reminderId?: string): NotificationDisplayStatus => {
      if (!currentUserId || !eventId) return 'unknown';

      // 1. Check if reminder is completed in local reminder repository
      if (reminderId && completedReminderIds.has(reminderId)) {
        return 'completed';
      }

      // 2. Check local ackMap
      const mapped = ackMap[eventId];
      if (mapped === 'acknowledged') return 'acknowledged';
      if (mapped === 'delivered' || mapped === 'pending') return 'awaiting_acknowledgement';

      // 3. Check outstanding records
      const isOutstanding = outstandingRecords.some((r) => r.eventId === eventId);
      if (isOutstanding) return 'awaiting_acknowledgement';

      return 'unknown';
    },
    [currentUserId, ackMap, outstandingRecords, completedReminderIds],
  );

  const acknowledge = useCallback(
    async (eventId: string, reminderId?: string) => {
      if (!currentUserId) {
        return { success: false, error: 'Authentication required' };
      }
      setActionError(null);
      const res = await acknowledgeNotificationFromUI(currentUserId, eventId, reminderId);
      if (res.success) {
        setAckMap((prev) => ({ ...prev, [eventId]: 'acknowledged' }));
        setOutstandingRecords((prev) => prev.filter((r) => r.eventId !== eventId));
      } else {
        setActionError(res.error || "I couldn't save that acknowledgement. Try again.");
      }
      return res;
    },
    [currentUserId],
  );

  return {
    currentUserId,
    outstandingRecords,
    outstandingCount: outstandingRecords.length,
    loading,
    actionError,
    refreshOutstanding,
    getStatusForEvent,
    acknowledge,
  };
}
