import test from 'node:test';
import assert from 'node:assert/strict';
import { DEFAULT_SETTINGS } from '../services/storage';
import { getApiKeyForProvider, isCloudProvider, isLocalAsrProvider, isLocalTranslationProvider } from './provider-runtime';

test('provider runtime resolves api keys and local model ids', () => {
  const settings = {
    ...DEFAULT_SETTINGS,
    geminiKey: 'gem-key',
    openaiKey: 'open-key',
    anthropicKey: 'anth-key',
  };

  assert.equal(getApiKeyForProvider(settings, 'gemini-cloud'), 'gem-key');
  assert.equal(getApiKeyForProvider(settings, 'gpt-cloud'), 'open-key');
  assert.equal(getApiKeyForProvider(settings, 'claude-cloud'), 'anth-key');
  assert.equal(getApiKeyForProvider(settings, 'whisper-large-v3'), '');

  assert.equal(isCloudProvider('gemini-cloud'), true);
  assert.equal(isCloudProvider('whisper-large-v3'), false);
  assert.equal(isLocalAsrProvider(settings, 'whisper-large-v3'), true);
  assert.equal(isLocalTranslationProvider(settings, 'qwen35-2b-instruct-q4_k_m'), true);
});
