import { useState, useEffect, useCallback } from 'react';
import { Bell, Clock, Check, CheckCircle2, AlertCircle, RefreshCw } from 'lucide-react';
import { auth } from '../lib/firebase';
import { MessageContent } from './MessageContent';
import {
  resolveNotificationStatus,
  acknowledgeNotificationFromUI,
  NotificationDisplayStatus,
} from '../lib/notification-ui-state';
import { notificationAcknowledgementManager } from '../lib/notification-acknowledgement';
import { formatReminderDate } from '../lib/reminder-date-utils';

export interface NotificationCardProps {
  messageId: string;
  proactiveEventId: string;
  text: string;
  ts: number;
  reminderId?: string;
  title?: string;
  dueAt?: number;
    children?: React.ReactNode;
}

export function NotificationCard({
  messageId,
  proactiveEventId,
  text,
  ts,
  reminderId: initialReminderId,
  title: initialTitle,
  dueAt: initialDueAt,
    children,
}: NotificationCardProps) {
  const [status, setStatus] = useState<NotificationDisplayStatus>('awaiting_acknowledgement');
  const [title, setTitle] = useState<string | undefined>(initialTitle);
  const [dueAt, setDueAt] = useState<number | undefined>(initialDueAt);
  const [formattedTime, setFormattedTime] = useState<string | undefined>(
    initialDueAt ? formatReminderDate(initialDueAt) : undefined
  );
  const [reminderId, setReminderId] = useState<string | undefined>(initialReminderId);
  const [submitting, setSubmitting] = useState(false);
  const [errorMessage, setErrorMessage] = useState<string | null>(null);

  const fetchRecordData = useCallback(async () => {
    const currentUid = auth.currentUser?.uid || 'local-user';
    if (!proactiveEventId) return;

    try {
      const repo = notificationAcknowledgementManager.getRepository();
      const record = await repo.getAcknowledgementByEventId(currentUid, proactiveEventId);

      if (record) {
        if (!title && record.title) setTitle(record.title);
        if (!dueAt && record.dueAt) {
          setDueAt(record.dueAt);
          setFormattedTime(formatReminderDate(record.dueAt));
        }
        if (!reminderId && record.reminderId) setReminderId(record.reminderId);
      }

      const resolved = await resolveNotificationStatus(
        currentUid,
        proactiveEventId,
        reminderId || record?.reminderId,
      );
      setStatus(resolved);
    } catch {
      // Safe fallback: preserve current status
    }
  }, [proactiveEventId, title, dueAt, reminderId]);

  useEffect(() => {
    fetchRecordData();

    // Subscribe to acknowledgement changes
    const unsub = notificationAcknowledgementManager.subscribe((rec) => {
      const currentUid = auth.currentUser?.uid || 'local-user';
      if (rec.userId === currentUid && rec.eventId === proactiveEventId) {
        if (rec.status === 'acknowledged') {
          setStatus('acknowledged');
          setErrorMessage(null);
        } else if (rec.status === 'delivered' || rec.status === 'pending') {
          setStatus('awaiting_acknowledgement');
        }
      }
    });

    return unsub;
  }, [fetchRecordData, proactiveEventId]);

  const handleAcknowledge = async () => {
    const currentUid = auth.currentUser?.uid || 'local-user';

    setSubmitting(true);
    setErrorMessage(null);

    const result = await acknowledgeNotificationFromUI(currentUid, proactiveEventId, reminderId);

    setSubmitting(false);
    if (result.success) {
      setStatus('acknowledged');
    } else {
      setErrorMessage(result.error || "I couldn't save that acknowledgement. Try again.");
    }
  };

  const displayTitle = title || 'Reminder Notification';
  const displayTime = formattedTime || (dueAt ? formatReminderDate(dueAt) : undefined);

  return (
    <div
      className="w-full min-w-0 rounded-2xl overflow-hidden border border-primary/30 bg-primary/5 shadow-lg my-2 transition-all"
      data-testid="notification-card"
      data-event-id={proactiveEventId}
      data-status={status}
    >
      {/* Notification Header */}
      <div className="flex flex-wrap items-center justify-between gap-2 px-4 py-2.5 bg-primary/10 border-b border-primary/20">
        <div className="flex items-center gap-2 min-w-0">
          <div className="p-1 rounded-md bg-primary/20 text-primary shrink-0" aria-hidden="true">
            <Bell className="w-4 h-4" />
          </div>
          <div className="min-w-0">
            <div className="text-xs font-semibold text-foreground truncate font-mono tracking-tight">
              {displayTitle}
            </div>
            {displayTime && (
              <div className="text-[10px] text-muted-foreground flex items-center gap-1 font-mono">
                <Clock className="w-3 h-3 shrink-0" aria-hidden="true" />
                <span>Scheduled: {displayTime}</span>
              </div>
            )}
          </div>
        </div>

        {/* Status Indicator */}
        <div className="shrink-0 flex items-center gap-1.5">
          {status === 'completed' && (
            <span
              className="inline-flex items-center gap-1 px-2.5 py-1 rounded-full text-[11px] font-medium bg-emerald-500/15 text-emerald-400 border border-emerald-500/30"
              role="status"
              aria-label="Status: Completed"
            >
              <CheckCircle2 className="w-3.5 h-3.5" aria-hidden="true" />
              Completed
            </span>
          )}
          {status === 'acknowledged' && (
            <span
              className="inline-flex items-center gap-1 px-2.5 py-1 rounded-full text-[11px] font-medium bg-primary/20 text-primary border border-primary/40"
              role="status"
              aria-label="Status: Acknowledged"
            >
              <Check className="w-3.5 h-3.5" aria-hidden="true" />
              Acknowledged
            </span>
          )}
          {status === 'awaiting_acknowledgement' && (
            <span
              className="inline-flex items-center gap-1 px-2.5 py-1 rounded-full text-[11px] font-medium bg-amber-500/15 text-amber-300 border border-amber-500/30 animate-pulse"
              role="status"
              aria-label="Status: Awaiting acknowledgement"
            >
              <Clock className="w-3.5 h-3.5" aria-hidden="true" />
              Awaiting acknowledgement
            </span>
          )}
        </div>
      </div>

      {/* Message Body */}
      <div className="px-4 py-3 text-sm text-foreground/90 break-words [overflow-wrap:anywhere]">
        <MessageContent text={text} />
      </div>

      {/* Interaction Footer for Awaiting Acknowledgement */}
      {status === 'awaiting_acknowledgement' && (
        <div className="px-4 pb-3 pt-1 flex flex-col sm:flex-row items-start sm:items-center justify-between gap-2 border-t border-primary/10">
          <div className="text-[11px] text-muted-foreground flex items-center gap-1">
            <span>Confirm receipt of this reminder</span>
          </div>
          <button
            onClick={handleAcknowledge}
            disabled={submitting}
            aria-label={`Acknowledge reminder: ${displayTitle}`}
            className="inline-flex items-center justify-center gap-1.5 px-4 py-2 rounded-xl bg-primary text-primary-foreground font-medium text-xs hover:bg-primary/90 active:scale-95 disabled:opacity-50 transition-all min-h-[44px] min-w-[120px] shadow-sm cursor-pointer"
          >
            {submitting ? (
              <>
                <RefreshCw className="w-3.5 h-3.5 animate-spin" aria-hidden="true" />
                <span>Saving…</span>
              </>
            ) : (
              <>
                <Check className="w-3.5 h-3.5" aria-hidden="true" />
                <span>Acknowledge</span>
              </>
            )}
          </button>
        </div>
      )}

      {/* Error state */}
      {errorMessage && (
        <div
          className="mx-4 mb-3 p-2.5 rounded-xl bg-destructive/15 border border-destructive/40 text-destructive-foreground text-xs flex items-center justify-between gap-2"
          role="alert"
        >
          <div className="flex items-center gap-1.5 min-w-0">
            <AlertCircle className="w-4 h-4 shrink-0 text-destructive" aria-hidden="true" />
            <span className="truncate">{errorMessage}</span>
          </div>
          <button
            onClick={handleAcknowledge}
            className="px-2 py-1 rounded bg-destructive/20 hover:bg-destructive/30 text-[11px] font-medium shrink-0"
          >
            Retry
          </button>
        </div>
      )}

      {/* Message actions (copy, speech, delete) */}
      {children && <div className="px-4 pb-2">{children}</div>}
    </div>
  );
}
