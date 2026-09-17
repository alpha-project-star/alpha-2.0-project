const fs = require('fs');
let code = fs.readFileSync('src/lib/alpha-store.ts', 'utf8');

const zodImport = `import { z } from "zod";\n`;

// insert Zod import
if (!code.includes('import { z } from "zod";')) {
  code = code.replace(/import \{.*?\} from "react";\n/, match => match + zodImport);
}

// ... we will use sed/awk or just write it via edit_file
