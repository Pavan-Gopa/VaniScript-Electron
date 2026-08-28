'use strict';

const FIXTURE_SCALES = Object.freeze({
  projects: 100,
  chunks: 500,
  batchJobs: 10000,
  documentWords: 100000,
  assistantFragments: 20000,
});

function createProjectSummary(index) {
  const id = `project-${String(index).padStart(4, '0')}`;
  return {
    schemaVersion: 1,
    id,
    name: `Project ${index}`,
    sourceFileName: `recording-${index}.m4a`,
    updatedAt: `2026-01-${String((index % 28) + 1).padStart(2, '0')}T00:00:00.000Z`,
    createdAt: '2026-01-01T00:00:00.000Z',
    currentIndex: index % FIXTURE_SCALES.chunks,
    totalChunks: FIXTURE_SCALES.chunks,
    approvedChunks: Math.floor(index % 17),
    targetLang: 'same',
    sourceMediaInfo: {
      kind: index % 2 === 0 ? 'audio' : 'video',
      fileName: `recording-${index}.m4a`,
      filePath: `/fixtures/recording-${index}.m4a`,
      durationSec: 600,
      fileSizeBytes: 1024 * 1024,
      container: 'm4a',
    },
  };
}

function createProjectSummaries(count = FIXTURE_SCALES.projects) {
  return Array.from({ length: Math.max(0, Math.floor(count)) }, (_, index) => createProjectSummary(index));
}

function createChunks(count = FIXTURE_SCALES.chunks) {
  return Array.from({ length: Math.max(0, Math.floor(count)) }, (_, index) => ({
    index,
    original: `chunk ${index} original text`,
    translated: index % 3 === 0 ? `chunk ${index} translated text` : '',
    approved: index % 5 === 0,
  }));
}

function createBatchJobs(count = FIXTURE_SCALES.batchJobs) {
  return Array.from({ length: Math.max(0, Math.floor(count)) }, (_, index) => ({
    jobId: `job-${String(index).padStart(5, '0')}`,
    sourcePath: `/fixtures/input-${index % 100}.m4a`,
    outputPath: `/fixtures/output-${index % 100}.json`,
    state: index % 11 === 0 ? 'done' : 'pending',
    phase: index % 11 === 0 ? 'complete' : 'queued',
    lastError: '',
  }));
}

function createDocumentBlocks(wordCount = FIXTURE_SCALES.documentWords) {
  const count = Math.max(0, Math.floor(wordCount));
  const blocks = [];
  for (let index = 0; index < count; index += 10) {
    blocks.push({ index: blocks.length, text: `word-${index} word-${index + 1} word-${index + 2} word-${index + 3} word-${index + 4} word-${index + 5} word-${index + 6} word-${index + 7} word-${index + 8} word-${index + 9}` });
  }
  return blocks;
}

function createAssistantFragments(count = FIXTURE_SCALES.assistantFragments) {
  return Array.from({ length: Math.max(0, Math.floor(count)) }, (_, index) => `fragment-${index} `);
}

function createProjectSession(chunkCount = FIXTURE_SCALES.chunks) {
  return {
    projectId: 'fixture-project',
    sourceFileName: 'fixture.m4a',
    currentIndex: Math.max(0, Math.floor(chunkCount) - 1),
    chunks: createChunks(chunkCount),
  };
}

module.exports = {
  FIXTURE_SCALES,
  createProjectSummary,
  createProjectSummaries,
  createChunks,
  createBatchJobs,
  createDocumentBlocks,
  createAssistantFragments,
  createProjectSession,
};
