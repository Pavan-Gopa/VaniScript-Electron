const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const net = require('node:net');
const crypto = require('node:crypto');

const {
  McpServer,
  McpServerError,
  MCP_ERROR_CODES,
  timingSafeTokenEqual,
} = require('../electron/main/mcp/mcpServer.js');

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

function makeServer(options = {}) {
  const vault = options.vault || new MemoryVault();
  const server = new McpServer({
    host: '127.0.0.1',
    port: 0,
    vault,
    ...options,
  });
  const issued = server.rotateToken();
  return { server, issued, vault };
}

async function startFixture(options = {}) {
  const fixture = makeServer(options);
  await fixture.server.start();
  return fixture;
}

function requestJson(server, body, options = {}) {
  const port = server.getStatus().port;
  const payload = body === undefined ? '' : JSON.stringify(body);
  const headers = {
    ...(body === undefined ? {} : {
      'content-type': 'application/json',
      'content-length': Buffer.byteLength(payload),
    }),
    ...(options.headers || {}),
  };
  if (options.token !== undefined) headers.authorization = `Bearer ${options.token}`;
  return new Promise((resolve, reject) => {
    const req = http.request({
      host: server.host,
      port,
      path: options.path || '/mcp',
      method: options.method || 'POST',
      headers,
      agent: false,
    }, (res) => {
      const chunks = [];
      res.on('data', (chunk) => chunks.push(chunk));
      res.on('end', () => {
        const text = Buffer.concat(chunks).toString('utf8');
        let parsed = null;
        try { parsed = text ? JSON.parse(text) : null; } catch { /* keep raw */ }
        resolve({ status: res.statusCode, headers: res.headers, body: parsed, raw: text });
      });
    });
    req.on('error', reject);
    if (options.writeChunks) {
      for (const chunk of options.writeChunks) req.write(chunk);
      if (options.end !== false) req.end();
    } else if (options.slowBodyMs) {
      req.write(payload.slice(0, Math.max(1, Math.floor(payload.length / 2))));
      setTimeout(() => req.end(payload.slice(Math.max(1, Math.floor(payload.length / 2)))), options.slowBodyMs);
    } else {
      req.end(payload);
    }
  });
}

test('rejects any non-loopback bind before opening a socket', () => {
  assert.throws(
    () => new McpServer({ host: '0.0.0.0', port: 0, vault: new MemoryVault() }),
    (error) => error instanceof McpServerError && error.code === MCP_ERROR_CODES.BIND_REJECTED,
  );
  assert.throws(
    () => new McpServer({ host: '192.168.1.5', port: 0, vault: new MemoryVault() }),
    (error) => error.code === MCP_ERROR_CODES.BIND_REJECTED,
  );
});

test('uses constant-time token comparison over fixed-size digests', () => {
  assert.equal(timingSafeTokenEqual('abc', 'abc'), true);
  assert.equal(timingSafeTokenEqual('abc', 'abcd'), false);
  assert.equal(timingSafeTokenEqual('', ''), true);
  assert.equal(timingSafeTokenEqual(null, 'abc'), false);
});

test('rejects missing and invalid bearer tokens with 401-class typed errors', async (t) => {
  const fixture = await startFixture();
  t.after(() => fixture.server.stop());

  const missing = await requestJson(fixture.server, { jsonrpc: '2.0', id: 1, method: 'initialize' });
  assert.equal(missing.status, 401);
  assert.equal(missing.body.error.code, MCP_ERROR_CODES.UNAUTHORIZED);

  const malformed = await requestJson(
    fixture.server,
    { jsonrpc: '2.0', id: 2, method: 'initialize' },
    { headers: { authorization: 'Basic not-bearer' } },
  );
  assert.equal(malformed.status, 401);
  assert.equal(malformed.body.error.code, MCP_ERROR_CODES.UNAUTHORIZED);

  const invalid = await requestJson(
    fixture.server,
    { jsonrpc: '2.0', id: 3, method: 'initialize' },
    { token: `${fixture.issued.token}wrong` },
  );
  assert.equal(invalid.status, 401);
  assert.equal(invalid.body.error.code, MCP_ERROR_CODES.UNAUTHORIZED);
});

test('valid handshake negotiates MCP version and echoes project envelope fields', async (t) => {
  const fixture = await startFixture();
  t.after(() => fixture.server.stop());

  const response = await requestJson(
    fixture.server,
    {
      jsonrpc: '2.0',
      id: 'handshake-1',
      method: 'initialize',
      params: { protocolVersion: '2025-03-26' },
      projectId: 'project-7',
      projectRevision: 12,
    },
    { token: fixture.issued.token, headers: { 'x-request-id': 'request-7' } },
  );
  assert.equal(response.status, 200);
  assert.equal(response.body.result.protocolVersion, '2025-03-26');
  assert.equal(response.body.requestId, 'request-7');
  assert.equal(response.body.projectId, 'project-7');
  assert.equal(response.body.projectRevision, 12);
  assert.equal(response.body.result.serverInfo.name, 'vaniscript-electron-mcp');
});

test('unsupported protocol versions return a typed negotiation error', async (t) => {
  const fixture = await startFixture();
  t.after(() => fixture.server.stop());
  const response = await requestJson(
    fixture.server,
    {
      jsonrpc: '2.0',
      id: 9,
      method: 'initialize',
      params: { protocolVersion: '2099-01-01' },
    },
    { token: fixture.issued.token },
  );
  assert.equal(response.status, 400);
  assert.equal(response.body.error.code, MCP_ERROR_CODES.UNSUPPORTED_VERSION);
});

test('rotation and revoke invalidate old credentials while preserving vault references', async (t) => {
  const fixture = await startFixture();
  t.after(() => fixture.server.stop());
  const old = fixture.issued;
  const rotated = fixture.server.rotateToken();
  assert.notEqual(rotated.token, old.token);
  assert.match(rotated.tokenRef, /^mcp:token:/);
  assert.equal(fixture.server.getStatus().tokenRef, rotated.tokenRef);
  assert.equal(fixture.vault.values.has(rotated.tokenRef), true);

  const revoked = await requestJson(
    fixture.server,
    { jsonrpc: '2.0', id: 1, method: 'initialize' },
    { token: old.token },
  );
  assert.equal(revoked.status, 401);
  assert.equal(revoked.body.error.code, MCP_ERROR_CODES.TOKEN_REVOKED);

  const valid = await requestJson(
    fixture.server,
    { jsonrpc: '2.0', id: 2, method: 'initialize' },
    { token: rotated.token },
  );
  assert.equal(valid.status, 200);

  assert.equal(fixture.server.revokeToken(rotated.tokenId), true);
  const afterRevoke = await requestJson(
    fixture.server,
    { jsonrpc: '2.0', id: 3, method: 'initialize' },
    { token: rotated.token },
  );
  assert.equal(afterRevoke.status, 401);
  assert.equal(afterRevoke.body.error.code, MCP_ERROR_CODES.TOKEN_REVOKED);
});

test('expired tokens are rejected without exposing their value', async (t) => {
  const fixture = makeServer();
  const short = fixture.server.rotateToken({ ttlMs: 15 });
  await fixture.server.start();
  t.after(() => fixture.server.stop());
  await new Promise((resolve) => setTimeout(resolve, 30));
  const response = await requestJson(
    fixture.server,
    { jsonrpc: '2.0', id: 1, method: 'initialize' },
    { token: short.token },
  );
  assert.equal(response.status, 401);
  assert.equal(response.body.error.code, MCP_ERROR_CODES.TOKEN_EXPIRED);
  assert.equal(JSON.stringify(fixture.server.getAuditLog()).includes(short.token), false);
});

test('audit records are bounded and redact request payload text', async (t) => {
  const fixture = await startFixture({ auditRetention: 6 });
  t.after(() => fixture.server.stop());
  const payloadMarkerA = 'payload-manuscript-secret-1';
  const payloadMarkerB = 'payload-manuscript-secret-2';
  const headerMarkerA = 'header-manuscript-secret-1';
  const headerMarkerB = 'header-manuscript-secret-2';
  const hash = (value) => crypto.createHash('sha256').update(value, 'utf8').digest('hex');

  await requestJson(
    fixture.server,
    {
      jsonrpc: '2.0',
      id: 'audit-warmup',
      method: 'initialize',
      params: { protocolVersion: '2024-11-05' },
    },
    { token: fixture.issued.token },
  );
  await requestJson(
    fixture.server,
    {
      jsonrpc: '2.0',
      id: 'audit-payload-1',
      method: 'initialize',
      requestId: payloadMarkerA,
      params: { protocolVersion: '2024-11-05', secret: payloadMarkerA },
    },
    { token: fixture.issued.token },
  );
  await requestJson(
    fixture.server,
    {
      jsonrpc: '2.0',
      id: 'audit-payload-2',
      method: 'initialize',
      requestId: payloadMarkerA,
      params: { protocolVersion: '2024-11-05', secret: payloadMarkerA },
    },
    { token: fixture.issued.token },
  );
  await requestJson(
    fixture.server,
    {
      jsonrpc: '2.0',
      id: 'audit-payload-3',
      method: 'initialize',
      requestId: payloadMarkerB,
      params: { protocolVersion: '2024-11-05', secret: payloadMarkerB },
    },
    { token: fixture.issued.token },
  );
  await requestJson(
    fixture.server,
    { jsonrpc: '2.0', id: 'audit-header-1', method: 'missing' },
    { token: fixture.issued.token, headers: { 'x-request-id': headerMarkerA } },
  );
  await requestJson(
    fixture.server,
    { jsonrpc: '2.0', id: 'audit-header-2', method: 'missing' },
    { token: fixture.issued.token, headers: { 'x-request-id': headerMarkerA } },
  );
  await requestJson(
    fixture.server,
    { jsonrpc: '2.0', id: 'audit-header-3', method: 'missing' },
    { token: fixture.issued.token, headers: { 'x-request-id': headerMarkerB } },
  );

  const records = fixture.server.getAuditLog();
  assert.equal(records.length, 6);
  const serializedRecords = JSON.stringify(records);
  for (const marker of [payloadMarkerA, payloadMarkerB, headerMarkerA, headerMarkerB]) {
    assert.equal(serializedRecords.includes(marker), false);
  }
  assert.equal(serializedRecords.includes(fixture.issued.token), false);
  assert.equal(records.every((record) => !('requestId' in record) && typeof record.requestIdHash === 'string'), true);
  assert.equal(records[0].requestIdHash, hash(payloadMarkerA));
  assert.equal(records[1].requestIdHash, records[0].requestIdHash);
  assert.notEqual(records[2].requestIdHash, records[0].requestIdHash);
  assert.equal(records[3].requestIdHash, hash(headerMarkerA));
  assert.equal(records[4].requestIdHash, records[3].requestIdHash);
  assert.notEqual(records[5].requestIdHash, records[3].requestIdHash);
  assert.equal(records[5].tool, 'missing');
});

test('request size limit rejects large bodies before dispatch', async (t) => {
  let called = false;
  const fixture = await startFixture({
    maxRequestBytes: 128,
    requestHandler: async () => { called = true; return { ok: true }; },
  });
  t.after(() => fixture.server.stop());
  const response = await requestJson(
    fixture.server,
    { jsonrpc: '2.0', id: 1, method: 'echo', params: { text: 'x'.repeat(512) } },
    { token: fixture.issued.token },
  );
  assert.equal(response.status, 413);
  assert.equal(response.body.error.code, MCP_ERROR_CODES.REQUEST_TOO_LARGE);
  assert.equal(called, false);
});

test('per-request timeout returns typed 408 instead of hanging', async (t) => {
  const fixture = await startFixture({
    requestTimeoutMs: 30,
    requestHandler: async () => new Promise((resolve) => setTimeout(() => resolve({ late: true }), 200)),
  });
  t.after(() => fixture.server.stop({ timeoutMs: 200 }));
  const response = await requestJson(
    fixture.server,
    { jsonrpc: '2.0', id: 1, method: 'slow' },
    { token: fixture.issued.token },
  );
  assert.equal(response.status, 408);
  assert.equal(response.body.error.code, MCP_ERROR_CODES.REQUEST_TIMEOUT);
  assert.equal(fixture.server.getAuditLog().at(-1).outcome, 'timeout');
});

test('global concurrency cap rejects floods while an active handler is pending', async (t) => {
  let release;
  let started = 0;
  const pending = new Promise((resolve) => { release = resolve; });
  const fixture = await startFixture({
    maxConcurrency: 1,
    requestTimeoutMs: 500,
    requestHandler: async () => {
      started += 1;
      await pending;
      return { done: true };
    },
  });
  t.after(() => fixture.server.stop({ timeoutMs: 200 }));

  const first = requestJson(fixture.server, { jsonrpc: '2.0', id: 1, method: 'slow' }, { token: fixture.issued.token });
  for (let i = 0; i < 20 && started === 0; i += 1) await new Promise((resolve) => setTimeout(resolve, 5));
  assert.equal(started, 1);
  const second = await requestJson(fixture.server, { jsonrpc: '2.0', id: 2, method: 'slow' }, { token: fixture.issued.token });
  assert.equal(second.status, 429);
  assert.equal(second.body.error.code, MCP_ERROR_CODES.CONCURRENCY_LIMIT);
  release();
  const firstResponse = await first;
  assert.equal(firstResponse.status, 200);
});

test('status projection and restart drain loopback connections', async (t) => {
  const fixture = await startFixture();
  t.after(() => fixture.server.stop());
  const running = fixture.server.getStatus();
  assert.equal(running.state, 'running');
  assert.equal(running.host, '127.0.0.1');
  assert.ok(running.port > 0);
  assert.ok(running.uptimeMs >= 0);
  assert.equal(typeof running.activeConnections, 'number');

  const socket = net.connect(running.port, running.host);
  await new Promise((resolve, reject) => {
    socket.once('connect', resolve);
    socket.once('error', reject);
  });
  const stopped = await fixture.server.stop({ timeoutMs: 200 });
  assert.equal(stopped.state, 'stopped');
  assert.equal(stopped.port, null);
  assert.equal(fixture.server.getStatus().activeConnections, 0);
  socket.destroy();

  const restarted = await fixture.server.start();
  assert.equal(restarted.state, 'running');
  assert.ok(restarted.port > 0);
});

test('contract module exposes protocol, envelope, and audit validators', async () => {
  const contracts = await import('../shared/contracts/mcp.ts');
  assert.equal(contracts.MCP_SCHEMA_VERSION, 1);
  assert.equal(contracts.isMcpProtocolVersion('2025-03-26'), true);
  assert.equal(contracts.isMcpProtocolVersion('2099-01-01'), false);
  const envelope = contracts.createMcpResponseEnvelope('id', 'request', { ok: true }, 'p', 4);
  assert.deepEqual(envelope.projectId, 'p');
  assert.deepEqual(envelope.projectRevision, 4);
  assert.equal(contracts.validateMcpAuditRecord({
    timestamp: new Date().toISOString(),
    peer: '127.0.0.1',
    route: '/mcp',
    tool: 'initialize',
    outcome: 'success',
    tokenIdHash: 'abc',
    requestIdHash: 'abc',
  }).ok, true);
});
