const fs = require('fs');
let content = fs.readFileSync('src/lib/alpha-store.ts', 'utf8');

// The observation and result truncation MUST also be aware of active Runs, otherwise we drop evidence required by evaluation.
content = content.replace(
  /upsertObservation\(o: Observation\) \{[\s\S]*?emit\(\);\n  \},/,
  `upsertObservation(o: Observation) {
    const nextObs = upsert(state.observations, o);
    const activeRunIds = new Set(state.runs.filter(r => ["queued", "running", "waiting", "blocked"].includes(r.status)).map(r => r.id));
    
    let active = nextObs.filter(x => activeRunIds.has(x.runId));
    let inactive = nextObs.filter(x => !activeRunIds.has(x.runId));
    
    if (nextObs.length > 200) {
      inactive = inactive.slice(-(Math.max(0, 200 - active.length)));
    }
    
    state = { ...state, observations: [...inactive, ...active].sort((a,b) => a.timestamp - b.timestamp) };
    writeLS(K.observations, state.observations);
    emit();
  },`
);

content = content.replace(
  /upsertResult\(r: Result\) \{[\s\S]*?emit\(\);\n  \},/,
  `upsertResult(r: Result) {
    const nextRes = upsert(state.results, r);
    const activeRunIds = new Set(state.runs.filter(r => ["queued", "running", "waiting", "blocked"].includes(r.status)).map(r => r.id));
    
    let active = nextRes.filter(x => activeRunIds.has(x.runId));
    let inactive = nextRes.filter(x => !activeRunIds.has(x.runId));
    
    if (nextRes.length > 100) {
      inactive = inactive.slice(-(Math.max(0, 100 - active.length)));
    }
    
    state = { ...state, results: [...inactive, ...active].sort((a,b) => a.timestamp - b.timestamp) };
    writeLS(K.results, state.results);
    emit();
  },`
);

fs.writeFileSync('src/lib/alpha-store.ts', content);
