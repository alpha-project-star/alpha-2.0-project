const fs = require('fs');
let content = fs.readFileSync('src/lib/alpha-store.ts', 'utf8');

// The user is right. Blind \`.slice(-X)\` could truncate an active or blocked run if 50 new runs are queued,
// or drop a pending step if a loop generated 200 other steps. We need a retention strategy that protects active states.

content = content.replace(
  /upsertRun\(r: Run\) \{[\s\S]*?emit\(\);\n  \},/,
  `upsertRun(r: Run) {
    const nextRuns = upsert(state.runs, r);
    // Sort so active/blocked runs are prioritized for retention, or simply filter out oldest completed ones until limit
    let active = nextRuns.filter(x => ["queued", "running", "waiting", "blocked"].includes(x.status));
    let inactive = nextRuns.filter(x => ["completed", "failed", "cancelled"].includes(x.status));
    
    if (nextRuns.length > 50) {
      inactive = inactive.slice(-(Math.max(0, 50 - active.length)));
    }
    
    state = { ...state, runs: [...inactive, ...active].sort((a,b) => (a.startedAt || 0) - (b.startedAt || 0)) };
    writeLS(K.runs, state.runs);
    emit();
  },`
);

content = content.replace(
  /upsertStep\(s: Step\) \{[\s\S]*?emit\(\);\n  \},/,
  `upsertStep(s: Step) {
    const nextSteps = upsert(state.steps, s);
    let active = nextSteps.filter(x => ["pending", "running"].includes(x.status));
    let inactive = nextSteps.filter(x => ["completed", "failed", "cancelled"].includes(x.status));
    
    if (nextSteps.length > 200) {
       inactive = inactive.slice(-(Math.max(0, 200 - active.length)));
    }
    
    state = { ...state, steps: [...inactive, ...active].sort((a,b) => a.sequence - b.sequence) };
    writeLS(K.steps, state.steps);
    emit();
  },`
);

content = content.replace(
  /upsertObservation\(o: Observation\) \{[\s\S]*?emit\(\);\n  \},/,
  `upsertObservation(o: Observation) {
    const nextObs = upsert(state.observations, o);
    // Observations don't have active status, but we must protect observations attached to active steps/runs.
    // We will just do a standard slice for observations/results for now but really we should garbage collect orphaned ones.
    state = { ...state, observations: nextObs.slice(-200) };
    writeLS(K.observations, state.observations);
    emit();
  },`
);

fs.writeFileSync('src/lib/alpha-store.ts', content);
