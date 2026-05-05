import test from 'node:test';
import assert from 'node:assert/strict';
import { getAvailableTranscriptionProviders, getAvailableTranslationProviders } from './provider-registry';

test('provider registry exposes cloud entries only when keys exist and disables translation when target is Same', () => {
  const settings = {
    geminiKey: 'g',
    openaiKey: '',
    anthropicKey: 'a',
    localAsrModels: {
      'parakeet-english': { status: 'downloaded', label: 'Parakeet English' },
    },
    localTranslationModels: {
      'gemma-4b-it-4bit': { status: 'downloaded', label: 'Gemma 4B IT 4-bit' },
    },
  } as any;

  const transcription = getAvailableTranscriptionProviders(settings);
  const translationDisabled = getAvailableTranslationProviders(settings, 'same');
  const translationEnabled = getAvailableTranslationProviders(settings, 'Russian');

  assert.equal(transcription.some((p) => p.id === 'gemini-cloud'), true);
  assert.equal(transcription.some((p) => p.id === 'gpt-cloud'), false);
  assert.equal(transcription.some((p) => p.id === 'claude-cloud'), true);
  assert.equal(transcription.some((p) => p.id === 'parakeet-english'), true);
  assert.equal(translationDisabled.enabled, false);
  assert.equal(translationEnabled.enabled, true);
  assert.equal(translationEnabled.providers.some((p) => p.id === 'gemma-4b-it-4bit'), true);
});
