import test from 'node:test';
import assert from 'node:assert/strict';
import { shouldTranslateChunk, splitLocalTranslationBatches } from './local-translation';

test('shouldTranslateChunk skips translation when target language is Same', () => {
  assert.equal(shouldTranslateChunk('same'), false);
  assert.equal(shouldTranslateChunk('Russian'), true);
});

test('splitLocalTranslationBatches groups timestamp paragraphs without dropping markers', () => {
  const source = [
    '[00:00] First paragraph.',
    '[00:12] Second paragraph with a bit more text.',
    '[00:28] Third paragraph.',
  ].join('\n\n');

  const batches = splitLocalTranslationBatches(source, 90);

  assert.deepEqual(batches, [
    '[00:00] First paragraph.\n\n[00:12] Second paragraph with a bit more text.',
    '[00:28] Third paragraph.',
  ]);
  assert.match(batches.join('\n\n'), /\[00:12\]/);
});
