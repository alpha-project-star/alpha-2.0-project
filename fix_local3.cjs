const fs = require('fs');
let content = fs.readFileSync('src/lib/local-intents.ts', 'utf8');

content = content.replace(/\.map\(\(p\) => `• \$\{p\.title\} \(\$\{p\.from\} → \$\{p\.to\}\)\$\{\}`\)/g, '.map((p) => `• ${p.title} (${p.status})`)');

fs.writeFileSync('src/lib/local-intents.ts', content);
