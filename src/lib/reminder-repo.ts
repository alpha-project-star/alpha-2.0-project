/**
 * ============================================================================
 * ARCHITECTURAL AUTHORITY DECLARATION — AL-02 RECONCILIATION
 * ============================================================================
 * ROLE: Durable Reminder Persistence Authority
 * AUTHORITATIVE SYMBOL: ReminderRepository (FirestoreReminderRepository)
 *
 * RESPONSIBILITIES:
 *  - Serves as the canonical, durable database persistence authority for reminders
 *    and proactive notification states on Firestore.
 *  - Handles queries, insertions, updates, and deletions directly with Firestore.
 *  - Preserves historic, legacy, and proactive reminder event states.
 *
 * NOT RESPONSIBLE FOR:
 *  - Conversational reminder context or active focus tracking (owned by `src/lib/reminder-context.ts`).
 *  - In-memory application state management or execution schemas (owned by `src/lib/alpha-store.ts` and `src/lib/execution.ts`).
 * ============================================================================
 */

import { 
  collection, 
  doc, 
  setDoc, 
  getDoc, 
  getDocs, 
  query, 
  where,
  updateDoc,
  deleteDoc
} from 'firebase/firestore';
import { db } from './firebase';

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

export interface ReminderRepository {
  listReminders(userId: string): Promise<FirestoreReminder[]>;
  getReminder(userId: string, reminderId: string): Promise<FirestoreReminder | null>;
  createReminder(userId: string, reminder: FirestoreReminder): Promise<void>;
  updateReminder(userId: string, reminderId: string, patch: Partial<FirestoreReminder>): Promise<void>;
  deleteReminder(userId: string, reminderId: string): Promise<void>;
}

export class FirestoreReminderRepository implements ReminderRepository {
  private getCollection(userId: string) {
    if (!userId) throw new Error("userId is required for repository access");
    return collection(db, 'users', userId, 'reminders');
  }

  private getDocRef(userId: string, reminderId: string) {
    if (!userId || !reminderId) throw new Error("userId and reminderId are required");
    return doc(db, 'users', userId, 'reminders', reminderId);
  }

  async listReminders(userId: string): Promise<FirestoreReminder[]> {
    const q = query(this.getCollection(userId));
    const snapshot = await getDocs(q);
    return snapshot.docs.map(doc => doc.data() as FirestoreReminder);
  }

  async getReminder(userId: string, reminderId: string): Promise<FirestoreReminder | null> {
    const docRef = this.getDocRef(userId, reminderId);
    const docSnap = await getDoc(docRef);
    if (docSnap.exists()) {
      return docSnap.data() as FirestoreReminder;
    }
    return null;
  }

  async createReminder(userId: string, reminder: FirestoreReminder): Promise<void> {
    if (reminder.userId !== userId) throw new Error("User ID mismatch");
    const docRef = this.getDocRef(userId, reminder.id);
    await setDoc(docRef, reminder);
  }

  async updateReminder(userId: string, reminderId: string, patch: Partial<FirestoreReminder>): Promise<void> {
    const docRef = this.getDocRef(userId, reminderId);
    await updateDoc(docRef, patch);
  }

  async deleteReminder(userId: string, reminderId: string): Promise<void> {
    const docRef = this.getDocRef(userId, reminderId);
    await deleteDoc(docRef);
  }
}

export class InMemoryReminderRepository implements ReminderRepository {
  public store = new Map<string, FirestoreReminder>();
  public shouldFail = false;
  public failureError = 'Simulated reminder persistence failure';

  private key(userId: string, reminderId: string): string {
    return `${userId}:${reminderId}`;
  }

  async listReminders(userId: string): Promise<FirestoreReminder[]> {
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

  async getReminder(userId: string, reminderId: string): Promise<FirestoreReminder | null> {
    if (this.shouldFail) throw new Error(this.failureError);
    const r = this.store.get(this.key(userId, reminderId));
    if (!r || r.userId !== userId) return null;
    return { ...r };
  }

  async createReminder(userId: string, reminder: FirestoreReminder): Promise<void> {
    if (this.shouldFail) throw new Error(this.failureError);
    if (reminder.userId !== userId) throw new Error("User ID mismatch");
    this.store.set(this.key(userId, reminder.id), { ...reminder });
  }

  async updateReminder(userId: string, reminderId: string, patch: Partial<FirestoreReminder>): Promise<void> {
    if (this.shouldFail) throw new Error(this.failureError);
    const k = this.key(userId, reminderId);
    const r = this.store.get(k);
    if (!r || r.userId !== userId) throw new Error('Reminder not found');
    if (patch.notificationState === 'claimed' && r.notificationState && r.notificationState !== 'pending') {
      throw new Error('Transaction conflict: already claimed');
    }
    this.store.set(k, { ...r, ...patch, updatedAt: Date.now() });
  }

  async deleteReminder(userId: string, reminderId: string): Promise<void> {
    if (this.shouldFail) throw new Error(this.failureError);
    this.store.delete(this.key(userId, reminderId));
  }

  clear(): void {
    this.store.clear();
  }
}
