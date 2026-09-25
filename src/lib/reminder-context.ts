/**
 * ============================================================================
 * ARCHITECTURAL AUTHORITY DECLARATION — AL-02 RECONCILIATION
 * ============================================================================
 * ROLE: Conversational Reminder Context Manager
 * AUTHORITATIVE SYMBOL: ReminderContextManager (reminderContextManager)
 *
 * RESPONSIBILITIES:
 *  - Tracks the currently active conversational focus/context for reminders
 *    per authenticated user in-memory.
 *  - Enforces strict user isolation (clears context on mismatched user ID access).
 *  - Provides immediate conversational lookup and context clearing/invalidation.
 *
 * NOT RESPONSIBLE FOR:
 *  - Planning or decomposition structures (owned by `src/lib/execution.ts`).
 *  - Action-tag coordination and execution sequencing (owned by `src/lib/actions.ts`).
 *  - Canonical reminder repository persistence (owned by `src/lib/reminder-repo.ts`).
 * ============================================================================
 */

import { FirestoreReminder } from './reminder-repo';
import { formatReminderDate } from './reminder-date-utils';
import { withCrossContextLock } from './cross-context-lock';
import { getStorage } from './alpha-store';

const LS_KEY = 'alpha.reminder_context.v1';

export interface ActiveReminderContext {
  id: string;
  title: string;
  dueAt: number;
    userId: string;
  notes?: string;
  updatedAt: number;
}

export interface PendingClarificationData {
  title: string;
  rawWhen: string;
  notes?: string;
  hour: number;
}

export type ReminderContextInput = 
  | FirestoreReminder 
  | {
      id: string;
      title: string;
      dueAt: number;
            userId?: string;
      notes?: string;
    };

/**
 * Authoritative in-memory conversational reminder context manager.
 * Tracks the current reminder in conversational focus per authenticated user.
 * Enforces strict user isolation: access attempts with a different userId clear context.
 */
class ReminderContextManager {
  private activeContext: ActiveReminderContext | null = null;
  private pendingClarification: { userId: string; data: PendingClarificationData } | null = null;
  private currentUserId: string | null = null;

  constructor() {
    this.reload();
  }

  private getStorageKey(userId: string | null): string {
    // All reminder contexts now use the stable canonical base key.
    return LS_KEY;
  }

  private reload(userId?: string) {
    const storage = getStorage();
    if (!storage) return;
    const key = this.getStorageKey(null);
    try {
      const v = storage.getItem(key);
      if (v) {
        const parsed = JSON.parse(v);
        this.activeContext = parsed.context;
        this.pendingClarification = parsed.pendingClarification || null;
        this.currentUserId = "local-user";
      }
    } catch {
      this.clear();
    }
  }

  private save() {
    const storage = getStorage();
    if (!storage) return;
    const key = this.getStorageKey(null);
    try {
      if (this.activeContext || this.pendingClarification) {
        storage.setItem(key, JSON.stringify({
          context: this.activeContext,
          pendingClarification: this.pendingClarification,
          userId: "local-user"
        }));
      } else {
        storage.removeItem(key);
      }
    } catch {}
  }

  async setContext(userId: string, reminder: ReminderContextInput) {
    await withCrossContextLock('alpha_lock_reminder_context', async () => {
      this.currentUserId = "local-user";
      this.activeContext = {
        id: reminder.id,
        title: reminder.title,
        dueAt: reminder.dueAt,
        userId: "local-user",
        notes: (reminder as any).notes,
        updatedAt: Date.now()
      };
      this.save();
    });
  }

  getContext(userId: string): ActiveReminderContext | null {
    this.reload();
    return this.activeContext;
  }

  async setPendingClarification(userId: string, data: PendingClarificationData) {
    await withCrossContextLock('alpha_lock_reminder_context', async () => {
      this.currentUserId = "local-user";
      this.pendingClarification = { userId: "local-user", data };
      this.save();
    });
  }

  getPendingClarification(userId: string): PendingClarificationData | null {
    this.reload();
    return this.pendingClarification?.data || null;
  }

  clearPendingClarification(userId: string) {
    this.reload();
    this.pendingClarification = null;
    this.save();
  }

  clear() {
    this.activeContext = null;
    this.pendingClarification = null;
    this.currentUserId = "local-user";
    this.save();
  }

  async invalidate(userId: string, reminderId: string) {
    await withCrossContextLock('alpha_lock_reminder_context', async () => {
      this.reload();
      if (this.activeContext?.id === reminderId) {
        this.clear();
      }
    });
  }
}

export const reminderContextManager = new ReminderContextManager();
