'use strict';

/**
 * P4.D4 Slice 2 — shorts-render-contract parity test (binding §3, §4
 * divergence #1, §6 Slice 2).
 *
 * Loads the committed shared fixture, computes each plan's canonical
 * projection with the REAL `activeShortsPlanProjection` (shared/shorts-state.js)
 * and canonicalizes the plans with the REAL `normalizeShortsSessionState`,
 * then applies the §3 comparator: plans matched by ordinal, canonical
 * projection fields (available, languageKey, title, summary, hook, category,
 * captionText) compared exactly, and TimelineCuts matched by their
 * (startSec, endSec) tuple with stableID uniqueness validated as a separate
 * structural invariant (one fixture cut intentionally carries no stableID).
 * `fallbackProjection` is native-only (Slice 3): the test asserts only that
 * the fixture carries both projection keys. Negative cases mutate in-memory
 * fixture copies and require the comparator to fail.
 */

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const {
  activeShortsPlanProjection,
  normalizeShortsSessionState,
  parseShortsTimestamp,
} = require('../../shared/shorts-state');
const { compareShortsRenderContract } = require('../parity/comparators.mjs');

const FIXTURE_PATH = path.join(
  __dirname,
  '..',
  'fixtures',
  'parity',
  'shorts-render-contract.json',
);

function loadFixture() {
  return JSON.parse(fs.readFileSync(FIXTURE_PATH, 'utf8'));
}

/** Decode through the real Shorts projection + normalization path. */
function decodeRenderContract(fixture) {
  const normalizedPlans = normalizeShortsSessionState({
    shortsPlans: fixture.plans,
  }).shortsPlans.map((plan) => {
    // Binding-only projection: Electron normalizes `start`/`end` timestamps,
    // while the shared fixture carries the numeric clipRange wire fields.
    const start = parseShortsTimestamp(plan.start);
    const end = parseShortsTimestamp(plan.end);
    return {
      ...plan,
      clipRange: {
        startSec: start.ok ? start.seconds : null,
        endSec: end.ok ? end.seconds : null,
      },
    };
  });
  return {
    projections: fixture.plans.map(
      (plan) => activeShortsPlanProjection(plan, fixture.activeLanguage),
    ),
    normalizedPlans,
  };
}

test('shorts render contract fixture declares the shared parity harness version', () => {
  assert.equal(loadFixture().fixtureVersion, 1);
});

test('fixture carries both the canonical and the native-only fallback projection', () => {
  const fixture = loadFixture();
  assert.ok(
    Object.hasOwn(fixture, 'canonicalProjection')
      && Object.hasOwn(fixture, 'fallbackProjection'),
    'fixture must document both projection strategies (binding §4 divergence #1)',
  );
});

test('canonical projection of every plan matches the fixture through the real projection path', () => {
  const fixture = loadFixture();
  const decoded = decodeRenderContract(fixture);

  const comparison = compareShortsRenderContract(fixture, decoded);
  assert.deepEqual(
    comparison.failures,
    [],
    `shorts-render parity comparator reported drift:\n${comparison.failures.join('\n')}`,
  );
  assert.equal(comparison.ok, true);
});

test('plan without an active-language variant projects available:false with empty strings', () => {
  const fixture = loadFixture();
  assert.equal(fixture.plans[1].stableID, 'fixture-plan-02');

  const projection = activeShortsPlanProjection(fixture.plans[1], fixture.activeLanguage);
  assert.deepEqual(
    projection,
    {
      available: false,
      languageKey: 'russian',
      title: '',
      summary: '',
      hook: '',
      category: '',
      captionText: '',
      variant: null,
    },
    'strict active-language projection never borrows another language or base title',
  );
});

test('plan whose active variant lacks captionText projects an empty captionText', () => {
  const fixture = loadFixture();
  assert.equal(fixture.plans[2].stableID, 'fixture-plan-03');
  // The plan carries base/target caption text, but the strict projection
  // resolves ONLY translationsByLanguage[activeLanguage].
  assert.equal(fixture.plans[2].captionText, 'Fixture plan three caption text.');
  assert.equal(fixture.plans[2].targetCaptionText, 'Fixture plan three target caption text.');
  assert.equal(fixture.plans[2].translationsByLanguage.russian.captionText, undefined);

  const projection = activeShortsPlanProjection(fixture.plans[2], fixture.activeLanguage);
  assert.equal(projection.available, true);
  assert.equal(projection.title, 'Fixture Plan Three Russian Title');
  assert.equal(projection.captionText, '');
});

test('timeline cuts round-trip through the real normalizer with timing preserved and IDs minted', () => {
  const fixture = loadFixture();
  const normalized = normalizeShortsSessionState({ shortsPlans: fixture.plans }).shortsPlans;

  // Fixture invariant: plan-01's cut carries a stableID, plan-03's does not.
  assert.equal(fixture.plans[0].timelineCuts[0].stableID, 'fixture-cut-01');
  assert.equal(fixture.plans[2].timelineCuts[0].stableID, undefined);

  // Real normalizer mints the missing ID without changing the timing tuple.
  assert.equal(normalized[0].timelineCuts[0].stableID, 'fixture-cut-01');
  assert.equal(typeof normalized[2].timelineCuts[0].stableID, 'string');
  assert.notEqual(normalized[2].timelineCuts[0].stableID, '');
  assert.equal(normalized[2].timelineCuts[0].startSec, 22);
  assert.equal(normalized[2].timelineCuts[0].endSec, 23);
});

test('comparator fails when projection or cut timing content is mutated', () => {
  const fixture = loadFixture();
  const decoded = decodeRenderContract(fixture);

  const mutatedProjection = structuredClone(fixture);
  mutatedProjection.canonicalProjection.plans[0].title = 'Mutated title';
  const projectionComparison = compareShortsRenderContract(mutatedProjection, decoded);
  assert.equal(projectionComparison.ok, false);
  assert.ok(
    projectionComparison.failures.some((line) => line.includes('canonicalProjection.plans[0].title')),
    `expected a canonicalProjection.plans[0].title failure, got:\n${projectionComparison.failures.join('\n')}`,
  );

  const mutatedCuts = structuredClone(fixture);
  mutatedCuts.plans[0].timelineCuts[0].endSec = 9;
  const cutComparison = compareShortsRenderContract(mutatedCuts, decoded);
  assert.equal(cutComparison.ok, false);
  assert.ok(
    cutComparison.failures.some((line) => line.includes('timelineCuts[0]')),
    `expected a timelineCuts[0] failure, got:\n${cutComparison.failures.join('\n')}`,
  );
});
