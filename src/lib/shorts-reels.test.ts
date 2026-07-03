import test from 'node:test';
import assert from 'node:assert/strict';
import { appendNonOverlappingShortsPlans, buildShortsPrompt, parseShortsPlanResponse, parseTimestampToSeconds, validateShortClip } from './shorts-reels';

test('buildShortsPrompt includes duration, count, language, and Vaishnava criteria', () => {
  const prompt = buildShortsPrompt({
    transcript: '[00:12] Take shelter of Krishna.',
    count: 3,
    minDurationSec: 45,
    maxDurationSec: 90,
    outputLanguage: 'Russian',
  });

  assert.match(prompt, /3/);
  assert.match(prompt, /45/);
  assert.match(prompt, /90/);
  assert.match(prompt, /Russian/);
  assert.match(prompt, /Vaishnava/i);
  assert.match(prompt, /JSON/);
  assert.match(prompt, /captionText/);
  assert.match(prompt, /1\.5-4 seconds/);
  assert.match(prompt, /Never put a whole 45-180 second clip into one or two caption cues/);
});

test('parseShortsPlanResponse extracts JSON array from model text', () => {
  const clips = parseShortsPlanResponse('```json\n[{ "start": "00:01:00", "end": "00:02:00", "title": "Shelter", "summary": "A strong moment.", "hook": "Clear spiritual advice.", "captionText": "[01:00] Take shelter\\n[01:03] of Krishna" }]\n```');
  assert.equal(clips.length, 1);
  assert.equal(clips[0].start, '00:01:00');
  assert.equal(clips[0].title, 'Shelter');
  assert.equal(clips[0].captionText, '[01:00] Take shelter\n[01:03] of Krishna');
});

test('bilingual Shorts prompt requests aligned source and target caption scripts', () => {
  const prompt = buildShortsPrompt({
    transcript: '[04:56]\nSource: Build Mayapur.\nTarget: Стройте Майяпур.',
    count: 1,
    minDurationSec: 30,
    maxDurationSec: 60,
    outputLanguage: 'Russian',
    mode: 'bilingual',
  });

  assert.match(prompt, /sourceCaptionText/);
  assert.match(prompt, /targetCaptionText/);
  assert.match(prompt, /same timestamp markers/);
});

test('buildShortsPrompt asks the planner to avoid existing clip ranges', () => {
  const prompt = buildShortsPrompt({
    transcript: '[05:23] Existing moment.\n\n[07:00] New moment.',
    count: 2,
    minDurationSec: 30,
    maxDurationSec: 90,
    outputLanguage: 'Russian',
    mode: 'bilingual',
    existingClips: [
      { start: '05:23', end: '06:49', title: 'Economy of giving' },
    ],
  });

  assert.match(prompt, /Already selected ranges/i);
  assert.match(prompt, /05:23 -> 06:49/);
  assert.match(prompt, /Do not choose moments that overlap/i);
});

test('appendNonOverlappingShortsPlans preserves existing edited clips and appends new ranges', () => {
  const existing = [{
    start: '05:23',
    end: '06:49',
    title: 'Keep this edited clip',
    summary: 'Already edited.',
    hook: 'Keep it.',
    sourceAlignment: [{ id: 'sub-1', start: 0, end: 3, text: 'Edited captions', words: [] }],
  }];
  const incoming = [
    { start: '05:30', end: '06:30', title: 'Duplicate range', summary: '', hook: '' },
    { start: '07:00', end: '08:00', title: 'Fresh range', summary: '', hook: '' },
  ];

  const result = appendNonOverlappingShortsPlans(existing, incoming);

  assert.equal(result.plans.length, 2);
  assert.strictEqual(result.plans[0], existing[0]);
  assert.equal(result.plans[1].title, 'Fresh range');
  assert.deepEqual(result.addedIndexes, [1]);
  assert.equal(result.skippedOverlapping.length, 1);
  assert.equal(result.skippedOverlapping[0].title, 'Duplicate range');
});

test('appendNonOverlappingShortsPlans filters overlapping incoming candidates against newly added clips', () => {
  const result = appendNonOverlappingShortsPlans([], [
    { start: '01:00', end: '02:00', title: 'First', summary: '', hook: '' },
    { start: '01:30', end: '02:20', title: 'Overlaps first', summary: '', hook: '' },
    { start: '02:02', end: '02:45', title: 'Adjacent fresh range', summary: '', hook: '' },
  ]);

  assert.deepEqual(result.plans.map((plan) => plan.title), ['First', 'Adjacent fresh range']);
  assert.deepEqual(result.addedIndexes, [0, 1]);
  assert.deepEqual(result.skippedOverlapping.map((plan) => plan.title), ['Overlaps first']);
});

test('parseTimestampToSeconds handles mm:ss and hh:mm:ss', () => {
  assert.equal(parseTimestampToSeconds('09:55'), 595);
  assert.equal(parseTimestampToSeconds('01:02:03'), 3723);
});

test('validateShortClip rejects clips outside requested duration', () => {
  assert.equal(validateShortClip({ startSec: 60, endSec: 120 }, 45, 90).ok, true);
  assert.equal(validateShortClip({ startSec: 60, endSec: 200 }, 45, 90).ok, false);
});
