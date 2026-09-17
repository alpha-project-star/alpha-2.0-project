// src/components/MigrationDryRun.tsx
import { useEffect, useState } from 'react';
import { performDryRun } from '../lib/migration-dry-run';
import { alphaStore } from '../lib/alpha-store';
import { FirestoreReminderRepository } from '../lib/reminder-repo';
import { toast } from 'sonner';
import { useAuth } from '../lib/auth';
import { MigrationOrchestrator, MigrationState } from '../lib/migration-orchestrator';

export function MigrationDryRun() {
  const auth = useAuth();
  const [orchestrator, setOrchestrator] = useState<MigrationOrchestrator | null>(null);
  const [orchestratorState, setOrchestratorState] = useState<MigrationState | null>(null);
  const [report, setReport] = useState<ReturnType<typeof performDryRun> | null>(null);
  const [isLoading, setIsLoading] = useState(false);
  const authUid = auth.status === 'authenticated' ? auth.user.uid : null;

  useEffect(() => {
    if (auth.status === 'authenticated' && authUid) {
      const orch = new MigrationOrchestrator(authUid);
      setOrchestrator(orch);
      orch.getState().then(setOrchestratorState);
    } else {
      setOrchestrator(null);
      setOrchestratorState(null);
    }
  }, [auth.status, authUid]);

  if (auth.status === 'unauthenticated') {
    return (
      <div className="p-4 glass rounded-xl border border-destructive/30">
        <h3 className="text-lg font-semibold mb-2">Migration Locked</h3>
        <p className="text-sm text-muted-foreground">Please sign in to migrate your reminders to the cloud.</p>
      </div>
    );
  }

  if (auth.status !== 'authenticated' || !orchestrator) {
    return null;
  }

  const runDryRun = async () => {
    setIsLoading(true);
    try {
      const repo = new FirestoreReminderRepository();
      const existingReminders = await repo.listReminders(auth.user.uid);
      const existingIds = new Set(existingReminders.map(r => r.id));
      
      const state = alphaStore.get();
      setReport(performDryRun(state, auth.user.uid, Date.now(), existingIds));
      
      // Refresh orchestrator state
      const s = await orchestrator.getState();
      setOrchestratorState(s);
    } catch (error: any) {
      toast.error(`Failed to check existing reminders: ${error.message}`);
    } finally {
      setIsLoading(false);
    }
  };

  const execute = async () => {
    if (!report || !report.report) return;
    
    setIsLoading(true);
    try {
      const newState = await orchestrator.executeMigration(Date.now());
      setOrchestratorState(newState);
      
      const results = newState.results || [];
      const createdCount = results.filter(r => r.status === 'created').length;
      const failedCount = results.filter(r => r.status === 'failed').length;
      
      if (failedCount > 0) {
        toast.error(`Migration completed with ${failedCount} failures.`);
      } else if (createdCount > 0) {
        toast.success(`Successfully migrated ${createdCount} reminders!`);
      } else {
        toast.info("No new reminders were eligible for migration.");
      }
    } catch (error: any) {
      toast.error(`Migration error: ${error.message}`);
      orchestrator.getState().then(setOrchestratorState);
    } finally {
      setIsLoading(false);
    }
  };

  const status = orchestratorState?.status || 'not_started';
  const isMigrating = status === 'in_progress' || isLoading;

  return (
    <div className="p-4 glass rounded-xl border border-primary/30 space-y-4">
      <div className="flex items-center justify-between">
        <h3 className="text-lg font-semibold">Migration Control</h3>
        <span className={`text-[10px] px-2 py-0.5 rounded-full border ${
          status === 'completed' ? 'border-emerald-400/40 text-emerald-300' :
          status === 'failed' ? 'border-destructive/40 text-destructive' :
          status === 'in_progress' ? 'border-primary/40 text-primary animate-pulse' :
          'border-muted-foreground/40 text-muted-foreground'
        }`}>
          {status.toUpperCase().replace('_', ' ')}
        </span>
      </div>

      <div className="flex gap-2">
        <button 
          onClick={runDryRun} 
          disabled={isMigrating}
          className="px-4 py-2 rounded-lg bg-secondary text-secondary-foreground text-sm font-semibold disabled:opacity-50"
        >
          {isLoading && status !== 'in_progress' ? 'Checking...' : 'Run Dry-Run'}
        </button>
        {report && report.eligible > 0 && status !== 'completed' && status !== 'in_progress' && (
          <button 
            onClick={execute} 
            disabled={isMigrating}
            className="px-4 py-2 rounded-lg bg-primary text-primary-foreground text-sm font-semibold disabled:opacity-50"
          >
            {isMigrating ? 'Migrating...' : `Migrate ${report.eligible} Eligible Records`}
          </button>
        )}
      </div>

      {orchestratorState?.results && (
        <div className="p-3 bg-muted rounded-lg text-xs">
          <h4 className="font-semibold mb-2 text-primary">Migration Results</h4>
          <div className="grid grid-cols-2 md:grid-cols-4 gap-2">
            <div className="p-2 bg-green-500/10 text-green-600 rounded">
              Created: {orchestratorState.summary?.created ?? 0}
            </div>
            <div className="p-2 bg-yellow-500/10 text-yellow-600 rounded">
              Skipped: {orchestratorState.summary?.skipped ?? 0}
            </div>
            <div className="p-2 bg-blue-500/10 text-blue-600 rounded">
              Exist: {orchestratorState.summary?.alreadyMigrated ?? 0}
            </div>
            <div className="p-2 bg-red-500/10 text-red-600 rounded">
              Failed: {orchestratorState.summary?.failed ?? 0}
            </div>
          </div>
          {orchestratorState.error && (
            <div className="mt-2 text-destructive font-medium italic">
              Error: {orchestratorState.error}
            </div>
          )}
          {orchestratorState.verified === false && (
            <div className="mt-1 text-destructive text-[10px]">
              Verification failed: some records are missing in Firestore.
            </div>
          )}
          {orchestratorState.verified === true && (
            <div className="mt-1 text-emerald-500 text-[10px]">
              ✓ All records verified in Firestore.
            </div>
          )}
        </div>
      )}

      {report && (
        <div className="mt-4 space-y-2 text-xs">
          <div className="grid grid-cols-2 gap-2 mb-4">
            <div className="p-2 bg-muted rounded">Total: {report.total}</div>
            <div className="p-2 bg-green-500/10 text-green-600 rounded">Eligible: {report.eligible}</div>
            <div className="p-2 bg-yellow-500/10 text-yellow-600 rounded">Blocked: {report.blocked}</div>
            <div className="p-2 bg-red-500/10 text-red-600 rounded">Conflicts: {report.conflicts}</div>
            <div className="p-2 bg-blue-500/10 text-blue-600 rounded col-span-2">Already Migrated: {report.alreadyMigrated}</div>
          </div>
          
          <div className="overflow-x-auto mt-4 border rounded-lg">
            <table className="w-full text-left border-collapse">
              <thead>
                <tr className="bg-muted">
                  <th className="p-2 border-b">Title</th>
                  <th className="p-2 border-b">Classification</th>
                  <th className="p-2 border-b">Status/Error</th>
                </tr>
              </thead>
              <tbody>
                {report.reports.map(r => (
                  <tr key={r.id} className="hover:bg-muted/50">
                    <td className="p-2 border-b font-medium">{r.title}</td>
                    <td className="p-2 border-b capitalize">{r.classification}</td>
                    <td className={`p-2 border-b ${r.error ? 'text-destructive' : 'text-muted-foreground'}`}>
                      {r.error || (r.classification === 'already-migrated' ? 'No action needed' : 'Ready')}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <p className="text-[10px] text-muted-foreground mt-2 italic">No writes to Firestore or localStorage performed.</p>
        </div>
      )}
    </div>
  );
}
