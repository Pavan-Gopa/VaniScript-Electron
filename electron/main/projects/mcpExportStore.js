'use strict';

/**
 * Protected MCP export store for the Electron Main process (P3E.D3-S4-A).
 *
 * Mirrors the native `McpExportStore.swift`: every export gets its own
 * directory under a protected root, is tracked in an in-memory registry keyed
 * by an opaque exportId, and only ever projects file names plus byte sizes —
 * never absolute paths. Reveal-side lookups answer for registered exports with
 * at least one completed file; anything else is a typed not-found error.
 *
 * All filesystem access flows through `fsSeam` (defaults to `node:fs/promises`)
 * so tests can inject single-operation failures without touching live paths;
 * `pathSeam` plays the same role for path composition. Writes published through
 * `writeFile` are atomic (temp file plus rename), so a failed write never
 * leaves a partial final file. Aborted exports stay in the registry with no
 * files, and removing their directories remains the caller's cleanup job.
 */

const crypto = require('node:crypto');
const fsp = require('node:fs/promises');
const path = require('node:path');

const EXPORT_ID_PREFIX_CHARS = 8;
const LABEL_MAX_CHARS = 80;
const DEFAULT_LABEL = 'VaniScript';
// Native safeFilePart alphabet: every run of characters outside it collapses.
const UNSAFE_LABEL_RUN = /[^A-Za-z0-9_-]+/g;

const EXPORT_STORE_ERROR_CODES = Object.freeze({
  NOT_FOUND: 'MCP_EXPORT_NOT_FOUND',
  INVALID_REQUEST: 'MCP_INVALID_REQUEST',
});

class McpExportStoreError extends Error {
  constructor(code, message) {
    super(message);
    this.name = 'McpExportStoreError';
    this.code = code;
    this.mcpCode = code;
    Object.setPrototypeOf(this, McpExportStoreError.prototype);
  }
}

function isPlainObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

/** Native safeFilePart: unsafe runs become '-', edges trim, fallback applies. */
function safeLabelPart(value) {
  const clean = String(value ?? '')
    .replace(UNSAFE_LABEL_RUN, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, LABEL_MAX_CHARS);
  return clean.length > 0 ? clean : DEFAULT_LABEL;
}

/**
 * @param {object} options
 * @param {string | (() => string)} options.exportsRoot - Absolute protected
 *   exports directory, or a resolver evaluated lazily per call.
 * @param {() => string} [options.now] - Timestamp source for record metadata.
 * @param {object} [options.fsSeam] - Overrides merged over node:fs/promises.
 * @param {object} [options.pathSeam] - Overrides merged over node:path.
 */
function createMcpExportStore(options = {}) {
  if (!isPlainObject(options)) {
    throw new TypeError('options must be an object');
  }
  const rootOption = options.exportsRoot;
  if (typeof rootOption !== 'string' && typeof rootOption !== 'function') {
    throw new TypeError('options.exportsRoot must be an absolute path or a resolver function');
  }
  const now = typeof options.now === 'function' ? options.now : () => new Date().toISOString();
  const io = { ...fsp, ...(isPlainObject(options.fsSeam) ? options.fsSeam : {}) };
  const pathSeam = { ...path, ...(isPlainObject(options.pathSeam) ? options.pathSeam : {}) };

  const records = new Map();

  const resolveRoot = () => {
    const dir = typeof rootOption === 'function' ? rootOption() : rootOption;
    if (typeof dir !== 'string' || dir.length === 0) {
      throw new TypeError('exportsRoot must resolve to a non-empty string');
    }
    if (!pathSeam.isAbsolute(dir)) {
      throw new TypeError('exportsRoot must be an absolute path');
    }
    return dir;
  };

  /**
   * Creates `<root>/<safeLabel>-<id8>` for one new export and pre-registers
   * the empty record, so reveal only answers once completed files land via
   * `register`.
   */
  async function makeDirectory(label) {
    const id = crypto.randomUUID().toLowerCase();
    const dir = pathSeam.join(resolveRoot(), `${safeLabelPart(label)}-${id.slice(0, EXPORT_ID_PREFIX_CHARS)}`);
    await io.mkdir(dir, { recursive: true });
    records.set(id, { id, files: [], createdAt: now() });
    return { id, dir };
  }

  /**
   * Atomic UTF-8 write: content lands in a sibling temp file first and rename
   * publishes it, so a failed write leaves no partial final file behind.
   */
  async function writeFile(filePath, content) {
    if (typeof filePath !== 'string' || filePath.length === 0) {
      throw new TypeError('filePath must be a non-empty string');
    }
    if (typeof content !== 'string') {
      throw new TypeError('content must be a utf8 string');
    }
    const tempPath = `${filePath}.tmp-${crypto.randomBytes(8).toString('hex')}`;
    try {
      await io.writeFile(tempPath, content, 'utf8');
      await io.rename(tempPath, filePath);
    } catch (error) {
      try {
        await io.unlink(tempPath);
      } catch {
        /* best effort: the original failure is what matters */
      }
      throw error;
    }
    return filePath;
  }

  /** Byte size of one file, or null when it cannot be stat-ed. */
  async function fileSize(filePath) {
    try {
      const stats = await io.stat(filePath);
      return typeof stats.size === 'number' ? stats.size : null;
    } catch {
      return null;
    }
  }

  /**
   * Attaches final files to an export and returns the public projection:
   * file names and byte sizes only, never absolute paths.
   */
  async function register(exportId, files) {
    const id = String(exportId ?? '');
    const list = Array.isArray(files) ? files : [];
    // Fail closed before any registry mutation or stat: every registered file
    // must resolve inside the protected exportsRoot, so reveal can never
    // surface an escaped path.
    const rootDir = pathSeam.resolve(resolveRoot());
    for (const filePath of list) {
      const text = String(filePath);
      const relative = pathSeam.relative(rootDir, pathSeam.resolve(text));
      if (
        relative.length === 0 ||
        relative.split(pathSeam.sep)[0] === '..' ||
        pathSeam.isAbsolute(relative)
      ) {
        throw new McpExportStoreError(
          EXPORT_STORE_ERROR_CODES.INVALID_REQUEST,
          'Registered files must resolve inside the protected MCP Exports root.',
        );
      }
    }
    const projected = [];
    for (const filePath of list) {
      projected.push({
        fileName: pathSeam.basename(String(filePath)),
        sizeBytes: (await fileSize(String(filePath))) ?? 0,
      });
    }
    records.set(id, { id, files: [...list], createdAt: now() });
    return { exportId: id, files: projected, fileCount: projected.length };
  }

  /**
   * Reveal-side lookup mirroring the native guard: only registered exports
   * with at least one completed file qualify; everything else is typed
   * not-found. Returns the internal record snapshot (absolute paths included)
   * for the caller's reveal step.
   */
  async function reveal(exportId) {
    const record = records.get(String(exportId ?? ''));
    if (!record || record.files.length === 0) {
      throw new McpExportStoreError(EXPORT_STORE_ERROR_CODES.NOT_FOUND, 'Unknown exportId or no completed files.');
    }
    return { id: record.id, createdAt: record.createdAt, files: [...record.files] };
  }

  return { makeDirectory, writeFile, fileSize, register, reveal };
}

module.exports = {
  EXPORT_STORE_ERROR_CODES,
  McpExportStoreError,
  createMcpExportStore,
};
