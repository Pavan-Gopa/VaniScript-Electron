'use strict';

/**
 * P3E.D3-S2/S3 contract coverage for the hardened streaming bundle service:
 * V2/JSON-v1 compatibility, Apple-shaped manifests, strict bounded parsing,
 * containment, staged atomic promotion, journaled library recovery, and the
 * unified content-routed `importBundle` entry point.
 */

const { test } = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const fsp = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');

const {
  createStreamingBundleService,
} = require('../electron/main/projects/streamingBundle.js');

const FIXED_NOW = '2026-08-24T00:00:00.000Z';
const PROJECT_MAGIC = 'VANISCRIPT_BUNDLE_V2';
const LIBRARY_MAGIC = 'VANISCRIPT_LIBRARY_V2';
const STAGE_PREFIX = '.vaniscript-stage-';
const JOURNAL_PREFIX = '.vaniscript-journal-';

// ─── Fixtures ────────────────────────────────────────────────────────────────

/** Deterministic binary crossing the 1 MiB copy-buffer boundary. */
function bigBinary(bytes = 1024 * 1024 + 777) {
  const buf = Buffer.alloc(bytes);
  for (let i = 0; i < bytes; i++) buf[i] = (i * 31 + (i % 251)) & 0xff;
  return buf;
}

function sha256(buffer) {
  return crypto.createHash('sha256').update(buffer).digest('hex');
}

function makeRoot(t, prefix) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  t.after(() => {
    try {
      fs.rmSync(root, { recursive: true, force: true });
    } catch {
      /* ignore */
    }
  });
  return root;
}

function makeService(t, root, overrides = {}) {
  let seq = 0;
  return createStreamingBundleService({
    projectsRootDir: root,
    newProjectId: () => `vs-test-${String(++seq).padStart(3, '0')}`,
    now: () => FIXED_NOW,
    ...overrides,
  });
}

function writeFile(dir, name, content) {
  const fullPath = path.join(dir, name);
  fs.mkdirSync(path.dirname(fullPath), { recursive: true });
  fs.writeFileSync(fullPath, content);
  return fullPath;
}

function makeSession(overrides = {}) {
  return {
    targetLang: 'Russian',
    sourceMediaKind: 'video',
    currentIndex: 0,
    chunks: [],
    ...overrides,
  };
}

function makeChunk(overrides = {}) {
  return {
    index: 0,
    startSec: 0,
    endSec: 1,
    durationSec: 1,
    original: 'x',
    status: 'done',
    approved: false,
    translated: '',
    translationsByLanguage: {},
    ...overrides,
  };
}

// ─── Hand-built wire helpers (independent of the service under test) ─========

function frameMetadata(metadata, padTo) {
  let json = Buffer.from(JSON.stringify(metadata, null, 2), 'utf8');
  if (padTo !== undefined) {
    assert.ok(json.length <= padTo, 'fixture metadata exceeds requested pad');
    json = Buffer.concat([json, Buffer.alloc(padTo - json.length, 0x20)]);
  }
  return Buffer.concat([
    Buffer.from(`${String(json.length).padStart(12, '0')}\n`, 'utf8'),
    json,
  ]);
}

function assetRecordBytes(asset, { library = false, index = 0, sizeOverride } = {}) {
  const declared = sizeOverride ?? asset.data.length;
  const headLines = ['START_ASSET'];
  if (library) headLines.push(String(index));
  headLines.push(asset.key, asset.name, String(declared));
  return Buffer.concat([
    Buffer.from(`${headLines.join('\n')}\n`, 'utf8'),
    asset.data,
    Buffer.from('END_ASSET\n', 'utf8'),
  ]);
}

function assembleBundle(magicLine, framedMetadata, records) {
  return Buffer.concat([
    Buffer.from(`${magicLine}\n`, 'utf8'),
    framedMetadata,
    ...records,
  ]);
}

function defaultRole(key) {
  if (key.startsWith('chunk:')) return 'mediaChunk';
  if (key === 'originalVideoPath') return 'auxiliary';
  return 'originalSource';
}

function manifestEntryFor(asset, extras = {}) {
  return {
    key: asset.key,
    role: defaultRole(asset.key),
    format: path.extname(asset.name).slice(1).toLowerCase(),
    originalFileName: asset.name,
    sha256: sha256(asset.data),
    size: asset.data.length,
    ...extras,
  };
}

function buildProjectBundleBuffer({
  project,
  assets = [],
  includeAssetMeta = true,
  includeManifest = false,
  manifestEntries,
  metadataExtras = {},
}) {
  const metadata = {
    format: 'vaniscript-project-v2',
    schemaVersion: 3,
    exportedAt: FIXED_NOW,
    project,
  };
  if (includeAssetMeta) {
    metadata.assetMeta = assets.map((a) => ({
      key: a.key,
      name: a.name,
      size: a.data.length,
    }));
  }
  if (includeManifest) {
    metadata.assetManifest = {
      entries: manifestEntries ?? assets.map((a) => manifestEntryFor(a)),
    };
  }
  Object.assign(metadata, metadataExtras);
  return assembleBundle(
    PROJECT_MAGIC,
    frameMetadata(metadata),
    assets.map((a) => assetRecordBytes(a)),
  );
}

async function writeFixture(root, name, buffer) {
  const filePath = path.join(root, name);
  fs.writeFileSync(filePath, buffer);
  return filePath;
}

function readExportedProject(filePath) {
  const buffer = fs.readFileSync(filePath);
  assert.equal(
    buffer.subarray(0, PROJECT_MAGIC.length + 1).toString('utf8'),
    `${PROJECT_MAGIC}\n`,
    'exact project magic header',
  );
  const nl = buffer.indexOf(0x0a);
  const frameText = buffer.subarray(nl + 1, nl + 14).toString('utf8');
  assert.match(frameText, /^[0-9]{12}\n$/, 'exact 12-digit metadata frame');
  const jsonLength = Number(frameText.slice(0, 12));
  const metadata = JSON.parse(
    buffer.subarray(nl + 14, nl + 14 + jsonLength).toString('utf8'),
  );
  return { buffer, metadata };
}

function residue(root) {
  return fs
    .readdirSync(root)
    .filter((n) => n.startsWith('.vaniscript-'))
    .sort();
}

function assertCleanStore(root, expectedFinals = []) {
  assert.deepEqual(residue(root), [], 'no stage/journal/temp residue');
  assert.deepEqual(
    fs.readdirSync(root).sort(),
    [...expectedFinals].sort(),
    'store contains exactly the expected finals',
  );
}

// ─── Round trips ─────────────────────────────────────────────────────────────

test('project V2 round trip preserves >1MiB binaries and emits Apple-shaped manifests', async (t) => {
  const sourceDir = makeRoot(t, 'vs-src-');
  const storeRoot = makeRoot(t, 'vs-store-');
  const outDir = makeRoot(t, 'vs-out-');

  const big = bigBinary();
  const video = crypto.randomBytes(4096);
  const chunk0Data = Buffer.from('chunk-zero-audio-bytes');
  const chunk1Data = Buffer.from('chunk-one-audio-bytes');
  const sourcePath = writeFile(sourceDir, 'Kadamba.mov', big);
  const videoPath = writeFile(sourceDir, 'original.mp4', video);
  const chunk0Path = writeFile(sourceDir, 'first.wav', chunk0Data);
  const chunk1Path = writeFile(sourceDir, 'second.wav', chunk1Data);

  const project = {
    id: 'vs-original-1',
    name: 'Round trip',
    createdAt: '2000-01-01T00:00:00.000Z',
    updatedAt: '2000-01-01T00:00:00.000Z',
    session: makeSession({
      sourceFile: sourcePath,
      originalVideoPath: videoPath,
      wavPath: '/tmp/derived-intermediate.wav',
      chunks: [
        makeChunk({ filePath: chunk0Path, language: 'English' }),
        makeChunk({ filePath: chunk1Path }),
      ],
    }),
  };

  const service = makeService(t, storeRoot);
  const bundlePath = path.join(outDir, 'round.vsbundle');
  await service.writeProjectBundle(project, bundlePath);

  const { buffer, metadata } = readExportedProject(bundlePath);
  assert.equal(metadata.format, 'vaniscript-project-v2');
  assert.equal(metadata.schemaVersion, 3);
  assert.equal(metadata.exportedAt, FIXED_NOW);
  assert.equal(metadata.project.name, 'Round trip');
  assert.notEqual(
    buffer.indexOf(Buffer.from('END_ASSET\n', 'utf8'), Math.max(0, buffer.length - 12)),
    -1,
    'physical EOF right after last record',
  );

  const entries = metadata.assetManifest.entries;
  assert.deepEqual(
    entries.map((e) => e.key),
    ['sourceFile', 'originalVideoPath', 'chunk:0', 'chunk:1'],
  );
  const byKey = new Map(entries.map((e) => [e.key, e]));
  assert.deepEqual(byKey.get('sourceFile'), {
    key: 'sourceFile',
    role: 'originalSource',
    format: 'mov',
    originalFileName: 'Kadamba.mov',
    sha256: sha256(big),
    size: big.length,
  });
  assert.equal(byKey.get('originalVideoPath').role, 'auxiliary');
  assert.equal(byKey.get('originalVideoPath').sha256, sha256(video));
  assert.equal(byKey.get('chunk:0').role, 'mediaChunk');
  assert.equal(byKey.get('chunk:0').format, 'wav');
  assert.equal(byKey.get('chunk:0').language, 'English');
  assert.equal('language' in byKey.get('chunk:1'), false);
  assert.deepEqual(metadata.assetMeta, [
    { key: 'sourceFile', name: 'Kadamba.mov', size: big.length },
    { key: 'originalVideoPath', name: 'original.mp4', size: video.length },
    { key: 'chunk:0', name: 'first.wav', size: chunk0Data.length },
    { key: 'chunk:1', name: 'second.wav', size: chunk1Data.length },
  ]);
  for (const entry of entries) {
    assert.match(entry.sha256, /^[0-9a-f]{64}$/, 'lowercase 64-hex digest');
  }
  assert.ok(!JSON.stringify(entries).includes('wavPath'), 'derived wavPath omitted');

  const imported = await service.importProjectBundle(bundlePath);
  assert.equal(imported.id, 'vs-test-001');
  assert.notEqual(imported.id, project.id);
  assert.equal(imported.createdAt, FIXED_NOW);
  assert.equal(imported.updatedAt, FIXED_NOW);

  const finalDir = path.join(storeRoot, 'vs-test-001');
  const restoredSource = path.join(finalDir, 'audio', 'sourceFile--Kadamba.mov');
  assert.equal(imported.session.sourceFile, restoredSource);
  assert.equal(
    imported.session.originalVideoPath,
    path.join(finalDir, 'audio', 'originalVideoPath--original.mp4'),
  );
  assert.equal(
    imported.session.chunks[0].filePath,
    path.join(finalDir, 'chunks', 'chunk_0--first.wav'),
  );
  assert.equal(
    imported.session.chunks[1].filePath,
    path.join(finalDir, 'chunks', 'chunk_1--second.wav'),
  );
  assert.deepEqual(fs.readFileSync(restoredSource), big, '>1MiB bytes intact');
  assert.equal(imported.session.chunks[0].original, 'x', 'chunk fields verbatim');

  const persisted = JSON.parse(
    fs.readFileSync(path.join(finalDir, 'project.json'), 'utf8'),
  );
  assert.equal(persisted.id, 'vs-test-001');
  assert.equal(persisted.session.sourceFile, restoredSource);
  assertCleanStore(storeRoot, ['vs-test-001']);
});

test('content-hash dedupe merges identical bytes into aliases; equal sizes stay separate', async (t) => {
  const sourceDir = makeRoot(t, 'vs-src-');
  const storeRoot = makeRoot(t, 'vs-store-');
  const outDir = makeRoot(t, 'vs-out-');

  const a = bigBinary(4096);
  const b = Buffer.from(a);
  b[b.length - 1] ^= 0xff; // same size, different bytes: must NOT dedupe
  const sameBasename = Buffer.from('identical-content');
  const videoCopy = Buffer.from(a); // identical bytes at another path

  const project = {
    id: 'orig',
    name: 'Dedupe',
    session: makeSession({
      sourceFile: writeFile(sourceDir, 'take.wav', a),
      originalVideoPath: writeFile(sourceDir, 'same-size.mp4', b),
      chunks: [
        makeChunk({ filePath: writeFile(sourceDir, 'same.wav', sameBasename) }),
        makeChunk({ filePath: writeFile(sourceDir, 'copy.wav', videoCopy) }),
      ],
    }),
  };

  const service = makeService(t, storeRoot);
  const bundlePath = path.join(outDir, 'dedupe.vsbundle');
  await service.writeProjectBundle(project, bundlePath);

  const { metadata } = readExportedProject(bundlePath);
  const entries = metadata.assetManifest.entries;
  assert.deepEqual(entries.map((e) => e.key), [
    'sourceFile',
    'originalVideoPath',
    'chunk:0',
  ]);
  assert.deepEqual(entries[0].aliases, ['chunk:1'], 'identical chunk merges as alias');
  assert.equal('aliases' in entries[1], false);
  assert.equal('aliases' in entries[2], false);
  assert.notEqual(entries[0].sha256, entries[1].sha256);
  assert.equal(entries[0].size, entries[1].size, 'equal sizes did not merge');
  assert.equal(entries[2].role, 'mediaChunk');

  const imported = await service.importProjectBundle(bundlePath);
  const finalDir = path.join(storeRoot, imported.id);
  // Same-basename chunks restore to distinct deterministic key-qualified
  // leaves; the content-identical chunk aliases onto its canonical unit.
  const leaf = path.join(finalDir, 'audio', 'sourceFile--take.wav');
  assert.equal(imported.session.sourceFile, leaf);
  assert.equal(
    imported.session.chunks[0].filePath,
    path.join(finalDir, 'chunks', 'chunk_0--same.wav'),
  );
  assert.equal(imported.session.chunks[1].filePath, leaf);
  assertCleanStore(storeRoot, [imported.id]);
});

test('library V2 round trip carries per-bundle manifests and index lines', async (t) => {
  const sourceDir = makeRoot(t, 'vs-src-');
  const storeRoot = makeRoot(t, 'vs-store-');
  const outDir = makeRoot(t, 'vs-out-');

  fs.mkdirSync(path.join(storeRoot, 'unrelated-project'));
  fs.writeFileSync(
    path.join(storeRoot, 'unrelated-project', 'marker.txt'),
    'keep me',
  );

  const big = bigBinary(1024 * 1024 + 11);
  const projects = [
    {
      id: 'lib-a',
      name: 'First',
      session: makeSession({
        sourceFile: writeFile(sourceDir, 'a.wav', Buffer.from('alpha')),
        chunks: [makeChunk({ filePath: writeFile(sourceDir, 'a-big.bin', big) })],
      }),
    },
    {
      id: 'lib-b',
      name: 'Second',
      session: makeSession({
        sourceFile: writeFile(sourceDir, 'b.mov', crypto.randomBytes(2048)),
      }),
    },
  ];

  const service = makeService(t, storeRoot);
  const bundlePath = path.join(outDir, 'library.vsbundle');
  await service.writeLibraryBundle(projects, bundlePath);

  const buffer = fs.readFileSync(bundlePath);
  assert.equal(
    buffer.subarray(0, LIBRARY_MAGIC.length + 1).toString('utf8'),
    `${LIBRARY_MAGIC}\n`,
    'exact library magic header',
  );
  assert.ok(
    buffer.includes(Buffer.from('START_ASSET\n0\nsourceFile\n', 'utf8')),
    'records carry the canonical project index',
  );
  const nl = buffer.indexOf(0x0a);
  const frameText = buffer.subarray(nl + 1, nl + 14).toString('utf8');
  const jsonLength = Number(frameText.slice(0, 12));
  const metadata = JSON.parse(
    buffer.subarray(nl + 14, nl + 14 + jsonLength).toString('utf8'),
  );
  assert.equal(metadata.format, 'vaniscript-library-v2');
  assert.equal(metadata.bundles.length, 2);
  assert.equal(metadata.bundles[0].assetManifest.entries[0].key, 'sourceFile');
  assert.equal(metadata.bundles[0].assetManifest.entries[1].key, 'chunk:0');
  assert.equal(metadata.bundles[0].assetManifest.entries[1].sha256, sha256(big));
  assert.equal(metadata.bundles[1].assetManifest.entries[0].format, 'mov');

  const imported = await service.importLibraryBundle(bundlePath);
  assert.equal(imported.length, 2);
  assert.deepEqual(imported.map((p) => p.id), ['vs-test-001', 'vs-test-002']);
  assert.equal(
    fs.readFileSync(
      path.join(storeRoot, 'vs-test-001', 'chunks', 'chunk_0--a-big.bin'),
    ).length,
    big.length,
  );
  assert.equal(
    fs.readFileSync(path.join(storeRoot, 'unrelated-project', 'marker.txt'), 'utf8'),
    'keep me',
    'pre-existing unrelated project untouched',
  );
  assertCleanStore(storeRoot, ['vs-test-001', 'vs-test-002', 'unrelated-project']);
});

// ─── Legacy compatibility ────────────────────────────────────────────────────

test('imports legacy Electron assetMeta-only V2 bundles and enforces meta-to-wire consistency', async (t) => {
  const storeRoot = makeRoot(t, 'vs-store-');
  const outDir = makeRoot(t, 'vs-out-');
  const service = makeService(t, storeRoot);

  const assets = [
    { key: 'sourceFile', name: 'talk.wav', data: Buffer.from('legacy-source') },
    { key: 'chunk:0', name: 'part.wav', data: Buffer.from('legacy-chunk') },
  ];
  const project = {
    id: 'old',
    name: 'Legacy',
    session: makeSession({ chunks: [makeChunk({})] }),
  };

  const goodPath = await writeFixture(
    outDir,
    'legacy.vsbundle',
    buildProjectBundleBuffer({ project, assets }),
  );
  const imported = await service.importProjectBundle(goodPath);
  const finalDir = path.join(storeRoot, imported.id);
  assert.equal(
    imported.session.sourceFile,
    path.join(finalDir, 'audio', 'sourceFile--talk.wav'),
  );
  assert.equal(
    imported.session.chunks[0].filePath,
    path.join(finalDir, 'chunks', 'chunk_0--part.wav'),
  );
  assertCleanStore(storeRoot, [imported.id]);

  const wrongSize = buildProjectBundleBuffer({
    project,
    assets,
    metadataExtras: {
      assetMeta: [
        { key: 'sourceFile', name: 'talk.wav', size: 13 },
        { key: 'chunk:0', name: 'part.wav', size: 99 },
      ],
    },
  });
  await assert.rejects(
    service.importProjectBundle(await writeFixture(outDir, 'bad-size.vsbundle', wrongSize)),
    /assetMeta/,
  );
  assertCleanStore(storeRoot, [imported.id]);

  const wrongName = buildProjectBundleBuffer({
    project,
    assets,
    metadataExtras: {
      assetMeta: [
        { key: 'sourceFile', name: 'renamed.wav', size: 13 },
        { key: 'chunk:0', name: 'part.wav', size: 11 },
      ],
    },
  });
  await assert.rejects(
    service.importProjectBundle(await writeFixture(outDir, 'bad-name.vsbundle', wrongName)),
    /assetMeta/,
  );
});

test('accepts historical fixtures with neither assetMeta nor manifest, and Apple manifest-only shape', async (t) => {
  const storeRoot = makeRoot(t, 'vs-store-');
  const outDir = makeRoot(t, 'vs-out-');
  const service = makeService(t, storeRoot);
  const project = { id: 'ancient', name: 'Ancient', session: makeSession() };
  const assets = [
    { key: 'sourceFile', name: 'old.wav', data: Buffer.from('ancient') },
  ];

  const bare = await writeFixture(
    outDir,
    'bare.vsbundle',
    buildProjectBundleBuffer({ project, assets, includeAssetMeta: false }),
  );
  const imported = await service.importProjectBundle(bare);
  assert.ok(imported.session.sourceFile.endsWith('sourceFile--old.wav'));

  const appleShape = await writeFixture(
    outDir,
    'apple.vsbundle',
    buildProjectBundleBuffer({
      project,
      assets,
      includeAssetMeta: false,
      includeManifest: true,
    }),
  );
  const importedApple = await service.importProjectBundle(appleShape);
  assert.ok(importedApple.session.sourceFile.endsWith('sourceFile--old.wav'));
  assertCleanStore(storeRoot, [imported.id, importedApple.id]);
});

// ─── JSON-v1 direct import ───────────────────────────────────────────────────

test('imports JSON project-v1 directly with base64 assets and no temporary bundles', async (t) => {
  const storeRoot = makeRoot(t, 'vs-store-');
  const outDir = makeRoot(t, 'vs-out-');
  const service = makeService(t, storeRoot);

  const doc = {
    format: 'vaniscript-project-v1',
    project: {
      id: 'v1-origin',
      name: 'V1 import',
      createdAt: '1999-01-01T00:00:00.000Z',
      session: makeSession({ sourceMediaKind: 'audio', chunks: [makeChunk({})] }),
    },
    assets: [
      {
        key: 'sourceFile',
        name: 'lecture.mp3',
        dataBase64: ` ${crypto.randomBytes(96).toString('base64')} `,
      },
      {
        key: 'chunk:0',
        name: 'seg.wav',
        dataBase64: Buffer.from('v1 chunk bytes').toString('base64'),
      },
    ],
  };
  const docPath = await writeFixture(
    outDir,
    'v1-project.json',
    Buffer.from(JSON.stringify(doc, null, 2), 'utf8'),
  );

  const imported = await service.importProjectBundle(docPath);
  assert.equal(imported.id, 'vs-test-001');
  assert.equal(imported.createdAt, FIXED_NOW);
  const finalDir = path.join(storeRoot, 'vs-test-001');
  assert.ok(
    imported.session.sourceFile.endsWith('audio/sourceFile--lecture.mp3'),
  );
  assert.equal(
    imported.session.chunks[0].filePath,
    path.join(finalDir, 'chunks', 'chunk_0--seg.wav'),
  );
  assert.equal(
    fs.readFileSync(imported.session.chunks[0].filePath, 'utf8'),
    'v1 chunk bytes',
  );
  assert.equal(fs.statSync(docPath).isFile(), true, 'source document untouched');
  assertCleanStore(storeRoot, ['vs-test-001']);

  const brokenBase64 = {
    ...doc,
    assets: [{ key: 'sourceFile', name: 'x.wav', dataBase64: 'not**base64!!' }],
  };
  await assert.rejects(
    service.importProjectBundle(
      await writeFixture(
        outDir,
        'v1-broken.json',
        Buffer.from(JSON.stringify(brokenBase64), 'utf8'),
      ),
    ),
    /base64/,
  );
  assertCleanStore(storeRoot, ['vs-test-001']);
});

test('imports JSON library-v1 directly into one transaction', async (t) => {
  const storeRoot = makeRoot(t, 'vs-store-');
  const outDir = makeRoot(t, 'vs-out-');
  const service = makeService(t, storeRoot);

  const doc = {
    format: 'vaniscript-library-v1',
    bundles: [
      {
        project: { id: 'l1', name: 'Lib one', session: makeSession() },
        assets: [{ key: 'sourceFile', name: 'one.wav', dataBase64: Buffer.from('one').toString('base64') }],
      },
      {
        project: { id: 'l2', name: 'Lib two', session: makeSession() },
        assets: [{ key: 'chunk:0', name: 'two.wav', dataBase64: Buffer.from('two').toString('base64') }],
      },
    ],
  };
  const docPath = await writeFixture(
    outDir,
    'v1-library.json',
    Buffer.from(JSON.stringify(doc), 'utf8'),
  );

  const imported = await service.importLibraryBundle(docPath);
  assert.deepEqual(imported.map((p) => p.name), ['Lib one', 'Lib two']);
  assertCleanStore(storeRoot, ['vs-test-001', 'vs-test-002']);
});

// ─── Manifest integrity ──────────────────────────────────────────────────────

test('rejects tampered manifests and wire records without promoting anything', async (t) => {
  const storeRoot = makeRoot(t, 'vs-store-');
  const outDir = makeRoot(t, 'vs-out-');
  const service = makeService(t, storeRoot);
  const project = { id: 'sec', name: 'Security', session: makeSession() };
  const assets = [
    { key: 'sourceFile', name: 'a.wav', data: Buffer.from('alpha-bytes') },
    { key: 'chunk:0', name: 'b.wav', data: Buffer.from('beta-bytes') },
  ];

  const cases = [
    ['flipped manifest hash', () =>
      buildProjectBundleBuffer({
        project,
        assets,
        includeManifest: true,
        manifestEntries: assets.map((a, i) =>
          manifestEntryFor(a, i === 0 ? { sha256: '0'.repeat(64) } : {}),
        ),
      })],
    ['wire size contradicts manifest', () =>
      assembleBundle(
        PROJECT_MAGIC,
        (() => {
          const metadata = {
            format: 'vaniscript-project-v2',
            schemaVersion: 3,
            exportedAt: FIXED_NOW,
            project,
            assetManifest: { entries: assets.map((a) => manifestEntryFor(a)) },
          };
          return frameMetadata(metadata);
        })(),
        [
          assetRecordBytes(assets[0], { sizeOverride: assets[0].data.length + 1 }),
          assetRecordBytes(assets[1]),
        ],
      )],
    ['missing wire record', () =>
      buildProjectBundleBuffer({
        project,
        assets,
        includeManifest: true,
        manifestEntries: assets.map((a) => manifestEntryFor(a)),
      }).subarray(0, -assetRecordBytes(assets[1]).length)],
    ['extra wire record absent from manifest', () =>
      Buffer.concat([
        buildProjectBundleBuffer({
          project,
          assets,
          includeManifest: true,
          manifestEntries: [manifestEntryFor(assets[0])],
        }),
        assetRecordBytes({ key: 'sneaky', name: 'c.wav', data: Buffer.from('zzz') }),
      ])],
    ['duplicate wire key', () =>
      Buffer.concat([
        buildProjectBundleBuffer({
          project,
          assets: [assets[0]],
          includeManifest: true,
        }),
        assetRecordBytes(assets[0]),
      ])],
    ['duplicate manifest key', () =>
      buildProjectBundleBuffer({
        project,
        assets: [assets[0]],
        includeManifest: true,
        manifestEntries: [manifestEntryFor(assets[0]), manifestEntryFor(assets[0])],
      })],
    ['alias collides with canonical key', () =>
      buildProjectBundleBuffer({
        project,
        assets,
        includeManifest: true,
        manifestEntries: [
          manifestEntryFor(assets[0], { aliases: ['chunk:0'] }),
          manifestEntryFor(assets[1]),
        ],
      })],
    ['unknown role', () =>
      buildProjectBundleBuffer({
        project,
        assets: [assets[0]],
        includeManifest: true,
        manifestEntries: [manifestEntryFor(assets[0], { role: 'sideloaded' })],
      })],
    ['uppercase sha256', () =>
      buildProjectBundleBuffer({
        project,
        assets: [assets[0]],
        includeManifest: true,
        manifestEntries: [
          manifestEntryFor(assets[0], { sha256: sha256(assets[0].data).toUpperCase() }),
        ],
      })],
    ['negative manifest size', () =>
      buildProjectBundleBuffer({
        project,
        assets: [assets[0]],
        includeManifest: true,
        manifestEntries: [manifestEntryFor(assets[0], { size: -5 })],
      })],
    ['malformed manifest container', () =>
      buildProjectBundleBuffer({
        project,
        assets: [assets[0]],
        includeManifest: true,
        metadataExtras: { assetManifest: { entries: 'nope' } },
      })],
  ];

  let index = 0;
  for (const [label, build] of cases) {
    index += 1;
    const bundlePath = await writeFixture(outDir, `tamper-${index}.vsbundle`, build());
    await assert.rejects(
      service.importProjectBundle(bundlePath),
      Error,
      `case rejected: ${label}`,
    );
    assert.deepEqual(residue(storeRoot), [], `no residue after: ${label}`);
  }
  assertCleanStore(storeRoot, []);
});

test('applies manifest aliases to the verified canonical file after verification', async (t) => {
  const storeRoot = makeRoot(t, 'vs-store-');
  const outDir = makeRoot(t, 'vs-out-');
  const service = makeService(t, storeRoot);

  const data = Buffer.from('canonical-bytes');
  const project = {
    id: 'alias-src',
    name: 'Alias',
    session: makeSession({
      sourceFile: '/elsewhere/take.wav',
      originalVideoPath: '/elsewhere/original.mp4',
    }),
  };
  const assets = [{ key: 'sourceFile', name: 'take.wav', data }];
  const bundlePath = await writeFixture(
    outDir,
    'alias.vsbundle',
    buildProjectBundleBuffer({
      project,
      assets,
      includeAssetMeta: false,
      includeManifest: true,
      manifestEntries: [manifestEntryFor(assets[0], { aliases: ['originalVideoPath'] })],
    }),
  );

  const imported = await service.importProjectBundle(bundlePath);
  const canonical = path.join(storeRoot, imported.id, 'audio', 'sourceFile--take.wav');
  assert.equal(imported.session.sourceFile, canonical);
  assert.equal(imported.session.originalVideoPath, canonical, 'alias resolved post-verification');
  assertCleanStore(storeRoot, [imported.id]);
});

// ─── Framing / UTF-8 / integer / marker / EOF tables ────────────────────────

test('framing, UTF-8, integer, marker, and EOF corruption table rejects without residue', async (t) => {
  const storeRoot = makeRoot(t, 'vs-store-');
  const outDir = makeRoot(t, 'vs-out-');
  const service = makeService(t, storeRoot);
  const project = { id: 'frame', name: 'Frames', session: makeSession() };
  const asset = { key: 'sourceFile', name: 'a.wav', data: Buffer.from('hi') };

  const validMetadata = () => ({
    format: 'vaniscript-project-v2',
    schemaVersion: 3,
    exportedAt: FIXED_NOW,
    project,
  });

  const jsonOf = (metadata) => Buffer.from(JSON.stringify(metadata, null, 2), 'utf8');
  const framed = (jsonBuffer) =>
    Buffer.concat([
      Buffer.from(`${String(jsonBuffer.length).padStart(12, '0')}\n`, 'utf8'),
      jsonBuffer,
    ]);

  const badMetadataCases = {
    'non-digit frame': Buffer.concat([
      Buffer.from(`${PROJECT_MAGIC}\n`, 'utf8'),
      Buffer.from('abcdefghijKL\n', 'utf8'),
      jsonOf(validMetadata()),
    ]),
    'short frame': Buffer.concat([
      Buffer.from(`${PROJECT_MAGIC}\n`, 'utf8'),
      Buffer.from('19\n', 'utf8'),
      jsonOf(validMetadata()),
    ]),
    'thirteen-digit frame': Buffer.concat([
      Buffer.from(`${PROJECT_MAGIC}\n`, 'utf8'),
      Buffer.from('0000000000183\n', 'utf8'),
      jsonOf(validMetadata()),
    ]),
    'crlf frame': Buffer.concat([
      Buffer.from(`${PROJECT_MAGIC}\r\n`, 'utf8'),
      framed(jsonOf(validMetadata())),
    ]),
    'metadata longer than archive': Buffer.concat([
      Buffer.from(`${PROJECT_MAGIC}\n`, 'utf8'),
      Buffer.from('000000999999\n', 'utf8'),
      jsonOf(validMetadata()),
    ]),
    'invalid utf-8 metadata': (() => {
      const json = jsonOf(validMetadata());
      json[json.indexOf(0x66)] = 0xff;
      return Buffer.concat([Buffer.from(`${PROJECT_MAGIC}\n`, 'utf8'), framed(json)]);
    })(),
    'metadata not json': Buffer.concat([
      Buffer.from(`${PROJECT_MAGIC}\n`, 'utf8'),
      framed(Buffer.from('{definitely not json', 'utf8')),
    ]),
    'wrong format field': (() => {
      const metadata = { ...validMetadata(), format: 'vaniscript-project-v1' };
      return Buffer.concat([
        Buffer.from(`${PROJECT_MAGIC}\n`, 'utf8'),
        framed(jsonOf(metadata)),
      ]);
    })(),
    'schemaVersion drift': (() => {
      const metadata = { ...validMetadata(), schemaVersion: 4 };
      return Buffer.concat([
        Buffer.from(`${PROJECT_MAGIC}\n`, 'utf8'),
        framed(jsonOf(metadata)),
      ]);
    })(),
    'missing exportedAt': (() => {
      const { exportedAt, ...rest } = validMetadata();
      void exportedAt;
      return Buffer.concat([
        Buffer.from(`${PROJECT_MAGIC}\n`, 'utf8'),
        framed(jsonOf(rest)),
      ]);
    })(),
  };

  const badRecordCases = {
    'leading-zero asset size': Buffer.concat([
      Buffer.from(`${PROJECT_MAGIC}\n`, 'utf8'),
      framed(jsonOf(validMetadata())),
      Buffer.from('START_ASSET\nsourceFile\na.wav\n00002\nhi\nEND_ASSET\n', 'utf8'),
    ]),
    'negative asset size': Buffer.concat([
      Buffer.from(`${PROJECT_MAGIC}\n`, 'utf8'),
      framed(jsonOf(validMetadata())),
      Buffer.from('START_ASSET\nsourceFile\na.wav\n-2\nhi\nEND_ASSET\n', 'utf8'),
    ]),
    'alphabetic asset size': Buffer.concat([
      Buffer.from(`${PROJECT_MAGIC}\n`, 'utf8'),
      framed(jsonOf(validMetadata())),
      Buffer.from('START_ASSET\nsourceFile\na.wav\ntwo\nhi\nEND_ASSET\n', 'utf8'),
    ]),
    'unsafe integer asset size': Buffer.concat([
      Buffer.from(`${PROJECT_MAGIC}\n`, 'utf8'),
      framed(jsonOf(validMetadata())),
      Buffer.from('START_ASSET\nsourceFile\na.wav\n9007199254740993\nhi\nEND_ASSET\n', 'utf8'),
    ]),
    'size exceeding remaining archive bytes': Buffer.concat([
      Buffer.from(`${PROJECT_MAGIC}\n`, 'utf8'),
      framed(jsonOf(validMetadata())),
      Buffer.from('START_ASSET\nsourceFile\na.wav\n100000\nhi\nEND_ASSET\n', 'utf8'),
    ]),
    'unknown marker instead of START_ASSET': Buffer.concat([
      Buffer.from(`${PROJECT_MAGIC}\n`, 'utf8'),
      framed(jsonOf(validMetadata())),
      Buffer.from('NOT_START\nsourceFile\na.wav\n2\nhi\nEND_ASSET\n', 'utf8'),
    ]),
    'wrong end marker': Buffer.concat([
      Buffer.from(`${PROJECT_MAGIC}\n`, 'utf8'),
      framed(jsonOf(validMetadata())),
      Buffer.from('START_ASSET\nsourceFile\na.wav\n2\nhi\nEND_ASSETS\n', 'utf8'),
    ]),
    'truncated payload before end marker': Buffer.concat([
      Buffer.from(`${PROJECT_MAGIC}\n`, 'utf8'),
      framed(jsonOf(validMetadata())),
      Buffer.from('START_ASSET\nsourceFile\na.wav\n50\nhi\n', 'utf8'),
    ]),
    'payload truncated by one byte': (() => {
      const full = Buffer.concat([
        Buffer.from(`${PROJECT_MAGIC}\n`, 'utf8'),
        framed(jsonOf(validMetadata())),
        assetRecordBytes(asset),
      ]);
      return full.subarray(0, full.length - 1);
    })(),
    'trailing junk byte after last record': Buffer.concat([
      Buffer.from(`${PROJECT_MAGIC}\n`, 'utf8'),
      framed(jsonOf(validMetadata())),
      assetRecordBytes(asset),
      Buffer.from('X', 'utf8'),
    ]),
    'trailing blank line after last record': Buffer.concat([
      Buffer.from(`${PROJECT_MAGIC}\n`, 'utf8'),
      framed(jsonOf(validMetadata())),
      assetRecordBytes(asset),
      Buffer.from('\n', 'utf8'),
    ]),
  };

  const headerCases = {
    'wrong magic text': Buffer.concat([
      Buffer.from('VANISCRIPT_BUNDL_V2\n', 'utf8'),
      framed(jsonOf(validMetadata())),
    ]),
    'truncated header': Buffer.from('VANI', 'utf8'),
    'empty file': Buffer.alloc(0),
    'library header in project importer': assembleBundle(
      LIBRARY_MAGIC,
      framed(jsonOf(validMetadata())),
      [],
    ),
  };

  let index = 0;
  for (const [label, buffer] of [
    ...Object.entries(headerCases),
    ...Object.entries(badMetadataCases),
    ...Object.entries(badRecordCases),
  ]) {
    index += 1;
    const bundlePath = await writeFixture(outDir, `frame-${index}.vsbundle`, buffer);
    await assert.rejects(
      service.importProjectBundle(bundlePath),
      Error,
      `case rejected: ${label}`,
    );
    assert.deepEqual(residue(storeRoot), [], `no residue after: ${label}`);
  }
  assertCleanStore(storeRoot, []);
});

// ─── Containment ─────────────────────────────────────────────────────────────

test('containment table rejects traversal forms without writing outside the store', async (t) => {
  const storeRoot = makeRoot(t, 'vs-store-');
  const outDir = makeRoot(t, 'vs-out-');
  const service = makeService(t, storeRoot);
  const escapeProbe = path.join(storeRoot, '..', 'vs-escape-probe.txt');
  fs.rmSync(escapeProbe, { force: true });
  t.after(() => fs.rmSync(escapeProbe, { force: true }));

  const metadata = {
    format: 'vaniscript-project-v2',
    schemaVersion: 3,
    exportedAt: FIXED_NOW,
    project: { id: 'esc', name: 'Escape', session: makeSession() },
  };
  const recordWith = (key, name, data = Buffer.from('x')) =>
    Buffer.concat([
      Buffer.from(`START_ASSET\n${key}\n${name}\n${data.length}\n`, 'utf8'),
      data,
      Buffer.from('END_ASSET\n', 'utf8'),
    ]);

  const hostileCases = [
    ['parent traversal in name', 'sourceFile', '../evil.wav'],
    ['deep parent traversal in name', 'chunk:0', 'a/../../evil.wav'],
    ['absolute posix name', 'sourceFile', '/etc/passwd'],
    ['windows drive name', 'sourceFile', 'C:\\evil.wav'],
    ['backslash separator in name', 'chunk:0', 'sub\\dir.wav'],
    ['dot name', 'sourceFile', '.'],
    ['dot-dot name', 'sourceFile', '..'],
    ['separator in key', 'chunk/zero', 'ok.wav'],
    ['drive syntax in key', 'C:chunk0', 'ok.wav'],
    ['tab control character in name', 'sourceFile', 'bad\tname.wav'],
  ];

  let index = 0;
  for (const [label, key, name] of hostileCases) {
    index += 1;
    const buffer = Buffer.concat([
      Buffer.from(`${PROJECT_MAGIC}\n`, 'utf8'),
      frameMetadata(metadata),
      recordWith(key, name),
    ]);
    const bundlePath = await writeFixture(outDir, `escape-${index}.vsbundle`, buffer);
    await assert.rejects(
      service.importProjectBundle(bundlePath),
      Error,
      `case rejected: ${label}`,
    );
    assert.deepEqual(residue(storeRoot), [], `no residue after: ${label}`);
  }

  // A NUL byte smuggled into the name line is likewise rejected.
  const nulRecord = Buffer.concat([
    Buffer.from('START_ASSET\nsourceFile\nbad', 'utf8'),
    Buffer.from([0x00]),
    Buffer.from('name.wav\n1\nx\nEND_ASSET\n', 'utf8'),
  ]);
  const nulPath = await writeFixture(
    outDir,
    'escape-nul.vsbundle',
    Buffer.concat([
      Buffer.from(`${PROJECT_MAGIC}\n`, 'utf8'),
      frameMetadata(metadata),
      nulRecord,
    ]),
  );
  await assert.rejects(service.importProjectBundle(nulPath), Error);
  assert.deepEqual(residue(storeRoot), []);

  assert.equal(fs.existsSync(escapeProbe), false, 'nothing escaped the store root');
  assertCleanStore(storeRoot, []);
});

// ─── Limits (exact / +1) ─────────────────────────────────────────────────────

test('injected limits enforce exact boundaries: accepted at the limit, rejected past it', async (t) => {
  const outDir = makeRoot(t, 'vs-out-');
  const project = {
    id: 'limits',
    name: 'Limits',
    session: makeSession(),
  };

  // Line limit: the name line content is capped at exactly maxLineBytes.
  const nameAtLimit = `${'a'.repeat(32)}.wav`; // 36-char name -> 36-byte line
  const lineBundle = await writeFixture(
    outDir,
    'line.vsbundle',
    buildProjectBundleBuffer({
      project,
      assets: [{ key: 'sourceFile', name: nameAtLimit, data: Buffer.from('bytes') }],
      includeManifest: false,
    }),
  );

  const accepted = await makeService(t, makeRoot(t, 'vs-limit-'), {
    limits: { maxLineBytes: 36 },
  }).importProjectBundle(lineBundle);
  assert.ok(accepted.session.sourceFile.includes(nameAtLimit));

  const overBundle = await writeFixture(
    outDir,
    'line-over.vsbundle',
    buildProjectBundleBuffer({
      project,
      assets: [{ key: 'sourceFile', name: `${'b'.repeat(37)}.wav`, data: Buffer.from('bytes') }],
      includeManifest: false,
    }),
  );
  await assert.rejects(
    makeService(t, makeRoot(t, 'vs-limit-'), { limits: { maxLineBytes: 36 } })
      .importProjectBundle(overBundle),
    /line limit/,
  );

  // Metadata + archive limits against the same physical bundle.
  const { buffer: bundleBuffer } = readExportedProject(lineBundle);
  const archiveSize = bundleBuffer.length;
  const nl = bundleBuffer.indexOf(0x0a);
  const jsonLength = Number(bundleBuffer.subarray(nl + 1, nl + 13).toString('utf8'));

  await makeService(t, makeRoot(t, 'vs-limit-'), { limits: { maxMetadataBytes: jsonLength } })
    .importProjectBundle(lineBundle);
  await assert.rejects(
    makeService(t, makeRoot(t, 'vs-limit-'), { limits: { maxMetadataBytes: jsonLength - 1 } })
      .importProjectBundle(lineBundle),
    /metadata exceeds/,
  );

  await makeService(t, makeRoot(t, 'vs-limit-'), { limits: { maxArchiveBytes: archiveSize } })
    .importProjectBundle(lineBundle);
  await assert.rejects(
    makeService(t, makeRoot(t, 'vs-limit-'), { limits: { maxArchiveBytes: archiveSize - 1 } })
      .importProjectBundle(lineBundle),
    /maximum archive size/,
  );
});

test('JSON-v1 documents honor maxJsonV1Bytes exactly', async (t) => {
  const storeRoot = makeRoot(t, 'vs-store-');
  const outDir = makeRoot(t, 'vs-out-');
  const doc = {
    format: 'vaniscript-project-v1',
    project: { id: 'j', name: 'Json', session: makeSession() },
    assets: [{ key: 'sourceFile', name: 'a.wav', dataBase64: Buffer.from('hey').toString('base64') }],
  };
  const unpadded = Buffer.from(JSON.stringify(doc, null, 2), 'utf8');
  const target = unpadded.length + 16;
  const paddedDocPath = await writeFixture(
    outDir,
    'v1-padded.json',
    Buffer.concat([unpadded, Buffer.alloc(target - unpadded.length, 0x20)]),
  );

  const imported = await makeService(t, storeRoot, { limits: { maxJsonV1Bytes: target } })
    .importProjectBundle(paddedDocPath);
  assert.equal(imported.id, 'vs-test-001');

  await assert.rejects(
    makeService(t, storeRoot, { limits: { maxJsonV1Bytes: target - 1 } })
      .importProjectBundle(paddedDocPath),
    /byte limit/,
  );
  assert.deepEqual(residue(storeRoot), []);
});

// ─── Export faults ───────────────────────────────────────────────────────────

function inflateStatView(st) {
  const clone = Object.create(
    Object.getPrototypeOf(st),
    Object.getOwnPropertyDescriptors(st),
  );
  clone.size = st.size + 1;
  return clone;
}

test('export faults preserve the prior destination and leave no temp residue', async (t) => {
  const sourceDir = makeRoot(t, 'vs-src-');
  const destDir = makeRoot(t, 'vs-dest-');
  const storeRoot = makeRoot(t, 'vs-store-');
  const destination = path.join(destDir, 'bundle.vsbundle');
  fs.writeFileSync(destination, 'PRIOR-DESTINATION');

  const project = {
    id: 'exp',
    name: 'Export',
    session: makeSession({
      sourceFile: writeFile(sourceDir, 'src.wav', bigBinary(300 * 1024)),
    }),
  };
  // Source truncation between hashing and writing: inflated handle stat
  // sizes make the completeness check fail before any bytes are written.
  const wrapHandle = (handle, overrides = {}) => ({
    read: (...a) => handle.read(...a),
    write: (...a) => handle.write(...a),
    close: (...a) => handle.close(...a),
    stat: (...a) => handle.stat(...a),
    sync: (...a) => handle.sync(...a),
    ...overrides,
  });
  const truncated = makeService(t, storeRoot, {
    fs: {
      open: async (target, flags) => {
        const handle = await fsp.open(target, flags);
        if (!flags.includes('r')) return handle;
        return wrapHandle(handle, {
          stat: async () => inflateStatView(await handle.stat()),
        });
      },
    },
  });
  await assert.rejects(truncated.writeProjectBundle(project, destination), /incomplete read|changed/);
  assert.equal(fs.readFileSync(destination, 'utf8'), 'PRIOR-DESTINATION');
  assert.deepEqual(
    fs.readdirSync(destDir).filter((n) => n.includes('.vsbuild-')),
    [],
    'no export temps remain',
  );

  // Output failure mid-stream: the fourth write to the output handle hits
  // the injected fault; every opened handle must still be closed.
  let opens = 0;
  let closes = 0;
  let outputWrites = 0;
  const outputFault = makeService(t, storeRoot, {
    fs: {
      open: async (target, flags) => {
        const handle = await fsp.open(target, flags);
        opens += 1;
        const isOutput = flags.includes('w');
        return wrapHandle(handle, {
          write: async (...a) => {
            if (isOutput) {
              outputWrites += 1;
              if (outputWrites === 4) throw new Error('injected output fault');
            }
            return handle.write(...a);
          },
          close: async () => {
            closes += 1;
            return handle.close();
          },
        });
      },
    },
  });
  await assert.rejects(outputFault.writeProjectBundle(project, destination), /injected output fault/);
  assert.equal(fs.readFileSync(destination, 'utf8'), 'PRIOR-DESTINATION');
  assert.equal(opens, closes, 'every opened descriptor was closed');
  assert.deepEqual(
    fs.readdirSync(destDir).filter((n) => n.includes('.vsbuild-')),
    [],
  );

  // Rename failure after a successful write: temp removed, destination kept.
  const realRename = fsp.rename.bind(fsp);
  const renameFault = makeService(t, storeRoot, {
    fs: {
      rename: async (...args) => {
        if (path.basename(args[1]) === 'bundle.vsbundle') {
          throw new Error('injected rename fault');
        }
        return realRename(...args);
      },
    },
  });
  await assert.rejects(renameFault.writeProjectBundle(project, destination), /injected rename fault/);
  assert.equal(fs.readFileSync(destination, 'utf8'), 'PRIOR-DESTINATION');
  assert.deepEqual(
    fs.readdirSync(destDir).filter((n) => n.includes('.vsbuild-')),
    [],
  );

  // Sanity: without faults the same export succeeds and replaces the file.
  const healthy = makeService(t, storeRoot);
  await healthy.writeProjectBundle(project, destination);
  const { metadata } = readExportedProject(destination);
  assert.equal(metadata.format, 'vaniscript-project-v2');
});

// ─── Atomic promotion faults ─────────────────────────────────────────────────

test('project import faults remove the stage and never expose a partial final', async (t) => {
  const storeRoot = makeRoot(t, 'vs-store-');
  const outDir = makeRoot(t, 'vs-out-');
  const project = { id: 'atomic', name: 'Atomic', session: makeSession() };
  const assets = [{ key: 'sourceFile', name: 'a.wav', data: Buffer.from('stable') }];
  const bundlePath = await writeFixture(
    outDir,
    'atomic.vsbundle',
    buildProjectBundleBuffer({ project, assets, includeManifest: false }),
  );

  // Fault before promotion: durable project.json write fails inside the stage.
  const realWriteFile = fsp.writeFile.bind(fsp);
  const jsonFault = makeService(t, storeRoot, {
    fs: {
      writeFile: async (...args) => {
        if (path.basename(String(args[0])).includes('.tmp-')) {
          throw new Error('injected json fault');
        }
        return realWriteFile(...args);
      },
    },
  });
  await assert.rejects(jsonFault.importProjectBundle(bundlePath), /injected json fault/);
  assertCleanStore(storeRoot, []);

  // Fault at promotion rename.
  const realRename = fsp.rename.bind(fsp);
  const renameFault = makeService(t, storeRoot, {
    fs: {
      rename: async (src, dst) => {
        if (path.basename(dst) === 'vs-test-001') throw new Error('injected promote fault');
        return realRename(src, dst);
      },
    },
  });
  await assert.rejects(renameFault.importProjectBundle(bundlePath), /injected promote fault/);
  assertCleanStore(storeRoot, []);

  // Pre-existing final is never overwritten.
  fs.mkdirSync(path.join(storeRoot, 'occupied'));
  fs.writeFileSync(path.join(storeRoot, 'occupied', 'project.json'), '{"kept":true}');
  const collision = makeService(t, storeRoot, { newProjectId: () => 'occupied' });
  await assert.rejects(collision.importProjectBundle(bundlePath), /Refusing to overwrite/);
  assert.equal(
    fs.readFileSync(path.join(storeRoot, 'occupied', 'project.json'), 'utf8'),
    '{"kept":true}',
  );
  assertCleanStore(storeRoot, ['occupied']);
});

// ─── Library transactions and journal recovery ──────────────────────────────

function twoProjectBundleBuffer() {
  const projects = [
    {
      id: 'tx-a',
      name: 'Tx A',
      session: makeSession(),
    },
    {
      id: 'tx-b',
      name: 'Tx B',
      session: makeSession(),
    },
  ];
  const bundles = [
    { project: projects[0], assets: [{ key: 'sourceFile', name: 'a.wav', data: Buffer.from('aaa') }] },
    { project: projects[1], assets: [{ key: 'sourceFile', name: 'b.wav', data: Buffer.from('bbb') }] },
  ];
  const metadata = {
    format: 'vaniscript-library-v2',
    schemaVersion: 3,
    exportedAt: FIXED_NOW,
    bundles: bundles.map((b) => ({
      project: b.project,
      assetMeta: b.assets.map((a) => ({ key: a.key, name: a.name, size: a.data.length })),
    })),
  };
  return assembleBundle(
    LIBRARY_MAGIC,
    frameMetadata(metadata),
    bundles.flatMap((b, index) =>
      b.assets.map((a) => assetRecordBytes(a, { library: true, index })),
    ),
  );
}

test('library promotion faults roll back every final and stage created by the transaction', async (t) => {
  const storeRoot = makeRoot(t, 'vs-store-');
  const outDir = makeRoot(t, 'vs-out-');
  fs.mkdirSync(path.join(storeRoot, 'keeper'));
  fs.writeFileSync(path.join(storeRoot, 'keeper', 'project.json'), '{"kept":true}');
  const bundlePath = await writeFixture(outDir, 'tx.vsbundle', twoProjectBundleBuffer());

  // Rename fails on the second promotion: the first promoted final must be
  // rolled back too.
  const realRename = fsp.rename.bind(fsp);
  const secondPromotionFault = makeService(t, storeRoot, {
    fs: {
      rename: async (src, dst) => {
        if (path.basename(dst) === 'vs-test-002') throw new Error('injected second promotion fault');
        return realRename(src, dst);
      },
    },
  });
  await assert.rejects(
    secondPromotionFault.importLibraryBundle(bundlePath),
    /injected second promotion fault/,
  );
  assertCleanStore(storeRoot, ['keeper']);

  // Journal durability failure during the per-promotion update aborts the tx.
  let journalWrites = 0;
  const realWriteFile = fsp.writeFile.bind(fsp);
  const journalUpdateFault = makeService(t, storeRoot, {
    fs: {
      writeFile: async (target, ...rest) => {
        if (path.basename(String(target)).startsWith('.vaniscript-journal-')) {
          journalWrites += 1;
          if (journalWrites >= 2) throw new Error('injected journal update fault');
        }
        return realWriteFile(target, ...rest);
      },
    },
  });
  await assert.rejects(
    journalUpdateFault.importLibraryBundle(bundlePath),
    /injected journal update fault/,
  );
  assertCleanStore(storeRoot, ['keeper']);

  // Failure persisting the initial journal prevents any directory creation.
  const initialFault = makeService(t, storeRoot, {
    fs: {
      writeFile: async (target, ...rest) => {
        if (path.basename(String(target)).includes('.vaniscript-journal-')) {
          throw new Error('injected initial journal fault');
        }
        return realWriteFile(target, ...rest);
      },
    },
  });
  await assert.rejects(
    initialFault.importLibraryBundle(bundlePath),
    /injected initial journal fault/,
  );
  assertCleanStore(storeRoot, ['keeper']);
});

test('leftover journals and stages are recovered deterministically; unrelated projects survive', async (t) => {
  const storeRoot = makeRoot(t, 'vs-store-');

  fs.mkdirSync(path.join(storeRoot, 'unrelated-project'));
  fs.writeFileSync(path.join(storeRoot, 'unrelated-project', 'data.txt'), 'precious');

  // Simulated crash residue: a complete journal listing a half-promoted tx.
  fs.mkdirSync(path.join(storeRoot, 'vs-crashed'));
  fs.writeFileSync(path.join(storeRoot, 'vs-crashed', 'project.json'), '{"crashed":true}');
  fs.mkdirSync(path.join(storeRoot, `${STAGE_PREFIX}deadbeefcafe-0`));
  fs.writeFileSync(path.join(storeRoot, `${STAGE_PREFIX}deadbeefcafe-0`, 'partial.bin'), 'partial');
  fs.writeFileSync(
    path.join(storeRoot, `${JOURNAL_PREFIX}deadbeefcafe${'.json'}`),
    JSON.stringify(
      {
        version: 1,
        transactionId: 'deadbeefcafe',
        createdAt: FIXED_NOW,
        entries: [
          { stageName: `${STAGE_PREFIX}deadbeefcafe-0`, finalName: 'vs-crashed', promoted: true },
        ],
      },
      null,
      2,
    ),
    'utf8',
  );
  // Malformed journal: removed, but claims nothing.
  fs.writeFileSync(path.join(storeRoot, `${JOURNAL_PREFIX}ffeeddccbbaa.json`), '\x00garbage');

  const outDir = makeRoot(t, 'vs-out-');
  const v1DocPath = await writeFixture(
    outDir,
    'probe.json',
    Buffer.from(
      JSON.stringify({
        format: 'vaniscript-project-v1',
        project: { id: 'probe', name: 'Probe', session: makeSession() },
      }),
      'utf8',
    ),
  );

  // Service creation kicks off recovery; the first import awaits it.
  const service = makeService(t, storeRoot);
  const imported = await service.importProjectBundle(v1DocPath);
  assert.equal(imported.id, 'vs-test-001');

  assert.equal(fs.existsSync(path.join(storeRoot, 'vs-crashed')), false, 'journal-listed final rolled back');
  assert.equal(fs.existsSync(path.join(storeRoot, `${STAGE_PREFIX}deadbeefcafe-0`)), false, 'stage swept');
  assert.deepEqual(residue(storeRoot), [], 'journals removed');
  assert.equal(
    fs.readFileSync(path.join(storeRoot, 'unrelated-project', 'data.txt'), 'utf8'),
    'precious',
    'unrelated project untouched',
  );
  assertCleanStore(storeRoot, ['unrelated-project', 'vs-test-001']);
});

async function writeV1Probe(outDir, name) {
  return writeFixture(
    outDir,
    name,
    Buffer.from(
      JSON.stringify({
        format: 'vaniscript-project-v1',
        project: { id: 'probe', name: 'Probe', session: makeSession() },
      }),
      'utf8',
    ),
  );
}

function isJournalTempName(name) {
  return /^\.vaniscript-journal-[0-9a-f]+\.json\.tmp-[0-9a-f]+$/.test(name);
}

test('failed final journal unlink or dirsync rejects and rolls back promoted finals', async (t) => {
  const outDir = makeRoot(t, 'vs-out-');
  const bundlePath = await writeFixture(outDir, 'tx.vsbundle', twoProjectBundleBuffer());

  // Unlink variant: on a healthy import the only journal unlink is the final
  // cleanup, so failing every journal unlink lands exactly there.
  const storeRoot = makeRoot(t, 'vs-store-');
  fs.mkdirSync(path.join(storeRoot, 'keeper'));
  fs.writeFileSync(path.join(storeRoot, 'keeper', 'data.txt'), 'precious');
  const realUnlink = fsp.unlink.bind(fsp);
  const unlinkFault = makeService(t, storeRoot, {
    fs: {
      unlink: async (target, ...rest) => {
        if (path.basename(String(target)).startsWith(JOURNAL_PREFIX)) {
          throw new Error('injected final journal unlink fault');
        }
        return realUnlink(target, ...rest);
      },
    },
  });
  await assert.rejects(
    unlinkFault.importLibraryBundle(bundlePath),
    /injected final journal unlink fault/,
  );
  const afterFault = fs.readdirSync(storeRoot).sort();
  assert.deepEqual(
    afterFault.filter((n) => !n.startsWith(JOURNAL_PREFIX)),
    ['keeper'],
    'promoted finals and stages rolled back',
  );
  assert.equal(afterFault.length, 2, 'exactly the rollback journal survives');
  assert.match(
    afterFault.find((n) => n.startsWith(JOURNAL_PREFIX)),
    /^\.vaniscript-journal-[0-9a-f]{24}\.json$/,
  );

  // A later recovery is safe: it clears the surviving journal and imports work.
  const healed = makeService(t, storeRoot);
  const imported = await healed.importProjectBundle(await writeV1Probe(outDir, 'probe-a.json'));
  assert.equal(imported.id, 'vs-test-001');
  assertCleanStore(storeRoot, ['keeper', 'vs-test-001']);

  // Dirsync variant: a two-bundle import opens the store root for fsync four
  // times — three persistJournal refreshes plus the strict final cleanup — so
  // the fourth lands exactly on the post-unlink durability barrier.
  const syncRoot = makeRoot(t, 'vs-store-');
  fs.mkdirSync(path.join(syncRoot, 'keeper'));
  fs.writeFileSync(path.join(syncRoot, 'keeper', 'data.txt'), 'precious');
  let rootSyncs = 0;
  const realOpen = fsp.open.bind(fsp);
  const syncFault = makeService(t, syncRoot, {
    fs: {
      open: async (target, flags, ...rest) => {
        if (target === syncRoot && ++rootSyncs === 4) {
          throw new Error('injected final dirsync fault');
        }
        return realOpen(target, flags, ...rest);
      },
    },
  });
  await assert.rejects(
    syncFault.importLibraryBundle(bundlePath),
    /injected final dirsync fault/,
  );
  // The journal unlink had already succeeded, so the store is fully clean.
  assertCleanStore(syncRoot, ['keeper']);
  const reimported = await makeService(t, syncRoot).importProjectBundle(
    await writeV1Probe(outDir, 'probe-b.json'),
  );
  assert.equal(reimported.id, 'vs-test-001');
  assertCleanStore(syncRoot, ['keeper', 'vs-test-001']);
});

test('every import reruns recovery on residue created after service construction', async (t) => {
  const storeRoot = makeRoot(t, 'vs-store-');
  const outDir = makeRoot(t, 'vs-out-');
  fs.mkdirSync(path.join(storeRoot, 'unrelated-project'));
  fs.writeFileSync(path.join(storeRoot, 'unrelated-project', 'data.txt'), 'precious');

  const service = makeService(t, storeRoot);
  // Settle construction-time recovery with one clean import first.
  const first = await service.importProjectBundle(await writeV1Probe(outDir, 'first.json'));
  assert.equal(first.id, 'vs-test-001');
  assertCleanStore(storeRoot, ['unrelated-project', 'vs-test-001']);

  // Crash residue appears after construction: a valid journal claiming a
  // half-promoted final, that final, and an orphaned stage directory.
  fs.mkdirSync(path.join(storeRoot, 'late-crash'));
  fs.writeFileSync(path.join(storeRoot, 'late-crash', 'project.json'), '{"late":true}');
  fs.mkdirSync(path.join(storeRoot, `${STAGE_PREFIX}cafebabecafe-0`));
  fs.writeFileSync(path.join(storeRoot, `${STAGE_PREFIX}cafebabecafe-0`, 'partial.bin'), 'partial');
  fs.writeFileSync(
    path.join(storeRoot, `${JOURNAL_PREFIX}cafebabecafe.json`),
    JSON.stringify(
      {
        version: 1,
        transactionId: 'cafebabecafe',
        createdAt: FIXED_NOW,
        entries: [
          { stageName: `${STAGE_PREFIX}cafebabecafe-0`, finalName: 'late-crash', promoted: false },
        ],
      },
      null,
      2,
    ),
    'utf8',
  );

  // The next import reruns recovery before starting its own transaction.
  const second = await service.importProjectBundle(await writeV1Probe(outDir, 'second.json'));
  assert.equal(second.id, 'vs-test-002');
  assert.equal(fs.existsSync(path.join(storeRoot, 'late-crash')), false, 'journal-listed late final rolled back');
  assert.equal(
    fs.existsSync(path.join(storeRoot, `${STAGE_PREFIX}cafebabecafe-0`)),
    false,
    'late orphaned stage swept',
  );
  assertCleanStore(storeRoot, ['unrelated-project', 'vs-test-001', 'vs-test-002']);
});

test('journal temp files never survive persistence faults and unrelated files are never swept', async (t) => {
  const storeRoot = makeRoot(t, 'vs-store-');
  const outDir = makeRoot(t, 'vs-out-');
  fs.mkdirSync(path.join(storeRoot, 'keeper'));
  fs.writeFileSync(path.join(storeRoot, 'keeper', 'data.txt'), 'precious');
  // Near-miss names that must survive every cleanup pass untouched.
  writeFile(storeRoot, '.vaniscript-journal-notes.json.tmp-notahex', 'mine');
  writeFile(storeRoot, 'notes.vaniscript-journal-x.json.tmp-deadbeef', 'mine');
  const preexisting = [
    '.vaniscript-journal-notes.json.tmp-notahex',
    'keeper',
    'notes.vaniscript-journal-x.json.tmp-deadbeef',
  ].sort();
  const assertOnlyPreexisting = (label) =>
    assert.deepEqual(fs.readdirSync(storeRoot).sort(), preexisting, label);
  const bundlePath = await writeFixture(outDir, 'tx.vsbundle', twoProjectBundleBuffer());

  // Write fault on the very first journal persistence.
  const realWriteFile = fsp.writeFile.bind(fsp);
  const writeFault = makeService(t, storeRoot, {
    fs: {
      writeFile: async (target, ...rest) => {
        if (isJournalTempName(path.basename(String(target)))) {
          throw new Error('injected journal temp write fault');
        }
        return realWriteFile(target, ...rest);
      },
    },
  });
  await assert.rejects(
    writeFault.importLibraryBundle(bundlePath),
    /injected journal temp write fault/,
  );
  assertOnlyPreexisting('write fault left no temp residue');

  // Sync fault while the unique temp file is being made durable.
  const realOpen = fsp.open.bind(fsp);
  const syncFault = makeService(t, storeRoot, {
    fs: {
      open: async (target, flags, ...rest) => {
        const fd = await realOpen(target, flags, ...rest);
        if (isJournalTempName(path.basename(String(target)))) {
          return {
            sync: async () => {
              throw new Error('injected journal temp sync fault');
            },
            close: () => fd.close(),
          };
        }
        return fd;
      },
    },
  });
  await assert.rejects(
    syncFault.importLibraryBundle(bundlePath),
    /injected journal temp sync fault/,
  );
  assertOnlyPreexisting('sync fault left no temp residue');

  // Rename fault after the temp file is fully durable.
  const realRename = fsp.rename.bind(fsp);
  const renameFault = makeService(t, storeRoot, {
    fs: {
      rename: async (src, dst, ...rest) => {
        if (isJournalTempName(path.basename(String(src)))) {
          throw new Error('injected journal temp rename fault');
        }
        return realRename(src, dst, ...rest);
      },
    },
  });
  await assert.rejects(
    renameFault.importLibraryBundle(bundlePath),
    /injected journal temp rename fault/,
  );
  assertOnlyPreexisting('rename fault left no temp residue');
});

// ─── Recovery barrier and strict journal protocol ───────────────────────────

test('first import awaits the startup recovery; no concurrent recovery pass ever runs', async (t) => {
  const storeRoot = makeRoot(t, 'vs-store-');
  const outDir = makeRoot(t, 'vs-out-');
  fs.mkdirSync(path.join(storeRoot, 'keeper'));
  fs.writeFileSync(path.join(storeRoot, 'keeper', 'data.txt'), 'precious');

  let releaseStartup;
  const startupGate = new Promise((resolve) => {
    releaseStartup = resolve;
  });
  let readdirCalls = 0;
  let activeReaddirs = 0;
  let maxActiveReaddirs = 0;
  const realReaddir = fsp.readdir.bind(fsp);
  const gated = makeService(t, storeRoot, {
    fs: {
      readdir: async (target, ...rest) => {
        if (String(target) !== storeRoot) return realReaddir(target, ...rest);
        readdirCalls += 1;
        activeReaddirs += 1;
        maxActiveReaddirs = Math.max(maxActiveReaddirs, activeReaddirs);
        try {
          if (readdirCalls === 1) await startupGate; // hold the startup pass open
          return await realReaddir(target, ...rest);
        } finally {
          activeReaddirs -= 1;
        }
      },
    },
  });

  // Fire the first import while the creation-time recovery is still blocked.
  const firstImport = gated.importProjectBundle(await writeV1Probe(outDir, 'gated.json'));
  await new Promise((resolve) => setTimeout(resolve, 25));
  assert.equal(
    readdirCalls,
    1,
    'no second recovery pass started behind the blocked startup pass',
  );

  releaseStartup();
  const imported = await firstImport;
  assert.equal(imported.id, 'vs-test-001');
  assert.equal(
    readdirCalls,
    2,
    'first import ran its own pre-import recovery only after awaiting the startup pass',
  );
  assert.equal(maxActiveReaddirs, 1, 'recovery passes never overlapped');
  assertCleanStore(storeRoot, ['keeper', 'vs-test-001']);
});

test('a failed startup recovery rejects the first import instead of being swallowed', async (t) => {
  const storeRoot = makeRoot(t, 'vs-store-');
  const outDir = makeRoot(t, 'vs-out-');
  let readdirCalls = 0;
  const realReaddir = fsp.readdir.bind(fsp);
  const doomed = makeService(t, storeRoot, {
    fs: {
      readdir: async (target, ...rest) => {
        if (String(target) === storeRoot && ++readdirCalls === 1) {
          throw new Error('injected startup recovery fault');
        }
        return realReaddir(target, ...rest);
      },
    },
  });

  await assert.rejects(
    doomed.importProjectBundle(await writeV1Probe(outDir, 'doomed.json')),
    /injected startup recovery fault/,
  );
  assert.deepEqual(fs.readdirSync(storeRoot), [], 'failure observed before any transaction started');

  // The next import runs its own pre-import recovery normally and succeeds.
  const healed = await doomed.importProjectBundle(await writeV1Probe(outDir, 'healed.json'));
  assert.equal(healed.id, 'vs-test-001');
  assertCleanStore(storeRoot, ['vs-test-001']);
});

test('rollback removal faults keep the journal and artifacts for a later clean recovery', async (t) => {
  const outDir = makeRoot(t, 'vs-out-');
  const bundlePath = await writeFixture(outDir, 'tx.vsbundle', twoProjectBundleBuffer());
  const storeRoot = makeRoot(t, 'vs-store-');
  fs.mkdirSync(path.join(storeRoot, 'keeper'));
  fs.writeFileSync(path.join(storeRoot, 'keeper', 'data.txt'), 'precious');

  const realRename = fsp.rename.bind(fsp);
  const realRm = fsp.rm.bind(fsp);
  let rollbackRmCalls = 0;
  const service = makeService(t, storeRoot, {
    fs: {
      rename: async (src, dst, ...rest) => {
        if (path.basename(String(dst)) === 'vs-test-002') {
          throw new Error('injected second promotion fault');
        }
        return realRename(src, dst, ...rest);
      },
      rm: async (target, ...rest) => {
        if (path.dirname(String(target)) === storeRoot && ++rollbackRmCalls === 1) {
          throw new Error('injected rollback rm fault');
        }
        return realRm(target, ...rest);
      },
    },
  });

  await assert.rejects(service.importLibraryBundle(bundlePath), (err) => {
    assert.match(err.message, /injected second promotion fault/, 'original error preserved');
    assert.match(err.message, /injected rollback rm fault/, 'cleanup failure exposed');
    assert.ok(err instanceof AggregateError, 'both errors inspectable on the aggregate');
    return true;
  });

  const names = fs.readdirSync(storeRoot).sort();
  assert.ok(
    names.some((n) => /^\.vaniscript-journal-[0-9a-f]{24}\.json$/.test(n)),
    'the durable rollback journal survives',
  );
  assert.ok(
    fs.existsSync(path.join(storeRoot, 'vs-test-001')),
    'faulted final stays under journal protection',
  );
  assert.equal(
    names.filter((n) => n.startsWith(STAGE_PREFIX)).length,
    1,
    'the remaining stage stays too',
  );

  // A later clean recovery removes the surviving final, stage, and journal.
  const healed = makeService(t, storeRoot);
  const imported = await healed.importProjectBundle(await writeV1Probe(outDir, 'after-rm.json'));
  assert.equal(imported.id, 'vs-test-001');
  assertCleanStore(storeRoot, ['keeper', 'vs-test-001']);
});

test('persistent recovery removal faults retain the journal, artifacts, and reject imports', async (t) => {
  const storeRoot = makeRoot(t, 'vs-store-');
  const outDir = makeRoot(t, 'vs-out-');
  fs.mkdirSync(path.join(storeRoot, 'unrelated-project'));
  fs.writeFileSync(path.join(storeRoot, 'unrelated-project', 'data.txt'), 'precious');
  // Planted crash residue: a valid journal plus its listed final and an orphan stage.
  fs.mkdirSync(path.join(storeRoot, 'stuck-final'));
  fs.writeFileSync(path.join(storeRoot, 'stuck-final', 'project.json'), '{"stuck":true}');
  fs.mkdirSync(path.join(storeRoot, `${STAGE_PREFIX}beefcafebeef-0`));
  fs.writeFileSync(path.join(storeRoot, `${STAGE_PREFIX}beefcafebeef-0`, 'partial.bin'), 'partial');
  fs.writeFileSync(
    path.join(storeRoot, `${JOURNAL_PREFIX}beefcafebeef.json`),
    JSON.stringify(
      {
        version: 1,
        transactionId: 'beefcafebeef',
        createdAt: FIXED_NOW,
        entries: [
          { stageName: `${STAGE_PREFIX}beefcafebeef-0`, finalName: 'stuck-final', promoted: true },
        ],
      },
      null,
      2,
    ),
    'utf8',
  );

  const realRm = fsp.rm.bind(fsp);
  const stubborn = makeService(t, storeRoot, {
    fs: {
      rm: async (target, ...rest) => {
        if (String(target).startsWith(`${storeRoot}${path.sep}`)) {
          throw new Error('injected persistent rm fault');
        }
        return realRm(target, ...rest);
      },
    },
  });

  await assert.rejects(
    stubborn.importProjectBundle(await writeV1Probe(outDir, 'blocked.json')),
    /injected persistent rm fault/,
  );
  assert.ok(fs.existsSync(path.join(storeRoot, `${JOURNAL_PREFIX}beefcafebeef.json`)), 'journal retained');
  assert.ok(fs.existsSync(path.join(storeRoot, 'stuck-final')), 'listed final retained');
  assert.ok(fs.existsSync(path.join(storeRoot, `${STAGE_PREFIX}beefcafebeef-0`)), 'orphan stage retained');
  assert.equal(
    fs.readFileSync(path.join(storeRoot, 'unrelated-project', 'data.txt'), 'utf8'),
    'precious',
    'unrelated project untouched',
  );

  const healed = makeService(t, storeRoot);
  const imported = await healed.importProjectBundle(await writeV1Probe(outDir, 'freed.json'));
  assert.equal(imported.id, 'vs-test-001');
  assertCleanStore(storeRoot, ['unrelated-project', 'vs-test-001']);
});

test('post-unlink failures end in a durably completed rollback or a recreated journal', async (t) => {
  const outDir = makeRoot(t, 'vs-out-');
  const bundlePath = await writeFixture(outDir, 'tx.vsbundle', twoProjectBundleBuffer());

  // Variant A: the durability barrier right after the final journal unlink
  // fails once. Rollback re-persists the journal BEFORE deleting anything
  // and finishes, so the store ends clean with no promoted final behind.
  const syncRoot = makeRoot(t, 'vs-store-');
  fs.mkdirSync(path.join(syncRoot, 'keeper'));
  fs.writeFileSync(path.join(syncRoot, 'keeper', 'data.txt'), 'precious');
  let onceOpens = 0;
  const realOpen = fsp.open.bind(fsp);
  const onceFault = makeService(t, syncRoot, {
    fs: {
      open: async (target, flags, ...rest) => {
        if (String(target) === syncRoot && ++onceOpens === 4) {
          throw new Error('injected post-unlink dirsync fault');
        }
        return realOpen(target, flags, ...rest);
      },
    },
  });
  await assert.rejects(
    onceFault.importLibraryBundle(bundlePath),
    /injected post-unlink dirsync fault/,
  );
  assertCleanStore(syncRoot, ['keeper']);
  const rerun = await makeService(t, syncRoot).importProjectBundle(
    await writeV1Probe(outDir, 'probe-a.json'),
  );
  assert.equal(rerun.id, 'vs-test-001');
  assertCleanStore(syncRoot, ['keeper', 'vs-test-001']);

  // Variant B: the same barrier fails AND the rollback's post-removal root
  // fsync fails too. The finals are already gone under the recreated
  // journal, which survives as the retryable marker.
  const twinRoot = makeRoot(t, 'vs-store-');
  fs.mkdirSync(path.join(twinRoot, 'keeper'));
  fs.writeFileSync(path.join(twinRoot, 'keeper', 'data.txt'), 'precious');
  let twinOpens = 0;
  const twiceFault = makeService(t, twinRoot, {
    fs: {
      open: async (target, flags, ...rest) => {
        if (String(target) === twinRoot && (++twinOpens === 4 || twinOpens === 6)) {
          throw new Error(
            twinOpens === 4 ? 'injected post-unlink dirsync fault' : 'injected rollback dirsync fault',
          );
        }
        return realOpen(target, flags, ...rest);
      },
    },
  });
  await assert.rejects(twiceFault.importLibraryBundle(bundlePath), (err) => {
    assert.match(err.message, /injected post-unlink dirsync fault/, 'original error preserved');
    assert.match(err.message, /injected rollback dirsync fault/, 'cleanup failure exposed');
    return true;
  });
  const survivorNames = fs.readdirSync(twinRoot).sort();
  assert.ok(
    survivorNames.some((n) => /^\.vaniscript-journal-[0-9a-f]{24}\.json$/.test(n)),
    'the recreated journal marks the incomplete transaction',
  );
  assert.deepEqual(
    survivorNames.filter((n) => !n.startsWith(JOURNAL_PREFIX)),
    ['keeper'],
    'no promoted final survived without either the journal or a finished rollback',
  );
  const recovered = await makeService(t, twinRoot).importProjectBundle(
    await writeV1Probe(outDir, 'probe-b.json'),
  );
  assert.equal(recovered.id, 'vs-test-001');
  assertCleanStore(twinRoot, ['keeper', 'vs-test-001']);
});

// ─── Edge shapes ─────────────────────────────────────────────────────────────

test('zero-asset project exports and imports as a valid empty bundle', async (t) => {
  const storeRoot = makeRoot(t, 'vs-store-');
  const outDir = makeRoot(t, 'vs-out-');
  const service = makeService(t, storeRoot);
  const bundlePath = path.join(outDir, 'empty.vsbundle');

  await service.writeProjectBundle(
    { id: 'empty-src', name: 'Empty', session: makeSession() },
    bundlePath,
  );
  const imported = await service.importProjectBundle(bundlePath);
  assert.equal(imported.name, 'Empty');
  assert.deepEqual(imported.session.chunks, []);
  assertCleanStore(storeRoot, [imported.id]);
});

test('factory validates its required options', async (t) => {
  assert.throws(() => createStreamingBundleService({}), /projectsRootDir/);
  assert.throws(
    () => createStreamingBundleService({ projectsRootDir: '/tmp/x' }),
    /newProjectId/,
  );
  assert.throws(
    () =>
      createStreamingBundleService({
        projectsRootDir: '/tmp/x',
        newProjectId: () => 'x',
        limits: { maxLineBytes: -1 },
      }),
    /maxLineBytes/,
  );

  // A relative resolver rejects at the recovery barrier on first import.
  await assert.rejects(
    createStreamingBundleService({
      projectsRootDir: () => 'not/absolute',
      newProjectId: () => 'vs-x',
    }).importProjectBundle('/tmp/whatever'),
    /absolute/,
  );

  // Unsafe generated ids are rejected after the document parses.
  const storeRoot = makeRoot(t, 'vs-hidden-');
  const docPath = await writeFixture(
    storeRoot,
    'probe.json',
    Buffer.from(
      JSON.stringify({
        format: 'vaniscript-project-v1',
        project: { id: 'probe', name: 'Probe', session: makeSession() },
      }),
      'utf8',
    ),
  );
  await assert.rejects(
    createStreamingBundleService({
      projectsRootDir: storeRoot,
      newProjectId: () => '.hidden',
    }).importProjectBundle(docPath),
    /unsafe project id/,
  );
});

// ─── Unified content router (P3E.D3-S3) ──────────────────────────────────────

/** Asserts an imported project's normalized session paths live under its own
 * generated final directory inside the store. */
function assertPlacedUnderFinalDir(project, storeRoot, label) {
  const finalDir = path.join(storeRoot, project.id);
  assert.ok(
    typeof project.session.sourceFile === 'string' &&
      project.session.sourceFile.startsWith(`${finalDir}${path.sep}`),
    `${label}: normalized sourceFile lives inside the final directory`,
  );
  for (const chunk of project.session.chunks) {
    if (!chunk.filePath) continue;
    assert.ok(
      chunk.filePath.startsWith(`${path.join(finalDir, 'chunks')}${path.sep}`),
      `${label}: normalized chunk files live inside the final chunks directory`,
    );
  }
}

test('importBundle routes all four content formats and rejects unsupported JSON by content alone', async (t) => {
  const v2ProjectBuffer = () =>
    buildProjectBundleBuffer({
      project: {
        id: 'origin-p',
        name: 'Wire project',
        session: makeSession({ chunks: [makeChunk({})] }),
      },
      assets: [
        { key: 'sourceFile', name: 'wire-src.wav', data: Buffer.from('wire-src') },
        { key: 'chunk:0', name: 'wire-c0.wav', data: Buffer.from('wire-c0') },
      ],
    });

  const rows = [
    {
      label: 'project V2 wire header',
      buffer: v2ProjectBuffer(),
      expectedIds: ['vs-test-001'],
      firstChunkBytes: 'wire-c0',
    },
    {
      label: 'library V2 wire header',
      buffer: twoProjectBundleBuffer(),
      expectedIds: ['vs-test-001', 'vs-test-002'],
    },
    {
      label: 'project JSON-v1 document',
      buffer: Buffer.from(
        JSON.stringify(
          {
            format: 'vaniscript-project-v1',
            project: {
              id: 'origin-v1',
              name: 'V1 project',
              session: makeSession({ sourceMediaKind: 'audio', chunks: [makeChunk({})] }),
            },
            assets: [
              {
                key: 'sourceFile',
                name: 'v1-src.mp3',
                dataBase64: Buffer.from('v1-src').toString('base64'),
              },
              {
                key: 'chunk:0',
                name: 'v1-c0.wav',
                dataBase64: Buffer.from('v1-c0').toString('base64'),
              },
            ],
          },
          null,
          2,
        ),
        'utf8',
      ),
      expectedIds: ['vs-test-001'],
      firstChunkBytes: 'v1-c0',
    },
    {
      label: 'library JSON-v1 document',
      buffer: Buffer.from(
        JSON.stringify({
          format: 'vaniscript-library-v1',
          bundles: [
            {
              project: { id: 'l1', name: 'Lib one', session: makeSession() },
              assets: [
                {
                  key: 'sourceFile',
                  name: 'one.wav',
                  dataBase64: Buffer.from('one').toString('base64'),
                },
              ],
            },
            {
              project: { id: 'l2', name: 'Lib two', session: makeSession() },
              assets: [
                {
                  key: 'sourceFile',
                  name: 'two-src.wav',
                  dataBase64: Buffer.from('two-src').toString('base64'),
                },
                {
                  key: 'chunk:0',
                  name: 'two.wav',
                  dataBase64: Buffer.from('two').toString('base64'),
                },
              ],
            },
          ],
        }),
        'utf8',
      ),
      expectedIds: ['vs-test-001', 'vs-test-002'],
    },
    {
      label: 'empty library JSON-v1 document',
      buffer: Buffer.from(
        JSON.stringify({ format: 'vaniscript-library-v1', bundles: [] }),
        'utf8',
      ),
      expectedIds: [],
    },
  ];

  for (const row of rows) {
    const storeRoot = makeRoot(t, 'vs-router-store-');
    const inDir = makeRoot(t, 'vs-router-in-');
    const service = makeService(t, storeRoot);
    // Every format gets the same neutral file name/extension: routing must be
    // by content, never by extension.
    const fixturePath = await writeFixture(inDir, 'fixture.bin', row.buffer);

    const imported = await service.importBundle(fixturePath);

    assert.ok(Array.isArray(imported), `${row.label}: returns an array`);
    assert.deepEqual(
      imported.map((project) => project.id),
      row.expectedIds,
      `${row.label}: generated ids`,
    );
    for (const project of imported) {
      assert.equal(project.createdAt, FIXED_NOW, `${row.label}: stamped creation time`);
      assertPlacedUnderFinalDir(project, storeRoot, row.label);
    }
    if (row.firstChunkBytes !== undefined) {
      assert.equal(
        fs.readFileSync(imported[0].session.chunks[0].filePath, 'utf8'),
        row.firstChunkBytes,
        `${row.label}: chunk payload round-trips`,
      );
    }
    assertCleanStore(storeRoot, row.expectedIds);
  }

  // Unsupported JSON is rejected by content; nothing is staged, nothing is
  // promoted, and previously imported finals survive untouched.
  const storeRoot = makeRoot(t, 'vs-router-reject-');
  const inDir = makeRoot(t, 'vs-router-reject-in-');
  const service = makeService(t, storeRoot);
  const keeper = await service.importBundle(
    await writeFixture(inDir, 'keeper.bin', v2ProjectBuffer()),
  );
  const probes = [
    ['plain object', { hello: 'world' }],
    ['unknown format', { format: 'vaniscript-project-v9', project: {} }],
    ['non-object document', [1, 2, 3]],
  ];
  for (const [name, doc] of probes) {
    const probePath = await writeFixture(
      inDir,
      `probe-${name.replace(/\s+/g, '-')}.json`,
      Buffer.from(JSON.stringify(doc), 'utf8'),
    );
    await assert.rejects(
      service.importBundle(probePath),
      /Unsupported bundle format/,
      `${name}: rejected as unsupported`,
    );
  }
  assertCleanStore(storeRoot, keeper.map((project) => project.id));
});

test('importBundle parses JSON-v1 documents from the open handle without re-reading the path', async (t) => {
  const projectDoc = Buffer.from(
    JSON.stringify({
      format: 'vaniscript-project-v1',
      project: {
        id: 'origin-v1',
        name: 'V1 project',
        session: makeSession({ sourceMediaKind: 'audio', chunks: [makeChunk({})] }),
      },
      assets: [
        {
          key: 'sourceFile',
          name: 'v1-src.mp3',
          dataBase64: Buffer.from('v1-src').toString('base64'),
        },
        {
          key: 'chunk:0',
          name: 'v1-c0.wav',
          dataBase64: Buffer.from('v1-c0').toString('base64'),
        },
      ],
    }),
    'utf8',
  );
  const libraryDoc = Buffer.from(
    JSON.stringify({
      format: 'vaniscript-library-v1',
      bundles: [
        {
          project: { id: 'l1', name: 'Lib one', session: makeSession() },
          assets: [
            {
              key: 'sourceFile',
              name: 'one.wav',
              dataBase64: Buffer.from('one').toString('base64'),
            },
          ],
        },
        {
          project: { id: 'l2', name: 'Lib two', session: makeSession() },
          assets: [
            {
              key: 'sourceFile',
              name: 'two-src.wav',
              dataBase64: Buffer.from('two-src').toString('base64'),
            },
          ],
        },
      ],
    }),
    'utf8',
  );
  // Any second path read after the classifying io.open trips this injected
  // fault, so both imports succeeding proves unified routing reads every
  // byte through the already-open FileHandle.
  const noPathReads = {
    readFile: async () => {
      throw new Error('injected readFile fault');
    },
  };
  const inDir = makeRoot(t, 'vs-router-noread-in-');

  const projectStoreRoot = makeRoot(t, 'vs-router-noread-p-');
  const projectFixturePath = await writeFixture(
    inDir,
    'probe-project.json',
    projectDoc,
  );
  const importedProject = await makeService(t, projectStoreRoot, {
    fs: noPathReads,
  }).importBundle(projectFixturePath);
  assert.deepEqual(
    importedProject.map((project) => project.id),
    ['vs-test-001'],
    'project v1: import succeeds and normalizes without a path re-read',
  );
  assert.equal(
    importedProject[0].createdAt,
    FIXED_NOW,
    'project v1: stamped creation time',
  );
  assertPlacedUnderFinalDir(importedProject[0], projectStoreRoot, 'project v1');
  assert.equal(
    fs.readFileSync(importedProject[0].session.chunks[0].filePath, 'utf8'),
    'v1-c0',
    'project v1: chunk payload materialized from the parsed document',
  );
  assertCleanStore(projectStoreRoot, ['vs-test-001']);

  const libraryStoreRoot = makeRoot(t, 'vs-router-noread-l-');
  const libraryFixturePath = await writeFixture(
    inDir,
    'probe-library.json',
    libraryDoc,
  );
  const importedLibrary = await makeService(t, libraryStoreRoot, {
    fs: noPathReads,
  }).importBundle(libraryFixturePath);
  assert.deepEqual(
    importedLibrary.map((project) => project.id),
    ['vs-test-001', 'vs-test-002'],
    'library v1: import succeeds and normalizes without a path re-read',
  );
  for (const project of importedLibrary) {
    assert.equal(project.createdAt, FIXED_NOW);
    assertPlacedUnderFinalDir(project, libraryStoreRoot, 'library v1');
  }
  assertCleanStore(libraryStoreRoot, ['vs-test-001', 'vs-test-002']);
});
