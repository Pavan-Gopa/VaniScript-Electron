import test from 'node:test';
import assert from 'node:assert/strict';
import { buildAudioReviewPrompt } from './audio-review';

test('buildAudioReviewPrompt asks for source correction with glossary', () => {
  const prompt = buildAudioReviewPrompt({
    selectedText: 'Jipatake Maharaj spoke.',
    mode: 'original',
    targetLang: 'Russian',
    speakerHint: 'Lecture',
    glossaryBlock: 'Glossary terms to preserve:\n- Jipatake Maharaj => Jayapataka Maharaja => Джаяпатака Махарадж',
  });

  assert.match(prompt, /Mode: Original transcript correction/);
  assert.match(prompt, /Jayapataka Maharaja/);
  assert.match(prompt, /Output only the corrected replacement text/);
});

test('buildAudioReviewPrompt asks for translated replacement in target language', () => {
  const prompt = buildAudioReviewPrompt({
    selectedText: 'Джай Патака говорил.',
    mode: 'translated',
    targetLang: 'Russian',
    speakerHint: '',
    glossaryBlock: '',
  });

  assert.match(prompt, /Mode: Translation correction to Russian/);
  assert.match(prompt, /Do not return analysis/);
});
