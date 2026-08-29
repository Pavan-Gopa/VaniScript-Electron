'use strict';

/**
 * P3E.D3-S4-A coverage for the file-export catalogue: the exact three-tool
 * surface with file scope, permission gating on every tool, argument
 * validation that fires before any dependency call, typed capability
 * failures for missing injections, and the three orchestration happy paths.
 */

const { test } = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');

const {
  EXPORT_ERROR_CODES,
  EXPORT_TOOL_DEFINITIONS,
  EXPORT_TOOL_NAMES,
  createExportCatalog,
} = require('../electron/main/mcp/mcpTools/exportCatalog.js');

const FIXTURE_DIR = '/fixtures/exports';

function makeFixture(options = {}) {
  const { omit = [], ...overrides } = options;
  const calls = {
    buildTranscriptArtifact: [],
    createExportDirectory: [],
    writeFile: [],
    registerFiles: [],
    resolveProject: [],
    bundleWriter: [],
    revealRecord: [],
    shellReveal: [],
  };
  const deps = {
    filePermissionEnabled: true,
    buildTranscriptArtifact: async () => ({ content: '# Transcript\n', fileName: 'lecture.txt' }),
    createExportDirectory: async (label) => ({ id: 'export-1', dir: `${FIXTURE_DIR}/${label}-1a2b3c4d` }),
    writeFile: async () => {},
    registerFiles: async (id, files) => ({
      exportId: id,
      files: [{ fileName: path.basename(files[0]), sizeBytes: 32 }],
      fileCount: files.length,
    }),
    resolveProject: async () => ({ id: 'project-9', name: 'Morning Lecture' }),
    bundleWriter: async () => {},
    revealRecord: async () => ({ id: 'export-1', files: [`${FIXTURE_DIR}/Transcript-1a2b3c4d/lecture.txt`] }),
    shellReveal: async () => {},
    ...overrides,
  };
  for (const name of omit) delete deps[name];
  // One uniform recorder: overrides replace implementations, never telemetry,
  // so assertions always observe exactly what the handlers invoked.
  const recorded = { filePermissionEnabled: deps.filePermissionEnabled };
  for (const [name, impl] of Object.entries(deps)) {
    if (name === 'filePermissionEnabled') continue;
    if (typeof impl !== 'function') { recorded[name] = impl; continue; }
    recorded[name] = async (...invocation) => {
      calls[name].push(invocation);
      return impl(...invocation);
    };
  }
  const catalog = createExportCatalog(recorded);
  const assertNoDependencyCalls = () => {
    for (const [name, list] of Object.entries(calls)) {
      assert.equal(list.length, 0, `dependency ${name} must not be called`);
    }
  };
  return { catalog, calls, assertNoDependencyCalls };
}

function assertErrorCode(code) {
  return (error) => {
    assert.equal(error.code, code);
    assert.equal(error.mcpCode, code);
    return true;
  };
}

test('catalog exposes exactly the three file-scope tools with canonical schemas', () => {
  assert.deepEqual([...EXPORT_TOOL_NAMES], ['export_transcript', 'export_project_bundle', 'reveal_export']);
  const { catalog } = makeFixture();
  assert.equal(catalog.scope, 'files');
  assert.equal(catalog.requiresFilePermission, true);
  assert.equal(catalog.definitions, EXPORT_TOOL_DEFINITIONS);

  const byName = new Map(catalog.definitions.map((tool) => [tool.name, tool]));
  for (const tool of catalog.definitions) {
    assert.equal(tool.scope, 'files');
    assert.equal(tool.risk, 'files');
    assert.equal(tool.riskLevel, 'files');
    assert.deepEqual(tool.capabilities, ['mcp.files']);
    assert.equal(tool.confirmationText, null);
  }

  const transcript = byName.get('export_transcript');
  assert.deepEqual(transcript.inputSchema.required, ['side', 'format']);
  assert.deepEqual(transcript.inputSchema.properties.side.enum, ['original', 'translated']);
  assert.deepEqual(transcript.inputSchema.properties.format.enum, ['txt', 'markdown', 'srt', 'vtt']);
  assert.equal(transcript.inputSchema.properties.language.type, 'string');

  const bundle = byName.get('export_project_bundle');
  assert.equal(bundle.inputSchema.required, undefined);
  assert.equal(bundle.inputSchema.properties.projectId.type, 'string');

  const reveal = byName.get('reveal_export');
  assert.deepEqual(reveal.inputSchema.required, ['exportId']);

  for (const name of EXPORT_TOOL_NAMES) {
    assert.equal(typeof catalog.handlers[name], 'function');
    assert.equal(catalog.get(name), catalog.handlers[name]);
  }
});

test('disabling the file permission denies all three tools before any dependency call', async () => {
  const { catalog, assertNoDependencyCalls } = makeFixture({ filePermissionEnabled: false });
  await assert.rejects(
    catalog.handlers.export_transcript({ side: 'original', format: 'txt' }),
    assertErrorCode(EXPORT_ERROR_CODES.PERMISSION_DENIED),
  );
  await assert.rejects(
    catalog.handlers.export_project_bundle({ projectId: 'p' }),
    assertErrorCode(EXPORT_ERROR_CODES.PERMISSION_DENIED),
  );
  await assert.rejects(
    catalog.handlers.reveal_export({ exportId: 'export-1' }),
    assertErrorCode(EXPORT_ERROR_CODES.PERMISSION_DENIED),
  );
  assertNoDependencyCalls();
});

test('transcript argument validation rejects before any dependency call', async () => {
  const invalidArgs = [
    {},
    { side: 'sideways', format: 'txt' },
    { side: 'original' },
    { side: 'original', format: 'docx' },
    { side: 'original', format: 'txt', language: '   ' },
    { side: 'translated', format: 'txt', language: 42 }, // non-string language
  ];
  for (const args of invalidArgs) {
    const { catalog, assertNoDependencyCalls } = makeFixture();
    await assert.rejects(
      catalog.handlers.export_transcript(args),
      assertErrorCode(EXPORT_ERROR_CODES.INVALID_REQUEST),
      JSON.stringify(args),
    );
    assertNoDependencyCalls();
  }
});

test('bundle and reveal argument validation rejects before any dependency call', async () => {
  for (const args of [{ projectId: 42 }, { projectId: '' }]) {
    const { catalog, assertNoDependencyCalls } = makeFixture();
    await assert.rejects(
      catalog.handlers.export_project_bundle(args),
      assertErrorCode(EXPORT_ERROR_CODES.INVALID_REQUEST),
      JSON.stringify(args),
    );
    assertNoDependencyCalls();
  }
  for (const args of [{}, { exportId: '' }]) {
    const { catalog, assertNoDependencyCalls } = makeFixture();
    await assert.rejects(
      catalog.handlers.reveal_export(args),
      assertErrorCode(EXPORT_ERROR_CODES.INVALID_REQUEST),
      JSON.stringify(args),
    );
    assertNoDependencyCalls();
  }
});

test('missing injected dependencies fail with CAPABILITY_UNAVAILABLE', async () => {
  const transcriptArgs = { side: 'original', format: 'txt' };
  const cases = [
    ['export_transcript', transcriptArgs, 'buildTranscriptArtifact'],
    ['export_transcript', transcriptArgs, 'createExportDirectory'],
    ['export_transcript', transcriptArgs, 'writeFile'],
    ['export_transcript', transcriptArgs, 'registerFiles'],
    ['export_project_bundle', {}, 'resolveProject'],
    ['export_project_bundle', {}, 'createExportDirectory'],
    ['export_project_bundle', {}, 'bundleWriter'],
    ['export_project_bundle', {}, 'registerFiles'],
    ['reveal_export', { exportId: 'export-1' }, 'revealRecord'],
    ['reveal_export', { exportId: 'export-1' }, 'shellReveal'],
  ];
  for (const [tool, args, missing] of cases) {
    const { catalog } = makeFixture({ omit: [missing] });
    await assert.rejects(catalog.handlers[tool](args), (error) => {
      assert.equal(error.code, EXPORT_ERROR_CODES.CAPABILITY_UNAVAILABLE, missing);
      assert.ok(Array.isArray(error.details.missingCapabilities), missing);
      assert.ok(error.details.missingCapabilities.includes(missing), missing);
      return true;
    });
  }
});

test('export_transcript builds once, writes UTF-8 under the made directory, registers, and projects without paths', async () => {
  const { catalog, calls } = makeFixture();
  const result = await catalog.handlers.export_transcript({ side: 'original', format: 'txt' });

  assert.deepEqual(calls.createExportDirectory, [['Transcript']]);
  assert.deepEqual(calls.buildTranscriptArtifact, [[{ side: 'original', format: 'txt', language: null }]]);
  assert.equal(calls.writeFile.length, 1);
  const [destPath, content] = calls.writeFile[0];
  assert.equal(destPath, path.join(`${FIXTURE_DIR}/Transcript-1a2b3c4d`, 'lecture.txt'));
  assert.equal(content, '# Transcript\n');
  assert.deepEqual(calls.registerFiles, [['export-1', [destPath]]]);

  assert.deepEqual(result, {
    exportId: 'export-1',
    files: [{ fileName: 'lecture.txt', sizeBytes: 32 }],
    fileCount: 1,
  });
  assert.ok(!JSON.stringify(result).includes(FIXTURE_DIR), 'result must not contain absolute paths');
});

test('explicit translation language passes through to the builder', async () => {
  const { catalog, calls } = makeFixture();
  await catalog.handlers.export_transcript({ side: 'translated', format: 'srt', language: 'Russian' });
  assert.deepEqual(calls.buildTranscriptArtifact[0][0], {
    side: 'translated',
    format: 'srt',
    language: 'Russian',
  });
});

test('omitted translated-side language reaches the builder as null for renderer fallback', async () => {
  const { catalog, calls } = makeFixture();
  await catalog.handlers.export_transcript({ side: 'translated', format: 'txt' });
  assert.deepEqual(calls.buildTranscriptArtifact[0][0], {
    side: 'translated',
    format: 'txt',
    language: null,
  });
  assert.equal(calls.writeFile.length, 1);
});

test('empty or dot basenames fail typed before any write', async () => {
  // Native lastPathComponent parity: basename is taken FIRST and only the
  // result is safety-checked; raw separator presence alone never rejects.
  const unsafeNames = ['..', '.', ''];
  if (process.platform !== 'win32') {
    unsafeNames.push('back\\slash.txt', '..\\..\\notes.md');
  }
  for (const fileName of unsafeNames) {
    const { catalog, calls } = makeFixture({
      buildTranscriptArtifact: async () => ({ content: '# Transcript\n', fileName }),
    });
    await assert.rejects(
      catalog.handlers.export_transcript({ side: 'original', format: 'txt' }),
      assertErrorCode(EXPORT_ERROR_CODES.INVALID_REQUEST),
      JSON.stringify(fileName),
    );
    assert.equal(calls.createExportDirectory.length, 0, JSON.stringify(fileName));
    assert.equal(calls.writeFile.length, 0, JSON.stringify(fileName));
    assert.equal(calls.registerFiles.length, 0, JSON.stringify(fileName));
  }
});

test('artifact names carrying raw paths compose from their lastPathComponent inside the export dir', async () => {
  const { catalog, calls } = makeFixture({
    buildTranscriptArtifact: async () => ({ content: '# Transcript\n', fileName: '/absent/dir/transcript.txt' }),
  });
  const result = await catalog.handlers.export_transcript({ side: 'original', format: 'txt' });
  const destPath = path.join(`${FIXTURE_DIR}/Transcript-1a2b3c4d`, 'transcript.txt');
  assert.deepEqual(calls.writeFile, [[destPath, '# Transcript\n']]);
  assert.deepEqual(calls.registerFiles, [['export-1', [destPath]]]);
  assert.deepEqual(result.files, [{ fileName: 'transcript.txt', sizeBytes: 32 }]);
});

test('empty transcript content fails as NOT_FOUND without creating a directory', async () => {
  const { catalog, calls } = makeFixture({
    buildTranscriptArtifact: async () => ({ content: '', fileName: 'empty.txt' }),
  });
  await assert.rejects(
    catalog.handlers.export_transcript({ side: 'original', format: 'txt' }),
    assertErrorCode(EXPORT_ERROR_CODES.NOT_FOUND),
  );
  assert.equal(calls.createExportDirectory.length, 0);
  assert.equal(calls.writeFile.length, 0);
  assert.equal(calls.registerFiles.length, 0);
});

test('export_project_bundle resolves, sanitizes the stem, writes once, and registers', async () => {
  const projectName = 'Утренняя Лекция: Часть 2!';
  const stem = 'Утренняя-Лекция-Часть-2';
  const { catalog, calls } = makeFixture({
    resolveProject: async () => ({ id: 'project-7', name: projectName }),
  });
  const result = await catalog.handlers.export_project_bundle({ projectId: 'project-7' });

  assert.deepEqual(calls.resolveProject, [['project-7']]);
  assert.deepEqual(calls.createExportDirectory, [[stem]]);
  assert.equal(calls.bundleWriter.length, 1);
  const [project, destPath] = calls.bundleWriter[0];
  assert.deepEqual(project, { id: 'project-7', name: projectName });
  assert.equal(destPath, path.join(`${FIXTURE_DIR}/${stem}-1a2b3c4d`, `${stem}.vaniscript`));
  assert.deepEqual(calls.registerFiles, [['export-1', [destPath]]]);
  assert.deepEqual(result.files, [{ fileName: `${stem}.vaniscript`, sizeBytes: 32 }]);
});

test('bundle export falls back to the default stem for unusable project names', async () => {
  const { catalog, calls } = makeFixture({
    resolveProject: async () => ({ id: 'p-1', name: '///***' }),
  });
  await catalog.handlers.export_project_bundle({ projectId: 'p-1' });
  assert.deepEqual(calls.resolveProject, [['p-1']]);
  assert.deepEqual(calls.createExportDirectory, [['VaniScript-Project']]);
});

test('active-project resolution passes undefined and null resolves to typed NOT_FOUND', async () => {
  const active = makeFixture();
  await active.catalog.handlers.export_project_bundle({});
  assert.deepEqual(active.calls.resolveProject, [[undefined]]);

  for (const args of [{}, { projectId: 'gone' }]) {
    const { catalog, calls } = makeFixture({ resolveProject: async () => null });
    await assert.rejects(
      catalog.handlers.export_project_bundle(args),
      assertErrorCode(EXPORT_ERROR_CODES.NOT_FOUND),
    );
    assert.equal(calls.bundleWriter.length, 0);
    assert.equal(calls.registerFiles.length, 0);
  }
});

test('reveal_export shells out to the first completed file and returns the public shape', async () => {
  const { catalog, calls } = makeFixture();
  const result = await catalog.handlers.reveal_export({ exportId: 'export-1' });

  assert.deepEqual(calls.revealRecord, [['export-1']]);
  assert.deepEqual(calls.shellReveal, [[`${FIXTURE_DIR}/Transcript-1a2b3c4d/lecture.txt`]]);
  assert.deepEqual(result, { success: true, exportId: 'export-1', fileName: 'lecture.txt' });
});

test('reveal_export maps unknown or empty records to typed NOT_FOUND without revealing', async () => {
  const empty = makeFixture({ revealRecord: async () => ({ id: 'export-1', files: [] }) });
  await assert.rejects(
    empty.catalog.handlers.reveal_export({ exportId: 'x' }),
    assertErrorCode(EXPORT_ERROR_CODES.NOT_FOUND),
  );
  assert.equal(empty.calls.shellReveal.length, 0);

  const storeStyle = makeFixture({
    revealRecord: async () => {
      const error = new Error('Unknown exportId or no completed files.');
      error.code = 'MCP_EXPORT_NOT_FOUND';
      throw error;
    },
  });
  await assert.rejects(
    storeStyle.catalog.handlers.reveal_export({ exportId: 'x' }),
    assertErrorCode(EXPORT_ERROR_CODES.NOT_FOUND),
  );
  assert.equal(storeStyle.calls.shellReveal.length, 0);
});
