import test from 'node:test';
import assert from 'node:assert/strict';

import { audioMimeTypeForPath, createObjectAudioUrl } from './audio-source';

test('audioMimeTypeForPath detects supported audio formats', () => {
  assert.equal(audioMimeTypeForPath('/tmp/example.wav'), 'audio/wav');
  assert.equal(audioMimeTypeForPath('/tmp/example.mp3'), 'audio/mpeg');
  assert.equal(audioMimeTypeForPath('/tmp/example.m4a'), 'audio/mp4');
  assert.equal(audioMimeTypeForPath('/tmp/example.unknown'), 'application/octet-stream');
});

test('createObjectAudioUrl returns a blob URL instead of a file URL', () => {
  const url = createObjectAudioUrl(new Uint8Array([1, 2, 3, 4]), 'audio/wav');

  try {
    assert.match(url, /^blob:/);
    assert.doesNotMatch(url, /^file:/);
  } finally {
    URL.revokeObjectURL(url);
  }
});
