'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const {
  normalizeShortsSessionState,
  activeShortsPlanProjection,
  validateShortsPlan,
} = require('../shared/shorts-state');

const nativeSessionFixture = JSON.parse(
  fs.readFileSync(path.join(__dirname, 'fixtures', 'shorts-session-native.json'), 'utf8'),
);

function makePlan(overrides = {}) {
  return {
    start: '00:00',
    end: '00:20',
    title: 'Base title',
    summary: 'Base summary',
    hook: 'Base hook',
    ...overrides,
  };
}

test('legacy IDs are adopted or minted and every plan id alias is stripped', () => {
  let calls = 0;
  const normalized = normalizeShortsSessionState({
    shortsPlans: [
      makePlan({ id: 'legacy-plan' }),
      makePlan({ title: 'Needs a new identity' }),
    ],
  }, () => `MINT-${++calls}`);

  assert.equal(normalized.shortsPlans[0].stableID, 'legacy-plan');
  assert.equal(normalized.shortsPlans[1].stableID, 'mint-1');
  assert.equal(normalized.shortsPlans[0].id, undefined);
  assert.equal(normalized.shortsPlans[1].id, undefined);
  assert.equal(calls, 1);
});

test('duplicate plan identities are replaced across active and rejected arrays', () => {
  const normalized = normalizeShortsSessionState({
    shortsPlans: [makePlan({ stableID: 'shared-id' })],
    shortsRejectedPlans: [makePlan({ stableID: 'shared-id', title: 'Rejected copy' })],
  }, () => 'REPLACEMENT-ID');

  assert.equal(normalized.shortsPlans[0].stableID, 'shared-id');
  assert.equal(normalized.shortsRejectedPlans[0].stableID, 'replacement-id');
});

test('missing and duplicate cut identities are minted per plan', () => {
  let calls = 0;
  const normalized = normalizeShortsSessionState({
    shortsPlans: [makePlan({
      stableID: 'plan-id',
      timelineCuts: [
        { startSec: 1, endSec: 2 },
        { stableID: 'cut-id', startSec: 2, endSec: 3 },
        { stableID: 'cut-id', startSec: 3, endSec: 4 },
      ],
    })],
  }, () => `CUT-${++calls}`);

  assert.deepEqual(
    normalized.shortsPlans[0].timelineCuts.map((cut) => cut.stableID),
    ['cut-1', 'cut-id', 'cut-2'],
  );
  assert.equal(normalized.shortsPlans[0].timelineCuts[0].id, undefined);
  assert.equal(calls, 2);
});

test('translation keys use D2 canonical language names with first collision winning', () => {
  const normalized = normalizeShortsSessionState({
    shortsPlans: [makePlan({
      stableID: 'plan-id',
      translationsByLanguage: {
        'de-DE': {
          language: 'de-DE',
          title: 'First German',
          summary: 'First summary',
          hook: 'First hook',
          provider: 'provider-a',
          updatedAt: '2026-01-01T00:00:00.000Z',
        },
        German: {
          language: 'German',
          title: 'Second German',
          summary: 'Second summary',
          hook: 'Second hook',
          provider: 'provider-b',
          updatedAt: '2026-02-01T00:00:00.000Z',
        },
      },
    })],
  });

  assert.deepEqual(normalized.shortsPlans[0].translationsByLanguage, {
    german: {
      language: 'German',
      title: 'First German',
      summary: 'First summary',
      hook: 'First hook',
      provider: 'provider-a',
      updatedAt: '2026-01-01T00:00:00.000Z',
    },
  });
});

test('active variant seeding covers target, bilingual, and source plans', () => {
  const target = normalizeShortsSessionState({
    activeTranslationLanguage: 'Russian',
    shortsPlans: [makePlan({
      stableID: 'target',
      languageMode: 'target',
      targetTitle: 'Target title',
      targetSummary: 'Target summary',
      targetHook: 'Target hook',
    })],
  });
  const bilingual = normalizeShortsSessionState({
    activeTranslationLanguage: 'Russian',
    shortsPlans: [makePlan({ stableID: 'bilingual', languageMode: 'bilingual' })],
  });
  const source = normalizeShortsSessionState({
    activeTranslationLanguage: 'Russian',
    shortsPlans: [makePlan({ stableID: 'source', languageMode: 'source' })],
  });

  assert.equal(target.shortsPlans[0].translationsByLanguage.russian.title, 'Target title');
  assert.equal(bilingual.shortsPlans[0].translationsByLanguage.russian.title, 'Base title');
  assert.equal(source.shortsPlans[0].translationsByLanguage, undefined);
});

test('existing German and Russian archives stay untouched when French is active', () => {
  const german = {
    language: 'German',
    title: 'German title',
    summary: 'German summary',
    hook: 'German hook',
    provider: 'provider-de',
    updatedAt: '2026-08-26T00:00:00.000Z',
  };
  const russian = {
    language: 'Russian',
    title: 'Russian title',
    summary: 'Russian summary',
    hook: 'Russian hook',
    provider: 'provider-ru',
    updatedAt: '2026-08-26T01:00:00.000Z',
  };
  const normalized = normalizeShortsSessionState({
    activeTranslationLanguage: 'French',
    shortsPlans: [makePlan({
      stableID: 'archived-plan',
      languageMode: 'bilingual',
      targetTitle: 'German title',
      targetSummary: 'German summary',
      targetHook: 'German hook',
      translationsByLanguage: { german, russian },
    })],
  });
  const plan = normalized.shortsPlans[0];
  const archive = plan.translationsByLanguage;

  assert.equal(Object.prototype.hasOwnProperty.call(archive, 'french'), false);
  assert.equal(JSON.stringify(archive.german), JSON.stringify(german));
  assert.equal(JSON.stringify(archive.russian), JSON.stringify(russian));

  const projection = activeShortsPlanProjection(plan, 'French');
  assert.equal(projection.available, false);
  const validation = validateShortsPlan(plan, {
    projection: 'target',
    activeLanguage: 'French',
    session: { activeTranslationLanguage: 'French' },
  });
  assert.equal(validation.issues.some((issue) => issue.code === 'MISSING_TARGET_VARIANT'), true);

  const switched = normalizeShortsSessionState({
    ...normalized,
    activeTranslationLanguage: 'German',
  });
  assert.deepEqual(switched.shortsPlans[0].translationsByLanguage, archive);
  assert.equal(Object.prototype.hasOwnProperty.call(
    switched.shortsPlans[0].translationsByLanguage,
    'french',
  ), false);
});

test('true legacy empty-archive seeding occurs once and survives a language switch', () => {
  const seeded = normalizeShortsSessionState({
    activeTranslationLanguage: 'Russian',
    shortsPlans: [makePlan({
      stableID: 'legacy-target',
      languageMode: 'target',
      targetTitle: 'Legacy target title',
      targetSummary: 'Legacy target summary',
      targetHook: 'Legacy target hook',
    })],
  });
  const seededArchive = seeded.shortsPlans[0].translationsByLanguage;

  assert.deepEqual(Object.keys(seededArchive), ['russian']);
  assert.equal(seededArchive.russian.title, 'Legacy target title');

  const switched = normalizeShortsSessionState({
    ...seeded,
    activeTranslationLanguage: 'German',
  });
  assert.deepEqual(switched.shortsPlans[0].translationsByLanguage, seededArchive);
  assert.equal(Object.prototype.hasOwnProperty.call(
    switched.shortsPlans[0].translationsByLanguage,
    'german',
  ), false);

  const normalizedAgain = normalizeShortsSessionState(switched);
  assert.deepEqual(normalizedAgain.shortsPlans[0].translationsByLanguage, seededArchive);
});


test('languageMode inference follows source, target, bilingual, and active-language rules', () => {
  const modeFor = (overrides, session = { activeTranslationLanguage: 'Russian' }) => normalizeShortsSessionState({
    ...session,
    shortsPlans: [makePlan({ stableID: 'plan-id', ...overrides })],
  }).shortsPlans[0].languageMode;

  assert.equal(modeFor({ sourceTitle: 'Source' }), 'source');
  assert.equal(modeFor({ targetTitle: 'Target' }), 'target');
  assert.equal(modeFor({ sourceTitle: 'Source', targetTitle: 'Target' }), 'bilingual');
  assert.equal(modeFor({ targetTitle: 'Target' }, {}), 'source');
  assert.equal(modeFor({ targetTitle: 'Target' }, { targetLang: 'Russian' }), 'target');
});

test('missing rejected plans normalize to an empty durable array', () => {
  const normalized = normalizeShortsSessionState({
    shortsPlans: makePlan(),
    shortsRejectedPlans: { stableID: 'not-an-array' },
  });

  assert.deepEqual(normalized.shortsPlans, []);
  assert.deepEqual(normalized.shortsRejectedPlans, []);
});

test('legacy index selection is ingress-only and never survives normalization', () => {
  const normalized = normalizeShortsSessionState({
    selectedShortsPlanIndexes: [0, 2],
    shortsPlans: [makePlan({ stableID: 'plan-id' })],
  });

  assert.equal(Object.prototype.hasOwnProperty.call(normalized, 'selectedShortsPlanIndexes'), false);
});

test('normalization is deep-clone idempotent and does not mint on the second pass', () => {
  let firstCalls = 0;
  const first = normalizeShortsSessionState({
    activeTranslationLanguage: 'Russian',
    shortsPlans: [makePlan({
      id: 'legacy-id',
      languageMode: 'target',
      timelineCuts: [{ startSec: 1, endSec: 2 }],
    })],
  }, () => `ID-${++firstCalls}`);
  let secondCalls = 0;
  const second = normalizeShortsSessionState(first, () => {
    secondCalls += 1;
    return 'must-not-be-used';
  });

  assert.deepEqual(second, first);
  assert.equal(firstCalls, 1);
  assert.equal(secondCalls, 0);
});

test('O2-SHT-09 normalizes a native-shaped Session fixture without minting identities', () => {
  const originalFixture = JSON.parse(JSON.stringify(nativeSessionFixture));
  assert.equal(nativeSessionFixture.schemaVersion, undefined);
  assert.equal(nativeSessionFixture.project, undefined);
  let mintCalls = 0;
  const normalized = normalizeShortsSessionState(nativeSessionFixture, () => {
    mintCalls += 1;
    return `unexpected-mint-${mintCalls}`;
  });

  assert.equal(mintCalls, 0);
  assert.deepEqual(nativeSessionFixture, originalFixture);
  assert.deepEqual(
    normalized.shortsPlans.map((plan) => plan.stableID),
    ['aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'],
  );
  assert.deepEqual(
    normalized.shortsRejectedPlans.map((plan) => plan.stableID),
    ['bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb'],
  );
  assert.deepEqual(Object.keys(normalized.shortsPlans[0].translationsByLanguage), ['german', 'russian']);
  assert.equal(normalized.shortsPlans[0].translationsByLanguage.german.provider, 'native-provider-de');
  assert.equal(normalized.shortsPlans[0].translationsByLanguage.russian.updatedAt, '2026-08-26T02:00:00.000Z');
  assert.deepEqual(normalized.shortsPlans[0].subtitleStyle, nativeSessionFixture.shortsPlans[0].subtitleStyle);
  assert.deepEqual(normalized.shortsPlans[0].timelineCuts, nativeSessionFixture.shortsPlans[0].timelineCuts);
  assert.deepEqual(normalized.shortsRejectedPlans, nativeSessionFixture.shortsRejectedPlans);
  assert.equal(Object.prototype.hasOwnProperty.call(normalized, 'selectedShortsPlanIndexes'), false);

  let secondMintCalls = 0;
  const second = normalizeShortsSessionState(normalized, () => {
    secondMintCalls += 1;
    return 'must-not-mint';
  });
  assert.deepEqual(second, normalized);
  assert.equal(secondMintCalls, 0);
});
