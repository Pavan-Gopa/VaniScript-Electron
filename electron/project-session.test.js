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
