// src/lib/migration-orchestrator.ts
import { doc, getDoc, setDoc, runTransaction } from 'firebase/firestore';
import { db } from './firebase';
import { AlphaState, alphaStore } from './alpha-store';
import { MigrationValidator } from './migration-contract';
import { MigrationWriter, MigrationWriteResult } from './migration-writer';
import { FirestoreReminderRepository } from './reminder-repo';

export type MigrationStatus = 'not_started' | 'eligible' | 'in_progress' | 'completed' | 'failed';

export interface MigrationSummary {
  total: number;
  eligible: number;
  created: number;
  skipped: number;
  blocked: number;
  conflicts: number;
  alreadyMigrated: number;
  failed: number;
}

export interface MigrationState {
  status: MigrationStatus;
  lastAttempt?: number;
  error?: string;
  summary?: MigrationSummary;
  results?: MigrationWriteResult[];
  verified?: boolean;
}

export class MigrationOrchestrator {
  private static inProgressLock = new Set<string>();

  constructor(
    private userId: string,
    private repo = new FirestoreReminderRepository(),
    private writer = new MigrationWriter(repo)
  ) {}

  private get stateDoc() {
    return doc(db, 'users', this.userId, 'migration', 'state');
  }

  async getState(): Promise<MigrationState> {
    if (!this.userId) return { status: 'not_started' };
    
    try {
      const snap = await getDoc(this.stateDoc);
      if (snap.exists()) {
        return snap.data() as MigrationState;
      }
    } catch (e) {
      console.error("Failed to fetch migration state", e);
    }

    // Determine eligibility if no state exists
    const state = alphaStore.get();
    if (state.reminders.length > 0) {
      return { status: 'eligible' };
    }
    
    return { status: 'not_started' };
  }

  async setStatus(status: MigrationStatus, extra: Partial<MigrationState> = {}) {
    const state: MigrationState = {
      status,
      ...extra,
      lastAttempt: Date.now()
    };
    await setDoc(this.stateDoc, state);
    return state;
  }

  /**
   * The core orchestration logic.
   * In Stage 1, this is only called manually.
   */
  async executeMigration(timestamp: number): Promise<MigrationState> {
    if (!this.userId) throw new Error("Authentication required");

    // 1. Concurrency Lock (In-process)
    if (MigrationOrchestrator.inProgressLock.has(this.userId)) {
      throw new Error("Migration already in progress");
    }
    MigrationOrchestrator.inProgressLock.add(this.userId);

    try {
      // 2. Atomic Concurrency Check & Lock (Firestore state)
      const lockAcquired = await runTransaction(db, async (transaction) => {
        const snap = await transaction.get(this.stateDoc);
        if (snap.exists()) {
          const data = snap.data() as MigrationState;
          if (data.status === 'in_progress') return false;
          if (data.status === 'completed') return 'completed';
        }
        
        transaction.set(this.stateDoc, { 
          status: 'in_progress', 
          lastAttempt: Date.now() 
        }, { merge: true });
        return true;
      });

      if (lockAcquired === false) {
        throw new Error("Migration already in progress (another session)");
      }
      if (lockAcquired === 'completed') {
        const state = await this.getState();
        return state;
      }

      const localState = alphaStore.get();
      
      // 3. Get existing Firestore IDs for idempotency
      const existingReminders = await this.repo.listReminders(this.userId);
      const existingIds = new Set(existingReminders.map(r => r.id));

      // 4. Validate
      const validator = new MigrationValidator(existingIds);
      const report = validator.validate(localState.reminders, this.userId, timestamp);

      // 5. Write
      const results = await this.writer.migrate(report, this.userId);
      
      // 6. Explicit Verification
      const finalExisting = await this.repo.listReminders(this.userId);
      const finalExistingIds = new Set(finalExisting.map(r => r.id));
      
      const missing = report.valid.filter(r => !finalExistingIds.has(r.id));
      const failed = results.some(r => r.status === 'failed') || missing.length > 0;
      
      const summary: MigrationSummary = {
        total: localState.reminders.length,
        eligible: report.valid.length,
        created: results.filter(r => r.status === 'created').length,
        skipped: results.filter(r => r.status === 'skipped').length,
        blocked: report.blocked.length,
        conflicts: report.conflicts.length,
        alreadyMigrated: report.alreadyMigrated.length,
        failed: results.filter(r => r.status === 'failed').length + missing.length
      };

      if (!failed && localState.reminders.length > 0) {
        // A-253: Wipe legacy source data upon proven successful migration.
        alphaStore.clearReminders();
      }

      const status: MigrationStatus = failed ? 'failed' : 'completed';
      
      const newState = await this.setStatus(status, { 
        results, 
        summary,
        verified: !failed,
        error: failed ? (missing.length > 0 ? `${missing.length} records missing after write` : "Some records failed to migrate") : undefined
      });

      return newState;
    } catch (error: any) {
      await this.setStatus('failed', { error: error.message });
      throw error;
    } finally {
      MigrationOrchestrator.inProgressLock.delete(this.userId);
    }
  }
}
