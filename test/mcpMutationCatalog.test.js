const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');

const {
  McpServer,
  MCP_ERROR_CODES,
} = require('../electron/main/mcp/mcpServer.js');
const { createReadCatalog } = require('../electron/main/mcp/mcpTools/readCatalog.js');
const {
  ConfirmationStore,
  MUTATION_SCOPE,
  PROCESSING_SCOPE,
  TOOL_NAMES,
  createMutationCatalog,
} = require('../electron/main/mcp/mcpTools/mutationCatalog.js');

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

function makeProject() {
  return {
    id: 'project-1',
    revision: 'r1',
    name: 'Mutation fixture',
    session: {
      sourceFile: null,
      sourceFileName: 'fixture.wav',
      sourceLang: 'en',
      targetLang: 'fr',
      durationSec: 4,
      currentChunkIndex: 0,
      chunks: [{
        index: 0,
        original: 'old text',
        translated: 'ancien texte',
        status: 'done',
        approved: true,
        originalCues: [{ startSec: 0, endSec: 2, text: 'old', words: [] }],
        translatedCues: [{ startSec: 0, endSec: 2, text: 'ancien', words: [] }],
      }, {
        index: 1,
        original: 'second',
        translated: 'deuxieme',
        status: 'done',
        approved: false,
        originalCues: [],
        translatedCues: [],
      }],
    },
    glossary: [{
      id: 'term-1',
      source: 'old',
      translation: 'ancien',
      variants: [],
      remember: true,
      createdAt: '2026-01-01T00:00:00.000Z',
      updatedAt: '2026-01-01T00:00:00.000Z',
    }],
  };
}

function requestJson(server, body, options = {}) {
  const payload = JSON.stringify(body);
  return new Promise((resolve, reject) => {
    const request = http.request({
      host: server.host,
      port: server.getStatus().port,
      path: '/mcp',
      method: 'POST',
      headers: {
        authorization: `Bearer ${options.token}`,
        origin: 'http://127.0.0.1',
        'content-type': 'application/json',
        'content-length': Buffer.byteLength(payload),
      },
      agent: false,
    }, (response) => {
      const chunks = [];
      response.on('data', (chunk) => chunks.push(chunk));
      response.on('end', () => resolve({
        status: response.statusCode,
        body: JSON.parse(Buffer.concat(chunks).toString('utf8')),
      }));
    });
    request.on('error', reject);
    request.end(payload);
  });
}

function mutationCall(name, args, id = name) {
  return {
    jsonrpc: '2.0',
    id,
    method: 'tools/call',
    params: { name, arguments: args },
  };
}

async function fixture(options = {}) {
  const project = options.project || makeProject();
  const catalog = options.catalog || createMutationCatalog({
    project,
    projectStore: options.projectStore,
    permissionPolicy: options.permissionPolicy ?? { mutation: true, processing: true },
    confirmationStore: options.confirmationStore,
    confirmation: options.confirmation,
    adapters: options.adapters,
    retranslateChunk: options.retranslateChunk,
    retryChunkTranslation: options.retryChunkTranslation,
    reprocessChunk: options.reprocessChunk,
    cancelProcessing: options.cancelProcessing,
    getProcessingStatus: options.getProcessingStatus,
    processing: options.processing,
    batchDomain: options.batchDomain,
    batchScheduler: options.batchScheduler,
  });
  const server = new McpServer({
    host: '127.0.0.1',
    port: 0,
    vault: new MemoryVault(),
    readCatalog: createReadCatalog({ project, projectId: 'project-1' }),
    mutationCatalog: catalog,
  });
  const issued = server.rotateToken();
  await server.start();
  return { server, issued, project, catalog };
}

function updateArgs(overrides = {}) {
  return {
    projectId: 'project-1',
    expectedProjectRevision: 'r1',
    chunkIndex: 0,
    side: 'original',
    text: 'new text',
    ...overrides,
  };
}

test('mutation catalog publishes bounded scopes, schemas, and confirmation text', () => {
  const catalog = createMutationCatalog({ permissionPolicy: { mutation: true, processing: true } });
  assert.deepEqual(new Set(TOOL_NAMES), new Set(catalog.tools.map((tool) => tool.name)));
  for (const tool of catalog.tools) {
    assert.equal(tool.inputSchema.type, 'object', tool.name);
    assert.equal(tool.resultSchema.type, 'object', tool.name);
    assert.equal(typeof tool.scope, 'string', tool.name);
    assert.equal(typeof tool.risk, 'string', tool.name);
    if (tool.scope === MUTATION_SCOPE || tool.scope === PROCESSING_SCOPE) {
      assert.equal(tool.inputSchema.required.includes('expectedProjectRevision'), true, tool.name);
      assert.equal(typeof tool.confirmationText, 'string', tool.name);
      assert.equal(tool.annotations.readOnlyHint, false, tool.name);
    }
  }
});

test('denied scope returns typed 403 before a mutation adapter is invoked', async (t) => {
  let invoked = 0;
  const project = makeProject();
  const fixtureValue = await fixture({
    project,
    permissionPolicy: {},
    adapters: { update_chunk_text: () => { invoked += 1; } },
  });
  t.after(async () => { await fixtureValue.server.stop(); });

  const response = await requestJson(
    fixtureValue.server,
    mutationCall('update_chunk_text', updateArgs()),
    { token: fixtureValue.issued.token },
  );
  assert.equal(response.status, 403);
  assert.equal(response.body.error.code, MCP_ERROR_CODES.PERMISSION_DENIED);
  assert.equal(invoked, 0);
  assert.equal(project.session.chunks[0].original, 'old text');
});

test('challenge requires Main approval and binds token identity, exact arguments, and revision', async (t) => {
  let now = 1_000;
  const project = makeProject();
  const confirmationStore = new ConfirmationStore({ now: () => now, ttlMs: 100 });
  const fixtureValue = await fixture({ project, confirmationStore });
  t.after(async () => { await fixtureValue.server.stop(); });

  const first = await requestJson(
    fixtureValue.server,
    mutationCall('update_chunk_text', updateArgs(), 'challenge'),
    { token: fixtureValue.issued.token },
  );
  assert.equal(first.status, 428);
  assert.equal(first.body.error.code, MCP_ERROR_CODES.CONFIRMATION_REQUIRED);
  const challenge = first.body.error.details;
  assert.equal(typeof challenge.challengeId, 'string');
  assert.equal(challenge.requiresHumanConfirmation, true);
  assert.equal(typeof challenge.confirmationText, 'string');
  assert.equal(typeof challenge.expiresAt, 'string');
  assert.equal(Object.prototype.hasOwnProperty.call(challenge, 'confirmationToken'), false);

  const echoedDetails = await requestJson(
    fixtureValue.server,
    mutationCall('update_chunk_text', updateArgs({
      challengeId: challenge.challengeId,
      confirmationText: challenge.confirmationText,
      requiresHumanConfirmation: challenge.requiresHumanConfirmation,
      expiresAt: challenge.expiresAt,
      text: 'different',
    }), 'agent-echo'),
    { token: fixtureValue.issued.token },
  );
  assert.equal(echoedDetails.status, 428);
  assert.equal(echoedDetails.body.error.code, MCP_ERROR_CODES.CONFIRMATION_INVALID);
  assert.equal(project.session.chunks[0].original, 'old text');

  const beforeApproval = await requestJson(
    fixtureValue.server,
    mutationCall('update_chunk_text', updateArgs({ challengeId: challenge.challengeId }), 'before-approval'),
    { token: fixtureValue.issued.token },
  );
  assert.equal(beforeApproval.status, 428);
  assert.equal(beforeApproval.body.error.code, MCP_ERROR_CODES.CONFIRMATION_INVALID);
  assert.equal(fixtureValue.server.confirmChallenge(challenge.challengeId), true);

  const confirmed = await requestJson(
    fixtureValue.server,
    mutationCall('update_chunk_text', updateArgs({ challengeId: challenge.challengeId }), 'confirm'),
    { token: fixtureValue.issued.token },
  );
  assert.equal(confirmed.status, 200);
  assert.equal(confirmed.body.result.data.text, 'new text');
  assert.notEqual(confirmed.body.projectRevision, 'r1');
  assert.equal(project.session.chunks[0].original, 'new text');
  assert.equal(project.session.chunks[0].approved, false);

  const replay = await requestJson(
    fixtureValue.server,
    mutationCall('update_chunk_text', updateArgs({
      expectedProjectRevision: project.revision,
      challengeId: challenge.challengeId,
    }), 'replay'),
    { token: fixtureValue.issued.token },
  );
  assert.equal(replay.status, 428);
  assert.equal(replay.body.error.code, MCP_ERROR_CODES.CONFIRMATION_INVALID);

  const currentRevision = project.revision;
  const expiryChallenge = await requestJson(
    fixtureValue.server,
    mutationCall('update_chunk_text', updateArgs({ expectedProjectRevision: currentRevision, text: 'expired target' }), 'expiry-challenge'),
    { token: fixtureValue.issued.token },
  );
  const expiryId = expiryChallenge.body.error.details.challengeId;
  now += 1_000;
  const expired = await requestJson(
    fixtureValue.server,
    mutationCall('update_chunk_text', updateArgs({ expectedProjectRevision: currentRevision, text: 'expired target', challengeId: expiryId }), 'expired'),
    { token: fixtureValue.issued.token },
  );
  assert.equal(expired.status, 428);
  assert.equal(expired.body.error.code, MCP_ERROR_CODES.CONFIRMATION_INVALID);
  assert.equal(project.session.chunks[0].original, 'new text');
});

test('stale expected revision conflicts without changing project state', async (t) => {
  const project = makeProject();
  project.revision = 'r2';
  const before = JSON.stringify(project);
  const fixtureValue = await fixture({ project });
  t.after(async () => { await fixtureValue.server.stop(); });

  const response = await requestJson(
    fixtureValue.server,
    mutationCall('update_chunk_text', updateArgs(), 'stale'),
    { token: fixtureValue.issued.token },
  );
  assert.equal(response.status, 409);
  assert.equal(response.body.error.code, MCP_ERROR_CODES.STALE_REVISION);
  assert.equal(fixtureValue.server.getAuditLog().at(-1).mcpCode, MCP_ERROR_CODES.STALE_REVISION);
  assert.equal(JSON.stringify(project), before);
});

test('two confirmed mutations with one expected revision serialize and second conflicts', async (t) => {
  const project = makeProject();
  const fixtureValue = await fixture({ project });
  t.after(async () => { await fixtureValue.server.stop(); });
  const firstArgs = updateArgs({ text: 'first' });
  const secondArgs = updateArgs({ text: 'second' });

  const [challengeOne, challengeTwo] = await Promise.all([
    requestJson(fixtureValue.server, mutationCall('update_chunk_text', firstArgs, 'c1'), { token: fixtureValue.issued.token }),
    requestJson(fixtureValue.server, mutationCall('update_chunk_text', secondArgs, 'c2'), { token: fixtureValue.issued.token }),
  ]);
  const challengeIdOne = challengeOne.body.error.details.challengeId;
  const challengeIdTwo = challengeTwo.body.error.details.challengeId;
  assert.equal(fixtureValue.server.confirmChallenge(challengeIdOne), true);
  assert.equal(fixtureValue.server.confirmChallenge(challengeIdTwo), true);
  const [first, second] = await Promise.all([
    requestJson(fixtureValue.server, mutationCall('update_chunk_text', { ...firstArgs, challengeId: challengeIdOne }, 'm1'), { token: fixtureValue.issued.token }),
    requestJson(fixtureValue.server, mutationCall('update_chunk_text', { ...secondArgs, challengeId: challengeIdTwo }, 'm2'), { token: fixtureValue.issued.token }),
  ]);
  assert.equal([first.status, second.status].filter((status) => status === 200).length, 1);
  assert.equal([first.status, second.status].filter((status) => status === 409).length, 1);
  assert.equal(project.session.chunks[0].original === 'first' || project.session.chunks[0].original === 'second', true);
});

test('real project adapters update cues, glossary, and batch approval atomically', async () => {
  const project = makeProject();
  const catalog = createMutationCatalog({ project, permissionPolicy: { mutation: true } });
  const context = { projectId: 'project-1', tokenId: 'client-1' };
  async function confirm(name, args) {
    let challenge;
    try {
      await catalog.execute(name, args, context);
    } catch (error) {
      assert.equal(error.mcpCode, MCP_ERROR_CODES.CONFIRMATION_REQUIRED);
      challenge = error.details.challengeId;
    }
    assert.equal(typeof challenge, 'string');
    assert.equal(catalog.confirmations.approve(challenge), true);
    return catalog.execute(name, { ...args, challengeId: challenge }, context);
  }

  let result = await confirm('update_cue_text', {
    projectId: 'project-1', expectedProjectRevision: project.revision, chunkIndex: 0, side: 'original', cueIndex: 0, text: 'cue changed',
  });
  assert.equal(result.data.cueId, 'chunk-0-original-cue-0');
  result = await confirm('update_cue_timestamps', {
    projectId: 'project-1', expectedProjectRevision: project.revision, chunkIndex: 0, side: 'original', cueIndex: 0, startSec: 0.5, endSec: 1.5,
  });
  assert.equal(result.data.startSec, 0.5);
  result = await confirm('create_glossary_entry', {
    projectId: 'project-1', expectedProjectRevision: project.revision, source: 'new', translation: 'nouveau', variants: ['newer'],
  });
  assert.equal(result.data.entry.source, 'new');
  result = await confirm('batch_approve_chunks', {
    projectId: 'project-1', expectedProjectRevision: project.revision, chunkIds: ['chunk-0', 'chunk-1'], approved: true,
  });
  assert.equal(result.data.changes.length, 2);
  assert.equal(project.session.chunks.every((chunk) => chunk.approved), true);
  assert.equal(project.glossary.some((entry) => entry.source === 'new'), true);
});

test('processing adapters use the scheduler seam and bump project revision', async (t) => {
  const project = makeProject();
  let calls = 0;
  const fixtureValue = await fixture({
    project,
    reprocessChunk: async (args) => {
      calls += 1;
      return { jobId: `job-${args.chunkIndex}`, state: 'pending' };
    },
  });
  t.after(async () => { await fixtureValue.server.stop(); });
  const args = { projectId: 'project-1', expectedProjectRevision: 'r1', chunkIndex: 0 };
  const challenge = await requestJson(fixtureValue.server, mutationCall('reprocess_chunk', args, 'process-challenge'), { token: fixtureValue.issued.token });
  assert.equal(challenge.status, 428);
  const challengeId = challenge.body.error.details.challengeId;
  assert.equal(fixtureValue.server.confirmChallenge(challengeId), true);
  const confirmed = await requestJson(
    fixtureValue.server,
    mutationCall('reprocess_chunk', { ...args, challengeId }, 'process-confirm'),
    { token: fixtureValue.issued.token },
  );
  assert.equal(confirmed.status, 200);
  assert.equal(calls, 1);
  assert.equal(confirmed.body.result.data.jobId, 'job-0');
  assert.notEqual(confirmed.body.projectRevision, 'r1');
});

test('audit records mutation attempts without argument payload text and reads remain available', async (t) => {
  const project = makeProject();
  const fixtureValue = await fixture({ project });
  t.after(async () => { await fixtureValue.server.stop(); });
  const deniedFixture = await fixture({ project: makeProject(), permissionPolicy: {} });
  t.after(async () => { await deniedFixture.server.stop(); });
  await requestJson(deniedFixture.server, mutationCall('update_chunk_text', updateArgs({ text: 'payload-secret-text' }), 'audit-denied'), { token: deniedFixture.issued.token });
  const deniedAudit = deniedFixture.server.getAuditLog().at(-1);
  assert.equal(deniedAudit.mcpCode, MCP_ERROR_CODES.PERMISSION_DENIED);
  const auditText = JSON.stringify(deniedFixture.server.getAuditLog());
  assert.equal(auditText.includes('payload-secret-text'), false);

  const challengeResponse = await requestJson(
    fixtureValue.server,
    mutationCall('update_chunk_text', updateArgs({ text: 'confirmation-secret' }), 'audit-required'),
    { token: fixtureValue.issued.token },
  );
  assert.equal(fixtureValue.server.getAuditLog().at(-1).mcpCode, MCP_ERROR_CODES.CONFIRMATION_REQUIRED);
  await requestJson(
    fixtureValue.server,
    mutationCall('update_chunk_text', {
      ...updateArgs({ text: 'confirmation-secret', challengeId: challengeResponse.body.error.details.challengeId }),
    }, 'audit-invalid'),
    { token: fixtureValue.issued.token },
  );
  const invalidAudit = fixtureValue.server.getAuditLog().at(-1);
  assert.equal(invalidAudit.mcpCode, MCP_ERROR_CODES.CONFIRMATION_INVALID);
  assert.equal(invalidAudit.reason, 'not_approved');

  const read = await requestJson(
    fixtureValue.server,
    mutationCall('get_chunk', { projectId: 'project-1', chunkIndex: 0 }, 'read'),
    { token: fixtureValue.issued.token },
  );
  assert.equal(read.status, 200);
  assert.equal(read.body.result.scope, 'read');
});
test('default cancellation adapters receive a job id string after human approval', async (t) => {
  const project = makeProject();
  let received;
  const fixtureValue = await fixture({
    project,
    batchScheduler: {
      cancel(jobId) {
        received = jobId;
        return { jobId, state: 'cancelled' };
      },
    },
  });
  t.after(async () => { await fixtureValue.server.stop(); });
  const args = { projectId: 'project-1', expectedProjectRevision: 'r1', jobId: 'job-1' };
  const challenge = await requestJson(
    fixtureValue.server,
    mutationCall('cancel_processing', args, 'cancel-challenge'),
    { token: fixtureValue.issued.token },
  );
  const challengeId = challenge.body.error.details.challengeId;
  assert.equal(fixtureValue.server.confirmChallenge(challengeId), true);
  const response = await requestJson(
    fixtureValue.server,
    mutationCall('cancel_processing', { ...args, challengeId }, 'cancel-confirm'),
    { token: fixtureValue.issued.token },
  );
  assert.equal(response.status, 200);
  assert.equal(received, 'job-1');
});

test('processing status sanitizes custom and scheduler payloads', async () => {
  const custom = createMutationCatalog({
    permissionPolicy: {},
    getProcessingStatus: () => ({
      state: 'running',
      sourcePath: '/private/source.wav',
      filePath: '/private/file.wav',
      outputPath: '/private/output.wav',
      nested: { path: '/private/nested', safe: true },
    }),
  });
  const customResult = await custom.execute('get_processing_status', {});
  assert.equal(customResult.data.state, 'running');
  assert.equal('sourcePath' in customResult.data, false);
  assert.equal('filePath' in customResult.data, false);
  assert.equal('outputPath' in customResult.data, false);
  assert.equal('path' in customResult.data.nested, false);
  assert.equal(customResult.data.nested.safe, true);

  const scheduler = createMutationCatalog({
    permissionPolicy: {},
    batchScheduler: {
      status: () => ({ phase: 'scan', outputPath: '/private/output.wav', progress: 0.5 }),
    },
  });
  const schedulerResult = await scheduler.execute('get_processing_status', {});
  assert.equal(schedulerResult.data.phase, 'scan');
  assert.equal('outputPath' in schedulerResult.data, false);
  assert.equal(schedulerResult.data.progress, 0.5);
});

test('project store conflict maps to stale revision without replacing memory or disk', async (t) => {
  const project = makeProject();
  const disk = makeProject();
  let saveCalls = 0;
  const projectStore = {
    loadProject() {
      return JSON.parse(JSON.stringify(disk));
    },
    saveProject() {
      saveCalls += 1;
      const error = new Error('store CAS conflict');
      error.code = 'CONFLICT';
      error.details = { currentRevision: 'r2' };
      throw error;
    },
  };
  const fixtureValue = await fixture({ project, projectStore });
  t.after(async () => { await fixtureValue.server.stop(); });
  const beforeMemory = JSON.stringify(project);
  const beforeDisk = JSON.stringify(disk);
  const args = updateArgs({ text: 'must-not-persist' });
  const challenge = await requestJson(
    fixtureValue.server,
    mutationCall('update_chunk_text', args, 'cas-challenge'),
    { token: fixtureValue.issued.token },
  );
  const challengeId = challenge.body.error.details.challengeId;
  assert.equal(fixtureValue.server.confirmChallenge(challengeId), true);
  const response = await requestJson(
    fixtureValue.server,
    mutationCall('update_chunk_text', { ...args, challengeId }, 'cas-execute'),
    { token: fixtureValue.issued.token },
  );
  assert.equal(response.status, 409);
  assert.equal(response.body.error.code, MCP_ERROR_CODES.STALE_REVISION);
  assert.equal(saveCalls, 1);
  assert.equal(JSON.stringify(project), beforeMemory);
  assert.equal(JSON.stringify(disk), beforeDisk);
});

test('approve_chunk honors explicit revoke and glossary bounds', async () => {
  const project = makeProject();
  const catalog = createMutationCatalog({ project, permissionPolicy: { mutation: true } });
  const context = { projectId: 'project-1', tokenId: 'bounds-client' };
  let challenge;
  try {
    await catalog.execute('approve_chunk', {
      projectId: 'project-1', expectedProjectRevision: project.revision, chunkIndex: 0, approved: false,
    }, context);
  } catch (error) {
    challenge = error.details.challengeId;
  }
  assert.equal(catalog.confirmations.approve(challenge), true);
  const revoked = await catalog.execute('approve_chunk', {
    projectId: 'project-1', expectedProjectRevision: project.revision, chunkIndex: 0, approved: false, challengeId: challenge,
  }, context);
  assert.equal(revoked.data.approved, false);
  assert.equal(project.session.chunks[0].approved, false);

  const oversized = {
    projectId: 'project-1',
    expectedProjectRevision: project.revision,
    source: 'x'.repeat(100_001),
    translation: 'ok',
  };
  let oversizedChallenge;
  try {
    await catalog.execute('create_glossary_entry', oversized, context);
  } catch (error) {
    oversizedChallenge = error.details.challengeId;
  }
  assert.equal(catalog.confirmations.approve(oversizedChallenge), true);
  await assert.rejects(
    catalog.execute('create_glossary_entry', { ...oversized, challengeId: oversizedChallenge }, context),
    (error) => error.mcpCode === 'MCP_INVALID_REQUEST',
  );

  const variants = Array.from({ length: 101 }, (_, index) => `v-${index}`);
  const variantArgs = {
    projectId: 'project-1',
    expectedProjectRevision: project.revision,
    source: 'bounded',
    translation: 'terme',
    variants,
  };
  let variantChallenge;
  try {
    await catalog.execute('create_glossary_entry', variantArgs, context);
  } catch (error) {
    variantChallenge = error.details.challengeId;
  }
  assert.equal(catalog.confirmations.approve(variantChallenge), true);
  await assert.rejects(
    catalog.execute('create_glossary_entry', { ...variantArgs, challengeId: variantChallenge }, context),
    (error) => error.mcpCode === 'MCP_INVALID_REQUEST',
  );
});
