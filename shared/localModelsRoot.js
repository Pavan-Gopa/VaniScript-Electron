const fs = require('fs');
const os = require('os');
const path = require('path');

const RUNTIMES = Object.freeze(['mlx', 'gguf', 'ggml', 'whisperkit']);

function expandHome(value, homeDir = os.homedir()) {
  if (!value || typeof value !== 'string') return null;
  if (value === '~') return homeDir;
  if (value.startsWith('~/')) return path.join(homeDir, value.slice(2));
  return value;
}

function configPath(homeDir = os.homedir()) {
  return path.join(homeDir, 'Library', 'Application Support', 'AILocalModels', 'config.json');
}

function readConfiguredRoot(homeDir = os.homedir()) {
  try {
    const raw = fs.readFileSync(configPath(homeDir), 'utf8');
    const parsed = JSON.parse(raw);
    return typeof parsed.root === 'string' ? parsed.root : null;
  } catch {
    return null;
  }
}

function isUsableRoot(root) {
  if (!root || !path.isAbsolute(root)) return false;
  try {
    return fs.statSync(root).isDirectory();
  } catch (error) {
    return error && error.code === 'ENOENT';
  }
}

function firstUsableRoot(candidates) {
  for (const candidate of candidates) {
    if (candidate && isUsableRoot(candidate)) return candidate;
  }
  return null;
}

function resolveModelsRoot(options = {}) {
  const homeDir = options.homeDir || os.homedir();
  const env = options.env || process.env;
  const configuredRoot = expandHome(options.configuredRoot, homeDir);
  const envRoot = expandHome(env.AI_LOCAL_MODELS_DIR, homeDir);
  const fileRoot = expandHome(options.configRoot || readConfiguredRoot(homeDir), homeDir);
  const defaultRoot = expandHome(options.defaultRoot || path.join(homeDir, 'AI_LOCAL_MODELS'), homeDir);
  const legacyRoot = expandHome(options.legacyRoot, homeDir);

  return firstUsableRoot([configuredRoot, envRoot, fileRoot, defaultRoot, legacyRoot])
    || defaultRoot;
}

function ensureRuntimeDirs(root) {
  fs.mkdirSync(root, { recursive: true });
  for (const runtime of RUNTIMES) {
    fs.mkdirSync(path.join(root, runtime), { recursive: true });
  }
}

function modelsDir(runtime, options = {}) {
  if (!RUNTIMES.includes(runtime)) {
    throw new Error(`Unsupported runtime: ${runtime}`);
  }
  const root = resolveModelsRoot(options);
  ensureRuntimeDirs(root);
  return path.join(root, runtime);
}

module.exports = {
  RUNTIMES,
  configPath,
  ensureRuntimeDirs,
  modelsDir,
  resolveModelsRoot,
};
