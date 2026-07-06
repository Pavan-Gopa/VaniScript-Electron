import test from 'node:test';
import assert from 'node:assert/strict';

import { resolveShortsAudioPath } from './shorts-media-source';

test('resolveShortsAudioPath uses the full wav when available', () => {
  assert.equal(
    resolveShortsAudioPath({
      wavPath: '/tmp/session.wav',
      originalVideoPath: '/tmp/source.mov',
      sourceFile: '/tmp/source.mov',
    }),
    '/tmp/session.wav'
  );
});

test('resolveShortsAudioPath falls back to imported video when wavPath is absent', () => {
  assert.equal(
    resolveShortsAudioPath({
      wavPath: '',
      originalVideoPath: '/tmp/imported/source.mov',
      sourceFile: '/tmp/imported/source.mov',
    }),
    '/tmp/imported/source.mov'
  );
});

test('resolveShortsAudioPath falls back to source media when only sourceFile exists', () => {
  assert.equal(
    resolveShortsAudioPath({
      wavPath: '',
      originalVideoPath: '',
      sourceFile: '/tmp/imported/source.mp3',
    }),
    '/tmp/imported/source.mp3'
  );
});
