'use strict';

// DOC-08 — deterministic derived exports and IPC wiring.
//
// The tests exercise the real importer after every format export. TXT/MD are
// canonicalized until a second export is byte-identical; DOCX/PDF are checked
// through the real structural import path. A small store-backed case proves
// language isolation, warning propagation, atomic output, and path safety.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');

const { getFixture } = require('./fixtures/document-fixtures.js');
const { importDocument } = require('../electron/main/documents/import.js');
const {
  createDocumentExportService,
  makeZip,
  exportDocument,
} = require('../electron/main/documents/export.js');
const { DocumentProjectStore } = require('../electron/main/documents/documentProjectStore.js');
const { AppError } = require('../shared/contracts/errors.ts');
const {
  DOCUMENT_EXPORT_COMMAND,
  DOCUMENT_EXPORT_FORMATS,
  validateDocumentArchive,
} = require('../shared/contracts/documents.ts');

function sha256Text(text) {
  return crypto.createHash('sha256').update(text, 'utf8').digest('hex');
}

function project(projectId, document) {
  return {
    schemaVersion: 3,
    projectId,
    revision: '1',
    type: 'document',
    metadata: { name: document.title, sourceFileName: document.sourceAsset.fileName },
    documentState: {
      sourceFileName: document.sourceAsset.fileName,
      title: document.title,
      sourceLang: 'en',
      targetLang: 'de',
      translationProvider: 'test',
    },
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z',
    assets: [],
  };
}

function archive(projectId, document) {
  return {
    schemaVersion: 1,
    projectId,
    format: document.format,
    title: document.title,
    sourceAsset: document.sourceAsset,
    preflight: document.preflight,
    blocks: document.blocks,
    editBaselines: {},
    blockPolicies: {},
    spanPolicies: {},
    editEpoch: 0,
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z',
  };
}

function directExport(document, format) {
  return exportDocument({ document, format });
}

for (const format of DOCUMENT_EXPORT_FORMATS) {
  test(`DOC-08 export format ${format} is non-empty and deterministic`, async () => {
    const imported = await importDocument(getFixture(format === 'docx' || format === 'pdf' ? format : format));
    const first = directExport(imported, format);
    const secondDocument = await importDocument({
      buffer: first.buffer,
      fileName: `roundtrip.${format}`,
      assetRef: `asset://roundtrip/${format}`,
    });
    const second = directExport(secondDocument, format);
    assert.ok(first.bytes > 0);
    assert.deepEqual(Buffer.from(second.buffer), Buffer.from(first.buffer));
  });
}

test('TXT round-trip preserves normalized block text', async () => {
  const imported = await importDocument(getFixture('txt'));
  const result = directExport(imported, 'txt');
  const reopened = await importDocument({
    buffer: result.buffer,
    fileName: 'roundtrip.txt',
    assetRef: 'asset://roundtrip/txt',
  });
  assert.deepEqual(reopened.blocks.map((block) => block.text), imported.blocks.map((block) => block.text));
});

test('MD round-trip preserves headings, inline traits, lists, tables, and code blocks', async () => {
  const imported = await importDocument(getFixture('md'));
  const first = directExport(imported, 'md');
  const reopened = await importDocument({
    buffer: first.buffer,
    fileName: 'roundtrip.md',
    assetRef: 'asset://roundtrip/md',
  });
  assert.deepEqual(
    reopened.blocks.map(({ kind, level, text }) => ({ kind, level, text })),
    imported.blocks.map(({ kind, level, text }) => ({ kind, level, text })),
  );
});

test('DOCX export re-import preserves main block structure and header content', async () => {
  const imported = await importDocument(getFixture('docx'));
  const result = directExport(imported, 'docx');
  assert.equal(result.buffer.subarray(0, 2).toString('ascii'), 'PK');
  const reopened = await importDocument({
    buffer: result.buffer,
    fileName: 'roundtrip.docx',
    assetRef: 'asset://roundtrip/docx',
  });
  assert.deepEqual(
    reopened.blocks.filter((block) => block.part === 'main').map(({ kind, level, text }) => ({ kind, level, text })),
    imported.blocks.filter((block) => block.part === 'main').map(({ kind, level, text }) => ({ kind, level, text })),
  );
  assert.deepEqual(
    reopened.blocks.filter((block) => block.part === 'header').map((block) => block.text),
    imported.blocks.filter((block) => block.part === 'header').map((block) => block.text),
  );
});

test('DOCX package rejects absolute and backslash entry names', () => {
  for (const name of ['/absolute.xml', '\\absolute.xml', 'word\\document.xml']) {
    assert.throws(
      () => makeZip([{ name, data: Buffer.from('x') }]),
      (error) => error instanceof AppError && error.code === 'CORRUPT_DATA',
    );
  }
});

test('PDF export is a valid readable text-layer document', async () => {
  const imported = await importDocument(getFixture('pdf'));
  const result = directExport(imported, 'pdf');
  assert.match(result.buffer.toString('latin1', 0, 8), /^%PDF-1\.[34]/);
  assert.equal(result.buffer.subarray(-5).toString('ascii'), '%%EOF');
  const reopened = await importDocument({
    buffer: result.buffer,
    fileName: 'roundtrip.pdf',
    assetRef: 'asset://roundtrip/pdf',
  });
  assert.deepEqual(reopened.blocks.map((block) => block.text), imported.blocks.map((block) => block.text));
  assert.equal(reopened.preflight.canImport, true);
});

test('stored language export uses only the selected translation and reports review warnings', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'vscript-export-'));
  try {
    const store = new DocumentProjectStore({ baseDir: root });
    const imported = await importDocument(getFixture('txt'));
    const projectId = 'export-project';
    const created = store.createDocumentProject(project(projectId, imported), archive(projectId, imported));
    const added = store.addLanguage(projectId, 'de', {
      provider: 'test',
      model: 'fixture',
      profile: 'default',
      promptVersion: '1',
      glossaryRevision: '1',
      sourceHash: imported.sourceAsset.hash,
    }, created.project.revision);
    const entries = imported.blocks.map((block, index) => ({
      blockId: block.blockId,
      text: `Deutsch ${index + 1}.`,
      sourceHash: sha256Text(block.text),
      status: index === 0 ? 'needs-review' : 'approved',
      updatedAt: '2026-01-01T00:00:00.000Z',
    }));
    store.saveTranslationArchive(projectId, 'de', {
      ...added.archive,
      blocks: Object.fromEntries(entries.map((entry) => [entry.blockId, entry])),
    }, added.revision);
    const service = createDocumentExportService({ store });
    const outputPath = path.join(root, 'exports', 'translated.txt');
    const result = service.exportDocument({ projectId, language: 'de', format: 'txt', outputPath });
    assert.equal(result.language, 'de');
    assert.equal(fs.readFileSync(outputPath, 'utf8'), 'Deutsch 1.\n\nDeutsch 2.');
    assert.deepEqual(result.warnings.map((warning) => warning.code), ['NEEDS_REVIEW']);
    const reopened = await importDocument({
      buffer: result.buffer,
      fileName: 'translated.txt',
      assetRef: 'asset://translated',
    });
    assert.deepEqual(reopened.blocks.map((block) => block.text), ['Deutsch 1.', 'Deutsch 2.']);
    assert.equal(validateDocumentArchive(store.loadDocumentArchive(projectId)).ok, true);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('export output rejects traversal and symlink targets without writing outside the target', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'vscript-export-safe-'));
  const outside = fs.mkdtempSync(path.join(os.tmpdir(), 'vscript-export-outside-'));
  try {
    const imported = await importDocument(getFixture('txt'));
    assert.doesNotThrow(() => directExport(imported, 'txt'));
    assert.throws(
      () => exportDocument({ document: imported, format: 'txt', outputPath: `${root}/../escape.txt` }),
      (error) => error instanceof AppError && error.code === 'PERMISSION_DENIED',
    );
    const hostile = {
      ...imported,
      blocks: imported.blocks.map((block, index) =>
        index === 0 ? { ...block, text: `${block.text}\u0001`, spans: [] } : block,
      ),
    };
    assert.throws(
      () => directExport(hostile, 'docx'),
      (error) => error instanceof AppError && error.code === 'VALIDATION_FAILED',
    );
    const target = path.join(root, 'linked.txt');
    fs.symlinkSync(path.join(outside, 'outside.txt'), target);
    assert.throws(
      () => exportDocument({ document: imported, format: 'txt', outputPath: target }),
      (error) => error instanceof AppError && error.code === 'PERMISSION_DENIED',
    );
    assert.equal(fs.existsSync(path.join(outside, 'outside.txt')), false);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
    fs.rmSync(outside, { recursive: true, force: true });
  }
});

test('export output rejects a pre-planted parent symlink before creating directories', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'vscript-export-parent-link-'));
  const outside = fs.mkdtempSync(path.join(os.tmpdir(), 'vscript-export-parent-outside-'));
  try {
    const imported = await importDocument(getFixture('txt'));
    const parent = path.join(root, 'exports');
    fs.symlinkSync(outside, parent, 'dir');
    assert.throws(
      () => exportDocument({
        document: imported,
        format: 'txt',
        outputPath: path.join(parent, 'nested', 'result.txt'),
      }),
      (error) => error instanceof AppError && error.code === 'PERMISSION_DENIED',
    );
    assert.equal(fs.existsSync(path.join(outside, 'nested')), false);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
    fs.rmSync(outside, { recursive: true, force: true });
  }
});

test('document export IPC handler routes the typed command', async () => {
  const { createRequest } = await import('../shared/contracts/ipc.ts');
  const { dispatch, createDocumentExportHandlers } = await import('../electron/main/ipc/index.mts');
  let seen = null;
  const handlers = createDocumentExportHandlers({
    exportDocument(request) {
      seen = request;
      return { format: request.format, language: null };
    },
  });
  const result = await dispatch(createRequest({
    method: DOCUMENT_EXPORT_COMMAND,
    args: { projectId: 'p', format: 'txt', language: null },
  }), handlers);
  assert.equal(result.ok, true);
  assert.equal(seen.projectId, 'p');
  assert.equal(result.value.format, 'txt');
});

test('document export IPC handler whitelists renderer fields and loads from the store', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'vscript-export-ipc-store-'));
  try {
    const imported = await importDocument(getFixture('txt'));
    const projectId = 'ipc-store-project';
    const store = new DocumentProjectStore({ baseDir: root });
    const created = store.createDocumentProject(project(projectId, imported), archive(projectId, imported));
    const expected = directExport(imported, 'txt');
    const injectedDocument = {
      ...imported,
      blocks: imported.blocks.map((block, index) =>
        index === 0 ? { ...block, text: 'renderer-injected' } : block,
      ),
    };
    const { createRequest } = await import('../shared/contracts/ipc.ts');
    const { dispatch, createDocumentExportHandlers } = await import('../electron/main/ipc/index.mts');
    const result = await dispatch(createRequest({
      method: DOCUMENT_EXPORT_COMMAND,
      args: {
        projectId,
        format: 'txt',
        language: null,
        document: injectedDocument,
        archive: { injected: true },
        translation: { injected: true },
      },
    }), createDocumentExportHandlers(store));
    assert.equal(result.ok, true);
    assert.deepEqual(Buffer.from(result.value.buffer), Buffer.from(expected.buffer));
    assert.equal(result.value.revision, String(created.project.revision));
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});
