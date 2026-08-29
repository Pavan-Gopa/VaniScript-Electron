'use strict';

/**
 * Hardened streaming bundle service for VaniScript V2 media bundles and
 * legacy JSON-v1 documents (P3E.D3-S2).
 *
 * Wire compatibility (byte-exact with the legacy Electron exporter and the
 * Apple VaniScriptCore exporter/importer):
 *   - Project header `VANISCRIPT_BUNDLE_V2\n`, library header
 *     `VANISCRIPT_LIBRARY_V2\n`.
 *   - Metadata framing: exactly 12 ASCII decimal digits + `\n`, then exactly
 *     that many UTF-8 JSON bytes (`format`, `schemaVersion` 3, `exportedAt`,
 *     `project` / `bundles`, legacy `assetMeta`).
 *   - Asset records: `START_ASSET\n` [library: decimal project index line]
 *     key line, name line, decimal size line, raw bytes, `END_ASSET\n`.
 *
 * Hardening added on top of the legacy implementation:
 *   - strict bounds (2 GiB archive, 50 MiB metadata / JSON-v1, 4 KiB textual
 *     lines), canonical decimal integers, fatal UTF-8 decoding, exact markers,
 *     physical EOF with no trailing junk, and metadata-to-wire consistency;
 *   - Apple-shaped `assetManifest: { entries }` with mandatory SHA-256 /
 *     size / key verification whenever a manifest is present, while legacy
 *     manifest-less V2 bundles remain readable;
 *   - deterministic key-qualified restore leaves, component-aware containment,
 *     same-filesystem staged promotion (single-rename visibility), and a
 *     durable all-or-nothing recovery journal for library transactions.
 *
 * JSON-v1 documents (`vaniscript-project-v1` / `vaniscript-library-v1`) are
 * imported directly; no temporary bundle files are ever created.
 *
 * The unified `importBundle(filePath)` entry point performs one bounded
 * open/peek, routes all four supported formats by content alone, and returns
 * the imported project array.
 */

const crypto = require('node:crypto');
const fsp = require('node:fs/promises');
const path = require('node:path');

const { normalizeImportedProjectSession } = require('../../project-session.js');

// ─── Wire constants ──────────────────────────────────────────────────────────

const PROJECT_MAGIC = 'VANISCRIPT_BUNDLE_V2';
const LIBRARY_MAGIC = 'VANISCRIPT_LIBRARY_V2';
const START_ASSET_MARKER = 'START_ASSET';
const END_ASSET_MARKER = 'END_ASSET';
const METADATA_DIGITS = 12;

const PROJECT_FORMAT_V2 = 'vaniscript-project-v2';
const LIBRARY_FORMAT_V2 = 'vaniscript-library-v2';
const PROJECT_FORMAT_V1 = 'vaniscript-project-v1';
const LIBRARY_FORMAT_V1 = 'vaniscript-library-v1';
const SCHEMA_VERSION = 3;

const ROLE_ORIGINAL_SOURCE = 'originalSource';
const ROLE_MEDIA_CHUNK = 'mediaChunk';
const ROLE_AUXILIARY = 'auxiliary';
// `localizedDocument` exists in the Apple cross-edition enum; accepted on
// read so Apple-produced manifests verify, never emitted by Electron.
const KNOWN_ROLES = new Set([
  ROLE_ORIGINAL_SOURCE,
  ROLE_MEDIA_CHUNK,
  ROLE_AUXILIARY,
  'localizedDocument',
]);

// ─── Explicit S2 bindings ────────────────────────────────────────────────────

const DEFAULT_LIMITS = Object.freeze({
  maxArchiveBytes: 2 * 1024 * 1024 * 1024, // archive stat ceiling
  maxMetadataBytes: 50 * 1024 * 1024,      // framed metadata block ceiling
  maxJsonV1Bytes: 50 * 1024 * 1024,        // non-streaming JSON-v1 ceiling
  maxLineBytes: 4 * 1024,                  // every textual wire line
});

const COPY_BUFFER_BYTES = 1024 * 1024;
const STAGE_PREFIX = '.vaniscript-stage-';
const JOURNAL_PREFIX = '.vaniscript-journal-';
const JOURNAL_SUFFIX = '.json';
// Unique temp-file shape written by persistJournal; recovery removes only
// names matching this validated service-owned pattern, never unrelated files.
const JOURNAL_TEMP_PATTERN = new RegExp(
  `^${JOURNAL_PREFIX.replace(/\./g, '\\.')}[0-9a-f]+` +
    `${JOURNAL_SUFFIX.replace(/\./g, '\\.')}\\.tmp-[0-9a-f]+$`,
);
const PROJECT_JSON_NAME = 'project.json';

// Project directory segments share the store's id alphabet and additionally
// never start with '.', keeping generated finals clear of the private
// stage/journal namespace above.
const SAFE_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;

const SHA256_PATTERN = /^[0-9a-f]{64}$/;
const FORMAT_FIELD_PATTERN = /^[a-z0-9]{0,16}$/;
const CONTROL_CHARS_PATTERN = /[\u0000-\u001F\u007F-\u009F]/;
const WINDOWS_RESERVED_BASENAME =
  /^(con|prn|aux|nul|com[1-9]|lpt[1-9])(\.[^\\/]*)?$/i;

const MAX_KEY_CHARS = 200;
const MAX_NAME_CHARS = 200;
const LEAF_PART_MAX_CHARS = 120;

const fatalDecoder = new TextDecoder('utf-8', { fatal: true });

// ─── Small validation helpers ────────────────────────────────────────────────

function isPlainObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function truncateForMessage(text) {
  return text.length > 80 ? `${text.slice(0, 77)}...` : text;
}

function resolveLimits(overrides) {
  const limits = { ...DEFAULT_LIMITS };
  if (overrides === undefined || overrides === null) return limits;
  if (!isPlainObject(overrides)) {
    throw new TypeError('limits must be an object when provided');
  }
  for (const key of Object.keys(DEFAULT_LIMITS)) {
    const value = overrides[key];
    if (value === undefined) continue;
    if (!Number.isSafeInteger(value) || value <= 0) {
      throw new TypeError(`limits.${key} must be a positive safe integer`);
    }
    limits[key] = value;
  }
  return limits;
}

function fatalDecode(buffer, what) {
  try {
    return fatalDecoder.decode(buffer);
  } catch {
    throw new Error(`${what} is not valid UTF-8`);
  }
}

/** Canonical non-negative decimal integer: digits only, no leading zeros. */
function parseCanonicalUint(text, what, max) {
  if (typeof text !== 'string' || !/^[0-9]+$/.test(text)) {
    throw new Error(`${what} must be a canonical decimal integer`);
  }
  if (text.length > 1 && text.charCodeAt(0) === 0x30) {
    throw new Error(`${what} must not contain leading zeros`);
  }
  const value = Number(text);
  if (!Number.isSafeInteger(value)) {
    throw new Error(`${what} exceeds the safe integer range`);
  }
  if (max !== undefined && value > max) {
    throw new Error(`${what} exceeds its maximum bound (${max})`);
  }
  return value;
}

function assertVisibleText(value, what) {
  if (typeof value !== 'string' || value.length === 0) {
    throw new Error(`${what} must be a non-empty string`);
  }
  if (CONTROL_CHARS_PATTERN.test(value)) {
    throw new Error(`${what} contains control characters`);
  }
}

function assertSafeKey(key, what = 'asset key') {
  assertVisibleText(key, what);
  if (key.length > MAX_KEY_CHARS) {
    throw new Error(`${what} exceeds ${MAX_KEY_CHARS} characters`);
  }
  if (key.includes('/') || key.includes('\\')) {
    throw new Error(`${what} must not contain path separators: "${key}"`);
  }
  if (/^[A-Za-z]:/.test(key)) {
    throw new Error(`${what} must not use Windows drive syntax: "${key}"`);
  }
}

function assertSafeBasename(name, what = 'asset name') {
  assertVisibleText(name, what);
  if (name.length > MAX_NAME_CHARS) {
    throw new Error(`${what} exceeds ${MAX_NAME_CHARS} characters`);
  }
  if (name.includes('/') || name.includes('\\')) {
    throw new Error(`${what} must be a bare file name: "${name}"`);
  }
  if (/^[A-Za-z]:/.test(name)) {
    throw new Error(`${what} must not use Windows drive syntax: "${name}"`);
  }
  if (name === '.' || name === '..') {
    throw new Error(`${what} must not be a relative path segment: "${name}"`);
  }
}

/**
 * Deterministic restore leaf part: hostile input was already rejected, this
 * only neutralizes characters that are legal-but-awkward in file names.
 */
function sanitizeLeafPart(value, fallback) {
  let out = String(value)
    .replace(/[^A-Za-z0-9._-]/g, '_')
    .replace(/^\.+/, '')
    .replace(/\.+$/, '')
    .slice(0, LEAF_PART_MAX_CHARS);
  if (WINDOWS_RESERVED_BASENAME.test(out)) out = `_${out}`;
  if (!out) return fallback;
  return out;
}

function buildRestoreLeaf(key, originalFileName) {
  return `${sanitizeLeafPart(key, 'asset')}--${sanitizeLeafPart(originalFileName, 'file')}`;
}

/**
 * Component-aware containment: join a POSIX-relative target under `baseDir`,
 * then prove with `path.relative` that the resolution stays inside `baseDir`.
 * Raw traversal forms were rejected upstream; this is defense in depth on the
 * composed target.
 */
function assertContainedChild(baseDir, relativePosix, what) {
  if (typeof relativePosix !== 'string' || relativePosix.length === 0) {
    throw new Error(`${what} resolves to an empty path`);
  }
  if (relativePosix.includes('\\') || path.isAbsolute(relativePosix)) {
    throw new Error(`${what} must be a relative POSIX path: "${relativePosix}"`);
  }
  for (const segment of relativePosix.split('/')) {
    if (segment === '' || segment === '.' || segment === '..') {
      throw new Error(
        `${what} must not traverse outside the destination: "${relativePosix}"`,
      );
    }
    if (CONTROL_CHARS_PATTERN.test(segment)) {
      throw new Error(`${what} contains control characters`);
    }
  }
  const resolved = path.resolve(baseDir, ...relativePosix.split('/'));
  const relBack = path.relative(baseDir, resolved);
  if (relBack === '' || relBack.startsWith('..') || path.isAbsolute(relBack)) {
    throw new Error(`${what} escapes the destination directory: "${relativePosix}"`);
  }
  return resolved;
}

// ─── Bounded buffered fd reader ──────────────────────────────────────────────

/**
 * Sequential reader over an open fd with hard bounds on line lengths and
 * exact-length reads. Tracks logical byte consumption so payload bounds can
 * be checked against the remaining archive size. Callers decode every buffer
 * through fatal UTF-8.
 */
function createBoundedReader(io, fd) {
  let pending = Buffer.alloc(0);
  const scratch = Buffer.alloc(COPY_BUFFER_BYTES);
  let atEof = false;
  let consumed = 0;

  async function refill() {
    // `fd` is a FileHandle; a null position reads sequentially.
    const { bytesRead } = await fd.read(scratch, 0, scratch.length, null);
    if (!bytesRead) {
      atEof = true;
      return false;
    }
    const chunk = scratch.subarray(0, bytesRead);
    pending = pending.length === 0 ? Buffer.from(chunk) : Buffer.concat([pending, chunk]);
    return true;
  }

  return {
    /** Next LF-terminated line without the LF, or null at clean EOF. */
    async readLine(maxBytes, what) {
      let nlIndex = pending.indexOf(0x0a);
      while (nlIndex === -1) {
        if (pending.length > maxBytes) {
          throw new Error(`${what} exceeds the ${maxBytes} byte line limit`);
        }
        if (!(await refill())) {
          if (pending.length === 0) return null;
          throw new Error(`${what} ends without a terminating newline`);
        }
        nlIndex = pending.indexOf(0x0a);
      }
      if (nlIndex > maxBytes) {
        throw new Error(`${what} exceeds the ${maxBytes} byte line limit`);
      }
      const line = pending.subarray(0, nlIndex);
      pending = pending.subarray(nlIndex + 1);
      consumed += line.length + 1;
      return line;
    },

    /** Reads exactly `length` bytes or throws on premature EOF. */
    async readExact(length, what) {
      if (!Number.isSafeInteger(length) || length < 0) {
        throw new Error(`${what}: invalid read length`);
      }
      while (pending.length < length) {
        if (!(await refill())) {
          throw new Error(`${what}: unexpected end of file (wanted ${length} bytes)`);
        }
      }
      const out = pending.subarray(0, length);
      pending = pending.subarray(length);
      consumed += length;
      return out;
    },

    bytesConsumed() {
      return consumed;
    },

    /** Returns up to maxBytes without consuming them (header sniffing). */
    async peekUpTo(maxBytes) {
      while (pending.length < maxBytes) {
        if (!(await refill())) break;
      }
      return pending.subarray(0, Math.min(pending.length, maxBytes));
    },
  };
}

async function readRequiredLine(reader, what, maxBytes) {
  const line = await reader.readLine(maxBytes, what);
  if (line === null) throw new Error(`${what}: unexpected end of file inside record`);
  return fatalDecode(line, what);
}

async function writeAll(fd, data) {
  let offset = 0;
  while (offset < data.length) {
    const { bytesWritten } = await fd.write(data, offset, data.length - offset);
    if (!bytesWritten) throw new Error('short write while writing bundle output');
    offset += bytesWritten;
  }
}

async function fsyncDirectory(io, dir, { strict = false } = {}) {
  let handle = null;
  try {
    handle = await io.open(dir, 'r');
    await handle.sync();
  } catch (err) {
    if (
      strict &&
      !(
        process.platform === 'win32' &&
        err &&
        ['EPERM', 'EISDIR', 'ENOTSUP', 'EINVAL'].includes(err.code)
      )
    ) {
      throw err;
    }
    // Windows does not support fsync on directory handles.  A successful
    // close still releases the handle in finally below; file durability is
    // provided by the file-handle syncs performed by the callers.
  } finally {
    if (handle !== null) {
      try {
        await handle.close();
      } catch {
        /* ignore */
      }
    }
  }
}

async function removeTreeBestEffort(io, target) {
  try {
    await io.rm(target, { recursive: true, force: true });
  } catch {
    /* ignore */
  }
}

/**
 * Strict tree removal for journaled cleanup paths: ENOENT counts as already
 * removed; any other failure rejects so callers can retain the journal.
 */
async function removeTreeStrict(io, target) {
  try {
    await io.rm(target, { recursive: true, force: true });
  } catch (err) {
    if (err && err.code === 'ENOENT') return;
    throw err;
  }
}

// ─── Streaming SHA-256 over physical sources ─────────────────────────────────

/**
 * Streams a file once and returns `{ sha256, size }`, enforcing a complete
 * read: hashed byte count must equal the stat size, so a source truncated
 * mid-read fails instead of exporting short bytes.
 */
async function hashPhysicalFile(io, absPath) {
  let fd;
  try {
    fd = await io.open(absPath, 'r');
  } catch (err) {
    if (err && err.code === 'ENOENT') {
      throw new Error(`Referenced asset is missing on disk: ${absPath}`);
    }
    throw err;
  }
  try {
    const stat = await fd.stat();
    if (!stat.isFile()) {
      throw new Error(`Referenced asset is not a regular file: ${absPath}`);
    }
    const hash = crypto.createHash('sha256');
    const buffer = Buffer.alloc(COPY_BUFFER_BYTES);
    let totalRead = 0;
    for (;;) {
      const { bytesRead } = await fd.read(buffer, 0, buffer.length, null);
      if (!bytesRead) break;
      hash.update(buffer.subarray(0, bytesRead));
      totalRead += bytesRead;
      if (totalRead > stat.size) break; // grew mid-read; rejected below
    }
    if (totalRead !== stat.size) {
      throw new Error(`Source changed while hashing (incomplete read): ${absPath}`);
    }
    return { sha256: hash.digest('hex'), size: stat.size };
  } finally {
    await fd.close();
  }
}

// ─── Export-side collection and manifest building ────────────────────────────

/**
 * Collect export slots in canonical order: `sourceFile`, distinct
 * `originalVideoPath`, `chunk:<index>`. The derived `wavPath` is deliberately
 * omitted: its audio is fully contained in the chunk WAVs and import never
 * re-transcribes.
 */
function collectSessionSlots(session) {
  const source = session && typeof session === 'object' ? session : {};
  const slots = [];
  const push = (key, role, filePath, language) => {
    if (typeof filePath === 'string' && filePath.length > 0) {
      slots.push({ key, role, filePath, language });
    }
  };
  push('sourceFile', ROLE_ORIGINAL_SOURCE, source.sourceFile);
  push('originalVideoPath', ROLE_AUXILIARY, source.originalVideoPath);
  if (Array.isArray(source.chunks)) {
    source.chunks.forEach((chunk, index) => {
      const language =
        chunk && typeof chunk.language === 'string' && chunk.language
          ? chunk.language
          : undefined;
      push(`chunk:${index}`, ROLE_MEDIA_CHUNK, chunk && chunk.filePath, language);
    });
  }
  return slots;
}

/**
 * Hash every referenced physical asset once (memoized per resolved path) and
 * merge slots with equal content into one unit whose later keys become
 * aliases. Content equality replaces the legacy unsafe size-only duplicate
 * test; no size-only dedupe exists anywhere here.
 */
async function buildBundleUnits(io, session) {
  const units = [];
  const unitsBySha = new Map();
  const fingerprintByPath = new Map();
  for (const slot of collectSessionSlots(session)) {
    const absPath = path.resolve(slot.filePath);
    let fingerprint = fingerprintByPath.get(absPath);
    if (!fingerprint) {
      try {
        await io.stat(slot.filePath);
      } catch (err) {
        // Missing referenced files are skipped, matching the legacy exporter's
        // tolerance for sessions that reference pruned media. Every other
        // stat failure is a hard error.
        if (err && err.code === 'ENOENT') continue;
        throw err;
      }
      fingerprint = await hashPhysicalFile(io, absPath);
      fingerprintByPath.set(absPath, fingerprint);
    }
    const existingUnit = unitsBySha.get(fingerprint.sha256);
    if (existingUnit) {
      if (!existingUnit.aliases.includes(slot.key)) {
        existingUnit.aliases.push(slot.key);
      }
      continue;
    }
    const unit = {
      key: slot.key,
      role: slot.role,
      language: slot.language,
      name: path.basename(slot.filePath),
      absPath,
      size: fingerprint.size,
      sha256: fingerprint.sha256,
      aliases: [],
    };
    unitsBySha.set(fingerprint.sha256, unit);
    units.push(unit);
  }
  return units;
}

function buildManifestEntry(unit) {
  const entry = {
    key: unit.key,
    role: unit.role,
    format: path.extname(unit.name).slice(1).toLowerCase(),
    originalFileName: unit.name,
    sha256: unit.sha256,
    size: unit.size,
  };
  if (unit.language !== undefined) entry.language = unit.language;
  if (unit.aliases.length > 0) entry.aliases = [...unit.aliases];
  return entry;
}

function buildLegacyAssetMetaRow(unit) {
  return { key: unit.key, name: unit.name, size: unit.size };
}

// ─── Export writers ──────────────────────────────────────────────────────────

async function exportBundles(io, limits, now, isLibrary, projects, filePath) {
  if (typeof filePath !== 'string' || filePath.length === 0) {
    throw new TypeError('filePath must be a non-empty string');
  }

  const bundles = [];
  for (const project of projects) {
    if (!isPlainObject(project)) {
      throw new TypeError('project must be a plain object');
    }
    const units = await buildBundleUnits(io, project.session);
    bundles.push({ project, units });
  }

  const exportedAt = now();
  const metadata = isLibrary
    ? {
        format: LIBRARY_FORMAT_V2,
        schemaVersion: SCHEMA_VERSION,
        exportedAt,
        bundles: bundles.map((bundle) => ({
          project: bundle.project,
          assetMeta: bundle.units.map(buildLegacyAssetMetaRow),
          assetManifest: { entries: bundle.units.map(buildManifestEntry) },
        })),
      }
    : {
        format: PROJECT_FORMAT_V2,
        schemaVersion: SCHEMA_VERSION,
        exportedAt,
        project: bundles.length > 0 ? bundles[0].project : {},
        assetMeta: bundles.length > 0 ? bundles[0].units.map(buildLegacyAssetMetaRow) : [],
        assetManifest: {
          entries:
            bundles.length > 0 ? bundles[0].units.map(buildManifestEntry) : [],
        },
      };

  const jsonBuffer = Buffer.from(JSON.stringify(metadata, null, 2), 'utf8');
  if (jsonBuffer.length > limits.maxMetadataBytes) {
    throw new Error(`Bundle metadata exceeds the ${limits.maxMetadataBytes} byte limit`);
  }

  let estimatedSize =
    (isLibrary ? LIBRARY_MAGIC.length : PROJECT_MAGIC.length) +
    1 +
    METADATA_DIGITS +
    1 +
    jsonBuffer.length;
  bundles.forEach((bundle, bundleIndex) => {
    for (const unit of bundle.units) {
      estimatedSize +=
        START_ASSET_MARKER.length +
        1 +
        (isLibrary ? String(bundleIndex).length + 1 : 0) +
        unit.key.length +
        1 +
        unit.name.length +
        1 +
        String(unit.size).length +
        1 +
        unit.size +
        END_ASSET_MARKER.length +
        1;
    }
  });
  if (estimatedSize > limits.maxArchiveBytes) {
    throw new Error(
      `Bundle exceeds the maximum archive size (${limits.maxArchiveBytes} bytes)`,
    );
  }

  const magic = isLibrary ? LIBRARY_MAGIC : PROJECT_MAGIC;
  const frame = `${String(jsonBuffer.length).padStart(METADATA_DIGITS, '0')}\n`;

  // Unique sibling temp on the destination filesystem; the prior destination
  // stays untouched until a successful rename.
  const destinationDir = path.dirname(filePath);
  const tempPath = path.join(
    destinationDir,
    `.${path.basename(filePath)}.vsbuild-${crypto.randomBytes(6).toString('hex')}.tmp`,
  );

  let outFd = null;
  try {
    outFd = await io.open(tempPath, 'w');
    await writeAll(outFd, Buffer.from(`${magic}\n${frame}`, 'utf8'));
    await writeAll(outFd, jsonBuffer);
    for (let bundleIndex = 0; bundleIndex < bundles.length; bundleIndex++) {
      for (const unit of bundles[bundleIndex].units) {
        const headLines = [START_ASSET_MARKER];
        if (isLibrary) headLines.push(String(bundleIndex));
        headLines.push(unit.key, unit.name, String(unit.size));
        await writeAll(outFd, Buffer.from(`${headLines.join('\n')}\n`, 'utf8'));
        await streamUnitIntoBundle(io, outFd, unit);
        await writeAll(outFd, Buffer.from(`${END_ASSET_MARKER}\n`, 'utf8'));
      }
    }
    await outFd.sync();
  } catch (err) {
    if (outFd !== null) {
      try {
        await outFd.close();
      } catch {
        /* ignore */
      }
      outFd = null;
    }
    await removeTreeBestEffort(io, tempPath);
    throw err;
  }
  await outFd.close();
  outFd = null;

  try {
    await io.rename(tempPath, filePath);
  } catch (err) {
    await removeTreeBestEffort(io, tempPath);
    throw err;
  }
  await fsyncDirectory(io, destinationDir);
}

/**
 * Second-pass copy of one physical asset into the bundle, verifying both the
 * complete byte count and the SHA-256 collected during the hashing pass, so a
 * source mutated or truncated between passes fails the export.
 */
async function streamUnitIntoBundle(io, outFd, unit) {
  const fd = await io.open(unit.absPath, 'r');
  try {
    const hash = crypto.createHash('sha256');
    const buffer = Buffer.alloc(COPY_BUFFER_BYTES);
    let copied = 0;
    for (;;) {
      const { bytesRead } = await fd.read(buffer, 0, buffer.length, null);
      if (!bytesRead) break;
      const slice = buffer.subarray(0, bytesRead);
      await writeAll(outFd, slice);
      hash.update(slice);
      copied += bytesRead;
      if (copied > unit.size) break; // rejected by the completeness check
    }
    if (copied !== unit.size || hash.digest('hex') !== unit.sha256) {
      throw new Error(`Source asset changed while writing bundle: ${unit.absPath}`);
    }
  } finally {
    await fd.close();
  }
}

// ─── Metadata parsing and strict shape checks ────────────────────────────────

async function readMetadataFrame(reader, what, limits) {
  const frameBuffer = await reader.readLine(limits.maxLineBytes, `${what} length frame`);
  if (frameBuffer === null) {
    throw new Error(`${what}: unexpected end of file before the metadata length frame`);
  }
  const frameText = fatalDecode(frameBuffer, `${what} length frame`);
  if (!/^[0-9]{12}$/.test(frameText)) {
    throw new Error(
      `${what} length frame must be exactly ${METADATA_DIGITS} ASCII digits`,
    );
  }
  const jsonLength = Number(frameText);
  if (jsonLength > limits.maxMetadataBytes) {
    throw new Error(`${what} metadata exceeds the ${limits.maxMetadataBytes} byte limit`);
  }
  const jsonBuffer = await reader.readExact(jsonLength, `${what} metadata`);
  const text = fatalDecode(jsonBuffer, `${what} metadata`);
  let metadata;
  try {
    metadata = JSON.parse(text);
  } catch {
    throw new Error(`${what} metadata is not valid JSON`);
  }
  if (!isPlainObject(metadata)) {
    throw new Error(`${what} metadata must be a JSON object`);
  }
  return metadata;
}

function assertCommonMetadataShape(metadata, expectedFormat, what) {
  if (metadata.format !== expectedFormat) {
    throw new Error(
      `${what} format ${JSON.stringify(metadata.format)}; expected "${expectedFormat}"`,
    );
  }
  if (metadata.schemaVersion !== SCHEMA_VERSION) {
    throw new Error(
      `${what} schemaVersion ${JSON.stringify(metadata.schemaVersion)}; expected ${SCHEMA_VERSION}`,
    );
  }
  if (typeof metadata.exportedAt !== 'string' || metadata.exportedAt.length === 0) {
    throw new Error(`${what} exportedAt must be a non-empty string`);
  }
}

function assertProjectMetadataShape(metadata) {
  assertCommonMetadataShape(metadata, PROJECT_FORMAT_V2, 'project bundle metadata');
  if (!isPlainObject(metadata.project)) {
    throw new Error('project bundle metadata.project must be an object');
  }
}

function assertLibraryMetadataShape(metadata) {
  assertCommonMetadataShape(metadata, LIBRARY_FORMAT_V2, 'library bundle metadata');
  if (!Array.isArray(metadata.bundles)) {
    throw new Error('library bundle metadata.bundles must be an array');
  }
  metadata.bundles.forEach((bundle, index) => {
    if (!isPlainObject(bundle)) {
      throw new Error(`library bundle metadata.bundles[${index}] must be an object`);
    }
    if (!isPlainObject(bundle.project)) {
      throw new Error(
        `library bundle metadata.bundles[${index}].project must be an object`,
      );
    }
  });
}

/** Parses (and strictly validates) an optional Apple-shaped asset manifest. */
function parseAssetManifest(container, what) {
  if (container.assetManifest === undefined) return null;
  const manifest = container.assetManifest;
  if (!isPlainObject(manifest) || !Array.isArray(manifest.entries)) {
    throw new Error(`${what} assetManifest must be an object with an entries array`);
  }
  const entries = [];
  const byKey = new Map();
  const claimedAliases = new Set();
  for (const raw of manifest.entries) {
    if (!isPlainObject(raw)) {
      throw new Error(`${what} manifest entry must be an object`);
    }
    assertSafeKey(raw.key, `${what} manifest entry key`);
    if (byKey.has(raw.key) || claimedAliases.has(raw.key)) {
      throw new Error(`Duplicate manifest key "${raw.key}"`);
    }
    if (!KNOWN_ROLES.has(raw.role)) {
      throw new Error(
        `Unknown manifest role ${JSON.stringify(raw.role)} for key "${raw.key}"`,
      );
    }
    if (raw.language !== undefined) {
      if (
        typeof raw.language !== 'string' ||
        raw.language.length > 64 ||
        CONTROL_CHARS_PATTERN.test(raw.language)
      ) {
        throw new Error(`Invalid manifest language for key "${raw.key}"`);
      }
    }
    if (typeof raw.format !== 'string' || !FORMAT_FIELD_PATTERN.test(raw.format)) {
      throw new Error(`Invalid manifest format field for key "${raw.key}"`);
    }
    assertSafeBasename(
      raw.originalFileName,
      `${what} manifest originalFileName for key "${raw.key}"`,
    );
    if (typeof raw.sha256 !== 'string' || !SHA256_PATTERN.test(raw.sha256)) {
      throw new Error(`Manifest sha256 for key "${raw.key}" must be lowercase 64-hex`);
    }
    if (!Number.isSafeInteger(raw.size) || raw.size < 0) {
      throw new Error(`Manifest size for key "${raw.key}" must be a safe integer >= 0`);
    }
    let aliases = [];
    if (raw.aliases !== undefined) {
      if (!Array.isArray(raw.aliases)) {
        throw new Error(`Manifest aliases for key "${raw.key}" must be an array`);
      }
      for (const alias of raw.aliases) {
        assertSafeKey(alias, `${what} manifest alias under key "${raw.key}"`);
        if (alias === raw.key || byKey.has(alias) || claimedAliases.has(alias)) {
          throw new Error(`Duplicate or self-referential manifest alias "${alias}"`);
        }
        claimedAliases.add(alias);
      }
      aliases = [...raw.aliases];
    }
    const entry = {
      key: raw.key,
      role: raw.role,
      language: raw.language,
      format: raw.format,
      originalFileName: raw.originalFileName,
      sha256: raw.sha256,
      size: raw.size,
      aliases,
    };
    byKey.set(entry.key, entry);
    entries.push(entry);
  }
  return { entries, byKey };
}

/** Parses (and validates) the optional legacy `assetMeta: [{key,name,size}]`. */
function parseLegacyAssetMeta(container, what) {
  if (container.assetMeta === undefined) return null;
  if (!Array.isArray(container.assetMeta)) {
    throw new Error(`${what} assetMeta must be an array`);
  }
  const rows = new Map();
  for (const row of container.assetMeta) {
    if (!isPlainObject(row)) {
      throw new Error(`${what} assetMeta row must be an object`);
    }
    assertSafeKey(row.key, `${what} assetMeta key`);
    if (rows.has(row.key)) {
      throw new Error(`Duplicate assetMeta key "${row.key}"`);
    }
    if (row.name !== undefined) {
      assertSafeBasename(row.name, `${what} assetMeta name for key "${row.key}"`);
    }
    if (!Number.isSafeInteger(row.size) || row.size < 0) {
      throw new Error(`assetMeta size for key "${row.key}" must be a safe integer >= 0`);
    }
    rows.set(row.key, { name: row.name, size: row.size });
  }
  return rows;
}

// ─── Import-side record streaming and verification ───────────────────────────

function inferRoleFromKey(key) {
  if (key.startsWith('chunk:')) return ROLE_MEDIA_CHUNK;
  if (key === 'originalVideoPath') return ROLE_AUXILIARY;
  return ROLE_ORIGINAL_SOURCE;
}

function guardCaseCollision(caseTargets, relativePosix) {
  const folded = relativePosix.toLowerCase();
  if (caseTargets.has(folded)) {
    throw new Error(
      `Duplicate restore target (case-insensitive collision): ${relativePosix}`,
    );
  }
  caseTargets.add(folded);
}

function planManifestTargets(stageDir, manifest) {
  const targetsByKey = new Map();
  const caseTargets = new Set();
  for (const entry of manifest.entries) {
    const subdir = entry.role === ROLE_MEDIA_CHUNK ? 'chunks' : 'audio';
    const relativeTarget = `${subdir}/${buildRestoreLeaf(entry.key, entry.originalFileName)}`;
    guardCaseCollision(caseTargets, relativeTarget);
    targetsByKey.set(
      entry.key,
      assertContainedChild(stageDir, relativeTarget, 'restored asset target'),
    );
  }
  return { targetsByKey, caseTargets };
}

async function copyRecordPayload(io, reader, absoluteTarget, size) {
  const hash = crypto.createHash('sha256');
  const outFd = await io.open(absoluteTarget, 'w');
  try {
    let remaining = size;
    while (remaining > 0) {
      const want = Math.min(remaining, COPY_BUFFER_BYTES);
      const chunk = await reader.readExact(want, 'asset payload');
      await writeAll(outFd, chunk);
      hash.update(chunk);
      remaining -= chunk.length;
    }
  } finally {
    await outFd.close();
  }
  return hash.digest('hex');
}

/**
 * Streams every `START_ASSET ... END_ASSET` record until clean physical EOF.
 * With a manifest present, wire keys/sizes/names/hashes are checked against
 * their entries as they stream; without one, records stand alone and legacy
 * `assetMeta` consistency is verified afterwards.
 */
async function streamAssetRecords(io, reader, context) {
  const { maxLineBytes, library, states, stages, archiveSize } = context;
  for (;;) {
    const markerBuffer = await reader.readLine(maxLineBytes, 'asset marker line');
    if (markerBuffer === null) return; // clean physical EOF after last record
    const marker = fatalDecode(markerBuffer, 'asset marker line');
    if (marker !== START_ASSET_MARKER) {
      throw new Error(
        `Expected "${START_ASSET_MARKER}" marker but found "${truncateForMessage(marker)}"`,
      );
    }

    let projectIndex = 0;
    if (library) {
      const indexText = await readRequiredLine(reader, 'library asset project index', maxLineBytes);
      projectIndex = parseCanonicalUint(
        indexText,
        'library asset project index',
        states.length - 1,
      );
    }
    const state = states[projectIndex];
    const stageDir = stages[projectIndex];

    const key = await readRequiredLine(reader, 'asset key', maxLineBytes);
    assertSafeKey(key);
    if (state.wireKeys.has(key)) {
      throw new Error(`Duplicate asset key "${key}"`);
    }
    const name = await readRequiredLine(reader, 'asset name', maxLineBytes);
    assertSafeBasename(name);
    const sizeText = await readRequiredLine(reader, 'asset size', maxLineBytes);
    const size = parseCanonicalUint(sizeText, 'asset size');
    const remainingArchive = archiveSize - reader.bytesConsumed();
    if (size > remainingArchive) {
      throw new Error(`asset size ${size} exceeds the remaining archive bytes`);
    }

    let entry = null;
    if (state.manifest) {
      entry = state.manifest.byKey.get(key) || null;
      if (!entry) {
        throw new Error(`Wire record absent from assetManifest: "${key}"`);
      }
      if (entry.size !== size) {
        throw new Error(
          `asset size ${size} contradicts manifest size ${entry.size} for key "${key}"`,
        );
      }
      if (name !== entry.originalFileName) {
        throw new Error(
          `asset name contradicts manifest originalFileName for key "${key}"`,
        );
      }
    }

    let absoluteTarget;
    if (entry && state.targetsByKey) {
      // Pre-planned, containment-checked target for this manifest entry.
      absoluteTarget = state.targetsByKey.get(key);
    } else {
      const role = entry ? entry.role : inferRoleFromKey(key);
      const subdir = role === ROLE_MEDIA_CHUNK ? 'chunks' : 'audio';
      const relativeTarget = `${subdir}/${buildRestoreLeaf(key, name)}`;
      guardCaseCollision(state.caseTargets, relativeTarget);
      absoluteTarget = assertContainedChild(
        stageDir,
        relativeTarget,
        'restored asset target',
      );
    }
    await io.mkdir(path.dirname(absoluteTarget), { recursive: true });

    const actualSha256 = await copyRecordPayload(io, reader, absoluteTarget, size);

    const endLine = await readRequiredLine(reader, 'end-of-asset marker', maxLineBytes);
    if (endLine !== END_ASSET_MARKER) {
      throw new Error(
        `Expected "${END_ASSET_MARKER}" marker but found "${truncateForMessage(endLine)}"`,
      );
    }

    state.wireKeys.add(key);
    state.assetMap.set(key, absoluteTarget);
    state.recordsByKey.set(key, { name, size, sha256: actualSha256 });
    if (entry) {
      if (actualSha256 !== entry.sha256) {
        throw new Error(`SHA-256 mismatch for key "${key}"`);
      }
      state.matchedKeys.add(key);
    }
  }
}

/** Metadata-to-wire consistency after all records streamed. */
function verifyCollectedRecords(state, what) {
  if (state.manifest) {
    for (const entry of state.manifest.entries) {
      if (!state.wireKeys.has(entry.key)) {
        throw new Error(`${what} manifest key has no wire record: "${entry.key}"`);
      }
    }
    return;
  }
  if (state.assetMetaRows) {
    if (state.assetMetaRows.size !== state.wireKeys.size) {
      throw new Error(`${what} assetMeta does not match the wire records`);
    }
    for (const [key, row] of state.assetMetaRows) {
      const record = state.recordsByKey.get(key);
      if (!record) {
        throw new Error(`${what} assetMeta key has no wire record: "${key}"`);
      }
      if (record.size !== row.size) {
        throw new Error(`${what} assetMeta size mismatch for key "${key}"`);
      }
      if (row.name !== undefined && record.name !== row.name) {
        throw new Error(`${what} assetMeta name mismatch for key "${key}"`);
      }
    }
  }
}

/** Aliases are applied only after every canonical entry has verified. */
function applyManifestAliases(state) {
  if (!state.manifest) return;
  for (const entry of state.manifest.entries) {
    const canonicalPath = state.assetMap.get(entry.key);
    for (const alias of entry.aliases) {
      state.assetMap.set(alias, canonicalPath);
    }
  }
}

function createBundleImportState(manifest, assetMetaRows) {
  return {
    manifest,
    assetMetaRows,
    assetMap: new Map(),
    wireKeys: new Set(),
    matchedKeys: new Set(),
    recordsByKey: new Map(),
    caseTargets: new Set(),
    targetsByKey: null,
  };
}

function assembleImportedProject(rawProject, projectId, timestamp, assetMap) {
  const project = {
    ...rawProject,
    id: projectId,
    createdAt: timestamp,
    updatedAt: timestamp,
  };
  project.session = normalizeImportedProjectSession(project.session, {
    projectId,
    assetMap,
  });
  return project;
}

// ─── Staging, durability, journals, recovery ─────────────────────────────────

async function writeDurableJson(io, filePath, value) {
  const payload = Buffer.from(JSON.stringify(value, null, 2), 'utf8');
  const tempPath = `${filePath}.tmp-${crypto.randomBytes(6).toString('hex')}`;
  await io.writeFile(tempPath, payload);
  const fd = await io.open(tempPath, 'r+');
  try {
    await fd.sync();
  } finally {
    await fd.close();
  }
  await io.rename(tempPath, filePath);
  await fsyncDirectory(io, path.dirname(filePath));
}

async function assertIdAvailable(io, rootDir, projectId) {
  try {
    await io.stat(path.join(rootDir, projectId));
  } catch (err) {
    if (err && err.code === 'ENOENT') return;
    throw err;
  }
  throw new Error(`Refusing to overwrite existing project directory: ${projectId}`);
}

async function persistJournal(io, journalPath, journal) {
  const tempPath = `${journalPath}.tmp-${crypto.randomBytes(6).toString('hex')}`;
  try {
    await io.writeFile(tempPath, Buffer.from(JSON.stringify(journal, null, 2), 'utf8'));
    const fd = await io.open(tempPath, 'r+');
    try {
      await fd.sync();
    } finally {
      await fd.close();
    }
    await io.rename(tempPath, journalPath);
  } catch (err) {
    // Whatever stage failed, never leak the unique temp file; the original
    // failure still rejects the caller.
    try {
      await io.unlink(tempPath);
    } catch {
      /* ignore */
    }
    throw err;
  }
  await fsyncDirectory(io, path.dirname(journalPath));
}

/**
 * Reads and validates a leftover transaction journal. Returns null for
 * unreadable or foreign-shaped files; those are still removed, but nothing
 * they might claim is touched.
 */
async function readJournalFile(io, journalPath) {
  let raw;
  try {
    raw = await io.readFile(journalPath, 'utf8');
  } catch {
    return null;
  }
  let doc;
  try {
    doc = JSON.parse(raw);
  } catch {
    return null;
  }
  if (!isPlainObject(doc) || !Array.isArray(doc.entries)) return null;
  const entries = [];
  for (const item of doc.entries) {
    if (
      !isPlainObject(item) ||
      typeof item.stageName !== 'string' ||
      typeof item.finalName !== 'string' ||
      !item.stageName.startsWith(STAGE_PREFIX) ||
      !SAFE_ID_PATTERN.test(item.finalName)
    ) {
      return null;
    }
    entries.push({ stageName: item.stageName, finalName: item.finalName });
  }
  return { entries };
}

/**
 * Deterministic crash recovery. A surviving journal means its transaction
 * never completed, so every listed final and stage belongs to the incomplete
 * transaction and is removed strictly (ENOENT counts as removed), the root
 * directory is fsynced, and only then is the journal itself unlinked and
 * that removal made durable. Any listed-path removal or sync failure retains
 * the journal and rejects so a later pass can retry; the sole incomplete-
 * transaction marker is never silently dropped. Foreign-shaped or unreadable
 * journals authorize nothing and only the file itself is removed. Orphaned
 * stage directories (crash before a journal existed, or single-project
 * imports that never journal) are swept along with journal temp files
 * matching only the service-owned temp shape. Pre-existing and unrelated
 * project directories are never touched.
 *
 * ponytail: assumes a single importer process per store root; revisit when
 * multi-process concurrent imports become real.
 */
async function recoverLeftovers(io, resolveRoot) {
  const rootDir = resolveRoot();
  let names;
  try {
    names = await io.readdir(rootDir);
  } catch (err) {
    if (err && err.code === 'ENOENT') return;
    throw err;
  }
  names.sort();
  for (const name of names) {
    if (!name.startsWith(JOURNAL_PREFIX) || !name.endsWith(JOURNAL_SUFFIX)) continue;
    const journalPath = path.join(rootDir, name);
    const journal = await readJournalFile(io, journalPath);
    if (!journal) {
      // Unreadable or foreign-shaped: it claims nothing, so drop the file.
      try {
        await io.unlink(journalPath);
      } catch {
        /* ignore */
      }
      continue;
    }
    for (const entry of journal.entries) {
      await removeTreeStrict(io, path.join(rootDir, entry.finalName));
      await removeTreeStrict(io, path.join(rootDir, entry.stageName));
    }
    await fsyncDirectory(io, rootDir, { strict: true });
    await io.unlink(journalPath);
    await fsyncDirectory(io, rootDir, { strict: true });
  }
  for (const name of names) {
    if (name.startsWith(STAGE_PREFIX) || JOURNAL_TEMP_PATTERN.test(name)) {
      await removeTreeBestEffort(io, path.join(rootDir, name));
    }
  }
}

/**
 * Preserves both failures without hiding either: the original transaction
 * error leads the message and both full errors stay inspectable on the
 * aggregate.
 */
function joinTransactionErrors(transactionError, cleanupError) {
  return new AggregateError(
    [transactionError, cleanupError],
    `${transactionError.message}; cleanup also failed: ${cleanupError.message}`,
  );
}

/**
 * The one strict rollback protocol shared by the streaming V2 and JSON-v1
 * library bodies. Destructive work is authorized only by a validated durable
 * journal: an existing journal that still validates is kept, a missing or
 * foreign-shaped one is re-persisted and fsynced first. Every listed final
 * and stage is then removed strictly (ENOENT counts as removed) and the root
 * is fsynced before the journal is unlinked and that removal made durable
 * too. On any failure the journal is left (or recreated) in place and an
 * aggregate preserving both the original transaction error and the cleanup
 * failure is thrown, so later recovery can retry. Returns only after a
 * durably completed rollback.
 */
async function rollbackLibraryTransaction(
  io,
  rootDir,
  journalPath,
  journalDoc,
  entries,
  transactionError,
) {
  try {
    const existing = await readJournalFile(io, journalPath);
    if (!existing) await persistJournal(io, journalPath, journalDoc());
  } catch (err) {
    // Without a durable marker nothing may be destroyed: leave every
    // artifact untouched for a later retry.
    throw joinTransactionErrors(transactionError, err);
  }
  try {
    for (const entry of entries) {
      await removeTreeStrict(io, path.join(rootDir, entry.finalName));
      await removeTreeStrict(io, path.join(rootDir, entry.stageName));
    }
    await fsyncDirectory(io, rootDir, { strict: true });
  } catch (err) {
    // The durable journal is still in place; recovery can retry the rest.
    throw joinTransactionErrors(transactionError, err);
  }
  try {
    await io.unlink(journalPath);
    await fsyncDirectory(io, rootDir, { strict: true });
  } catch (err) {
    // The unlink may have landed just before this fsync failed: re-persist
    // the marker so the incomplete transaction keeps its retry anchor.
    try {
      await persistJournal(io, journalPath, journalDoc());
    } catch {
      /* best effort: the unlink/fsync failure below still rejects */
    }
    throw joinTransactionErrors(transactionError, err);
  }
}

/**
 * Shared journaled library transaction: persists the rollback journal first,
 * stages every planned project directory, hands staging to `fillStages`,
 * promotes each stage with a per-promotion journal refresh, and owns the
 * single strict rollback/finalization protocol for both endings. Success
 * requires the journal to be durably gone: a surviving journal would make a
 * later recovery delete these very projects.
 */
async function runLibraryTransaction(io, rootDir, now, plans, fillStages) {
  const transactionId = crypto.randomBytes(12).toString('hex');
  const journalEntries = plans.map((plan, index) => ({
    stageName: `${STAGE_PREFIX}${transactionId}-${index}`,
    finalName: plan.id,
    promoted: false,
  }));
  const journalPath = path.join(
    rootDir,
    `${JOURNAL_PREFIX}${transactionId}${JOURNAL_SUFFIX}`,
  );
  const journalDoc = () => ({
    version: 1,
    transactionId,
    createdAt: now(),
    entries: journalEntries,
  });
  await persistJournal(io, journalPath, journalDoc());

  const stageDirs = journalEntries.map((entry) => path.join(rootDir, entry.stageName));
  const finalDirs = journalEntries.map((entry) => path.join(rootDir, entry.finalName));
  const importedProjects = [];

  try {
    for (const stageDir of stageDirs) {
      await io.mkdir(stageDir, { recursive: true });
    }
    await fillStages(stageDirs, finalDirs, importedProjects);
    for (let index = 0; index < plans.length; index++) {
      await io.rename(stageDirs[index], finalDirs[index]);
      journalEntries[index].promoted = true;
      await persistJournal(io, journalPath, journalDoc());
    }
  } catch (err) {
    // Roll back every final/stage created by this transaction under journal
    // protection; finals were proven absent beforehand, so anything present
    // now is ours.
    await rollbackLibraryTransaction(io, rootDir, journalPath, journalDoc, journalEntries, err);
    throw err;
  }

  try {
    await io.unlink(journalPath);
    await fsyncDirectory(io, rootDir, { strict: true });
    return importedProjects;
  } catch (err) {
    // Final cleanup failed after promotion: reject, undo everything this
    // transaction created, and end with either a fully clean store or a
    // durable journal marking the unambiguous incomplete transaction.
    await rollbackLibraryTransaction(io, rootDir, journalPath, journalDoc, journalEntries, err);
    throw err;
  }
}

/**
 * Single-project promotion: everything happens inside a unique stage
 * directory under the store root (same filesystem), and the only visibility
 * point is one rename onto the final path. Any failure removes the stage and
 * leaves no final directory behind.
 */
async function promoteSingleProject(io, rootDir, projectId, fillStage) {
  const stageDir = path.join(
    rootDir,
    `${STAGE_PREFIX}${crypto.randomBytes(12).toString('hex')}`,
  );
  const finalDir = path.join(rootDir, projectId);
  await io.mkdir(stageDir, { recursive: true });
  try {
    const project = await fillStage(stageDir, finalDir);
    await writeDurableJson(io, path.join(stageDir, PROJECT_JSON_NAME), project);
    await io.rename(stageDir, finalDir);
    await fsyncDirectory(io, rootDir);
    return project;
  } catch (err) {
    await removeTreeBestEffort(io, stageDir);
    throw err;
  }
}

/**
 * Assets stream into the staging directory, so their recorded paths carry the
 * stage prefix. Before the session is normalized and persisted, every path is
 * rebased onto the final directory the stage will be renamed to.
 */
function rebaseAssetMap(assetMap, stageDir, finalDir) {
  for (const [key, value] of assetMap) {
    if (typeof value === 'string' && value.startsWith(`${stageDir}${path.sep}`)) {
      assetMap.set(key, `${finalDir}${value.slice(stageDir.length)}`);
    }
  }
}

// ─── JSON-v1 direct import (no temporary bundles) ────────────────────────────

function decodeBase64Asset(value, what) {
  if (typeof value !== 'string') {
    throw new Error(`${what} dataBase64 must be a string`);
  }
  const compact = value.replace(/\s+/g, '');
  if (compact.length === 0) return Buffer.alloc(0);
  if (!/^[A-Za-z0-9+/]+={0,2}$/.test(compact) || compact.length % 4 !== 0) {
    throw new Error(`${what} contains invalid base64`);
  }
  return Buffer.from(compact, 'base64');
}

async function materializeJsonV1Assets(io, stageDir, assets, state) {
  if (assets === undefined) return;
  if (!Array.isArray(assets)) {
    throw new Error('v1 assets must be an array when present');
  }
  for (const asset of assets) {
    if (!isPlainObject(asset)) {
      throw new Error('each v1 asset must be an object');
    }
    const key = asset.key;
    assertSafeKey(key, 'v1 asset key');
    if (state.wireKeys.has(key)) {
      throw new Error(`Duplicate v1 asset key "${key}"`);
    }
    const rawName =
      typeof asset.name === 'string' && asset.name.length > 0 ? asset.name : key;
    assertSafeBasename(rawName, `v1 asset name for key "${key}"`);
    const data = decodeBase64Asset(asset.dataBase64, `v1 asset "${key}"`);
    const subdir = key.startsWith('chunk:') ? 'chunks' : 'audio';
    const relativeTarget = `${subdir}/${buildRestoreLeaf(key, rawName)}`;
    guardCaseCollision(state.caseTargets, relativeTarget);
    const absoluteTarget = assertContainedChild(
      stageDir,
      relativeTarget,
      'v1 asset target',
    );
    await io.mkdir(path.dirname(absoluteTarget), { recursive: true });
    await io.writeFile(absoluteTarget, data);
    state.wireKeys.add(key);
    state.assetMap.set(key, absoluteTarget);
  }
}

// ─── Service factory ─────────────────────────────────────────────────────────

function createStreamingBundleService(options = {}) {
  if (!isPlainObject(options)) {
    throw new TypeError('options must be an object');
  }
  const rootOption = options.projectsRootDir;
  if (typeof rootOption !== 'string' && typeof rootOption !== 'function') {
    throw new TypeError(
      'options.projectsRootDir must be an absolute path or a resolver function',
    );
  }
  if (typeof options.newProjectId !== 'function') {
    throw new TypeError('options.newProjectId must be a function');
  }
  const newProjectId = options.newProjectId;
  const now =
    typeof options.now === 'function' ? options.now : () => new Date().toISOString();
  const limits = resolveLimits(options.limits);
  // Narrow fault seam: every filesystem operation below goes through `io`, so
  // tests can inject single-operation failures without touching live paths.
  const io = { ...fsp, ...(isPlainObject(options.fs) ? options.fs : {}) };

  const resolveRoot = () => {
    const dir = typeof rootOption === 'function' ? rootOption() : rootOption;
    if (typeof dir !== 'string' || dir.length === 0) {
      throw new TypeError('projectsRootDir must resolve to a non-empty string');
    }
    if (!path.isAbsolute(dir)) {
      throw new TypeError('projectsRootDir must be an absolute path');
    }
    return dir;
  };

  const allocateProjectId = () => {
    const id = newProjectId();
    if (
      typeof id !== 'string' ||
      id.length === 0 ||
      id.length > MAX_KEY_CHARS ||
      !SAFE_ID_PATTERN.test(id) ||
      id.includes('..')
    ) {
      throw new Error(`newProjectId produced an unsafe project id: ${String(id)}`);
    }
    return id;
  };

  // Imports are serialized so leftover recovery can never race a live
  // transaction staged by this same service instance.
  let queue = Promise.resolve();
  const enqueue = (operation) => {
    const run = queue.then(operation, operation);
    queue = run.then(
      () => {},
      () => {},
    );
    return run;
  };

  // One creation-time recovery pass, chained into the serialized import
  // barrier instead of running detached: the first queued import awaits it
  // (observing any failure) before launching its own required pre-import
  // pass, and every later import runs exactly one pass — all inside the
  // queue, so no recovery can race another pass or a live transaction.
  const startupRecovery = recoverLeftovers(io, resolveRoot);
  startupRecovery.catch(() => {}); // no-import edge only; the first import observes the real rejection
  let startupAwaited = false;
  const ensureRecovered = async () => {
    if (!startupAwaited) {
      startupAwaited = true;
      await startupRecovery;
    }
    await recoverLeftovers(io, resolveRoot);
  };

  function assertFilePath(filePath) {
    if (typeof filePath !== 'string' || filePath.length === 0) {
      throw new TypeError('filePath must be a non-empty string');
    }
  }

  async function importStreamingProjectBody(reader, archiveSize) {
    const rootDir = resolveRoot();
    const metadata = await readMetadataFrame(reader, 'project bundle', limits);
    assertProjectMetadataShape(metadata);
    const manifest = parseAssetManifest(metadata, 'project bundle');
    const assetMetaRows = parseLegacyAssetMeta(metadata, 'project bundle');
    const projectId = allocateProjectId();
    await assertIdAvailable(io, rootDir, projectId);
    const timestamp = now();

    return promoteSingleProject(io, rootDir, projectId, async (stageDir, finalDir) => {
      const state = createBundleImportState(manifest, assetMetaRows);
      if (manifest) {
        const planned = planManifestTargets(stageDir, manifest);
        state.targetsByKey = planned.targetsByKey;
        state.caseTargets = planned.caseTargets;
      }
      await streamAssetRecords(io, reader, {
        maxLineBytes: limits.maxLineBytes,
        library: false,
        states: [state],
        stages: [stageDir],
        archiveSize,
      });
      verifyCollectedRecords(state, 'project bundle');
      rebaseAssetMap(state.assetMap, stageDir, finalDir);
      applyManifestAliases(state);
      return assembleImportedProject(
        metadata.project,
        projectId,
        timestamp,
        state.assetMap,
      );
    });
  }

  async function importJsonV1ProjectBody(doc) {
    const rootDir = resolveRoot();
    const projectId = allocateProjectId();
    await assertIdAvailable(io, rootDir, projectId);
    const timestamp = now();

    return promoteSingleProject(io, rootDir, projectId, async (stageDir, finalDir) => {
      const state = createBundleImportState(null, null);
      await materializeJsonV1Assets(io, stageDir, doc.assets, state);
      rebaseAssetMap(state.assetMap, stageDir, finalDir);
      return assembleImportedProject(doc.project, projectId, timestamp, state.assetMap);
    });
  }

  async function importAnyProject(filePath) {
    assertFilePath(filePath);
    await ensureRecovered();
    const fd = await io.open(filePath, 'r');
    try {
      const stat = await fd.stat();
      if (!stat.isFile()) {
        throw new Error('Bundle path is not a regular file');
      }
      if (stat.size > limits.maxArchiveBytes) {
        throw new Error(
          `Bundle exceeds the maximum archive size (${limits.maxArchiveBytes} bytes)`,
        );
      }
      const reader = createBoundedReader(io, fd);
      const header = (await reader.peekUpTo(LIBRARY_MAGIC.length + 1)).toString('latin1');
      if (stat.size === 0) {
        throw new Error('Bundle file is empty or lacks a format header');
      }
      const route =
        header.startsWith(`${PROJECT_MAGIC}\n`) ? 'project'
        : header.startsWith(`${LIBRARY_MAGIC}\n`) ? 'library'
        : null;
      if (route !== null) {
        const headerLength = (route === 'project' ? PROJECT_MAGIC.length : LIBRARY_MAGIC.length) + 1;
        await reader.readExact(headerLength, 'bundle header');
        if (route === 'library') {
          throw new Error('This is a library bundle; use importLibraryBundle');
        }
        return await importStreamingProjectBody(reader, stat.size);
      }
      if (stat.size > limits.maxJsonV1Bytes) {
        throw new Error(`JSON document exceeds the ${limits.maxJsonV1Bytes} byte limit`);
      }
      const text = fatalDecode(await io.readFile(filePath), 'JSON document');
      let doc;
      try {
        doc = JSON.parse(text);
      } catch {
        throw new Error('JSON document is not valid JSON');
      }
      if (!isPlainObject(doc) || doc.format !== PROJECT_FORMAT_V1) {
        throw new Error(
          `Unsupported project format; expected "${PROJECT_MAGIC}" wire header or "${PROJECT_FORMAT_V1}" document`,
        );
      }
      if (!isPlainObject(doc.project)) {
        throw new Error('v1 document project must be an object');
      }
      return await importJsonV1ProjectBody(doc);
    } finally {
      await fd.close();
    }
  }

  async function importStreamingLibraryBody(reader, archiveSize) {
    const rootDir = resolveRoot();
    const metadata = await readMetadataFrame(reader, 'library bundle', limits);
    assertLibraryMetadataShape(metadata);
    const bundles = metadata.bundles.map((bundle) => ({
      project: bundle.project,
      manifest: parseAssetManifest(bundle, 'library bundle'),
      assetMetaRows: parseLegacyAssetMeta(bundle, 'library bundle'),
    }));

    const plans = bundles.map(() => ({ id: allocateProjectId() }));
    for (const plan of plans) {
      await assertIdAvailable(io, rootDir, plan.id);
    }

    return runLibraryTransaction(io, rootDir, now, plans, async (
      stageDirs,
      finalDirs,
      importedProjects,
    ) => {
      const states = bundles.map((bundle) =>
        createBundleImportState(bundle.manifest, bundle.assetMetaRows),
      );
      bundles.forEach((bundle, index) => {
        if (bundle.manifest) {
          const planned = planManifestTargets(stageDirs[index], bundle.manifest);
          states[index].targetsByKey = planned.targetsByKey;
          states[index].caseTargets = planned.caseTargets;
        }
      });

      await streamAssetRecords(io, reader, {
        maxLineBytes: limits.maxLineBytes,
        library: true,
        states,
        stages: stageDirs,
        archiveSize,
      });

      for (let index = 0; index < bundles.length; index++) {
        verifyCollectedRecords(states[index], 'library bundle');
        rebaseAssetMap(states[index].assetMap, stageDirs[index], finalDirs[index]);
        applyManifestAliases(states[index]);
        const project = assembleImportedProject(
          bundles[index].project,
          plans[index].id,
          now(),
          states[index].assetMap,
        );
        await writeDurableJson(io, path.join(stageDirs[index], PROJECT_JSON_NAME), project);
        importedProjects.push(project);
      }
    });
  }

  async function importJsonV1LibraryBody(doc) {
    const rootDir = resolveRoot();
    if (!Array.isArray(doc.bundles)) {
      throw new Error('v1 library document bundles must be an array');
    }
    const plans = doc.bundles.map((bundle, index) => {
      if (!isPlainObject(bundle)) {
        throw new Error(`v1 library bundles[${index}] must be an object`);
      }
      if (!isPlainObject(bundle.project)) {
        throw new Error(`v1 library bundles[${index}].project must be an object`);
      }
      return { id: allocateProjectId(), bundle };
    });
    for (const plan of plans) {
      await assertIdAvailable(io, rootDir, plan.id);
    }

    return runLibraryTransaction(io, rootDir, now, plans, async (
      stageDirs,
      finalDirs,
      importedProjects,
    ) => {
      for (let index = 0; index < plans.length; index++) {
        const state = createBundleImportState(null, null);
        await materializeJsonV1Assets(
          io,
          stageDirs[index],
          plans[index].bundle.assets,
          state,
        );
        rebaseAssetMap(state.assetMap, stageDirs[index], finalDirs[index]);
        const project = assembleImportedProject(
          plans[index].bundle.project,
          plans[index].id,
          now(),
          state.assetMap,
        );
        await writeDurableJson(io, path.join(stageDirs[index], PROJECT_JSON_NAME), project);
        importedProjects.push(project);
      }
    });
  }

  async function importAnyLibrary(filePath) {
    assertFilePath(filePath);
    await ensureRecovered();
    const fd = await io.open(filePath, 'r');
    try {
      const stat = await fd.stat();
      if (!stat.isFile()) {
        throw new Error('Bundle path is not a regular file');
      }
      if (stat.size > limits.maxArchiveBytes) {
        throw new Error(
          `Bundle exceeds the maximum archive size (${limits.maxArchiveBytes} bytes)`,
        );
      }
      const reader = createBoundedReader(io, fd);
      if (stat.size === 0) {
        throw new Error('Bundle file is empty or lacks a format header');
      }
      const header = (await reader.peekUpTo(LIBRARY_MAGIC.length + 1)).toString('latin1');
      const route =
        header.startsWith(`${PROJECT_MAGIC}\n`) ? 'project'
        : header.startsWith(`${LIBRARY_MAGIC}\n`) ? 'library'
        : null;
      if (route !== null) {
        const headerLength = (route === 'project' ? PROJECT_MAGIC.length : LIBRARY_MAGIC.length) + 1;
        await reader.readExact(headerLength, 'bundle header');
        if (route === 'project') {
          throw new Error('This is a project bundle; use importProjectBundle');
        }
        return await importStreamingLibraryBody(reader, stat.size);
      }
      if (stat.size > limits.maxJsonV1Bytes) {
        throw new Error(`JSON document exceeds the ${limits.maxJsonV1Bytes} byte limit`);
      }
      const text = fatalDecode(await io.readFile(filePath), 'JSON document');
      let doc;
      try {
        doc = JSON.parse(text);
      } catch {
        throw new Error('JSON document is not valid JSON');
      }
      if (!isPlainObject(doc) || doc.format !== LIBRARY_FORMAT_V1) {
        throw new Error(
          `Unsupported library format; expected "${LIBRARY_MAGIC}" wire header or "${LIBRARY_FORMAT_V1}" document`,
        );
      }
      return await importJsonV1LibraryBody(doc);
    } finally {
      await fd.close();
    }
  }

  // Unified content router: one open + one bounded peek classifies the file,
  // then each format delegates to the same internal body the format-specific
  // public methods use. Same recovery barrier, no extension sniffing, no
  // second queued entry point.
  async function importAnyBundle(filePath) {
    assertFilePath(filePath);
    await ensureRecovered();
    const fd = await io.open(filePath, 'r');
    try {
      const stat = await fd.stat();
      if (!stat.isFile()) {
        throw new Error('Bundle path is not a regular file');
      }
      if (stat.size > limits.maxArchiveBytes) {
        throw new Error(
          `Bundle exceeds the maximum archive size (${limits.maxArchiveBytes} bytes)`,
        );
      }
      if (stat.size === 0) {
        throw new Error('Bundle file is empty or lacks a format header');
      }
      const reader = createBoundedReader(io, fd);
      const header = (await reader.peekUpTo(LIBRARY_MAGIC.length + 1)).toString('latin1');
      if (header.startsWith(`${PROJECT_MAGIC}\n`)) {
        await reader.readExact(PROJECT_MAGIC.length + 1, 'bundle header');
        return [await importStreamingProjectBody(reader, stat.size)];
      }
      if (header.startsWith(`${LIBRARY_MAGIC}\n`)) {
        await reader.readExact(LIBRARY_MAGIC.length + 1, 'bundle header');
        return await importStreamingLibraryBody(reader, stat.size);
      }
      if (stat.size > limits.maxJsonV1Bytes) {
        throw new Error(`JSON document exceeds the ${limits.maxJsonV1Bytes} byte limit`);
      }
      // Single-handle read: the non-consuming peek left all stat.size bytes
      // buffered/remaining on this reader, so the document comes off the
      // already-open fd — never a second path read after classification.
      const text = fatalDecode(
        await reader.readExact(stat.size, 'JSON document'),
        'JSON document',
      );
      let doc;
      try {
        doc = JSON.parse(text);
      } catch {
        throw new Error('JSON document is not valid JSON');
      }
      const isProjectV1 = isPlainObject(doc) && doc.format === PROJECT_FORMAT_V1;
      const isLibraryV1 = isPlainObject(doc) && doc.format === LIBRARY_FORMAT_V1;
      if (!isProjectV1 && !isLibraryV1) {
        throw new Error(
          `Unsupported bundle format; expected "${PROJECT_MAGIC}" or "${LIBRARY_MAGIC}" wire header, or "${PROJECT_FORMAT_V1}" / "${LIBRARY_FORMAT_V1}" document`,
        );
      }
      if (isLibraryV1) {
        return await importJsonV1LibraryBody(doc);
      }
      if (!isPlainObject(doc.project)) {
        throw new Error('v1 document project must be an object');
      }
      return [await importJsonV1ProjectBody(doc)];
    } finally {
      await fd.close();
    }
  }

  return {
    writeProjectBundle(project, filePath) {
      if (!isPlainObject(project)) {
        throw new TypeError('project must be an object');
      }
      return exportBundles(io, limits, now, false, [project], filePath);
    },

    writeLibraryBundle(projects, filePath) {
      if (!Array.isArray(projects)) {
        throw new TypeError('projects must be an array');
      }
      return exportBundles(io, limits, now, true, projects, filePath);
    },

    importProjectBundle(filePath) {
      return enqueue(() => importAnyProject(filePath));
    },

    importLibraryBundle(filePath) {
      return enqueue(() => importAnyLibrary(filePath));
    },

    importBundle(filePath) {
      return enqueue(() => importAnyBundle(filePath));
    },
  };
}

module.exports = { createStreamingBundleService };
