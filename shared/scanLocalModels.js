const fs = require('fs');
const path = require('path');
const {
  RUNTIMES,
  ensureRuntimeDirs,
  resolveModelsRoot,
} = require('./localModelsRoot');

const ASR_HINTS = ['whisper', 'parakeet', 'ctc', 'rnnt', 'transducer'];
const POLISH_HINTS = ['qwen', 'llama', 'gemma', 'mistral', 'mixtral', 'phi', 'deepseek', 'yi', 'falcon', 'gpt', 'granite'];

function safeReadJson(filePath) {
  try {
    return JSON.parse(fs.readFileSync(filePath, 'utf8'));
  } catch {
    return null;
  }
}

function listDir(dirPath) {
  try {
    return fs.readdirSync(dirPath, { withFileTypes: true });
  } catch {
    return [];
  }
}

function valuesForRoleDetection(config) {
  if (!config || typeof config !== 'object') return '';
  const values = [];
  if (typeof config.model_type === 'string') values.push(config.model_type);
  if (Array.isArray(config.architectures)) values.push(...config.architectures.filter((value) => typeof value === 'string'));
  if (typeof config.name_or_path === 'string') values.push(config.name_or_path);
  return values.join(' ').toLowerCase();
}

function roleFromMlxConfig(modelPath) {
  const haystack = valuesForRoleDetection(safeReadJson(path.join(modelPath, 'config.json')));
  if (!haystack) return 'unsupported';
  if (ASR_HINTS.some((hint) => haystack.includes(hint))) return 'asr';
  if (POLISH_HINTS.some((hint) => haystack.includes(hint))) return 'polish';
  return 'unsupported';
}

function directoryContainsExtension(modelPath, extension) {
  return listDir(modelPath).some((item) => item.isFile() && item.name.toLowerCase().endsWith(extension));
}

function roleOf(modelPath, options = {}) {
  const runtime = options.runtime || path.basename(path.dirname(modelPath));
  const ext = path.extname(modelPath).toLowerCase();

  if (runtime === 'ggml' || ext === '.bin') {
    if (ext === '.bin') return 'asr';
    return directoryContainsExtension(modelPath, '.bin') ? 'asr' : 'unsupported';
  }
  if (runtime === 'gguf' || ext === '.gguf') {
    if (ext === '.gguf') return 'polish';
    return directoryContainsExtension(modelPath, '.gguf') ? 'polish' : 'unsupported';
  }
  if (runtime === 'mlx') return roleFromMlxConfig(modelPath);
  if (runtime === 'whisperkit') return fs.existsSync(modelPath) ? 'asr' : 'unsupported';

  return 'unsupported';
}

function modelEntry(root, runtime, name, role) {
  const modelPath = path.join(root, runtime, name);
  return {
    name,
    runtime,
    role,
    supported: role !== 'unsupported',
    path: modelPath,
  };
}

function scanRuntime(root, runtime) {
  const dir = path.join(root, runtime);
  const entries = [];
  for (const item of listDir(dir)) {
    if (item.name.startsWith('.')) continue;
    if ((runtime === 'ggml' || runtime === 'gguf') && !(item.isFile() || item.isDirectory())) continue;
    if ((runtime === 'mlx' || runtime === 'whisperkit') && !item.isDirectory()) continue;
    const role = roleOf(path.join(dir, item.name), { runtime });
    entries.push(modelEntry(root, runtime, item.name, role));
  }
  return entries;
}

function scanLocalModels(options = {}) {
  const root = options.root || resolveModelsRoot(options);
  ensureRuntimeDirs(root);
  const runtimes = options.runtimes || RUNTIMES;
  return runtimes.flatMap((runtime) => scanRuntime(root, runtime));
}

module.exports = {
  roleOf,
  scanLocalModels,
};
