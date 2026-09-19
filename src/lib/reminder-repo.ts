/**
 * ============================================================================
 * ARCHITECTURAL AUTHORITY DECLARATION — FOUNDATION HARDENING
 * ============================================================================
 * ROLE: Canonical Local-First Reminder Persistence Authority
 * AUTHORITATIVE SYMBOL: ReminderRepository (LocalReminderRepository)
 *
 * RESPONSIBILITIES:
 *  - Serves as the single authoritative persistence engine for reminders.
 *  - Backed by browser local persistence (alpha.reminders.v1 via getStorage()).
 *  - In-memory fallback for SSR and test environments.
 *  - Zero network dependence; works offline and for unauthenticated users.
 *  - Persist-before-commit semantics with safe error handling (PersistenceError).
 *  - Atomic read-modify-write with transaction-like claim state conflict detection.
 *
 * NOT RESPONSIBLE FOR:
 *  - Conversational context / focus tracking (owned by `src/lib/reminder-context.ts`).
 *  - In-memory chat/note/bill application state (owned by `src/lib/alpha-store.ts`).
 * ============================================================================
 */

import { getStorage, PersistenceError } from './alpha-store';

export type ReminderState = 'active' | 'completed' | 'cancelled';
export type NotificationState = 'pending' | 'claimed' | 'accepted' | 'failed';
export type ProactiveResponseState = 'pending' | 'generating' | 'generated' | 'failed';

export interface FirestoreReminder {
  id: string;
  userId: string;
  title: string;
  notes: string;
  dueAt: number;
  createdAt: number;
  updatedAt: number;
  reminderState: ReminderState;
  notificationState: NotificationState;
  legacyFiredAt?: number; // Preserves legacy firing history
  proactiveState?: ProactiveResponseState;
  proactiveEventId?: string;
  proactiveHandledAt?: number;
  proactiveMessageId?: string;
}

export type LocalReminder = FirestoreReminder;

export interface ReminderRepository {
  listReminders(userId: string): Promise<FirestoreReminder[]>;
  getReminder(userId: string, reminderId: string): Promise<FirestoreReminder | null>;
  createReminder(userId: string, reminder: FirestoreReminder): Promise<void>;
  updateReminder(userId: string, reminderId: string, patch: Partial<FirestoreReminder>): Promise<void>;
  deleteReminder(userId: string, reminderId: string): Promise<void>;
  clear?(): void;
}

const STORAGE_PREFIX = 'alpha.reminders.v1';

export class LocalReminderRepository implements ReminderRepository {
  public store = new Map<string, FirestoreReminder>();
  public shouldFail = false;
  public failureError = 'Local reminder persistence failure';

  private storageKey(userId: string): string {
    const safeUid = userId ? userId.trim() : 'local-user';
    return `${STORAGE_PREFIX}.${safeUid}`;
  }

  private load(userId: string): Map<string, FirestoreReminder> {
    if (this.shouldFail) {
      throw new PersistenceError(this.storageKey(userId), new Error(this.failureError));
    }
    const storage = getStorage();
    if (!storage) {
      return this.store;
    }
    const key = this.storageKey(userId);
    let raw: string | null;
    try {
      raw = storage.getItem(key);
    } catch (readErr) {
      throw new PersistenceError(key, readErr);
    }

    // Case 1: No stored reminder data (missing key or genuinely empty string)
    if (raw === null || raw.trim() === "") {
      return new Map();
    }

    // Case 2 & 3: Parse and validate stored JSON
    let list: unknown;
    try {
      list = JSON.parse(raw);
    } catch (jsonErr) {
      throw new PersistenceError(
        key,
        new Error(`Malformed JSON in reminder storage: ${jsonErr instanceof Error ? jsonErr.message : String(jsonErr)}`)
      );
    }

    if (!Array.isArray(list)) {
      throw new PersistenceError(key, new Error("Invalid reminder storage structure: expected an array"));
    }

    const map = new Map<string, FirestoreReminder>();
    for (const item of list) {
      if (
        !item ||
        typeof item !== "object" ||
        typeof (item as Record<string, unknown>).id !== "string" ||
        !(item as { id: string }).id.trim() ||
        typeof (item as Record<string, unknown>).title !== "string" ||
        typeof (item as Record<string, unknown>).dueAt !== "number" ||
        isNaN((item as { dueAt: number }).dueAt) ||
        !isFinite((item as { dueAt: number }).dueAt)
      ) {
        throw new PersistenceError(
          key,
          new Error("Invalid reminder record in storage: missing id, title, or valid numeric dueAt")
        );
      }
      map.set((item as FirestoreReminder).id, item as FirestoreReminder);
    }
    return map;
  }

  private save(userId: string, map: Map<string, FirestoreReminder>): void {
    if (this.shouldFail) {
      throw new PersistenceError(this.storageKey(userId), new Error(this.failureError));
    }
    const storage = getStorage();
    if (!storage) {
      this.store = map;
      return;
    }
    const key = this.storageKey(userId);
    const list = Array.from(map.values());
    try {
      storage.setItem(key, JSON.stringify(list));
      if (typeof window !== 'undefined') {
        try {
          window.dispatchEvent(new CustomEvent('alpha:reminders-changed'));
        } catch {}
      }
    } catch (err) {
      throw new PersistenceError(key, err);
    }
  }

  async listReminders(userId: string): Promise<FirestoreReminder[]> {
    if (this.shouldFail) throw new Error(this.failureError);
    const effectiveUserId = userId || 'local-user';
    const map = this.load(effectiveUserId);
    return Array.from(map.values()).filter(r => r.userId === effectiveUserId || !r.userId || r.userId === 'local-user');
  }

  async getReminder(userId: string, reminderId: string): Promise<FirestoreReminder | null> {
    if (this.shouldFail) throw new Error(this.failureError);
    const effectiveUserId = userId || 'local-user';
    const map = this.load(effectiveUserId);
    const item = map.get(reminderId);
    if (!item) return null;
    return { ...item };
  }

  async createReminder(userId: string, reminder: FirestoreReminder): Promise<void> {
    if (this.shouldFail) throw new Error(this.failureError);
    const effectiveUserId = userId || 'local-user';
    const map = this.load(effectiveUserId);
    const nextReminder: FirestoreReminder = {
      ...reminder,
      userId: effectiveUserId,
      updatedAt: Date.now(),
    };
    const nextMap = new Map(map);
    nextMap.set(reminder.id, nextReminder);
    this.save(effectiveUserId, nextMap);
    this.store.set(reminder.id, nextReminder);
  }

  async updateReminder(userId: string, reminderId: string, patch: Partial<FirestoreReminder>): Promise<void> {
    if (this.shouldFail) throw new Error(this.failureError);
    const effectiveUserId = userId || 'local-user';
    const map = this.load(effectiveUserId);
    const existing = map.get(reminderId);
    if (!existing) {
      throw new Error(`Reminder not found: ${reminderId}`);
    }
    if (patch.notificationState === 'claimed' && existing.notificationState && existing.notificationState !== 'pending') {
      throw new Error('Transaction conflict: already claimed');
    }
    const updated: FirestoreReminder = {
      ...existing,
      ...patch,
      updatedAt: Date.now(),
    };
    const nextMap = new Map(map);
    nextMap.set(reminderId, updated);
    this.save(effectiveUserId, nextMap);
    this.store.set(reminderId, updated);
  }

  async deleteReminder(userId: string, reminderId: string): Promise<void> {
    if (this.shouldFail) throw new Error(this.failureError);
    const effectiveUserId = userId || 'local-user';
    const map = this.load(effectiveUserId);
    if (!map.has(reminderId)) return;
    const nextMap = new Map(map);
    nextMap.delete(reminderId);
    this.save(effectiveUserId, nextMap);
    this.store.delete(reminderId);
  }

  clear(): void {
    this.store.clear();
    const storage = getStorage();
    if (storage) {
      try {
        const keysToRemove: string[] = [];
        for (let i = 0; i < storage.length; i++) {
          const k = storage.key(i);
          if (k && k.startsWith(STORAGE_PREFIX)) {
            keysToRemove.push(k);
          }
        }
        for (const k of keysToRemove) {
          storage.removeItem(k);
        }
      } catch {}
    }
  }
}

export class InMemoryReminderRepository extends LocalReminderRepository {
  private key(userId: string, reminderId: string): string {
    return `${userId}:${reminderId}`;
  }

  override async listReminders(userId: string): Promise<FirestoreReminder[]> {
    if (this.shouldFail) throw new Error(this.failureError);
    const prefix = `${userId}:`;
    const results: FirestoreReminder[] = [];
    for (const [k, v] of this.store.entries()) {
      if (k.startsWith(prefix) && v.userId === userId) {
        results.push({ ...v });
      }
    }
    return results;
  }

  override async getReminder(userId: string, reminderId: string): Promise<FirestoreReminder | null> {
    if (this.shouldFail) throw new Error(this.failureError);
    const r = this.store.get(this.key(userId, reminderId));
    if (!r || r.userId !== userId) return null;
    return { ...r };
  }

  override async createReminder(userId: string, reminder: FirestoreReminder): Promise<void> {
    if (this.shouldFail) throw new Error(this.failureError);
    if (reminder.userId !== userId) throw new Error("User ID mismatch");
    this.store.set(this.key(userId, reminder.id), { ...reminder });
  }

  override async updateReminder(userId: string, reminderId: string, patch: Partial<FirestoreReminder>): Promise<void> {
    if (this.shouldFail) throw new Error(this.failureError);
    const k = this.key(userId, reminderId);
    const r = this.store.get(k);
    if (!r || r.userId !== userId) throw new Error('Reminder not found');
    if (patch.notificationState === 'claimed' && r.notificationState && r.notificationState !== 'pending') {
      throw new Error('Transaction conflict: already claimed');
    }
    this.store.set(k, { ...r, ...patch, updatedAt: Date.now() });
  }

  override async deleteReminder(userId: string, reminderId: string): Promise<void> {
    if (this.shouldFail) throw new Error(this.failureError);
    this.store.delete(this.key(userId, reminderId));
  }

  override clear(): void {
    this.store.clear();
  }
}

/**
 * Backward compatibility alias: FirestoreReminderRepository redirects to LocalReminderRepository.
 * Reminders are strictly local-first and do not persist to Firestore.
 */
export const FirestoreReminderRepository = LocalReminderRepository;
