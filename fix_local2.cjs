const fs = require('fs');
let content = fs.readFileSync('src/lib/local-intents.ts', 'utf8');

content = content.replace(/  \}\n\n  \}\n  \/\/ Bill:/, '  }\n\n  // Bill:');

fs.writeFileSync('src/lib/local-intents.ts', content);
