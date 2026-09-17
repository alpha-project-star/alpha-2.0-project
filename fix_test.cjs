const fs = require('fs');
let content = fs.readFileSync('tests/phase4-intelligence.test.ts', 'utf8');
content = content.replace(/upsertPlan/g, 'upsertTask');
content = content.replace(/plans/g, 'tasks');
fs.writeFileSync('tests/phase4-intelligence.test.ts', content);
