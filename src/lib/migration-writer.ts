// src/lib/migration-writer.ts
import { ReminderRepository } from "./reminder-repo";
import { MigrationReport } from "./migration-contract";
import { getAuth } from "firebase/auth";

export interface MigrationWriteResult {
  id: string;
  status: 'created' | 'skipped' | 'failed';
  reason?: string;
}

export class MigrationWriter {
  constructor(private repo: ReminderRepository) {}

  /**
   * Performs the actual migration writes to Firestore.
   * Only writes records classified as 'valid' in the report.
   */
  async migrate(report: MigrationReport, providedUserId?: string): Promise<MigrationWriteResult[]> {
    const auth = getAuth();
    const currentUser = auth.currentUser;

    if (!currentUser) {
      throw new Error("Authentication required for migration.");
    }

    const userId = currentUser.uid;

    // Security check: if a userId was provided, it must match the authenticated user
    if (providedUserId && providedUserId !== userId) {
      throw new Error("User ID mismatch: cannot migrate to another user's account.");
    }

    const results: MigrationWriteResult[] = [];

    // 1. Handle Valid (New) Records
    for (const reminder of report.valid) {
      try {
        await this.repo.createReminder(userId, reminder);
        results.push({ id: reminder.id, status: 'created' });
      } catch (error: any) {
        results.push({ 
          id: reminder.id, 
          status: 'failed', 
          reason: error.message || 'Unknown failure' 
        });
      }
    }

    // 2. Handle Already Migrated (Skipped)
    for (const { reminder } of report.alreadyMigrated) {
      results.push({ id: reminder.id, status: 'skipped', reason: 'Already migrated' });
    }

    // 3. Handle Conflicts (Skipped)
    for (const { reminder, reason } of report.conflicts) {
      results.push({ id: reminder.id, status: 'skipped', reason: `Conflict: ${reason}` });
    }

    // 4. Handle Blocked (Skipped)
    for (const { reminder, reason } of report.blocked) {
      results.push({ id: reminder.id, status: 'skipped', reason: `Blocked: ${reason}` });
    }

    return results;
  }
}
