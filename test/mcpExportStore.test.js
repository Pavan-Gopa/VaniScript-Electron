'use strict';

/**
 * P3E.D3-S4-A coverage for the protected MCP export store: unique sanitized
 * directories under the exports root, projections that never leak absolute
 * paths, reveal guards for unknown/empty exports, and atomic writes that
 * leave no partial finals or temp residue behind.
 */

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const fsp = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');

const {
  EXPORT_STORE_ERROR_CODES,
  McpExportStoreError,
  createMcpExportStore,
} = require('../electron/main/projects/mcpExportStore.js');

const FIXED_NOW = '2026-08-24T00:00:00.000Z';

function makeRoot(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'vaniscript-mcp-exports-'));
  t.after(() => {
    fs.rmSync(root, { recursive: true, force: true });
  });
  return root;
}

function makeStore(t, root, overrides = {}) {
  return createMcpExportStore({
    exportsRoot: root,
    now: () => FIXED_NOW,
    ...overrides,
  });
}

test('makeDirectory creates unique sanitized directories under the exports root', async (t) => {
  const root = makeRoot(t);
  const store = makeStore(t, root);
  const first = await store.makeDirectory('My Report: *Final*?');
  assert.match(path.basename(first.dir), /^My-Report-Final-[0-9a-f]{8}$/);
  assert.match(first.id, /^[0-9a-f-]{36}$/);
  assert.ok(fs.existsSync(first.dir));

  const second = await store.makeDirectory('My Report: *Final*?');
  assert.notEqual(second.id, first.id);
  assert.notEqual(second.dir, first.dir);

  const hostile = await store.makeDirectory('///***');
  assert.match(path.basename(hostile.dir), /^VaniScript-[0-9a-f]{8}$/);
});

test('exportsRoot accepts a lazy resolver function', async (t) => {
  const root = makeRoot(t);
  const store = createMcpExportStore({ exportsRoot: () => root, now: () => FIXED_NOW });
  const made = await store.makeDirectory('lazy');
  assert.ok(fs.statSync(made.dir).isDirectory());
});

test('register returns the public projection and keeps absolute paths internal', async (t) => {
  const root = makeRoot(t);
  const store = makeStore(t, root);
  const { id, dir } = await store.makeDirectory('notes');
  const destPath = path.join(dir, 'notes.txt');
  await store.writeFile(destPath, 'hello export');
  assert.deepEqual(fs.readdirSync(dir), ['notes.txt']);

  const projection = await store.register(id, [destPath]);
  assert.deepEqual(projection, {
    exportId: id,
    files: [{ fileName: 'notes.txt', sizeBytes: Buffer.byteLength('hello export') }],
    fileCount: 1,
  });
  assert.ok(!JSON.stringify(projection).includes(root), 'projection must not contain absolute paths');

  const record = await store.reveal(id);
  assert.deepEqual(record.files, [destPath]);
  assert.equal(record.createdAt, FIXED_NOW);
});

test('fileSize reports stat sizes and falls back safely', async (t) => {
  const root = makeRoot(t);
  const store = makeStore(t, root);
  const filePath = path.join(root, 'present.txt');
  await fsp.writeFile(filePath, '12345', 'utf8');
  assert.equal(await store.fileSize(filePath), 5);
  assert.equal(await store.fileSize(path.join(root, 'absent.txt')), null);

  const { id, dir } = await store.makeDirectory('ghost');
  const missingInside = path.join(dir, 'ghost.txt');
  const projection = await store.register(id, [missingInside]);
  assert.deepEqual(projection.files, [{ fileName: 'ghost.txt', sizeBytes: 0 }]);
});

test('reveal rejects unknown ids and registered-but-empty exports with typed not-found', async (t) => {
  const root = makeRoot(t);
  const store = makeStore(t, root);

  await assert.rejects(store.reveal('missing-id'), (error) => {
    assert.ok(error instanceof McpExportStoreError);
    assert.equal(error.code, EXPORT_STORE_ERROR_CODES.NOT_FOUND);
    assert.equal(error.mcpCode, EXPORT_STORE_ERROR_CODES.NOT_FOUND);
    return true;
  });

  const { id } = await store.makeDirectory('empty');
  await assert.rejects(store.reveal(id), (error) => error.code === EXPORT_STORE_ERROR_CODES.NOT_FOUND);
});

test('failed atomic writes leave no partial final or temp file and keep the registry clean', async (t) => {
  const root = makeRoot(t);
  const store = makeStore(t, root, {
    fsSeam: {
      rename: async () => {
        throw new Error('rename exploded');
      },
    },
  });
  const { id, dir } = await store.makeDirectory('boom');

  await assert.rejects(store.writeFile(path.join(dir, 'final.txt'), 'payload'), /rename exploded/);
  assert.deepEqual(fs.readdirSync(dir), [], 'no temp residue may survive');
  await assert.rejects(store.reveal(id), (error) => error.code === EXPORT_STORE_ERROR_CODES.NOT_FOUND);
});

test('register rejects paths resolving outside the protected exports root', async (t) => {
  const root = makeRoot(t);
  const store = makeStore(t, root);
  const { id, dir } = await store.makeDirectory('inside');
  const insidePath = path.join(dir, 'notes.txt');
  await store.writeFile(insidePath, 'payload');

  const escapePaths = [
    '/etc/passwd',
    path.join(root, '..', 'outside.txt'),
    path.join(root, 'sub', '..'),
    root,
  ];
  for (const escapePath of escapePaths) {
    await assert.rejects(store.register(id, [insidePath, escapePath]), (error) => {
      assert.ok(error instanceof McpExportStoreError, escapePath);
      assert.equal(error.code, EXPORT_STORE_ERROR_CODES.INVALID_REQUEST, escapePath);
      assert.equal(error.mcpCode, EXPORT_STORE_ERROR_CODES.INVALID_REQUEST, escapePath);
      return true;
    });
  }
});

test('reveal refuses exports whose registration attempted to escape the root', async (t) => {
  const root = makeRoot(t);
  const store = makeStore(t, root);
  const { id } = await store.makeDirectory('escape');
  await assert.rejects(
    store.register(id, [path.join(root, '..', 'secret.txt')]),
    (error) => error.code === EXPORT_STORE_ERROR_CODES.INVALID_REQUEST,
  );
  await assert.rejects(store.reveal(id), (error) => {
    assert.ok(error instanceof McpExportStoreError);
    assert.equal(error.code, EXPORT_STORE_ERROR_CODES.NOT_FOUND);
    return true;
  });
});

test('exportsRoot is validated as an absolute path', async (t) => {
  assert.throws(() => createMcpExportStore({}), TypeError);
  const relative = createMcpExportStore({ exportsRoot: 'relative/exports' });
  await assert.rejects(relative.makeDirectory('x'), TypeError);
});
