import test from 'node:test';
import assert from 'node:assert/strict';
import { isAudioSourcePath, isVideoSourcePath, sourceMediaKind } from './media-source';

test('sourceMediaKind detects supported video files', () => {
  assert.equal(sourceMediaKind('/tmp/lecture.mp4'), 'video');
  assert.equal(sourceMediaKind('/tmp/lecture.MOV'), 'video');
  assert.equal(sourceMediaKind('/tmp/lecture.webm'), 'video');
});

test('sourceMediaKind detects supported audio files', () => {
  assert.equal(sourceMediaKind('/tmp/lecture.mp3'), 'audio');
  assert.equal(sourceMediaKind('/tmp/lecture.wav'), 'audio');
  assert.equal(sourceMediaKind('/tmp/lecture.flac'), 'audio');
});

test('source helpers reject unknown files', () => {
  assert.equal(isVideoSourcePath('/tmp/notes.txt'), false);
  assert.equal(isAudioSourcePath('/tmp/notes.txt'), false);
  assert.equal(sourceMediaKind('/tmp/notes.txt'), 'unknown');
});
