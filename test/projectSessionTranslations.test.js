'use strict';

// P3E.D2 — Project session multi-language migration tests.
//
// electron/project-session.js must restore assets/index and then run the
// shared normalizer over the assembled session:
//
//   - legacy `selectedTranslationLanguage` is load-only input, stripped after
//     normalization;
//   - Apple multi-variant archives re-key from variant.language/raw keys with
//     every inactive usable variant preserved (cues/formats/provider/time);
//   - active resolution follows the precedence chain: stored active -> legacy
//     selected -> targetLang -> config.targetLang -> first archive language;
//   - legacy translated* projections mirror exactly the resolved variant;
//   - declared-but-partial languages survive in the available union;
//   - normalization is idempotent.

const test = require('node:test');
const assert = require('node:assert/strict');

const { normalizeImportedProjectSession } = require('../electron/project-session.js');
const shared = require('../shared/media-translations.js');

function makeSession(overrides = {}) {
  return {
    sourceFile: '/old/Projects/source.mov',
    sourceFileName: 'Kadamba.mov',
    sourceLang: 'auto',
    targetLang: 'Russian',
    transcriptionProvider: 'coreml-whisperkit',
    translationProvider: 'gemini-cloud',
    outputFormats: [],
    durationSec: 0,
    metadata: {},
    sourceMediaInfo: {},
    chunks: [],
    ...overrides,
  };
}

// Deterministic regression for the importer: pre-normalization seeding plus a
// truthy targetLang chain used to seed/displace variants from the legacy
// leftover and let the shared pass fall back to the first-inserted archive
// language. Restoration stays non-translational and the shared resolver runs
// exactly once over unmasked targets.
test('the shared resolver alone decides: leftovers never seed, displace, or mask the resolved active', () => {
  const session = normalizeImportedProjectSession(makeSession({
    targetLang: 'same',
    config: { targetLang: 'Russian' },
    chunks: [
      {
        index: 0, filePath: '/old/a.wav', startSec: 0, endSec: 2, durationSec: 2,
        original: 'hello', status: 'done', approved: true,
        translationsByLanguage: {
          french: { language: 'French', text: 'Bonjour' },
          russian: {
            language: 'Russian', text: 'Привет мир',
            cues: [{ startSec: 0, endSec: 2, text: 'Привет мир' }],
            formats: { TXT: 'Привет мир' },
            provider: 'mlx-local',
            updatedAt: '2026-03-03T00:00:00.000Z',
          },
        },
        translated: 'Privet',
      },
      {
        index: 1, filePath: '/old/b.wav', startSec: 2, endSec: 4, durationSec: 2,
        original: 'world', status: 'done', approved: false,
        translationsByLanguage: { french: { language: 'French', text: 'Salut' } },
        translated: 'Privet',
      },
    ],
  }));

  assert.equal(session.activeTranslationLanguage, 'Russian', 'config.targetLang outranks the unreal same sentinel');
  assert.equal(session.targetLang, 'Russian');
  assert.equal(session.config.targetLang, 'Russian');
  assert.equal(session.chunks[0].translated, 'Привет мир', 'projection mirrors the real Russian archive variant');
  assert.deepEqual(session.chunks[0].translatedCues, [{ startSec: 0, endSec: 2, text: 'Привет мир' }]);
  const archive = session.chunks[0].translationsByLanguage;
  assert.equal(archive.russian.text, 'Привет мир', 'the leftover never replaces the archived Russian variant');
  assert.equal(archive.russian.provider, 'mlx-local', 'variant metadata untouched');
  assert.equal(archive.french.text, 'Bonjour', 'first-inserted language does not become active');
  const bare = session.chunks[1];
  assert.deepEqual(
    bare.translationsByLanguage.russian,
    { language: 'Russian', text: 'Privet' },
    'a usable leftover reaches the resolved slot only via the single shared pass'
  );
  assert.equal(bare.translated, 'Privet');
  assert.deepEqual(Object.keys(archive), ['french', 'russian'], 'both variants preserved in insertion order');
  assert.equal(bare.translationsByLanguage.french.text, 'Salut');
  assert.deepEqual(session.availableTranslationLanguages, ['Russian', 'French']);
  assert.equal('selectedTranslationLanguage' in session, false);
  // Idempotence: importing the imported session changes nothing.
  const again = normalizeImportedProjectSession(JSON.parse(JSON.stringify(session)), {});
  assert.deepEqual(again, JSON.parse(JSON.stringify(session)));
});

test('legacy selected/target migrations strip the selected field and synchronize targets', () => {
  const session = normalizeImportedProjectSession(makeSession({
    selectedTranslationLanguage: 'ru',
    targetLang: 'fr',
    config: { targetLang: 'fr' },
    chunks: [{
      index: 0, filePath: '/old/a.wav', startSec: 0, endSec: 4, durationSec: 4,
      original: 'hello', status: 'done', approved: false,
      translationsByLanguage: {
        ru: { language: 'ru', text: 'Русский' },
        fr: { language: 'fr', text: 'Français' },
      },
      translated: '',
    }],
  }));

  assert.equal('selectedTranslationLanguage' in session, false, 'legacy field stripped');
  assert.equal(session.activeTranslationLanguage, 'Russian', 'legacy selected wins the precedence chain');
  assert.equal(session.targetLang, 'Russian', 'session target synchronized to canonical active');
  assert.equal(session.config.targetLang, 'Russian', 'config target synchronized to canonical active');
  // Idempotence: re-normalizing the normalized session changes nothing.
  const again = normalizeImportedProjectSession(JSON.parse(JSON.stringify(session)), { projectId: session.projectId });
  assert.deepEqual(again, JSON.parse(JSON.stringify(session)));
});

test('Apple multi-variant imports re-key raw archive entries and preserve every inactive usable variant', () => {
  const cues = [{ startSec: 0, endSec: 2, text: 'Русский текст' }];
  const session = normalizeImportedProjectSession(makeSession({
    chunks: [{
      index: 0, filePath: '/old/a.wav', startSec: 0, endSec: 2, durationSec: 2,
      original: 'hello', status: 'done', approved: true,
      translationsByLanguage: {
        ru: {
          language: 'RU',
          text: 'Русский текст',
          cues,
          formats: { TXT: 'Русский текст' },
          provider: 'mlx-local',
          updatedAt: '2026-01-01T00:00:00.000Z',
        },
        'en-US': { language: '', text: 'English text' },
        broken: { language: 'de', text: 'translation failed: boom' },
      },
    }],
  }));

  const chunk = session.chunks[0];
  const archive = chunk.translationsByLanguage;
  assert.deepEqual(Object.keys(archive), ['russian', 'english'], 'raw keys canonicalized; unusable variants dropped');
  assert.equal(archive.russian.language, 'Russian', 'variant display name canonicalized');
  assert.deepEqual(archive.russian.cues, cues, 'inactive-adjacent cues preserved verbatim');
  assert.deepEqual(archive.russian.formats, { TXT: 'Русский текст' });
  assert.equal(archive.russian.provider, 'mlx-local', 'provider preserved');
  assert.equal(archive.russian.updatedAt, '2026-01-01T00:00:00.000Z', 'timestamp preserved');
  assert.equal(archive.english.text, 'English text', 'raw-key fallback keeps the english variant');
  assert.equal(chunk.translated, 'Русский текст', 'projection mirrors the resolved russian variant');
  assert.deepEqual(chunk.translatedCues, cues);
  assert.equal(session.availableTranslationLanguages.includes('German'), false, 'unusable variants do not register languages');
});

test('active resolution follows the documented precedence chain', () => {
  const base = () => ({
    chunks: [{
      index: 0, filePath: '/a.wav', startSec: 0, endSec: 1, durationSec: 1,
      original: 'x', status: 'done', approved: false,
      translationsByLanguage: {
        french: { language: 'French', text: 'bonjour' },
        russian: { language: 'Russian', text: 'привет' },
      },
    }],
  });

  // Stored active beats legacy selected.
  const first = normalizeImportedProjectSession(makeSession({
    ...base(),
    activeTranslationLanguage: 'french',
    selectedTranslationLanguage: 'ru',
  }));
  assert.equal(first.activeTranslationLanguage, 'French');

  // Legacy selected beats targetLang.
  const second = normalizeImportedProjectSession(makeSession({
    ...base(),
    selectedTranslationLanguage: 'ru',
    targetLang: 'french',
    config: { targetLang: 'french' },
  }));
  assert.equal(second.activeTranslationLanguage, 'Russian');

  // targetLang beats config.targetLang.
  const third = normalizeImportedProjectSession(makeSession({
    ...base(),
    targetLang: 'russian',
    config: { targetLang: 'french' },
  }));
  assert.equal(third.activeTranslationLanguage, 'Russian');

  // First archive language is the final fallback.
  const fourth = normalizeImportedProjectSession(makeSession({ ...base(), targetLang: '' }));
  assert.equal(fourth.activeTranslationLanguage, 'French');
});

test('missing resolved variants project blank without borrowing; empty sessions keep legacy fields', () => {
  const borrowed = normalizeImportedProjectSession(makeSession({
    targetLang: 'Spanish',
    chunks: [{
      index: 0, filePath: '/a.wav', startSec: 0, endSec: 1, durationSec: 1,
      original: 'x', status: 'done', approved: false,
      translationsByLanguage: { french: { language: 'French', text: 'bonjour' } },
      translatedCues: [{ startSec: 0, endSec: 1, text: 'stale' }],
    }],
  }));
  assert.equal(borrowed.chunks[0].translated, '', 'no spanish variant projects blank');
  assert.equal(borrowed.chunks[0].translatedCues, undefined, 'stale cues are not carried across languages');
  assert.ok(borrowed.chunks[0].translationsByLanguage.french, 'inactive variant preserved');

  const plain = normalizeImportedProjectSession(makeSession({
    targetLang: 'same',
    chunks: [{
      index: 0, filePath: '/a.wav', startSec: 0, endSec: 1, durationSec: 1,
      original: 'spoken only', status: 'done', approved: false,
      translated: '',
    }],
  }));
  assert.equal('activeTranslationLanguage' in plain, false);
  assert.equal(plain.chunks[0].translated, '');
  // Incomplete imports stay Retry/Approve-next safe: both targets land on the
  // untranslated sentinel so nothing downstream trims an undefined target.
  assert.equal(plain.targetLang, 'same');
  assert.equal(plain.config.targetLang, 'same');
  assert.equal('translationsByLanguage' in plain.chunks[0], false, 'no archive invented');
  const plainAgain = normalizeImportedProjectSession(JSON.parse(JSON.stringify(plain)), { projectId: plain.projectId });
  assert.deepEqual(plainAgain, JSON.parse(JSON.stringify(plain)), 'second normalization is deep-idempotent');
});

test('declared partial languages survive in the available union next to archive-derived ones', () => {
  const session = normalizeImportedProjectSession(makeSession({
    activeTranslationLanguage: 'Russian',
    availableTranslationLanguages: ['German'],
    chunks: [{
      index: 0, filePath: '/a.wav', startSec: 0, endSec: 1, durationSec: 1,
      original: 'x', status: 'done', approved: false,
      translationsByLanguage: { french: { language: 'French', text: 'bonjour' } },
    }],
  }));
  assert.deepEqual(session.availableTranslationLanguages, ['Russian', 'German', 'French']);
});

test('asset restoration still flows through the shared normalizer end-to-end', () => {
  const assetMap = new Map([
    ['sourceFile', '/imported/audio/Kadamba.mov'],
    ['chunk:0', '/imported/chunks/chunk_0000.wav'],
  ]);
  const session = normalizeImportedProjectSession(makeSession({
    activeTranslationLanguage: 'Russian',
    chunks: [{
      index: 0, filePath: '/old/a.wav', startSec: 0, endSec: 2, durationSec: 2,
      original: 'hello', status: 'done', approved: true,
      translationsByLanguage: { ru: { language: 'ru', text: 'Русский текст', cues: [{ startSec: 0, endSec: 2, text: 'Русский текст' }] } },
      translated: '',
    }],
  }), { projectId: 'vs-imported', assetMap });

  assert.equal(session.projectId, 'vs-imported');
  assert.equal(session.chunks[0].filePath, '/imported/chunks/chunk_0000.wav', 'assets restored before normalization');
  assert.equal(session.sourceFile, '/imported/audio/Kadamba.mov');
  assert.equal(session.chunks[0].translated, 'Русский текст');
  assert.equal(shared.isUsableTranslationText(session.chunks[0].translated), true);
});
