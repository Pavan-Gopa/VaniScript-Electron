'use strict';

// P3E.D2 — Media review coordinator tests.
//
// The coordinator owns every source/translation mutation of a media session
// plus its transient generation ledger. These tests drive the observable
// contract against plain session fixtures — no React, no providers:
//
//   - hydration normalization/projection/edit/remove semantics;
//   - initial/retry transcription commits (including late approval/index
//     preservation and inactive-variant preservation);
//   - the deferred stale matrix: old session generations, changed chunk
//     identity, source edits (ABA), translation edits, newer cross-kind
//     operations, language switches, add-language sweeps, retranslation,
//     approval/navigation independence;
//   - arbitrary edits/selection rewrites collapse lane timing to honest
//     TXT-only representations (cues dropped, late commits still no-ops);
//   - contextual selection replacement guards;
//   - Add Translation progressive behavior.

const test = require('node:test');
const assert = require('node:assert/strict');
require('tsx/cjs');

const { MediaReviewCoordinator } = require('../src/services/media-review-coordinator.ts');
const shared = require('../shared/media-translations.js');

// --- Fixtures -----------------------------------------------------------------

function makeConfig(targetLang = 'Russian') {
  return {
    date: '', location: '', lecturer: '', participants: '',
    targetLang,
    formats: ['TXT'],
    transcriptionProvider: 'gemini-cloud',
    translationProvider: 'gemini-cloud',
  };
}

function makeChunk(overrides = {}) {
  return {
    index: 0,
    filePath: '/audio/seg-1.wav',
    durationSec: 10,
    startSec: 0,
    endSec: 10,
    original: '',
    translated: '',
    status: 'pending',
    approved: false,
    ...overrides,
  };
}

function makeSession(overrides = {}) {
  return {
    sourceFile: '/audio/src.wav',
    sourceFileName: 'src.wav',
    sourceMediaKind: 'audio',
    wavPath: '/audio/src.wav',
    config: makeConfig(),
    chunks: [makeChunk()],
    currentIndex: 0,
    targetLang: 'Russian',
    ...overrides,
  };
}

const CUES = [{ startSec: 0, endSec: 5, text: 'Привет мир' }];

// --- Hydration / normalization / projection -----------------------------------

test('hydration strips the legacy selected field and resolves canonical state', () => {
  const review = new MediaReviewCoordinator();
  const session = review.adopt(makeSession({
    selectedTranslationLanguage: 'ru',
    chunks: [makeChunk({
      status: 'done',
      original: 'Hello world',
      translated: 'Привет мир',
      translationsByLanguage: {
        ru: { language: 'ru', text: 'Привет мир', cues: CUES, provider: 'gemini-cloud', updatedAt: 't1' },
        en: { language: 'en', text: 'Hello world' },
      },
    })],
    availableTranslationLanguages: ['German'],
  }));

  assert.equal('selectedTranslationLanguage' in session, false);
  assert.equal(session.activeTranslationLanguage, 'Russian');
  assert.deepEqual(session.availableTranslationLanguages, ['Russian', 'German', 'English']);
  // Generations live only in the coordinator ledger, never on the session.
  assert.equal(/generation/i.test(JSON.stringify(session)), false);

  const chunk = session.chunks[0];
  assert.deepEqual(Object.keys(chunk.translationsByLanguage), ['russian', 'english']);
  assert.equal(chunk.translated, 'Привет мир');
  assert.deepEqual(chunk.translatedCues, CUES);
});

test('missing active variant projects blank instead of borrowing another language', () => {
  const review = new MediaReviewCoordinator();
  const session = review.adopt(makeSession({
    chunks: [makeChunk({
      status: 'done',
      original: 'Hello world',
      translationsByLanguage: {
        en: { language: 'en', text: 'Hello world' },
      },
    })],
  }));
  const chunk = session.chunks[0];
  // Active resolves to Russian (target); no russian variant exists and the
  // chunk carries no usable legacy projection, so the eager fields stay
  // blank — never borrowed from english.
  assert.equal(session.activeTranslationLanguage, 'Russian');
  assert.equal(chunk.translated, '');
  assert.equal(chunk.translatedCues, undefined);
  assert.equal(chunk.translationsByLanguage.english.text, 'Hello world');
});

test('usable legacy projections seed the missing resolved variant', () => {
  const review = new MediaReviewCoordinator();
  const session = review.adopt(makeSession({
    chunks: [makeChunk({ status: 'done', original: 'Hello', translated: 'Привет' })],
  }));
  const chunk = session.chunks[0];
  assert.deepEqual(chunk.translationsByLanguage.russian, {
    language: 'Russian', text: 'Привет',
  });
  assert.equal(chunk.translated, 'Привет');
});

// --- Initial / retry transcription commits -------------------------------------

test('initial transcription commits the source and the captured target variant', () => {
  const review = new MediaReviewCoordinator();
  const adopted = review.adopt(makeSession());
  const begun = review.beginTranscription(adopted, 0, adopted.config, { retry: false });
  assert.ok(begun);
  assert.equal(begun.session.chunks[0].status, 'processing');

  const next = review.commitTranscription(begun.session, begun.operation, {
    original: 'Hello world',
    originalFormats: { TXT: 'Hello world' },
    originalCues: [{ startSec: 0, endSec: 10, text: 'Hello world' }],
    unrecognizedFragments: ['hm'],
    translatedText: 'Привет мир',
    translatedCues: CUES,
    translatedFormats: { TXT: 'Привет мир' },
    provider: 'gemini-cloud',
    updatedAt: 't2',
  });

  assert.ok(next);
  const chunk = next.chunks[0];
  assert.equal(chunk.status, 'done');
  assert.equal(chunk.original, 'Hello world');
  assert.deepEqual(chunk.unrecognizedFragments, ['hm']);
  assert.deepEqual(chunk.translationsByLanguage.russian, {
    language: 'Russian', text: 'Привет мир', cues: CUES, formats: { TXT: 'Привет мир' }, provider: 'gemini-cloud', updatedAt: 't2',
  });
  assert.equal(chunk.translated, 'Привет мир');
  assert.equal(chunk.approved, false);
  assert.equal(next.activeTranslationLanguage, 'Russian');
});

test('retry transcription resets approval at start and preserves later approval/index changes on success', () => {
  const review = new MediaReviewCoordinator();
  const second = makeChunk({ index: 1, filePath: '/audio/seg-2.wav', startSec: 10, endSec: 20, durationSec: 10, status: 'error', original: 'Error: boom' });
  const adopted = review.adopt(makeSession({
    chunks: [makeChunk({ status: 'done', original: 'First', approved: true }), second],
    currentIndex: 1,
  }));

  const begun = review.beginTranscription(adopted, 1, adopted.config, { retry: true });
  assert.ok(begun);
  assert.equal(begun.session.chunks[1].approved, false, 'retry clears approval at start');
  assert.equal(begun.session.chunks[1].status, 'pending');

  // While the retry runs, the user approves chunk 0 again and moves the cursor.
  let latest = review.setApproval(begun.session, 0, true);
  latest = review.setCurrentIndex(latest, 0);

  const next = review.commitTranscription(latest, begun.operation, {
    original: 'Second fixed',
    translatedText: 'Второй',
  });

  assert.ok(next);
  assert.equal(next.currentIndex, 0, 'late success never restores the older cursor');
  assert.equal(next.chunks[0].approved, true, 'later approval preserved');
  assert.equal(next.chunks[1].original, 'Second fixed');
  assert.equal(next.chunks[1].translated, 'Второй');
  assert.equal(next.chunks[1].status, 'done');
});

test('failed transcription surfaces the typed error message as source', () => {
  const review = new MediaReviewCoordinator();
  const adopted = review.adopt(makeSession());
  const begun = review.beginTranscription(adopted, 0, adopted.config, { retry: false });
  const next = review.failTranscription(begun.session, begun.operation, 'provider exploded');
  assert.ok(next);
  assert.equal(next.chunks[0].status, 'error');
  assert.equal(next.chunks[0].original, 'Error: provider exploded');
});

test('failed transcription collapses a cue-backed chunk to the TXT-only error representation', () => {
  const review = new MediaReviewCoordinator();
  const frenchVariant = { language: 'French', text: 'Deuxième', formats: { TXT: 'Deuxième', SRT: 'timed' } };
  const adopted = review.adopt(makeSession({
    currentIndex: 1,
    chunks: [
      makeChunk({ status: 'done', original: 'First', approved: true }),
      makeChunk({
        index: 1,
        filePath: '/audio/seg-2.wav',
        durationSec: 10,
        startSec: 10,
        endSec: 20,
        status: 'done',
        approved: true,
        original: 'Second take',
        originalCues: [{ startSec: 10, endSec: 15, text: 'Second take' }],
        originalFormats: {
          TXT: 'Second take',
          SRT: '1\n00:00:10,000 --> 00:00:15,000\nSecond take\n',
          VTT: 'WEBVTT\n\n00:00:10.000 --> 00:00:15.000\nSecond take\n',
        },
        translated: 'Второй',
        translationsByLanguage: {
          russian: { language: 'Russian', text: 'Второй' },
          french: frenchVariant,
        },
      }),
    ],
  }));

  const begun = review.beginTranscription(adopted, 1, adopted.config, { retry: false });
  assert.ok(begun);
  const failed = review.failTranscription(begun.session, begun.operation, 'provider exploded');
  assert.ok(failed);
  const chunk = failed.chunks[1];
  assert.equal(chunk.status, 'error');
  assert.equal(chunk.original, 'Error: provider exploded');
  assert.deepEqual(
    chunk.originalFormats,
    { TXT: 'Error: provider exploded' },
    'SRT/VTT keys are gone; exactly {TXT} survives'
  );
  assert.equal('originalCues' in chunk, false, 'stale cue track removed outright');
  assert.equal(chunk.approved, true, 'approval untouched by the failure');
  assert.equal(failed.currentIndex, 1, 'cursor untouched by the failure');
  assert.deepEqual(
    chunk.translationsByLanguage.russian,
    { language: 'Russian', text: 'Второй' },
    'active archive untouched'
  );
  assert.deepEqual(chunk.translationsByLanguage.french, frenchVariant, 'inactive variants stay byte-identical');

  // A failure superseded by a newer operation on the same lane stays a no-op.
  const newer = review.beginTranscription(failed, 1, adopted.config, { retry: false });
  assert.ok(newer);
  assert.equal(
    review.failTranscription(newer.session, begun.operation, 'stale boom'),
    null,
    'older failures remain stale'
  );
  assert.equal(newer.session.chunks[1].status, 'processing', 'stale failure changed nothing');
  assert.equal(newer.session.chunks[1].original, 'Error: provider exploded');
});

test('unusable translation results preserve canonical content and archives', () => {
  const review = new MediaReviewCoordinator();
  const adopted = review.adopt(makeSession({
    chunks: [makeChunk({
      status: 'done',
      original: 'Hello',
      translationsByLanguage: { russian: { language: 'Russian', text: 'Старый перевод' } },
      translated: 'Старый перевод',
    })],
  }));
  const begun = review.beginTranscription(adopted, 0, adopted.config, { retry: true });
  const next = review.commitTranscription(begun.session, begun.operation, {
    original: 'Hello v2',
    translatedText: 'MLX translation failed: model offline',
  });
  assert.ok(next);
  assert.equal(next.chunks[0].original, 'Hello v2', 'valid source still commits');
  assert.equal(next.chunks[0].translationsByLanguage.russian.text, 'Старый перевод', 'prior archive untouched');
  assert.equal(next.chunks[0].translated, 'Старый перевод');
  assert.equal(next.chunks[0].status, 'done');
});

// --- Deferred stale matrix ------------------------------------------------------

test('old-session completions are no-ops', () => {
  const review = new MediaReviewCoordinator();
  const adopted = review.adopt(makeSession());
  const begun = review.beginTranscription(adopted, 0, adopted.config, { retry: false });
  review.reset();
  assert.equal(review.commitTranscription(begun.session, begun.operation, { original: 'x' }), null);

  const other = new MediaReviewCoordinator();
  const started = other.beginTranscription(other.adopt(makeSession()), 0, makeConfig(), { retry: false });
  const fresh = new MediaReviewCoordinator().adopt(started.session);
  assert.equal(
    new MediaReviewCoordinator().commitTranscription(fresh, started.operation, { original: 'x' }),
    null,
    'another coordinator instance never accepts foreign tokens'
  );
});

test('changed chunk identity (not array position) invalidates commits', () => {
  const review = new MediaReviewCoordinator();
  const adopted = review.adopt(makeSession({
    chunks: [makeChunk(), makeChunk({ index: 1, filePath: '/audio/seg-2.wav', startSec: 10, endSec: 20, durationSec: 10 })],
  }));
  const begun = review.beginTranscription(adopted, 1, adopted.config, { retry: false });

  // Same array slot, different identity (chunk replaced by a re-cut).
  const recut = begun.session;
  recut.chunks[1] = { ...recut.chunks[1], startSec: 12, endSec: 22 };
  assert.equal(review.commitTranscription(recut, begun.operation, { original: 'x' }), null);
});

test('source edits invalidate deferred operations including ABA round-trips', () => {
  const review = new MediaReviewCoordinator();
  const adopted = review.adopt(makeSession({
    chunks: [makeChunk({ status: 'done', original: 'alpha' })],
  }));
  const begun = review.beginTranscription(adopted, 0, adopted.config, { retry: false });

  const editedTwice = review.editSource(review.editSource(begun.session, 0, 'beta'), 0, 'alpha');
  assert.equal(editedTwice.chunks[0].original, 'alpha', 'text matches the captured baseline again');
  assert.equal(
    review.commitTranscription(editedTwice, begun.operation, { original: 'late' }),
    null,
    'ABA round-trip still detected via the content generation'
  );

  // A plain concurrent source edit also drops the completion.
  const other = new MediaReviewCoordinator();
  const start2 = other.beginTranscription(other.adopt(makeSession({
    chunks: [makeChunk({ status: 'done', original: 'alpha' })],
  })), 0, makeConfig(), { retry: false });
  assert.equal(other.commitTranscription(other.editSource(start2.session, 0, 'gamma'), start2.operation, { original: 'late' }), null);
});

test('newer operations on the same lane invalidate older ones across kinds', () => {
  const review = new MediaReviewCoordinator();
  const adopted = review.adopt(makeSession({
    chunks: [makeChunk({
      status: 'done', original: 'Hola mundo',
      translationsByLanguage: { spanish: { language: 'Spanish', text: 'Hola mundo' } },
      translated: 'Hola mundo',
    })],
    config: makeConfig('Spanish'),
    targetLang: 'Spanish',
    availableTranslationLanguages: ['Spanish'],
  }));

  const retry = review.beginTranslationRetry(adopted, 0);
  assert.ok(retry);
  const polishOp = review.beginSelectionOperation(retry.session, 0, 'translated', { selectedText: 'Hola', contextText: 'Hola mundo' }, 'polish');
  assert.ok(polishOp);

  assert.equal(
    review.commitTranslationResult(retry.session, retry.operation, { text: 'Nuevo' }),
    null,
    'the newer polish invalidated the older retry'
  );

  const polished = review.commitSelectionReplacement(retry.session, polishOp, 'Hola brillante', 't2');
  assert.ok(polished);
  assert.equal(polished.chunks[0].translationsByLanguage.spanish.text, 'Hola brillante mundo');
});

test('active retry translation drops after a language switch', () => {
  const review = new MediaReviewCoordinator();
  const adopted = review.adopt(makeSession({
    availableTranslationLanguages: ['Russian', 'French'],
    chunks: [makeChunk({ status: 'done', original: 'Bonjour', translated: 'Бонжур' })],
  }));
  const begun = review.beginTranslationRetry(adopted, 0);
  assert.ok(begun);

  const switched = review.selectLanguage(begun.session, 'French');
  assert.ok(switched);
  assert.equal(review.commitTranslationResult(switched, begun.operation, { text: 'Поздний' }), null);
});

test('add-language sweeps archive their captured language while projection follows the active view', () => {
  const review = new MediaReviewCoordinator();
  const adopted = review.adopt(makeSession({
    availableTranslationLanguages: ['Russian', 'French', 'Spanish'],
    chunks: [makeChunk({ status: 'done', original: 'Hello', translated: 'Привет' })],
  }));
  const operation = review.beginLanguageSweepStep(adopted, 0, 'French');
  assert.ok(operation);

  // User switches to Spanish while the French step is in flight.
  const switched = review.selectLanguage(adopted, 'Spanish');
  assert.ok(switched);

  const next = review.commitLanguageSweepStep(switched, operation, {
    text: 'Bonju', cues: [], formats: { TXT: 'Bonju' }, provider: 'gpt-cloud', updatedAt: 't3',
  });
  assert.ok(next);
  assert.equal(next.chunks[0].translationsByLanguage.french.text, 'Bonju', 'captured language archived');
  assert.equal(next.chunks[0].translationsByLanguage.russian.text, 'Привет', 'prior languages preserved');
  assert.equal(next.chunks[0].translated, '', 'projection shows the missing Spanish variant, not French');
  assert.equal(next.activeTranslationLanguage, 'Spanish', 'late completions never reselect');
  assert.equal(next.chunks[0].status, 'done', 'sweeps never flip chunk status');
});

test('retranslation skips chunks whose content moved after their step began', () => {
  const review = new MediaReviewCoordinator();
  const chunks = [
    makeChunk({ status: 'done', original: 'one' }),
    makeChunk({ index: 1, filePath: '/audio/seg-2.wav', startSec: 10, endSec: 20, durationSec: 10, status: 'done', original: 'two' }),
    makeChunk({ index: 2, filePath: '/audio/seg-3.wav', startSec: 20, endSec: 30, durationSec: 10, original: '' }),
  ];
  const adopted = review.adopt(makeSession({ chunks }));
  assert.equal(review.beginLanguageSweepStep(adopted, 2, 'French'), null, 'unusable sources are skipped at begin');

  const operation = review.beginLanguageSweepStep(adopted, 1, 'French');
  assert.ok(operation);
  const edited = review.editSource(adopted, 1, 'two (corrected)');
  assert.equal(review.commitLanguageSweepStep(edited, operation, { text: 'deux' }), null);
});

test('approval and navigation never mutate archives', () => {
  const review = new MediaReviewCoordinator();
  const chunks = [
    makeChunk({ status: 'done', original: 'a', translated: 'а' }),
    makeChunk({ index: 1, filePath: '/audio/seg-2.wav', startSec: 10, endSec: 20, durationSec: 10, status: 'done', original: 'b' }),
  ];
  const session = review.adopt(makeSession({ chunks }));

  const approvedAndMoved = review.setCurrentIndex(review.setApproval(session, 0, true), 1);
  assert.deepEqual(
    approvedAndMoved.chunks,
    session.chunks.map((c, i) => (i === 0 ? { ...c, approved: true } : c))
  );
  assert.equal(approvedAndMoved.currentIndex, 1);
  assert.equal(approvedAndMoved.chunks[1].translationsByLanguage, undefined);
});

// --- Direct edits ----------------------------------------------------------------

test('direct translation edits upsert the active variant and an empty edit removes it', () => {
  const review = new MediaReviewCoordinator();
  const session = review.adopt(makeSession({
    chunks: [makeChunk({
      status: 'done', original: 'Hi',
      translationsByLanguage: { russian: { language: 'Russian', text: 'Привет' } },
      translated: 'Привет',
    })],
  }));

  const edited = review.editTranslation(session, 0, 'Привет, друзья', 'Привет, друзья', 't4');
  assert.equal(edited.chunks[0].translationsByLanguage.russian.text, 'Привет, друзья');
  assert.equal(edited.chunks[0].translated, 'Привет, друзья');
  assert.equal(edited.chunks[0].translatedFormats.TXT, 'Привет, друзья');

  const removed = review.editTranslation(edited, 0, '');
  assert.equal(removed.chunks[0].translationsByLanguage, undefined);
  assert.equal(removed.chunks[0].translated, '');
});

test('in-flight operations drop when a direct translation edit races them', () => {
  const review = new MediaReviewCoordinator();
  const adopted = review.adopt(makeSession({
    chunks: [makeChunk({ status: 'done', original: 'Hi', translated: 'Привет' })],
  }));
  const begun = review.beginTranslationRetry(adopted, 0);
  const edited = review.editTranslation(begun.session, 0, 'Ручная правка');
  assert.equal(review.commitTranslationResult(edited, begun.operation, { text: 'Поздний' }), null);
});

test('direct source edits drop cue timing and timed formats, settle status, and drop late commits', () => {
  const review = new MediaReviewCoordinator();
  const base = review.adopt(makeSession({
    chunks: [makeChunk({
      status: 'processing',
      original: 'Hello world',
      originalCues: [{ startSec: 0, endSec: 5, text: 'Hello world' }],
      originalFormats: {
        TXT: 'Hello world',
        SRT: '1\n00:00:00,000 --> 00:00:05,000\nHello world\n',
        VTT: 'WEBVTT\n\n00:00:00.000 --> 00:00:05.000\nHello world\n',
      },
      approved: true,
    })],
  }));
  const begun = review.beginTranscription(base, 0, base.config, { retry: false });
  assert.ok(begun);

  const edited = review.editSource(begun.session, 0, 'Hello fixed world');

  assert.equal(edited.chunks[0].original, 'Hello fixed world', 'new plain text stays canonical');
  assert.equal('originalCues' in edited.chunks[0], false, 'stale cue track is removed outright');
  assert.deepEqual(
    edited.chunks[0].originalFormats,
    { TXT: 'Hello fixed world' },
    'timed formats collapse to exactly {TXT}'
  );
  assert.equal(edited.chunks[0].status, 'done', 'synchronous invalidation settles processing');
  assert.equal(edited.chunks[0].approved, true, 'approval untouched');

  // The transcription started before the edit lands as a no-op afterwards.
  assert.equal(
    review.commitTranscription(edited, begun.operation, {
      original: 'Late provider text',
      originalCues: [{ startSec: 0, endSec: 10, text: 'Late provider text' }],
      originalFormats: { TXT: 'Late provider text' },
    }),
    null
  );
});

test('direct active translation edits clear only the active variant timing; inactive archives stay byte-identical', () => {
  const review = new MediaReviewCoordinator();
  const russianVariant = {
    language: 'Russian',
    text: 'Привет мир',
    cues: [{ startSec: 0, endSec: 5, text: 'Привет мир' }],
    formats: { TXT: 'Привет мир', SRT: 'srt-ru', VTT: 'vtt-ru' },
    provider: 'gemini-cloud',
    updatedAt: 't1',
  };
  const frenchVariant = {
    language: 'French',
    text: 'Bonjour le monde',
    cues: [{ startSec: 0, endSec: 5, text: 'Bonjour le monde' }],
    formats: { TXT: 'Bonjour le monde', VTT: 'vtt-fr' },
    provider: 'mlx-local',
    updatedAt: 't2',
  };
  const base = review.adopt(makeSession({
    availableTranslationLanguages: ['Russian', 'French'],
    chunks: [makeChunk({
      status: 'processing',
      original: 'Hello world',
      translated: russianVariant.text,
      translationsByLanguage: { russian: russianVariant, french: frenchVariant },
    })],
  }));
  const begun = review.beginTranslationRetry(base, 0);
  assert.ok(begun);

  const edited = review.editTranslation(begun.session, 0, 'Привет, правленый мир');

  const active = edited.chunks[0].translationsByLanguage.russian;
  assert.equal(active.text, 'Привет, правленый мир');
  assert.equal('cues' in active, false, "only the active variant's cues are dropped");
  assert.deepEqual(active.formats, { TXT: 'Привет, правленый мир' }, 'active timed formats collapse to TXT');
  assert.equal(active.provider, 'gemini-cloud', 'still-true metadata survives');
  assert.equal(active.updatedAt, 't1', 'updatedAt survives when the caller supplies none');

  assert.equal(edited.chunks[0].translated, 'Привет, правленый мир', 'projection mirrors untimed text');
  assert.equal('translatedCues' in edited.chunks[0], false);
  assert.deepEqual(edited.chunks[0].translatedFormats, { TXT: 'Привет, правленый мир' });
  assert.equal(edited.chunks[0].status, 'done', 'settle processing');

  assert.deepEqual(
    edited.chunks[0].translationsByLanguage.french,
    frenchVariant,
    'inactive archive stays byte-identical'
  );

  assert.equal(
    review.commitTranslationResult(edited, begun.operation, { text: 'Поздний', cues: CUES }),
    null,
    'late translation commit drops'
  );
});

test('an undo-like edit back to prior text stays canonical but never resurrects stale cue timing', () => {
  const review = new MediaReviewCoordinator();
  const base = review.adopt(makeSession({
    chunks: [makeChunk({
      status: 'done',
      original: 'alpha',
      originalCues: [{ startSec: 0, endSec: 4, text: 'alpha' }],
      originalFormats: { TXT: 'alpha', SRT: '1\n00:00:00,000 --> 00:00:04,000\nalpha\n' },
    })],
  }));

  const retyped = review.editSource(base, 0, 'beta');
  const undone = review.editSource(retyped, 0, 'alpha');

  assert.equal(undone.chunks[0].original, 'alpha', 'restored text remains visible/canonical');
  assert.equal(
    'originalCues' in undone.chunks[0],
    false,
    'without stored cue history the restore stays untimed'
  );
  assert.deepEqual(undone.chunks[0].originalFormats, { TXT: 'alpha' });
});

// --- Contextual selection replacement ---------------------------------------------

test('selection replacement applies only on the same baseline with an unambiguous occurrence', () => {
  const review = new MediaReviewCoordinator();
  const adopted = review.adopt(makeSession({
    chunks: [makeChunk({ status: 'done', original: 'Hare Krishna world' })],
  }));

  // Same baseline, single occurrence: applies.
  const op = review.beginSelectionOperation(adopted, 0, 'original', { selectedText: 'Hare Krishna', contextText: '' });
  assert.ok(op);
  const applied = review.commitSelectionReplacement(adopted, op, 'Gora');
  assert.ok(applied);
  assert.equal(applied.chunks[0].original, 'Gora world');
  assert.equal(applied.chunks[0].originalFormats.TXT, 'Gora world');

  // Drifted baseline: no-op.
  const driftedBase = makeSession({ chunks: [makeChunk({ status: 'done', original: 'Hare Krishna world' })] });
  const op2 = review.beginSelectionOperation(driftedBase, 0, 'original', { selectedText: 'Hare Krishna', contextText: '' });
  assert.equal(review.commitSelectionReplacement(review.editSource(driftedBase, 0, 'drifted'), op2, 'X'), null);

  // Ambiguous occurrence without context: no-op.
  const ambiguousBase = review.adopt(makeSession({
    chunks: [makeChunk({ status: 'done', original: 'ab ab' })],
  }));
  const op3 = review.beginSelectionOperation(ambiguousBase, 0, 'original', { selectedText: 'ab', contextText: '' });
  assert.equal(review.commitSelectionReplacement(ambiguousBase, op3, 'X'), null);

  // Ambiguous occurrence disambiguated by a unique context line: applies.
  const contextual = review.adopt(makeSession({
    chunks: [makeChunk({ status: 'done', original: '[00:01] ab\n[00:02] ab' })],
  }));
  const op4 = review.beginSelectionOperation(contextual, 0, 'original', { selectedText: 'ab', contextText: '[00:02] ab' });
  const applied4 = review.commitSelectionReplacement(contextual, op4, 'cd');
  assert.ok(applied4);
  assert.equal(applied4.chunks[0].original, '[00:01] ab\n[00:02] cd');
});

test('selection replacements follow the untimed policy on both lanes', () => {
  const review = new MediaReviewCoordinator();

  // Source lane: cues and timed formats do not survive the rewrite.
  const sourceBase = review.adopt(makeSession({
    chunks: [makeChunk({
      status: 'done',
      original: 'Hare Krishna world',
      originalCues: [{ startSec: 0, endSec: 5, text: 'Hare Krishna world' }],
      originalFormats: { TXT: 'Hare Krishna world', SRT: 'srt-old', VTT: 'vtt-old' },
    })],
  }));
  const sourceOp = review.beginSelectionOperation(sourceBase, 0, 'original', {
    selectedText: 'Hare Krishna', contextText: '',
  });
  assert.ok(sourceOp);
  const sourceApplied = review.commitSelectionReplacement(sourceBase, sourceOp, 'Gora');
  assert.ok(sourceApplied);
  assert.equal(sourceApplied.chunks[0].original, 'Gora world');
  assert.equal('originalCues' in sourceApplied.chunks[0], false);
  assert.deepEqual(sourceApplied.chunks[0].originalFormats, { TXT: 'Gora world' });

  // Translation lane: only the captured active variant loses timing; the
  // inactive sibling stays byte-identical and the projection follows.
  const frenchVariant = {
    language: 'French',
    text: 'Bonjour le monde',
    cues: [{ startSec: 0, endSec: 5, text: 'Bonjour le monde' }],
    formats: { TXT: 'Bonjour le monde' },
    provider: 'mlx-local',
    updatedAt: 't2',
  };
  const tBase = review.adopt(makeSession({
    availableTranslationLanguages: ['Russian', 'French'],
    chunks: [makeChunk({
      status: 'done',
      original: 'Hello world',
      translated: 'Привет мир',
      translationsByLanguage: {
        russian: {
          language: 'Russian', text: 'Привет мир',
          cues: [{ startSec: 0, endSec: 5, text: 'Привет мир' }],
          formats: { TXT: 'Привет мир', SRT: 'srt-ru' },
          provider: 'gemini-cloud', updatedAt: 't1',
        },
        french: frenchVariant,
      },
    })],
  }));
  const tOp = review.beginSelectionOperation(tBase, 0, 'translated', {
    selectedText: 'мир', contextText: '',
  });
  assert.ok(tOp);
  const tApplied = review.commitSelectionReplacement(tBase, tOp, 'правленый мир', 't9');
  assert.ok(tApplied);

  const active = tApplied.chunks[0].translationsByLanguage.russian;
  assert.equal(active.text, 'Привет правленый мир');
  assert.equal('cues' in active, false);
  assert.deepEqual(active.formats, { TXT: 'Привет правленый мир' });
  assert.equal(active.provider, 'gemini-cloud', 'still-true metadata survives');
  assert.equal(active.updatedAt, 't9', 'explicit commit timestamp wins');
  assert.deepEqual(
    tApplied.chunks[0].translationsByLanguage.french,
    frenchVariant,
    'inactive archive stays byte-identical'
  );
  assert.equal('translatedCues' in tApplied.chunks[0], false);
  assert.deepEqual(tApplied.chunks[0].translatedFormats, { TXT: 'Привет правленый мир' });
});

// --- Glossary bulk rewrite ---------------------------------------------------------

test('bulk glossary rewrites bump generations and refresh projections', () => {
  const review = new MediaReviewCoordinator();
  const adopted = review.adopt(makeSession({
    chunks: [makeChunk({
      status: 'done', original: 'Krishna speaks', translated: 'Кришна говорит',
      translationsByLanguage: { russian: { language: 'Russian', text: 'Кришна говорит' } },
    })],
  }));
  const beguns = review.beginTranscription(adopted, 0, adopted.config, { retry: true });

  const rewrittenChunks = adopted.chunks.map((chunk) => ({
    ...chunk,
    original: 'Kṛṣṇa speaks',
  }));
  const rewritten = review.commitContentRewrite(adopted, rewrittenChunks, [0]);
  assert.equal(rewritten.chunks[0].original, 'Kṛṣṇa speaks');

  assert.equal(
    review.commitTranscription(rewritten, beguns.operation, { original: 'late' }),
    null,
    'operations started before the rewrite drop'
  );
});

// --- Glossary language scoping -------------------------------------------------------

test('glossary rewrites stay inside their own language and the projection follows the active variant', () => {
  const review = new MediaReviewCoordinator();
  const frenchVariant = {
    language: 'French',
    text: 'Swami Djajapataka parle',
    cues: [{ startSec: 0, endSec: 10, text: 'Swami Djajapataka parle' }],
    formats: { TXT: 'Swami Djajapataka parle' },
    provider: 'gemini-cloud',
    updatedAt: '2026-01-01T00:00:00.000Z',
  };
  const russianVariant = {
    language: 'Russian',
    text: 'Свами Djajapataka говорит',
    cues: [{ startSec: 0, endSec: 10, text: 'Свами Djajapataka говорит' }],
    formats: { TXT: 'Свами Djajapataka говорит' },
    provider: 'mlx-local',
    updatedAt: '2026-02-02T00:00:00.000Z',
  };
  const adopted = review.adopt(makeSession({
    chunks: [makeChunk({
      status: 'done',
      original: 'Swami Djajapataka speaks',
      translated: russianVariant.text,
      translationsByLanguage: { french: frenchVariant, russian: russianVariant },
    })],
  }));
  const beguns = review.beginTranscription(adopted, 0, adopted.config, { retry: true });
  const baseEntry = {
    id: 'glossary-djajapataka',
    variants: ['Djajapataka'],
    source: 'Jayapataka Maharaja',
    translation: 'Джаяпатака Махарадж',
    remember: true,
  };

  // Round 1: Russian is active with no declared mapping — the generic
  // entry.translation applies there; French has no mapping and must stay
  // byte-identical.
  const rewritten = review.applyGlossaryEntry(adopted, [0], baseEntry);

  const russian = rewritten.chunks[0].translationsByLanguage.russian;
  assert.equal(russian.text, 'Свами Джаяпатака Махарадж говорит');
  assert.deepEqual(russian.cues, [{ startSec: 0, endSec: 10, text: 'Свами Джаяпатака Махарадж говорит' }]);
  assert.deepEqual(russian.formats, { TXT: 'Свами Джаяпатака Махарадж говорит' });
  assert.equal(russian.provider, 'mlx-local', 'provider survives the rewrite');
  assert.equal(russian.updatedAt, '2026-02-02T00:00:00.000Z', 'timestamp survives the rewrite');
  assert.deepEqual(
    rewritten.chunks[0].translationsByLanguage.french,
    frenchVariant,
    'inactive French stays byte-identical without a French mapping'
  );
  assert.equal(rewritten.chunks[0].original, 'Swami Jayapataka Maharaja speaks', 'source lane keeps the generic replacement');
  assert.equal(rewritten.chunks[0].translated, 'Свами Джаяпатака Махарадж говорит', 'eager projection mirrors the active variant');

  assert.equal(
    review.commitTranscription(rewritten, beguns.operation, { original: 'late' }),
    null,
    'operations started before the rewrite drop'
  );

  // Round 2: an explicit (case-insensitively matched) French mapping rewrites
  // only French; Russian remains correct.
  const respecified = review.applyGlossaryEntry(rewritten, [0], {
    ...baseEntry,
    translations: { FRENCH: 'Jayapataka Maharaja' },
  });

  const frenchAfter = respecified.chunks[0].translationsByLanguage.french;
  assert.equal(frenchAfter.text, 'Swami Jayapataka Maharaja parle');
  assert.deepEqual(frenchAfter.cues, [{ startSec: 0, endSec: 10, text: 'Swami Jayapataka Maharaja parle' }]);
  assert.deepEqual(frenchAfter.formats, { TXT: 'Swami Jayapataka Maharaja parle' });
  assert.equal(frenchAfter.provider, 'gemini-cloud');
  assert.equal(frenchAfter.updatedAt, '2026-01-01T00:00:00.000Z');
  assert.equal(
    respecified.chunks[0].translationsByLanguage.russian.text,
    'Свами Джаяпатака Махарадж говорит',
    'Russian remains correct after the French respec'
  );
  assert.equal(respecified.chunks[0].translated, 'Свами Джаяпатака Махарадж говорит');
});

// --- Language controls --------------------------------------------------------------

test('selectLanguage rejects unknown languages and synchronizes targets', () => {
  const review = new MediaReviewCoordinator();
  const session = review.adopt(makeSession());

  assert.equal(review.selectLanguage(session, 'Klingon'), null);
  assert.equal(review.selectLanguage(session, 'French'), null, 'unregistered languages cannot be selected');

  const registered = review.addLanguage(session, 'French');
  assert.ok(registered);
  assert.equal(registered.activeTranslationLanguage, 'French');
  assert.equal(registered.targetLang, 'French');
  assert.equal(registered.config.targetLang, 'French');
  assert.deepEqual(registered.availableTranslationLanguages, ['Russian', 'French']);
  assert.equal(shared.translationLanguageKey(registered.activeTranslationLanguage), 'french');
});

test('addLanguage registers partial languages that survive re-hydration', () => {
  const review = new MediaReviewCoordinator();
  const session = review.addLanguage(review.adopt(makeSession()), 'German');
  assert.equal(session.activeTranslationLanguage, 'German', 'registration selects immediately');

  const rehydrated = new MediaReviewCoordinator().adopt(session);
  assert.equal(rehydrated.activeTranslationLanguage, 'German');
  assert.deepEqual(rehydrated.availableTranslationLanguages, ['German', 'Russian'], 'declared partial languages persist active-first');
});

test('invalidating mutations never leave an in-flight chunk stuck at processing', () => {
  const review = new MediaReviewCoordinator();

  // A retry translation runs ('processing') and a direct source edit lands:
  // the late retry drops AND the chunk settles to a stable state derived from
  // its own content, keeping approval and cursor untouched.
  const base = review.adopt(makeSession({
    chunks: [makeChunk({
      status: 'done', original: 'Hi', approved: true, translated: 'Привет',
      translationsByLanguage: { russian: { language: 'Russian', text: 'Привет' } },
    })],
  }));
  const retry = review.beginTranslationRetry(base, 0);
  assert.ok(retry);
  assert.equal(retry.session.chunks[0].status, 'processing');

  const edited = review.editSource(retry.session, 0, 'Hello (fixed)');
  assert.equal(edited.chunks[0].status, 'done', 'source edit settles the invalidated chunk');
  assert.equal(edited.chunks[0].approved, true, 'approval state preserved');
  assert.equal(edited.currentIndex, base.currentIndex, 'cursor preserved');
  assert.equal(review.commitTranslationResult(edited, retry.operation, { text: 'Поздний' }), null);

  // A direct translation edit racing a transcription run also settles.
  const transcribeBase = review.adopt(makeSession({
    chunks: [makeChunk({ status: 'done', original: 'Hi', translated: 'Привет' })],
  }));
  const begun = review.beginTranscription(transcribeBase, 0, transcribeBase.config, { retry: false });
  assert.ok(begun);
  const tEdited = review.editTranslation(begun.session, 0, 'Ручная правка');
  assert.equal(tEdited.chunks[0].status, 'done');
  assert.equal(review.commitTranscription(tEdited, begun.operation, { original: 'late' }), null);

  // Existing content decides the stable state: a chunk without a usable
  // source settles to 'error', never to a fake 'done'.
  const freshBase = review.adopt(makeSession());
  const freshBegun = review.beginTranscription(freshBase, 0, freshBase.config, { retry: false });
  assert.ok(freshBegun);
  const touched = review.editTranslation(freshBegun.session, 0, '');
  assert.equal(touched.chunks[0].status, 'error', 'content without usable source settles to error');

  // A selection replacement that invalidates an active-language retry also
  // settles the chunk instead of leaving it processing.
  const selBase = review.adopt(makeSession({
    chunks: [makeChunk({
      status: 'done', original: 'Hola mundo', translated: 'Hola mundo',
      translationsByLanguage: { spanish: { language: 'Spanish', text: 'Hola mundo' } },
    })],
    config: makeConfig('Spanish'),
    targetLang: 'Spanish',
    availableTranslationLanguages: ['Spanish'],
  }));
  const droppedRetry = review.beginTranslationRetry(selBase, 0);
  assert.ok(droppedRetry);
  const polishOp = review.beginSelectionOperation(
    droppedRetry.session, 0, 'translated', { selectedText: 'mundo', contextText: '' }, 'polish'
  );
  assert.ok(polishOp);
  const polished = review.commitSelectionReplacement(droppedRetry.session, polishOp, 'planeta');
  assert.ok(polished);
  assert.equal(polished.chunks[0].status, 'done', 'selection replacement settles the dropped retry');
  assert.equal(review.commitTranslationResult(polished, droppedRetry.operation, { text: 'tarde' }), null);

  // A glossary rewrite during a running transcription settles too.
  const glossBase = review.adopt(makeSession({
    chunks: [makeChunk({ status: 'done', original: 'Krishna speaks' })],
  }));
  const begun3 = review.beginTranscription(glossBase, 0, glossBase.config, { retry: false });
  const rewritten = review.applyGlossaryEntry(glossBase, [0], {
    id: 'glossary-krishna',
    variants: ['Krishna'],
    source: 'Kṛṣṇa',
    translation: 'Кришна',
    remember: true,
    createdAt: '', updatedAt: '',
  });
  assert.equal(rewritten.chunks[0].original, 'Kṛṣṇa speaks');
  assert.equal(rewritten.chunks[0].status, 'done', 'glossary rewrite settles the dropped operation');
  assert.equal(review.commitTranscription(rewritten, begun3.operation, { original: 'late' }), null);
});

test('glossary rewrites propagate the source replacement into originalCues and pin mapping precedence', () => {
  const review = new MediaReviewCoordinator();
  const originalCues = [
    { startSec: 0, endSec: 2, text: 'Krishna', words: [{ startSec: 0, endSec: 2, text: 'Krishna' }] },
    { startSec: 2, endSec: 4, text: 'speaks softly', words: [] },
  ];
  const adopted = review.adopt(makeSession({
    chunks: [makeChunk({
      status: 'done',
      original: 'Krishna speaks',
      originalCues,
      translated: 'Krishna говорит',
      translationsByLanguage: {
        russian: {
          language: 'Russian', text: 'Krishna говорит',
          cues: [{ startSec: 0, endSec: 10, text: 'Krishna говорит' }],
        },
        french: {
          language: 'French', text: 'Krishna parle',
          cues: [{ startSec: 0, endSec: 10, text: 'Krishna parle' }],
        },
      },
    })],
  }));

  // Russian is ACTIVE and carries an explicit mapping; French is inactive
  // with none — explicit must beat the generic fallback for the active
  // variant, and the inactive variant stays byte-identical.
  const rewritten = review.applyGlossaryEntry(adopted, [0], {
    id: 'glossary-krishna',
    variants: ['Krishna'],
    source: 'Kṛṣṇa',
    translation: 'Кришна (generic)',
    translations: { Russian: 'Кришна (explicit)' },
    remember: true,
    createdAt: '', updatedAt: '',
  });

  // Source lane: chunk body AND matching cue texts take the same replacement;
  // timing/words/other cue fields pass through untouched.
  assert.equal(rewritten.chunks[0].original, 'Kṛṣṇa speaks');
  const cues = rewritten.chunks[0].originalCues;
  assert.deepEqual(cues.map((cue) => cue.text), ['Kṛṣṇa', 'speaks softly']);
  assert.deepEqual(
    cues[0],
    { startSec: 0, endSec: 2, text: 'Kṛṣṇa', words: [{ startSec: 0, endSec: 2, text: 'Krishna' }] },
    'cue identity/timestamps/words survive'
  );

  const variants = rewritten.chunks[0].translationsByLanguage;
  assert.equal(variants.russian.text, 'Кришна (explicit) говорит', 'explicit active mapping wins over generic');
  assert.equal(variants.french.text, 'Krishna parle', 'inactive unmapped variant stays byte-identical');
  assert.equal(rewritten.chunks[0].translated, 'Кришна (explicit) говорит', 'eager projection follows the active variant');
});
