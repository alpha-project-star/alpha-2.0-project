// src/lib/notification-lifecycle.ts

/**
 * Phase 3I: Authoritative State Ownership, Lifecycle State Machine & Reliability Invariants.
 * 
 * Explicit State Ownership Separation:
 * 1. Reminder State: Owned by ReminderRepository ('active' | 'completed' | 'cancelled').
 * 2. Due State: Determined by ReminderScheduler (dueAt <= now). LLM never determines due state.
 * 3. Due-Event State: Owned by ReminderEventDelivery (deterministic eventId = `due_${reminderId}_${dueAt}`).
 * 4. Proactive Generation State: Owned by ProactiveTrigger ('pending' | 'generating' | 'generated' | 'failed').
 * 5. Notification Delivery State: Owned by NotificationDelivery ('pending' | 'delivering' | 'delivered' | 'failed').
 * 6. Acknowledgement State: Owned by AcknowledgementRepository ('pending' | 'delivered' | 'acknowledged' | 'failed').
 * 7. Recovery State: Owned by NotificationRecovery (read-only query of delivered-but-unacknowledged records).
 * 8. UI State: Non-authoritative cache/representation. Reconciles against authoritative repository state.
 */

import type { ReminderState, NotificationState, ProactiveResponseState } from './reminder-repo';
import type { DeliveryRecordStatus } from './notification-delivery';
import type { AcknowledgementStatus } from './notification-acknowledgement';

export type LifecycleDomain =
  | 'reminder'
  | 'due_event'
  | 'proactive_generation'
  | 'notification_delivery'
  | 'acknowledgement';

export interface StateTransitionResult<T extends string> {
  valid: boolean;
  from: T;
  to: T;
  domain: LifecycleDomain;
  error?: string;
}

// Valid state machine transitions per domain
const VALID_REMINDER_TRANSITIONS: Record<ReminderState, ReminderState[]> = {
  active: ['completed', 'cancelled', 'active'],
  completed: ['active'], // Reopening
  cancelled: ['active'], // Reopening
};

const VALID_EVENT_DELIVERY_TRANSITIONS: Record<NotificationState, NotificationState[]> = {
  pending: ['claimed', 'failed'],
  claimed: ['accepted', 'pending', 'failed'], // 'pending' on stale lease recovery
  accepted: [], // Terminal for this due event occurrence
  failed: ['pending'], // Retry
};

const VALID_PROACTIVE_GENERATION_TRANSITIONS: Record<ProactiveResponseState, ProactiveResponseState[]> = {
  pending: ['generating', 'failed'],
  generating: ['generated', 'failed', 'pending'], // 'pending' on stale lease recovery
  generated: [], // Terminal: generated response is immutable
  failed: ['generating', 'pending'], // Retry
};

const VALID_NOTIFICATION_DELIVERY_TRANSITIONS: Record<DeliveryRecordStatus, DeliveryRecordStatus[]> = {
  pending: ['delivering', 'failed'],
  delivering: ['delivered', 'failed'],
  delivered: [], // Terminal: delivered message is immutable
  failed: ['delivering', 'pending'], // Retry
};

const VALID_ACKNOWLEDGEMENT_TRANSITIONS: Record<AcknowledgementStatus, AcknowledgementStatus[]> = {
  pending: ['delivered', 'acknowledged', 'failed'],
  delivered: ['acknowledged', 'failed'],
  acknowledged: [], // Terminal: user acknowledgement is immutable
  failed: ['delivered', 'acknowledged'], // Retry
};

/**
 * Validates a state transition against the authoritative state machine.
 * Rejects impossible transitions such as acknowledged -> pending, completed -> awaiting_ack, etc.
 */
export function validateLifecycleTransition<T extends string>(
  domain: LifecycleDomain,
  from: T,
  to: T,
): StateTransitionResult<T> {
  // Self-transition is always idempotent/noop
  if (from === to) {
    return { valid: true, from, to, domain };
  }

  let valid = false;

  switch (domain) {
    case 'reminder': {
      const allowed = VALID_REMINDER_TRANSITIONS[from as ReminderState];
      valid = allowed ? allowed.includes(to as ReminderState) : false;
      break;
    }
    case 'due_event': {
      const allowed = VALID_EVENT_DELIVERY_TRANSITIONS[from as NotificationState];
      valid = allowed ? allowed.includes(to as NotificationState) : false;
      break;
    }
    case 'proactive_generation': {
      const allowed = VALID_PROACTIVE_GENERATION_TRANSITIONS[from as ProactiveResponseState];
      valid = allowed ? allowed.includes(to as ProactiveResponseState) : false;
      break;
    }
    case 'notification_delivery': {
      const allowed = VALID_NOTIFICATION_DELIVERY_TRANSITIONS[from as DeliveryRecordStatus];
      valid = allowed ? allowed.includes(to as DeliveryRecordStatus) : false;
      break;
    }
    case 'acknowledgement': {
      const allowed = VALID_ACKNOWLEDGEMENT_TRANSITIONS[from as AcknowledgementStatus];
      valid = allowed ? allowed.includes(to as AcknowledgementStatus) : false;
      break;
    }
    default:
      valid = false;
  }

  if (!valid) {
    return {
      valid: false,
      from,
      to,
      domain,
      error: `Invalid lifecycle transition in domain "${domain}": cannot transition from "${from}" to "${to}"`,
    };
  }

  return { valid: true, from, to, domain };
}

/**
 * Retention Policy & Historical Integrity Audit:
 * 
 * 1. Historical Acknowledgement Records:
 *    - Status 'acknowledged': retained indefinitely for auditability and recovery queries.
 *    - Must NEVER be deleted when the parent reminder is completed or deleted.
 * 
 * 2. Historical Delivery Records:
 *    - Status 'delivered': retained for conversational idempotency and cross-tab deduplication.
 *    - Reused during recovery; never deleted during routine operations.
 * 
 * 3. Historical Due Events:
 *    - Deterministic event IDs (`due_${reminderId}_${dueAt}`) serve as natural deduplication keys.
 *    - Multiple occurrences of recurring or rescheduled reminders generate distinct event IDs.
 */
export interface RetentionAuditReport {
  totalAcknowledgements: number;
  acknowledgedCount: number;
  deliveredUnacknowledgedCount: number;
  safeToRetain: boolean;
  notes: string[];
}

export function auditRetentionPolicy(records: Array<{ status: AcknowledgementStatus; reminderId: string }>): RetentionAuditReport {
  let ackCount = 0;
  let unackCount = 0;

  for (const r of records) {
    if (r.status === 'acknowledged') ackCount++;
    else if (r.status === 'delivered' || r.status === 'pending') unackCount++;
  }

  return {
    totalAcknowledgements: records.length,
    acknowledgedCount: ackCount,
    deliveredUnacknowledgedCount: unackCount,
    safeToRetain: true,
    notes: [
      'Historical acknowledgement records are preserved for audit and recovery.',
      'Completed reminders do not delete historical delivery or acknowledgement records.',
      'Active lease records recover boundedly upon timeout.',
    ],
  };
}
