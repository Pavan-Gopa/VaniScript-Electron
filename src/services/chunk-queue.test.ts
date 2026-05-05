import test from 'node:test';
import assert from 'node:assert/strict';
import { createChunkQueueState, markChunkReady, nextPrefetchIndex } from './chunk-queue';

test('queue tracks current chunk and next prefetch target', () => {
  const state = createChunkQueueState([
    {
      chunkId: 'c1',
      startMs: 0,
      endMs: 1000,
      audioPath: '/tmp/c1.wav',
      status: 'queued',
      originalText: '',
      translatedText: null,
      segments: [],
      transcriptionProvider: 'whisper-large-v3',
      translationProvider: null,
      formatCache: {},
      error: null,
    },
    {
      chunkId: 'c2',
      startMs: 1000,
      endMs: 2000,
      audioPath: '/tmp/c2.wav',
      status: 'queued',
      originalText: '',
      translatedText: null,
      segments: [],
      transcriptionProvider: 'whisper-large-v3',
      translationProvider: null,
      formatCache: {},
      error: null,
    },
    {
      chunkId: 'c3',
      startMs: 2000,
      endMs: 3000,
      audioPath: '/tmp/c3.wav',
      status: 'queued',
      originalText: '',
      translatedText: null,
      segments: [],
      transcriptionProvider: 'whisper-large-v3',
      translationProvider: null,
      formatCache: {},
      error: null,
    },
  ]);

  const ready = markChunkReady(state, 'c1');
  assert.equal(ready.currentChunkId, 'c1');
  assert.equal(nextPrefetchIndex(ready), 1);
});
