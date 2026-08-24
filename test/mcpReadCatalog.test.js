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
  createReadCatalog,
} = require('../electron/main/mcp/mcpTools/readCatalog.js');

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
