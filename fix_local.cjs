const fs = require('fs');
let content = fs.readFileSync('src/lib/local-intents.ts', 'utf8');

content = content.replace(/\|plan/g, '|task');
content = content.replace(/\|plans/g, '|tasks');
content = content.replace(/plan:/g, 'task:');
content = content.replace(/kind === "plan"/g, 'kind === "task"');
content = content.replace(/s\.plans/g, 's.tasks');
content = content.replace(/alphaStore\.deletePlan/g, 'alphaStore.deleteTask');
content = content.replace(/alphaStore\.upsertPlan/g, 'alphaStore.upsertTask');
content = content.replace(/"\*\*Plans:\*\*\\n"/g, '"**Tasks:**\\n"');
content = content.replace(/You have no plans\./g, 'You have no tasks.');
content = content.replace(/No plan matching/g, 'No task matching');
content = content.replace(/Multiple plans match/g, 'Multiple tasks match');
content = content.replace(/Deleted plan/g, 'Deleted task');

fs.writeFileSync('src/lib/local-intents.ts', content);
