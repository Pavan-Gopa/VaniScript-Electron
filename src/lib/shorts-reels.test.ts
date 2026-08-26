import test from 'node:test';
import assert from 'node:assert/strict';
import {
  appendNonOverlappingShortsPlans,
  attachShortsPlanActiveTranslation,
  buildShortsPrompt,
  collectAvailableShortsTranslationLanguages,
  applyShortsRejectedLedgerPolicy,
  parseShortsMetadataResponse,
  parseShortsPlanResponse,
  parseShortsTimestamp,
  projectShortsPlanForLanguage,
  selectShortsPlanProjection,
  selectShortsSourceProjection,
  selectShortsTargetProjection,
  shortsAlignmentMatchesCaption,
  replaceShortsPlanRange,
  replaceShortsPlanRangeChecked,
  removeShortsPlanToRejectedLedger,
  restoreShortsPlanFromRejectedLedger,
  shortsPlanExportLanguages,
  shortsSelectionKey,
  sortShortsSelectionKeys,
  updateShortsPlanTargetMetadata,
  upsertShortsPlanTranslation,
  validateShortsExportSelection,
  validateShortsPlan,
  validateShortsPlanRestore,
  validateShortsPlanSettings,
  resolveShortsSourceDuration,
} from './shorts-reels';
import type { NormalizedShortsClipPlan, NormalizedTimelineCut, ShortsClipPlan } from './shorts-reels';
type NormalizedShortsTestPlan = Omit<NormalizedShortsClipPlan, 'timelineCuts'>
  & Record<string, unknown>
  & {
    timelineCuts?: Array<NormalizedTimelineCut & { id?: string }>;
  };
type NormalizedShortsTestSession = Record<string, unknown> & {
  shortsPlans: NormalizedShortsTestPlan[];
  shortsRejectedPlans: NormalizedShortsTestPlan[];
};
const { normalizeShortsSessionState } = require('../../shared/shorts-state.js') as {
  normalizeShortsSessionState: (session: Record<string, unknown>, idFactory?: () => string) => NormalizedShortsTestSession;
};

test('buildShortsPrompt includes duration, count, language, and Vaishnava criteria', () => {
  const prompt = buildShortsPrompt({
    transcript: '[00:12] Take shelter of Krishna.',
    count: 3,
    minDurationSec: 45,
    maxDurationSec: 90,
    outputLanguage: 'Russian',
  });

  assert.match(prompt, /3/);
  assert.match(prompt, /45/);
  assert.match(prompt, /90/);
  assert.match(prompt, /Russian/);
  assert.match(prompt, /Vaishnava/i);
  assert.match(prompt, /JSON/);
  assert.match(prompt, /captionText/);
  assert.match(prompt, /1\.5-4 seconds/);
  assert.match(prompt, /Never put a whole 45-180 second clip into one or two caption cues/);
});

test('parseShortsPlanResponse extracts JSON array from model text', () => {
  const clips = parseShortsPlanResponse('```json\n[{ "start": "00:01:00", "end": "00:02:00", "title": "Shelter", "summary": "A strong moment.", "hook": "Clear spiritual advice.", "captionText": "[01:00] Take shelter\\n[01:03] of Krishna" }]\n```');
  assert.equal(clips.length, 1);
  assert.equal(clips[0].start, '00:01:00');
  assert.equal(clips[0].title, 'Shelter');
  assert.equal(clips[0].captionText, '[01:00] Take shelter\n[01:03] of Krishna');
});

test('bilingual Shorts prompt requests aligned source and target caption scripts', () => {
  const prompt = buildShortsPrompt({
    transcript: '[04:56]\nSource: Build Mayapur.\nTarget: Стройте Майяпур.',
    count: 1,
    minDurationSec: 30,
    maxDurationSec: 60,
    outputLanguage: 'Russian',
    mode: 'bilingual',
  });

  assert.match(prompt, /sourceCaptionText/);
  assert.match(prompt, /targetCaptionText/);
  assert.match(prompt, /same timestamp markers/);
});

test('buildShortsPrompt asks the planner to avoid existing clip ranges', () => {
  const prompt = buildShortsPrompt({
    transcript: '[05:23] Existing moment.\n\n[07:00] New moment.',
    count: 2,
    minDurationSec: 30,
    maxDurationSec: 90,
    outputLanguage: 'Russian',
    mode: 'bilingual',
    existingClips: [
      { start: '05:23', end: '06:49', title: 'Economy of giving' },
    ],
  });

  assert.match(prompt, /Already selected ranges/i);
  assert.match(prompt, /05:23 -> 06:49/);
  assert.match(prompt, /Do not choose moments that overlap/i);
});

test('appendNonOverlappingShortsPlans preserves existing edited clips and appends new ranges', () => {
  const existing = [{
    start: '05:23',
    end: '06:49',
    title: 'Keep this edited clip',
    summary: 'Already edited.',
    hook: 'Keep it.',
    sourceAlignment: [{ id: 'sub-1', start: 0, end: 3, text: 'Edited captions', words: [] }],
  }];
  const incoming = [
    { start: '05:30', end: '06:30', title: 'Duplicate range', summary: '', hook: '' },
    { start: '07:10', end: '08:10', title: 'Fresh range', summary: '', hook: '' },
  ];

  const result = appendNonOverlappingShortsPlans(existing, incoming);

  assert.equal(result.plans.length, 2);
  assert.strictEqual(result.plans[0], existing[0]);
  assert.equal(result.plans[1].title, 'Fresh range');
  assert.deepEqual(result.addedIndexes, [1]);
  assert.equal(result.skippedOverlapping.length, 1);
  assert.equal(result.skippedOverlapping[0].title, 'Duplicate range');
});

test('appendNonOverlappingShortsPlans filters overlapping incoming candidates against newly added clips', () => {
  const result = appendNonOverlappingShortsPlans([], [
    { start: '01:00', end: '02:00', title: 'First', summary: '', hook: '' },
    { start: '01:30', end: '02:20', title: 'Overlaps first', summary: '', hook: '' },
    { start: '02:02', end: '02:45', title: 'Adjacent fresh range', summary: '', hook: '' },
  ]);

  assert.deepEqual(result.plans.map((plan) => plan.title), ['First']);
  assert.deepEqual(result.addedIndexes, [0]);
  assert.deepEqual(result.skippedOverlapping.map((plan) => plan.title), ['Overlaps first', 'Adjacent fresh range']);
});

test('replaceShortsPlanRange clears stale generated captions so subtitles rebuild from transcript cues', () => {
  const replaced = replaceShortsPlanRange({
    start: '00:48',
    end: '01:48',
    title: 'Generated clip',
    summary: 'Good moment.',
    hook: 'Strong hook.',
    captionText: '[00:48] Old target caption',
    sourceCaptionText: '[00:48] Old source caption',
    targetCaptionText: '[00:48] Old target caption',
    sourceAlignment: [{ id: 'source-sub', start: 0, end: 2, text: 'Old source', words: [] }],
    targetAlignment: [{ id: 'target-sub', start: 0, end: 2, text: 'Old target', words: [] }],
    sourceFrameKeyframes: [{ id: 'kf', time: 0, x: 50, y: 50, zoom: 1 }],
    timelineCuts: [{ startSec: 5, endSec: 8 }],
    timelineTrim: { trimStartSec: 2, trimEndSec: 1 },
    syncEnabled: true,
  }, '00:30', '01:48');

  assert.equal(replaced.start, '00:30');
  assert.equal(replaced.end, '01:48');
  assert.equal(replaced.captionText, undefined);
  assert.equal(replaced.sourceCaptionText, undefined);
  assert.equal(replaced.targetCaptionText, undefined);
  assert.equal(replaced.sourceAlignment, undefined);
  assert.equal(replaced.targetAlignment, undefined);
  assert.deepEqual(replaced.timelineCuts, []);
  assert.deepEqual(replaced.timelineTrim, { trimStartSec: 0, trimEndSec: 0 });
  assert.deepEqual(replaced.sourceFrameKeyframes, [{ id: 'kf', time: 0, x: 50, y: 50, zoom: 1 }]);
  assert.equal(replaced.syncEnabled, true);
});

test('strict Shorts timestamp parser canonicalizes valid input and rejects malformed components', () => {
  assert.deepEqual(parseShortsTimestamp('[09:55]'), {
    ok: true,
    seconds: 595,
    canonical: '09:55',
  });
  assert.equal(parseShortsTimestamp('01:02:03.9').seconds, 3723);
  assert.equal(parseShortsTimestamp('00:60').ok, false);
  assert.equal(parseShortsTimestamp('01:60:00').ok, false);
  assert.equal(parseShortsTimestamp('Infinity').ok, false);
});

test('validateShortsPlan rejects clips outside requested duration', () => {
  assert.equal(validateShortsPlan(makePlan({ start: '01:00', end: '02:00' }), { minDurationSec: 45, maxDurationSec: 90 }).valid, true);
  assert.equal(validateShortsPlan(makePlan({ start: '01:00', end: '03:20' }), { minDurationSec: 45, maxDurationSec: 90 }).valid, false);
});

const makePlan = (overrides: Record<string, unknown> = {}): ShortsClipPlan => ({
  start: '00:00',
  end: '00:20',
  title: 'Base title',
  summary: 'Base summary',
  hook: 'Base hook',
  ...overrides,
});

test('normalizer output is assignable to the canonical Shorts plan type', () => {
  const normalized = normalizeShortsSessionState({
    shortsPlans: [makePlan({ stableID: 'canonical-plan' })],
  }, () => 'unused');
  const canonical: NormalizedShortsClipPlan = normalized.shortsPlans[0];
  assert.equal(canonical.stableID, 'canonical-plan');
  assert.equal(canonical.languageMode, 'source');
});

test('normalizes legacy plan IDs, strips aliases, and mints duplicate identities', () => {
  let nextID = 0;
  const normalized = normalizeShortsSessionState({
    selectedShortsPlanIndexes: [0],
    shortsPlans: [
      makePlan({ id: 'legacy-plan' }),
      makePlan({ stableID: 'legacy-plan', title: 'Duplicate' }),
      makePlan({ title: 'Missing identity' }),
    ],
  }, () => `MINT-${++nextID}`);

  assert.equal(normalized.selectedShortsPlanIndexes, undefined);
  assert.equal(normalized.shortsPlans[0].stableID, 'legacy-plan');
  assert.equal(normalized.shortsPlans[0].id, undefined);
  assert.equal(normalized.shortsPlans[1].stableID, 'mint-1');
  assert.equal(normalized.shortsPlans[2].stableID, 'mint-2');
  assert.equal(nextID, 2);
});

test('normalizes missing and duplicate timeline cut IDs within each plan', () => {
  let nextID = 0;
  const normalized = normalizeShortsSessionState({
    shortsPlans: [makePlan({
      stableID: 'plan-1',
      timelineCuts: [
        { startSec: 1, endSec: 2 },
        { stableID: 'cut-1', startSec: 2, endSec: 3 },
        { stableID: 'cut-1', startSec: 3, endSec: 4 },
      ],
    })],
  }, () => `cut-${++nextID}`);

  assert.deepEqual(normalized.shortsPlans[0].timelineCuts?.map((cut) => cut.stableID), ['cut-1', 'cut-2', 'cut-3']);
  assert.equal(normalized.shortsPlans[0].timelineCuts?.[0]?.id, undefined);
  assert.equal(nextID, 3);
});

test('canonicalizes translation keys with first-entry collision wins and preserves provenance', () => {
  const normalized = normalizeShortsSessionState({
    activeTranslationLanguage: 'de-DE',
    shortsPlans: [makePlan({
      stableID: 'plan-1',
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
  }, () => 'unused');

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

test('seeds the exact active variant only from target or eligible base fields', () => {
  const target = normalizeShortsSessionState({
    activeTranslationLanguage: 'Russian',
    shortsPlans: [makePlan({
      stableID: 'target',
      languageMode: 'target',
      targetTitle: 'Target title',
      targetSummary: 'Target summary',
      targetHook: 'Target hook',
    })],
  }, () => 'unused');
  const bilingual = normalizeShortsSessionState({
    activeTranslationLanguage: 'Russian',
    shortsPlans: [makePlan({
      stableID: 'bilingual',
      languageMode: 'bilingual',
    })],
  }, () => 'unused');
  const source = normalizeShortsSessionState({
    activeTranslationLanguage: 'Russian',
    shortsPlans: [makePlan({
      stableID: 'source',
      languageMode: 'source',
    })],
  }, () => 'unused');

  assert.equal(target.shortsPlans[0].translationsByLanguage?.russian?.title, 'Target title');
  assert.equal(bilingual.shortsPlans[0].translationsByLanguage?.russian?.title, 'Base title');
  assert.equal(source.shortsPlans[0].translationsByLanguage, undefined);
});

test('infers language mode from source/target evidence and active language', () => {
  const normalizeMode = (overrides: Record<string, unknown>, session: Record<string, unknown> = { activeTranslationLanguage: 'Russian' }) =>
    normalizeShortsSessionState({
      ...session,
      shortsPlans: [makePlan({ stableID: 'plan-1', ...overrides })],
    }, () => 'unused').shortsPlans[0].languageMode;

  assert.equal(normalizeMode({ sourceTitle: 'Source title' }), 'source');
  assert.equal(normalizeMode({ targetTitle: 'Target title' }), 'target');
  assert.equal(normalizeMode({ sourceTitle: 'Source title', targetTitle: 'Target title' }), 'bilingual');
  assert.equal(normalizeMode({ targetTitle: 'Target title' }, { targetLang: 'Russian' }), 'target');
  assert.equal(normalizeMode({ targetTitle: 'Target title' }, {}), 'source');
});

test('normalizes rejected plans as a first-class array and is idempotent', () => {
  let firstCalls = 0;
  const first = normalizeShortsSessionState({
    shortsPlans: [makePlan({ stableID: 'active-1' })],
    shortsRejectedPlans: [makePlan({ stableID: 'rejected-1' })],
    selectedShortsPlanIndexes: [1],
  }, () => `mint-${++firstCalls}`);
  assert.deepEqual(first.shortsRejectedPlans.map((plan) => plan.stableID), ['rejected-1']);

  assert.equal(first.selectedShortsPlanIndexes, undefined);
  assert.deepEqual(normalizeShortsSessionState({ shortsPlans: makePlan() }).shortsRejectedPlans, []);

  let secondCalls = 0;
  const second = normalizeShortsSessionState(first, () => {
    secondCalls += 1;
    return 'must-not-mint';
  });
  assert.deepEqual(second, first);
  assert.equal(secondCalls, 0);
});
test('O2-SHT-02 rejects invalid timing atomically across create, replace, and export preflight', () => {
  const sourceSession = {
    sourceMediaInfo: { durationSec: 1000 },
    chunks: [{ endSec: 1000 }],
  };
  const cases = [
    { name: 'malformed', start: '[00:10', end: '00:20', valid: false },
    { name: 'negative', start: '-1', end: '00:10', valid: false },
    { name: 'zero-duration', start: '00:10', end: '00:10', valid: false },
    { name: 'reversed', start: '00:20', end: '00:10', valid: false },
    { name: 'NaN', start: 'NaN', end: '00:20', valid: false },
    { name: 'Infinity', start: 'Infinity', end: '00:20', valid: false },
    { name: 'nine-seconds', start: '00:00', end: '00:09', valid: false },
    { name: 'ten-seconds', start: '00:00', end: '00:10', valid: true },
    { name: 'three-hundred-seconds', start: '00:00', end: '05:00', valid: true },
    { name: 'three-hundred-one-seconds', start: '00:00', end: '05:01', valid: false },
    { name: 'beyond-media', start: '01:30', end: '01:41', sourceDurationSec: 100, valid: false },
    { name: 'exact-media-end', start: '01:30', end: '01:40', sourceDurationSec: 100, valid: true },
  ];

  for (const timing of cases) {
    const options = {
      session: sourceSession,
      sourceDurationSec: timing.sourceDurationSec ?? undefined,
      minDurationSec: 10,
      maxDurationSec: 300,
    };
    const plan = makePlan({ stableID: `candidate-${timing.name}`, start: timing.start, end: timing.end });
    const created = appendNonOverlappingShortsPlans([], [plan], 1, options);
    assert.equal(created.addedIndexes.length, timing.valid ? 1 : 0, `${timing.name}: create`);
    if (!timing.valid) assert.deepEqual(created.plans, [], `${timing.name}: create is atomic`);

    const replacementBase = makePlan({
      stableID: `replace-${timing.name}`,
      start: '00:10',
      end: '00:30',
      captionText: 'Existing caption',
      timelineCuts: [{ startSec: 2, endSec: 4 }],
    });
    const beforeReplacement = JSON.parse(JSON.stringify(replacementBase));
    const replaced = replaceShortsPlanRangeChecked(
      replacementBase,
      timing.start,
      timing.end,
      options
    );
    assert.equal(replaced.success, timing.valid, `${timing.name}: replace`);
    assert.deepEqual(replacementBase, beforeReplacement, `${timing.name}: replace is atomic`);

    const preflight = validateShortsExportSelection([{ plan, language: 'source' }], options);
    assert.equal(preflight.valid, timing.valid, `${timing.name}: preflight`);
    if (!timing.valid) {
      assert.equal(preflight.results[0].valid, false, `${timing.name}: preflight rejects unit`);
    }
  }
});

test('Shorts plan validation enforces finite cut bounds and preserves exact identities', () => {
  const cases = [
    { name: 'negative', startSec: -0.1, endSec: 2 },
    { name: 'reversed', startSec: 5, endSec: 5 },
    { name: 'outside', startSec: 1, endSec: 21 },
    { name: 'nan', startSec: Number.NaN, endSec: 2 },
    { name: 'infinity', startSec: 1, endSec: Number.POSITIVE_INFINITY },
  ];
  for (const timing of cases) {
    const result = validateShortsPlan(makePlan({
      stableID: `cut-${timing.name}`,
      timelineCuts: [{ stableID: `cut-id-${timing.name}`, startSec: timing.startSec, endSec: timing.endSec }],
    }));
    const issue = result.issues.find((item) => item.code === 'INVALID_CUT');
    assert.ok(issue, `${timing.name}: invalid cut issue`);
    assert.equal(issue?.entityId, `cut-id-${timing.name}`, `${timing.name}: stable cut identity`);
  }
  const valid = validateShortsPlan(makePlan({
    stableID: 'cut-valid',
    timelineCuts: [{ stableID: 'cut-valid-id', startSec: 0, endSec: 20 }],
  }));
  assert.equal(valid.valid, true);
  assert.equal(valid.issues.some((item) => item.code === 'INVALID_CUT'), false);
});

test('target operations require the exact active archive variant', () => {
  const plan = makePlan({
    stableID: 'target-plan',
    languageMode: 'bilingual',
    translationsByLanguage: {
      russian: {
        language: 'Russian',
        title: 'Russian title',
        summary: 'Russian summary',
        hook: 'Russian hook',
        captionText: 'Russian captions',
      },
    },
  });
  const options = { activeLanguage: 'German', session: { activeTranslationLanguage: 'German' } };
  const validation = validateShortsPlan(plan, { ...options, projection: 'target' });
  assert.equal(validation.valid, false);
  assert.equal(validation.issues.some((item) => item.code === 'MISSING_TARGET_VARIANT'), true);
  const replaced = replaceShortsPlanRangeChecked(plan, '00:10', '00:30', options);
  assert.equal(replaced.success, false);
  if (!replaced.success) assert.equal(replaced.code, 'MISSING_TARGET_VARIANT');
  const preflight = validateShortsExportSelection([{ plan, language: 'target' }], options);
  assert.equal(preflight.valid, false);
  assert.equal(preflight.issues.some((item) => item.code === 'MISSING_TARGET_VARIANT'), true);

  const exact = validateShortsExportSelection([{
    plan,
    language: 'target',
  }], {
    activeLanguage: 'Russian',
    session: { activeTranslationLanguage: 'Russian' },
  });
  assert.equal(exact.valid, true);
});

test('persist-normalize keeps German and Russian archives exact while French target stays unavailable', () => {
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

  assert.equal(plan.translationsByLanguage?.french, undefined);
  assert.equal(JSON.stringify(plan.translationsByLanguage?.german), JSON.stringify(german));
  assert.equal(JSON.stringify(plan.translationsByLanguage?.russian), JSON.stringify(russian));

  const projection = selectShortsTargetProjection(plan, 'French');
  assert.equal(projection.available, false);
  const validation = validateShortsPlan(plan, {
    projection: 'target',
    activeLanguage: 'French',
    session: { activeTranslationLanguage: 'French' },
  });
  assert.equal(validation.issues.some((item) => item.code === 'MISSING_TARGET_VARIANT'), true);

  const switched = normalizeShortsSessionState({
    ...normalized,
    activeTranslationLanguage: 'German',
  });
  assert.deepEqual(switched.shortsPlans[0].translationsByLanguage, plan.translationsByLanguage);
});


test('padded active and rejected exclusions reject only overlaps greater than one second', () => {
  const active = makePlan({ stableID: 'active', start: '01:00', end: '01:20' });
  const rejected = makePlan({ stableID: 'rejected', start: '02:00', end: '02:20' });
  const candidateAtBoundary = makePlan({ stableID: 'boundary', start: '01:35', end: '01:45' });
  const boundary = validateShortsPlan(candidateAtBoundary, {
    activePlans: [active],
    rejectedPlans: [rejected],
  });
  assert.equal(boundary.issues.some((item) => item.code === 'OVERLAP_ACTIVE'), false);
  const candidate = makePlan({ stableID: 'overlap', start: '01:33', end: '01:45' });
  const overlap = validateShortsPlan(candidate, {
    activePlans: [active],
    rejectedPlans: [rejected],
  });
  assert.equal(overlap.valid, false);
  const rejectedCandidate = makePlan({ stableID: 'rejected-overlap', start: '02:33', end: '02:45' });

  const rejectedResult = validateShortsPlan(rejectedCandidate, { rejectedPlans: [rejected] });
  assert.equal(rejectedResult.issues.some((item) => item.code === 'OVERLAP_REJECTED'), true);
});

test('AI duration settings are inclusive and bounded', () => {
  assert.equal(validateShortsPlanSettings(10, 300).ok, true);
  assert.equal(validateShortsPlanSettings(9, 300).ok, false);
  assert.equal(validateShortsPlanSettings(10, 301).ok, false);
  assert.equal(validateShortsPlanSettings(301, 10).ok, false);
  assert.equal(validateShortsPlanSettings(Number.NaN, 300).ok, false);
});

test('source duration resolution follows persisted precedence and chunk fallback', () => {
  assert.equal(resolveShortsSourceDuration({
    sourceMediaInfo: { durationSec: 80 },
    durationSec: 90,
    chunks: [{ endSec: 100 }],
  }), 80);
  assert.equal(resolveShortsSourceDuration({
    sourceMediaInfo: { durationSec: 0 },
    durationSec: 90,
    chunks: [{ endSec: 100 }],
  }), 90);
  assert.equal(resolveShortsSourceDuration({
    chunks: [{ endSec: 100 }, { endSec: Number.NaN }, { endSec: 120 }],
  }), 120);
  assert.equal(resolveShortsSourceDuration({
    sourceMediaInfo: { durationSec: -1 },
    durationSec: 0,
    chunks: [{ endSec: 0 }],
  }), null);
});

test('restore validation excludes the restored ledger object but enforces active and rejected conflicts', () => {
  const restored = makePlan({ stableID: 'restored', start: '01:00', end: '01:20' });
  const activeConflict = makePlan({ stableID: 'active-conflict', start: '01:30', end: '01:50' });
  const rejectedConflict = makePlan({ stableID: 'rejected-conflict', start: '01:30', end: '01:50' });
  const result = validateShortsPlanRestore(restored, {
    activePlans: [activeConflict],
    rejectedPlans: [restored, rejectedConflict],
  });
  assert.equal(result.valid, false);
  assert.equal(result.issues.some((item) => item.code === 'OVERLAP_ACTIVE'), true);
  assert.equal(result.issues.some((item) => item.code === 'OVERLAP_REJECTED'), true);

  const isolated = validateShortsPlanRestore(restored, { rejectedPlans: [restored] });
  assert.equal(isolated.valid, true);
});

test('plan validation reports projection metadata with warning-only empty captions', () => {
  const emptyTitle = validateShortsPlan(makePlan({ title: '   ' }));
  assert.equal(emptyTitle.valid, false);
  assert.equal(emptyTitle.issues.some((item) => item.code === 'EMPTY_TITLE' && item.severity === 'error'), true);

  const emptyCaptions = validateShortsPlan(makePlan({ title: 'Valid title' }));
  assert.equal(emptyCaptions.valid, true);
  assert.equal(emptyCaptions.issues.some((item) => item.code === 'EMPTY_CAPTIONS' && item.severity === 'warning'), true);
});
test('O2-SHT-03 moves complete plans into a capped rejected ledger and restores atomically', () => {
  const removedPlan = makePlan({
    stableID: 'removed-plan',
    start: '00:40',
    end: '01:00',
    languageMode: 'bilingual',
    sourceTitle: 'Source title',
    sourceSummary: 'Source summary',
    sourceHook: 'Source hook',
    sourceCaptionText: 'Source captions',
    targetTitle: 'Russian title',
    targetSummary: 'Russian summary',
    targetHook: 'Russian hook',
    targetCaptionText: 'Russian captions',
    translationsByLanguage: {
      russian: {
        language: 'Russian',
        title: 'Russian title',
        summary: 'Russian summary',
        hook: 'Russian hook',
        captionText: 'Russian captions',
        provider: 'provider-a',
        updatedAt: '2026-08-26T00:00:00.000Z',
      },
    },
    subtitleStyle: { fontFamily: 'Cuprum', subtitleBottomMargin: 560 },
    sourceAlignment: [{ id: 'source-cue', start: 0, end: 2, text: 'Source', words: [] }],
    timelineCuts: [{ stableID: 'cut-1', startSec: 2, endSec: 4 }],
  });
  const olderSameRange = makePlan({
    stableID: 'older-same-range',
    start: '[00:40]',
    end: '01:00',
    title: 'Older rejected copy',
  });
  const removed = removeShortsPlanToRejectedLedger({
    activeTranslationLanguage: 'Russian',
    shortsPlans: [removedPlan],
    shortsRejectedPlans: [olderSameRange],
  }, 'removed-plan');
  assert.equal(removed.success, true);
  if (!removed.success) return;
  assert.deepEqual(removed.session.shortsPlans, []);
  assert.equal(removed.plan.stableID, 'removed-plan');
  assert.equal(removed.session.shortsRejectedPlans.length, 1);
  assert.equal(removed.session.shortsRejectedPlans[0].stableID, 'removed-plan');
  assert.deepEqual(removed.session.shortsRejectedPlans[0].translationsByLanguage, removedPlan.translationsByLanguage);
  assert.deepEqual(removed.session.shortsRejectedPlans[0].sourceAlignment, removedPlan.sourceAlignment);
  assert.deepEqual(removed.session.shortsRejectedPlans[0].timelineCuts, removedPlan.timelineCuts);
  assert.deepEqual(removed.session.shortsRejectedPlans[0].subtitleStyle, removedPlan.subtitleStyle);

  const capped = applyShortsRejectedLedgerPolicy({
    shortsPlans: [],
    shortsRejectedPlans: Array.from({ length: 52 }, (_, index) => makePlan({
      stableID: `rejected-${index}`,
      start: secondsToShortsTimestampForTest(index * 20),
      end: secondsToShortsTimestampForTest(index * 20 + 20),
      title: `Rejected ${index}`,
    })),
  });
  assert.equal(capped.shortsRejectedPlans.length, 50);
  assert.deepEqual(
    capped.shortsRejectedPlans.slice(0, 2).map((plan) => plan.stableID),
    ['rejected-2', 'rejected-3']
  );
  assert.equal(capped.shortsRejectedPlans.at(-1)?.stableID, 'rejected-51');

  const loaded = normalizeShortsSessionState(removed.session as Record<string, unknown>);
  assert.deepEqual(
    loaded.shortsRejectedPlans.map((plan) => plan.stableID),
    ['removed-plan']
  );
  assert.deepEqual(loaded.shortsRejectedPlans[0], removed.session.shortsRejectedPlans[0]);

  const activeExclusion = makePlan({ stableID: 'active-exclusion', start: '01:40', end: '02:00' });
  const rejectedExclusion = makePlan({ stableID: 'rejected-exclusion', start: '03:00', end: '03:20' });
  const regeneration = appendNonOverlappingShortsPlans([], [
    makePlan({ stableID: 'inside-active-window', start: '02:10', end: '02:20' }),
    makePlan({ stableID: 'fresh-range', start: '02:30', end: '02:45' }),
    makePlan({ stableID: 'inside-rejected-window', start: '03:25', end: '03:35' }),
  ], {
    activePlans: [activeExclusion],
    rejectedPlans: [rejectedExclusion],
  });
  assert.deepEqual(regeneration.plans.map((plan) => plan.stableID), ['fresh-range']);
  assert.deepEqual(regeneration.skippedOverlapping.map((plan) => plan.stableID), ['inside-active-window', 'inside-rejected-window']);

  const otherRejected = makePlan({ stableID: 'other-rejected', start: '04:00', end: '04:20' });
  const restoredSession = {
    ...removed.session,
    shortsPlans: [activeExclusion],
    shortsRejectedPlans: [removed.plan, otherRejected],
  };
  const restored = restoreShortsPlanFromRejectedLedger(restoredSession, 'removed-plan', {
    activeLanguage: 'Russian',
  });
  assert.equal(restored.success, true);
  if (!restored.success) return;
  assert.equal(restored.plan.stableID, 'removed-plan');
  assert.deepEqual(restored.plan, removed.plan);
  assert.deepEqual(restored.session.shortsRejectedPlans.map((plan) => plan.stableID), ['other-rejected']);
  assert.deepEqual(restored.session.shortsPlans.map((plan) => plan.stableID), ['active-exclusion', 'removed-plan']);

  const blockedSession = {
    ...removed.session,
    shortsPlans: [makePlan({ stableID: 'blocking-active', start: '01:05', end: '01:25' })],
    shortsRejectedPlans: [removed.plan, otherRejected],
  };
  const beforeBlockedRestore = JSON.stringify(blockedSession);
  const blocked = restoreShortsPlanFromRejectedLedger(blockedSession, 'removed-plan');
  assert.equal(blocked.success, false);
  if (!blocked.success) assert.equal(blocked.code, 'OVERLAP_ACTIVE');
  assert.equal(JSON.stringify(blockedSession), beforeBlockedRestore);
});

function secondsToShortsTimestampForTest(seconds: number): string {
  const minutes = Math.floor(seconds / 60);
  const remainder = seconds % 60;
  return `${String(minutes).padStart(2, '0')}:${String(remainder).padStart(2, '0')}`;
}

test('O2-SHT-04 keeps Shorts export selection transient and stable by identity/language', () => {
  const keys = [
    shortsSelectionKey('plan-b', 'target'),
    shortsSelectionKey('plan-a', 'target'),
    shortsSelectionKey('plan-b', 'source'),
    shortsSelectionKey('plan-a', 'source'),
  ];
  assert.deepEqual(sortShortsSelectionKeys(keys), [
    shortsSelectionKey('plan-a', 'source'),
    shortsSelectionKey('plan-a', 'target'),
    shortsSelectionKey('plan-b', 'source'),
    shortsSelectionKey('plan-b', 'target'),
  ]);
  assert.deepEqual(shortsPlanExportLanguages(makePlan({ languageMode: 'bilingual' })), ['source', 'target']);

  const selectedBeforeDelete = new Set([
    shortsSelectionKey('deleted-plan', 'source'),
    shortsSelectionKey('deleted-plan', 'target'),
  ]);
  const selectedAfterDelete = new Set(
    Array.from(selectedBeforeDelete).filter((key) => key.slice(0, key.lastIndexOf(':')) !== 'deleted-plan')
  );
  assert.deepEqual(Array.from(selectedAfterDelete), []);
  assert.equal(selectedAfterDelete.has(shortsSelectionKey('replacement-plan', 'source')), false);

  const projectSwitchSelection = new Set(selectedBeforeDelete);
  projectSwitchSelection.clear();
  assert.equal(projectSwitchSelection.size, 0);

  const serialized = JSON.stringify(normalizeShortsSessionState({
    selectedShortsPlanIndexes: [0],
    shortsPlans: [makePlan({ stableID: 'plan-a' })],
    shortsRejectedPlans: [],
  }));
  assert.doesNotMatch(serialized, /selectedShortsPlanIndexes|selectedShortsPlanKeys|selection/i);
});
test('O2-SHT-05 projects the exact active Shorts language without fallback', () => {
  const plan = makePlan({
    stableID: 'projection-plan',
    languageMode: 'bilingual',
    sourceTitle: 'Source title',
    sourceSummary: 'Source summary',
    sourceHook: 'Source hook',
    sourceCategory: 'Source category',
    sourceCaptionText: '[00:10] Source caption',
    translationsByLanguage: {
      russian: {
        language: 'Russian',
        title: 'Russian title',
        summary: 'Russian summary',
        hook: 'Russian hook',
        category: 'Russian category',
        captionText: '[00:10] Русский текст',
        provider: 'provider-ru',
        updatedAt: '2026-08-01T00:00:00.000Z',
      },
      german: {
        language: 'German',
        title: 'German title',
        summary: 'German summary',
        hook: 'German hook',
        category: 'German category',
        captionText: '[00:10] Deutscher Text',
        provider: 'provider-de',
        updatedAt: '2026-08-02T00:00:00.000Z',
      },
    },
    targetTitle: 'Stale target title',
    targetSummary: 'Stale target summary',
    targetHook: 'Stale target hook',
    targetCategory: 'Stale target category',
    targetCaptionText: 'Stale target caption',
    targetAlignment: [{ id: 'stale-ru', start: 0, end: 2, text: 'Русский текст', words: [] }],
  });
  const source = selectShortsSourceProjection(plan);
  assert.deepEqual(
    [source.title, source.summary, source.hook, source.category, source.captionText],
    ['Source title', 'Source summary', 'Source hook', 'Source category', '[00:10] Source caption'],
  );

  const russian = selectShortsTargetProjection(plan, 'Russian');
  const german = selectShortsTargetProjection(plan, 'de-DE');
  assert.deepEqual(
    [russian.title, russian.summary, russian.hook, russian.category, russian.captionText],
    ['Russian title', 'Russian summary', 'Russian hook', 'Russian category', '[00:10] Русский текст'],
  );
  assert.deepEqual(
    [german.title, german.summary, german.hook, german.category, german.captionText],
    ['German title', 'German summary', 'German hook', 'German category', '[00:10] Deutscher Text'],
  );
  assert.equal(selectShortsTargetProjection(plan, 'French').available, false);
  assert.equal(selectShortsTargetProjection(plan, 'French').title, '');

  const projected = projectShortsPlanForLanguage(plan, 'target', 'German');
  assert.equal(projected.title, 'German title');
  assert.equal(projected.summary, 'German summary');
  assert.equal(projected.hook, 'German hook');
  assert.equal(projected.category, 'German category');
  assert.equal(projected.captionText, '[00:10] Deutscher Text');

  const russianArchiveBefore = JSON.stringify(plan.translationsByLanguage?.russian);
  const germanArchiveBefore = JSON.stringify(plan.translationsByLanguage?.german);
  const edited = updateShortsPlanTargetMetadata(plan, 'German', {
    targetTitle: 'Edited German title',
    targetSummary: 'Edited German summary',
    targetHook: 'Edited German hook',
    targetCategory: 'Edited German category',
    targetCaptionText: '[00:10] Edited German text',
  });
  assert.equal(edited.title, 'Base title');
  assert.equal(edited.targetTitle, 'Edited German title');
  assert.equal(JSON.stringify(edited.translationsByLanguage?.russian), russianArchiveBefore);
  assert.notEqual(JSON.stringify(edited.translationsByLanguage?.german), germanArchiveBefore);
  assert.equal(edited.translationsByLanguage?.german?.title, 'Edited German title');
  assert.equal(edited.translationsByLanguage?.german?.captionText, '[00:10] Edited German text');
  assert.equal(edited.translationsByLanguage?.german?.provider, 'provider-de');

  const missingFrench = validateShortsExportSelection([{ plan, language: 'target' }], {
    activeLanguage: 'French',
    session: { activeTranslationLanguage: 'French' },
  });
  assert.equal(missingFrench.valid, false);
  assert.equal(missingFrench.issues.some((issue) => issue.code === 'MISSING_TARGET_VARIANT'), true);
  assert.equal(shortsAlignmentMatchesCaption(plan.targetAlignment, german.captionText), false);
  assert.equal(shortsAlignmentMatchesCaption(
    [{ id: 'de', start: 0, end: 2, text: 'Deutscher Text', words: [] }],
    german.captionText,
  ), true);

  const generated = attachShortsPlanActiveTranslation({
    ...makePlan({
      languageMode: 'target',
      title: 'Generated German title',
      summary: 'Generated German summary',
      hook: 'Generated German hook',
      category: 'Generated German category',
      captionText: '[00:10] Generated German text',
    }),
    targetTitle: 'Generated German title',
  }, 'German');
  assert.equal(generated.translationsByLanguage?.german?.title, 'Generated German title');
  assert.equal(generated.translationsByLanguage?.german?.captionText, '[00:10] Generated German text');
});

test('O2-SHT-05 available language union is active-first across active and rejected archives', () => {
  const active = makePlan({
    stableID: 'active',
    translationsByLanguage: {
      russian: { language: 'Russian', title: 'RU', summary: 'RU', hook: 'RU' },
      german: { language: 'German', title: 'DE', summary: 'DE', hook: 'DE' },
    },
  });
  const rejected = makePlan({
    stableID: 'rejected',
    translationsByLanguage: {
      french: { language: 'French', title: 'FR', summary: 'FR', hook: 'FR' },
    },
  });
  assert.deepEqual(
    collectAvailableShortsTranslationLanguages({
      activeTranslationLanguage: 'German',
      availableTranslationLanguages: ['Russian'],
      shortsPlans: [active],
      shortsRejectedPlans: [rejected],
    }),
    ['German', 'Russian', 'French'],
  );
});

test('Shorts metadata upsert preserves provider provenance and parses provider JSON', () => {
  const plan = makePlan({
    translationsByLanguage: {
      german: {
        language: 'German',
        title: 'Before',
        summary: 'Before',
        hook: 'Before',
        provider: 'old-provider',
        updatedAt: '2026-08-02T00:00:00.000Z',
      },
    },
  });
  const translated = parseShortsMetadataResponse('```json\\n{"title":"After","summary":"Summary","hook":"Hook","category":"Category","captionText":"Caption"}\\n```');
  const updated = upsertShortsPlanTranslation(plan, 'German', {
    ...translated,
    provider: 'new-provider',
    updatedAt: '2026-08-26T00:00:00.000Z',
  });
  assert.equal(updated.translationsByLanguage?.german?.title, 'After');
  assert.equal(updated.translationsByLanguage?.german?.provider, 'new-provider');
  assert.equal(updated.translationsByLanguage?.german?.updatedAt, '2026-08-26T00:00:00.000Z');
});
test('O2-SHT-06 keeps each plan subtitle style snapshot independent of later defaults', () => {
  const first = normalizeShortsSessionState({
    shortsPlans: [
      makePlan({ stableID: 'style-a', subtitleStyle: { fontFamily: 'Cuprum', fontSize: 96 } }),
      makePlan({ stableID: 'style-b', subtitleStyle: { fontFamily: 'Inter', fontSize: 52 } }),
    ],
    shortsRejectedPlans: [],
  });
  const laterGlobalDefaults = { fontFamily: 'Arial', fontSize: 20 };
  const second = normalizeShortsSessionState({
    ...first,
    shortsPlans: first.shortsPlans.map((plan) => ({ ...plan, subtitleStyle: plan.subtitleStyle })),
    shortsSettings: laterGlobalDefaults,
  });
  assert.deepEqual(second.shortsPlans.map((plan) => plan.subtitleStyle), [
    { fontFamily: 'Cuprum', fontSize: 96 },
    { fontFamily: 'Inter', fontSize: 52 },
  ]);
});
