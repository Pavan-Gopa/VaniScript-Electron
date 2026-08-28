'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const {
  PROJECT_SUMMARY_PAGE_BYTES,
  createProjectListService,
  compactProjectSummary,
} = require('../electron/main/projects/projectList');

function fixtureSummary(index) {
  const id = `project-${String(index).padStart(3, '0')}`;
  return compactProjectSummary({
    id,
    name: `Project ${index}`,
    sourceFileName: `source-${index}.m4a`,
    updatedAt: `2026-02-${String((index % 28) + 1).padStart(2, '0')}T00:00:00.000Z`,
    createdAt: '2026-01-01T00:00:00.000Z',
    currentIndex: index % 4,
    totalChunks: 4,
    approvedChunks: index % 4,
    targetLang: 'same',
    sourceMediaInfo: { kind: 'audio', fileName: `source-${index}.m4a`, filePath: `/tmp/source-${index}.m4a` },
  });
}

test('project list pages are bounded, deterministic, and sidecar-only in steady state', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'p4d3-projects-'));
  try {
    for (let index = 0; index < 100; index += 1) {
      const id = `project-${String(index).padStart(3, '0')}`;
      const directory = path.join(root, id);
      fs.mkdirSync(directory, { recursive: true });
      fs.writeFileSync(path.join(directory, 'project-summary.json'), JSON.stringify(fixtureSummary(index)), 'utf8');
    }
    const service = createProjectListService({ projectsRootDir: root });
    const first = service.listPage({ limit: 500, offset: 0 });
    assert.equal(first.projects.length, 50);
    assert.equal(first.limit, 50);
    assert.equal(first.offset, 0);
    assert.equal(first.total, 100);
    assert.equal(first.hasMore, true);
    assert.equal(first.nextOffset, 50);
    assert.ok(Buffer.byteLength(JSON.stringify({ ok: true, ...first }), 'utf8') <= PROJECT_SUMMARY_PAGE_BYTES);
    assert.equal(JSON.stringify(first).includes('session'), false);
    assert.equal(JSON.stringify(first).includes('chunks'), false);

    const second = service.listPage({ limit: 50, offset: first.nextOffset });
    assert.equal(second.projects.length, 50);
    assert.equal(second.hasMore, false);
    assert.equal(second.nextOffset, null);
    assert.equal(new Set([...first.projects, ...second.projects].map((project) => project.id)).size, 100);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('missing or invalid sidecars repair from authoritative project JSON', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'p4d3-repair-'));
  try {
    const id = 'project-repair';
    const directory = path.join(root, id);
    fs.mkdirSync(directory, { recursive: true });
    const project = { id, session: { sourceFileName: 'repair.m4a', chunks: [{ original: 'private text' }] } };
    fs.writeFileSync(path.join(directory, 'project.json'), JSON.stringify(project), 'utf8');
    fs.writeFileSync(path.join(directory, 'project-summary.json'), JSON.stringify({ id, session: project.session }), 'utf8');
    const service = createProjectListService({
      projectsRootDir: root,
      projectSummary: () => fixtureSummary(7) && compactProjectSummary({ ...fixtureSummary(7), id }),
    });
    const page = service.listPage({ limit: 1, offset: 0 });
    assert.equal(page.projects.length, 1);
    assert.equal(page.projects[0].id, id);
    const repaired = JSON.parse(fs.readFileSync(path.join(directory, 'project-summary.json'), 'utf8'));
    assert.equal(repaired.id, id);
    assert.equal('session' in repaired, false);
    assert.equal(JSON.stringify(repaired).includes('private text'), false);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});
