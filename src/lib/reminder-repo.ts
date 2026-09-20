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
 *    Note: localStorage provides browser-origin local persistence, not server-durable storage.
 *  - In-memory fallback for SSR and test environments.
 *  - Zero network dependence; works offline and for unauthenticated users.
 *  - Persist-before-commit semantics with safe error handling (PersistenceError).
 *  - Serialized read-modify-write claim transitions protected by cross-context locks with claim conflict detection.
 *
 * NOT RESPONSIBLE FOR:
 *  - Conversational context / focus tracking (owned by `src/lib/reminder-context.ts`).
 *  - In-memory chat/note/bill application state (owned by `src/lib/alpha-store.ts`).
 * ============================================================================
 */

import { getStorage, PersistenceError } from './alpha-store';
import { withCrossContextLock } from './cross-context-lock';

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
  replaceReminders(userId: string, reminders: FirestoreReminder[]): Promise<void>;
  clear(): Promise<void>;
}

const STORAGE_PREFIX = 'alpha.reminders.v1';

function isObjectRecord(val: unknown): val is Record<string, unknown> {
  return typeof val === 'object' && val !== null && !Array.isArray(val);
}

function isFiniteNumber(val: unknown): val is number {
  return typeof val === 'number' && Number.isFinite(val);
}

function isReminderState(val: unknown): val is ReminderState {
  return val === 'active' || val === 'completed' || val === 'cancelled';
}

function isNotificationState(val: unknown): val is NotificationState {
  return val === 'pending' || val === 'claimed' || val === 'accepted' || val === 'failed';
}

function isProactiveResponseState(val: unknown): val is ProactiveResponseState {
  return val === 'pending' || val === 'generating' || val === 'generated' || val === 'failed';
}

function validateAndParseReminder(item: unknown, effectiveUserId: string, key: string): FirestoreReminder {
  if (!isObjectRecord(item)) {
    throw new PersistenceError(key, new Error('Invalid reminder record in storage: expected a non-null object'));
  }

  // 1. id: non-empty string
  if (typeof item.id !== 'string' || item.id.trim() === '') {
    throw new PersistenceError(key, new Error('Invalid reminder record in storage: missing or empty "id"'));
  }

  // 2. userId: non-empty string, must match effective user
  if (typeof item.userId !== 'string' || item.userId.trim() === '') {
    throw new PersistenceError(key, new Error(`Invalid reminder record in storage: missing or empty "userId" for reminder ${item.id}`));
  }
  if (item.userId !== effectiveUserId) {
    throw new PersistenceError(
      key,
      new Error(`User ownership mismatch in storage: expected "${effectiveUserId}", found "${item.userId}" on reminder ${item.id}`)
    );
  }

  // 3. title: must be a string
  if (typeof item.title !== 'string') {
    throw new PersistenceError(key, new Error(`Invalid reminder record in storage: "title" must be a string on reminder ${item.id}`));
  }

  // 4. notes: must be a string (do not silently synthesize if missing)
  if (typeof item.notes !== 'string') {
    throw new PersistenceError(key, new Error(`Invalid reminder record in storage: "notes" must be a string on reminder ${item.id}`));
  }

  // 5. dueAt: finite number
  if (!isFiniteNumber(item.dueAt)) {
    throw new PersistenceError(key, new Error(`Invalid reminder record in storage: "dueAt" must be a finite number on reminder ${item.id}`));
  }

  // 6. createdAt: finite number
  if (!isFiniteNumber(item.createdAt)) {
    throw new PersistenceError(key, new Error(`Invalid reminder record in storage: "createdAt" must be a finite number on reminder ${item.id}`));
  }

  // 7. updatedAt: finite number
  if (!isFiniteNumber(item.updatedAt)) {
    throw new PersistenceError(key, new Error(`Invalid reminder record in storage: "updatedAt" must be a finite number on reminder ${item.id}`));
  }

  // 8. reminderState: 'active' | 'completed' | 'cancelled'
  if (!isReminderState(item.reminderState)) {
    throw new PersistenceError(
      key,
      new Error(`Invalid reminder record in storage: invalid "reminderState" "${String(item.reminderState)}" on reminder ${item.id}`)
    );
  }

  // 9. notificationState: 'pending' | 'claimed' | 'accepted' | 'failed'
  if (!isNotificationState(item.notificationState)) {
    throw new PersistenceError(
      key,
      new Error(`Invalid reminder record in storage: invalid "notificationState" "${String(item.notificationState)}" on reminder ${item.id}`)
    );
  }

  // Optional canonical fields validation:
  if (item.legacyFiredAt !== undefined && !isFiniteNumber(item.legacyFiredAt)) {
    throw new PersistenceError(
      key,
      new Error(`Invalid reminder record in storage: "legacyFiredAt" must be a finite number on reminder ${item.id}`)
    );
  }

  if (item.proactiveState !== undefined && !isProactiveResponseState(item.proactiveState)) {
    throw new PersistenceError(
      key,
      new Error(`Invalid reminder record in storage: invalid "proactiveState" "${String(item.proactiveState)}" on reminder ${item.id}`)
    );
  }

  if (item.proactiveEventId !== undefined && typeof item.proactiveEventId !== 'string') {
    throw new PersistenceError(
      key,
      new Error(`Invalid reminder record in storage: "proactiveEventId" must be a string on reminder ${item.id}`)
    );
  }

  if (item.proactiveHandledAt !== undefined && !isFiniteNumber(item.proactiveHandledAt)) {
    throw new PersistenceError(
      key,
      new Error(`Invalid reminder record in storage: "proactiveHandledAt" must be a finite number on reminder ${item.id}`)
    );
  }

  if (item.proactiveMessageId !== undefined && typeof item.proactiveMessageId !== 'string') {
    throw new PersistenceError(
      key,
      new Error(`Invalid reminder record in storage: "proactiveMessageId" must be a string on reminder ${item.id}`)
    );
  }

  const result: FirestoreReminder = {
    id: item.id,
    userId: item.userId,
    title: item.title,
    notes: item.notes,
    dueAt: item.dueAt,
    createdAt: item.createdAt,
    updatedAt: item.updatedAt,
    reminderState: item.reminderState,
    notificationState: item.notificationState,
    ...(item.legacyFiredAt !== undefined ? { legacyFiredAt: item.legacyFiredAt } : {}),
    ...(item.proactiveState !== undefined ? { proactiveState: item.proactiveState } : {}),
    ...(item.proactiveEventId !== undefined ? { proactiveEventId: item.proactiveEventId } : {}),
    ...(item.proactiveHandledAt !== undefined ? { proactiveHandledAt: item.proactiveHandledAt } : {}),
    ...(item.proactiveMessageId !== undefined ? { proactiveMessageId: item.proactiveMessageId } : {}),
  };

  return result;
}

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
    const safeUid = userId ? userId.trim() : 'local-user';
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
    for (const rawItem of list) {
      const reminder = validateAndParseReminder(rawItem, safeUid, key);
      if (map.has(reminder.id)) {
        throw new PersistenceError(key, new Error(`Duplicate reminder ID in storage: "${reminder.id}"`));
      }
      map.set(reminder.id, reminder);
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
    await withCrossContextLock(this.storageKey(effectiveUserId), async () => {
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
    });
  }

  async updateReminder(userId: string, reminderId: string, patch: Partial<FirestoreReminder>): Promise<void> {
    if (this.shouldFail) throw new Error(this.failureError);
    const effectiveUserId = userId || 'local-user';
    await withCrossContextLock(this.storageKey(effectiveUserId), async () => {
      const map = this.load(effectiveUserId);
      const existing = map.get(reminderId);
      if (!existing) {
        throw new Error(`Reminder not found: ${reminderId}`);
      }
      if (patch.notificationState === 'claimed' && existing.notificationState && existing.notificationState !== 'pending') {
        throw new Error('Claim conflict: already claimed');
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
    });
  }

  async deleteReminder(userId: string, reminderId: string): Promise<void> {
    if (this.shouldFail) throw new Error(this.failureError);
    const effectiveUserId = userId || 'local-user';
    await withCrossContextLock(this.storageKey(effectiveUserId), async () => {
      const map = this.load(effectiveUserId);
      if (!map.has(reminderId)) return;
      const nextMap = new Map(map);
      nextMap.delete(reminderId);
      this.save(effectiveUserId, nextMap);
      this.store.delete(reminderId);
    });
  }

  async clear(): Promise<void> {
    await withCrossContextLock(STORAGE_PREFIX, async () => {
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
    });
  }

  async replaceReminders(userId: string, reminders: FirestoreReminder[]): Promise<void> {
    if (this.shouldFail) throw new Error(this.failureError);
    const effectiveUserId = userId || 'local-user';
    await withCrossContextLock(this.storageKey(effectiveUserId), async () => {
      const nextMap = new Map<string, FirestoreReminder>();
      for (const r of reminders) {
        nextMap.set(r.id, {
          ...r,
          userId: effectiveUserId,
          updatedAt: Date.now(),
        });
      }
      this.save(effectiveUserId, nextMap);
      // Update in-memory store for matching userId
      for (const [id, r] of this.store.entries()) {
        if (r.userId === effectiveUserId) {
          this.store.delete(id);
        }
      }
      for (const [id, r] of nextMap.entries()) {
        this.store.set(id, r);
      }
    });
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
    await withCrossContextLock(`alpha_inmem_reminder_${userId}`, async () => {
      this.store.set(this.key(userId, reminder.id), { ...reminder });
    });
  }

  override async updateReminder(userId: string, reminderId: string, patch: Partial<FirestoreReminder>): Promise<void> {
    if (this.shouldFail) throw new Error(this.failureError);
    await withCrossContextLock(`alpha_inmem_reminder_${userId}`, async () => {
      const k = this.key(userId, reminderId);
      const r = this.store.get(k);
      if (!r || r.userId !== userId) throw new Error('Reminder not found');
      if (patch.notificationState === 'claimed' && r.notificationState && r.notificationState !== 'pending') {
        throw new Error('Claim conflict: already claimed');
      }
      this.store.set(k, { ...r, ...patch, updatedAt: Date.now() });
    });
  }

  override async deleteReminder(userId: string, reminderId: string): Promise<void> {
    if (this.shouldFail) throw new Error(this.failureError);
    await withCrossContextLock(`alpha_inmem_reminder_${userId}`, async () => {
      this.store.delete(this.key(userId, reminderId));
    });
  }

  override async replaceReminders(userId: string, reminders: FirestoreReminder[]): Promise<void> {
    if (this.shouldFail) throw new Error(this.failureError);
    await withCrossContextLock(`alpha_inmem_reminder_${userId}`, async () => {
      // Clear existing for this user
      const keysToRemove: string[] = [];
      for (const [k, v] of this.store.entries()) {
        if (v.userId === userId) {
          keysToRemove.push(k);
        }
      }
      for (const k of keysToRemove) {
        this.store.delete(k);
      }
      // Add new ones
      for (const r of reminders) {
        this.store.set(this.key(userId, r.id), { ...r, userId });
      }
    });
  }

  override async clear(): Promise<void> {
    this.store.clear();
  }
}

/**
 * Backward compatibility alias: FirestoreReminderRepository redirects to LocalReminderRepository.
 * Reminders are strictly local-first and do not persist to Firestore.
 */
export const FirestoreReminderRepository = LocalReminderRepository;
