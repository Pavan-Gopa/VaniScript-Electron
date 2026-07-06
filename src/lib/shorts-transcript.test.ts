import test from 'node:test';
import assert from 'node:assert/strict';

import type { ChunkData } from '../types';
import { buildShortsCuesForClip, buildShortsTranscriptText } from './shorts-transcript';

const baseChunk: ChunkData = {
  index: 0,
  filePath: '/tmp/chunk.wav',
  durationSec: 152,
  startSec: 0,
  endSec: 152,
  original: 'Grouped fallback text',
  translated: 'Сгруппированный текст',
  status: 'done',
  approved: true,
};

test('buildShortsTranscriptText preserves structured cue timestamps for planning', () => {
  const chunks: ChunkData[] = [{
    ...baseChunk,
    originalCues: [
      { startSec: 77, endSec: 80, text: 'Earlier sentence.' },
      { startSec: 94, endSec: 99, text: 'And most of all, it meant to be in charge' },
    ],
  }];

  const transcript = buildShortsTranscriptText(chunks, 'source');

  assert.match(transcript, /\[01:17\] Earlier sentence\./);
  assert.match(transcript, /\[01:34\] And most of all, it meant to be in charge/);
});

test('buildShortsCuesForClip keeps structured cue timing relative to clip start', () => {
  const chunks: ChunkData[] = [{
    ...baseChunk,
    originalCues: [
      { startSec: 77, endSec: 80, text: 'Earlier sentence.' },
      { startSec: 94, endSec: 99, text: 'And most of all, it meant to be in charge' },
    ],
  }];

  const cues = buildShortsCuesForClip(chunks, 'source', 30, 152);
  const targetCue = cues.find((cue) => cue.text.includes('And most of all'));

  assert.deepEqual(targetCue, {
    startSec: 64,
    endSec: 69,
    text: 'And most of all, it meant to be in charge',
  });
});

test('buildShortsTranscriptText pairs source and target lines by nearest cue time', () => {
  const chunks: ChunkData[] = [{
    ...baseChunk,
    originalCues: [
      { startSec: 94, endSec: 99, text: 'And most of all, it meant to be in charge' },
    ],
    translatedCues: [
      { startSec: 94, endSec: 99, text: 'И больше всего, это означало быть ответственным' },
    ],
  }];

  assert.equal(
    buildShortsTranscriptText(chunks, 'bilingual'),
    '[01:34]\nSource: And most of all, it meant to be in charge\nTarget: И больше всего, это означало быть ответственным'
  );
});
