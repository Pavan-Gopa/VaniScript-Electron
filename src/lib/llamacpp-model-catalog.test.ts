import test from 'node:test';
import assert from 'node:assert/strict';
import {
  LLAMACPP_TRANSLATION_MODELS,
  createDefaultTranslationModelStateMap,
  getRecommendedTranslationModel,
} from './llamacpp-model-catalog';

test('llama.cpp translation catalog exposes curated model tiers', () => {
  assert.equal(LLAMACPP_TRANSLATION_MODELS.some((m) => m.id === 'qwen35-08b-instruct-q4_k_m'), true);
  assert.equal(LLAMACPP_TRANSLATION_MODELS.some((m) => m.id === 'qwen35-2b-instruct-q4_k_m'), true);
  assert.equal(LLAMACPP_TRANSLATION_MODELS.some((m) => m.id === 'gemma-4-4b-it-q4_k_m'), true);
  assert.equal(
    LLAMACPP_TRANSLATION_MODELS.find((m) => m.id === 'qwen35-2b-instruct-q4_k_m')?.repositoryId,
    'bartowski/Qwen_Qwen3.5-2B-GGUF'
  );
  assert.equal(
    LLAMACPP_TRANSLATION_MODELS.find((m) => m.id === 'gemma-4-2b-it-q4_k_m')?.fileName,
    'google_gemma-4-E2B-it-Q4_K_M.gguf'
  );
  assert.equal(getRecommendedTranslationModel()?.id, 'qwen35-2b-instruct-q4_k_m');
});

test('default translation model state map is created from the curated catalog', () => {
  const stateMap = createDefaultTranslationModelStateMap();
  assert.equal(stateMap['qwen35-2b-instruct-q4_k_m']?.label, 'Qwen 3.5 2B Q4_K_M');
  assert.equal(stateMap['qwen35-2b-instruct-q4_k_m']?.runtime, 'llamacpp');
  assert.equal(stateMap['gemma-4-4b-it-q4_k_m']?.status, 'not_downloaded');
});
