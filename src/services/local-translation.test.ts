import test from 'node:test';
import assert from 'node:assert/strict';
import { shouldTranslateChunk } from './local-translation';

test('shouldTranslateChunk skips translation when target language is Same', () => {
  assert.equal(shouldTranslateChunk('same'), false);
  assert.equal(shouldTranslateChunk('Russian'), true);
});
