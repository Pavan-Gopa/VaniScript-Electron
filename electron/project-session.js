'use strict';

const path = require('path');

// Single shared implementation of the multi-language contract (display/key
// normalization, usability policy, archive re-keying, active resolution,
// eager projection). Main and the renderer both use this module — no
// duplicate normalization here.
const mediaTranslations = require('../shared/media-translations');

const AUDIO_EXTENSIONS = new Set(['mp3', 'wav', 'm4a', 'flac', 'ogg', 'aac', 'wma']);
const VIDEO_EXTENSIONS = new Set(['mp4', 'mov', 'mkv', 'webm']);

function extension(filePath) {
  return String(filePath || '').split('.').pop()?.toLowerCase() || '';
}

function inferSourceMediaKind(filePath, sourceMediaInfo) {
  if (sourceMediaInfo?.kind === 'video' || sourceMediaInfo?.kind === 'audio') {
    return sourceMediaInfo.kind;
  }
  const ext = extension(filePath);
  if (VIDEO_EXTENSIONS.has(ext)) return 'video';
  if (AUDIO_EXTENSIONS.has(ext)) return 'audio';
  return 'unknown';
}

function firstFiniteNumber(...values) {
  for (const value of values) {
    const number = Number(value);
    if (Number.isFinite(number)) return number;
  }
  return 0;
}

function firstPositiveFiniteNumber(...values) {
  for (const value of values) {
    const number = Number(value);
    if (Number.isFinite(number) && number > 0) return number;
  }
  return 0;
}

function clampSessionIndex(index, totalChunks) {
  const total = Math.max(0, Math.floor(Number(totalChunks) || 0));
  if (total === 0) return 0;
  const floor = Math.floor(firstFiniteNumber(index));
  return Math.max(0, Math.min(total - 1, floor));
}

function resolveSessionCurrentIndex(session, totalChunks = session?.chunks?.length ?? 0) {
  return clampSessionIndex(firstFiniteNumber(session?.currentIndex, session?.currentChunkIndex), totalChunks);
}

function contiguousApprovedCount(chunks) {
  let count = 0;
  for (const chunk of chunks) {
    if (!chunk?.approved) break;
    count += 1;
  }
  return count;
}

function resolveSessionReviewProgressIndex(session, totalChunks = session?.chunks?.length ?? 0) {
  const total = Math.max(0, Math.floor(Number(totalChunks) || 0));
  if (total === 0) return 0;
  const chunks = Array.isArray(session?.chunks) ? session.chunks.slice(0, total) : [];
  const nextAfterApproved = Math.min(total - 1, contiguousApprovedCount(chunks));
  return Math.max(resolveSessionCurrentIndex(session, total), nextAfterApproved);
}

function normalizeOutputFormats(outputFormats, configFormats) {
  const formats = Array.isArray(outputFormats) && outputFormats.length > 0
    ? outputFormats
    : Array.isArray(configFormats) && configFormats.length > 0
      ? configFormats
      : ['TXT'];
  return formats.map((format) => String(format || '').trim()).filter(Boolean);
}

function assetPath(assetMap, key) {
  return assetMap && typeof assetMap.get === 'function' ? assetMap.get(key) : undefined;
}

function normalizeSourceMediaInfo(sourceMediaInfo, mediaPath, sourceMediaKind) {
  if (!sourceMediaInfo || typeof sourceMediaInfo !== 'object') return sourceMediaInfo || null;
  const next = { ...sourceMediaInfo };
  if (mediaPath) {
    next.filePath = mediaPath;
    next.fileName = next.fileName || path.basename(mediaPath);
  }
  if (!next.kind || next.kind === 'unknown') {
    next.kind = sourceMediaKind;
  }
  return next;
}

function lastChunkEndSec(chunks) {
  const last = chunks[chunks.length - 1];
  const endSec = Number(last?.endSec);
  return Number.isFinite(endSec) && endSec > 0 ? endSec : 0;
}

function normalizeImportedProjectSession(session, options = {}) {
  const base = session && typeof session === 'object' ? session : {};
  const assetMap = options.assetMap;
  const sourceFile = assetPath(assetMap, 'sourceFile') || base.sourceFile || '';
  const sourceMediaKind = base.sourceMediaKind && base.sourceMediaKind !== 'unknown'
    ? base.sourceMediaKind
    : inferSourceMediaKind(sourceFile || base.sourceMediaInfo?.filePath, base.sourceMediaInfo);
  const originalVideoPath = assetPath(assetMap, 'originalVideoPath')
    || base.originalVideoPath
    || (sourceMediaKind === 'video' ? sourceFile : '');
  const mediaInfoPath = sourceMediaKind === 'video' ? (originalVideoPath || sourceFile) : sourceFile;
  const sourceMediaInfo = normalizeSourceMediaInfo(base.sourceMediaInfo, mediaInfoPath, sourceMediaKind);
  const metadata = base.metadata && typeof base.metadata === 'object' ? base.metadata : {};
  const existingConfig = base.config && typeof base.config === 'object' ? base.config : {};
  const rawChunks = Array.isArray(base.chunks) ? base.chunks : [];
  const currentIndex = resolveSessionCurrentIndex(base, rawChunks.length);
  // Restoration is strictly non-translation mechanics: re-point assets and
  // keep every other chunk field verbatim. Active resolution, legacy seeding,
  // and eager projection belong to the single shared pass below.
  const restoredChunks = rawChunks.map((chunk, index) => ({
    ...chunk,
    filePath: assetPath(assetMap, `chunk:${index}`) || chunk.filePath || '',
  }));
  const outputFormats = normalizeOutputFormats(base.outputFormats, existingConfig.formats);
  const durationSec = firstPositiveFiniteNumber(base.durationSec, sourceMediaInfo?.durationSec, lastChunkEndSec(restoredChunks));

  // The one canonical translation pass over the assembled session, with
  // base.targetLang and config.targetLang unmasked: the shared normalizer
  // owns precedence (active -> selected -> targetLang -> config.targetLang ->
  // first archive), seeding/re-keying/projection, the available-language
  // union, and target synchronization.
  const normalized = mediaTranslations.normalizeMediaSessionTranslations({
    ...base,
    ...(options.projectId || base.projectId
      ? { projectId: options.projectId || base.projectId }
      : {}),
    sourceFile,
    sourceMediaKind,
    originalVideoPath,
    wavPath: assetPath(assetMap, 'wavPath') || base.wavPath || '',
    sourceMediaInfo,
    targetLang: base.targetLang,
    outputFormats,
    config: {
      date: metadata.date || existingConfig.date || '',
      location: metadata.location || existingConfig.location || '',
      lecturer: metadata.lecturer || existingConfig.lecturer || '',
      participants: metadata.participants || existingConfig.participants || '',
      targetLang: existingConfig.targetLang,
      formats: outputFormats,
      transcriptionProvider: base.transcriptionProvider || existingConfig.transcriptionProvider || '',
      translationProvider: base.translationProvider || existingConfig.translationProvider || '',
    },
    currentIndex,
    currentChunkIndex: currentIndex,
    durationSec,
    chunks: restoredChunks,
  });

  // Compatibility default only: when nothing real resolved anywhere, restore
  // the historical untranslated sentinel without creating or selecting any
  // variant. Language resolution is never restated here.
  if (!normalized.activeTranslationLanguage) {
    const config = normalized.config && typeof normalized.config === 'object' ? normalized.config : {};
    if (!mediaTranslations.isRealTranslationLanguage(normalized.targetLang)) normalized.targetLang = 'same';
    if (!mediaTranslations.isRealTranslationLanguage(config.targetLang)) config.targetLang = 'same';
    normalized.config = config;
  }
  return normalized;
}

module.exports = {
  normalizeImportedProjectSession,
  resolveSessionCurrentIndex,
  resolveSessionReviewProgressIndex,
};
