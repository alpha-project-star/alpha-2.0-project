const fs = require('fs');
let content = fs.readFileSync('src/routes/plans.tsx', 'utf8');
content = content.replace(/status/g, 'from');
content = content.replace(/import \{([^\}]+)\} from/g, 'import {$1} from');
fs.writeFileSync('src/routes/plans.tsx', content);
