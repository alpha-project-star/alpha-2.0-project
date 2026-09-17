const fs = require('fs');
let content = fs.readFileSync('src/lib/actions.ts', 'utf8');

content = content.replace(/type Kind = .*/, 'type Kind = "note" | "memory" | "task" | "goal" | "bill" | "reminder";');
content = content.replace(/apply\(\/\\\[\\\[UPDATE_PLAN.*?,\s*\);/gs, '');

fs.writeFileSync('src/lib/actions.ts', content);
