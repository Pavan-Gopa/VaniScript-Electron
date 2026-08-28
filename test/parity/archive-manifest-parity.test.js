'use strict';

/**
 * P4.D4 Slice 2 — archive-manifest-v3 parity test (binding §3 with Errata
 * wire names `originalFileName`/`size`, §6 Slice 2).
 *
 * Part A (comparator): the committed fixture round-trips through the §3
 * comparator — format + schemaVersion exact, entries matched by key with
 * role/format/originalFileName/sha256/size/aliases comparison, including the
 * sha-dedupe aliases entry (chunk:0 with aliases ['chunk:1']). Mutated
 * in-memory copies must fail.
 *
 * Part B (real product decode): the fixture's manifest is fed to the REAL
 * streaming bundle importer. Redacted fixture sha256 values cannot pass the
 * importer's payload hash verification by construction, so the test derives
 * the entry hashes from generated payload bytes while preserving every other
 * fixture field (role/format/originalFileName/size/aliases) — the same
 * hand-built wire pattern the existing streamingBundle tests use. This proves
 * Electron's decoder accepts the fixture manifest shape, enforces format +
 * schemaVersion exactness, verifies sha256 against payload bytes, and applies
 * the sha-dedupe alias (chunk:1 → chunk:0's restored file).
 */

const { test } = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const {
  createStreamingBundleService,
} = require('../../electron/main/projects/streamingBundle.js');
const { compareArchiveManifest } = require('../parity/comparators.mjs');

const FIXTURE_PATH = path.join(__dirname, '..', 'fixtures', 'parity', 'archive-manifest-v3.json');
const PROJECT_MAGIC = 'VANISCRIPT_BUNDLE_V2';

function loadFixture() {
  return JSON.parse(fs.readFileSync(FIXTURE_PATH, 'utf8'));
}

function sha256(buffer) {
  return crypto.createHash('sha256').update(buffer).digest('hex');
}

/** Deterministic payload of a given length (mirrors streamingBundle tests). */
function payloadBytes(length, seed = 0) {
  const buffer = Buffer.alloc(length);
  for (let i = 0; i < length; i++) buffer[i] = (i * 31 + seed + (i % 251)) & 0xff;
  return buffer;
}

function makeTempDir(t, prefix) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  t.after(() => {
    try {
      fs.rmSync(dir, { recursive: true, force: true });
    } catch {
      /* ignore */
    }
  });
  return dir;
}

function makeService(t, root) {
  let seq = 0;
  return createStreamingBundleService({
    projectsRootDir: root,
    newProjectId: () => `vs-parity-${String(++seq).padStart(3, '0')}`,
    now: () => '2026-01-01T00:00:00.000Z',
  });
}

/**
 * Hand-built V2 project bundle (independent of the service under test):
 * magic, metadata length frame, metadata JSON, then asset records.
 */
function buildBundleBuffer(metadata, records) {
  const json = Buffer.from(JSON.stringify(metadata, null, 2), 'utf8');
  const recordBuffers = records.map(({ key, name, data }) => Buffer.concat([
    Buffer.from(`START_ASSET\n${key}\n${name}\n${data.length}\n`, 'utf8'),
    data,
    Buffer.from('END_ASSET\n', 'utf8'),
  ]));
  return Buffer.concat([
    Buffer.from(`${PROJECT_MAGIC}\n`, 'utf8'),
    Buffer.from(`${String(json.length).padStart(12, '0')}\n`, 'utf8'),
    json,
    ...recordBuffers,
  ]);
}

test('archive manifest fixture declares the shared parity harness version', () => {
  assert.equal(loadFixture().fixtureVersion, 1);
});

test('archive manifest comparator self-check preserves sha-dedupe alias semantics', () => {
  const fixture = loadFixture();
  // This clone only checks comparator behavior; the real product decode is
  // covered by the Part B importer test below.
  const comparatorInput = JSON.parse(JSON.stringify(fixture));

  const comparison = compareArchiveManifest(fixture, comparatorInput);
  assert.deepEqual(
    comparison.failures,
    [],
    `archive-manifest parity comparator reported drift:\n${comparison.failures.join('\n')}`,
  );
  assert.equal(comparison.ok, true);
});

test('comparator fails when a manifest entry is mutated', () => {
  const fixture = loadFixture();
  const mutations = [
    ['entry "chunk:0".size', (doc) => {
      doc.assetManifest.entries.find((e) => e.key === 'chunk:0').size = 1;
    }],
    ['entry "sourceFile".sha256', (doc) => {
      doc.assetManifest.entries.find((e) => e.key === 'sourceFile').sha256
        = '0'.repeat(64);
    }],
    ['entry "chunk:0".aliases', (doc) => {
      delete doc.assetManifest.entries.find((e) => e.key === 'chunk:0').aliases;
    }],
    ['entry "originalVideoPath".role', (doc) => {
      doc.assetManifest.entries.find((e) => e.key === 'originalVideoPath').role = 'mediaChunk';
    }],
  ];

  for (const [label, mutate] of mutations) {
    const decoded = JSON.parse(JSON.stringify(fixture));
    mutate(decoded);
    const comparison = compareArchiveManifest(fixture, decoded);
    assert.equal(comparison.ok, false, `expected comparator failure for ${label}`);
    assert.ok(
      comparison.failures.some((line) => line.includes(label)),
      `expected a failure naming ${label}, got:\n${comparison.failures.join('\n')}`,
    );
  }
});

test('real bundle importer decodes the fixture manifest shape and applies the sha-dedupe alias', async (t) => {
  const fixture = loadFixture();
  const outDir = makeTempDir(t, 'parity-bundle-out-');
  const storeRoot = makeTempDir(t, 'parity-bundle-store-');
  const service = makeService(t, storeRoot);

  // Payload bytes sized to the fixture's declared sizes; the content-identical
  // chunk is what produces the sha-dedupe alias in the fixture.
  const payloads = {
    sourceFile: payloadBytes(480000, 1),
    'chunk:0': payloadBytes(240000, 2),
    originalVideoPath: payloadBytes(1048576, 3),
  };
  const sourceEntry = fixture.assetManifest.entries.find((e) => e.key === 'sourceFile');
  const chunkEntry = fixture.assetManifest.entries.find((e) => e.key === 'chunk:0');
  assert.equal(sourceEntry.size, payloads.sourceFile.length);
  assert.equal(chunkEntry.size, payloads['chunk:0'].length);
  assert.deepEqual(chunkEntry.aliases, ['chunk:1']);

  const metadata = {
    format: fixture.format,
    schemaVersion: fixture.schemaVersion,
    exportedAt: fixture.exportedAt,
    project: {
      id: 'fixture-archive-manifest-01',
      name: 'Fixture Archive Manifest Project',
      session: {
        sourceMediaKind: 'audio',
        currentIndex: 1,
        chunks: [
          {
            index: 0,
            startSec: 0,
            endSec: 15,
            durationSec: 15,
            original: 'Fixture source sentence one.',
            translated: '',
            status: 'done',
            approved: true,
          },
          {
            index: 1,
            startSec: 15,
            endSec: 30,
            durationSec: 15,
            original: 'Fixture source sentence two.',
            translated: '',
            status: 'pending',
            approved: false,
          },
        ],
      },
    },
    assetManifest: {
      entries: fixture.assetManifest.entries.map((entry) => ({
        ...entry,
        sha256: sha256(payloads[entry.key]),
      })),
    },
  };

  const bundlePath = path.join(outDir, 'fixture-archive.vsbundle');
  fs.writeFileSync(bundlePath, buildBundleBuffer(metadata, [
    { key: 'sourceFile', name: sourceEntry.originalFileName, data: payloads.sourceFile },
    { key: 'chunk:0', name: chunkEntry.originalFileName, data: payloads['chunk:0'] },
    { key: 'originalVideoPath', name: 'fixture-original.mp4', data: payloads.originalVideoPath },
  ]));

  const imported = await service.importProjectBundle(bundlePath);
  assert.ok(imported.session.sourceFile, 'sourceFile asset restored');
  // The alias maps chunk:1 onto chunk:0's restored canonical file — the
  // real product semantics of the sha-dedupe manifest entry.
  assert.equal(
    imported.session.chunks[0].filePath,
    imported.session.chunks[1].filePath,
    'alias chunk:1 resolves to the chunk:0 canonical file',
  );
  assert.ok(
    path.basename(imported.session.chunks[0].filePath) === 'chunk_0--fixture-chunk-00.m4a',
    `chunk file restored under a key-qualified leaf: ${imported.session.chunks[0].filePath}`,
  );
});

test('real bundle importer rejects a payload whose bytes contradict the manifest sha256', async (t) => {
  const fixture = loadFixture();
  const outDir = makeTempDir(t, 'parity-bundle-out-');
  const storeRoot = makeTempDir(t, 'parity-bundle-store-');
  const service = makeService(t, storeRoot);

  const sourcePayload = payloadBytes(480000, 1);
  const chunkPayload = payloadBytes(240000, 2);
  const corruptedChunk = Buffer.from(chunkPayload);
  corruptedChunk[0] ^= 0xff; // flip one byte: same size, different sha256

  const metadata = {
    format: fixture.format,
    schemaVersion: fixture.schemaVersion,
    exportedAt: fixture.exportedAt,
    project: { id: 'fixture-archive-manifest-01', name: 'Fixture', session: { chunks: [] } },
    assetManifest: {
      entries: fixture.assetManifest.entries.map((entry) => ({
        ...entry,
        sha256: sha256(entry.key === 'sourceFile' ? sourcePayload : chunkPayload),
      })),
    },
  };

  const bundlePath = path.join(outDir, 'corrupt.vsbundle');
  fs.writeFileSync(bundlePath, buildBundleBuffer(metadata, [
    { key: 'sourceFile', name: 'fixture-source.m4a', data: sourcePayload },
    { key: 'chunk:0', name: 'fixture-chunk-00.m4a', data: corruptedChunk },
  ]));

  await assert.rejects(
    service.importProjectBundle(bundlePath),
    /SHA-256 mismatch for key "chunk:0"/,
  );
});

test('real bundle importer enforces exact format and schemaVersion', async (t) => {
  const fixture = loadFixture();
  const outDir = makeTempDir(t, 'parity-bundle-out-');
  const storeRoot = makeTempDir(t, 'parity-bundle-store-');
  const service = makeService(t, storeRoot);

  const payload = payloadBytes(480000, 1);
  const metadata = {
    format: fixture.format,
    schemaVersion: fixture.schemaVersion - 1,
    exportedAt: fixture.exportedAt,
    project: { id: 'fixture-archive-manifest-01', name: 'Fixture', session: { chunks: [] } },
    assetManifest: {
      entries: fixture.assetManifest.entries.map((entry) => ({
        ...entry,
        sha256: sha256(payload),
      })),
    },
  };

  const bundlePath = path.join(outDir, 'wrong-schema.vsbundle');
  fs.writeFileSync(bundlePath, buildBundleBuffer(metadata, [
    { key: 'sourceFile', name: 'fixture-source.m4a', data: payload },
  ]));

  await assert.rejects(
    service.importProjectBundle(bundlePath),
    /schemaVersion/,
  );
});
