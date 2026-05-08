import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const {
  buildDownloadUrl,
  getInstalledModelPath,
  getTranslationModelDescriptor,
} = require('../../electron/llamacpp-model-store.js');

test('llamacpp model store exposes curated Hugging Face download metadata', () => {
  const descriptor = getTranslationModelDescriptor('qwen35-2b-instruct-q4_k_m');

  assert.equal(descriptor.repositoryId, 'bartowski/Qwen_Qwen3.5-2B-GGUF');
  assert.equal(descriptor.fileName, 'Qwen_Qwen3.5-2B-Q4_K_M.gguf');
  assert.match(buildDownloadUrl('qwen35-2b-instruct-q4_k_m'), /huggingface\.co\/bartowski\/Qwen_Qwen3\.5-2B-GGUF\/resolve\/main\/Qwen_Qwen3\.5-2B-Q4_K_M\.gguf$/);
});

test('llamacpp model store resolves app-managed install path per model id', () => {
  const installPath = getInstalledModelPath('/tmp/translation-models', 'gemma-4-2b-it-q4_k_m');
  assert.equal(installPath, '/tmp/translation-models/gemma-4-2b-it-q4_k_m/google_gemma-4-E2B-it-Q4_K_M.gguf');
});
