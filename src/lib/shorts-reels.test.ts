import test from 'node:test';
import assert from 'node:assert/strict';
import { buildShortsPrompt, parseShortsPlanResponse, parseTimestampToSeconds, validateShortClip } from './shorts-reels';

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

test('parseTimestampToSeconds handles mm:ss and hh:mm:ss', () => {
  assert.equal(parseTimestampToSeconds('09:55'), 595);
  assert.equal(parseTimestampToSeconds('01:02:03'), 3723);
});

test('validateShortClip rejects clips outside requested duration', () => {
  assert.equal(validateShortClip({ startSec: 60, endSec: 120 }, 45, 90).ok, true);
  assert.equal(validateShortClip({ startSec: 60, endSec: 200 }, 45, 90).ok, false);
});
