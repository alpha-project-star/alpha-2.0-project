const fs = require('fs');
let content = fs.readFileSync('tests/phase4-intelligence.test.ts', 'utf8');

// The test is looking for "delete plan Vacation". Since we removed plan from local-intents, it returns null.
// Let's change the test to use "delete task Vacation".
content = content.replace(/"delete plan Vacation"/g, '"delete task Vacation"');

fs.writeFileSync('tests/phase4-intelligence.test.ts', content);
