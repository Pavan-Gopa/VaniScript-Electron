'use strict';

/**
 * P4.D4 Slice 2 — shorts-export-selection parity test (binding §3, §4
 * divergence #2, §6 Slice 2).
 *
 * Loads the committed shared fixture and applies the §3 comparator: selections
 * match by normalized selection identity (stableID, lowercased languageKey),
 * isSelected compares as a boolean, and selectionIdentityMap must be a 1:1
 * index↔stableID bijection consistent with every selection's planIndex.
 * The stableID+language identity is the cross-edition canonical key (§4
 * divergence #2); the case-insensitivity of language keys is exercised
 * positively. Negative cases mutate in-memory fixture copies and require the
 * comparator to fail.
 */

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

// Load the real renderer selection-key helper without introducing a production
// test seam; the npm test runner already includes tsx as a dev dependency.
const { require: requireTypeScript } = require('tsx/cjs/api');
const { shortsSelectionKey } = requireTypeScript(
  path.join(__dirname, '..', '..', 'src', 'lib', 'shorts-reels.ts'),
  __filename,
);
const { compareShortsExportSelection } = require('../parity/comparators.mjs');

const FIXTURE_PATH = path.join(
  __dirname,
  '..',
  'fixtures',
  'parity',
  'shorts-export-selection.json',
);

function loadFixture() {
  return JSON.parse(fs.readFileSync(FIXTURE_PATH, 'utf8'));
}

function displayLanguageKey(languageKey) {
  return String(languageKey || '').toLowerCase();
}

/**
 * Rebuild the renderer's selectedShortsPlanKeys state with the same
 * stableID+language key helper used by the product, then read it with
 * shortsSelectionKey just as the export controls do. Native
 * ShortsExportSelection.insert/contains has the same normalized identity
 * semantics; the wire rows remain the cross-edition projection.
 */
function decodeSelection(fixture) {
  const selectedShortsPlanKeys = new Set();
  for (const selection of fixture.selections) {
    if (selection.isSelected === true) {
      selectedShortsPlanKeys.add(
        shortsSelectionKey(
          selection.stableID,
          displayLanguageKey(selection.languageKey),
        ),
      );
    }
  }
  return {
    selectionIdentityMap: fixture.selectionIdentityMap.map((row) => ({ ...row })),
    selections: fixture.selections.map((selection) => ({
      ...selection,
      isSelected: selectedShortsPlanKeys.has(
        shortsSelectionKey(
          selection.stableID,
          displayLanguageKey(selection.languageKey),
        ),
      ),
    })),
  };
}

test('shorts export selection fixture declares the shared parity harness version', () => {
  assert.equal(loadFixture().fixtureVersion, 1);
});

test('export selections round-trip through the real Electron selection-key path', () => {
  const fixture = loadFixture();
  const decoded = decodeSelection(fixture);
  const comparison = compareShortsExportSelection(fixture, decoded);
  assert.deepEqual(
    comparison.failures,
    [],
    `shorts-export parity comparator reported drift:\n${comparison.failures.join('\n')}`,
  );
  assert.equal(comparison.ok, true);
});

test('selectionIdentityMap is a consistent index↔stableID bijection', () => {
  const fixture = loadFixture();
  const map = fixture.selectionIdentityMap;

  const indexes = map.map((row) => row.index);
  const stableIDs = map.map((row) => row.stableID);
  assert.equal(new Set(indexes).size, indexes.length, 'indexes are unique');
  assert.equal(new Set(stableIDs).size, stableIDs.length, 'stableIDs are unique');
  assert.deepEqual(
    indexes,
    [...indexes].sort((a, b) => a - b),
    'identity map covers the plan ordinals in order',
  );
  for (const selection of fixture.selections) {
    assert.equal(
      map[selection.planIndex].stableID,
      selection.stableID,
      `selection planIndex ${selection.planIndex} maps to its stableID`,
    );
  }
});

test('language keys match case-insensitively across editions', () => {
  const fixture = loadFixture();
  const recased = JSON.parse(JSON.stringify(fixture));
  for (const selection of recased.selections) {
    selection.languageKey = selection.languageKey.toUpperCase();
  }

  const comparison = compareShortsExportSelection(fixture, recased);
  assert.equal(comparison.ok, true, `expected case-insensitive match, got:\n${comparison.failures.join('\n')}`);
});

test('comparator fails when selection content or identity is mutated', () => {
  const fixture = loadFixture();

  const flipped = JSON.parse(JSON.stringify(fixture));
  flipped.selections[0].isSelected = !flipped.selections[0].isSelected;
  const flippedComparison = compareShortsExportSelection(fixture, flipped);
  assert.equal(flippedComparison.ok, false);
  assert.ok(
    flippedComparison.failures.some((line) => line.includes('isSelected')),
    `expected an isSelected failure, got:\n${flippedComparison.failures.join('\n')}`,
  );

  const inconsistent = JSON.parse(JSON.stringify(fixture));
  inconsistent.selections[0].stableID = 'fixture-plan-99';
  const inconsistentComparison = compareShortsExportSelection(fixture, inconsistent);
  assert.equal(inconsistentComparison.ok, false);
  assert.ok(
    inconsistentComparison.failures.some((line) => line.includes('fixture-plan-99')),
    `expected an identity failure, got:\n${inconsistentComparison.failures.join('\n')}`,
  );

  const brokenBijection = JSON.parse(JSON.stringify(fixture));
  brokenBijection.selectionIdentityMap[1].index = 0;
  const bijectionComparison = compareShortsExportSelection(fixture, brokenBijection);
  assert.equal(bijectionComparison.ok, false);
  assert.ok(
    bijectionComparison.failures.some((line) => line.includes('bijection broken')),
    `expected a bijection failure, got:\n${bijectionComparison.failures.join('\n')}`,
  );
});
