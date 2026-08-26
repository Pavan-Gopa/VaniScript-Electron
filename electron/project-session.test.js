const test = require('node:test');
const assert = require('node:assert/strict');

const {
  normalizeImportedProjectSession,
  resolveSessionReviewProgressIndex,
} = require('./project-session');

test('normalizes Apple Silicon project sessions for Electron review UI', () => {
  const assetMap = new Map([
    ['sourceFile', '/tmp/imported/audio/Kadamba.mov'],
    ['chunk:0', '/tmp/imported/chunks/chunk_0000.wav'],
  ]);
  const session = normalizeImportedProjectSession({
    activeTranslationLanguage: 'Russian',
    currentChunkIndex: 5,
    sourceFile: '/old/VaniScript/Projects/source.mov',
    sourceFileName: 'Kadamba.mov',
    sourceLang: 'auto',
    targetLang: 'Russian',
    transcriptionProvider: 'coreml-whisperkit',
    translationProvider: 'gemini-cloud',
    outputFormats: [],
    durationSec: 0,
    metadata: {
      date: '2020',
      location: 'Mayapur',
      lecturer: 'His Holiness Kadamba Kanana Swami',
      participants: '',
    },
    sourceMediaInfo: {
      kind: 'video',
      filePath: '/old/VaniScript/Projects/source.mov',
      fileName: 'Kadamba.mov',
      durationSec: 3225.04,
    },
    chunks: Array.from({ length: 7 }, (_, index) => (
      index === 0 ? {
        index: 0,
        filePath: '/old/VaniScript/Projects/chunks/chunk_0000.wav',
        startSec: 0,
        endSec: 509.45,
        durationSec: 509.45,
        original: 'Original text',
        translated: '',
        status: 'done',
        approved: true,
        translationsByLanguage: {
          Russian: {
            language: 'Russian',
            text: 'Russian text',
            cues: [{ startSec: 0, endSec: 2, text: 'Russian text' }],
          },
        },
      } : {
        index,
        filePath: `/old/VaniScript/Projects/chunks/chunk_000${index}.wav`,
        startSec: index * 500,
        endSec: (index + 1) * 500,
        durationSec: 500,
        original: `Original text ${index}`,
        translated: `Translated text ${index}`,
        status: 'done',
        approved: true,
      }
    )),
  }, { projectId: 'vs-imported', assetMap });

  assert.equal(session.projectId, 'vs-imported');
  assert.equal(session.currentIndex, 5);
  assert.equal(session.currentChunkIndex, 5);
  assert.equal(session.sourceFile, '/tmp/imported/audio/Kadamba.mov');
  assert.equal(session.originalVideoPath, '/tmp/imported/audio/Kadamba.mov');
  assert.equal(session.sourceMediaKind, 'video');
  assert.equal(session.sourceMediaInfo.filePath, '/tmp/imported/audio/Kadamba.mov');
  assert.equal(session.durationSec, 3225.04);
  assert.deepEqual(session.outputFormats, ['TXT']);
  assert.deepEqual(session.config, {
    date: '2020',
    location: 'Mayapur',
    lecturer: 'His Holiness Kadamba Kanana Swami',
    participants: '',
    targetLang: 'Russian',
    formats: ['TXT'],
    transcriptionProvider: 'coreml-whisperkit',
    translationProvider: 'gemini-cloud',
  });
  assert.equal(session.chunks[0].filePath, '/tmp/imported/chunks/chunk_0000.wav');
  assert.equal(session.chunks[0].translated, 'Russian text');
  assert.deepEqual(session.chunks[0].translatedCues, [{ startSec: 0, endSec: 2, text: 'Russian text' }]);
});

test('keeps every approved chunk reachable when user opens an earlier chunk', () => {
  const chunks = Array.from({ length: 7 }, (_, index) => ({
    index,
    approved: true,
  }));

  assert.equal(resolveSessionReviewProgressIndex({ currentIndex: 3, chunks }, chunks.length), 6);
});

test('keeps the next unapproved chunk reachable after reviewing approved chunks', () => {
  const chunks = Array.from({ length: 7 }, (_, index) => ({
    index,
    approved: index < 5,
  }));

  assert.equal(resolveSessionReviewProgressIndex({ currentIndex: 1, chunks }, chunks.length), 5);
});

test('normalizes Shorts state during project-session ingress', () => {
  const session = normalizeImportedProjectSession({
    activeTranslationLanguage: 'Russian',
    targetLang: 'Russian',
    selectedShortsPlanIndexes: [0],
    shortsPlans: [{
      id: 'legacy-plan',
      start: '00:00',
      end: '00:20',
      languageMode: 'target',
      title: 'Legacy title',
      summary: 'Legacy summary',
      hook: 'Legacy hook',
    }],
    shortsRejectedPlans: 'not-an-array',
    chunks: [],
  }, { projectId: 'shorts-project' });

  assert.deepEqual(session.shortsPlans.map((plan) => plan.stableID), ['legacy-plan']);
  assert.deepEqual(session.shortsRejectedPlans, []);
  assert.equal(session.shortsPlans[0].id, undefined);
  assert.equal(session.selectedShortsPlanIndexes, undefined);
  assert.equal(session.shortsPlans[0].translationsByLanguage.russian.title, 'Legacy title');
});

test('project-session save/load preserves the complete rejected Shorts ledger', () => {
  const ledgerPlan = {
    stableID: 'rejected-ledger-plan',
    start: '00:30',
    end: '00:50',
    languageMode: 'bilingual',
    title: 'Target title',
    summary: 'Target summary',
    hook: 'Target hook',
    sourceTitle: 'Source title',
    sourceSummary: 'Source summary',
    sourceHook: 'Source hook',
    targetTitle: 'Target title',
    targetSummary: 'Target summary',
    targetHook: 'Target hook',
    translationsByLanguage: {
      russian: {
        language: 'Russian',
        title: 'Target title',
        summary: 'Target summary',
        hook: 'Target hook',
        captionText: 'Target caption',
        provider: 'provider-a',
        updatedAt: '2026-08-26T00:00:00.000Z',
      },
    },
    subtitleStyle: {
      fontFamily: 'Cuprum',
      subtitleBottomMargin: 560,
    },
    timelineCuts: [{ stableID: 'cut-1', startSec: 2, endSec: 4 }],
    timelineTrim: { trimStartSec: 1, trimEndSec: 2 },
    backgroundSettings: { solidEnabled: true, solidColor: '#000000' },
  };
  const initial = normalizeImportedProjectSession({
    activeTranslationLanguage: 'Russian',
    targetLang: 'Russian',
    shortsPlans: [],
    shortsRejectedPlans: [ledgerPlan],
    chunks: [],
  }, { projectId: 'ledger-project' });
  const reloaded = normalizeImportedProjectSession(
    JSON.parse(JSON.stringify(initial)),
    { projectId: 'ledger-project' }
  );

  assert.deepEqual(reloaded.shortsPlans, []);
  assert.deepEqual(reloaded.shortsRejectedPlans, initial.shortsRejectedPlans);
  assert.equal(reloaded.shortsRejectedPlans[0].stableID, 'rejected-ledger-plan');
  assert.deepEqual(reloaded.shortsRejectedPlans[0].translationsByLanguage.russian, ledgerPlan.translationsByLanguage.russian);
  assert.deepEqual(reloaded.shortsRejectedPlans[0].subtitleStyle, ledgerPlan.subtitleStyle);
  assert.deepEqual(reloaded.shortsRejectedPlans[0].timelineCuts, ledgerPlan.timelineCuts);
  assert.deepEqual(reloaded.shortsRejectedPlans[0].timelineTrim, ledgerPlan.timelineTrim);
  assert.deepEqual(reloaded.shortsRejectedPlans[0].backgroundSettings, ledgerPlan.backgroundSettings);
});
test('project-session save/load preserves active and rejected Shorts plans, languages, and style', () => {
  const activePlan = {
    stableID: 'lifecycle-active',
    start: '00:10',
    end: '00:30',
    title: 'German active title',
    summary: 'German active summary',
    hook: 'German active hook',
    category: 'Teaching',
    sourceTitle: 'Source active title',
    sourceSummary: 'Source active summary',
    sourceHook: 'Source active hook',
    sourceCategory: 'Source',
    sourceCaptionText: 'Source caption',
    targetTitle: 'German active title',
    targetSummary: 'German active summary',
    targetHook: 'German active hook',
    targetCategory: 'Teaching',
    targetCaptionText: 'German caption',
    languageMode: 'bilingual',
    translationsByLanguage: {
      german: {
        language: 'German',
        title: 'German active title',
        summary: 'German active summary',
        hook: 'German active hook',
        category: 'Teaching',
        captionText: 'German caption',
        provider: 'provider-de',
        updatedAt: '2026-08-26T01:00:00.000Z',
      },
      russian: {
        language: 'Russian',
        title: 'Russian active title',
        summary: 'Russian active summary',
        hook: 'Russian active hook',
        category: 'Учение',
        captionText: 'Русские субтитры',
        provider: 'provider-ru',
        updatedAt: '2026-08-26T02:00:00.000Z',
      },
    },
    subtitleStyle: {
      fontFamily: 'Cuprum',
      fontSize: 96,
      subtitleBottomMargin: 560,
    },
    timelineCuts: [{ stableID: 'lifecycle-cut', startSec: 2, endSec: 4 }],
  };
  const rejectedPlan = {
    stableID: 'lifecycle-rejected',
    start: '01:00',
    end: '01:20',
    title: 'Rejected Russian title',
    summary: 'Rejected Russian summary',
    hook: 'Rejected Russian hook',
    languageMode: 'target',
    translationsByLanguage: {
      russian: {
        language: 'Russian',
        title: 'Rejected Russian title',
        summary: 'Rejected Russian summary',
        hook: 'Rejected Russian hook',
        provider: 'provider-ru',
        updatedAt: '2026-08-26T03:00:00.000Z',
      },
    },
    subtitleStyle: {
      fontFamily: 'Inter',
      fontSize: 52,
      subtitleBottomMargin: 420,
    },
    timelineCuts: [{ stableID: 'rejected-cut', startSec: 1, endSec: 3 }],
  };
  const initial = normalizeImportedProjectSession({
    activeTranslationLanguage: 'German',
    targetLang: 'German',
    availableTranslationLanguages: ['German', 'Russian'],
    selectedShortsPlanIndexes: [0],
    shortsPlans: [activePlan],
    shortsRejectedPlans: [rejectedPlan],
    chunks: [],
  }, { projectId: 'shorts-lifecycle' });
  const reloaded = normalizeImportedProjectSession(
    JSON.parse(JSON.stringify(initial)),
    { projectId: 'shorts-lifecycle' },
  );

  assert.equal(reloaded.activeTranslationLanguage, 'German');
  assert.deepEqual(reloaded.availableTranslationLanguages, ['German', 'Russian']);
  assert.deepEqual(reloaded.shortsPlans, initial.shortsPlans);
  assert.deepEqual(reloaded.shortsRejectedPlans, initial.shortsRejectedPlans);
  assert.deepEqual(reloaded.shortsPlans[0].subtitleStyle, activePlan.subtitleStyle);
  assert.deepEqual(reloaded.shortsRejectedPlans[0].subtitleStyle, rejectedPlan.subtitleStyle);
  assert.deepEqual(reloaded.shortsPlans[0].timelineCuts, activePlan.timelineCuts);
  assert.deepEqual(reloaded.shortsRejectedPlans[0].timelineCuts, rejectedPlan.timelineCuts);
  assert.equal(reloaded.selectedShortsPlanIndexes, undefined);

  const switched = normalizeImportedProjectSession({
    ...initial,
    activeTranslationLanguage: 'Russian',
    targetLang: 'Russian',
  }, { projectId: 'shorts-lifecycle' });
  assert.equal(switched.activeTranslationLanguage, 'Russian');
  assert.deepEqual(switched.shortsPlans[0].translationsByLanguage, initial.shortsPlans[0].translationsByLanguage);
  assert.deepEqual(switched.shortsRejectedPlans[0].translationsByLanguage, initial.shortsRejectedPlans[0].translationsByLanguage);
});
