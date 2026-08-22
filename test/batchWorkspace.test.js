const test = require('node:test');
const assert = require('node:assert/strict');
require('tsx/cjs');
const React = require('react');
const ReactDOMServer = require('react-dom/server');
const { JSDOM } = require('jsdom');
const BATCH = '../shared/contracts/batch.ts';
const STORE = '../src/stores/batchStore.ts';
const { BatchQueueTable } = require('../src/components/BatchWorkspace.tsx');

function job(overrides = {}) {
  return {
    schemaVersion: 1,
    jobId: 'job-1',
    profileId: 'profile-1',
    sourcePath: '/audio/source.mp3',
    outputPath: '/audio/source.txt',
    state: 'pending',
    phase: 'planning',
    attempt: 0,
    maxAttempts: 3,
    progress: 0,
    configSnapshot: {},
    sourceFingerprint: null,
    outputFingerprint: null,
    lastError: null,
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z',
    startedAt: null,
    completedAt: null,
    ...overrides,
  };
}

test('Batch filters map UI vocabulary to durable job states and query projections', async () => {
  const { filterBatchJobs } = await import(STORE);
  const jobs = [
    job({ jobId: 'pending', state: 'pending' }),
    job({ jobId: 'running', state: 'running', phase: 'transcribing', sourcePath: '/audio/lecture.wav' }),
    job({ jobId: 'done', state: 'done', progress: 1 }),
    job({ jobId: 'failed', state: 'failed', lastError: 'model unavailable' }),
    job({ jobId: 'collision', state: 'blockedOutputCollision', lastError: 'output exists' }),
    job({ jobId: 'cancelled', state: 'cancelled' }),
  ];

  assert.deepEqual(filterBatchJobs(jobs, 'completed').map((item) => item.jobId), ['done']);
  assert.deepEqual(filterBatchJobs(jobs, 'collision').map((item) => item.jobId), ['collision']);
  assert.deepEqual(filterBatchJobs(jobs, 'running', 'lecture').map((item) => item.jobId), ['running']);
  assert.deepEqual(filterBatchJobs(jobs, 'failed', 'missing'), []);
  assert.equal(filterBatchJobs(jobs, 'all').length, 6);
});

test('Batch control state machine keeps pause/resume/drain deterministic', async () => {
  const { getBatchControlState, getBatchBadgeState } = await import(STORE);
  const stopped = { mode: 'stopped', activeJobId: null, badge: 'idle', updatedAt: '' };
  const running = { mode: 'running', activeJobId: 'job-1', badge: 'running', updatedAt: '' };
  const paused = { mode: 'pause-after-current', activeJobId: 'job-1', badge: 'paused', updatedAt: '' };

  assert.deepEqual(getBatchControlState(stopped), {
    canScan: true,
    canStart: true,
    canPauseAfterCurrent: false,
    canResume: false,
    canDrain: false,
  });
  assert.deepEqual(getBatchControlState(running), {
    canScan: true,
    canStart: false,
    canPauseAfterCurrent: true,
    canResume: false,
    canDrain: true,
  });
  assert.equal(getBatchControlState(paused).canResume, true);
  assert.equal(getBatchControlState(paused).canPauseAfterCurrent, false);
  assert.equal(getBatchBadgeState(stopped, [job({ state: 'failed' })]), 'failed');
});

test('Batch store uses IPC projections and does not persist queue state locally', async () => {
  const { BATCH_COMMANDS } = await import(BATCH);
  const { createBatchStore } = await import(STORE);
  const calls = [];
  const api = {
    invoke: async (method, args) => {
      calls.push({ method, args });
      if (method === BATCH_COMMANDS.listProfiles) return { profiles: [] };
      if (method === BATCH_COMMANDS.listJobs) return { jobs: [job()] };
      if (method === BATCH_COMMANDS.getState) return { mode: 'stopped', activeJobId: null, badge: 'idle', updatedAt: 'now' };
      if (method === BATCH_COMMANDS.listIssues) return { issues: [] };
      if (method === BATCH_COMMANDS.getJobDetails) return { job: job(), checkpoints: [], events: [] };
      return { ok: true };
    },
  };
  const store = createBatchStore(api);
  await store.refresh();
  assert.equal(store.getState().jobs.length, 1);
  assert.equal(store.getState().profiles.length, 0);
  await store.selectJob('job-1');
  assert.equal(store.getState().selectedDetails.job.jobId, 'job-1');
  store.setFilter('running');
  assert.equal(store.getState().filter, 'running');
  assert.equal(Object.keys(globalThis).some((key) => key.toLowerCase().includes('localstorage')), false);
  assert.ok(calls.some(({ method }) => method === BATCH_COMMANDS.listJobs));
});

test('10k-row projection renders a bounded virtual DOM window in jsdom', async () => {
  const { getVirtualRows } = await import(STORE);
  const dom = new JSDOM('<!doctype html><main id="fixture"></main>');
  const fixture = dom.window.document.querySelector('#fixture');
  const jobs = Array.from({ length: 10_000 }, (_, index) => job({ jobId: `job-${index}`, sourcePath: `/audio/${index}.mp3` }));
  const virtual = getVirtualRows(jobs, 0, 560, 58, 8);
  const markup = ReactDOMServer.renderToStaticMarkup(
    React.createElement(BatchQueueTable, { jobs, selectedJobId: null, onSelect: () => {} }),
  );
  fixture.innerHTML = markup;
  const renderedRows = fixture.querySelectorAll('[data-testid="batch-queue-row"]');

  assert.equal(jobs.length, 10_000);
  assert.equal(virtual.totalHeight, 580_000);
  assert.equal(virtual.start, 0);
  assert.equal(virtual.end, 18);
  assert.equal(renderedRows.length, 18);
  assert.ok(renderedRows.length < 40, 'virtualized DOM must stay bounded at 10k rows');

  fixture.replaceChildren();
  const scrolled = getVirtualRows(jobs, 290_000, 560, 58, 8);
  for (const item of jobs.slice(scrolled.start, scrolled.end)) {
    const row = dom.window.document.createElement('div');
    row.dataset.jobId = item.jobId;
    fixture.appendChild(row);
  }
  assert.equal(scrolled.start, 4992);
  assert.equal(scrolled.end, 5018);
  assert.equal(fixture.children.length, 26);
  dom.window.close();
});
