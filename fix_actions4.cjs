const fs = require('fs');
let content = fs.readFileSync('src/lib/actions.ts', 'utf8');

content = content.replace(
  /const KIND_PLURAL: Record<Kind, string> = \{[\s\S]*?\};/,
  `const KIND_PLURAL: Record<Kind, string> = {
  note: "notes",
  memory: "memories",
  task: "tasks",
  goal: "goals",
  bill: "bills",
  reminder: "reminders",
};`
);

// Fix the missing return statement in searchText
content = content.replace(
  /function searchText\(kind: Kind, x: any\): string \{[\s\S]*?case "bill":\s*return `\$\{x\.name\} \$\{x\.amount\} \$\{x\.dueDate\} \$\{x\.status\}`\.toLowerCase\(\);\s*\}/,
  `function searchText(kind: Kind, x: any): string {
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
}`
);

// Fix empty apply()
content = content.replace(/apply\(\s*\);/g, '');
// there could be apply(\n  );
content = content.replace(/apply\(\s*\n\s*\);/g, '');

fs.writeFileSync('src/lib/actions.ts', content);
