const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const projectPath = (...parts) => path.join(process.cwd(), ...parts);

test('packaged Electron app includes shared modules required by main process', () => {
  const pkg = JSON.parse(fs.readFileSync(projectPath('package.json'), 'utf8'));
  const main = fs.readFileSync(projectPath('electron', 'main.js'), 'utf8');
  const sharedRequires = [...main.matchAll(/require\(['"]\.\.\/shared\/([^'"]+)['"]\)/g)]
    .map((match) => match[1]);

  assert.notEqual(sharedRequires.length, 0);
  assert.ok(
    pkg.build.files.some((entry) => entry === 'shared/**/*' || entry === 'shared/**'),
    `package.json build.files must include shared/**/* for ${sharedRequires.join(', ')}`
  );
});
