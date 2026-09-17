import { learningEngine } from './src/lib/learning-engine.ts';

const candidate = learningEngine.proposeCandidate({
  type: 'EXPLICIT_PREFERENCE',
  subject: 'user_preference',
  candidateStatement: 'User prefers dark mode',
  source: 'test',
  evidence: [{ type: 'direct', sourceId: '1', content: 'I prefer dark mode.' }],
  provenance: 'explicit_user_statement'
});
console.log("Candidate:");
console.log(candidate);
