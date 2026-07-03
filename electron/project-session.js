'use strict';

const path = require('path');

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

function normalizeOutputFormats(outputFormats, configFormats) {
  const formats = Array.isArray(outputFormats) && outputFormats.length > 0
    ? outputFormats
    : Array.isArray(configFormats) && configFormats.length > 0
      ? configFormats
      : ['TXT'];
  return formats.map((format) => String(format || '').trim()).filter(Boolean);
}

function pickActiveTranslationVariant(chunk, activeLang) {
  const archive = chunk?.translationsByLanguage;
  if (!archive || typeof archive !== 'object') return null;
  const variants = Object.keys(archive).map((key) => archive[key]).filter(Boolean);
  if (variants.length === 0) return null;
  const norm = (value) => String(value || '').trim().toLowerCase();
  const target = norm(activeLang);
  if (target) {
    const match = variants.find((variant) => norm(variant.language) === target);
    if (match) return match;
  }
  return variants[0];
}

function restoreImportedChunk(chunk, filePath, activeLang) {
  const variant = pickActiveTranslationVariant(chunk, activeLang);
  const legacyTranslated = String(chunk?.translated || '').trim();
  const translated = legacyTranslated ? chunk.translated : (variant?.text ?? chunk?.translated ?? '');
  const translatedCues = Array.isArray(variant?.cues) && variant.cues.length > 0
    ? variant.cues
    : chunk?.translatedCues;
  return { ...chunk, filePath, translated, translatedCues };
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
  const activeTranslationLanguage = base.activeTranslationLanguage || base.targetLang;
  const chunks = Array.isArray(base.chunks)
    ? base.chunks.map((chunk, index) =>
        restoreImportedChunk(chunk, assetPath(assetMap, `chunk:${index}`) || chunk.filePath || '', activeTranslationLanguage)
      )
    : [];
  const currentIndex = resolveSessionCurrentIndex(base, chunks.length);
  const metadata = base.metadata && typeof base.metadata === 'object' ? base.metadata : {};
  const existingConfig = base.config && typeof base.config === 'object' ? base.config : {};
  const targetLang = base.targetLang || existingConfig.targetLang || activeTranslationLanguage || 'same';
  const outputFormats = normalizeOutputFormats(base.outputFormats, existingConfig.formats);
  const durationSec = firstPositiveFiniteNumber(base.durationSec, sourceMediaInfo?.durationSec, lastChunkEndSec(chunks));

  return {
    ...base,
    projectId: options.projectId || base.projectId,
    sourceFile,
    sourceMediaKind,
    originalVideoPath,
    wavPath: assetPath(assetMap, 'wavPath') || base.wavPath || '',
    sourceMediaInfo,
    targetLang,
    outputFormats,
    config: {
      date: metadata.date || existingConfig.date || '',
      location: metadata.location || existingConfig.location || '',
      lecturer: metadata.lecturer || existingConfig.lecturer || '',
      participants: metadata.participants || existingConfig.participants || '',
      targetLang,
      formats: outputFormats,
      transcriptionProvider: base.transcriptionProvider || existingConfig.transcriptionProvider || '',
      translationProvider: base.translationProvider || existingConfig.translationProvider || '',
    },
    currentIndex,
    currentChunkIndex: currentIndex,
    durationSec,
    chunks,
  };
}

module.exports = {
  normalizeImportedProjectSession,
  resolveSessionCurrentIndex,
  restoreImportedChunk,
};
