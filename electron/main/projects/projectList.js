'use strict';

const nodeFs = require('node:fs');
const nodePath = require('node:path');

const PROJECT_SUMMARY_SCHEMA_VERSION = 1;
const PROJECT_SUMMARY_FILENAME = 'project-summary.json';
const PROJECT_SUMMARY_PAGE_LIMIT = 50;
const PROJECT_SUMMARY_PAGE_BYTES = 256 * 1024;
const SUMMARY_STRING_LIMIT = 2048;

const SUMMARY_KEYS = new Set([
  'schemaVersion',
  'id',
  'name',
  'sourceFileName',
  'updatedAt',
  'createdAt',
  'currentIndex',
  'totalChunks',
  'approvedChunks',
  'targetLang',
  'sourceMediaInfo',
]);
const MEDIA_KEYS = new Set([
  'originalURL',
  'filePath',
  'fileName',
  'title',
  'kind',
  'durationSec',
  'fileSizeBytes',
  'width',
  'height',
  'frameRate',
  'videoCodec',
  'audioCodec',
  'container',
  'writingApplication',
  'overallBitrateBps',
  'videoBitrateBps',
  'audioBitrateBps',
  'audioSampleRateHz',
  'audioChannelCount',
  'importedAt',
]);

function isRecord(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function boundedString(value, limit = SUMMARY_STRING_LIMIT) {
  return typeof value === 'string' ? value.slice(0, limit) : '';
}

function compactMediaInfo(value) {
  if (!isRecord(value)) return null;
  const result = {};
  for (const key of MEDIA_KEYS) {
    const item = value[key];
    if (typeof item === 'string') result[key] = boundedString(item, key === 'filePath' || key === 'originalURL' ? 1024 : SUMMARY_STRING_LIMIT);
    else if (typeof item === 'number' && Number.isFinite(item)) result[key] = item;
  }
  return Object.keys(result).length > 0 ? result : null;
}

function compactProjectSummary(summary) {
  if (!isRecord(summary)) return null;
  const result = {
    schemaVersion: PROJECT_SUMMARY_SCHEMA_VERSION,
    id: boundedString(summary.id),
    name: boundedString(summary.name),
    sourceFileName: boundedString(summary.sourceFileName),
    updatedAt: boundedString(summary.updatedAt),
    createdAt: boundedString(summary.createdAt),
    currentIndex: Number.isInteger(summary.currentIndex) ? Math.max(0, summary.currentIndex) : 0,
    totalChunks: Number.isInteger(summary.totalChunks) ? Math.max(0, summary.totalChunks) : 0,
    approvedChunks: Number.isInteger(summary.approvedChunks) ? Math.max(0, summary.approvedChunks) : 0,
    targetLang: boundedString(summary.targetLang),
    sourceMediaInfo: compactMediaInfo(summary.sourceMediaInfo),
  };
  return result.id ? result : null;
}

function validateProjectSummary(value, expectedId) {
  if (!isRecord(value)) return null;
  if (Object.keys(value).some((key) => !SUMMARY_KEYS.has(key))) return null;
  const summary = compactProjectSummary(value);
  if (!summary || summary.id !== expectedId || value.schemaVersion !== PROJECT_SUMMARY_SCHEMA_VERSION) return null;
  if (summary.totalChunks < summary.currentIndex) return null;
  if (summary.approvedChunks > summary.totalChunks) return null;
  if (summary.sourceMediaInfo && summary.sourceMediaInfo.kind !== 'audio' && summary.sourceMediaInfo.kind !== 'video') return null;
  return summary;
}

function normalizePageOptions(options) {
  if (options === undefined || options === null) return { limit: PROJECT_SUMMARY_PAGE_LIMIT, offset: 0 };
  if (!isRecord(options)) throw new TypeError('project list options must be an object.');
  const rawLimit = options.limit;
  const rawOffset = options.offset;
  const limit = rawLimit === undefined
    ? PROJECT_SUMMARY_PAGE_LIMIT
    : Number.isInteger(rawLimit)
      ? Math.min(PROJECT_SUMMARY_PAGE_LIMIT, Math.max(1, rawLimit))
      : PROJECT_SUMMARY_PAGE_LIMIT;
  const offset = rawOffset === undefined
    ? 0
    : Number.isInteger(rawOffset)
      ? Math.max(0, rawOffset)
      : 0;
  return { limit, offset };
}

function sortedSummaries(summaries) {
  return [...summaries].sort((left, right) => {
    const byDate = String(right.updatedAt).localeCompare(String(left.updatedAt));
    return byDate || String(right.id).localeCompare(String(left.id));
  });
}

function pageByteLength(page) {
  return Buffer.byteLength(JSON.stringify({ ok: true, ...page }), 'utf8');
}

function createProjectListService(options = {}) {
  if (!isRecord(options)) throw new TypeError('project list service options must be an object.');
  const io = { ...nodeFs, ...(isRecord(options.fs) ? options.fs : {}) };
  const rootOption = options.projectsRootDir;
  if (typeof rootOption !== 'string' && typeof rootOption !== 'function') {
    throw new TypeError('projectsRootDir must be an absolute path or resolver function.');
  }
  const resolveRoot = () => {
    const root = typeof rootOption === 'function' ? rootOption() : rootOption;
    if (typeof root !== 'string' || !nodePath.isAbsolute(root)) throw new TypeError('projectsRootDir must resolve to an absolute path.');
    return root;
  };
  const resolveProjectJson = typeof options.projectJsonPath === 'function'
    ? options.projectJsonPath
    : (id) => nodePath.join(resolveRoot(), id, 'project.json');
  const resolveSummaryJson = typeof options.projectSummaryPath === 'function'
    ? options.projectSummaryPath
    : (id) => nodePath.join(resolveRoot(), id, PROJECT_SUMMARY_FILENAME);
  const readAuthoritative = typeof options.readProject === 'function'
    ? options.readProject
    : (id) => JSON.parse(io.readFileSync(resolveProjectJson(id), 'utf8'));
  const summarize = typeof options.projectSummary === 'function'
    ? options.projectSummary
    : (project) => project;

  function projectIds() {
    const entries = io.readdirSync(resolveRoot(), { withFileTypes: true });
    return entries
      .filter((entry) => typeof entry === 'string' || entry?.isDirectory?.())
      .map((entry) => typeof entry === 'string' ? entry : entry?.name)
      .filter((id) => typeof id === 'string' && id.length > 0 && !id.startsWith('.') && id !== '..' && id !== '.');
  }

  function readSummary(id) {
    try {
      const parsed = JSON.parse(io.readFileSync(resolveSummaryJson(id), 'utf8'));
      return validateProjectSummary(parsed, id);
    } catch {
      return null;
    }
  }

  function writeSummaryFile(project) {
    const raw = summarize(project);
    const summary = compactProjectSummary(raw);
    if (!summary) throw new TypeError('project summary is invalid.');
    const filePath = resolveSummaryJson(summary.id);
    const directory = nodePath.dirname(filePath);
    io.mkdirSync(directory, { recursive: true });
    const temporary = `${filePath}.tmp-${process.pid}-${Date.now()}-${Math.random().toString(16).slice(2)}`;
    const payload = JSON.stringify(summary, null, 2);
    try {
      io.writeFileSync(temporary, payload, 'utf8');
      io.renameSync(temporary, filePath);
    } catch (error) {
      try { io.rmSync(temporary, { force: true }); } catch { /* preserve original failure */ }
      throw error;
    }
    return summary;
  }

  function collectSummaries() {
    const summaries = [];
    for (const id of projectIds()) {
      let summary = readSummary(id);
      if (!summary) {
        try {
          const project = readAuthoritative(id);
          summary = compactProjectSummary(summarize(project));
          if (summary) writeSummaryFile(project);
        } catch {
          summary = null;
        }
      }
      if (summary) summaries.push(summary);
    }
    return sortedSummaries(summaries);
  }

  function listPage(optionsArg) {
    const { limit, offset } = normalizePageOptions(optionsArg);
    const all = collectSummaries();
    const requested = all.slice(offset, offset + limit);
    const projects = [];
    for (const summary of requested) {
      const candidate = [...projects, summary];
      const hasMore = offset + candidate.length < all.length;
      const page = {
        projects: candidate,
        limit,
        offset,
        total: all.length,
        hasMore,
        nextOffset: hasMore ? offset + candidate.length : null,
      };
      if (pageByteLength(page) > PROJECT_SUMMARY_PAGE_BYTES) break;
      projects.push(summary);
    }
    const hasMore = offset + projects.length < all.length;
    return {
      projects,
      limit,
      offset,
      total: all.length,
      hasMore,
      nextOffset: hasMore ? offset + projects.length : null,
    };
  }

  return {
    listPage,
    writeSummaryFile,
    readSummary,
    collectSummaries,
  };
}

module.exports = {
  PROJECT_SUMMARY_SCHEMA_VERSION,
  PROJECT_SUMMARY_FILENAME,
  PROJECT_SUMMARY_PAGE_LIMIT,
  PROJECT_SUMMARY_PAGE_BYTES,
  compactProjectSummary,
  validateProjectSummary,
  createProjectListService,
};
