const fs = require('fs');
let code = fs.readFileSync('src/routes/settings.tsx', 'utf8');

code = code.replace(/const s = useAlpha\(\(x\) => x\.settings\);/, 'const globalSettings = useAlpha((x) => x.settings);\n  const [s, setS] = useState(globalSettings);\n  \n  function updateSetting(patch) {\n    setS(prev => ({ ...prev, ...patch }));\n  }');

code = code.replace(/alphaStore\.setSettings/g, 'updateSetting');

// Fix Save button
code = code.replace(
  /<button\n\s*onClick=\{\(\) => \{\n\s*setSaved\(true\);\n\s*setTimeout\(\(\) => setSaved\(false\), 1500\);\n\s*\}\}/,
  `<button\n            onClick={() => {\n              alphaStore.setSettings(s);\n              setSaved(true);\n              setTimeout(() => setSaved(false), 1500);\n            }}`
);

// We should also replace the sentence "Changes save automatically."
code = code.replace(/Changes save automatically\./, 'Unsaved changes.');

fs.writeFileSync('src/routes/settings.tsx', code);
