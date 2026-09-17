const fs = require('fs');
let content = fs.readFileSync('src/lib/alpha-store.ts', 'utf8');

if (!content.includes('export type { Task')) {
  content = content.replace(
    'export interface Note {',
    'export type { Task, Goal, Run, Step, Observation, Result } from "./execution";\n\nexport interface Note {'
  );
  fs.writeFileSync('src/lib/alpha-store.ts', content);
}
