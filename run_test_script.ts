import { learningEngine } from './src/lib/learning-engine.ts';

const candidate = learningEngine.proposeCandidate({
  type: 'preference',
  subject: 'user_preference',
  candidateStatement: 'User prefers dark mode',
  source: 'test',
  evidence: [{ type: 'explicit_statement', sourceId: '1', content: 'I prefer dark mode.' }],
  provenance: 'user'
});
console.log(candidate);
