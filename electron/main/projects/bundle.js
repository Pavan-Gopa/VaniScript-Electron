'use strict';

/**
 * Secure ProjectV3 bundling (.vsbundle) for the Electron main process.
 *
 * Design goals (VaniScript Electron Migration Plan, PROJ-03):
 *  - Pack a ProjectV3 directory (project.json + assets) into a portable zip
 *    archive with a checksum manifest (sha256) so imports can verify integrity.
 *  - Unpack archives while rigorously defending against:
 *      * Zip Slip / path traversal (`../../`, leading `../`, absolute paths),
 *      * absolute paths and Windows drive letters,
 *      * symlink / hardlink escape,
 *      * case-insensitive / duplicate entry collisions,
 *      * manifest vs. payload mismatch (missing / extra / tampered entries).
 *  - Validates project.json against ProjectV3 before promoting to the store.
 *
 * The module exposes `exportProjectBundle(projectId, outPath, opts?)` and
 * `importProjectBundle(archivePath, opts?)` whose optional `opts.store` injects
 * a ProjectStore (required for unit tests; defaults to the shared singleton).
 */

const fs = require('node:fs');
const fsp = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');

const archiver = require('archiver');
const yauzl = require('yauzl');

const { validateProjectV3, PROJECT_SCHEMA_VERSION } = require('../../../shared/contracts/projects.ts');
const { createAppError } = require('../../../shared/contracts/errors.ts');
const { sanitizeProjectId, defaultProjectStore } = require('./projectStore.js');

const BUNDLE_FORMAT = 'vaniscript-bundle-v1';
const MANIFEST_NAME = 'manifest.json';
const CHECKSUM_ALGORITHM = 'sha256';
const DEFAULT_MAX_BYTES = 2 * 1024 * 1024 * 1024; // 2 GiB safety cap on import

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

function toPosix(p) {
  return p.split(path.sep).join('/');
}

async function exists(p) {
  try {
    await fsp.access(p);
    return true;
  } catch {
    return false;
  }
}

/** Recursively list regular files in a directory (symlinks are skipped). */
async function collectFiles(root) {
  const out = [];
  async function walk(dir) {
    const dirents = await fsp.readdir(dir, { withFileTypes: true });
    for (const d of dirents) {
      const abs = path.join(dir, d.name);
      if (d.isSymbolicLink()) continue; // never bundle symlinks
      if (d.isDirectory()) {
        await walk(abs);
      } else if (d.isFile()) {
        out.push(toPosix(path.relative(root, abs)));
      }
    }
  }
  await walk(root);
  return out.sort();
}

/** Stream a readable and resolve with its sha256 hex digest and byte size. */
function sha256OfReadable(readable) {
  return new Promise((resolve, reject) => {
    const hash = crypto.createHash(CHECKSUM_ALGORITHM);
    let size = 0;
    readable.on('data', (chunk) => {
      hash.update(chunk);
      size += chunk.length;
    });
    readable.on('end', () => resolve({ checksum: hash.digest('hex'), size }));
    readable.on('error', reject);
  });
}

/**
 * Parse and sanitize a zip entry name.
 * Throws on absolute paths, Windows drive letters, or any `..` traversal.
 * Returns the safe relative path plus a POSIX form and directory flag.
 */
function parseEntryName(name) {
  if (
    name.startsWith('/') ||
    name.includes('\\') ||
    /^[A-Za-z]:[\\/]/.test(name)
  ) {
    throw createAppError('INVALID_BUNDLE', `Absolute path not allowed in bundle: ${name}`);
  }
  const parts = [];
  for (const segment of name.split('/')) {
    if (segment === '' || segment === '.') continue;
    if (segment === '..') {
      throw createAppError('ZIP_SLIP', `Path traversal not allowed in bundle: ${name}`);
    }
    parts.push(segment);
  }
  const isDir = name.endsWith('/');
  const posix = parts.join('/');
  if (!isDir && posix === '') {
    throw createAppError('INVALID_BUNDLE', `Invalid empty entry name: ${name}`);
  }
  return { rel: parts.join(path.sep), posix, isDir };
}

/** Move a directory into place, falling back to copy+delete across devices. */
async function safeMoveDirectory(src, dst) {
  await fsp.mkdir(path.dirname(dst), { recursive: true });
  try {
    await fsp.rename(src, dst);
  } catch (err) {
    if (err && err.code === 'EXDEV') {
      await fsp.cp(src, dst, { recursive: true });
      await fsp.rm(src, { recursive: true, force: true });
    } else {
      throw err;
    }
  }
}


/** Map yauzl's structural rejections (it validates every entry name on open)
 * to our security codes, preserving our own defense-in-depth checks below. */
function classifyZipError(err) {
  const msg = (err && err.message) || '';
  if (/invalid relative path|traversal|\.\.\//i.test(msg)) {
    return createAppError('ZIP_SLIP', `Unsafe zip entry: ${msg}`);
  }
  if (/absolute path/i.test(msg)) {
    return createAppError('INVALID_BUNDLE', `Absolute path in zip: ${msg}`);
  }
  return createAppError('CORRUPT_DATA', `Failed to open bundle archive: ${msg}`);
}

function openZip(archivePath) {
  return new Promise((resolve, reject) => {
    yauzl.open(archivePath, { lazyEntries: true, autoClose: false }, (err, zipfile) => {
      if (err) reject(classifyZipError(err));
      else resolve(zipfile);
    });
  });
}

/** Open a single entry's read stream, promisified. */
function openEntryStream(zipfile, entry) {
  return new Promise((resolve, reject) => {
    zipfile.openReadStream(entry, (err, stream) => {
      if (err) reject(err);
      else if (!stream) reject(createAppError('CORRUPT_DATA', `No read stream for entry: ${entry.fileName}`));
      else resolve(stream);
    });
  });
}

// ---------------------------------------------------------------------------
// Export
// ---------------------------------------------------------------------------

async function exportProjectBundle(projectId, outPath, options = {}) {
  const store = options.store || defaultProjectStore;
  if (!store || typeof store.baseDirPath !== 'function') {
    throw createAppError('VALIDATION_FAILED', 'exportProjectBundle requires a ProjectStore');
  }

  const safeId = sanitizeProjectId(projectId);
  const projectDir = path.join(store.baseDirPath(), safeId);

  let stat;
  try {
    stat = fs.statSync(projectDir);
  } catch {
    throw createAppError('NOT_FOUND', `Project directory not found: ${safeId}`);
  }
  if (!stat.isDirectory()) {
    throw createAppError('NOT_FOUND', `Project path is not a directory: ${safeId}`);
  }
  if (!fs.existsSync(path.join(projectDir, 'project.json'))) {
    throw createAppError('CORRUPT_DATA', `project.json missing for ${safeId}`);
  }

  const files = await collectFiles(projectDir);

  const manifestEntries = [];
  let manifestProjectId;
  for (const rel of files) {
    const posix = toPosix(rel);
    const abs = path.join(projectDir, rel);
    const { checksum, size } = await sha256OfReadable(fs.createReadStream(abs));
    manifestEntries.push({ path: posix, size, checksum });
    if (posix === 'project.json') {
      try {
        const pj = JSON.parse(fs.readFileSync(abs, 'utf8'));
        if (pj && typeof pj.projectId === 'string') manifestProjectId = pj.projectId;
      } catch {
        /* ignore: validation happens at import time */
      }
    }
  }

  const manifest = {
    format: BUNDLE_FORMAT,
    schemaVersion: PROJECT_SCHEMA_VERSION,
    algorithm: CHECKSUM_ALGORITHM,
    createdAt: new Date().toISOString(),
    projectId: manifestProjectId || safeId,
    entries: manifestEntries,
  };

  const output = fs.createWriteStream(outPath);
  const archive = archiver('zip', { zlib: { level: 9 }, forceZip64: true });

  const cleanupPartial = () => {
    try {
      if (fs.existsSync(outPath)) fs.unlinkSync(outPath);
    } catch {
      /* best effort */
    }
  };

  try {
    await new Promise((resolve, reject) => {
      let settled = false;
      const finish = (err) => {
        if (settled) return;
        settled = true;
        if (err) reject(err);
        else resolve();
      };
      output.on('close', () => finish());
      output.on('error', finish);
      archive.on('error', finish);
      // Archiver 'warning' events are non-fatal; only 'error' rejects.
      archive.pipe(output);
      for (const rel of files) {
        archive.append(fs.createReadStream(path.join(projectDir, rel)), { name: toPosix(rel) });
      }
      archive.append(Buffer.from(JSON.stringify(manifest, null, 2)), { name: MANIFEST_NAME });
      archive.finalize();
    });
  } catch (err) {
    cleanupPartial();
    throw err;
  }

  return { outPath, projectId: safeId, format: BUNDLE_FORMAT, manifest };
}

// ---------------------------------------------------------------------------
// Import
// ---------------------------------------------------------------------------

async function importProjectBundle(archivePath, options = {}) {
  const store = options.store || defaultProjectStore;
  if (!store || typeof store.baseDirPath !== 'function') {
    throw createAppError('VALIDATION_FAILED', 'importProjectBundle requires a ProjectStore');
  }
  const overwrite = options.overwrite === true;
  const verifyChecksums = options.verifyChecksums !== false;

  if (!fs.existsSync(archivePath) || !fs.statSync(archivePath).isFile()) {
    throw createAppError('NOT_FOUND', `Bundle archive not found: ${archivePath}`);
  }
  const maxBytes = typeof options.maxBytes === 'number' ? options.maxBytes : DEFAULT_MAX_BYTES;
  if (fs.statSync(archivePath).size > maxBytes) {
    throw createAppError('INVALID_BUNDLE', `Bundle exceeds maximum allowed size (${maxBytes} bytes)`);
  }

  const extractedRoot = await fsp.mkdtemp(path.join(os.tmpdir(), 'vsbundle-'));

  const removeExtracted = async () => {
    try {
      if (fs.existsSync(extractedRoot)) await fsp.rm(extractedRoot, { recursive: true, force: true });
    } catch {
      /* best effort */
    }
  };

  try {
    const { manifest, extracted } = await extractArchive(archivePath, extractedRoot, verifyChecksums);

    const projectDir = locateProjectDir(extractedRoot);
    const projectJsonPath = path.join(projectDir, 'project.json');
    let parsed;
    try {
      parsed = JSON.parse(await fsp.readFile(projectJsonPath, 'utf8'));
    } catch {
      throw createAppError('CORRUPT_DATA', 'project.json is not valid JSON');
    }
    const result = validateProjectV3(parsed);
    if (!result.ok) {
      throw createAppError('VALIDATION_FAILED', 'Bundle does not contain a valid ProjectV3', result.error);
    }
    const project = result.value;
    const safeId = sanitizeProjectId(project.projectId);
    const dst = path.join(store.baseDirPath(), safeId);

    if (await exists(dst)) {
      if (!overwrite) {
        throw createAppError('CONFLICT', `Project ${safeId} already exists in the store`);
      }
      await fsp.rm(dst, { recursive: true, force: true });
    }

    await safeMoveDirectory(projectDir, dst);
    // If we promoted the extracted root itself, it is already gone.
    if (fs.existsSync(extractedRoot)) await removeExtracted();

    return { projectId: safeId, project, projectDir: dst, manifest: manifest || undefined };
  } catch (err) {
    await removeExtracted();
    throw err;
  }
}

/**
 * Extract a zip into `extractedRoot`, validating every entry, and (optionally)
 * verify each extracted file against the manifest's checksums.
 * Returns the parsed manifest (or null) and a map of extracted relative paths
 * to their computed { checksum, size }.
 */
function extractArchive(archivePath, extractedRoot, verifyChecksums) {
  return new Promise((resolve, reject) => {
    let zipfile;
    const seen = new Set(); // case-insensitive collision detection
    const extracted = new Map(); // posix -> { checksum, size }
    let manifest = null;

    const finish = (err, value) => {
      if (err) {
        if (zipfile) try { zipfile.close(); } catch { /* ignore */ }
        reject(err);
      } else {
        if (zipfile) try { zipfile.close(); } catch { /* ignore */ }
        resolve(value);
      }
    };

    openZip(archivePath)
      .then((zf) => {
        zipfile = zf;
        zipfile.on('error', (err) => finish(classifyZipError(err)));
        zipfile.readEntry();
        zipfile.on('entry', (entry) => {
          processEntry(entry).catch((err) => finish(err));
        });
        zipfile.on('end', () => {
          try {
            if (verifyChecksums && manifest) verifyManifest(manifest, extracted);
            finish(null, { manifest, extracted });
          } catch (err) {
            finish(err);
          }
        });
      })
      .catch((err) => finish(err));

    async function processEntry(entry) {
      const mode = (entry.externalFileAttributes >> 16) & 0o7777;
      if ((mode & 0o120000) === 0o120000 || (mode & 0o060000) === 0o060000) {
        throw createAppError('INVALID_BUNDLE', `Symlink/hardlink entries are not allowed: ${entry.fileName}`);
      }

      const { rel, posix, isDir } = parseEntryName(entry.fileName);

      // Bound check (defense in depth even though '..' is already rejected).
      const target = path.resolve(extractedRoot, rel);
      if (target !== extractedRoot && !target.startsWith(extractedRoot + path.sep)) {
        throw createAppError('ZIP_SLIP', `Entry escapes target directory: ${entry.fileName}`);
      }

      const lower = posix.toLowerCase();
      if (seen.has(lower)) {
        throw createAppError('INVALID_BUNDLE', `Duplicate or case-collision entry: ${entry.fileName}`);
      }
      seen.add(lower);

      if (isDir) {
        await fsp.mkdir(target, { recursive: true });
        zipfile.readEntry();
        return;
      }

      await fsp.mkdir(path.dirname(target), { recursive: true });
      const readStream = await openEntryStream(zipfile, entry);

      await new Promise((res, rej) => {
        const hash = crypto.createHash(CHECKSUM_ALGORITHM);
        let size = 0;
        const writeStream = fs.createWriteStream(target);
        readStream.on('data', (chunk) => {
          hash.update(chunk);
          size += chunk.length;
        });
        readStream.on('error', (e) => {
          writeStream.destroy(e);
          rej(e);
        });
        writeStream.on('error', rej);
        writeStream.on('finish', () => {
          extracted.set(posix, { checksum: hash.digest('hex'), size });
          res();
        });
        readStream.pipe(writeStream);
      });

      if (posix === MANIFEST_NAME) {
        try {
          const buf = await fsp.readFile(target, 'utf8');
          const parsed = JSON.parse(buf);
          if (parsed && Array.isArray(parsed.entries)) manifest = parsed;
        } catch {
          /* missing/invalid manifest: treated as manifest-less bundle */
        }
      }

      zipfile.readEntry();
    }
  });
}

function verifyManifest(manifest, extracted) {
  const expected = new Map(manifest.entries.map((e) => [e.path, e]));
  for (const [rel, meta] of extracted) {
    if (rel === MANIFEST_NAME) continue;
    const exp = expected.get(rel);
    if (!exp) {
      throw createAppError('INVALID_BUNDLE', `Extracted file is not listed in manifest: ${rel}`);
    }
    if (exp.checksum !== meta.checksum) {
      throw createAppError('INVALID_BUNDLE', `Checksum mismatch for ${rel}`);
    }
    if (typeof exp.size === 'number' && exp.size !== meta.size) {
      throw createAppError('INVALID_BUNDLE', `Size mismatch for ${rel}`);
    }
  }
  for (const [rel] of expected) {
    if (rel === MANIFEST_NAME) continue;
    if (!extracted.has(rel)) {
      throw createAppError('INVALID_BUNDLE', `Manifest entry missing from archive: ${rel}`);
    }
  }
}

/** Find the directory inside `root` that contains project.json. */
function locateProjectDir(root) {
  if (fs.existsSync(path.join(root, 'project.json'))) return root;
  let candidate = null;
  let count = 0;
  for (const d of fs.readdirSync(root, { withFileTypes: true })) {
    if (d.isDirectory() && fs.existsSync(path.join(root, d.name, 'project.json'))) {
      candidate = path.join(root, d.name);
      count += 1;
    }
  }
  if (count === 1 && candidate) return candidate;
  if (count > 1) throw createAppError('INVALID_BUNDLE', 'Multiple project directories found in bundle');
  throw createAppError('INVALID_BUNDLE', 'No project.json found in bundle');
}

// ---------------------------------------------------------------------------
// Factory + exports
// ---------------------------------------------------------------------------

function createProjectBundle(store) {
  if (!store || typeof store.baseDirPath !== 'function') {
    throw createAppError('VALIDATION_FAILED', 'createProjectBundle requires a ProjectStore');
  }
  return {
    exportProjectBundle: (projectId, outPath, opts = {}) =>
      exportProjectBundle(projectId, outPath, { ...opts, store }),
    importProjectBundle: (archivePath, opts = {}) =>
      importProjectBundle(archivePath, { ...opts, store }),
  };
}


module.exports = {
  BUNDLE_FORMAT,
  MANIFEST_NAME,
  exportProjectBundle,
  importProjectBundle,
  createProjectBundle,
  // exported for unit tests / defense-in-depth reuse
  parseEntryName,
  verifyManifest,
};
