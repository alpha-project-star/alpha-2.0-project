import { learningEngine } from './src/lib/learning-engine.ts';

const c1 = learningEngine.proposeCandidate({
  type: 'EXPLICIT_PREFERENCE',
  subject: 'fact',
  candidateStatement: 'User lives in NY',
  source: 'test',
  evidence: [{ type: 'direct', sourceId: '1', content: 'I live in NY' }],
  provenance: 'explicit_user_statement'
});
console.log(c1);

const c2 = learningEngine.proposeCandidate({
  type: 'EXPLICIT_PREFERENCE',
  subject: 'fact',
  candidateStatement: 'User lives in NY',
  source: 'test',
  evidence: [{ type: 'direct', sourceId: '2', content: 'I live in NY again' }],
  provenance: 'explicit_user_statement'
});
console.log(c2);
