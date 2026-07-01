const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { ensureRuntimeDirs, modelsDir, resolveModelsRoot } = require('../shared/localModelsRoot');
const { roleOf, scanLocalModels } = require('../shared/scanLocalModels');

function makeTempDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'vaniscript-local-models-'));
}

function writeJson(filePath, value) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, JSON.stringify(value, null, 2));
}

test('resolver creates stable AI_LOCAL_MODELS runtime directories', () => {
  const root = makeTempDir();

  ensureRuntimeDirs(root);

  for (const runtime of ['mlx', 'gguf', 'ggml', 'whisperkit']) {
    assert.equal(modelsDir(runtime, { configuredRoot: root }), path.join(root, runtime));
    assert.equal(fs.statSync(path.join(root, runtime)).isDirectory(), true);
  }
});

test('resolver prefers app setting, environment, config file, then default root', () => {
  const homeDir = makeTempDir();
  const configuredRoot = path.join(homeDir, 'Configured');
  const envRoot = path.join(homeDir, 'Env');
  const configRoot = path.join(homeDir, 'Config');
  fs.mkdirSync(configuredRoot, { recursive: true });
  fs.mkdirSync(envRoot, { recursive: true });
  fs.mkdirSync(configRoot, { recursive: true });
  writeJson(path.join(homeDir, 'Library', 'Application Support', 'AILocalModels', 'config.json'), { root: configRoot });

  assert.equal(resolveModelsRoot({ configuredRoot, env: { AI_LOCAL_MODELS_DIR: envRoot }, homeDir }), configuredRoot);
  assert.equal(resolveModelsRoot({ env: { AI_LOCAL_MODELS_DIR: envRoot }, homeDir }), envRoot);
  assert.equal(resolveModelsRoot({ env: {}, homeDir }), configRoot);
});

test('scanLocalModels supports VaniScript ASR and translation storage layouts', () => {
  const root = makeTempDir();
  ensureRuntimeDirs(root);

  fs.mkdirSync(path.join(root, 'ggml', 'whisper-large-v3'), { recursive: true });
  fs.writeFileSync(path.join(root, 'ggml', 'whisper-large-v3', 'ggml-large-v3-q8_0.bin'), '');
  fs.writeFileSync(path.join(root, 'ggml', 'drop-in-whisper.bin'), '');
  fs.mkdirSync(path.join(root, 'gguf', 'qwen35-2b-instruct-q4_k_m'), { recursive: true });
  fs.writeFileSync(path.join(root, 'gguf', 'qwen35-2b-instruct-q4_k_m', 'Qwen_Qwen3.5-2B-Q4_K_M.gguf'), '');
  fs.mkdirSync(path.join(root, 'mlx', 'Qwen-MLX'), { recursive: true });
  writeJson(path.join(root, 'mlx', 'Qwen-MLX', 'config.json'), { model_type: 'qwen2' });

  assert.equal(roleOf(path.join(root, 'ggml', 'whisper-large-v3'), { runtime: 'ggml' }), 'asr');
  assert.equal(roleOf(path.join(root, 'ggml', 'drop-in-whisper.bin'), { runtime: 'ggml' }), 'asr');
  assert.equal(roleOf(path.join(root, 'gguf', 'qwen35-2b-instruct-q4_k_m'), { runtime: 'gguf' }), 'polish');
  assert.equal(roleOf(path.join(root, 'mlx', 'Qwen-MLX'), { runtime: 'mlx' }), 'polish');

  assert.deepEqual(scanLocalModels({ root }).map((entry) => `${entry.runtime}:${entry.name}:${entry.role}`).sort(), [
    'ggml:drop-in-whisper.bin:asr',
    'ggml:whisper-large-v3:asr',
    'gguf:qwen35-2b-instruct-q4_k_m:polish',
    'mlx:Qwen-MLX:polish',
  ]);
});
