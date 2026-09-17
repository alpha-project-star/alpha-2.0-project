const fs = require('fs');
let content = fs.readFileSync('src/lib/alpha-store.ts', 'utf8');

content = content.replace(/let active = nextRuns\.filter/g, 'const active = nextRuns.filter');
content = content.replace(/let active = nextSteps\.filter/g, 'const active = nextSteps.filter');
content = content.replace(/let active = nextObs\.filter/g, 'const active = nextObs.filter');
content = content.replace(/let active = nextRes\.filter/g, 'const active = nextRes.filter');

fs.writeFileSync('src/lib/alpha-store.ts', content);
