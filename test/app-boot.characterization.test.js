// FND-00 baseline characterization test.
//
// This is the smoke test that establishes the Electron app's boot contract
// across macOS, Windows, and Linux CI. It does not require a display or a
// packaged build; instead it verifies the invariants the app depends on to
// start:
//   1. Boot-critical entry files are present (main process, preload, renderer
//      HTML, and the Vite build config).
//   2. `package.json#main` resolves to a real file.
//   3. Fundamental main-process modules load and expose their documented APIs
//      (the modules the main process `require`s at startup).
//   4. The `electron-builder` file manifest actually contains the directories
//      the main process requires, so a packaged build can boot.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const projectPath = (...parts) => path.join(process.cwd(), ...parts);

test('boot-critical entry files exist', () => {
  for (const rel of [
    'electron/main.js',
    'electron/preload.js',
    'index.html',
    'vite.config.ts',
  ]) {
    assert.ok(
      fs.existsSync(projectPath(rel)),
      `missing boot-critical file: ${rel}`
    );
  }
});

test('package.json main entry resolves to a real file', () => {
  const pkg = JSON.parse(fs.readFileSync(projectPath('package.json'), 'utf8'));
  assert.equal(typeof pkg.main, 'string');
  assert.ok(
    fs.existsSync(projectPath(pkg.main)),
    `package.json main "${pkg.main}" does not resolve to a file`
  );
});

test('fundamental main-process modules load and expose their APIs', () => {
  const localModelsRoot = require('../shared/localModelsRoot');
  const scanLocalModels = require('../shared/scanLocalModels');
  const llamacppModelStore = require('../electron/llamacpp-model-store');

  for (const name of ['RUNTIMES', 'ensureRuntimeDirs', 'modelsDir', 'resolveModelsRoot']) {
    assert.ok(name in localModelsRoot, `shared/localModelsRoot missing export: ${name}`);
  }
  for (const name of ['scanLocalModels', 'roleOf']) {
    assert.ok(name in scanLocalModels, `shared/scanLocalModels missing export: ${name}`);
  }
  for (const name of ['resolveInstalledModelPath', 'removeTranslationModel']) {
    assert.ok(name in llamacppModelStore, `electron/llamacpp-model-store missing export: ${name}`);
  }
});

test('packaged build manifest includes the main-process module directories', () => {
  const pkg = JSON.parse(fs.readFileSync(projectPath('package.json'), 'utf8'));
  const files = pkg.build && pkg.build.files;
  assert.ok(Array.isArray(files), 'package.json build.files must be an array');

  const required = ['shared/**/*', 'electron/**/*', 'dist/**/*'];
  for (const entry of required) {
    assert.ok(
      files.includes(entry),
      `package.json build.files must include "${entry}" so the packaged app can boot`
    );
  }
});
