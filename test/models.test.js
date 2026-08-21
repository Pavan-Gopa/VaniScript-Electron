'use strict';

/**
 * MOD-01 — Local model manager unit tests.
 * Run via: node --test test/models.test.js  (or scripts/run-electron-tests.mjs)
 * Exercises path-traversal guards, checksum verification, and secure relocation
 * without an Electron runtime (modelManager.js has no electron import).
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');

const mm = require('../electron/main/models/modelManager.js');

function makeTempDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'models-test-'));
}

function writeFile(p, content = 'hello model bytes') {
  fs.mkdirSync(path.dirname(p), { recursive: true });
  fs.writeFileSync(p, content, { mode: 0o644 });
  return p;
}

function sha256Of(content) {
  return crypto.createHash('sha256').update(Buffer.from(content)).digest('hex');
}

function isAppError(value) {
  return !!value && value.isAppError === true && typeof value.code === 'string';
}

// ─── Classification ──────────────────────────────────────────────────────────

test('classify detects each supported runtime', () => {
  assert.equal(mm.classify('/x/m.gguf', 'm.gguf', false), 'gguf');
  assert.equal(mm.classify('/x/w.bin', 'w.bin', false), 'ggml');
  assert.equal(mm.classify('/x/m.safetensors', 'm.safetensors', false), 'mlx');
  assert.equal(mm.classify('/x/Kit.mlmodelc', 'Kit.mlmodelc', true), 'whisperkit');
});

test('classify treats a dir with config.json as mlx', () => {
  const dir = makeTempDir();
  const modelDir = path.join(dir, 'mymodel');
  fs.mkdirSync(modelDir);
  writeFile(path.join(modelDir, 'config.json'), '{}');
  assert.equal(mm.classify(modelDir, 'mymodel', true), 'mlx');
});

test('classify ignores unsupported files and plain dirs', () => {
  assert.equal(mm.classify('/x/notes.txt', 'notes.txt', false), null);
  assert.equal(mm.classify('/x/plain', 'plain', true), null);
});

// ─── Path traversal guard ─────────────────────────────────────────────────────

test('assertWithinRoot accepts descendant and rejects escape', () => {
  const root = makeTempDir();
  const ok = mm.assertWithinRoot(path.join(root, 'a', 'b.gguf'), root, 'dest');
  assert.ok(ok.startsWith(root));

  assert.throws(() => mm.assertWithinRoot(path.join(root, '..', 'escape.gguf'), root, 'dest'), (err) => {
    assert.ok(isAppError(err));
    assert.equal(err.code, 'PERMISSION_DENIED');
    return true;
  });

  assert.throws(() => mm.assertWithinRoot('/etc/passwd', root, 'dest'), (err) => {
    assert.equal(err.code, 'PERMISSION_DENIED');
    return true;
  });
});

// ─── Scan ──────────────────────────────────────────────────────────────────────

test('scanModels finds classified artifacts recursively', () => {
  const root = makeTempDir();
  writeFile(path.join(root, 'gguf', 'm.gguf'), 'gguf-content');
  writeFile(path.join(root, 'ggml', 'w.bin'), 'ggml-content');
  const wk = path.join(root, 'whisperkit', 'Kit.mlmodelc');
  fs.mkdirSync(wk, { recursive: true });
  const mlx = path.join(root, 'mlx', 'mymodel');
  fs.mkdirSync(mlx, { recursive: true });
  writeFile(path.join(mlx, 'config.json'), '{}');
  writeFile(path.join(mlx, 'model.safetensors'), 'mlx-content');
  writeFile(path.join(root, 'other', 'notes.txt'), 'ignored'); // unsupported

  const { action, models } = mm.scanModels({ directories: [root] });
  assert.equal(action, 'scan');
  const runtimes = models.map((m) => m.runtime).sort();
  assert.deepEqual(runtimes, ['ggml', 'gguf', 'mlx', 'whisperkit'].sort());
  const gguf = models.find((m) => m.name === 'm.gguf');
  assert.equal(gguf.isDirectory, false);
  assert.equal(gguf.extension, '.gguf');
  assert.equal(typeof gguf.sizeBytes, 'number');
  assert.ok(gguf.sizeBytes > 0);
});

test('scanModels honors runtime filter', () => {
  const root = makeTempDir();
  writeFile(path.join(root, 'gguf', 'm.gguf'), 'x');
  writeFile(path.join(root, 'ggml', 'w.bin'), 'y');
  const { models } = mm.scanModels({ directories: [root], runtimes: ['gguf'] });
  assert.equal(models.length, 1);
  assert.equal(models[0].runtime, 'gguf');
});

// ─── Verify ────────────────────────────────────────────────────────────────────

test('verifyModel computes checksum and matches expected', async () => {
  const root = makeTempDir();
  const content = 'verify-me';
  const file = writeFile(path.join(root, 'm.gguf'), content);
  const expected = sha256Of(content);

  const res = await mm.verifyModel({ filePath: file, expectedChecksum: expected });
  assert.equal(res.action, 'verify');
  assert.equal(res.checksum, expected);
  assert.equal(res.match, true);
  assert.equal(res.sizeBytes, Buffer.byteLength(content));

  // No expectedChecksum → match defaults true.
  const res2 = await mm.verifyModel({ filePath: file });
  assert.equal(res2.match, true);
});

test('verifyModel raises NOT_FOUND for missing file', async () => {
  const root = makeTempDir();
  await assert.rejects(
    () => mm.verifyModel({ filePath: path.join(root, 'nope.gguf') }),
    (err) => {
      assert.ok(isAppError(err));
      assert.equal(err.code, 'NOT_FOUND');
      return true;
    },
  );
});

test('verifyModel raises CORRUPT_DATA on checksum mismatch', async () => {
  const root = makeTempDir();
  const file = writeFile(path.join(root, 'm.gguf'), 'real-content');
  await assert.rejects(
    () => mm.verifyModel({ filePath: file, expectedChecksum: 'deadbeef' }),
    (err) => {
      assert.ok(isAppError(err));
      assert.equal(err.code, 'CORRUPT_DATA');
      assert.equal(err.details.actualChecksum, sha256Of('real-content'));
      return true;
    },
  );
});

test('verifyModel raises PERMISSION_DENIED on traversal', async () => {
  await assert.rejects(
    () => mm.verifyModel({ filePath: '/etc/passwd', allowedRoot: makeTempDir() }),
    (err) => {
      assert.equal(err.code, 'PERMISSION_DENIED');
      return true;
    },
  );
});

// ─── Relocate (secure) ──────────────────────────────────────────────────────────

test('relocateModel moves file and verifies integrity', async () => {
  const root = makeTempDir();
  const content = 'relocate-content';
  const src = writeFile(path.join(root, 'src', 'm.gguf'), content);
  const dest = path.join(root, 'dst', 'm.gguf');
  const expected = sha256Of(content);

  const res = await mm.relocateModel({ sourcePath: src, destinationPath: dest, allowedRoot: root });
  assert.equal(res.action, 'relocate');
  assert.equal(res.checksum, expected);
  assert.equal(res.sizeBytes, Buffer.byteLength(content));
  assert.ok(fs.existsSync(dest), 'destination should exist');
  assert.ok(!fs.existsSync(src), 'source should be removed');
  assert.equal(fs.readFileSync(dest, 'utf8'), content);
});

test('relocateModel refuses to overwrite an existing destination', async () => {
  const root = makeTempDir();
  const src = writeFile(path.join(root, 'src', 'm.gguf'), 'src');
  const dest = writeFile(path.join(root, 'dst', 'm.gguf'), 'preexisting');

  await assert.rejects(
    () => mm.relocateModel({ sourcePath: src, destinationPath: dest, allowedRoot: root }),
    (err) => {
      assert.ok(isAppError(err));
      assert.equal(err.code, 'OUTPUT_COLLISION');
      return true;
    },
  );
  // Source untouched, original destination preserved.
  assert.ok(fs.existsSync(src));
  assert.equal(fs.readFileSync(dest, 'utf8'), 'preexisting');
});

test('relocateModel raises NOT_FOUND for missing source', async () => {
  const root = makeTempDir();
  await assert.rejects(
    () => mm.relocateModel({ sourcePath: path.join(root, 'src', 'nope.gguf'), destinationPath: path.join(root, 'dst', 'm.gguf'), allowedRoot: root }),
    (err) => {
      assert.equal(err.code, 'NOT_FOUND');
      return true;
    },
  );
});

test('relocateModel blocks path traversal on destination', async () => {
  const root = makeTempDir();
  const src = writeFile(path.join(root, 'm.gguf'), 'data');
  await assert.rejects(
    () => mm.relocateModel({ sourcePath: src, destinationPath: path.join(root, '..', 'escape.gguf'), allowedRoot: root }),
    (err) => {
      assert.equal(err.code, 'PERMISSION_DENIED');
      return true;
    },
  );
  // Source remains because the move was never attempted.
  assert.ok(fs.existsSync(src));
});

test('relocateModel raises CORRUPT_DATA when expected checksum mismatches', async () => {
  const root = makeTempDir();
  const src = writeFile(path.join(root, 'm.gguf'), 'real-content');
  const dest = path.join(root, 'dst', 'm.gguf');
  await assert.rejects(
    () => mm.relocateModel({ sourcePath: src, destinationPath: dest, expectedChecksum: 'deadbeef', allowedRoot: root }),
    (err) => {
      assert.equal(err.code, 'CORRUPT_DATA');
      return true;
    },
  );
  // No partial destination; source preserved.
  assert.ok(!fs.existsSync(dest));
  assert.ok(fs.existsSync(src));
});

test('relocateModel leaves no partial file on copy failure', async () => {
  const root = makeTempDir();
  const src = writeFile(path.join(root, 'm.gguf'), 'data');
  const dest = path.join(root, 'dst', 'm.gguf');
  // Point destination at an unwritable location (read-only parent) to force a
  // write error → INTERNAL, and assert the partial file is cleaned up.
  const roParent = path.join(root, 'ro');
  fs.mkdirSync(roParent, 0o555);
  const badDest = path.join(roParent, 'locked', 'm.gguf');
  await assert.rejects(
    () => mm.relocateModel({ sourcePath: src, destinationPath: badDest, allowedRoot: root }),
    (err) => {
      assert.ok(isAppError(err));
      return true;
    },
  );
  assert.ok(!fs.existsSync(badDest), 'partial destination must be cleaned up');
  fs.chmodSync(roParent, 0o755); // allow cleanup of temp dir
});

// ─── manageModels dispatch ─────────────────────────────────────────────────────

test('manageModels dispatches by action and rejects unknown', async () => {
  const root = makeTempDir();
  const scan = await mm.manageModels({ action: 'scan', directories: [root] });
  assert.equal(scan.action, 'scan');

  const file = writeFile(path.join(root, 'm.gguf'), 'x');
  const verify = await mm.manageModels({ action: 'verify', filePath: file });
  assert.equal(verify.action, 'verify');

  await assert.rejects(
    () => mm.manageModels({ action: 'frobnicate' }),
    (err) => {
      assert.equal(err.code, 'VALIDATION_FAILED');
      return true;
    },
  );

  await assert.rejects(
    () => mm.manageModels({}),
    (err) => {
      assert.equal(err.code, 'VALIDATION_FAILED');
      return true;
    },
  );
});
