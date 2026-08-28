'use strict';

/**
 * P4.D4 Slice 2 — settings-current parity test (binding §3, §6 Slice 2).
 *
 * Loads the committed shared fixture, decodes it through the REAL Main-process
 * settings store (`readSettings` → `migrateSettings` → `normalizeSettings`),
 * and applies the §3 semantic comparator: deep-equal on all fixture keys
 * (schemaVersion included), ignoring the §3-named environment fields.
 * A negative case mutates an in-memory copy of the fixture and requires the
 * comparator to fail — proving the harness discriminates semantic edits.
 */

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const store = require('../../electron/main/storage/settingsStore.js');
const { compareSettings } = require('../parity/comparators.mjs');

const FIXTURE_PATH = path.join(__dirname, '..', 'fixtures', 'parity', 'settings-current.json');

function loadFixture() {
  return JSON.parse(fs.readFileSync(FIXTURE_PATH, 'utf8'));
}

/** Decode a settings document through the real disk store (temp path). */
function decodeSettings(document, t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'parity-settings-'));
  t.after(() => {
    try {
      fs.rmSync(dir, { recursive: true, force: true });
    } catch {
      /* ignore */
    }
  });
  const settingsPath = path.join(dir, 'settings', 'settings.json');
  fs.mkdirSync(path.dirname(settingsPath), { recursive: true });
  fs.writeFileSync(settingsPath, JSON.stringify(document, null, 2), 'utf8');
  return store.readSettings({ settingsPath });
}

test('settings fixture declares the shared parity harness version', () => {
  assert.equal(loadFixture().fixtureVersion, 1);
});

test('settings fixture decodes through the real settings store to the same semantic content', (t) => {
  const fixture = loadFixture();
  const result = decodeSettings(fixture, t);

  assert.equal(result.source, 'file');
  assert.equal(result.recovered, false);
  assert.equal(result.settings.schemaVersion, fixture.schemaVersion);

  const comparison = compareSettings(fixture, result.settings);
  assert.deepEqual(
    comparison.failures,
    [],
    `settings parity comparator reported drift:\n${comparison.failures.join('\n')}`,
  );
  assert.equal(comparison.ok, true);
});

test('comparator fails when the fixture settings content is mutated', (t) => {
  const fixture = loadFixture();
  const mutated = structuredClone(fixture);
  mutated.appearance.theme = mutated.appearance.theme === 'dark' ? 'light' : 'dark';
  mutated.transcription.defaultTargetLanguage = 'German';

  const result = decodeSettings(mutated, t);
  const comparison = compareSettings(fixture, result.settings);

  assert.equal(comparison.ok, false);
  assert.ok(
    comparison.failures.some((line) => line.includes('appearance.theme')),
    `expected an appearance.theme failure, got:\n${comparison.failures.join('\n')}`,
  );
  assert.ok(
    comparison.failures.some((line) => line.includes('transcription.defaultTargetLanguage')),
    `expected a transcription.defaultTargetLanguage failure, got:\n${comparison.failures.join('\n')}`,
  );
});
