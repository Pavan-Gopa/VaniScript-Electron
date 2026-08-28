'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { createObservability, createLegacyAuditRecorder, safeMcpError } = require('../electron/main/observability.js');
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const http = require('node:http');

const MAIN_SOURCE = fs.readFileSync(path.join(__dirname, '..', 'electron', 'main.js'), 'utf8');

test('legacy audit seam projects hostile request metadata through shared allowlist', () => {
  const obs = createObservability({ sink: () => {} });
  const recordLegacyAudit = createLegacyAuditRecorder(obs.audit, () => new Date('2026-08-28T00:00:00.000Z'));
  const record = recordLegacyAudit({
    peer: '127.0.0.1',
    route: '/message?sessionId=SESSION_MARKER',
    method: 'POST',
    tool: 'update_chunk_text',
    outcome: 'rejected',
    mcpCode: 'MCP_INVALID_REQUEST',
    reason: 'parse_failed',
    requestId: 'REQUEST_MARKER',
    tokenId: 'Bearer SECRET_MARKER',
    body: 'TRANSCRIPT_MARKER',
    args: { source: 'MANUSCRIPT_MARKER', path: '/Users/private/source.txt' },
  });
  assert.equal(record.timestamp, '2026-08-28T00:00:00.000Z');
  assert.equal(record.peer, '127.0.0.1');
  assert.equal(record.method, 'POST');
  assert.equal(record.mcpCode, 'MCP_INVALID_REQUEST');
  assert.match(record.requestIdHash, /^[0-9a-f]{64}$/);
  assert.match(record.tokenIdHash, /^[0-9a-f]{64}$/);
  const serialized = JSON.stringify(record);
  for (const marker of ['SESSION_MARKER', 'REQUEST_MARKER', 'SECRET_MARKER', 'TRANSCRIPT_MARKER', 'MANUSCRIPT_MARKER', '/Users/private']) {
    assert.equal(serialized.includes(marker), false, `leaked ${marker}`);
  }
});

function extractFunctionBody(source, name) {
  const marker = `function ${name}()`;
  const start = source.indexOf(marker);
  assert.ok(start !== -1, `${name} is defined in main.js`);
  const open = source.indexOf('{', start);
  let depth = 0;
  for (let index = open; index < source.length; index += 1) {
    if (source[index] === '{') depth += 1;
    else if (source[index] === '}') {
      depth -= 1;
      if (depth === 0) return source.slice(open + 1, index);
    }
  }
  throw new Error(`Unbalanced function body for ${name}`);
}

function sliceBetween(source, startMarker, endMarker) {
  const start = source.indexOf(startMarker);
  assert.ok(start !== -1, `start marker found: ${startMarker}`);
  const end = source.indexOf(endMarker, start);
  assert.ok(end !== -1, `end marker found: ${endMarker}`);
  return source.slice(start, end);
}

function startLegacyHarness({ mainCatalog, observability, windowManager }) {
  let actualServer = null;
  const requireSeam = (specifier) => {
    if (specifier === 'http') {
      return {
        createServer(handler) {
          actualServer = http.createServer(handler);
          const listen = actualServer.listen.bind(actualServer);
          actualServer.listen = (_productionPort, host, callback) => listen(0, host, callback);
          return actualServer;
        },
      };
    }
    if (specifier === 'url') return require('node:url');
    throw new Error(`Unexpected production transport dependency: ${specifier}`);
  };
  const authHelpers = sliceBetween(
    MAIN_SOURCE,
    'function isMcpAuthorized',
    'function startMcpServer',
  );
  const startBody = extractFunctionBody(MAIN_SOURCE, 'startMcpServer');
  const buildHarness = new Function(
    'require',
    'crypto',
    'safeLogger',
    'observability',
    'createLegacyAuditRecorder',
    'safeMcpError',
    'MCP_MAIN_TOOL_DEFINITIONS',
    'dispatchedMcpToolCatalog',
    'mcpToolRpcError',
    'windowManager',
    `"use strict";
let mcpHttpServer = null;
const activeSseConnections = new Map();
const pendingMcpRequests = new Map();
let mcpAccessToken = '';
${authHelpers}
function startMcpServer() {
${startBody}
}
startMcpServer();
return {
  get server() { return mcpHttpServer; },
  get token() { return mcpAccessToken; },
  get pending() { return pendingMcpRequests; },
};`,
  );
  return buildHarness(
    requireSeam,
    crypto,
    { info() {}, warn() {}, error() {} },
    observability,
    createLegacyAuditRecorder,
    safeMcpError,
    [],
    (name) => (name === 'export_transcript' ? mainCatalog : null),
    () => ({ code: -32603, message: 'MCP tool call failed.' }),
    windowManager,
  );
}

function makeSseReader(response) {
  let buffer = '';
  const queued = [];
  const waiters = [];

  function publish(event) {
    const waiterIndex = waiters.findIndex((waiter) => !waiter.name || waiter.name === event.name);
    if (waiterIndex !== -1) {
      const [waiter] = waiters.splice(waiterIndex, 1);
      waiter.resolve(event);
      return;
    }
    queued.push(event);
  }

  response.setEncoding('utf8');
  response.on('data', (chunk) => {
    buffer += chunk.replace(/\r\n/g, '\n');
    let boundary = buffer.indexOf('\n\n');
    while (boundary !== -1) {
      const block = buffer.slice(0, boundary);
      buffer = buffer.slice(boundary + 2);
      const lines = block.split('\n');
      const name = lines.find((line) => line.startsWith('event:'))?.slice(6).trim() || 'message';
      const data = lines
        .filter((line) => line.startsWith('data:'))
        .map((line) => line.slice(5).trimStart())
        .join('\n');
      publish({ name, data });
      boundary = buffer.indexOf('\n\n');
    }
  });

  return {
    next(name) {
      const queuedIndex = queued.findIndex((event) => !name || event.name === name);
      if (queuedIndex !== -1) return Promise.resolve(queued.splice(queuedIndex, 1)[0]);
      return new Promise((resolve) => waiters.push({ name, resolve }));
    },
  };
}

function waitForListening(server) {
  if (server.listening) return Promise.resolve();
  return new Promise((resolve, reject) => {
    server.once('listening', resolve);
    server.once('error', reject);
  });
}

function openSse(server, token) {
  const address = server.address();
  assert.ok(address && typeof address === 'object');
  return new Promise((resolve, reject) => {
    const request = http.request({
      host: '127.0.0.1',
      port: address.port,
      path: '/sse',
      method: 'GET',
      headers: { Authorization: `Bearer ${token}` },
    });
    request.on('error', reject);
    request.on('response', (response) => {
      if (response.statusCode !== 200) {
        response.resume();
        reject(new Error(`Unexpected SSE status ${response.statusCode}`));
        return;
      }
      const events = makeSseReader(response);
      events.next('endpoint')
        .then((endpoint) => resolve({
          response,
          events,
          endpoint: endpoint.data,
          port: address.port,
        }))
        .catch(reject);
    });
    request.end();
  });
}

function postRpc(client, token, rpc) {
  const body = JSON.stringify(rpc);
  return new Promise((resolve, reject) => {
    const request = http.request({
      host: '127.0.0.1',
      port: client.port,
      path: client.endpoint,
      method: 'POST',
      headers: {
        Authorization: `Bearer ${token}`,
        'Content-Type': 'application/json',
        'Content-Length': Buffer.byteLength(body),
      },
    }, (response) => {
      response.resume();
      response.on('end', () => resolve(response.statusCode));
    });
    request.on('error', reject);
    request.end(body);
  });
}

test('legacy production failure branches audit once with safe reasons', async (t) => {
  const obs = createObservability({
    sink: () => {},
    clock: () => new Date('2026-08-28T00:00:00.000Z'),
  });
  const rendererCalls = [];
  const harness = startLegacyHarness({
    observability: obs,
    mainCatalog: {
      execute: async () => {
        throw Object.assign(new Error('CATALOG_SECRET /Users/private/catalog.txt'), { code: 'MCP_INTERNAL' });
      },
    },
    windowManager: {
      getMainWindow: () => ({
        webContents: {
          send: (channel, payload) => rendererCalls.push({ channel, payload }),
        },
      }),
    },
  });
  let client = null;
  t.after(async () => {
    client?.response.destroy();
    if (harness.server?.listening) {
      await new Promise((resolve) => harness.server.close(resolve));
    }
  });

  await waitForListening(harness.server);
  client = await openSse(harness.server, harness.token);

  const catalogEvent = client.events.next('message');
  assert.equal(await postRpc(client, harness.token, {
    jsonrpc: '2.0',
    id: 'catalog-failure',
    method: 'tools/call',
    params: { name: 'export_transcript', arguments: {} },
  }), 202);
  const catalogResponse = JSON.parse((await catalogEvent).data);
  assert.equal(catalogResponse.id, 'catalog-failure');
  assert.equal(catalogResponse.error.code, -32603);
  assert.equal(JSON.stringify(catalogResponse).includes('CATALOG_SECRET'), false);
  const catalogAudits = obs.audit.list().filter((row) => (
    row.route === '/message' && row.tool === 'export_transcript'
  ));
  assert.equal(catalogAudits.length, 1);
  assert.equal(catalogAudits[0].outcome, 'rejected');
  assert.equal(catalogAudits[0].reason, 'server_error');

  const rendererEvent = client.events.next('message');
  assert.equal(await postRpc(client, harness.token, {
    jsonrpc: '2.0',
    id: 'renderer-failure',
    method: 'tools/call',
    params: { name: 'get_project_state', arguments: {} },
  }), 202);
  assert.equal(rendererCalls.length, 1);
  const forwarded = rendererCalls[0].payload;
  const pending = harness.pending.get(forwarded.requestId);
  assert.ok(pending);
  pending.reject(Object.assign(new Error('RENDERER_SECRET /Users/private/renderer.txt'), { code: 'PROVIDER_ERROR' }));
  const rendererResponse = JSON.parse((await rendererEvent).data);
  assert.equal(rendererResponse.id, 'renderer-failure');
  assert.equal(rendererResponse.error.code, -32603);
  assert.equal(JSON.stringify(rendererResponse).includes('RENDERER_SECRET'), false);
  const rendererAudits = obs.audit.list().filter((row) => row.reason === 'renderer_rejected');
  assert.equal(rendererAudits.length, 1);
  assert.equal(rendererAudits[0].outcome, 'rejected');
  assert.equal(rendererAudits[0].mcpCode, 'PROVIDER_ERROR');

  const beforeServerError = obs.audit.list().length;
  harness.server.emit('error', new Error('EADDRINUSE /Users/private/socket'));
  const serverAudits = obs.audit.list().slice(beforeServerError);
  assert.equal(serverAudits.length, 1);
  assert.equal(serverAudits[0].route, '/sse');
  assert.equal(serverAudits[0].tool, null);
  assert.equal(serverAudits[0].outcome, 'rejected');
  assert.equal(serverAudits[0].reason, 'server_error');
  assert.equal(serverAudits[0].mcpCode, 'MCP_INTERNAL');
});
test('legacy audit retention remains bounded at one thousand records', () => {
  const obs = createObservability({ sink: () => {} });
  const recordLegacyAudit = createLegacyAuditRecorder(obs.audit, () => new Date('2026-08-28T00:00:00.000Z'));
  for (let i = 0; i < 1200; i += 1) recordLegacyAudit({ peer: '127.0.0.1', route: '/sse', method: 'GET', outcome: 'success' });
  assert.equal(obs.audit.list().length, 1000);
});
