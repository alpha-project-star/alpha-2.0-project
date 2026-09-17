import { formatReminderDate } from './reminder-date-utils';
import { reminderContextManager, ActiveReminderContext } from './reminder-context';
import {
  AcknowledgementRecord,
  AcknowledgementRepository,
  AcknowledgementStatus,
  AcknowledgementChannel,
  notificationAcknowledgementManager,
} from './notification-acknowledgement';

export type RecoveryErrorCode =
  | 'UNAUTHENTICATED'
  | 'USER_MISMATCH'
  | 'INVALID_INPUT'
  | 'NOT_FOUND'
  | 'PERSISTENCE_FAILURE'
  | 'QUERY_FAILURE'
  | 'CONCURRENCY_CONFLICT';

export type OutstandingAcknowledgementRecord = AcknowledgementRecord;

export interface RecoveryResultSuccess {
  success: true;
  status: 'success' | 'empty';
  records: OutstandingAcknowledgementRecord[];
  count: number;
}

export interface RecoveryResultFailure {
  success: false;
  status:
    | 'unauthenticated'
    | 'user_mismatch'
    | 'invalid_input'
    | 'not_found'
    | 'persistence_failure'
    | 'query_failure'
    | 'concurrency_conflict';
  error: {
    code: RecoveryErrorCode;
    message: string;
  };
}

export type RecoveryResult = RecoveryResultSuccess | RecoveryResultFailure;

export interface InquiryClassification {
  isInquiry: boolean;
  queryType?: 'what' | 'which' | 'when' | 'missed' | 'general';
  explicitTarget?: string;
}

/**
 * Classifies user inquiries regarding delivered / unacknowledged reminders.
 */
export function classifyInquiryUtterance(rawText: string): InquiryClassification {
  if (!rawText || typeof rawText !== 'string') {
    return { isInquiry: false };
  }

  const lower = rawText.toLowerCase().replace(/[.,!?;:]/g, ' ').replace(/\s+/g, ' ').trim();
  if (!lower) {
    return { isInquiry: false };
  }

  // Check for "when" questions about an active/recent reminder
  const whenPatterns = [
    /^(?:when\s+was\s+(?:that|the|my)\s+(?:reminder|appointment|task)|when\s+is\s+(?:that|the|it)|when\s+was\s+it\??)$/,
    /\b(?:when\s+was\s+(?:that|the)\s+appointment|when\s+was\s+(?:that|the)\s+reminder)\b/,
    /\b(?:what\s+time\s+was\s+(?:that|the\s+reminder|the\s+appointment))\b/,
  ];
  if (whenPatterns.some((p) => p.test(lower))) {
    const match = lower.match(/(?:reminder|appointment|task)\s+(?:for|about|named)?\s*(.+)?$/);
    return {
      isInquiry: true,
      queryType: 'when',
      explicitTarget: match && match[1] ? match[1].trim() : undefined,
    };
  }

  // Check for "missed" / "outstanding" questions
  const missedPatterns = [
    /\b(?:what\s+reminders?\s+did\s+i\s+miss|did\s+i\s+miss\s+(?:any|a)\s+reminders?|is\s+there\s+anything\s+i\s+missed|what\s+did\s+i\s+miss)\b/,
    /\b(?:which\s+reminders?\s+have\s+i\s+not\s+acknowledged|what\s+reminders?\s+are\s+pending|unacknowledged\s+reminders?)\b/,
  ];
  if (missedPatterns.some((p) => p.test(lower))) {
    return { isInquiry: true, queryType: 'missed' };
  }

  // Check for "what was that..." or "what reminder..." questions
  const whatPatterns = [
    /^(?:what\s+was\s+that|what\s+reminders?|which\s+reminders?|what\s+was\s+the\s+reminder|what\s+appointment|what\s+was\s+that\s+appointment|what\s+about\s+(?:the\s+)?(.+))\b/,
    /\b(?:what\s+was\s+(?:that|the)\s+appointment|what\s+was\s+(?:that|the)\s+reminder)\b/,
    /\b(?:tell\s+me\s+about\s+(?:the\s+)?(?:unacknowledged\s+)?reminder)\b/,
    /\b(?:what\s+was\s+the\s+other\s+reminder(?:\s+again)?)\b/,
    /\b(?:what\s+about\s+(?:the\s+)?(.+))\b/,
  ];
  if (whatPatterns.some((p) => p.test(lower))) {
    const match = lower.match(/(?:about|for|named)\s+(?:the\s+)?(.+)$/);
    return {
      isInquiry: true,
      queryType: 'what',
      explicitTarget: match && match[1] ? match[1].replace(/\b(?:reminder|appointment)\b/g, '').trim() : undefined,
    };
  }

  return { isInquiry: false };
}

export class NotificationRecoveryManager {
  private repo: AcknowledgementRepository;

  constructor(repo?: AcknowledgementRepository) {
    this.repo = repo || notificationAcknowledgementManager.getRepository();
  }

  public setRepository(repo: AcknowledgementRepository): void {
    this.repo = repo;
  }

  public getRepository(): AcknowledgementRepository {
    return this.repo;
  }

  /**
   * Queries all outstanding (delivered / pending, unacknowledged) records for an authenticated user.
   * Read-only: Does not mutate state or generate messages.
   */
  public async getOutstandingAcknowledgements(userId: string): Promise<RecoveryResult> {
    if (!userId || typeof userId !== 'string' || !userId.trim()) {
      return {
        success: false,
        status: 'unauthenticated',
        error: {
          code: 'UNAUTHENTICATED',
          message: 'Authenticated user ID is required for recovery',
        },
      };
    }
    const cleanUserId = userId.trim();

    try {
      const all = await this.repo.listAcknowledgements(cleanUserId);
      const userRecords = all.filter((r) => r.userId === cleanUserId);

      const outstanding: OutstandingAcknowledgementRecord[] = userRecords
        .filter((r) => r.status === 'delivered' || r.status === 'pending')
        .map((r) => ({
          ...r,
                  }))
        .sort((a, b) => (b.deliveredAt || b.createdAt) - (a.deliveredAt || a.createdAt));

      if (outstanding.length === 0) {
        return {
          success: true,
          status: 'empty',
          records: [],
          count: 0,
        };
      }

      return {
        success: true,
        status: 'success',
        records: outstanding,
        count: outstanding.length,
      };
    } catch (err: any) {
      return {
        success: false,
        status: 'persistence_failure',
        error: {
          code: 'PERSISTENCE_FAILURE',
          message: `Failed to query outstanding acknowledgements: ${err?.message || err}`,
        },
      };
    }
  }

  /**
   * Queries outstanding acknowledgement record for a specific eventId.
   */
  public async getOutstandingAcknowledgementForEvent(
    userId: string,
    eventId: string,
  ): Promise<RecoveryResult> {
    if (!userId || typeof userId !== 'string' || !userId.trim()) {
      return {
        success: false,
        status: 'unauthenticated',
        error: {
          code: 'UNAUTHENTICATED',
          message: 'Authenticated user ID is required',
        },
      };
    }
    if (!eventId || typeof eventId !== 'string' || !eventId.trim()) {
      return {
        success: false,
        status: 'invalid_input',
        error: {
          code: 'INVALID_INPUT',
          message: 'Event ID is required',
        },
      };
    }
    const cleanUserId = userId.trim();

    try {
      const record = await this.repo.getAcknowledgementByEventId(cleanUserId, eventId.trim());
      if (!record || record.userId !== cleanUserId) {
        return {
          success: false,
          status: 'not_found',
          error: {
            code: 'NOT_FOUND',
            message: `No record found for event ID: ${eventId}`,
          },
        };
      }

      if (record.status !== 'delivered' && record.status !== 'pending') {
        return {
          success: true,
          status: 'empty',
          records: [],
          count: 0,
        };
      }

      const formatted: OutstandingAcknowledgementRecord = {
        ...record,
              };

      return {
        success: true,
        status: 'success',
        records: [formatted],
        count: 1,
      };
    } catch (err: any) {
      return {
        success: false,
        status: 'persistence_failure',
        error: {
          code: 'PERSISTENCE_FAILURE',
          message: `Failed to query event acknowledgement: ${err?.message || err}`,
        },
      };
    }
  }

  /**
   * Queries outstanding acknowledgement records for a specific reminderId.
   */
  public async getOutstandingAcknowledgementForReminder(
    userId: string,
    reminderId: string,
  ): Promise<RecoveryResult> {
    if (!userId || typeof userId !== 'string' || !userId.trim()) {
      return {
        success: false,
        status: 'unauthenticated',
        error: {
          code: 'UNAUTHENTICATED',
          message: 'Authenticated user ID is required',
        },
      };
    }
    if (!reminderId || typeof reminderId !== 'string' || !reminderId.trim()) {
      return {
        success: false,
        status: 'invalid_input',
        error: {
          code: 'INVALID_INPUT',
          message: 'Reminder ID is required',
        },
      };
    }

    const cleanUserId = userId.trim();
    const cleanReminderId = reminderId.trim();

    try {
      const all = await this.repo.listAcknowledgements(cleanUserId);
      const matching = all
        .filter((r) => r.userId === cleanUserId && r.reminderId === cleanReminderId)
        .filter((r) => r.status === 'delivered' || r.status === 'pending')
        .map((r) => ({
          ...r,
                  }))
        .sort((a, b) => (b.deliveredAt || b.createdAt) - (a.deliveredAt || a.createdAt));

      if (matching.length === 0) {
        return {
          success: true,
          status: 'empty',
          records: [],
          count: 0,
        };
      }

      return {
        success: true,
        status: 'success',
        records: matching,
        count: matching.length,
      };
    } catch (err: any) {
      return {
        success: false,
        status: 'persistence_failure',
        error: {
          code: 'PERSISTENCE_FAILURE',
          message: `Failed to query reminder acknowledgement: ${err?.message || err}`,
        },
      };
    }
  }

  /**
   * Resolves the active outstanding reminder based on current conversation context or single pending item.
   */
  public async getActiveOutstandingAcknowledgement(
    userId: string,
  ): Promise<OutstandingAcknowledgementRecord | null> {
    if (!userId) return null;
    const cleanUserId = userId.trim();

    const activeCtx = reminderContextManager.getContext(cleanUserId);
    const recoveryRes = await this.getOutstandingAcknowledgements(cleanUserId);
    if (!recoveryRes.success || recoveryRes.count === 0) {
      return null;
    }

    if (activeCtx) {
      const match = recoveryRes.records.find((r) => r.reminderId === activeCtx.id);
      if (match) return match;
    }

    if (recoveryRes.count === 1) {
      return recoveryRes.records[0];
    }

    return null;
  }

  /**
   * Helper to check if a specific event is delivered and unacknowledged.
   */
  public async isDeliveredAndUnacknowledged(userId: string, eventId: string): Promise<boolean> {
    const res = await this.getOutstandingAcknowledgementForEvent(userId, eventId);
    return res.success && res.status === 'success' && res.count > 0;
  }

  /**
   * Helper to check if a specific event has already been acknowledged.
   */
  public async isAcknowledged(userId: string, eventId: string): Promise<boolean> {
    if (!userId || !eventId) return false;
    try {
      const record = await this.repo.getAcknowledgementByEventId(userId.trim(), eventId.trim());
      return !!record && record.status === 'acknowledged';
    } catch {
      return false;
    }
  }

  /**
   * Handles conversational inquiry questions such as "What reminder did I miss?" or "When was that appointment?"
   * Preserves user isolation and context continuity without claiming the user heard/saw it.
   */
  public async handleConversationalInquiry(userId: string, userText: string): Promise<string | null> {
    if (!userId || !userText) return null;
    const cleanUserId = userId.trim();

    const classification = classifyInquiryUtterance(userText);
    if (!classification.isInquiry) {
      return null;
    }

    const outstandingResult = await this.getOutstandingAcknowledgements(cleanUserId);
    if (!outstandingResult.success) {
      return 'I could not verify your outstanding reminder status at this moment.';
    }

    const { records, count } = outstandingResult;
    const activeCtx = reminderContextManager.getContext(cleanUserId);

    // Handle "When was that..." inquiries
    if (classification.queryType === 'when') {
      let targetRecord: OutstandingAcknowledgementRecord | null = null;
      if (classification.explicitTarget) {
        const q = classification.explicitTarget.toLowerCase();
        targetRecord =
          records.find((r) => r.title && r.title.toLowerCase().includes(q)) || null;
      }
      if (!targetRecord && activeCtx) {
        targetRecord = records.find((r) => r.reminderId === activeCtx.id) || null;
      }
      if (!targetRecord && count === 1) {
        targetRecord = records[0];
      }

      if (targetRecord) {
        const timeStr = (targetRecord.dueAt ? formatReminderDate(targetRecord.dueAt) : 'the scheduled time');
        const titleStr = targetRecord.title ? ` for "${targetRecord.title}"` : '';
        return `Your reminder${titleStr} was scheduled for ${timeStr}. It was delivered, but remains awaiting acknowledgement.`;
      } else if (activeCtx) {
        return `It was scheduled for ${formatReminderDate(activeCtx.dueAt)}.`;
      }
    }

    // Explicit target filtering for "what about X"
    if (classification.explicitTarget && count > 0) {
      const q = classification.explicitTarget.toLowerCase();
      const matched = records.filter((r) => r.title && r.title.toLowerCase().includes(q));
      if (matched.length === 1) {
        const r = matched[0];
        const timeStr = (r.dueAt ? ` (scheduled for ${formatReminderDate(r.dueAt)})` : '');
        // Synchronize conversational context if no active context is set
        if (!activeCtx) {
          reminderContextManager.setContext(cleanUserId, {
            id: r.reminderId,
            title: r.title || 'Reminder',
            dueAt: r.dueAt || Date.now(),
          });
        }
        return `Your reminder for "${r.title}" was delivered${timeStr}, but you have not acknowledged it yet.`;
      }
    }

    if (count === 0) {
      return 'You have no outstanding reminder notifications awaiting confirmation.';
    }

    if (count === 1) {
      const r = records[0];
      const titleStr = r.title ? `"${r.title}"` : 'your scheduled reminder';
      const timeStr = (r.dueAt ? ` scheduled for ${formatReminderDate(r.dueAt)}` : '');

      // Update conversational context safely without clobbering newer context
      if (!activeCtx || activeCtx.id === r.reminderId) {
        reminderContextManager.setContext(cleanUserId, {
          id: r.reminderId,
          title: r.title || 'Reminder',
          dueAt: r.dueAt || Date.now(),
        });
      }

      return `Your reminder for ${titleStr}${timeStr} was delivered, but you have not acknowledged it yet.`;
    }

    // Multiple outstanding reminders: list them clearly and ask for clarification
    const formattedList = records
      .map((r, idx) => {
        const title = r.title ? `"${r.title}"` : `Reminder ${idx + 1}`;
        const time = (r.dueAt ? ` (scheduled for ${formatReminderDate(r.dueAt)})` : '');
        return `${idx + 1}. ${title}${time}`;
      })
      .join('\n');

    return `You have ${count} reminders awaiting confirmation:\n${formattedList}\n\nWhich one would you like to follow up on?`;
  }

  public clearUserContext(userId: string): void {
    if (!userId) return;
    reminderContextManager.clear();
  }

  public reset(): void {
    reminderContextManager.clear();
  }
}

export const notificationRecoveryManager = new NotificationRecoveryManager();
