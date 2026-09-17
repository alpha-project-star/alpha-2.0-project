// src/lib/reminder-events.ts

import { z } from 'zod';

/**
 * Authoritative schema for a reminder-due event.
 * Represents the immutable application-level fact:
 * "Reminder X became due for authenticated user Y at time Z."
 */
export const ReminderDueEventSchema = z.object({
  type: z.literal('reminder_due'),
  eventId: z.string().min(1, 'eventId is required'),
  reminderId: z.string().min(1, 'reminderId is required'),
  userId: z.string().min(1, 'userId is required'),
  dueAt: z.number().finite().positive('dueAt must be a valid positive timestamp'),
  detectedAt: z.number().finite().positive('detectedAt must be a valid positive timestamp'),
  title: z.string().default(''),
});

export type ReminderDueEvent = z.infer<typeof ReminderDueEventSchema>;

/**
 * Result of validating an incoming event payload.
 */
export type EventValidationResult = 
  | { success: true; event: ReminderDueEvent }
  | { success: false; error: string; details?: z.ZodError };

/**
 * Validates an incoming object against the canonical ReminderDueEventSchema.
 */
export function validateReminderDueEvent(data: unknown): EventValidationResult {
  if (!data || typeof data !== 'object') {
    return { success: false, error: 'Event payload must be a non-null object' };
  }

  const result = ReminderDueEventSchema.safeParse(data);
  if (!result.success) {
    const issues = result.error.issues.map(i => `${i.path.join('.')}: ${i.message}`).join(', ');
    return { success: false, error: `Invalid reminder_due event: ${issues}`, details: result.error };
  }

  return { success: true, event: result.data };
}

/**
 * Generates a deterministic, unique, and stable eventId for a reminder due occurrence.
 * Ensures identical event identity across racing tabs and process restarts.
 */
export function generateReminderEventId(reminderId: string, dueAt: number): string {
  if (!reminderId || typeof dueAt !== 'number' || isNaN(dueAt)) {
    throw new Error('Valid reminderId and numeric dueAt are required to generate eventId');
  }
  return `due_${reminderId}_${dueAt}`;
}
