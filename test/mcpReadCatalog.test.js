const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');

const {
  McpServer,
  MCP_ERROR_CODES,
} = require('../electron/main/mcp/mcpServer.js');
const {
  READ_TOOL_DEFINITIONS,
  READ_TOOL_NAMES,
  ReadCatalogError,
  createReadCatalog,
} = require('../electron/main/mcp/mcpTools/readCatalog.js');
const helpSearchFixture = require('./fixtures/help-search.json');
const helpContextFixture = require('./fixtures/help-context.json');

class MemoryVault {
  constructor() {
    this.values = new Map();
  }

  storeSecret(key, value) {
    this.values.set(key, value);
    return true;
  }

  getSecret(key) {
    return this.values.get(key) || null;
  }

  deleteSecret(key) {
    return this.values.delete(key);
  }
}

function requestJson(server, body, options = {}) {
  const payload = JSON.stringify(body);
  const headers = {
    authorization: `Bearer ${options.token}`,
    origin: 'http://127.0.0.1',
    'content-type': 'application/json',
    'content-length': Buffer.byteLength(payload),
    ...(options.requestId ? { 'x-request-id': options.requestId } : {}),
  };
  return new Promise((resolve, reject) => {
    const req = http.request({
      host: server.host,
      port: server.getStatus().port,
      path: '/mcp',
      method: 'POST',
      headers,
      agent: false,
    }, (res) => {
      const chunks = [];
      res.on('data', (chunk) => chunks.push(chunk));
      res.on('end', () => {
        const text = Buffer.concat(chunks).toString('utf8');
        resolve({
          status: res.statusCode,
          body: text ? JSON.parse(text) : null,
        });
      });
    });
    req.on('error', reject);
    req.end(payload);
  });
}

function makeProject() {
  return {
    id: 'project-1',
    name: 'Read fixture',
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-02T00:00:00.000Z',
    screen: 'review',
    session: {
      projectId: 'project-1',
      sourceFile: '/private/source.wav',
      sourceFileName: 'source.wav',
      sourceLang: 'en',
      targetLang: 'fr',
      activeTranslationLanguage: 'French',
      availableTranslationLanguages: ['French', 'English'],
      durationSec: 4,
      currentChunkIndex: 0,
      chunks: [{
        index: 0,
        filePath: '/private/chunk.wav',
        startSec: 0,
        endSec: 4,
        durationSec: 4,
        original: 'Hare Krishna world',
        translated: 'Bonjour monde',
        status: 'done',
        approved: true,
        translationsByLanguage: {
          french: {
            language: 'French',
            text: 'Bonjour monde',
            cues: [{ startSec: 0, endSec: 2, text: 'Bonjour' }],
            provider: 'gemini-cloud',
          },
          english: {
            language: 'English',
            text: 'Hello world',
            cues: [{ startSec: 0, endSec: 2, text: 'Hello' }],
          },
        },
        originalCues: [{ startSec: 0, endSec: 2, text: 'Hare Krishna', words: [] }],
        translatedCues: [{ startSec: 0, endSec: 2, text: 'Bonjour' }],
        unrecognizedFragments: ['Krishna'],
      }],
      shortsPlans: [{
        stableID: 'plan-1',
        start: '00:00',
        end: '00:10',
        title: 'Fixture clip',
        summary: 'Fixture summary',
        hook: 'Fixture hook',
        captionText: 'Fixture caption',
        languageMode: 'source',
      }],
      shortsRejectedPlans: [],
    },
  };
}

function makeFixture() {
  const project = makeProject();
  const catalog = createReadCatalog({
    project,
    projectId: 'project-1',
    projectRevision: 'revision-1',
    settings: {
      screen: 'review',
      glossary: [{
        id: 'term-1',
        source: 'Krishna',
        translation: 'Krishna',
        variants: ['Krsna'],
        category: 'names',
        remember: true,
        createdAt: '2026-01-01T00:00:00.000Z',
        updatedAt: '2026-01-01T00:00:00.000Z',
      }],
      subtitleStyle: { fontSize: 42 },
    },
    selection: { blockId: 'block-1', start: 0, end: 7, text: 'Hare' },
    // S4-B: the two export reads resolve session truth through the injected
    // readiness reader instead of a static stub projection.
    exportReadiness: async () => makeReadiness({ shortsPlanCount: 1, sourceVideoPath: '/private/source.mp4' }),
  });
  const server = new McpServer({
    host: '127.0.0.1',
    port: 0,
    vault: new MemoryVault(),
    readCatalog: catalog,
  });
  const issued = server.rotateToken();
  return { server, issued, project };
}

function makeReadiness(overrides = {}) {
  return {
    sessionAvailable: true,
    chunkCount: 1,
    originalNonEmptyCount: 1,
    shortsPlanCount: 0,
    sourceVideoPath: '/private/source.wav',
    // Main computes this via fs.existsSync after the renderer sends the path.
    sourceVideoExists: true,
    ...overrides,
  };
}

function catalogWithReadiness(snapshot) {
  return createReadCatalog({
    projectId: 'project-1',
    projectRevision: 'revision-1',
    exportReadiness: async () => snapshot,
  });
}

function isJsonSchema(schema) {
  return schema && typeof schema === 'object' && schema.type === 'object' && schema.properties && typeof schema.properties === 'object';
}

function argumentsFor(name) {
  const args = { projectId: 'project-1' };
  if (name === 'get_project_summary') return { projectId: 'project-1' };
  if (name === 'get_chunk' || name === 'get_chunk_cues') return { ...args, chunkIndex: 0 };
  if (name === 'search_transcript' || name === 'search_glossary' || name === 'search_help') return { ...args, query: 'Krishna' };
  if (name === 'get_help_topic') return { topicId: 'getting-started' };
  if (name === 'get_shorts_plan' || name === 'validate_shorts_plan' || name === 'get_visual_editor_state') return { ...args, planId: 'plan-1' };
  if (name === 'validate_export') return { ...args, kind: 'transcript' };
  return args;
}

test('every read tool publishes valid input and result JSON schemas', () => {
  assert.equal(READ_TOOL_DEFINITIONS.length, READ_TOOL_NAMES.length);
  assert.equal(new Set(READ_TOOL_NAMES).size, READ_TOOL_NAMES.length);
  for (const tool of READ_TOOL_DEFINITIONS) {
    assert.equal(typeof tool.name, 'string');
    assert.equal(tool.risk, 'read');
    assert.equal(tool.riskLevel, 'read');
    assert.equal(tool.scope, 'read');
    assert.deepEqual(tool.capabilityRequirements, ['mcp.read']);
    assert.equal(tool.confirmationText, null);
    assert.equal(isJsonSchema(tool.inputSchema), true, tool.name);
    assert.equal(isJsonSchema(tool.resultSchema), true, tool.name);
    assert.equal(tool.resultSchema.required.includes('projectId'), true, tool.name);
    assert.equal(tool.resultSchema.required.includes('projectRevision'), true, tool.name);
  }
});

test('tools/list exposes the complete read catalogue over an authenticated loopback socket', async (t) => {
  const fixture = makeFixture();
  await fixture.server.start();
  t.after(() => fixture.server.stop());

  const response = await requestJson(fixture.server, {
    jsonrpc: '2.0',
    id: 'list-1',
    method: 'tools/list',
    projectId: 'project-1',
    projectRevision: 'revision-1',
  }, { token: fixture.issued.token, requestId: 'list-request' });

  assert.equal(response.status, 200);
  assert.deepEqual(response.body.projectId, 'project-1');
  assert.deepEqual(response.body.projectRevision, 'revision-1');
  assert.deepEqual(response.body.result.tools.map((tool) => tool.name), READ_TOOL_NAMES);
  assert.equal(response.body.result.tools.every((tool) => tool.scope === 'read'), true);
});

test('every published read tool invokes end-to-end with deterministic metadata', async (t) => {
  const fixture = makeFixture();
  await fixture.server.start();
  t.after(() => fixture.server.stop());

  for (const name of READ_TOOL_NAMES) {
    const request = {
      jsonrpc: '2.0',
      id: `call-${name}`,
      method: 'tools/call',
      params: { name, arguments: argumentsFor(name) },
      projectId: 'project-1',
      projectRevision: 'revision-1',
    };
    const response = await requestJson(fixture.server, request, {
      token: fixture.issued.token,
      requestId: `request-${name}`,
    });
    assert.equal(response.status, 200, name);
    assert.equal(response.body.result.schemaVersion, 1, name);
    assert.equal(response.body.result.tool, name, name);
    assert.equal(response.body.result.scope, 'read', name);
    assert.equal(response.body.result.risk, 'read', name);
    assert.equal(response.body.result.projectId, 'project-1', name);
    assert.equal(response.body.result.projectRevision, 'revision-1', name);
    assert.ok(Object.prototype.hasOwnProperty.call(response.body.result, 'data'), name);
  }

  const audits = fixture.server.getAuditLog();
  const serialized = JSON.stringify(audits);
  for (const name of READ_TOOL_NAMES) {
    assert.equal(audits.some((record) => record.tool === name && record.outcome === 'success'), true, name);
  }
  assert.equal(serialized.includes('request-project-secret'), false);
});

test('unknown tools return a typed method-not-found error and reads cannot mutate', async (t) => {
  const fixture = makeFixture();
  await fixture.server.start();
  t.after(() => fixture.server.stop());

  const unknown = await requestJson(fixture.server, {
    jsonrpc: '2.0',
    id: 'unknown-1',
    method: 'tools/call',
    params: { name: 'not_a_real_tool', arguments: {} },
  }, { token: fixture.issued.token });
  assert.equal(unknown.status, 404);
  assert.equal(unknown.body.error.code, MCP_ERROR_CODES.METHOD_NOT_FOUND);

  const before = JSON.parse(JSON.stringify(fixture.project));
  const read = await requestJson(fixture.server, {
    jsonrpc: '2.0',
    id: 'read-1',
    method: 'tools/call',
    params: {
      name: 'get_chunk',
      arguments: {
        projectId: 'project-1',
        chunkIndex: 0,
        original: 'MUST NOT BE WRITTEN',
        translated: 'MUST NOT BE WRITTEN',
        approved: false,
      },
    },
  }, { token: fixture.issued.token });
  assert.equal(read.status, 200);
  assert.equal(read.body.result.data.original, 'Hare Krishna world');
  assert.deepEqual(fixture.project, before);
});

test('translation reads publish canonical multi-language state without mutating the source session', async () => {
  const project = makeProject();
  const before = JSON.parse(JSON.stringify(project));
  const catalog = createReadCatalog({ project, projectId: 'project-1', projectRevision: 'revision-1' });

  // get_project_state: legacy selected stripped, canonical active published.
  const state = await catalog.execute('get_project_state', { projectId: 'project-1' });
  const publishedSession = state.data.project.session;
  assert.equal('selectedTranslationLanguage' in publishedSession, false);
  assert.equal(publishedSession.activeTranslationLanguage, 'French');
  assert.equal(publishedSession.targetLang, 'French');
  assert.deepEqual(publishedSession.availableTranslationLanguages, ['French', 'English']);
  // Envelope canonicalization sorts object keys (stableClone).
  assert.deepEqual(Object.keys(publishedSession.chunks[0].translationsByLanguage), ['english', 'french']);

  // get_ui_state / list_translation_languages: established keys sourced from
  // the canonical active.
  const ui = await catalog.execute('get_ui_state', { projectId: 'project-1' });
  assert.equal(ui.data.selectedTranslationLanguage, 'French');
  const languages = await catalog.execute('list_translation_languages', { projectId: 'project-1' });
  assert.equal(languages.data.activeLanguage, 'French');
  assert.deepEqual(languages.data.availableLanguages, ['French', 'English']);

  // get_chunk: default text comes from the exact active variant.
  const chunk = await catalog.execute('get_chunk', { projectId: 'project-1', chunkIndex: 0 });
  assert.equal(chunk.data.translated, 'Bonjour monde');
  assert.equal(chunk.data.selectedTranslationLanguage, 'French');
  assert.equal(chunk.data.translationCueCount, 1);

  const englishChunk = await catalog.execute('get_chunk', {
    projectId: 'project-1', chunkIndex: 0, language: 'English',
  });
  assert.equal(englishChunk.data.translated, 'Hello world');
  assert.equal(englishChunk.data.translationCueCount, 1);

  const unknownChunk = await catalog.execute('get_chunk', {
    projectId: 'project-1', chunkIndex: 0, language: 'de',
  });
  assert.equal(unknownChunk.data.translated, '');
  assert.equal(unknownChunk.data.translationCueCount, 0);

  // get_chunk_cues: default (active), explicit language, and unknown language.
  const frenchCues = await catalog.execute('get_chunk_cues', {
    projectId: 'project-1', chunkIndex: 0, side: 'translated',
  });
  assert.equal(frenchCues.data.language, 'French');
  assert.deepEqual(frenchCues.data.cues.map((cue) => cue.text), ['Bonjour']);

  const englishCues = await catalog.execute('get_chunk_cues', {
    projectId: 'project-1', chunkIndex: 0, side: 'translated', language: 'English',
  });
  assert.equal(englishCues.data.language, 'English');
  assert.deepEqual(englishCues.data.cues.map((cue) => cue.text), ['Hello']);
  assert.equal(englishCues.data.count, 1);

  const unknownCues = await catalog.execute('get_chunk_cues', {
    projectId: 'project-1', chunkIndex: 0, side: 'translated', language: 'de',
  });
  assert.equal(unknownCues.data.language, 'de');
  assert.deepEqual(unknownCues.data.cues, []);
  assert.equal(unknownCues.data.count, 0);

  // search_transcript translated side follows the active projection.
  const search = await catalog.execute('search_transcript', {
    projectId: 'project-1', query: 'Bonjour', side: 'translated',
  });
  assert.equal(search.data.matchCount >= 1, true);

  const englishSearch = await catalog.execute('search_transcript', {
    projectId: 'project-1', query: 'Hello', side: 'translated', language: 'English',
  });
  assert.equal(englishSearch.data.matchCount, 1);

  const unknownSearch = await catalog.execute('search_transcript', {
    projectId: 'project-1', query: 'Hello', side: 'translated', language: 'de',
  });
  assert.equal(unknownSearch.data.matchCount, 0);

  // Source immutability across every read above.
  assert.deepEqual(project, before);
});

test('translated text reads publish the language selector accepted by their handlers', () => {
  const languageAwareTextReads = ['get_chunk', 'search_transcript'];
  assert.deepEqual(
    languageAwareTextReads.map((name) => ({
      name,
      publishesLanguage: Object.prototype.hasOwnProperty.call(
        READ_TOOL_DEFINITIONS.find((tool) => tool.name === name).inputSchema.properties,
        'language'
      ),
    })),
    languageAwareTextReads.map((name) => ({ name, publishesLanguage: true }))
  );
});

test('get_safe_settings drops secret-named primitive values at every depth', async () => {
  const catalog = createReadCatalog({
    settings: {
      apiKey: 'x',
      nested: {
        token: 'y',
        password: 'z',
        label: 'safe',
      },
      sibling: 'survives',
    },
  });

  const result = await catalog.execute('get_safe_settings');
  assert.deepEqual(result.data, {
    nested: { label: 'safe' },
    sibling: 'survives',
  });
});

test('list_export_options publishes the native nested shape from injected readiness', async () => {
  const catalog = catalogWithReadiness(makeReadiness({ shortsPlanCount: 2, sourceVideoPath: '/private/source.mov' }));
  const result = await catalog.execute('list_export_options', { projectId: 'project-1' });

  assert.equal(result.schemaVersion, 1);
  assert.equal(result.tool, 'list_export_options');
  assert.equal(result.scope, 'read');
  assert.equal(result.risk, 'read');
  assert.equal(result.projectId, 'project-1');
  assert.equal(result.projectRevision, 'revision-1');
  assert.deepEqual(result.data, {
    transcript: {
      available: true,
      sides: ['original', 'translated'],
      formats: ['txt', 'markdown', 'srt', 'vtt'],
    },
    shortsIdeas: { available: true, languages: ['source', 'target'] },
    shortsVideos: {
      available: true,
      formats: ['mp4', 'mov'],
      resolutions: ['source', '1080p', '720p'],
      frameRates: ['source', '30', '25', '24'],
    },
    destinationPolicy: 'Files are written only to VaniScript/MCP Exports and returned by exportId.',
  });
});

test('list_export_options reports every group unavailable without an active session', async () => {
  const shapes = [];
  for (const snapshot of [null, makeReadiness({ sessionAvailable: false })]) {
    const result = await catalogWithReadiness(snapshot).execute('list_export_options');
    assert.deepEqual(result.data.transcript, {
      available: false,
      sides: ['original', 'translated'],
      formats: ['txt', 'markdown', 'srt', 'vtt'],
    });
    assert.deepEqual(result.data.shortsIdeas, { available: false, languages: ['source', 'target'] });
    assert.deepEqual(result.data.shortsVideos, {
      available: false,
      formats: ['mp4', 'mov'],
      resolutions: ['source', '1080p', '720p'],
      frameRates: ['source', '30', '25', '24'],
    });
    assert.equal(result.data.destinationPolicy, 'Files are written only to VaniScript/MCP Exports and returned by exportId.');
    shapes.push(result);
  }
  assert.equal(shapes.length, 2);
});

test('validate_export drives every transcript branch from injected readiness', async () => {
  const happy = await catalogWithReadiness(makeReadiness()).execute('validate_export', { kind: 'transcript' });
  assert.deepEqual(happy.data, { valid: true, kind: 'transcript', issues: [] });

  // Native allSatisfy semantics: an empty chunk list reports both issues.
  const noChunks = await catalogWithReadiness(makeReadiness({ chunkCount: 0, originalNonEmptyCount: 0 }))
    .execute('validate_export', { kind: 'transcript' });
  assert.deepEqual(noChunks.data, {
    valid: false,
    kind: 'transcript',
    issues: [
      { severity: 'error', code: 'NO_CHUNKS', message: 'The project has no segments.' },
      { severity: 'error', code: 'EMPTY_TRANSCRIPT', message: 'The project has no transcript text.' },
    ],
  });

  const whitespaceOnly = await catalogWithReadiness(makeReadiness({ chunkCount: 3, originalNonEmptyCount: 0 }))
    .execute('validate_export', { kind: 'transcript' });
  assert.deepEqual(whitespaceOnly.data, {
    valid: false,
    kind: 'transcript',
    issues: [{ severity: 'error', code: 'EMPTY_TRANSCRIPT', message: 'The project has no transcript text.' }],
  });
});

test('validate_export fails typed when no project is open', async () => {
  for (const snapshot of [null, undefined, makeReadiness({ sessionAvailable: false })]) {
    await assert.rejects(
      () => catalogWithReadiness(snapshot).execute('validate_export', { kind: 'transcript' }),
      (error) => {
        assert.ok(error instanceof ReadCatalogError);
        assert.equal(error.mcpCode, 'MCP_NOT_FOUND');
        assert.equal(error.message, 'NO_ACTIVE_PROJECT: No project is open');
        return true;
      },
    );
  }
});

test('unknown export kinds fail typed INVALID_REQUEST like native -2', async () => {
  await assert.rejects(
    () => catalogWithReadiness(makeReadiness()).execute('validate_export', { kind: 'video' }),
    (error) => {
      assert.ok(error instanceof ReadCatalogError);
      assert.equal(error.mcpCode, 'MCP_INVALID_REQUEST');
      assert.equal(error.message, 'kind must be transcript, shortsIdeas, or shortsVideos');
      return true;
    },
  );
});

test('validate_export drives every shorts branch from injected readiness', async () => {
  const noPlansIdeas = await catalogWithReadiness(makeReadiness()).execute('validate_export', { kind: 'shortsIdeas' });
  assert.deepEqual(noPlansIdeas.data, {
    valid: false,
    kind: 'shortsIdeas',
    issues: [{ severity: 'error', code: 'NO_SHORTS_PLANS', message: 'Create Shorts plans first.' }],
  });
  const ideasReady = await catalogWithReadiness(makeReadiness({ shortsPlanCount: 2 })).execute('validate_export', { kind: 'shortsIdeas' });
  assert.deepEqual(ideasReady.data, { valid: true, kind: 'shortsIdeas', issues: [] });

  // Native parity: NO_SHORTS_PLANS appends first, then the media guard adds
  // SOURCE_MEDIA_MISSING and early-returns with BOTH issues accumulated.
  const videosNoPlans = await catalogWithReadiness(makeReadiness({ sourceVideoPath: null })).execute('validate_export', { kind: 'shortsVideos' });
  assert.deepEqual(videosNoPlans.data, {
    valid: false,
    kind: 'shortsVideos',
    issues: [
      { severity: 'error', code: 'NO_SHORTS_PLANS', message: 'Create Shorts plans first.' },
      { severity: 'error', code: 'SOURCE_MEDIA_MISSING', message: 'Original source video is unavailable.' },
    ],
  });

  // Native early return: SOURCE_MEDIA_MISSING alone short-circuits video checks.
  const mediaMissing = await catalogWithReadiness(makeReadiness({ shortsPlanCount: 1, sourceVideoPath: null }))
    .execute('validate_export', { kind: 'shortsVideos' });
  assert.deepEqual(mediaMissing.data, {
    valid: false,
    kind: 'shortsVideos',
    issues: [{ severity: 'error', code: 'SOURCE_MEDIA_MISSING', message: 'Original source video is unavailable.' }],
  });

  // Audio source media fails VIDEO_REQUIRED; every native container passes.
  const audioSource = await catalogWithReadiness(makeReadiness({ shortsPlanCount: 1, sourceVideoPath: '/private/interview.mp3' }))
    .execute('validate_export', { kind: 'shortsVideos' });
  assert.deepEqual(audioSource.data, {
    valid: false,
    kind: 'shortsVideos',
    issues: [{ severity: 'error', code: 'VIDEO_REQUIRED', message: 'Shorts video export requires video source media.' }],
  });
  for (const extension of ['.mp4', '.mov', '.webm', '.mkv', '.m4v']) {
    const ready = await catalogWithReadiness(makeReadiness({
      shortsPlanCount: 1,
      sourceVideoPath: `/private/clip${extension.toUpperCase()}`,
    })).execute('validate_export', { kind: 'shortsVideos' });
    assert.deepEqual(ready.data, { valid: true, kind: 'shortsVideos', issues: [] }, extension);
  }

  // Empty-string paths count as missing media, matching native !!source truthiness.
  const emptyPath = await catalogWithReadiness(makeReadiness({ shortsPlanCount: 1, sourceVideoPath: '' }))
    .execute('validate_export', { kind: 'shortsVideos' });
  assert.equal(emptyPath.data.valid, false);
  assert.equal(emptyPath.data.issues[0].code, 'SOURCE_MEDIA_MISSING');

  // Main-process existence truth: a vanished video fails closed even with a
  // video extension, exactly like a null or empty path.
  const vanishedMedia = await catalogWithReadiness(makeReadiness({ shortsPlanCount: 1, sourceVideoExists: false }))
    .execute('validate_export', { kind: 'shortsVideos' });
  assert.deepEqual(vanishedMedia.data, {
    valid: false,
    kind: 'shortsVideos',
    issues: [{ severity: 'error', code: 'SOURCE_MEDIA_MISSING', message: 'Original source video is unavailable.' }],
  });

  // Snapshots without the existence field (legacy fake readers) fail closed.
  const legacySnapshot = makeReadiness({ shortsPlanCount: 1 });
  delete legacySnapshot.sourceVideoExists;
  const noExistenceField = await catalogWithReadiness(legacySnapshot)
    .execute('validate_export', { kind: 'shortsVideos' });
  assert.equal(noExistenceField.data.valid, false);
  assert.equal(noExistenceField.data.issues[0].code, 'SOURCE_MEDIA_MISSING');
  assert.equal(noExistenceField.data.issues[0].message, 'Original source video is unavailable.');
});

test('missing exportReadiness dependency fails typed CAPABILITY_UNAVAILABLE for both export reads', async () => {
  const catalog = createReadCatalog({ projectId: 'project-1', projectRevision: 'revision-1' });
  for (const [tool, args] of [['list_export_options', {}], ['validate_export', { kind: 'transcript' }]]) {
    await assert.rejects(() => catalog.execute(tool, args), (error) => {
      assert.ok(error instanceof ReadCatalogError);
      assert.equal(error.mcpCode, 'MCP_CAPABILITY_UNAVAILABLE');
      return true;
    }, tool);
  }
});

test('export reads keep the read envelope and native data shapes over the loopback socket', async (t) => {
  const fixture = makeFixture();
  await fixture.server.start();
  t.after(() => fixture.server.stop());

  const optionsResponse = await requestJson(fixture.server, {
    jsonrpc: '2.0',
    id: 'options-1',
    method: 'tools/call',
    params: { name: 'list_export_options', arguments: {} },
    projectId: 'project-1',
    projectRevision: 'revision-1',
  }, { token: fixture.issued.token });
  assert.equal(optionsResponse.status, 200);
  assert.equal(optionsResponse.body.result.tool, 'list_export_options');
  assert.equal(optionsResponse.body.result.scope, 'read');
  assert.equal(optionsResponse.body.result.risk, 'read');
  assert.equal(optionsResponse.body.result.projectId, 'project-1');
  assert.equal(optionsResponse.body.result.projectRevision, 'revision-1');
  assert.equal(optionsResponse.body.result.data.transcript.available, true);
  assert.equal(optionsResponse.body.result.data.shortsVideos.available, true);

  const validateResponse = await requestJson(fixture.server, {
    jsonrpc: '2.0',
    id: 'validate-1',
    method: 'tools/call',
    params: { name: 'validate_export', arguments: { kind: 'transcript' } },
    projectId: 'project-1',
    projectRevision: 'revision-1',
  }, { token: fixture.issued.token });
  assert.equal(validateResponse.status, 200);
  assert.deepEqual(validateResponse.body.result.data, { valid: true, kind: 'transcript', issues: [] });
});

test('export reads surface typed errors over the loopback socket', async (t) => {
  const catalog = catalogWithReadiness(null);
  const server = new McpServer({
    host: '127.0.0.1',
    port: 0,
    vault: new MemoryVault(),
    readCatalog: catalog,
  });
  const issued = server.rotateToken();
  await server.start();
  t.after(() => server.stop());

  const response = await requestJson(server, {
    jsonrpc: '2.0',
    id: 'closed-1',
    method: 'tools/call',
    params: { name: 'validate_export', arguments: { kind: 'transcript' } },
  }, { token: issued.token });
  assert.equal(response.status, 404);
  assert.equal(response.body.error.code, MCP_ERROR_CODES.NOT_FOUND);
  assert.equal(response.body.error.message, 'NO_ACTIVE_PROJECT: No project is open');
});

test('Shorts reads resolve the requested disk project, ignore globals, and publish path-safe state', async () => {
  const makePlan = (stableID, title, overrides = {}) => ({
    stableID,
    start: '00:00',
    end: '00:10',
    title,
    summary: `${title} summary`,
    hook: `${title} hook`,
    captionText: `${title} caption`,
    languageMode: 'source',
    backgroundSettings: { solidEnabled: true, solidColor: '#000000' },
    sourceLogo: { id: `${stableID}-logo`, src: '/private/logo.png', name: 'Logo', size: 1, opacity: 1 },
    sourceTextTracks: [{ id: `${stableID}-text`, name: 'Text', blocks: [] }],
    sourceAudioTracks: [{
      id: `${stableID}-audio`,
      name: 'Audio',
      src: '/private/audio.mp3',
      previewSrc: '/private/audio-preview.mp3',
      startSec: 0,
      trimStartSec: 0,
      trimEndSec: 0,
      volume: 1,
      fadeInSec: 0,
      fadeOutSec: 0,
    }],
    sourceIntro: { id: `${stableID}-intro`, src: '/private/intro.mp4', name: 'Intro', duration: 1, x: 0, y: 0, scale: 1, animation: 'none' },
    sourceOutro: { id: `${stableID}-outro`, src: '/private/outro.mp4', name: 'Outro', duration: 1, x: 0, y: 0, scale: 1, animation: 'none' },
    ...overrides,
  });
  const projectA = {
    id: 'project-a',
    session: {
      projectId: 'project-a',
      durationSec: 100,
      shortsPlans: [makePlan('plan-a', 'Project A')],
      shortsRejectedPlans: [],
    },
  };
  const projectB = {
    id: 'project-b',
    session: {
      projectId: 'project-b',
      durationSec: 8,
      sourceMediaInfo: { durationSec: 8 },
      shortsPlans: [makePlan('plan-b', 'Project B')],
      shortsRejectedPlans: [makePlan('rejected-b', 'Rejected B')],
    },
  };
  const catalog = createReadCatalog({
    settings: {
      shortsPlans: [makePlan('global-plan', 'Global fake')],
      rejectedShortsPlans: [makePlan('global-rejected', 'Global rejected fake')],
      visualEditorState: { marker: 'global fake', audioTracks: [{ src: '/private/global.mp3' }] },
      session: { shortsPlans: [makePlan('session-plan', 'Unrelated session fake')] },
    },
    resolveShortsProject: async (projectId) => ({ 'project-a': projectA, 'project-b': projectB }[projectId || 'project-a'] || null),
  });

  const active = await catalog.execute('get_shorts_plans', {});
  assert.equal(active.projectId, 'project-a');
  assert.deepEqual(active.data.plans.map((plan) => plan.id), ['plan-a']);

  const plans = await catalog.execute('get_shorts_plans', { projectId: 'project-b' });
  assert.equal(plans.projectId, 'project-b');
  assert.deepEqual(plans.data.plans.map((plan) => plan.id), ['plan-b']);
  assert.equal(plans.data.plans[0].title, 'Project B');

  const one = await catalog.execute('get_shorts_plan', { projectId: 'project-b', planId: 'plan-b' });
  assert.equal(one.data.plan.id, 'plan-b');
  assert.equal(one.data.plan.title, 'Project B');

  const rejected = await catalog.execute('list_rejected_shorts_plans', { projectId: 'project-b' });
  assert.deepEqual(rejected.data.plans.map((plan) => plan.id), ['rejected-b']);

  const validation = await catalog.execute('validate_shorts_plan', { projectId: 'project-b', planId: 'plan-b' });
  assert.equal(validation.data.planId, 'plan-b');
  assert.equal(validation.data.valid, false);
  assert.equal(validation.data.issues.some((issue) => issue.code === 'OUTSIDE_SOURCE'), true);

  const editor = await catalog.execute('get_visual_editor_state', { projectId: 'project-b', planId: 'plan-b' });
  assert.equal(editor.data.plan.id, 'plan-b');
  assert.equal(editor.data.assetPolicy.includes('source paths'), true);
  assert.equal(JSON.stringify({ plans, one, rejected, validation, editor }).includes('/private/'), false);
  assert.equal(JSON.stringify(editor.data).includes('global fake'), false);

  await assert.rejects(
    () => catalog.execute('get_shorts_plans', { projectId: 'unknown-project' }),
    (error) => error instanceof ReadCatalogError && error.mcpCode === 'MCP_NOT_FOUND',
  );
  await assert.rejects(
    () => catalog.execute('get_shorts_plan', { projectId: 'project-b', planId: 'unknown-plan' }),
    (error) => error instanceof ReadCatalogError && error.mcpCode === 'MCP_NOT_FOUND',
  );
});
test('Shorts project isolation survives the authenticated loopback request path', async (t) => {
  const makePlan = (stableID, title, overrides = {}) => ({
    stableID,
    start: '00:00',
    end: '00:10',
    title,
    summary: `${title} summary`,
    hook: `${title} hook`,
    captionText: `${title} caption`,
    languageMode: 'source',
    sourceLogo: { id: `${stableID}-logo`, src: '/private/logo.png', name: 'Logo' },
    sourceAudioTracks: [{
      id: `${stableID}-audio`,
      name: 'Audio',
      src: '/private/audio.mp3',
      previewSrc: '/private/audio-preview.mp3',
    }],
    ...overrides,
  });
  const projects = {
    'project-a': {
      id: 'project-a',
      session: {
        projectId: 'project-a',
        durationSec: 100,
        shortsPlans: [makePlan('plan-a', 'Project A')],
        shortsRejectedPlans: [],
      },
    },
    'project-b': {
      id: 'project-b',
      session: {
        projectId: 'project-b',
        durationSec: 8,
        sourceMediaInfo: { durationSec: 8 },
        shortsPlans: [makePlan('plan-b', 'Project B')],
        shortsRejectedPlans: [makePlan('rejected-b', 'Rejected B')],
      },
    },
  };
  const catalog = createReadCatalog({
    settings: {
      shortsPlans: [makePlan('global-plan', 'Global fake')],
      rejectedShortsPlans: [makePlan('global-rejected', 'Global rejected fake')],
      visualEditorState: { marker: 'global fake' },
    },
    resolveShortsProject: async (projectId) => projects[projectId || 'project-a'] || null,
  });
  const server = new McpServer({
    host: '127.0.0.1',
    port: 0,
    vault: new MemoryVault(),
    readCatalog: catalog,
  });
  const issued = server.rotateToken();
  await server.start();
  t.after(() => server.stop());

  const calls = [
    ['get_shorts_plans', { projectId: 'project-b' }],
    ['get_shorts_plan', { projectId: 'project-b', planId: 'plan-b' }],
    ['list_rejected_shorts_plans', { projectId: 'project-b' }],
    ['validate_shorts_plan', { projectId: 'project-b', planId: 'plan-b' }],
    ['get_visual_editor_state', { projectId: 'project-b', planId: 'plan-b' }],
  ];
  for (const [name, args] of calls) {
    const response = await requestJson(server, {
      jsonrpc: '2.0',
      id: `project-b-${name}`,
      method: 'tools/call',
      params: { name, arguments: args },
      projectId: 'project-a',
      projectRevision: 'revision-a',
    }, { token: issued.token, requestId: `project-b-${name}` });
    assert.equal(response.status, 200, name);
    assert.equal(response.body.result.projectId, 'project-b', name);
    const data = response.body.result.data;
    assert.equal(JSON.stringify(data).includes('Global fake'), false, name);
    assert.equal(JSON.stringify(data).includes('/private/'), false, name);
    if (name === 'get_shorts_plans') {
      assert.deepEqual(data.plans.map((plan) => plan.id), ['plan-b']);
      assert.equal(data.plans[0].title, 'Project B');
    } else if (name === 'get_shorts_plan' || name === 'get_visual_editor_state') {
      assert.equal(data.plan.id, 'plan-b', name);
      assert.equal(data.plan.title, 'Project B', name);
    } else if (name === 'list_rejected_shorts_plans') {
      assert.deepEqual(data.plans.map((plan) => plan.id), ['rejected-b']);
    } else {
      assert.equal(data.planId, 'plan-b');
      assert.equal(data.valid, false);
      assert.equal(data.issues.some((issue) => issue.code === 'OUTSIDE_SOURCE'), true);
    }
  }

  const missing = await requestJson(server, {
    jsonrpc: '2.0',
    id: 'unknown-project',
    method: 'tools/call',
    params: { name: 'get_shorts_plans', arguments: { projectId: 'unknown-project' } },
    projectId: 'project-a',
    projectRevision: 'revision-a',
  }, { token: issued.token, requestId: 'unknown-project' });
  assert.equal(missing.status, 404);
  assert.equal(missing.body.error.code, 'MCP_NOT_FOUND');
});

test('help list projects shared bilingual summaries with full sorted categories', async () => {
  const catalog = createReadCatalog({
    settings: { helpLocale: 'ru-RU' },
    helpTopics: [{ topicId: 'injected', category: 'Injected', title: 'Do not use', summary: 'Do not use' }],
  });

  const result = await catalog.execute('list_help_topics', { category: ' translation ' });
  assert.equal(result.schemaVersion, 1);
  assert.equal(result.tool, 'list_help_topics');
  assert.equal(result.scope, 'read');
  assert.equal(result.risk, 'read');
  assert.equal(result.data.language, 'ru');
  assert.deepEqual(result.data.categories, [
    'Assistant',
    'Export',
    'Getting Started',
    'Import',
    'Processing',
    'Projects',
    'Review',
    'Settings',
    'Shorts',
    'Translation',
    'Troubleshooting',
  ]);
  assert.deepEqual(result.data.topics.map((topic) => ({
    topicId: topic.topicId,
    category: topic.category,
    screen: topic.screen,
    title: topic.title,
  })), [
    {
      topicId: 'translate',
      category: 'Translation',
      screen: 'review',
      title: 'Создание, переключение и полировка переводов',
    },
    {
      topicId: 'glossary',
      category: 'Translation',
      screen: '',
      title: 'Использование glossary для имён и терминов',
    },
  ]);
  assert.equal(result.data.count, 2);
  assert.equal(result.data.topics.every((topic) => (
    Object.keys(topic).sort().join(',') === 'category,screen,summary,title,topicId'
  )), true);
});

test('help search follows bilingual fixture ranking, clamped limits, and empty result semantics', async () => {
  const catalog = createReadCatalog({ settings: { helpLocale: 'ru' } });

  for (const fixture of helpSearchFixture.queries) {
    const result = await catalog.execute('search_help', {
      query: fixture.query,
      language: fixture.language,
      limit: fixture.limit,
    });
    assert.equal(result.data.query, fixture.query, fixture.name);
    assert.equal(result.data.language, fixture.expectedLanguage, fixture.name);
    assert.equal(result.data.matches[0]?.topicId, fixture.expectedFirstID, fixture.name);
    if (fixture.expectedFirstTitle) {
      assert.equal(result.data.matches[0]?.title, fixture.expectedFirstTitle, fixture.name);
    }
    assert.equal(result.data.matchCount, result.data.matches.length, fixture.name);
    assert.equal(result.data.limit, fixture.limit, fixture.name);
    assert.equal(result.data.matches.every((topic) => (
      Array.isArray(topic.requirements)
      && topic.steps.every((step, index) => step.number === index + 1 && typeof step.instruction === 'string')
      && Array.isArray(topic.troubleshooting)
      && Array.isArray(topic.relatedTopicIds)
    )), true, fixture.name);
  }

  const tie = await catalog.execute('search_help', helpSearchFixture.tie);
  assert.deepEqual(tie.data.matches.map((topic) => topic.topicId), helpSearchFixture.tie.expectedIDs);

  const noMatch = await catalog.execute('search_help', helpSearchFixture.noMatch);
  assert.deepEqual(noMatch.data.matches, []);
  assert.equal(noMatch.data.matchCount, 0);
  assert.equal(noMatch.data.limit, helpSearchFixture.noMatch.limit);

  for (const fixture of helpSearchFixture.limits) {
    const result = await catalog.execute('search_help', fixture);
    assert.equal(result.data.matchCount, fixture.expectedCount, JSON.stringify(fixture));
    assert.equal(result.data.limit, Math.min(10, Math.max(1, fixture.limit)));
  }
  const invalidLimit = await catalog.execute('search_help', {
    query: 'export',
    language: 'en',
    limit: 'invalid',
  });
  assert.equal(invalidLimit.data.limit, 5);
});

test('help search rejects blank MCP queries with a typed invalid request', async () => {
  const catalog = createReadCatalog();
  await assert.rejects(
    () => catalog.execute('search_help', {
      query: helpSearchFixture.empty.query,
      language: helpSearchFixture.empty.language,
      limit: helpSearchFixture.empty.limit,
    }),
    (error) => {
      assert.ok(error instanceof ReadCatalogError);
      assert.equal(error.mcpCode, 'MCP_INVALID_REQUEST');
      assert.equal(error.message, 'query is required and cannot be empty');
      return true;
    },
  );
});

test('help topic lookup localizes full details and reports typed not-found errors', async () => {
  const catalog = createReadCatalog({ settings: { helpLocale: 'ru' } });
  const result = await catalog.execute('get_help_topic', { topicId: ' export-documents ' });
  assert.equal(result.data.topicId, 'export-documents');
  assert.equal(result.data.topic.topicId, 'export-documents');
  assert.equal(result.data.topic.category, 'Export');
  assert.equal(result.data.topic.screen, 'export');
  assert.equal(result.data.topic.title, 'Экспорт документов транскрипта');
  assert.equal(result.data.topic.summary, 'Экспортируйте исходный текст или перевод в TXT, SRT, VTT или Markdown.');
  assert.deepEqual(result.data.topic.steps.map((step) => step.number), [1, 2, 3]);
  assert.equal(result.data.topic.steps[1].instruction.includes('Document export'), true);
  assert.deepEqual(result.data.topic.relatedTopicIds, ['review-transcript', 'create-shorts']);
  assert.equal(Object.prototype.hasOwnProperty.call(result.data.topic, 'id'), false);
  assert.equal(Object.prototype.hasOwnProperty.call(result.data.topic, 'relatedTopicIDs'), false);

  await assert.rejects(
    () => catalog.execute('get_help_topic', { topicId: 'not-a-real-topic', language: 'en' }),
    (error) => {
      assert.ok(error instanceof ReadCatalogError);
      assert.equal(error.mcpCode, 'MCP_NOT_FOUND');
      assert.equal(error.message, 'Help topic not found: not-a-real-topic');
      return true;
    },
  );
  await assert.rejects(
    () => catalog.execute('get_help_topic', { topicId: '   ' }),
    (error) => {
      assert.ok(error instanceof ReadCatalogError);
      assert.equal(error.mcpCode, 'MCP_INVALID_REQUEST');
      assert.equal(error.message, 'topicId is required. Call list_help_topics or search_help first.');
      return true;
    },
  );
});

test('help language arguments take precedence over persisted locale and normalize to en or ru', async () => {
  const catalog = createReadCatalog({ settings: { helpLocale: 'ru-RU' } });
  const persisted = await catalog.execute('get_onboarding_checklist', {});
  assert.equal(persisted.data.language, 'ru');
  assert.equal(persisted.data.title, 'Чек-лист первого проекта');

  const explicitEnglish = await catalog.execute('get_onboarding_checklist', { language: 'en-US' });
  assert.equal(explicitEnglish.data.language, 'en');
  assert.equal(explicitEnglish.data.title, 'First project checklist');

  const invalid = await catalog.execute('get_onboarding_checklist', { language: 'fr' });
  assert.equal(invalid.data.language, 'en');
});

test('contextual help follows every active renderer screen/state fixture in both locales', async () => {
  for (const fixture of helpContextFixture.cases) {
    const catalog = createReadCatalog({
      projectId: 'context-project',
      projectRevision: 'context-revision',
      activeRendererState: fixture.state,
    });
    for (const language of ['en', 'ru']) {
      const result = await catalog.execute('get_contextual_help', { language });
      const expected = fixture.expected[language];
      assert.deepEqual({
        language: result.data.language,
        screen: result.data.screen,
        title: result.data.title,
        summary: result.data.summary,
        nextActions: result.data.nextActions,
        recommendedTopicIds: result.data.recommendedTopicIds,
      }, {
        language,
        screen: expected.screen,
        title: expected.title,
        summary: expected.summary,
        nextActions: expected.nextActions,
        recommendedTopicIds: expected.recommendedTopicIDs,
      }, `${fixture.name} ${language}`);
      assert.equal(result.data.projectId, 'context-project', `${fixture.name} ${language}`);
    }
  }
});

test('contextual help reads active UI and processing state readers before stale options', async () => {
  const catalog = createReadCatalog({
    screen: 'review',
    readers: {
      getUiState: async () => ({
        screen: 'export',
        hasSource: true,
        hasActiveSession: true,
        shortsPlanCount: 1,
      }),
      getProcessingStatus: async () => ({ progress: 1 }),
    },
  });
  const result = await catalog.execute('get_contextual_help', { language: 'en' });
  assert.equal(result.data.screen, 'export');
  assert.equal(result.data.title, 'Export documents or create Shorts');
  assert.deepEqual(result.data.nextActions, [
    'Use Document export for TXT, SRT, VTT, or Markdown.',
    'Select the required clip cards and export ideas or videos.',
  ]);
});

test('onboarding checklist remains eight numbered localized steps', async () => {
  const catalog = createReadCatalog();
  const expectedTopicIds = [
    'getting-started',
    'manage-models',
    'configure-engine',
    'review-transcript',
    'glossary',
    'export-documents',
    'create-shorts',
  ];
  for (const language of ['en', 'ru']) {
    const result = await catalog.execute('get_onboarding_checklist', { language });
    assert.equal(result.data.language, language);
    assert.equal(result.data.steps.length, 8);
    assert.deepEqual(result.data.steps.map((step) => step.number), [1, 2, 3, 4, 5, 6, 7, 8]);
    assert.deepEqual(result.data.topicIds, expectedTopicIds);
    assert.equal(result.data.steps[3].instruction.includes('Initialize Engine'), true);
    assert.equal(result.data.steps[4].instruction.includes('Approve & Next'), true);
    assert.equal(result.data.steps[7].instruction.includes('Help Tour'), true);
  }
});
