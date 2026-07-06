const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { resolveInstalledModelPath } = require('../electron/llamacpp-model-store');

function makeTempDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'vaniscript-gguf-'));
}

test('resolveInstalledModelPath supports direct custom GGUF drop-ins', () => {
  const root = makeTempDir();
  const filePath = path.join(root, 'custom-qwen.gguf');
  fs.writeFileSync(filePath, 'gguf');

  assert.equal(resolveInstalledModelPath(root, 'custom-qwen.gguf'), filePath);
});

test('resolveInstalledModelPath supports custom GGUF directories', () => {
  const root = makeTempDir();
  const modelDir = path.join(root, 'custom-qwen');
  const filePath = path.join(modelDir, 'custom-qwen.Q4_K_M.gguf');
  fs.mkdirSync(modelDir, { recursive: true });
  fs.writeFileSync(filePath, 'gguf');

  assert.equal(resolveInstalledModelPath(root, 'custom-qwen'), filePath);
});
