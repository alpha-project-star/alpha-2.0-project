import { alphaCore } from './src/lib/alpha-core.ts';
const result = alphaCore.integrateLearning({
  id: 'L-1',
  subject: 'Capability',
  candidateStatement: 'reminders are unavailable',
  evidenceReferences: [{ type: 'explicit_statement', sourceId: 'src', content: 'User told me so', timestamp: Date.now() }],
  provenance: 'user',
  confidence: 'high',
  status: 'APPLIED',
  learningType: 'capability',
  scope: { type: 'global' },
  evaluations: [],
  createdAt: Date.now(),
  updatedAt: Date.now()
} as any);
console.log(result);
