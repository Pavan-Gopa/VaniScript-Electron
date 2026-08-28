'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const {
  createSafeLogger,
  createObservability,
  safeError,
  safeIpcError,
  safeMcpError,
  safeAuditRecord,
  MAX_RECORD_BYTES,
} = require('../electron/main/observability.js');
const {
  createDefaultUsageLedger,
  migrateLegacyUsage,
  recordUsage,
  projectUsage,
  migrateSettings,
} = require('../shared/contracts/settings-runtime.js');

function parseLine(line) {
  return JSON.parse(line);
}

test('safe sink emits the exact bounded outer record and hashes correlation', () => {
  const lines = [];
  const logger = createSafeLogger((line) => lines.push(line), {
    clock: () => new Date('2026-08-28T00:00:00.000Z'),
    knownSecrets: ['vault-secret-value'],
  });
  const record = logger.error({
    category: 'provider',
    event: 'provider.failed',
    correlation: { requestId: 'req-123', projectId: 'project-123', operationId: 'op-1', jobId: 'job-1' },
    data: {
      providerId: 'gemini-cloud',
      modelId: 'gemini-2.5-flash',
      purpose: 'translation',
      status: 503,
      apiKey: 'vault-secret-value',
      bearer: 'Bearer injected-token-value',
      nested: {
        transcript: 'TRANSCRIPT_MARKER',
        stderr: 'STDERR_MARKER',
        sourcePath: '/Users/pavan/private/audio.wav',
        url: 'https://provider.test/generate?key=query-secret',
        unknown: 'UNKNOWN_MARKER',
      },
      raw: true,
      redact: false,
    },
    error: Object.assign(new Error('PROVIDER_ERROR TRANSCRIPT_MARKER /Users/pavan'), {
      code: 'PROVIDER_ERROR',
      stack: 'STACK_MARKER',
    }),
  });
  assert.equal(lines.length, 1);
  const parsed = parseLine(lines[0]);
  assert.deepEqual(Object.keys(parsed).sort(), ['category', 'correlation', 'data', 'error', 'event', 'level', 'redactions', 'schemaVersion', 'timestamp'].sort());
  assert.equal(parsed.schemaVersion, 1);
  assert.equal(parsed.timestamp, '2026-08-28T00:00:00.000Z');
  assert.equal(parsed.level, 'error');
  assert.equal(parsed.category, 'provider');
  assert.match(parsed.correlation.requestId, /^[0-9a-f]{32}$/);
  assert.equal(parsed.data.providerId, 'gemini-cloud');
  assert.equal(parsed.data.status, 503);
  const serialized = lines[0];
  for (const marker of ['vault-secret-value', 'injected-token-value', 'TRANSCRIPT_MARKER', 'STDERR_MARKER', '/Users/pavan', 'query-secret', 'UNKNOWN_MARKER', 'STACK_MARKER']) {
    assert.equal(serialized.includes(marker), false, `leaked ${marker}`);
  }
  assert.equal(record.error.message, 'Provider request failed.');
  assert.ok(record.redactions.secret >= 2);
  assert.ok(record.redactions.path >= 2);
  assert.ok(record.redactions.text >= 2);
  assert.ok(Buffer.byteLength(lines[0], 'utf8') <= MAX_RECORD_BYTES);
});

test('unknown event and bypass fields cannot opt out of recursive redaction', () => {
  const lines = [];
  const logger = createSafeLogger((line) => lines.push(line));
  logger.info({
    category: 'future-category',
    event: 'An arbitrary user supplied event',
    data: {
      redact: false,
      raw: true,
      accessToken: 'Bearer token-value',
      manuscriptText: 'MANUSCRIPT_MARKER',
      nested: [{ output: 'OUTPUT_MARKER' }, { absolutePath: '/tmp/marker.txt' }],
    },
  });
  const parsed = parseLine(lines[0]);
  assert.equal(parsed.category, 'runtime');
  assert.equal(parsed.event, 'unknown');
  const serialized = lines[0];
  assert.equal(serialized.includes('token-value'), false);
  assert.equal(serialized.includes('MANUSCRIPT_MARKER'), false);
  assert.equal(serialized.includes('OUTPUT_MARKER'), false);
  assert.equal(serialized.includes('/tmp/marker.txt'), false);
  assert.equal(parsed.data.redact, undefined);
  assert.equal(parsed.data.raw, undefined);
});
test('sink failures are swallowed and counted without affecting telemetry accessors', () => {
  const logger = createSafeLogger(() => {
    throw new Error('sink unavailable');
  });
  assert.doesNotThrow(() => logger.info({ category: 'runtime', event: 'runtime.sink-test' }));
  assert.equal(logger.getSinkFailures(), 1);

  const obs = createObservability({
    sink: () => {
      throw new Error('sink unavailable');
    },
  });
  assert.doesNotThrow(() => obs.logger.warn({ category: 'runtime', event: 'runtime.sink-test' }));
  assert.ok(obs.getTelemetryFailures() >= 1);
});


test('safe error and IPC/MCP envelopes retain codes while dropping raw details', () => {
  const error = Object.assign(new Error('secret TRANSCRIPT /Users/a'), {
    code: 'PROVIDER_ERROR',
    status: 502,
    details: { stack: 'STACK', challengeId: 'challenge-1', reason: 'challenge_mismatch', raw: 'PAYLOAD' },
  });
  assert.deepEqual(safeError(error), {
    name: 'Error',
    code: 'PROVIDER_ERROR',
    message: 'Provider request failed.',
    status: 502,
  });
  const ipc = safeIpcError(error);
  assert.equal(ipc.message, 'Provider request failed.');
  assert.equal(JSON.stringify(ipc).includes('secret'), false);
  const mcp = safeMcpError(Object.assign(new Error('PAYLOAD'), {
    code: 'MCP_CONFIRMATION_INVALID',
    details: { challengeId: 'challenge-1', reason: 'challenge_mismatch', raw: 'PAYLOAD' },
  }));
  assert.equal(mcp.code, 'MCP_CONFIRMATION_INVALID');
  assert.equal(mcp.details.challengeId, 'challenge-1');
  assert.equal(JSON.stringify(mcp).includes('PAYLOAD'), false);
});

test('usage ledger counts terminal operations once, retries separately, and projects dates', () => {
  const at = new Date('2026-08-28T12:00:00.000Z');
  let ledger = createDefaultUsageLedger();
  ledger = recordUsage(ledger, {
    operationId: 'op-1', providerId: 'gemini-cloud', modelId: 'gemini-2.5-flash', purpose: 'translation', outcome: 'success', inputTokens: 100, outputTokens: 20,
  }, at);
  const duplicate = recordUsage(ledger, {
    operationId: 'op-1', providerId: 'gemini-cloud', modelId: 'gemini-2.5-flash', purpose: 'translation', outcome: 'success', inputTokens: 100, outputTokens: 20,
  }, new Date(at.getTime() + 1000));
  assert.equal(duplicate.requests, 1);
  ledger = recordUsage(duplicate, {
    operationId: 'retry-1', providerId: 'gemini-cloud', modelId: 'gemini-2.5-flash', purpose: 'translation', outcome: 'error', inputTokens: 999, outputTokens: 999,
  }, new Date(at.getTime() + 86400000));
  assert.equal(ledger.requests, 1);
  assert.equal(ledger.errors, 1);
  assert.equal(ledger.inputTokens, 100);
  assert.equal(ledger.outputTokens, 20);
  assert.equal(ledger.providers['gemini-cloud'].purposes.translation.requests, 1);
  assert.equal(ledger.providers['gemini-cloud'].purposes.translation.errors, 1);
  assert.equal(projectUsage(ledger, { from: '2026-08-28', to: '2026-08-28' }).requests, 1);
  assert.equal(projectUsage(ledger, { from: '2026-08-29', to: '2026-08-29' }).errors, 1);
  assert.equal(Object.prototype.hasOwnProperty.call(projectUsage(ledger), 'recentOperationHashes'), false);
});

test('legacy usage migration preserves all-time provider totals and settings v2', () => {
  const ledger = migrateLegacyUsage({
    'gemini-cloud': { sessions: 3, inputTokens: 400, outputTokens: 120, audioMinutes: 2, lastUsed: '2026-08-27T00:00:00.000Z' },
    'gpt-cloud': { sessions: 1, inputTokens: 20, outputTokens: 10 },
  });
  assert.equal(ledger.requests, 4);
  assert.equal(ledger.inputTokens, 420);
  assert.equal(ledger.providers['gemini-cloud'].requests, 3);
  assert.equal(ledger.daily && Object.keys(ledger.daily).length, 0);
  const migrated = migrateSettings({ api: { lastUsage: { 'gemini-cloud': { sessions: 2, inputTokens: 5 } } } });
  assert.equal(migrated.settings.schemaVersion, 2);
  assert.equal(migrated.settings.api.lastUsage.requests, 2);
});

test('Main usage persistence is atomic and failures do not throw', () => {
  let settings = { schemaVersion: 2, api: { lastUsage: createDefaultUsageLedger(), providers: {} } };
  let writes = 0;
  const obs = createObservability({
    sink: () => {},
    settingsStore: {
      readSettings: () => settings,
      writeSettings: (next) => { writes += 1; settings = next; },
    },
    clock: () => new Date('2026-08-28T00:00:00.000Z'),
  });
  const result = obs.usage.record({ operationId: 'atomic-1', providerId: 'gpt-cloud', modelId: 'gpt-4o-mini', purpose: 'chat', outcome: 'success', inputTokens: 4, outputTokens: 3 });
  assert.equal(result.requests, 1);
  assert.equal(writes, 1);
  assert.deepEqual(settings.api.providers, {});
  assert.equal(settings.api.lastUsage.providers['gpt-cloud'].requests, 1);
  const reset = obs.usage.reset();
  assert.equal(reset.requests, 0);
});

test('audit helper retains only shared allowlist and bounded retention', () => {
  const record = safeAuditRecord({
    peer: '127.0.0.1', route: '/message', method: 'POST', tool: 'project.read', outcome: 'denied',
    mcpCode: 'MCP_UNAUTHORIZED', reason: 'unauthorized', tokenId: 'Bearer TOKEN', requestId: 'request-1', body: 'BODY_MARKER',
  });
  assert.equal(record.peer, '127.0.0.1');
  assert.equal(record.route, '/message');
  assert.equal(record.method, 'POST');
  assert.match(record.tokenIdHash, /^[0-9a-f]{64}$/);
  assert.equal(Object.prototype.hasOwnProperty.call(record, 'body'), false);
  assert.equal(JSON.stringify(record).includes('BODY_MARKER'), false);
  const obs = createObservability({ sink: () => {} });
  for (let i = 0; i < 1100; i += 1) obs.audit.record({ peer: '127.0.0.1', route: '/sse', outcome: 'success' });
  assert.equal(obs.audit.list().length, 1000);
});
