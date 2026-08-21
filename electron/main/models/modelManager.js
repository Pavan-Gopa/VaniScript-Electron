'use strict';

/**
 * MOD-01 — Local model manager (Main process, CommonJS, no electron import).
 *
 * Provides secure scanning, checksum verification, and relocation of local
 * model artifacts (GGUF, GGML/.bin, WhisperKit .mlmodelc, MLX dirs). The module
 * is deliberately free of any `electron` import so it can be required directly
 * by `node --test` without an Electron runtime.
 *
 * Safety guarantees:
 *  - Every path is resolved and asserted to stay within an allowed root before
 *    any read/write (path-traversal guard). Existing sources are realpath'd so
 *    symlink escapes are also blocked.
 *  - Relocation streams the file while computing a checksum, verifies the copy
 *    is byte-identical, removes the source only after a verified copy exists,
 *    and deletes any partial destination on failure (never leaves corrupt bytes).
 *  - Missing files raise NOT_FOUND; checksum mismatches / unreadable content
 *    raise CORRUPT_DATA; out-of-root paths raise PERMISSION_DENIED; an existing
 *    destination raises OUTPUT_COLLISION; malformed args raise VALIDATION_FAILED.
 */

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const {
  RUNTIMES,
  resolveModelsRoot,
  ensureRuntimeDirs,
} = require('../../../shared/localModelsRoot');

// ─── Canonical error model ───────────────────────────────────────────────────
// Plain Node cannot require the TypeScript contracts module, so this module
// carries a self-contained structural AppError with the canonical codes. The
// shape matches shared/contracts/errors.ts (code + isAppError marker) so the
// IPC layer's `err.isAppError` check and the unit tests both accept it.

const ERROR_CODES = Object.freeze([
  'VALIDATION_FAILED',
  'NOT_FOUND',
  'CONFLICT',
  'CANCELLED',
  'PERMISSION_DENIED',
  'CAPABILITY_UNAVAILABLE',
  'PROVIDER_ERROR',
  'MODEL_UNAVAILABLE',
  'SOURCE_CHANGED',
  'OUTPUT_COLLISION',
  'UPDATE_BLOCKED',
  'CORRUPT_DATA',
  'INTERNAL',
]);

class AppError extends Error {
  constructor(code, message, details) {
    super(message);
    this.name = 'AppError';
    this.code = ERROR_CODES.includes(code) ? code : 'INTERNAL';
    this.message = message;
    this.details = details;
    this.isAppError = true;
    if (Error.captureStackTrace) {
      Error.captureStackTrace(this, AppError);
    }
  }
}

function createAppError(code, message, details) {
  return new AppError(code, message, details);
}

/** Canonical IPC channel (mirrors MODELS_MANAGE_CHANNEL in shared/contracts/models.ts). */
const MODELS_MANAGE_CHANNEL = 'models:manage';
const DEFAULT_ALGORITHM = 'sha256';
const MAX_SCAN_DEPTH = 3;

// ─── Path safety ─────────────────────────────────────────────────────────────

/**
 * Resolve `target` and assert it is `root` or a descendant. Returns the
 * resolved target. Throws PERMISSION_DENIED on traversal.
 */
function assertWithinRoot(target, root, label) {
  if (!target || typeof target !== 'string') {
    throw createAppError('VALIDATION_FAILED', `${label} must be a non-empty path string`);
  }
  const resolvedRoot = path.resolve(root);
  const resolvedTarget = path.resolve(target);
  const inside = resolvedTarget === resolvedRoot || resolvedTarget.startsWith(resolvedRoot + path.sep);
  if (!inside) {
    throw createAppError(
      'PERMISSION_DENIED',
      `Path traversal blocked: ${label} "${target}" escapes allowed root "${root}"`,
      { target, root },
    );
  }
  return resolvedTarget;
}

/**
 * Resolve an existing path to its real (symlink-free) location and assert it
 * stays within `root`. Throws NOT_FOUND when missing, PERMISSION_DENIED on
 * symlink escape, CORRUPT_DATA on stat failure.
 */
function assertRealWithinRoot(target, root, label) {
  let real;
  try {
    real = fs.realpathSync(target);
  } catch (err) {
    if (err && err.code === 'ENOENT') {
      throw createAppError('NOT_FOUND', `${label} not found: ${target}`);
    }
    throw createAppError('CORRUPT_DATA', `Unable to resolve ${label} "${target}": ${err.message}`, { code: err.code });
  }
  const resolvedRoot = path.resolve(root);
  // Resolve the root through symlinks too (e.g. macOS /tmp -> /private/tmp) so
  // the real source is judged against the real root, not a lexically resolved one.
  let rootReal = resolvedRoot;
  try {
    rootReal = fs.realpathSync(resolvedRoot);
  } catch (_) {
    /* root may not exist yet; fall back to lexical resolution */
  }
  const inside = real === rootReal || real.startsWith(rootReal + path.sep);
  if (!inside) {
    throw createAppError(
      'PERMISSION_DENIED',
      `Symlink escape blocked: ${label} "${target}" resolves outside allowed root`,
      { target, real, root: rootReal },
    );
  }
  return real;
}

// ─── Hashing / copying ───────────────────────────────────────────────────────

/** Stream-hash a file, resolving to { checksum, sizeBytes }. */
function hashFile(filePath, algorithm) {
  return new Promise((resolve, reject) => {
    const hash = crypto.createHash(algorithm);
    let sizeBytes = 0;
    const stream = fs.createReadStream(filePath);
    stream.on('data', (chunk) => {
      hash.update(chunk);
      sizeBytes += chunk.length;
    });
    stream.on('error', (err) => {
      if (err && err.code === 'ENOENT') {
        reject(createAppError('NOT_FOUND', `Model file not found: ${filePath}`));
      } else {
        reject(createAppError('CORRUPT_DATA', `Failed to read "${filePath}": ${err.message}`, { code: err.code }));
      }
    });
    stream.on('end', () => resolve({ checksum: hash.digest('hex'), sizeBytes }));
  });
}

/** Stream-copy `source`→`dest` while hashing; resolves to { checksum, sizeBytes }. */
function copyStreamWithHash(source, dest, algorithm) {
  return new Promise((resolve, reject) => {
    const hash = crypto.createHash(algorithm);
    const read = fs.createReadStream(source);
    const write = fs.createWriteStream(dest);
    let sizeBytes = 0;
    read.on('data', (chunk) => {
      hash.update(chunk);
      sizeBytes += chunk.length;
      if (!write.write(chunk)) read.pause();
    });
    write.on('drain', () => read.resume());
    read.on('error', (err) => {
      read.destroy();
      write.destroy();
      reject(createAppError('CORRUPT_DATA', `Failed to read source "${source}": ${err.message}`, { code: err.code }));
    });
    write.on('error', (err) => {
      read.destroy();
      reject(createAppError('INTERNAL', `Failed to write destination "${dest}": ${err.message}`, { code: err.code }));
    });
    read.on('end', () => write.end());
    write.on('finish', () => resolve({ checksum: hash.digest('hex'), sizeBytes }));
  });
}

// ─── Classification ──────────────────────────────────────────────────────────

/**
 * Detect the runtime of an entry. Returns a ModelRuntime string or null when
 * the entry is not a supported model artifact. Directory detection inspects
 * `.mlmodelc` (WhisperKit) and the presence of `config.json` (MLX).
 */
function classify(entryPath, name, isDirectory) {
  const lower = name.toLowerCase();
  if (isDirectory) {
    if (lower.endsWith('.mlmodelc')) return 'whisperkit';
    try {
      if (fs.existsSync(path.join(entryPath, 'config.json'))) return 'mlx';
    } catch (_) {
      /* ignore */
    }
    return null;
  }
  if (lower.endsWith('.gguf')) return 'gguf';
  if (lower.endsWith('.bin')) return 'ggml';
  if (lower.endsWith('.safetensors')) return 'mlx';
  return null;
}

function defaultScanDirs(options) {
  const root = options.root ? path.resolve(options.root) : resolveModelsRoot();
  ensureRuntimeDirs(root);
  return RUNTIMES.map((runtime) => path.join(root, runtime));
}

function collectDir(dir, runtimes, includeSizes, models, depth) {
  let entries;
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch (_) {
    return;
  }
  for (const ent of entries) {
    if (ent.name.startsWith('.')) continue;
    const full = path.join(dir, ent.name);
    const isDir = ent.isDirectory();
    const runtime = classify(full, ent.name, isDir);
    if (runtime && runtimes.includes(runtime)) {
      let sizeBytes;
      if (includeSizes && !isDir) {
        try {
          sizeBytes = fs.statSync(full).size;
        } catch (_) {
          /* ignore */
        }
      }
      models.push({
        name: ent.name,
        runtime,
        path: full,
        isDirectory: isDir,
        extension: isDir ? '' : path.extname(ent.name).toLowerCase(),
        sizeBytes,
      });
    }
    // A directory already classified as a model (mlx/whisperkit) owns its
    // contents; do not recurse, or its inner files (e.g. .safetensors) would be
    // reported as separate models.
    if (isDir && !runtime && depth < MAX_SCAN_DEPTH) {
      collectDir(full, runtimes, includeSizes, models, depth + 1);
    }
  }
}

// ─── Operations ──────────────────────────────────────────────────────────────

/** Scan supported model artifacts, returning { action, models }. */
function scanModels(options = {}) {
  const runtimes = options.runtimes || RUNTIMES;
  const includeSizes = options.includeSizes !== false;
  const directories =
    Array.isArray(options.directories) && options.directories.length
      ? options.directories
      : defaultScanDirs(options);
  const models = [];
  for (const dir of directories) {
    collectDir(dir, runtimes, includeSizes, models, 0);
  }
  return { action: 'scan', models };
}

/** Verify a model file's checksum; raises NOT_FOUND / CORRUPT_DATA / PERMISSION_DENIED. */
async function verifyModel(request = {}) {
  const { filePath, expectedChecksum, algorithm = DEFAULT_ALGORITHM, allowedRoot } = request;
  if (!filePath || typeof filePath !== 'string') {
    throw createAppError('VALIDATION_FAILED', 'verifyModel requires a "filePath" string');
  }
  if (allowedRoot) assertWithinRoot(filePath, allowedRoot, 'filePath');

  let stat;
  try {
    stat = fs.statSync(filePath);
  } catch (err) {
    if (err && err.code === 'ENOENT') {
      throw createAppError('NOT_FOUND', `Model file not found: ${filePath}`);
    }
    throw createAppError('CORRUPT_DATA', `Unable to access "${filePath}": ${err.message}`, { code: err.code });
  }
  if (!stat.isFile()) {
    throw createAppError('VALIDATION_FAILED', `Path is not a file: ${filePath}`);
  }

  const { checksum, sizeBytes } = await hashFile(filePath, algorithm);
  const match = expectedChecksum ? checksum.toLowerCase() === String(expectedChecksum).toLowerCase() : true;
  if (expectedChecksum && !match) {
    throw createAppError('CORRUPT_DATA', `Checksum mismatch for "${filePath}"`, {
      expectedChecksum: String(expectedChecksum).toLowerCase(),
      actualChecksum: checksum,
      algorithm,
    });
  }
  return { action: 'verify', filePath, algorithm, checksum, sizeBytes, match };
}

/** Relocate a model file with integrity checks; raises on any safety violation. */
async function relocateModel(request = {}) {
  const {
    sourcePath,
    destinationPath,
    expectedChecksum,
    algorithm = DEFAULT_ALGORITHM,
    allowedRoot = resolveModelsRoot(),
  } = request;

  if (!sourcePath || typeof sourcePath !== 'string') {
    throw createAppError('VALIDATION_FAILED', 'relocateModel requires a "sourcePath" string');
  }
  if (!destinationPath || typeof destinationPath !== 'string') {
    throw createAppError('VALIDATION_FAILED', 'relocateModel requires a "destinationPath" string');
  }

  const resolvedRoot = path.resolve(allowedRoot);
  assertWithinRoot(sourcePath, resolvedRoot, 'sourcePath');
  assertWithinRoot(destinationPath, resolvedRoot, 'destinationPath');

  // Resolve real source; this blocks symlink escapes and guarantees existence.
  const realSource = assertRealWithinRoot(sourcePath, resolvedRoot, 'sourcePath');

  // Refuse to clobber an existing destination.
  let destExists = false;
  try {
    destExists = !!fs.statSync(destinationPath);
  } catch (err) {
    if (err && err.code !== 'ENOENT') {
      throw createAppError('CORRUPT_DATA', `Unable to stat destination "${destinationPath}": ${err.message}`, { code: err.code });
    }
  }
  if (destExists) {
    throw createAppError('OUTPUT_COLLISION', `Destination already exists: ${destinationPath}`);
  }

  // Pre-verify integrity against an expected checksum before any move.
  let sourceStat;
  try {
    sourceStat = fs.statSync(realSource);
  } catch (err) {
    if (err && err.code === 'ENOENT') {
      throw createAppError('NOT_FOUND', `Source not found: ${realSource}`);
    }
    throw createAppError('CORRUPT_DATA', `Unable to access source "${realSource}": ${err.message}`, { code: err.code });
  }
  if (!sourceStat.isFile()) {
    throw createAppError('VALIDATION_FAILED', `Source is not a file: ${realSource}`);
  }

  const { checksum: sourceChecksum, sizeBytes } = await hashFile(realSource, algorithm);
  if (expectedChecksum && sourceChecksum.toLowerCase() !== String(expectedChecksum).toLowerCase()) {
    throw createAppError('CORRUPT_DATA', `Source checksum mismatch for "${realSource}"`, {
      expectedChecksum: String(expectedChecksum).toLowerCase(),
      actualChecksum: sourceChecksum,
      algorithm,
    });
  }

  try {
    fs.mkdirSync(path.dirname(destinationPath), { recursive: true });
  } catch (err) {
    throw createAppError('INTERNAL', `Failed to create destination directory for "${destinationPath}": ${err.message}`, { code: err.code });
  }

  let copyResult;
  try {
    copyResult = await copyStreamWithHash(realSource, destinationPath, algorithm);
  } catch (err) {
    // Never leave a partial/corrupt destination behind.
    try {
      fs.unlinkSync(destinationPath);
    } catch (_) {
      /* ignore */
    }
    throw err;
  }

  // The verified copy must be byte-identical to the source.
  if (copyResult.checksum !== sourceChecksum || copyResult.sizeBytes !== sizeBytes) {
    try {
      fs.unlinkSync(destinationPath);
    } catch (_) {
      /* ignore */
    }
    throw createAppError('CORRUPT_DATA', `Relocation produced a non-identical copy of "${realSource}"`, {
      sourceChecksum,
      destinationChecksum: copyResult.checksum,
    });
  }

  // Remove the source only after a verified copy exists.
  try {
    fs.unlinkSync(realSource);
  } catch (err) {
    throw createAppError(
      'INTERNAL',
      `Verified copy exists but source removal failed for "${realSource}": ${err.message}`,
      { code: err.code },
    );
  }

  return { action: 'relocate', sourcePath, destinationPath, checksum: sourceChecksum, sizeBytes };
}

/** Dispatch a ModelManageRequest by `action`. */
async function manageModels(request = {}) {
  if (!request || typeof request !== 'object' || !request.action) {
    throw createAppError('VALIDATION_FAILED', 'model manager request requires an "action"');
  }
  switch (request.action) {
    case 'scan':
      return scanModels(request);
    case 'verify':
      return await verifyModel(request);
    case 'relocate':
      return await relocateModel(request);
    default:
      throw createAppError('VALIDATION_FAILED', `Unknown model action: ${request.action}`);
  }
}

module.exports = {
  MODELS_MANAGE_CHANNEL,
  scanModels,
  verifyModel,
  relocateModel,
  manageModels,
  assertWithinRoot,
  classify,
};
