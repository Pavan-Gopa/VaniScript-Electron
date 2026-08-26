'use strict';

const SHORTS_EXPORT_CONTRACT = 'vaniscript-shorts-render-v1';
const SAFE_STRING_PATTERN = /^[^\u0000-\u001f\u007f]*$/u;
const OUTPUT_EXTENSION_PATTERN = /^\.(mp4|mov)$/u;

function isPlainObject(value) {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function isSafeString(value, allowEmpty = false) {
  return typeof value === 'string'
    && (allowEmpty || value.trim().length > 0)
    && SAFE_STRING_PATTERN.test(value);
}

function isFiniteNumber(value) {
  return typeof value === 'number' && Number.isFinite(value);
}

/** Runtime guard for the JSON subset used by the wire contract. */
function isJsonCompatibleValue(value, ancestors = new WeakSet()) {
  if (value === null || typeof value === 'string' || typeof value === 'boolean') return true;
  if (typeof value === 'number') return Number.isFinite(value);
  if (typeof value !== 'object' || value === undefined || ancestors.has(value)) return false;

  ancestors.add(value);
  let valid = true;
  if (Array.isArray(value)) {
    valid = value.every((item) => isJsonCompatibleValue(item, ancestors));
  } else if (isPlainObject(value)) {
    valid = Object.keys(value).every((key) => isJsonCompatibleValue(value[key], ancestors));
  } else {
    valid = false;
  }
  ancestors.delete(value);
  return valid;
}

function cloneJsonValue(value, valuePath, ancestors) {
  if (value === null || typeof value === 'string' || typeof value === 'boolean') return value;
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) throw new TypeError(`Non-finite number at ${valuePath}.`);
    return Object.is(value, -0) ? 0 : value;
  }
  if (typeof value !== 'object' || value === undefined) {
    throw new TypeError(`Non-JSON value at ${valuePath}.`);
  }
  if (ancestors.has(value)) throw new TypeError(`Cyclic value at ${valuePath}.`);
  ancestors.add(value);

  let result;
  if (Array.isArray(value)) {
    const cloned = [];
    value.forEach((item, index) => {
      if (item === undefined) throw new TypeError(`Undefined array item at ${valuePath}[${index}].`);
      cloned.push(cloneJsonValue(item, `${valuePath}[${index}]`, ancestors));
    });
    result = cloned;
  } else if (isPlainObject(value)) {
    const cloned = {};
    for (const key of Object.keys(value)) {
      // Undefined object properties are omitted by JSON.stringify and are not
      // part of the wire shape. This also handles optional render fields.
      if (value[key] === undefined) continue;
      Object.defineProperty(cloned, key, {
        configurable: true,
        enumerable: true,
        value: cloneJsonValue(value[key], `${valuePath}.${key}`, ancestors),
        writable: true,
      });
    }
    result = cloned;
  } else {
    throw new TypeError(`Non-plain object at ${valuePath}.`);
  }

  ancestors.delete(value);
  return result;
}

function freezeRecursively(value, seen = new WeakSet()) {
  if (value !== null && typeof value === 'object') {
    if (!seen.has(value)) {
      seen.add(value);
      if (Array.isArray(value)) {
        value.forEach((item) => freezeRecursively(item, seen));
      } else {
        Object.keys(value).forEach((key) => {
          freezeRecursively(value[key], seen);
        });
      }
      Object.freeze(value);
    }
  }
  return value;
}

/** Deep-freeze a JSON-compatible value in place. */
function deepFreeze(value) {
  if (!isJsonCompatibleValue(value)) throw new TypeError('deepFreeze requires an acyclic JSON-compatible value.');
  return freezeRecursively(value);
}

/** Clone into plain JSON values, then recursively freeze the clone. */
function deepCloneDeepFreeze(value) {
  const cloned = cloneJsonValue(value, '$', new WeakSet());
  return freezeRecursively(cloned);
}

function compareSelection(left, right) {
  if (left.stableID < right.stableID) return -1;
  if (left.stableID > right.stableID) return 1;
  if (left.language < right.language) return -1;
  if (left.language > right.language) return 1;
  return 0;
}

function safeExportPart(value, fallback = 'clip') {
  return (value || fallback)
    .replace(/[<>:"/\\|?*\x00-\x1F]/gu, '_')
    .replace(/[^\p{L}\p{N}_ -]/gu, '')
    .replace(/\s+/gu, '_')
    .replace(/_+/gu, '_')
    .slice(0, 80) || fallback;
}

function normalizeExtension(extension) {
  const value = extension.trim().toLowerCase();
  const normalized = value.startsWith('.') ? value : `.${value}`;
  if (!OUTPUT_EXTENSION_PATTERN.test(normalized)) {
    throw new TypeError(`Unsupported Shorts export extension: ${extension}.`);
  }
  return normalized;
}

/**
 * Derive the deterministic one-based output name used by every export slice.
 * Ordering is supplied by the caller; materialization supplies stable order.
 */
function shortsExportFileName(ordinal, language, title, extension) {
  if (!Number.isInteger(ordinal) || ordinal < 1) throw new TypeError('Shorts export ordinal must be a positive integer.');
  if (language !== 'source' && language !== 'target') throw new TypeError(`Unsupported Shorts export language: ${language}.`);
  const suffix = normalizeExtension(extension);
  return `${String(ordinal).padStart(2, '0')}_${language}_${safeExportPart(title)}${suffix}`;
}

function joinOutputDirectory(directory, fileName) {
  const trimmed = directory.trim();
  if (!trimmed) throw new TypeError('Shorts export output directory is required.');
  if (/^[\\/]+$/u.test(trimmed)) return `${trimmed}${fileName}`;
  const separator = trimmed.includes('\\') && !trimmed.includes('/') ? '\\' : '/';
  return `${trimmed.replace(/[\\/]+$/u, '')}${separator}${fileName}`;
}

function normalizeProbeResult(probeResult) {
  if (!isPlainObject(probeResult)) throw new TypeError('Shorts export probe result must be a plain object.');
  const { width, height, durationSec, fps } = probeResult;
  if (!Number.isInteger(width) || width < 1 || !Number.isInteger(height) || height < 1) {
    throw new TypeError('Shorts export probe dimensions must be positive integers.');
  }
  if (!isFiniteNumber(durationSec) || durationSec < 0) {
    throw new TypeError('Shorts export probe duration must be a finite non-negative number.');
  }
  if (fps !== undefined && fps !== null && (!isFiniteNumber(fps) || fps <= 0)) {
    throw new TypeError('Shorts export probe FPS must be null or a positive finite number.');
  }
  return { width, height, durationSec, fps: fps ?? null };
}

function throwSnapshotIssues(validation) {
  if (validation.ok) throw new Error('Expected an invalid Shorts export snapshot.');
  const detail = validation.issues.map((issue) => `${issue.code} at ${issue.path}: ${issue.message}`).join('; ');
  throw new TypeError(`Invalid Shorts export snapshot: ${detail}`);
}

function finalizeSnapshot(value) {
  const frozen = deepCloneDeepFreeze(value);
  const validation = validateShortsExportSnapshot(frozen);
  if (!validation.ok) throwSnapshotIssues(validation);
  return frozen;
}

/**
 * Materialize exactly once from the synchronous seed, probe result, and chosen
 * output directory. Callers must not rebuild this object after awaiting probe
 * or directory selection; the returned value is an immutable export boundary.
 */
function materializeShortsExportSnapshot(seed, probeResult, chosenDirectory) {
  if (!isPlainObject(seed)) throw new TypeError('Shorts export seed must be a plain object.');
  const info = normalizeProbeResult(probeResult);
  if (!isSafeString(seed.jobId)) throw new TypeError('Shorts export jobId must be a non-empty safe string.');
  if (!isPlainObject(seed.source)) throw new TypeError('Shorts export seed source must be a plain object.');
  if (!isSafeString(seed.source.inputVideoPath) || !isSafeString(seed.source.inputVideoSrc) || !isSafeString(seed.source.sourceFileName)) {
    throw new TypeError('Shorts export seed source paths and filename are required safe strings.');
  }
  if (!isPlainObject(seed.options) || !Array.isArray(seed.clips)) {
    throw new TypeError('Shorts export seed options and clips are required.');
  }

  const ordered = [...seed.clips].sort(compareSelection);
  const clips = ordered.map((clip, index) => {
    if (!isPlainObject(clip) || !isSafeString(clip.stableID)) {
      throw new TypeError(`Shorts export clip ${index + 1} has an invalid stableID.`);
    }
    if (clip.language !== 'source' && clip.language !== 'target') {
      throw new TypeError(`Shorts export clip ${clip.stableID} has an invalid language.`);
    }
    if (!isPlainObject(clip.project)) throw new TypeError(`Shorts export clip ${clip.stableID} is missing its render project.`);
    const title = typeof clip.title === 'string' ? clip.title : clip.project.title;
    if (!isSafeString(title, true)) throw new TypeError(`Shorts export clip ${clip.stableID} has an invalid title.`);
    const fileName = shortsExportFileName(index + 1, clip.language, title, seed.options.format);
    return {
      ordinal: index + 1,
      stableID: clip.stableID,
      language: clip.language,
      fileName,
      outputPath: joinOutputDirectory(chosenDirectory, fileName),
      project: clip.project,
    };
  });

  return finalizeSnapshot({
    contract: SHORTS_EXPORT_CONTRACT,
    jobId: seed.jobId,
    source: {
      inputVideoPath: seed.source.inputVideoPath,
      inputVideoSrc: seed.source.inputVideoSrc,
      sourceFileName: seed.source.sourceFileName,
      info,
    },
    options: seed.options,
    clips,
  });
}

/** Build/freeze a complete snapshot when paths and source info are already known. */
function buildShortsExportSnapshot(input) {
  if (!isPlainObject(input) || !Array.isArray(input.clips)) throw new TypeError('Shorts export snapshot input is invalid.');
  const ordered = [...input.clips].sort(compareSelection);
  const clips = ordered.map((clip, index) => {
    if (!isPlainObject(clip)) throw new TypeError(`Shorts export clip ${index + 1} is invalid.`);
    const project = clip.project;
    if (!isPlainObject(project)) throw new TypeError(`Shorts export clip ${index + 1} is missing its render project.`);
    const title = typeof project.title === 'string' ? project.title : '';
    const language = clip.language;
    if (language !== 'source' && language !== 'target') throw new TypeError(`Shorts export clip ${index + 1} has an invalid language.`);
    const fileName = typeof clip.fileName === 'string' && clip.fileName.length > 0
      ? clip.fileName
      : shortsExportFileName(index + 1, language, title, input.options.format);
    if (typeof clip.outputPath !== 'string' || clip.outputPath.length === 0) {
      throw new TypeError(`Shorts export clip ${clip.stableID} is missing outputPath.`);
    }
    return {
      ordinal: index + 1,
      stableID: clip.stableID,
      language,
      fileName,
      outputPath: clip.outputPath,
      project,
    };
  });
  return finalizeSnapshot({
    contract: input.contract || SHORTS_EXPORT_CONTRACT,
    jobId: input.jobId,
    source: input.source,
    options: input.options,
    clips,
  });
}

function outputPathClips(value) {
  if (Array.isArray(value)) return value;
  const snapshot = value;
  return Array.isArray(snapshot.clips) ? snapshot.clips : [];
}

/** Return output paths occurring more than once, in deterministic order. */
function findDuplicateOutputPaths(value) {
  const counts = new Map();
  for (const clip of outputPathClips(value)) {
    if (typeof clip?.outputPath !== 'string') continue;
    counts.set(clip.outputPath, (counts.get(clip.outputPath) || 0) + 1);
  }
  return [...counts.entries()]
    .filter(([, count]) => count > 1)
    .map(([outputPath]) => outputPath)
    .sort();
}

function addIssue(issues, issuePath, code, message) {
  issues.push({ path: issuePath, code, message });
}

function requireString(record, key, issuePath, issues, allowEmpty = false) {
  const value = record[key];
  if (!isSafeString(value, allowEmpty)) {
    addIssue(issues, `${issuePath}.${key}`, 'INVALID_STRING', 'Expected a non-empty string without control characters.');
    return null;
  }
  return value;
}

function requireFiniteNumber(record, key, issuePath, issues, { integer = false, min } = {}) {
  const value = record[key];
  if (!isFiniteNumber(value) || (integer && !Number.isInteger(value)) || (min !== undefined && value < min)) {
    addIssue(issues, `${issuePath}.${key}`, 'INVALID_NUMBER', 'Expected a finite number within the contract bounds.');
    return null;
  }
  return value;
}

function validateProject(project, issuePath, sourceSrc, issues) {
  if (!isPlainObject(project) || !isJsonCompatibleValue(project)) {
    addIssue(issues, issuePath, 'INVALID_PROJECT', 'Render project must be a plain JSON-compatible object.');
    return;
  }
  requireString(project, 'id', issuePath, issues);
  requireString(project, 'title', issuePath, issues, true);
  const projectSrc = requireString(project, 'inputVideoSrc', issuePath, issues);
  if (projectSrc !== null && projectSrc !== sourceSrc) {
    addIssue(issues, `${issuePath}.inputVideoSrc`, 'SOURCE_MISMATCH', 'Render project inputVideoSrc must match snapshot source inputVideoSrc.');
  }
  for (const key of ['sourceWidth', 'sourceHeight', 'width', 'height']) {
    requireFiniteNumber(project, key, issuePath, issues, { integer: true, min: 1 });
  }
  for (const key of ['fps', 'clipStartSec', 'clipEndSec', 'durationSec', 'durationInFrames', 'subtitleBottomMargin']) {
    requireFiniteNumber(project, key, issuePath, issues, { min: key === 'fps' || key === 'durationInFrames' ? 1 : 0 });
  }
  for (const key of ['subtitles', 'frameKeyframes', 'mediaSegments']) {
    if (!Array.isArray(project[key]) || !isJsonCompatibleValue(project[key])) {
      addIssue(issues, `${issuePath}.${key}`, 'INVALID_PROJECT_FIELD', 'Expected a JSON-compatible array.');
    }
  }
  if (!isPlainObject(project.captionStyle) || !isJsonCompatibleValue(project.captionStyle)) {
    addIssue(issues, `${issuePath}.captionStyle`, 'INVALID_PROJECT_FIELD', 'Expected a JSON-compatible caption style object.');
  }
  for (const key of ['timelineCuts', 'timelineTrim', 'backgroundSettings', 'logo', 'textTracks', 'audioTracks', 'intro', 'outro']) {
    if (project[key] !== undefined && !isJsonCompatibleValue(project[key])) {
      addIssue(issues, `${issuePath}.${key}`, 'INVALID_PROJECT_FIELD', 'Optional render project fields must be JSON-compatible.');
    }
  }
}

/** Validate the complete wire value before Main accepts or re-freezes it. */
function validateShortsExportSnapshot(value) {
  const issues = [];
  try {
    if (!isPlainObject(value) || !isJsonCompatibleValue(value)) {
      return {
        ok: false,
        issues: [{ path: '$', code: 'NOT_JSON_COMPATIBLE', message: 'Snapshot must be an acyclic plain JSON-compatible object.' }],
      };
    }

    if (value.contract !== SHORTS_EXPORT_CONTRACT) addIssue(issues, '$.contract', 'INVALID_CONTRACT', `Expected ${SHORTS_EXPORT_CONTRACT}.`);
    requireString(value, 'jobId', '$', issues);

    const source = value.source;
    let sourceSrc = null;
    if (!isPlainObject(source)) {
      addIssue(issues, '$.source', 'INVALID_SOURCE', 'Source must be a plain object.');
    } else {
      requireString(source, 'inputVideoPath', '$.source', issues);
      sourceSrc = requireString(source, 'inputVideoSrc', '$.source', issues);
      requireString(source, 'sourceFileName', '$.source', issues);
      if (!isPlainObject(source.info)) {
        addIssue(issues, '$.source.info', 'INVALID_SOURCE_INFO', 'Source info must be a plain object.');
      } else {
        requireFiniteNumber(source.info, 'width', '$.source.info', issues, { integer: true, min: 1 });
        requireFiniteNumber(source.info, 'height', '$.source.info', issues, { integer: true, min: 1 });
        requireFiniteNumber(source.info, 'durationSec', '$.source.info', issues, { min: 0 });
        if (source.info.fps !== null && (!isFiniteNumber(source.info.fps) || source.info.fps <= 0)) {
          addIssue(issues, '$.source.info.fps', 'INVALID_SOURCE_INFO', 'FPS must be null or a positive finite number.');
        }
      }
    }

    const options = value.options;
    if (!isPlainObject(options)) {
      addIssue(issues, '$.options', 'INVALID_OPTIONS', 'Options must be a plain object.');
    } else {
      if (!['mp4', 'mov'].includes(options.format)) addIssue(issues, '$.options.format', 'INVALID_OPTION', 'Format must be mp4 or mov.');
      if (!['source', '1080p', '2k', '4k'].includes(options.resolutionPreset)) addIssue(issues, '$.options.resolutionPreset', 'INVALID_OPTION', 'Resolution preset is invalid.');
      if (!['source', '24', '25', '30', '50', '60'].includes(options.frameRatePreset)) addIssue(issues, '$.options.frameRatePreset', 'INVALID_OPTION', 'Frame-rate preset is invalid.');
      if (!['high', 'balanced', 'compact'].includes(options.qualityPreset)) addIssue(issues, '$.options.qualityPreset', 'INVALID_OPTION', 'Quality preset is invalid.');
      requireFiniteNumber(options, 'subtitleBottomMargin', '$.options', issues, { min: 0 });
      for (const key of ['subtitleUseCharsPerLine', 'subtitleUseLinesPerCue']) {
        if (typeof options[key] !== 'boolean') addIssue(issues, `$.options.${key}`, 'INVALID_OPTION', 'Subtitle switches must be booleans.');
      }
      requireFiniteNumber(options, 'subtitleMaxCharsPerLine', '$.options', issues, { integer: true, min: 1 });
      requireFiniteNumber(options, 'subtitleMaxLines', '$.options', issues, { integer: true, min: 1 });
    }

    const clips = value.clips;
    if (!Array.isArray(clips) || clips.length === 0) {
      addIssue(issues, '$.clips', 'INVALID_CLIPS', 'Snapshot must contain at least one clip.');
    } else {
      const seenUnits = new Set();
      const seenNames = new Set();
      const seenPaths = new Set();
      clips.forEach((clip, index) => {
        const clipPath = `$.clips[${index}]`;
        if (!isPlainObject(clip) || !isJsonCompatibleValue(clip)) {
          addIssue(issues, clipPath, 'INVALID_CLIP', 'Clip must be a plain JSON-compatible object.');
          return;
        }
        const ordinal = requireFiniteNumber(clip, 'ordinal', clipPath, issues, { integer: true, min: 1 });
        const stableID = requireString(clip, 'stableID', clipPath, issues);
        if (clip.language !== 'source' && clip.language !== 'target') addIssue(issues, `${clipPath}.language`, 'INVALID_LANGUAGE', 'Language must be source or target.');
        const unitKey = stableID && (clip.language === 'source' || clip.language === 'target') ? `${stableID}\u0000${clip.language}` : '';
        if (unitKey && seenUnits.has(unitKey)) addIssue(issues, `${clipPath}.stableID`, 'DUPLICATE_UNIT', 'The same stableID/language unit occurs more than once.');
        if (unitKey) seenUnits.add(unitKey);
        const fileName = requireString(clip, 'fileName', clipPath, issues);
        const outputPath = requireString(clip, 'outputPath', clipPath, issues);
        if (fileName && (fileName.includes('/') || fileName.includes('\\'))) addIssue(issues, `${clipPath}.fileName`, 'INVALID_FILENAME', 'Filename must be a basename without path separators.');
        if (fileName && seenNames.has(fileName)) addIssue(issues, `${clipPath}.fileName`, 'DUPLICATE_OUTPUT_FILENAME', 'Output filenames must be unique.');
        if (fileName) seenNames.add(fileName);
        if (outputPath && seenPaths.has(outputPath)) addIssue(issues, `${clipPath}.outputPath`, 'DUPLICATE_OUTPUT_PATH', 'Output paths must be unique.');
        if (outputPath) seenPaths.add(outputPath);
        if (ordinal !== null && stableID && (clip.language === 'source' || clip.language === 'target') && fileName && isPlainObject(options)) {
          try {
            const expected = shortsExportFileName(ordinal, clip.language, isPlainObject(clip.project) && typeof clip.project.title === 'string' ? clip.project.title : '', options.format);
            if (fileName !== expected) addIssue(issues, `${clipPath}.fileName`, 'NON_DETERMINISTIC_FILENAME', `Expected deterministic filename ${expected}.`);
          } catch (_error) {
            // The option issue is reported above.
          }
        }
        if (outputPath && fileName && !(outputPath === fileName || outputPath.endsWith(`/${fileName}`) || outputPath.endsWith(`\\${fileName}`))) {
          addIssue(issues, `${clipPath}.outputPath`, 'OUTPUT_FILENAME_MISMATCH', 'Output path must end with fileName.');
        }
        if (sourceSrc && isPlainObject(clip.project)) validateProject(clip.project, `${clipPath}.project`, sourceSrc, issues);
        if (ordinal !== null && ordinal !== index + 1) addIssue(issues, `${clipPath}.ordinal`, 'INVALID_ORDER', 'Clip ordinals must be contiguous one-based values.');
      });
      const ordered = clips.filter((clip) => isPlainObject(clip));
      const sorted = [...ordered].sort((left, right) => {
        const leftLanguage = left.language === 'source' || left.language === 'target' ? left.language : '';
        const rightLanguage = right.language === 'source' || right.language === 'target' ? right.language : '';
        return compareSelection(
          { stableID: typeof left.stableID === 'string' ? left.stableID : '', language: leftLanguage },
          { stableID: typeof right.stableID === 'string' ? right.stableID : '', language: rightLanguage },
        );
      });
      if (ordered.some((clip, index) => clip !== sorted[index])) addIssue(issues, '$.clips', 'INVALID_ORDER', 'Clips must be sorted by stableID, then language.');
    }
  } catch (error) {
    addIssue(issues, '$', 'INVALID_RENDER_SNAPSHOT', error?.message || String(error));
  }
  return issues.length > 0 ? { ok: false, issues } : { ok: true };
}

function isShortsExportSnapshot(value) {
  return validateShortsExportSnapshot(value).ok;
}

function isProgressNumber(value) {
  return isFiniteNumber(value) && value >= 0 && value <= 1;
}

function integerValue(value, minimum) {
  if (!Number.isInteger(value) || typeof value !== 'number' || value < minimum) return null;
  return value;
}

function isShortsExportProgressEvent(value) {
  if (!isPlainObject(value) || !isJsonCompatibleValue(value)) return false;
  const sequence = integerValue(value.sequence, 1);
  const clipIndex = integerValue(value.clipIndex, 0);
  const completed = integerValue(value.completed, 0);
  const current = integerValue(value.current, 1);
  const total = integerValue(value.total, 1);
  return isSafeString(value.jobId)
    && sequence !== null
    && (value.kind === 'starting' || value.kind === 'progress')
    && clipIndex !== null
    && completed !== null
    && current !== null
    && total !== null
    && isProgressNumber(value.progress)
    && isSafeString(value.stage)
    && isSafeString(value.message, true);
}

function isShortsExportTerminalEvent(value) {
  if (!isPlainObject(value) || !isJsonCompatibleValue(value)) return false;
  const sequence = integerValue(value.sequence, 1);
  const total = integerValue(value.total, 1);
  const completed = integerValue(value.completed, 0);
  if (!isSafeString(value.jobId) || value.kind !== 'terminal' || sequence === null) return false;
  if (value.state !== 'succeeded' && value.state !== 'failed' && value.state !== 'cancelled') return false;
  if (!isProgressNumber(value.progress) || total === null || completed === null) return false;
  if (!Array.isArray(value.outputs) || !value.outputs.every((output) => isSafeString(output))) return false;
  if (value.failedClipIndex !== undefined && integerValue(value.failedClipIndex, 0) === null) return false;
  if (value.failedStableID !== undefined && !isSafeString(value.failedStableID)) return false;
  if (value.errorCode !== undefined && !isSafeString(value.errorCode)) return false;
  return isSafeString(value.message, true) && typeof value.cleanupComplete === 'boolean';
}

/**
 * Guard the event stream for one export session.
 *
 * The gate is deliberately independent from React/Electron so callers can
 * replace it at session entry and keep all ordering/latch rules in one place.
 */
function createShortsExportEventGate({ jobId }) {
  let activeJobId = jobId;
  let sequence = 0;
  let terminal = false;
  let percent = 0;
  let lastTerminal = null;

  const state = Object.freeze({
    get jobId() {
      return activeJobId;
    },
    get sequence() {
      return sequence;
    },
    get terminal() {
      return terminal;
    },
    get percent() {
      return percent;
    },
    get lastTerminal() {
      return lastTerminal;
    },
  });

  return {
    get state() {
      return state;
    },
    reset({ jobId: nextJobId }) {
      activeJobId = nextJobId;
      sequence = 0;
      terminal = false;
      percent = 0;
      lastTerminal = null;
    },
    accept(payload) {
      if (!payload || payload.jobId !== activeJobId || terminal) return null;
      if (!Number.isSafeInteger(payload.sequence) || payload.sequence <= sequence) return null;
      const isProgress = isShortsExportProgressEvent(payload);
      const isTerminal = isShortsExportTerminalEvent(payload);
      if (!isProgress && !isTerminal) return null;

      sequence = payload.sequence;
      percent = Math.max(percent, payload.progress);
      if (isTerminal) {
        terminal = true;
        lastTerminal = payload;
      }
      return { event: payload, percent };
    },
  };
}

if (typeof module !== 'undefined') {
  module.exports = {
    SHORTS_EXPORT_CONTRACT,
    isSafeString,
    isJsonCompatibleValue,
    deepFreeze,
    deepCloneDeepFreeze,
    shortsExportFileName,
    materializeShortsExportSnapshot,
    buildShortsExportSnapshot,
    findDuplicateOutputPaths,
    validateShortsExportSnapshot,
    isShortsExportSnapshot,
    isShortsExportProgressEvent,
    isShortsExportTerminalEvent,
    createShortsExportEventGate,
  };
}
