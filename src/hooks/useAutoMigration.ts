// src/hooks/useAutoMigration.ts
import { useEffect, useRef } from 'react';
import { useAuth } from '../lib/auth';
import { MigrationOrchestrator } from '../lib/migration-orchestrator';
import { alphaStore } from '../lib/alpha-store';

export function useAutoMigration() {
  const auth = useAuth();
  const triggered = useRef(false);
  const authUid = auth.status === 'authenticated' ? auth.user.uid : null;

  useEffect(() => {
    // Only trigger once per session when authenticated
    if (auth.status === 'authenticated' && authUid && !triggered.current) {
      const state = alphaStore.get();
      
      // Only trigger if there is legacy data to migrate
      if (state.reminders && state.reminders.length > 0) {
        triggered.current = true;
        
        const orch = new MigrationOrchestrator(authUid);
        
        // Background execution
        // We use Date.now() once here to ensure the entire batch shares the same timestamp
        const timestamp = Date.now();
        
        orch.executeMigration(timestamp).catch(err => {
          console.error("Auto-migration failed:", err);
          // We don't reset triggered.current here because the orchestrator 
          // handles retries/failures in persistent state.
          // The user can also retry manually via the UI.
        });
      }
    }
  }, [auth.status, authUid]);
}
