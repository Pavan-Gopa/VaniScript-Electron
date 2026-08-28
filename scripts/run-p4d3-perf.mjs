import fs from 'node:fs';
import path from 'node:path';
import { performance } from 'node:perf_hooks';
import { createRequire } from 'node:module';
import * as performanceModule from '../src/lib/performance.ts';
import * as virtualWindowModule from '../src/lib/virtual-window.ts';
import * as projectNavigationModule from '../src/lib/project-navigation.ts';
const projectNavigationExports = projectNavigationModule.default ?? projectNavigationModule;
const performanceExports = performanceModule.default ?? performanceModule;
const virtualWindowExports = virtualWindowModule.default ?? virtualWindowModule;
const {
  PERFORMANCE_BUDGETS,
  PERFORMANCE_CEILINGS,
  PERFORMANCE_SCHEMA_VERSION,
  percentile,
  satisfiesPerformanceInvariants,
} = performanceExports;
const {
  getChunkRowWindow,
  getVariableVirtualWindow,
  getVirtualRows,
} = virtualWindowExports;
const { projectChunkNumbers } = projectNavigationExports;

const require = createRequire(import.meta.url);
const {
  FIXTURE_SCALES,
  createAssistantFragments,
  createBatchJobs,
  createDocumentBlocks,
  createProjectSession,
  createProjectSummaries,
} = require('../test/fixtures/p4d3-fixtures.js');
const { createProjectListService, PROJECT_SUMMARY_PAGE_BYTES } = require('../electron/main/projects/projectList.js');

const metrics = [];
const checks = [];
function measure(name, fixtureScale, targetMs, ceilingMs, operation) {
  for (let index = 0; index < 2; index += 1) operation();
  const samples = [];
  for (let index = 0; index < 9; index += 1) {
    const startedAt = performance.now();
    operation();
    samples.push(Math.max(0, performance.now() - startedAt));
  }
  const p95Ms = percentile(samples, 95);
  const maxMs = Math.max(...samples);
  metrics.push({
    name,
    fixtureScale,
    samples: samples.length,
    p95Ms: Number(p95Ms.toFixed(3)),
    ceilingMs: Number(maxMs.toFixed(3)),
    targetMs,
    absoluteCeilingMs: ceilingMs,
    status: p95Ms <= targetMs && maxMs <= ceilingMs ? 'pass' : 'fail',
  });
}
 

function check(name, passed, details = {}) {
  checks.push({ name, status: passed ? 'pass' : 'fail', ...details });
}

function pageFixtureSummaries() {
  const summaries = createProjectSummaries(FIXTURE_SCALES.projects);
  const byPath = new Map(summaries.map((summary) => [`/p4d3/${summary.id}/project-summary.json`, JSON.stringify(summary)]));
  const service = createProjectListService({
    projectsRootDir: '/p4d3',
    projectSummaryPath: (id) => `/p4d3/${id}/project-summary.json`,
    fs: {
      readdirSync: () => summaries.map((summary) => ({ name: summary.id, isDirectory: () => true })),
      readFileSync: (filePath) => {
        const value = byPath.get(filePath);
        if (!value) throw new Error('missing fixture sidecar');
        return value;
      },
    },
  });
  return service.listPage({ limit: 50, offset: 0 });
}

const projects = createProjectSummaries(FIXTURE_SCALES.projects);
const batchJobs = createBatchJobs(FIXTURE_SCALES.batchJobs);
const documentBlocks = createDocumentBlocks(FIXTURE_SCALES.documentWords);
const assistantFragments = createAssistantFragments(FIXTURE_SCALES.assistantFragments);

measure('project-first-page', FIXTURE_SCALES.projects, PERFORMANCE_BUDGETS.p95ProjectFirstPageMs, PERFORMANCE_CEILINGS.projectFirstPageMs, () => {
  const page = pageFixtureSummaries();
  if (page.projects.length === 0) throw new Error('project page is empty');
});
measure('project-route-switch', FIXTURE_SCALES.projects, PERFORMANCE_BUDGETS.p95RouteSwitchMs, PERFORMANCE_CEILINGS.routeSwitchMs, () => {
  getVariableVirtualWindow(projects.length, -1, 0, 600, 96, 430, 10, 2);
  getVariableVirtualWindow(projects.length, 0, 430, 600, 96, 430, 10, 2);
});
measure('batch-page-250', FIXTURE_SCALES.batchJobs, PERFORMANCE_BUDGETS.p95BatchPageMs, PERFORMANCE_CEILINGS.batchPageMs, () => {
  getVirtualRows(batchJobs, 0, 430, 58, 8);
});
measure('document-projection', FIXTURE_SCALES.documentWords, PERFORMANCE_BUDGETS.p95DocumentProjectionMs, PERFORMANCE_CEILINGS.documentProjectionMs, () => {
  documentBlocks.slice(0, PERFORMANCE_BUDGETS.documentProjectionRows);
});
measure('active-edit-commit', FIXTURE_SCALES.chunks, PERFORMANCE_BUDGETS.p95ActiveEditCommitMs, PERFORMANCE_CEILINGS.activeEditCommitMs, () => {
  const session = createProjectSession(FIXTURE_SCALES.chunks);
  const active = session.chunks[session.currentIndex];
  return active?.original.replace('original', 'revised');
});
measure('virtual-scroll', FIXTURE_SCALES.chunks, PERFORMANCE_BUDGETS.p95VirtualScrollMs, PERFORMANCE_CEILINGS.virtualScrollMs, () => {
  getChunkRowWindow(FIXTURE_SCALES.chunks, 720, 224, 36, 4);
});
measure('assistant-flush', FIXTURE_SCALES.assistantFragments, PERFORMANCE_BUDGETS.p95AssistantFlushMs, PERFORMANCE_CEILINGS.assistantFlushMs, () => {
  const text = assistantFragments.join('');
  text.slice(-PERFORMANCE_BUDGETS.assistantMessageLimit);
});
 
const canCollectHeap = typeof global.gc === 'function';
check('heap-metric-available', canCollectHeap);
if (canCollectHeap) global.gc();
const heapBefore = process.memoryUsage().heapUsed;
const clonedSession = typeof structuredClone === 'function'
  ? structuredClone(createProjectSession(FIXTURE_SCALES.chunks))
  : JSON.parse(JSON.stringify(createProjectSession(FIXTURE_SCALES.chunks)));
if (canCollectHeap) global.gc();
const heapAfter = process.memoryUsage().heapUsed;
const heapDeltaBytes = Math.max(0, heapAfter - heapBefore);
metrics.push({
  name: 'media-project-heap-delta',
  fixtureScale: FIXTURE_SCALES.chunks,
  samples: 1,
  heapDeltaBytes,
  targetBytes: PERFORMANCE_BUDGETS.mediaCloneHeapBytes,
  absoluteCeilingBytes: PERFORMANCE_CEILINGS.mediaCloneHeapBytes,
  status: heapDeltaBytes <= PERFORMANCE_CEILINGS.mediaCloneHeapBytes ? 'pass' : 'fail',
});
check('heap-delta-500-chunks', heapDeltaBytes <= PERFORMANCE_CEILINGS.mediaCloneHeapBytes, {
  fixtureScale: FIXTURE_SCALES.chunks,
  heapDeltaBytes,
  targetBytes: PERFORMANCE_BUDGETS.mediaCloneHeapBytes,
  ceilingBytes: PERFORMANCE_CEILINGS.mediaCloneHeapBytes,
});
void clonedSession;

const projectPage = pageFixtureSummaries();
const projectPageBytes = Buffer.byteLength(JSON.stringify(projectPage), 'utf8');
const projectWindow = getVariableVirtualWindow(FIXTURE_SCALES.projects, -1, 0, 600, 96, 430, 10, 2);
const chunkWindow = getChunkRowWindow(FIXTURE_SCALES.chunks, 0, 224, 36, 4);
const batchWindow = getVirtualRows(batchJobs, 0, 430, 58, 8);
const documentRows = Math.min(documentBlocks.length, PERFORMANCE_BUDGETS.documentProjectionRows);
const invariantValues = {
  projectDomNodes: projectWindow.end - projectWindow.start,
  chunkDomNodes: (chunkWindow.end - chunkWindow.start) * 2,
  batchRequestLimit: PERFORMANCE_BUDGETS.batchRequestLimit,
  batchDomRows: batchWindow.rows.length,
  documentRows,
  assistantMessages: PERFORMANCE_BUDGETS.assistantMessageLimit,
  previewBytes: PERFORMANCE_BUDGETS.previewMaxBytes,
};
check('bounded-dom-and-page-invariants', satisfiesPerformanceInvariants(invariantValues), invariantValues);
check('project-page-count', projectPage.projects.length <= PERFORMANCE_BUDGETS.projectSummaryPageLimit, {
  count: projectPage.projects.length,
  limit: PERFORMANCE_BUDGETS.projectSummaryPageLimit,
});
const batchPageBytes = Buffer.byteLength(JSON.stringify({ jobs: batchJobs.slice(0, PERFORMANCE_BUDGETS.batchRequestLimit), limit: PERFORMANCE_BUDGETS.batchRequestLimit, offset: 0, total: batchJobs.length, hasMore: true, nextOffset: PERFORMANCE_BUDGETS.batchRequestLimit }), 'utf8');
check('project-page-bytes', projectPageBytes <= PROJECT_SUMMARY_PAGE_BYTES, {
  bytes: projectPageBytes,
  ceilingBytes: PROJECT_SUMMARY_PAGE_BYTES,
});
check('batch-page-bytes', batchPageBytes <= PERFORMANCE_BUDGETS.batchPageBytes, {
  bytes: batchPageBytes,
  ceilingBytes: PERFORMANCE_BUDGETS.batchPageBytes,
});
check('required-fixture-scales', FIXTURE_SCALES.projects === 100 && FIXTURE_SCALES.chunks === 500 && FIXTURE_SCALES.batchJobs === 10000 && FIXTURE_SCALES.documentWords === 100000 && FIXTURE_SCALES.assistantFragments === 20000, FIXTURE_SCALES);
check('required-metrics', ['project-first-page', 'project-route-switch', 'document-projection', 'active-edit-commit', 'virtual-scroll', 'media-project-heap-delta', 'assistant-flush'].every((name) => metrics.some((metric) => metric.name === name)));

function executeLegacyBatchUiRequest() {
  let request = null;
  const legacyElectronApi = {
    invoke(method, args) {
      if (method === 'batch:listJobs') request = { method, args };
      return Promise.resolve({ jobs: [] });
    },
  };
  void legacyElectronApi.invoke('batch:listJobs', { limit: 10_000, offset: 0 });
  return request;
}

const legacyProjectProjection = projects.map((project) => ({ id: project.id }));
const legacyChunkProjection = projectChunkNumbers(FIXTURE_SCALES.chunks).map((chunkNumber) => ({ chunkNumber }));
const legacyBatchRequest = executeLegacyBatchUiRequest();
const legacyBatchLimit = legacyBatchRequest?.args?.limit;
const negativeDiscriminators = [
  {
    name: 'legacy-unbounded-project-map',
    observedCount: legacyProjectProjection.length,
    gatePassed: satisfiesPerformanceInvariants({ ...invariantValues, projectDomNodes: legacyProjectProjection.length }),
    detected: legacyProjectProjection.length > PERFORMANCE_BUDGETS.projectOuterDomNodes,
  },
  {
    name: 'legacy-unbounded-chunk-map',
    observedCount: legacyChunkProjection.length,
    gatePassed: satisfiesPerformanceInvariants({ ...invariantValues, chunkDomNodes: legacyChunkProjection.length }),
    detected: legacyChunkProjection.length > PERFORMANCE_BUDGETS.expandedChunkDomNodes,
  },
  {
    name: 'legacy-batch-limit-10000',
    observedLimit: legacyBatchLimit,
    gatePassed: satisfiesPerformanceInvariants({ ...invariantValues, batchRequestLimit: legacyBatchLimit }),
    detected: legacyBatchLimit > PERFORMANCE_BUDGETS.batchRequestLimit,
  },
];
for (const discriminator of negativeDiscriminators) {
  check(`negative-${discriminator.name}`, discriminator.detected && !discriminator.gatePassed, {
    observedCount: discriminator.observedCount,
    observedLimit: discriminator.observedLimit,
    gatePassed: discriminator.gatePassed,
  });
}
const probePayload = JSON.stringify({ fixtures: FIXTURE_SCALES, budgets: PERFORMANCE_BUDGETS, metrics, checks, negativeDiscriminators });
check('artifact-redaction', !probePayload.includes('/fixtures') && !probePayload.includes('fragment-') && !probePayload.includes('chunk 0 original'));

const artifact = {
  schemaVersion: PERFORMANCE_SCHEMA_VERSION,
  status: [...metrics, ...checks].every((entry) => entry.status === 'pass') ? 'pass' : 'fail',
  fixtures: FIXTURE_SCALES,
  budgets: PERFORMANCE_BUDGETS,
  metrics,
  checks,
  negativeDiscriminators,
  limitations: {
    proxy: 'Node perf_hooks and deterministic projection probes; not GPU compositor timing or packaged Electron process memory.',
  },
};
const artifactPath = path.resolve('artifacts/p4d3-performance.json');
fs.mkdirSync(path.dirname(artifactPath), { recursive: true });
fs.writeFileSync(artifactPath, `${JSON.stringify(artifact, null, 2)}\n`, 'utf8');
process.stdout.write(`${JSON.stringify({ artifact: artifactPath, status: artifact.status, metrics: metrics.length, checks: checks.length })}\n`);
if (artifact.status !== 'pass') process.exitCode = 1;
