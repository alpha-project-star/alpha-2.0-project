import { learningEngine } from './src/lib/learning-engine.ts';

let appliedCount = 0;
for (let i = 0; i < 505; i++) {
  const c = learningEngine.proposeCandidate({
    type: 'BEHAVIORAL_PATTERN',
    subject: `fact_${i}`,
    candidateStatement: `statement ${i}`,
    source: 'test',
    evidence: [
      { type: 'repeated', sourceId: `s_${i}_1`, content: 'test' },
      { type: 'repeated', sourceId: `s_${i}_2`, content: 'test2' }
    ],
    provenance: 'repeated_behavior'
  });
  if (c.candidate) {
    learningEngine.validateCandidate(c.candidate.id);
    const r = learningEngine.applyCandidate(c.candidate.id);
    if (r.success) appliedCount++;
  }
}
console.log("Applied:", appliedCount);
console.log("Learnings size:", learningEngine.listAllLearnings().length);
