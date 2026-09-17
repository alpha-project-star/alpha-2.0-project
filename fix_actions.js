const fs = require('fs');
let content = fs.readFileSync('src/lib/actions.ts', 'utf8');

content = content.replace(/type Plan,\n/g, 'type Task,\n  type Goal,\n');
content = content.replace(/type Kind = "note" | "memory" | "plan" | "bill";/g, 'type Kind = "note" | "memory" | "task" | "goal" | "bill";');
content = content.replace(/plan: "plans",/g, 'task: "tasks",\n  goal: "goals",');
content = content.replace(/case "plan":/g, 'case "task":\n    case "goal":');
content = content.replace(/kind === "plan"\n\s*\?\s*s\.plans/g, 'kind === "task"\n        ? s.tasks\n        : kind === "goal"\n        ? s.goals');
content = content.replace(/else if \(kind === "plan"\) alphaStore\.deletePlan\(id\);/g, 'else if (kind === "task") alphaStore.deleteTask(id);\n  else if (kind === "goal") alphaStore.deleteGoal(id);');
content = content.replace(/else if \(kind === "plan"\) alphaStore\.upsertPlan\(item as Plan\);/g, 'else if (kind === "task") alphaStore.upsertTask(item as Task);\n  else if (kind === "goal") alphaStore.upsertGoal(item as Goal);');

content = content.replace(/apply\(\n\s*\/\\\[\\\[ADD_PLAN:[\\s\\S]*?\}\s*satisfies Plan\);\n\s*return[\\s\\S]*?\},?\n\s*\);/g, '');
content = content.replace(/\[\[ADD_PLAN:[\\s\\S]*?\}\s*satisfies Plan\);\n\s*return[\\s\\S]*?\},?\n\s*\);/gm, '');

// let's do a regex replacement for the ADD_PLAN block
content = content.replace(/apply\(\s*\/\\\[\\\[ADD_PLAN[\s\S]*?\}\s*satisfies Plan\);\s*return verify\("plan"[\s\S]*?\},?\s*\);/g, '');

content = content.replace(/apply\(\/\\\[\\\[UPDATE_PLAN[\s\S]*?updateTag\("plan", "UPDATE_PLAN", \["title", "from", "to", "date", "details"\]\),/g, '');
content = content.replace(/apply\(\/\\\[\\\[DELETE_PLAN[\s\S]*?deleteTag\("plan", "DELETE_PLAN"\)\);/g, '');
content = content.replace(/\|plan/g, '|task');
content = content.replace(/plans/g, 'tasks');
content = content.replace(/plan"/g, 'task"');
content = content.replace(/"plan/g, '"task');


fs.writeFileSync('src/lib/actions.ts', content);
