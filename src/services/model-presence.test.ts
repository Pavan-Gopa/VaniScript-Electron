import test from 'node:test';
import assert from 'node:assert/strict';
import { DEFAULT_SETTINGS } from './storage';
import { reconcileLocalModelStatesWithDisk } from './model-presence';

test('reconcileLocalModelStatesWithDisk clears stale downloaded models when files disappeared', () => {
  const settings: any = {
    ...DEFAULT_SETTINGS,
    transcriptionProvider: 'whisper-medium-en',
    translationProvider: 'qwen35-4b-instruct-q4_k_m',
    localAsrModels: {
      'whisper-medium-en': { status: 'downloaded', label: 'Whisper Medium English', path: '/missing/ggml.bin' },
    },
    localTranslationModels: {
      'qwen35-4b-instruct-q4_k_m': { status: 'downloaded', label: 'Qwen 3.5 4B', path: '/missing/model.gguf' },
    },
  };

  const next = reconcileLocalModelStatesWithDisk(settings, {
    asr: {
      'whisper-medium-en': { status: 'not_found', path: null },
    },
    translation: {
      'qwen35-4b-instruct-q4_k_m': { status: 'not_found', path: null },
    },
  });

  assert.equal(next.localAsrModels['whisper-medium-en'].status, 'not_downloaded');
  assert.equal(next.localAsrModels['whisper-medium-en'].path, null);
  assert.equal(next.localTranslationModels['qwen35-4b-instruct-q4_k_m'].status, 'not_downloaded');
  assert.equal(next.localTranslationModels['qwen35-4b-instruct-q4_k_m'].path, null);
  assert.notEqual(next.transcriptionProvider, 'whisper-medium-en');
  assert.notEqual(next.translationProvider, 'qwen35-4b-instruct-q4_k_m');
});

test('reconcileLocalModelStatesWithDisk treats incomplete models as not downloaded', () => {
  const settings: any = {
    ...DEFAULT_SETTINGS,
    translationProvider: 'qwen35-9b-instruct-q4_k_m',
    localTranslationModels: {
      'qwen35-9b-instruct-q4_k_m': { status: 'downloaded', label: 'Qwen 3.5 9B', path: '/partial/model.gguf' },
    },
  };

  const next = reconcileLocalModelStatesWithDisk(settings, {
    translation: {
      'qwen35-9b-instruct-q4_k_m': { status: 'incomplete', path: null },
    },
  });

  assert.equal(next.localTranslationModels['qwen35-9b-instruct-q4_k_m'].status, 'not_downloaded');
  assert.equal(next.localTranslationModels['qwen35-9b-instruct-q4_k_m'].path, null);
  assert.notEqual(next.translationProvider, 'qwen35-9b-instruct-q4_k_m');
});
