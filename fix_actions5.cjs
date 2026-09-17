const fs = require('fs');
let content = fs.readFileSync('src/lib/actions.ts', 'utf8');

// I'll just find the exact text of searchText and replace the whole function.
const searchFuncRegex = /function searchText\(kind: Kind, x: any\): string \{[\s\S]*?\n\}/g;

const correctSearchFunc = `function searchText(kind: Kind, x: any): string {
  switch (kind) {
    case "note":
      return \`\${x.title} \${x.body}\`.toLowerCase();
    case "memory":
      return \`\${x.topic} \${x.detail}\`.toLowerCase();
    case "task":
      return \`\${x.title} \${x.description} \${x.status}\`.toLowerCase();
    case "goal":
      return \`\${x.title} \${x.description} \${x.status}\`.toLowerCase();
    case "bill":
      return \`\${x.name} \${x.amount} \${x.dueDate} \${x.status}\`.toLowerCase();
    case "reminder":
      return \`\${x.title} \${x.notes} \${x.when}\`.toLowerCase();
  }
  return "";
}`;

content = content.replace(searchFuncRegex, correctSearchFunc);

fs.writeFileSync('src/lib/actions.ts', content);
