// src/lib/migration-contract.ts
import { Reminder } from "./alpha-store";
import { FirestoreReminder } from "./reminder-repo";

export interface MigrationReport {
  valid: FirestoreReminder[];
  blocked: { reminder: Reminder; reason: string }[];
  conflicts: { reminder: Reminder; reason: string }[];
  alreadyMigrated: { reminder: Reminder }[];
}

export class MigrationValidator {
  constructor(private existingFirestoreIds: Set<string>) {}

  validate(reminders: Reminder[], userId: string, timestamp: number): MigrationReport {
    const report: MigrationReport = { valid: [], blocked: [], conflicts: [], alreadyMigrated: [] };
    const seenIds = new Set<string>();

    for (const r of reminders) {
      // 1. Identification
      if (!r.id) {
        report.blocked.push({ reminder: r, reason: "Missing record ID" });
        continue;
      }

      // 2. Conflict Check (Duplicate in local source list)
      if (seenIds.has(r.id)) {
        report.conflicts.push({ reminder: r, reason: "Duplicate ID in local storage source" });
        continue;
      }
      seenIds.add(r.id);

      // 3. Idempotency Check (Already in Firestore)
      if (this.existingFirestoreIds.has(r.id)) {
        report.alreadyMigrated.push({ reminder: r });
        continue;
      }

      // 4. Field Validation (Title/Notes - handle defaults)
      const title = (r.title || "Untitled").trim();
      const notes = (r.notes || "").trim();

      // 5. Date Validation
      const dueAt = Date.parse(r.when);
      if (isNaN(dueAt) || !r.when) {
        report.blocked.push({ reminder: r, reason: "Invalid or missing due date" });
        continue;
      }

      // 6. State Mapping
      if (r.done !== 'yes' && r.done !== 'no') {
        report.blocked.push({ reminder: r, reason: `Unknown completion state: ${r.done}` });
        continue;
      }

      // 7. Ownership (Ensure userId is valid)
      if (!userId) {
        report.blocked.push({ reminder: r, reason: "Missing authenticated user ID" });
        continue;
      }

      report.valid.push({
        id: r.id,
        userId: userId,
        title,
        notes,
        dueAt,
        createdAt: timestamp,
        updatedAt: timestamp,
        reminderState: r.done === 'yes' ? 'completed' : 'active',
        notificationState: 'pending',
        legacyFiredAt: r.firedAt
      });
    }

    return report;
  }
}
