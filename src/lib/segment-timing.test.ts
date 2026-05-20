import test from 'node:test';
import assert from 'node:assert/strict';
import {
  buildReadableCuesFromWords,
  buildSrtFromTimedCues,
  buildTimedTextFromWords,
  buildVttFromTimedCues,
  splitTextIntoReadableCues,
} from './segment-timing';

test('buildReadableCuesFromWords creates dense sentence-aware cues from word timestamps', () => {
  const cues = buildReadableCuesFromWords([
    { text: 'The', start: 0, end: 0.2 },
    { text: 'spiritual', start: 0.2, end: 0.8 },
    { text: 'city', start: 0.8, end: 1.1 },
    { text: 'is', start: 1.1, end: 1.3 },
    { text: 'Mayapur.', start: 1.3, end: 1.8 },
    { text: 'It', start: 2.0, end: 2.2 },
    { text: 'is', start: 2.2, end: 2.4 },
    { text: 'built', start: 2.4, end: 2.8 },
    { text: 'on', start: 2.8, end: 3.0 },
    { text: 'giving.', start: 3.0, end: 3.4 },
  ], { maxCueDurationSec: 4, maxCharsPerCue: 42 });

  assert.deepEqual(cues.map((cue) => cue.text), [
    'The spiritual city is Mayapur.',
    'It is built on giving.',
  ]);
  assert.equal(cues[0].startSec, 0);
  assert.equal(cues[0].endSec, 1.8);
  assert.equal(cues[1].startSec, 2);
  assert.equal(cues[1].endSec, 3.4);
});

test('buildReadableCuesFromWords soft-splits long clauses without losing word timing', () => {
  const words = 'And on the strength of this we are representing the most magnanimous nature of Sri Caitanya Mahaprabhu.'
    .split(' ')
    .map((text, index) => ({ text, start: index * 0.42, end: (index + 1) * 0.42 }));

  const cues = buildReadableCuesFromWords(words, {
    maxCueDurationSec: 3,
    maxCharsPerCue: 36,
    maxWordsPerCue: 8,
  });

  assert.ok(cues.length >= 3);
  assert.equal(cues[0].startSec, 0);
  assert.equal(cues.at(-1)?.endSec, words.at(-1)?.end);
  assert.equal(cues.map((cue) => cue.text).join(' '), words.map((word) => word.text).join(' '));
  assert.ok(cues.every((cue) => cue.text.length <= 54));
});

test('splitTextIntoReadableCues gives usable fallback timings when word timestamps are absent', () => {
  const cues = splitTextIntoReadableCues(
    'First sentence. Second sentence is a little longer, and it should split cleanly.',
    10,
    { maxCueDurationSec: 4, maxCharsPerCue: 34 },
  );

  assert.ok(cues.length >= 2);
  assert.equal(cues[0].startSec, 0);
  assert.equal(cues.at(-1)?.endSec, 10);
  assert.equal(cues.map((cue) => cue.text).join(' '), 'First sentence. Second sentence is a little longer, and it should split cleanly.');
});

test('timed words can be rendered as TXT, SRT, and VTT without giant cues', () => {
  const words = [
    { text: 'Krishna', start: 0, end: 0.5 },
    { text: 'speaks', start: 0.5, end: 1.0 },
    { text: 'about', start: 1.0, end: 1.3 },
    { text: 'bhakti.', start: 1.3, end: 1.8 },
  ];
  const cues = buildReadableCuesFromWords(words);

  assert.equal(buildTimedTextFromWords(words), '[00:00] Krishna speaks about bhakti.');
  assert.match(buildSrtFromTimedCues(cues), /1\n00:00:00,000 --> 00:00:01,800\nKrishna speaks about bhakti\./);
  assert.match(buildVttFromTimedCues(cues), /^WEBVTT\n\n00:00:00\.000 --> 00:00:01\.800\nKrishna speaks about bhakti\./);
});
