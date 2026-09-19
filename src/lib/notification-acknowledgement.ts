import { doc, getDoc, setDoc, updateDoc, collection, getDocs } from 'firebase/firestore';
import { db } from './firebase';
import { reminderContextManager, ActiveReminderContext } from './reminder-context';

export type AcknowledgementStatus = 'pending' | 'delivered' | 'acknowledged' | 'failed';

export type AcknowledgementChannel = 'in_app' | 'push' | 'browser' | 'tts';

export type AcknowledgementErrorCode =
  | 'UNAUTHENTICATED'
  | 'USER_MISMATCH'
  | 'INVALID_INPUT'
  | 'NOT_FOUND'
  | 'AMBIGUOUS_TARGET'
  | 'NOT_ACKNOWLEDGEMENT'
  | 'PERSISTENCE_FAILURE'
  | 'CONCURRENCY_CONFLICT'
  | 'UNSUPPORTED_CHANNEL';

export interface AcknowledgementRecord {
  ackId: string;
  eventId: string;
  reminderId: string;
  userId: string;
  channel: AcknowledgementChannel;
  status: AcknowledgementStatus;
  deliveredAt?: number;
  acknowledgedAt?: number;
  userConfirmationText?: string;
  title?: string;
  dueAt?: number;
  createdAt: number;
  updatedAt: number;
  version?: number;
}

export function generateAcknowledgementId(eventId: string, channel: string = 'in_app'): string {
  if (!eventId || typeof eventId !== 'string') {
    throw new Error('Event ID is required to generate acknowledgement ID');
  }
  return `${eventId.trim()}:${(channel || 'in_app').trim()}:ack`;
}

export interface AcknowledgementRepository {
  getAcknowledgement(userId: string, ackId: string): Promise<AcknowledgementRecord | null>;
  saveAcknowledgement(userId: string, record: AcknowledgementRecord): Promise<void>;
  updateAcknowledgement(userId: string, ackId: string, patch: Partial<AcknowledgementRecord>): Promise<void>;
  listAcknowledgements(userId: string): Promise<AcknowledgementRecord[]>;
  getAcknowledgementByEventId(userId: string, eventId: string): Promise<AcknowledgementRecord | null>;
}

export class InMemoryAcknowledgementRepository implements AcknowledgementRepository {
  private store = new Map<string, AcknowledgementRecord>();
  public shouldFail = false;
  public failureError = 'Simulated acknowledgement persistence failure';

  private key(userId: string, ackId: string): string {
    return `${userId}:${ackId}`;
  }

  async getAcknowledgement(userId: string, ackId: string): Promise<AcknowledgementRecord | null> {
    if (this.shouldFail) throw new Error(this.failureError);
    const item = this.store.get(this.key(userId, ackId));
    return item ? { ...item } : null;
  }

  async saveAcknowledgement(userId: string, record: AcknowledgementRecord): Promise<void> {
    if (this.shouldFail) throw new Error(this.failureError);
    if (record.userId !== userId) throw new Error('User isolation mismatch on acknowledgement save');
    this.store.set(this.key(userId, record.ackId), { ...record });
  }

  async updateAcknowledgement(
    userId: string,
    ackId: string,
    patch: Partial<AcknowledgementRecord>,
  ): Promise<void> {
    if (this.shouldFail) throw new Error(this.failureError);
    const k = this.key(userId, ackId);
    const item = this.store.get(k);
    if (!item) throw new Error(`Acknowledgement record not found: ${ackId}`);
    if (item.userId !== userId) throw new Error('User isolation mismatch on acknowledgement update');
    this.store.set(k, { ...item, ...patch, updatedAt: Date.now() });
  }

  async listAcknowledgements(userId: string): Promise<AcknowledgementRecord[]> {
    if (this.shouldFail) throw new Error(this.failureError);
    const prefix = `${userId}:`;
    const results: AcknowledgementRecord[] = [];
    for (const [k, v] of this.store.entries()) {
      if (k.startsWith(prefix)) {
        results.push({ ...v });
      }
    }
    return results;
  }

  async getAcknowledgementByEventId(
    userId: string,
    eventId: string,
  ): Promise<AcknowledgementRecord | null> {
    if (this.shouldFail) throw new Error(this.failureError);
    const list = await this.listAcknowledgements(userId);
    const found = list.find((a) => a.eventId === eventId);
    return found ? { ...found } : null;
  }

  findAcknowledgementGlobally(id: string): AcknowledgementRecord | null {
    if (this.shouldFail) throw new Error(this.failureError);
    for (const v of this.store.values()) {
      if (v.ackId === id || v.eventId === id || v.reminderId === id) {
        return { ...v };
      }
    }
    return null;
  }

  clear(): void {
    this.store.clear();
  }
}

export class FirestoreAcknowledgementRepository implements AcknowledgementRepository {
  private getDb() {
    return db;
  }

  async getAcknowledgement(userId: string, ackId: string): Promise<AcknowledgementRecord | null> {
    const db = this.getDb();
    if (!db) return null;
    const ref = doc(db, `users/${userId}/acknowledgements/${ackId}`);
    const snap = await getDoc(ref);
    if (!snap.exists()) return null;
    return snap.data() as AcknowledgementRecord;
  }

  async saveAcknowledgement(userId: string, record: AcknowledgementRecord): Promise<void> {
    const db = this.getDb();
    if (!db) return;
    const ref = doc(db, `users/${userId}/acknowledgements/${record.ackId}`);
    await setDoc(ref, record);
  }

  async updateAcknowledgement(
    userId: string,
    ackId: string,
    patch: Partial<AcknowledgementRecord>,
  ): Promise<void> {
    const db = this.getDb();
    if (!db) return;
    const ref = doc(db, `users/${userId}/acknowledgements/${ackId}`);
    await updateDoc(ref, { ...patch, updatedAt: Date.now() });
  }

  async listAcknowledgements(userId: string): Promise<AcknowledgementRecord[]> {
    const db = this.getDb();
    if (!db) return [];
    const col = collection(db, `users/${userId}/acknowledgements`);
    const snap = await getDocs(col);
    return snap.docs.map((d) => d.data() as AcknowledgementRecord);
  }

  async getAcknowledgementByEventId(
    userId: string,
    eventId: string,
  ): Promise<AcknowledgementRecord | null> {
    const list = await this.listAcknowledgements(userId);
    return list.find((a) => a.eventId === eventId) || null;
  }
}

export interface AcknowledgeReminderInput {
  authenticatedUserId: string;
  ackId?: string;
  eventId?: string;
  reminderId?: string;
  channel?: AcknowledgementChannel;
  userConfirmationText?: string;
}

export interface AcknowledgementResultSuccess {
  success: true;
  status: 'acknowledged' | 'already_acknowledged';
  ackId: string;
  eventId: string;
  reminderId: string;
  record: AcknowledgementRecord;
  conversationalReply: string;
}

export interface AcknowledgementResultFailure {
  success: false;
  status?:
    | 'failed'
    | 'unauthenticated'
    | 'ambiguous_target'
    | 'not_acknowledgement'
    | 'user_mismatch'
    | 'invalid_input'
    | 'not_found'
    | 'concurrency_conflict'
    | 'persistence_failure';
  ackId?: string;
  eventId?: string;
  error: {
    code: AcknowledgementErrorCode;
    message: string;
    candidates?: Array<{ reminderId: string; title?: string; eventId?: string }>;
  };
}

export type AcknowledgementResult = AcknowledgementResultSuccess | AcknowledgementResultFailure;

export type UtteranceClassification =
  | { type: 'acknowledgement'; confidence: 'high' | 'medium'; explicitTarget?: string }
  | { type: 'completion'; target?: string }
  | { type: 'reschedule'; target?: string }
  | { type: 'inquiry'; query?: string }
  | { type: 'ambiguous'; reason: string }
  | { type: 'unrelated' };

/**
 * Conservative Natural Language Acknowledgement Classifier
 * Separates explicit acknowledgements from task completion, rescheduling, and general conversation.
 */
export function classifyAcknowledgementUtterance(
  rawText: string,
  options?: {
    activeReminder?: ActiveReminderContext | null;
    pendingCount?: number;
  },
): UtteranceClassification {
  if (!rawText || typeof rawText !== 'string') {
    return { type: 'unrelated' };
  }

  const text = rawText.trim();
  const lower = text.toLowerCase().replace(/[.,!?;:]/g, ' ').replace(/\s+/g, ' ').trim();

  if (!lower) {
    return { type: 'unrelated' };
  }

  // 1. Completion Intent Checks (MUST NOT be treated as acknowledgement)
  const completionPatterns = [
    /\b(?:mark|set)\s+(?:it|this|that|reminder)\s+(?:as\s+)?(?:done|complete|completed|finished)\b/,
    /\b(?:i(?:'ve|\s+have)?\s+(?:done|completed|finished)\s+(?:it|this|that|the))\b/,
    /\b(?:i(?:'ve|\s+have)?\s+done\s+it)\b/,
    /\b(?:i\s+finished\s+it)\b/,
    /\b(?:complete\s+(?:the\s+)?reminder|finish\s+(?:the\s+)?reminder|mark\s+done|mark\s+complete)\b/,
    /^(?:done|completed|finished)$/,
  ];
  if (completionPatterns.some((p) => p.test(lower))) {
    return { type: 'completion' };
  }

  // 2. Reschedule Intent Checks
  const reschedulePatterns = [
    /\b(?:remind\s+me\s+again|remind\s+me\s+later|snooze|reschedule|postpone|change\s+time)\b/,
    /\b(?:remind\s+me\s+(?:tomorrow|later|in\s+\d+|at\s+\d+))\b/,
  ];
  if (reschedulePatterns.some((p) => p.test(lower))) {
    return { type: 'reschedule' };
  }

  // 3. Questions / Inquiries specifically about Reminders
  const inquiryPatterns = [
    /\b(?:what\s+was\s+(?:that|the|my)\s+(?:reminder|alarm|notification)|what\s+reminder|which\s+reminder|when\s+is\s+(?:it|the\s+reminder)|when\s+was\s+(?:that|the\s+reminder)|tell\s+me\s+more\s+about\s+the\s+reminder)\b/,
    /^(?:what\s+reminder\??|which\s+reminder\??|when\s+is\s+it\??|what\s+was\s+(?:that|the\s+other\s+reminder)\??|what\s+was\s+the\s+other\s+reminder\s+again\??)$/,
  ];
  if (inquiryPatterns.some((p) => p.test(lower))) {
    return { type: 'inquiry' };
  }

  // 4. Natural Explicit Acknowledgement Confirmation Patterns
  const ackExactPatterns = [
    /^yes[, ]*i heard(?: you)?(?:[, ]*alpha)?$/,
    /^i heard(?: you)?(?:[, ]*alpha)?$/,
    /^i remember(?: that)?(?:[, ]*alpha)?$/,
    /^got it(?:[, ]*alpha)?$/,
    /^gotcha(?:[, ]*alpha)?$/,
    /^thanks(?:[, ]*alpha)?$/,
    /^thank you(?:[, ]*alpha)?$/,
    /^understood(?:[, ]*alpha)?$/,
    /^okay(?:[, ]*alpha)?$/,
    /^ok(?:[, ]*alpha)?$/,
    /^noted(?:[, ]*alpha)?$/,
    /^duly noted(?:[, ]*alpha)?$/,
    /^acknowledged(?:[, ]*alpha)?$/,
    /^sounds good(?:[, ]*alpha)?$/,
    /^alright[, ]*i'?ll do it(?:[, ]*alpha)?$/,
    /^okay[, ]*i'?ll handle it(?:[, ]*alpha)?$/,
    /^i'?ll handle it(?:[, ]*alpha)?$/,
    /^yes[, ]*i remember(?: that)?(?:[, ]*alpha)?$/,
    /^yes[, ]*got it(?:[, ]*alpha)?$/,
    /^yes[, ]*thanks(?:[, ]*alpha)?$/,
    /^yes[, ]*thank you(?:[, ]*alpha)?$/,
  ];

  const isExactAck = ackExactPatterns.some((p) => p.test(lower));
  if (isExactAck) {
    // Check if context is ambiguous (e.g. multiple pending and no active focus)
    if (!options?.activeReminder && (options?.pendingCount ?? 0) > 1) {
      return {
        type: 'ambiguous',
        reason: 'Multiple outstanding reminders are awaiting confirmation.',
      };
    }
    return { type: 'acknowledgement', confidence: 'high' };
  }

  // Check for explicit reminder mention in acknowledgement
  // Example: "I heard about the dentist", "Got the meeting reminder", "Thanks for the appointment reminder", "Got the electric bill reminder"
  const explicitAckMatch = lower.match(
    /^(?:yes[, ]*)?(?:i heard(?: you)?|got(?: it)?|thanks|thank you|i remember|noted|understood)(?:\s+(?:for|about|on|with|regarding))?\s+(?:the\s+)?(.+)$/,
  );
  if (explicitAckMatch && explicitAckMatch[1]) {
    const rawTarget = explicitAckMatch[1].replace(/\b(?:reminder|alpha)\b/g, '').trim();
    if (rawTarget.length > 1) {
      return {
        type: 'acknowledgement',
        confidence: 'high',
        explicitTarget: rawTarget,
      };
    }
  }

  // 5. Bare "yes" or "yeah" or "yep" — Ambiguous unless there is a single clear active reminder
  if (/^(?:yes|yeah|yep|yup|sure)$/.test(lower)) {
    if (options?.activeReminder) {
      return { type: 'acknowledgement', confidence: 'medium' };
    }
    return {
      type: 'ambiguous',
      reason: 'Bare confirmation without active reminder context is ambiguous.',
    };
  }

  return { type: 'unrelated' };
}

export function generateConversationalAcknowledgementReply(
  userText: string,
  record?: AcknowledgementRecord,
): string {
  const lower = (userText || '').toLowerCase();

  if (/thanks|thank you/.test(lower)) {
    return "You're welcome. The reminder is acknowledged, but not marked complete.";
  }
  if (/i remember/.test(lower)) {
    return 'Understood.';
  }
  if (/i heard/.test(lower)) {
    return "Good. I'll leave the reminder active until you tell me it's done.";
  }
  if (/i'?ll handle it|i'?ll do it/.test(lower)) {
    return "Sounds good. Let me know when you'd like to mark it done.";
  }
  if (/got it|gotcha|noted|understood/.test(lower)) {
    return "Understood. The reminder remains active until you're ready to complete it.";
  }
  if (/^ok\b|^okay\b/.test(lower)) {
    return 'Noted. The reminder remains active in your list.';
  }

  const reminderTitle = record?.title ? ` for "${record.title}"` : '';
  return `Acknowledged. The notification${reminderTitle} has been confirmed, and the reminder remains active until completed.`;
}

export interface NotificationAcknowledgementManagerOptions {
  repo?: AcknowledgementRepository;
}

export class NotificationAcknowledgementManager {
  private repo: AcknowledgementRepository;
  private inFlightAcks = new Set<string>();
  private inFlightPromises = new Map<string, Promise<AcknowledgementResult>>();
  private listeners = new Set<(record: AcknowledgementRecord) => void>();

  constructor(options: NotificationAcknowledgementManagerOptions = {}) {
    this.repo = options.repo || new InMemoryAcknowledgementRepository();
  }

  public subscribe(listener: (record: AcknowledgementRecord) => void): () => void {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }

  private notify(record: AcknowledgementRecord): void {
    for (const listener of this.listeners) {
      try {
        listener(record);
      } catch {
        // Safe isolation for listener errors
      }
    }
  }

  public setRepository(repo: AcknowledgementRepository): void {
    this.repo = repo;
  }

  public getRepository(): AcknowledgementRepository {
    return this.repo;
  }

  /**
   * Called when a reminder event is delivered to the user in-app (e.g. from Phase 3E delivery).
   * Creates or updates a durable acknowledgement record in 'delivered' state.
   */
  public async recordDelivery(input: {
    authenticatedUserId: string;
    eventId: string;
    reminderId: string;
    channel?: AcknowledgementChannel;
    title?: string;
    dueAt?: number;
  }): Promise<AcknowledgementRecord> {
    const { authenticatedUserId, eventId, reminderId, channel = 'in_app', title, dueAt } = input;

    if (!authenticatedUserId || typeof authenticatedUserId !== 'string' || !authenticatedUserId.trim()) {
      throw new Error('Authenticated user ID is required to record delivery');
    }
    if (!eventId || typeof eventId !== 'string' || !eventId.trim()) {
      throw new Error('Event ID is required to record delivery');
    }
    if (!reminderId || typeof reminderId !== 'string' || !reminderId.trim()) {
      throw new Error('Reminder ID is required to record delivery');
    }

    const userId = authenticatedUserId.trim();
    const ackId = generateAcknowledgementId(eventId, channel);
    const existing = await this.repo.getAcknowledgement(userId, ackId);

    if (existing) {
      if (existing.status === 'acknowledged') {
        return existing;
      }
      const updated: AcknowledgementRecord = {
        ...existing,
        status: 'delivered',
        deliveredAt: Date.now(),
        updatedAt: Date.now(),
      };
      await this.repo.updateAcknowledgement(userId, ackId, updated);
      this.notify(updated);
      return updated;
    }

    const newRecord: AcknowledgementRecord = {
      ackId,
      eventId: eventId.trim(),
      reminderId: reminderId.trim(),
      userId,
      channel,
      status: 'delivered',
      deliveredAt: Date.now(),
      title,
      dueAt,
      createdAt: Date.now(),
      updatedAt: Date.now(),
      version: 1,
    };

    await this.repo.saveAcknowledgement(userId, newRecord);
    this.notify(newRecord);
    return newRecord;
  }

  /**
   * Authoritatively acknowledges a delivered reminder event for an authenticated user.
   */
  public async acknowledgeReminder(
    input: AcknowledgeReminderInput,
  ): Promise<AcknowledgementResult> {
    const rawAuth = input?.authenticatedUserId;
    if (!rawAuth || typeof rawAuth !== 'string' || !rawAuth.trim()) {
      return {
        success: false,
        status: 'unauthenticated',
        error: {
          code: 'UNAUTHENTICATED',
          message: 'Authenticated user ID is required for notification acknowledgement',
        },
      };
    }
    const userId = rawAuth.trim();

    const channel: AcknowledgementChannel = input.channel || 'in_app';
    const supportedChannels: AcknowledgementChannel[] = ['in_app', 'push', 'browser', 'tts'];
    if (!supportedChannels.includes(channel)) {
      return {
        success: false,
        status: 'invalid_input',
        error: {
          code: 'UNSUPPORTED_CHANNEL',
          message: `Channel "${channel}" is not supported for acknowledgement`,
        },
      };
    }

    const cleanEventId = typeof input.eventId === 'string' ? input.eventId.trim() : '';
    const cleanReminderId = typeof input.reminderId === 'string' ? input.reminderId.trim() : '';
    const cleanAckId = typeof input.ackId === 'string' ? input.ackId.trim() : '';

    if (!cleanAckId && !cleanEventId && !cleanReminderId) {
      return {
        success: false,
        status: 'invalid_input',
        error: {
          code: 'INVALID_INPUT',
          message: 'At least one of ackId, eventId, or reminderId is required for acknowledgement',
        },
      };
    }

    let ackId = cleanAckId;
    const eventId = cleanEventId;

    if (!ackId && eventId) {
      ackId = generateAcknowledgementId(eventId, channel);
    }

    let record: AcknowledgementRecord | null = null;

    try {
      if (ackId) {
        record = await this.repo.getAcknowledgement(userId, ackId);
      } else if (cleanReminderId) {
        const all = await this.repo.listAcknowledgements(userId);
        record =
          all
            .filter((a) => a.reminderId === cleanReminderId)
            .sort((a, b) => b.createdAt - a.createdAt)[0] || null;
      }
    } catch (err: any) {
      return {
        success: false,
        status: 'persistence_failure',
        ackId,
        eventId,
        error: {
          code: 'PERSISTENCE_FAILURE',
          message: `Failed to read acknowledgement record: ${err?.message || err}`,
        },
      };
    }

    if (!record) {
      // Check if this record belongs to another user
      const globalFinder = (this.repo as any).findAcknowledgementGlobally;
      if (typeof globalFinder === 'function') {
        const otherUserRec = globalFinder.call(this.repo, ackId || eventId || cleanReminderId);
        if (otherUserRec && otherUserRec.userId !== userId) {
          return {
            success: false,
            status: 'user_mismatch',
            ackId: otherUserRec.ackId,
            eventId: otherUserRec.eventId,
            error: {
              code: 'USER_MISMATCH',
              message: 'Cross-user acknowledgement attempt was rejected',
            },
          };
        }
      }

      return {
        success: false,
        status: 'not_found',
        ackId,
        eventId,
        error: {
          code: 'NOT_FOUND',
          message: 'No delivered reminder notification found to acknowledge',
        },
      };
    }

    if (record.userId !== userId) {
      return {
        success: false,
        status: 'user_mismatch',
        ackId: record.ackId,
        eventId: record.eventId,
        error: {
          code: 'USER_MISMATCH',
          message: 'Cross-user acknowledgement attempt was rejected',
        },
      };
    }

    // Idempotency: If already acknowledged, return idempotent success
    if (record.status === 'acknowledged') {
      const conversationalReply = generateConversationalAcknowledgementReply(
        input.userConfirmationText || 'acknowledged',
        record,
      );
      return {
        success: true,
        status: 'already_acknowledged',
        ackId: record.ackId,
        eventId: record.eventId,
        reminderId: record.reminderId,
        record,
        conversationalReply,
      };
    }

    // Concurrency / In-Flight Locking
    const lockKey = `${userId}:${record.ackId}`;
    if (this.inFlightAcks.has(lockKey)) {
      return {
        success: false,
        status: 'concurrency_conflict',
        ackId: record.ackId,
        eventId: record.eventId,
        error: {
          code: 'CONCURRENCY_CONFLICT',
          message: 'An acknowledgement is already in progress for this reminder event',
        },
      };
    }

    this.inFlightAcks.add(lockKey);

    try {
      const updatedRecord: AcknowledgementRecord = {
        ...record,
        status: 'acknowledged',
        acknowledgedAt: Date.now(),
        userConfirmationText: input.userConfirmationText || record.userConfirmationText,
        updatedAt: Date.now(),
        version: (record.version || 1) + 1,
      };

      await this.repo.saveAcknowledgement(userId, updatedRecord);
      this.notify(updatedRecord);

      const conversationalReply = generateConversationalAcknowledgementReply(
        input.userConfirmationText || '',
        updatedRecord,
      );

      return {
        success: true,
        status: 'acknowledged',
        ackId: updatedRecord.ackId,
        eventId: updatedRecord.eventId,
        reminderId: updatedRecord.reminderId,
        record: updatedRecord,
        conversationalReply,
      };
    } catch (err: any) {
      return {
        success: false,
        status: 'persistence_failure',
        ackId: record.ackId,
        eventId: record.eventId,
        error: {
          code: 'PERSISTENCE_FAILURE',
          message: `Failed to persist acknowledgement: ${err?.message || err}`,
        },
      };
    } finally {
      this.inFlightAcks.delete(lockKey);
    }
  }

  /**
   * Processes a natural conversational utterance from the user.
   * Resolves target via active context or explicit mentions.
   */
  public async acknowledgeFromUserUtterance(
    userId: string,
    userText: string,
  ): Promise<AcknowledgementResult> {
    if (!userId || typeof userId !== 'string' || !userId.trim()) {
      return {
        success: false,
        status: 'unauthenticated',
        error: {
          code: 'UNAUTHENTICATED',
          message: 'Authenticated user ID is required for acknowledgement',
        },
      };
    }
    const cleanUserId = userId.trim();

    // 1. Fetch pending/delivered unacknowledged records for this user
    let unacknowledged: AcknowledgementRecord[] = [];
    try {
      const all = await this.repo.listAcknowledgements(cleanUserId);
      unacknowledged = all.filter((a) => a.status === 'delivered' || a.status === 'pending');
    } catch (err: any) {
      return {
        success: false,
        status: 'persistence_failure',
        error: {
          code: 'PERSISTENCE_FAILURE',
          message: `Failed to retrieve user acknowledgement records: ${err?.message || err}`,
        },
      };
    }

    const activeCtx = reminderContextManager.getContext(cleanUserId);

    // 2. Classify utterance
    const classification = classifyAcknowledgementUtterance(userText, {
      activeReminder: activeCtx,
      pendingCount: unacknowledged.length,
    });

    if (classification.type !== 'acknowledgement') {
      if (classification.type === 'ambiguous') {
        const candidates = unacknowledged.map((u) => ({
          reminderId: u.reminderId,
          title: u.title,
          eventId: u.eventId,
        }));
        return {
          success: false,
          status: 'ambiguous_target',
          error: {
            code: 'AMBIGUOUS_TARGET',
            message: classification.reason,
            candidates,
          },
        };
      }

      return {
        success: false,
        status: 'not_acknowledgement',
        error: {
          code: 'NOT_ACKNOWLEDGEMENT',
          message: `Utterance is classified as ${classification.type}`,
        },
      };
    }

    // 3. Resolve Target Record
    let target: AcknowledgementRecord | null = null;

    // Explicit mention in user utterance takes precedence
    if (classification.explicitTarget) {
      const q = classification.explicitTarget.toLowerCase();
      target =
        unacknowledged.find(
          (u) =>
            (u.title && u.title.toLowerCase().includes(q)) ||
            (u.reminderId && u.reminderId.toLowerCase().includes(q)),
        ) || null;

      if (!target && activeCtx && activeCtx.title.toLowerCase().includes(q)) {
        target = unacknowledged.find((u) => u.reminderId === activeCtx.id) || null;
      }
    }

    // If no explicit match, fallback to active context
    if (!target && activeCtx) {
      target = unacknowledged.find((u) => u.reminderId === activeCtx.id) || null;
    }

    // If no active context, but exactly one unacknowledged record exists, use that
    if (!target && unacknowledged.length === 1) {
      target = unacknowledged[0];
    }

    // If multiple unacknowledged exist and cannot resolve unambiguously
    if (!target && unacknowledged.length > 1) {
      const candidates = unacknowledged.map((u) => ({
        reminderId: u.reminderId,
        title: u.title,
        eventId: u.eventId,
      }));
      return {
        success: false,
        status: 'ambiguous_target',
        error: {
          code: 'AMBIGUOUS_TARGET',
          message: 'Multiple unacknowledged reminders are pending. Please specify which one.',
          candidates,
        },
      };
    }

    if (!target) {
      return {
        success: false,
        status: 'not_found',
        error: {
          code: 'NOT_FOUND',
          message: 'No pending reminder notifications found to acknowledge',
        },
      };
    }

    // 4. Perform durable acknowledgement
    return this.acknowledgeReminder({
      authenticatedUserId: cleanUserId,
      ackId: target.ackId,
      eventId: target.eventId,
      reminderId: target.reminderId,
      channel: target.channel,
      userConfirmationText: userText,
    });
  }

  public async getPendingAcknowledgements(userId: string): Promise<AcknowledgementRecord[]> {
    if (!userId) return [];
    try {
      const all = await this.repo.listAcknowledgements(userId);
      return all.filter((a) => a.status === 'delivered' || a.status === 'pending');
    } catch {
      return [];
    }
  }

  public async getAcknowledgementStatus(
    userId: string,
    eventId: string,
  ): Promise<AcknowledgementStatus | null> {
    if (!userId || !eventId) return null;
    try {
      const record = await this.repo.getAcknowledgementByEventId(userId, eventId);
      return record ? record.status : null;
    } catch {
      return null;
    }
  }

  public clearUserContext(userId: string): void {
    if (!userId) return;
    const prefix = `${userId}:`;
    for (const key of this.inFlightAcks) {
      if (key.startsWith(prefix)) {
        this.inFlightAcks.delete(key);
      }
    }
  }

  public reset(): void {
    this.inFlightAcks.clear();
    if (this.repo instanceof InMemoryAcknowledgementRepository) {
      this.repo.clear();
    }
  }
}

export const notificationAcknowledgementManager = new NotificationAcknowledgementManager();
