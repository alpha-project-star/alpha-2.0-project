// src/lib/migration-dry-run.ts
import { Reminder, AlphaState } from "./alpha-store";
import { FirestoreReminder } from "./reminder-repo";
import { MigrationValidator } from "./migration-contract";

export interface PreviewReminder extends FirestoreReminder {
  error?: string;
  classification: 'valid' | 'blocked' | 'conflict' | 'already-migrated';
}

export function performDryRun(
  state: AlphaState, 
  authUid: string, 
  timestamp: number,
  existingIds: Set<string> = new Set()
) {
  const validator = new MigrationValidator(existingIds);
  const report = validator.validate(state.reminders, authUid, timestamp);

  const previewResults: PreviewReminder[] = [
    ...report.valid.map(r => ({ ...r, classification: 'valid' as const })),
    ...report.blocked.map(({ reminder, reason }) => {
      const dueAt = Date.parse(reminder.when);
      return {
        id: reminder.id,
        userId: authUid,
        title: reminder.title || "Untitled",
        notes: reminder.notes || "",
        dueAt: isNaN(dueAt) ? 0 : dueAt,
        createdAt: timestamp,
        updatedAt: timestamp,
        reminderState: reminder.done === 'yes' ? 'completed' : 'active' as any,
        notificationState: 'pending' as const,
        error: reason,
        classification: 'blocked' as const
      };
    }),
    ...report.conflicts.map(({ reminder, reason }) => {
      const dueAt = Date.parse(reminder.when);
      return {
        id: reminder.id,
        userId: authUid,
        title: reminder.title || "Untitled",
        notes: reminder.notes || "",
        dueAt: isNaN(dueAt) ? 0 : dueAt,
        createdAt: timestamp,
        updatedAt: timestamp,
        reminderState: reminder.done === 'yes' ? 'completed' : 'active' as any,
        notificationState: 'pending' as const,
        error: reason,
        classification: 'conflict' as const
      };
    }),
    ...report.alreadyMigrated.map(({ reminder }) => {
      const dueAt = Date.parse(reminder.when);
      return {
        id: reminder.id,
        userId: authUid,
        title: reminder.title || "Untitled",
        notes: reminder.notes || "",
        dueAt: isNaN(dueAt) ? 0 : dueAt,
        createdAt: timestamp,
        updatedAt: timestamp,
        reminderState: reminder.done === 'yes' ? 'completed' : 'active' as any,
        notificationState: 'pending' as const,
        classification: 'already-migrated' as const
      };
    })
  ];

  return {
    total: state.reminders.length,
    eligible: report.valid.length,
    blocked: report.blocked.length,
    conflicts: report.conflicts.length,
    alreadyMigrated: report.alreadyMigrated.length,
    reports: previewResults,
    report // Original MigrationReport
  };
}
