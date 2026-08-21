'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const fsp = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');

const archiver = require('archiver');

const {
  createProjectBundle,
  exportProjectBundle,
  importProjectBundle,
  parseEntryName,
  verifyManifest,
} = require('../electron/main/projects/bundle.js');
const { createProjectStore } = require('../electron/main/projects/projectStore.js');
const { isAppError } = require('../shared/contracts/errors.ts');

// --- Fixtures ----------------------------------------------------------------

function validMedia() {
  return {
    schemaVersion: 3,
    projectId: 'p3',
    revision: '7',
    type: 'media',
    mediaState: {
      sourceFile: null,
      sourceFileName: 'a.wav',
      durationSec: 5,
      sourceLang: 'en',
      targetLang: 'de',
      transcriptionProvider: 'x',
      translationProvider: 'y',
      outputFormats: ['SRT'],
      chunks: [],
      currentChunkIndex: 0,
    },
    metadata: { name: 'A', sourceFileName: 'a.wav' },
    createdAt: '2024-01-01T00:00:00.000Z',
    updatedAt: '2024-01-01T00:00:00.000Z',
    assets: [],
  };
}

// --- Helpers -----------------------------------------------------------------

async function tmpBaseDir() {
  return fsp.mkdtemp(path.join(os.tmpdir(), 'vsbundle-test-'));
}

async function makeArchivedZip(outPath, entries) {
  // entries: { [name]: Buffer|string } — archiver normalizes names, so only use
  // safe (relative) names here.
  await new Promise((resolve, reject) => {
    const output = fs.createWriteStream(outPath);
    const archive = archiver('zip', { zlib: { level: 9 } });
    output.on('close', resolve);
    output.on('error', reject);
    archive.on('error', reject);
    archive.pipe(output);
    for (const [name, content] of Object.entries(entries)) {
      archive.append(typeof content === 'string' ? Buffer.from(content) : content, { name });
    }
    archive.finalize();
  });
}

// Build a raw STORED zip whose entry names are preserved verbatim, so we can
// forge malicious names (Zip Slip, absolute) that archiver would otherwise
// sanitize. yauzl does not enforce CRC, so crc=0 is acceptable.
function makeRawZip(filePath, entries) {
  const parts = [];
  const central = [];
  let offset = 0;
  for (const e of entries) {
    const nameBuf = Buffer.from(e.name, 'utf8');
    const data = Buffer.isBuffer(e.data) ? e.data : Buffer.from(e.data);
    const crc = 0;

    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt16LE(0, 6);
    local.writeUInt16LE(0, 8); // stored
    local.writeUInt16LE(0, 10);
    local.writeUInt16LE(0, 12);
    local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(data.length, 18);
    local.writeUInt32LE(data.length, 22);
    local.writeUInt16LE(nameBuf.length, 26);
    local.writeUInt16LE(0, 28);
    parts.push(local, nameBuf, data);
    const localOffset = offset;
    offset += local.length + nameBuf.length + data.length;

    const cd = Buffer.alloc(46);
    cd.writeUInt32LE(0x02014b50, 0);
    cd.writeUInt16LE(20, 4);
    cd.writeUInt16LE(20, 6);
    cd.writeUInt16LE(0, 8);
    cd.writeUInt16LE(0, 10);
    cd.writeUInt16LE(0, 12);
    cd.writeUInt16LE(0, 14);
    cd.writeUInt32LE(crc, 16);
    cd.writeUInt32LE(data.length, 20);
    cd.writeUInt32LE(data.length, 24);
    cd.writeUInt16LE(nameBuf.length, 28);
    cd.writeUInt16LE(0, 30);
    cd.writeUInt16LE(0, 32);
    cd.writeUInt16LE(0, 34);
    cd.writeUInt16LE(0, 36);
    cd.writeUInt32LE(0, 38);
    cd.writeUInt32LE(localOffset, 42);
    central.push(cd, nameBuf);
  }
  const centralBuf = Buffer.concat(central);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(0, 4);
  end.writeUInt16LE(0, 6);
  end.writeUInt16LE(entries.length, 8);
  end.writeUInt16LE(entries.length, 10);
  end.writeUInt32LE(centralBuf.length, 12);
  end.writeUInt32LE(offset, 16);
  end.writeUInt16LE(0, 20);
  fs.writeFileSync(filePath, Buffer.concat([...parts, centralBuf, end]));
}

function codeOf(err) {
  return isAppError(err) ? err.code : (err && err.code) || undefined;
}

// --- parseEntryName unit tests ----------------------------------------------

test('parseEntryName accepts nested and root files, rejects traversal', () => {
  assert.equal(parseEntryName('project.json').posix, 'project.json');
  assert.equal(parseEntryName('assets/notes.txt').posix, 'assets/notes.txt');
  assert.equal(parseEntryName('a/b/c.json').posix, 'a/b/c.json');
  assert.throws(() => parseEntryName('../escape.txt'), (e) => codeOf(e) === 'ZIP_SLIP');
  assert.throws(() => parseEntryName('a/../../b.txt'), (e) => codeOf(e) === 'ZIP_SLIP');
  assert.throws(() => parseEntryName('../../etc/passwd'), (e) => codeOf(e) === 'ZIP_SLIP');
});

test('parseEntryName rejects absolute and drive-letter paths', () => {
  assert.throws(() => parseEntryName('/etc/passwd'), (e) => codeOf(e) === 'INVALID_BUNDLE');
  assert.throws(() => parseEntryName('C:\\windows\\evil'), (e) => codeOf(e) === 'INVALID_BUNDLE');
  assert.throws(() => parseEntryName('D:/evil.txt'), (e) => codeOf(e) === 'INVALID_BUNDLE');
});

test('verifyManifest detects missing, extra, and tampered entries', () => {
  const manifest = {
    entries: [
      { path: 'project.json', checksum: 'abc', size: 10 },
      { path: 'assets/x.txt', checksum: 'def', size: 3 },
    ],
  };
  assert.throws(
    () => verifyManifest(manifest, new Map([['project.json', { checksum: 'abc', size: 10 }]])),
    (e) => codeOf(e) === 'INVALID_BUNDLE',
  );
  assert.throws(
    () =>
      verifyManifest(
        manifest,
        new Map([
          ['project.json', { checksum: 'abc', size: 10 }],
          ['assets/x.txt', { checksum: 'WRONG', size: 3 }],
        ]),
      ),
    (e) => codeOf(e) === 'INVALID_BUNDLE',
  );
  assert.throws(
    () =>
      verifyManifest(
        manifest,
        new Map([
          ['project.json', { checksum: 'abc', size: 10 }],
          ['assets/x.txt', { checksum: 'def', size: 3 }],
          ['extra.txt', { checksum: 'zzz', size: 1 }],
        ]),
      ),
    (e) => codeOf(e) === 'INVALID_BUNDLE',
  );
  // Exact match passes silently.
  assert.doesNotThrow(() =>
    verifyManifest(
      manifest,
      new Map([
        ['project.json', { checksum: 'abc', size: 10 }],
        ['assets/x.txt', { checksum: 'def', size: 3 }],
      ]),
    ),
  );
});

// --- Pack / unpack round-trip ------------------------------------------------

test('export + import round-trips a ProjectV3 with assets', async () => {
  const baseA = await tmpBaseDir();
  const baseB = await tmpBaseDir();
  try {
    const storeA = createProjectStore({ baseDir: baseA });
    const storeB = createProjectStore({ baseDir: baseB });

    const project = validMedia();
    await storeA.saveProject(project, null);
    // Add a side asset that the bundle must carry.
    await fsp.mkdir(path.join(baseA, 'p3', 'assets'), { recursive: true });
    await fsp.writeFile(path.join(baseA, 'p3', 'assets', 'notes.txt'), 'hello-asset');

    const bundlePath = path.join(baseA, 'p3.vsbundle');
    const exported = await createProjectBundle(storeA).exportProjectBundle('p3', bundlePath);

    assert.ok(fs.existsSync(bundlePath));
    assert.equal(exported.projectId, 'p3');
    assert.ok(Array.isArray(exported.manifest.entries));
    const names = exported.manifest.entries.map((e) => e.path).sort();
    assert.deepEqual(names, ['assets/notes.txt', 'project.json']);

    const imported = await createProjectBundle(storeB).importProjectBundle(bundlePath);
    assert.equal(imported.projectId, 'p3');
    assert.equal(imported.project.schemaVersion, 3);
    assert.equal(imported.project.metadata.name, 'A');

    const loaded = await storeB.loadProject('p3');
    assert.equal(loaded.projectId, 'p3');
    assert.equal(
      await fsp.readFile(path.join(baseB, 'p3', 'assets', 'notes.txt'), 'utf8'),
      'hello-asset',
    );
    assert.equal(fs.existsSync(path.join(baseB, 'p3', 'project.json')), true);
  } finally {
    await fsp.rm(baseA, { recursive: true, force: true });
    await fsp.rm(baseB, { recursive: true, force: true });
  }
});

test('import rejects a Zip Slip traversal entry (no escape written)', async () => {
  const base = await tmpBaseDir();
  try {
    const store = createProjectStore({ baseDir: base });
    const bundlePath = path.join(base, 'evil.zip');
    // '../../escaped.txt' should resolve outside the temp extraction root.
    makeRawZip(bundlePath, [
      { name: '../../escaped.txt', data: Buffer.from('pwned') },
      { name: 'good/sub/../../still-evil.txt', data: Buffer.from('pwned') },
    ]);

    await assert.rejects(
      () => importProjectBundle(bundlePath, { store }),
      (e) => codeOf(e) === 'ZIP_SLIP',
    );

    // Nothing was written outside the (now-removed) temp extraction root.
    assert.equal(fs.existsSync(path.resolve(os.tmpdir(), 'escaped.txt')), false);
    assert.equal(fs.existsSync(path.resolve(os.tmpdir(), 'still-evil.txt')), false);
  } finally {
    await fsp.rm(base, { recursive: true, force: true });
  }
});

test('import rejects absolute path entries', async () => {
  const base = await tmpBaseDir();
  try {
    const store = createProjectStore({ baseDir: base });
    const bundlePath = path.join(base, 'abs.zip');
    makeRawZip(bundlePath, [{ name: '/etc/pwned', data: Buffer.from('x') }]);

    await assert.rejects(
      () => importProjectBundle(bundlePath, { store }),
      (e) => codeOf(e) === 'INVALID_BUNDLE',
    );
  } finally {
    await fsp.rm(base, { recursive: true, force: true });
  }
});

test('import rejects a manifest checksum mismatch', async () => {
  const base = await tmpBaseDir();
  try {
    const store = createProjectStore({ baseDir: base });
    const bundlePath = path.join(base, 'tampered.zip');
    const projectJson = JSON.stringify(validMedia());
    const manifest = JSON.stringify({
      format: 'vaniscript-bundle-v1',
      schemaVersion: 3,
      algorithm: 'sha256',
      createdAt: new Date().toISOString(),
      projectId: 'p3',
      entries: [{ path: 'project.json', checksum: '0'.repeat(64), size: Buffer.byteLength(projectJson) }],
    });
    await makeArchivedZip(bundlePath, { 'project.json': projectJson, 'manifest.json': manifest });

    await assert.rejects(
      () => importProjectBundle(bundlePath, { store }),
      (e) => codeOf(e) === 'INVALID_BUNDLE',
    );
  } finally {
    await fsp.rm(base, { recursive: true, force: true });
  }
});

test('import rejects a bundle without project.json', async () => {
  const base = await tmpBaseDir();
  try {
    const store = createProjectStore({ baseDir: base });
    const bundlePath = path.join(base, 'noproj.zip');
    await makeArchivedZip(bundlePath, { 'readme.txt': 'no project here', 'manifest.json': JSON.stringify({ entries: [{ path: 'readme.txt', checksum: 'x', size: 13 }] }) });

    await assert.rejects(
      () => importProjectBundle(bundlePath, { store }),
      (e) => codeOf(e) === 'INVALID_BUNDLE',
    );
  } finally {
    await fsp.rm(base, { recursive: true, force: true });
  }
});

test('import conflicts on existing project unless overwrite is set', async () => {
  const baseA = await tmpBaseDir();
  const baseB = await tmpBaseDir();
  try {
    const storeA = createProjectStore({ baseDir: baseA });
    const storeB = createProjectStore({ baseDir: baseB });

    await storeA.saveProject(validMedia(), null);
    await storeB.saveProject(validMedia(), null);
    const bundlePath = path.join(baseA, 'p3.vsbundle');
    await createProjectBundle(storeA).exportProjectBundle('p3', bundlePath);

    await assert.rejects(
      () => importProjectBundle(bundlePath, { store: storeB }),
      (e) => codeOf(e) === 'CONFLICT',
    );

    const imported = await importProjectBundle(bundlePath, { store: storeB, overwrite: true });
    assert.equal(imported.projectId, 'p3');
    const loaded = await storeB.loadProject('p3');
    assert.equal(loaded.projectId, 'p3');
  } finally {
    await fsp.rm(baseA, { recursive: true, force: true });
    await fsp.rm(baseB, { recursive: true, force: true });
  }
});

test('export throws NOT_FOUND for an unknown project', async () => {
  const base = await tmpBaseDir();
  try {
    const store = createProjectStore({ baseDir: base });
    await assert.rejects(
      () => exportProjectBundle('ghost', path.join(base, 'x.vsbundle'), { store }),
      (e) => codeOf(e) === 'NOT_FOUND',
    );
  } finally {
    await fsp.rm(base, { recursive: true, force: true });
  }
});
