'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const test = require('node:test');

const root = path.resolve(__dirname, '..');
const artifactPath = path.join(root, 'artifacts', 'p4d3-performance.json');

test('P4D3 performance command emits bounded artifact and required probes', () => {
  const result = spawnSync(process.execPath, ['--expose-gc', '--import', 'tsx', 'scripts/run-p4d3-perf.mjs'], {
    cwd: root,
    encoding: 'utf8',
    env: { ...process.env },
  });
  assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`);
  assert.equal(fs.existsSync(artifactPath), true);
  const artifact = JSON.parse(fs.readFileSync(artifactPath, 'utf8'));
  assert.equal(artifact.status, 'pass');
  assert.deepEqual(artifact.fixtures, {
    projects: 100,
    chunks: 500,
    batchJobs: 10000,
    documentWords: 100000,
    assistantFragments: 20000,
  });
  assert.ok(artifact.metrics.length >= 7);
  assert.ok(artifact.checks.every((entry) => entry.status === 'pass'));
  const serialized = JSON.stringify(artifact);
  assert.equal(serialized.includes('/fixtures'), false);
  assert.equal(serialized.includes('fragment-'), false);
  assert.equal(serialized.includes('chunk 0 original'), false);
});

test('P4D3 negative discriminators execute forbidden paths and prove gate rejection', () => {
  const result = spawnSync(process.execPath, ['--expose-gc', '--import', 'tsx', 'scripts/run-p4d3-perf.mjs'], {
    cwd: root,
    encoding: 'utf8',
    env: { ...process.env },
  });
  assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`);
  const artifact = JSON.parse(fs.readFileSync(artifactPath, 'utf8'));
  const discriminators = new Map(artifact.negativeDiscriminators.map((entry) => [entry.name, entry]));
  assert.equal(discriminators.get('legacy-unbounded-project-map').observedCount, 100);
  assert.equal(discriminators.get('legacy-unbounded-chunk-map').observedCount, 500);
  assert.equal(discriminators.get('legacy-batch-limit-10000').observedLimit, 10_000);
  for (const entry of discriminators.values()) assert.equal(entry.gatePassed, false);
  assert.match(artifact.limitations.proxy, /Node perf_hooks/);
});
