'use strict';

/**
 * MCP-01 loopback transport for the Electron Main process.
 *
 * This module deliberately owns only the transport boundary. Tool catalogues
 * are injected as handlers by later work items, keeping the trust boundary,
 * token lifecycle, limits, and audit projection testable without a Renderer.
 */

const http = require('node:http');
const crypto = require('node:crypto');
const { URL } = require('node:url');
const defaultVault = require('../storage/vault.js');

const DEFAULT_HOST = '127.0.0.1';
const DEFAULT_PORT = 19789;
const DEFAULT_MAX_REQUEST_BYTES = 1024 * 1024;
const DEFAULT_REQUEST_TIMEOUT_MS = 10_000;
const DEFAULT_MAX_CONCURRENCY = 16;
const DEFAULT_DRAIN_TIMEOUT_MS = 5_000;
const DEFAULT_AUDIT_RETENTION = 1_000;
const TOKEN_REGISTRY_KEY = 'mcp:token-registry';
const TOKEN_REF_PREFIX = 'mcp:token:';
const SERVER_NAME = 'vaniscript-electron-mcp';
const SERVER_VERSION = '1.0.0';
const SUPPORTED_PROTOCOL_VERSIONS = Object.freeze(['2024-11-05', '2025-03-26']);
const DEFAULT_PROTOCOL_VERSION = SUPPORTED_PROTOCOL_VERSIONS[SUPPORTED_PROTOCOL_VERSIONS.length - 1];

const MCP_ERROR_CODES = Object.freeze({
  BIND_REJECTED: 'MCP_BIND_REJECTED',
  SERVER_NOT_RUNNING: 'MCP_SERVER_NOT_RUNNING',
  SERVER_DRAINING: 'MCP_SERVER_DRAINING',
  UNAUTHORIZED: 'MCP_UNAUTHORIZED',
  TOKEN_EXPIRED: 'MCP_TOKEN_EXPIRED',
  TOKEN_REVOKED: 'MCP_TOKEN_REVOKED',
  TOKEN_UNAVAILABLE: 'MCP_TOKEN_UNAVAILABLE',
  UNSUPPORTED_VERSION: 'MCP_UNSUPPORTED_VERSION',
  INVALID_REQUEST: 'MCP_INVALID_REQUEST',
  REQUEST_TOO_LARGE: 'MCP_REQUEST_TOO_LARGE',
  REQUEST_TIMEOUT: 'MCP_REQUEST_TIMEOUT',
  CONCURRENCY_LIMIT: 'MCP_CONCURRENCY_LIMIT',
  METHOD_NOT_FOUND: 'MCP_METHOD_NOT_FOUND',
  INTERNAL: 'MCP_INTERNAL',
});

const APP_ERROR_CODES = Object.freeze({
  [MCP_ERROR_CODES.BIND_REJECTED]: 'VALIDATION_FAILED',
  [MCP_ERROR_CODES.SERVER_NOT_RUNNING]: 'CONFLICT',
  [MCP_ERROR_CODES.SERVER_DRAINING]: 'CANCELLED',
  [MCP_ERROR_CODES.UNAUTHORIZED]: 'PERMISSION_DENIED',
  [MCP_ERROR_CODES.TOKEN_EXPIRED]: 'PERMISSION_DENIED',
  [MCP_ERROR_CODES.TOKEN_REVOKED]: 'PERMISSION_DENIED',
  [MCP_ERROR_CODES.TOKEN_UNAVAILABLE]: 'PERMISSION_DENIED',
  [MCP_ERROR_CODES.UNSUPPORTED_VERSION]: 'CAPABILITY_UNAVAILABLE',
  [MCP_ERROR_CODES.INVALID_REQUEST]: 'VALIDATION_FAILED',
  [MCP_ERROR_CODES.REQUEST_TOO_LARGE]: 'VALIDATION_FAILED',
  [MCP_ERROR_CODES.REQUEST_TIMEOUT]: 'CANCELLED',
  [MCP_ERROR_CODES.CONCURRENCY_LIMIT]: 'CONFLICT',
  [MCP_ERROR_CODES.METHOD_NOT_FOUND]: 'CAPABILITY_UNAVAILABLE',
  [MCP_ERROR_CODES.INTERNAL]: 'INTERNAL',
});

const HTTP_STATUS = Object.freeze({
  [MCP_ERROR_CODES.BIND_REJECTED]: 400,
  [MCP_ERROR_CODES.SERVER_NOT_RUNNING]: 503,
  [MCP_ERROR_CODES.SERVER_DRAINING]: 503,
  [MCP_ERROR_CODES.UNAUTHORIZED]: 401,
  [MCP_ERROR_CODES.TOKEN_EXPIRED]: 401,
  [MCP_ERROR_CODES.TOKEN_REVOKED]: 401,
  [MCP_ERROR_CODES.TOKEN_UNAVAILABLE]: 503,
  [MCP_ERROR_CODES.UNSUPPORTED_VERSION]: 400,
  [MCP_ERROR_CODES.INVALID_REQUEST]: 400,
  [MCP_ERROR_CODES.REQUEST_TOO_LARGE]: 413,
  [MCP_ERROR_CODES.REQUEST_TIMEOUT]: 408,
  [MCP_ERROR_CODES.CONCURRENCY_LIMIT]: 429,
  [MCP_ERROR_CODES.METHOD_NOT_FOUND]: 404,
  [MCP_ERROR_CODES.INTERNAL]: 500,
});

class McpServerError extends Error {
  constructor(code, message, details) {
    super(message);
    this.name = 'McpServerError';
    this.code = code;
    this.status = HTTP_STATUS[code] || 500;
    this.appCode = APP_ERROR_CODES[code] || 'INTERNAL';
    if (details !== undefined) this.details = details;
    Object.setPrototypeOf(this, McpServerError.prototype);
  }

  toJSON() {
    const output = {
      code: this.code,
      message: this.message,
      status: this.status,
      appCode: this.appCode,
    };
    if (this.details !== undefined) output.details = this.details;
    return output;
  }
}

function mcpError(code, message, details) {
  return new McpServerError(code, message, details);
}

function validateLoopbackHost(host) {
  const candidate = host === undefined ? DEFAULT_HOST : host;
  if (candidate !== '127.0.0.1' && candidate !== '::1') {
    throw mcpError(
      MCP_ERROR_CODES.BIND_REJECTED,
      'MCP server may bind only to 127.0.0.1 or ::1.',
    );
  }
  return candidate;
}

function validatePort(port) {
  if (!Number.isInteger(port) || port < 0 || port > 65_535) {
    throw mcpError(MCP_ERROR_CODES.INVALID_REQUEST, 'MCP port must be an integer from 0 to 65535.');
  }
  return port;
}

function positiveInteger(value, fallback, field) {
  const candidate = value === undefined ? fallback : value;
  if (!Number.isInteger(candidate) || candidate <= 0) {
    throw mcpError(MCP_ERROR_CODES.INVALID_REQUEST, `${field} must be a positive integer.`);
  }
  return candidate;
}

function boundedInteger(value, fallback, field, minimum) {
  const candidate = value === undefined ? fallback : value;
  if (!Number.isInteger(candidate) || candidate < minimum) {
    throw mcpError(MCP_ERROR_CODES.INVALID_REQUEST, `${field} must be an integer of at least ${minimum}.`);
  }
  return candidate;
}

function sha256(value) {
  return crypto.createHash('sha256').update(String(value), 'utf8').digest('hex');
}

/**
 * Compare bearer values without a length-dependent early return. Hashing both
 * sides first gives timingSafeEqual fixed-size buffers even for malformed input.
 */
function timingSafeTokenEqual(candidate, expected) {
  if (typeof candidate !== 'string' || typeof expected !== 'string') return false;
  const candidateHash = crypto.createHash('sha256').update(candidate, 'utf8').digest();
  const expectedHash = crypto.createHash('sha256').update(expected, 'utf8').digest();
  return crypto.timingSafeEqual(candidateHash, expectedHash);
}

function safeRequestId(value) {
  if (typeof value !== 'string' || value.length === 0) return crypto.randomUUID();
  const normalized = value.replace(/[\u0000-\u001f\u007f]/g, '').slice(0, 128);
  return normalized || crypto.randomUUID();
}

function safeMethod(value) {
  if (typeof value !== 'string' || value.length === 0) return null;
  return value.replace(/[\u0000-\u001f\u007f]/g, '').slice(0, 128) || null;
}

function safeProjectId(value) {
  return typeof value === 'string' && value.length > 0 ? value : null;
}

function safeProjectRevision(value) {
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  if (typeof value === 'string' && value.length > 0) return value;
  return null;
}

function isLoopbackOrigin(origin) {
  if (typeof origin !== 'string' || origin.length === 0) return true;
  try {
    const parsed = new URL(origin);
    const host = parsed.hostname.replace(/^\[|\]$/g, '').toLowerCase();
    return host === '127.0.0.1' || host === '::1' || host === 'localhost';
  } catch {
    return false;
  }
}

function requestPath(req) {
  try {
    return new URL(req.url || '/', 'http://127.0.0.1').pathname || '/';
  } catch {
    return '/';
  }
}

function requestPeer(req) {
  const socket = req.socket;
  if (!socket || typeof socket.remoteAddress !== 'string') return 'unknown';
  return socket.remoteAddress;
}

function publicTokenRecord(record) {
  return {
    tokenId: record.tokenId,
    tokenRef: record.tokenRef,
    createdAt: record.createdAt,
    expiresAt: record.expiresAt,
    revokedAt: record.revokedAt,
  };
}

function cloneRecord(record) {
  return {
    tokenId: record.tokenId,
    tokenRef: record.tokenRef,
    createdAt: record.createdAt,
    expiresAt: record.expiresAt,
    revokedAt: record.revokedAt,
  };
}

function tokenExpiry(options) {
  if (options.expiresAt !== undefined && options.expiresAt !== null) {
    const value = options.expiresAt instanceof Date
      ? options.expiresAt.getTime()
      : typeof options.expiresAt === 'number'
        ? options.expiresAt
        : Date.parse(String(options.expiresAt));
    if (!Number.isFinite(value)) {
      throw mcpError(MCP_ERROR_CODES.INVALID_REQUEST, 'Token expiresAt must be a valid timestamp.');
    }
    return new Date(value).toISOString();
  }
  if (options.ttlMs === undefined || options.ttlMs === null) return null;
  if (!Number.isFinite(options.ttlMs) || options.ttlMs <= 0) {
    throw mcpError(MCP_ERROR_CODES.INVALID_REQUEST, 'Token ttlMs must be a positive number.');
  }
  return new Date(Date.now() + options.ttlMs).toISOString();
}

function tokenIsExpired(record, now = Date.now()) {
  return Boolean(record.expiresAt && Date.parse(record.expiresAt) <= now);
}

function parseRegistry(raw) {
  if (typeof raw !== 'string' || raw.length === 0) return [];
  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return [];
  }
  if (!parsed || !Array.isArray(parsed.tokens)) return [];
  return parsed.tokens.filter((record) => (
    record &&
    typeof record.tokenId === 'string' &&
    typeof record.tokenRef === 'string' &&
    typeof record.createdAt === 'string' &&
    (record.expiresAt === null || typeof record.expiresAt === 'string') &&
    (record.revokedAt === null || typeof record.revokedAt === 'string')
  )).map(cloneRecord);
}

function requestBody(req, maxBytes) {
  return new Promise((resolve, reject) => {
    let settled = false;
    let size = 0;
    const chunks = [];
    const settleReject = (error) => {
      if (settled) return;
      settled = true;
      reject(error);
    };
    const settleResolve = (value) => {
      if (settled) return;
      settled = true;
      resolve(value);
    };

    const contentLength = req.headers['content-length'];
    if (contentLength !== undefined) {
      const declared = Number(contentLength);
      if (!Number.isFinite(declared) || declared < 0) {
        req.resume();
        settleReject(mcpError(MCP_ERROR_CODES.INVALID_REQUEST, 'Content-Length is invalid.'));
        return;
      }
      if (declared > maxBytes) {
        req.resume();
        settleReject(mcpError(MCP_ERROR_CODES.REQUEST_TOO_LARGE, 'MCP request exceeds the configured size limit.'));
        return;
      }
    }

    req.on('data', (chunk) => {
      if (settled) return;
      size += chunk.length;
      if (size > maxBytes) {
        req.resume();
        settleReject(mcpError(MCP_ERROR_CODES.REQUEST_TOO_LARGE, 'MCP request exceeds the configured size limit.'));
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => settleResolve(Buffer.concat(chunks).toString('utf8')));
    req.on('aborted', () => settleReject(mcpError(MCP_ERROR_CODES.REQUEST_TIMEOUT, 'MCP request was aborted.')));
    req.on('error', () => settleReject(mcpError(MCP_ERROR_CODES.INTERNAL, 'MCP request stream failed.')));
  });
}

class McpServer {
  constructor(options = {}) {
    if (!options || typeof options !== 'object') {
      throw mcpError(MCP_ERROR_CODES.INVALID_REQUEST, 'MCP server options must be an object.');
    }
    this.host = validateLoopbackHost(options.host);
    this.port = validatePort(options.port === undefined ? DEFAULT_PORT : options.port);
    this.maxRequestBytes = positiveInteger(options.maxRequestBytes, DEFAULT_MAX_REQUEST_BYTES, 'maxRequestBytes');
    this.requestTimeoutMs = positiveInteger(options.requestTimeoutMs, DEFAULT_REQUEST_TIMEOUT_MS, 'requestTimeoutMs');
    this.maxConcurrency = positiveInteger(options.maxConcurrency, DEFAULT_MAX_CONCURRENCY, 'maxConcurrency');
    this.drainTimeoutMs = positiveInteger(options.drainTimeoutMs, DEFAULT_DRAIN_TIMEOUT_MS, 'drainTimeoutMs');
    this.auditRetention = boundedInteger(options.auditRetention, DEFAULT_AUDIT_RETENTION, 'auditRetention', 1);
    this.protocolVersions = Object.freeze(
      (Array.isArray(options.protocolVersions) && options.protocolVersions.length > 0
        ? options.protocolVersions
        : SUPPORTED_PROTOCOL_VERSIONS).filter((value) => typeof value === 'string'),
    );
    if (this.protocolVersions.length === 0) {
      throw mcpError(MCP_ERROR_CODES.INVALID_REQUEST, 'At least one MCP protocol version is required.');
    }

    this.vault = options.vault || defaultVault;
    this.vaultOptions = options.vaultOptions || (
      typeof options.vaultPath === 'string' && options.vaultPath.length > 0
        ? { vaultPath: options.vaultPath }
        : undefined
    );
    this.registryKey = typeof options.registryKey === 'string' && options.registryKey.length > 0
      ? options.registryKey
      : TOKEN_REGISTRY_KEY;
    this.handlers = options.handlers && typeof options.handlers === 'object' ? options.handlers : {};
    this.requestHandler = typeof options.requestHandler === 'function'
      ? options.requestHandler
      : typeof options.handleRequest === 'function'
        ? options.handleRequest
        : null;
    this.capabilities = options.capabilities && typeof options.capabilities === 'object'
      ? options.capabilities
      : { tools: { listChanged: false } };
    this.serverName = typeof options.serverName === 'string' && options.serverName.length > 0
      ? options.serverName
      : SERVER_NAME;
    this.serverVersion = typeof options.serverVersion === 'string' && options.serverVersion.length > 0
      ? options.serverVersion
      : SERVER_VERSION;

    this.state = 'stopped';
    this.server = null;
    this.boundPort = null;
    this.startedAt = null;
    this.lastError = null;
    this.activeRequests = 0;
    this.sockets = new Set();
    this.auditRecords = [];
    this.tokenRecords = new Map();
    this.startPromise = null;
    this.stopPromise = null;
    this._loadTokenRegistry();
    if (typeof options.tokenRef === 'string' && options.tokenRef.length > 0) {
      const tokenId = typeof options.tokenId === 'string' && options.tokenId.length > 0
        ? options.tokenId
        : options.tokenRef.slice(TOKEN_REF_PREFIX.length) || crypto.randomUUID();
      if (!this.tokenRecords.has(tokenId)) {
        this.tokenRecords.set(tokenId, {
          tokenId,
          tokenRef: options.tokenRef,
          createdAt: new Date().toISOString(),
          expiresAt: options.tokenExpiresAt ? new Date(options.tokenExpiresAt).toISOString() : null,
          revokedAt: null,
        });
      }
    }
  }

  _vaultArgs() {
    return this.vaultOptions;
  }

  _loadTokenRegistry() {
    try {
      const raw = this.vault.getSecret(this.registryKey, this._vaultArgs());
      for (const record of parseRegistry(raw)) this.tokenRecords.set(record.tokenId, record);
    } catch {
      // A locked/missing vault fails closed during authentication. Construction
      // remains side-effect free so status can still expose the stopped state.
    }
  }

  _persistTokenRegistry() {
    const tokens = Array.from(this.tokenRecords.values()).map(cloneRecord);
    this.vault.storeSecret(
      this.registryKey,
      JSON.stringify({ version: 1, tokens }),
      this._vaultArgs(),
    );
  }

  _activeTokenRecord() {
    const now = Date.now();
    return Array.from(this.tokenRecords.values()).find((record) => (
      !record.revokedAt && !tokenIsExpired(record, now)
    )) || null;
  }

  _issueToken(options = {}, revokeExisting) {
    if (!options || typeof options !== 'object') {
      throw mcpError(MCP_ERROR_CODES.INVALID_REQUEST, 'Token options must be an object.');
    }
    const token = crypto.randomBytes(32).toString('hex');
    const tokenId = crypto.randomUUID();
    const tokenRef = `${TOKEN_REF_PREFIX}${tokenId}`;
    const record = {
      tokenId,
      tokenRef,
      createdAt: new Date().toISOString(),
      expiresAt: tokenExpiry(options),
      revokedAt: null,
    };
    const previous = this.tokenRecords;
    const next = new Map();
    for (const prior of previous.values()) {
      next.set(prior.tokenId, revokeExisting && !prior.revokedAt
        ? { ...prior, revokedAt: new Date().toISOString() }
        : cloneRecord(prior));
    }
    next.set(tokenId, record);

    try {
      this.vault.storeSecret(tokenRef, token, this._vaultArgs());
      this.tokenRecords = next;
      this._persistTokenRegistry();
    } catch (error) {
      try { this.vault.deleteSecret(tokenRef, this._vaultArgs()); } catch { /* best effort rollback */ }
      this.tokenRecords = previous;
      if (error instanceof McpServerError) throw error;
      throw mcpError(MCP_ERROR_CODES.TOKEN_UNAVAILABLE, 'MCP credential vault is unavailable.');
    }

    return { ...publicTokenRecord(record), token };
  }

  /** Issue an additional token without revoking existing credentials. */
  issueToken(options = {}) {
    return this._issueToken(options, false);
  }

  /** Rotate credentials atomically from the server's point of view. */
  rotateToken(options = {}) {
    return this._issueToken(options, true);
  }

  createToken(options = {}) {
    return this.issueToken(options);
  }

  revokeToken(tokenIdOrRef) {
    const matches = Array.from(this.tokenRecords.values()).filter((record) => (
      tokenIdOrRef === undefined ||
      tokenIdOrRef === record.tokenId ||
      tokenIdOrRef === record.tokenRef
    ));
    if (matches.length === 0) return false;
    const previous = this.tokenRecords;
    const revokedAt = new Date().toISOString();
    const next = new Map(previous);
    for (const record of matches) {
      next.set(record.tokenId, { ...record, revokedAt: record.revokedAt || revokedAt });
    }
    try {
      this.tokenRecords = next;
      this._persistTokenRegistry();
    } catch (error) {
      this.tokenRecords = previous;
      if (error instanceof McpServerError) throw error;
      throw mcpError(MCP_ERROR_CODES.TOKEN_UNAVAILABLE, 'MCP credential vault is unavailable.');
    }
    return true;
  }

  revoke(tokenIdOrRef) {
    return this.revokeToken(tokenIdOrRef);
  }

  listTokens() {
    return Array.from(this.tokenRecords.values()).map(publicTokenRecord);
  }

  _parseBearer(req) {
    const authorization = req.headers.authorization;
    if (typeof authorization !== 'string') return null;
    const match = /^Bearer[ \t]+([^ \t]+)$/i.exec(authorization.trim());
    return match ? match[1] : null;
  }

  authenticateToken(token) {
    if (typeof token !== 'string' || token.length === 0) {
      throw mcpError(MCP_ERROR_CODES.UNAUTHORIZED, 'MCP bearer authentication failed.');
    }
    let matched = null;
    let vaultFailure = false;
    // Deliberately inspect every record so matching does not introduce a
    // record-count-dependent early return.
    for (const record of this.tokenRecords.values()) {
      let expected = null;
      try {
        expected = this.vault.getSecret(record.tokenRef, this._vaultArgs());
      } catch {
        vaultFailure = true;
      }
      if (typeof expected === 'string' && timingSafeTokenEqual(token, expected)) {
        matched = record;
      }
    }
    if (!matched) {
      if (vaultFailure && this.tokenRecords.size > 0) {
        throw mcpError(MCP_ERROR_CODES.TOKEN_UNAVAILABLE, 'MCP credential vault is unavailable.');
      }
      throw mcpError(MCP_ERROR_CODES.UNAUTHORIZED, 'MCP bearer authentication failed.');
    }
    if (matched.revokedAt) {
      throw mcpError(MCP_ERROR_CODES.TOKEN_REVOKED, 'MCP bearer token has been revoked.');
    }
    if (tokenIsExpired(matched)) {
      throw mcpError(MCP_ERROR_CODES.TOKEN_EXPIRED, 'MCP bearer token has expired.');
    }
    return matched;
  }

  authenticateRequest(req) {
    return this.authenticateToken(this._parseBearer(req));
  }

  negotiateProtocolVersion(requested) {
    const candidate = requested === undefined || requested === null
      ? DEFAULT_PROTOCOL_VERSION
      : requested;
    if (typeof candidate !== 'string' || !this.protocolVersions.includes(candidate)) {
      throw mcpError(MCP_ERROR_CODES.UNSUPPORTED_VERSION, 'Requested MCP protocol version is unsupported.');
    }
    return candidate;
  }

  _status() {
    const address = this.server && this.server.address && this.server.address();
    const actualPort = address && typeof address === 'object' ? address.port : this.boundPort;
    return {
      schemaVersion: 1,
      state: this.state,
      host: this.host,
      port: actualPort === null || actualPort === undefined ? null : actualPort,
      uptimeMs: this.startedAt === null ? 0 : Math.max(0, Date.now() - this.startedAt),
      activeConnections: this.sockets.size,
      activeRequests: this.activeRequests,
      startedAt: this.startedAt === null ? null : new Date(this.startedAt).toISOString(),
      supportedProtocolVersions: Array.from(this.protocolVersions),
      tokenRef: this._activeTokenRecord()?.tokenRef || null,
      tokenId: this._activeTokenRecord()?.tokenId || null,
      tokenExpiresAt: this._activeTokenRecord()?.expiresAt || null,
    };
  }

  getStatus() {
    return this._status();
  }

  status() {
    return this.getStatus();
  }

  getAuditLog(query = {}) {
    const options = query && typeof query === 'object' ? query : {};
    let records = this.auditRecords;
    if (typeof options.outcome === 'string') {
      records = records.filter((record) => record.outcome === options.outcome);
    }
    if (typeof options.since === 'string') {
      const since = Date.parse(options.since);
      if (Number.isFinite(since)) records = records.filter((record) => Date.parse(record.timestamp) >= since);
    }
    const limit = Number.isInteger(options.limit) && options.limit > 0 ? options.limit : records.length;
    return records.slice(Math.max(0, records.length - limit)).map((record) => ({ ...record }));
  }

  getAuditRecords(query = {}) {
    return this.getAuditLog(query);
  }

  _recordAudit(ctx, outcome) {
    if (ctx.auditRecorded) return;
    ctx.auditRecorded = true;
    const record = {
      timestamp: new Date().toISOString(),
      peer: ctx.peer,
      route: ctx.route,
      tool: ctx.tool,
      outcome,
      tokenIdHash: ctx.tokenRecord ? sha256(ctx.tokenRecord.tokenId) : null,
      requestIdHash: ctx.requestId ? sha256(ctx.requestId) : null,
    };
    this.auditRecords.push(record);
    if (this.auditRecords.length > this.auditRetention) {
      this.auditRecords.splice(0, this.auditRecords.length - this.auditRetention);
    }
  }

  _setCors(req, res) {
    const origin = typeof req.headers.origin === 'string' ? req.headers.origin.trim() : '';
    if (origin && isLoopbackOrigin(origin)) res.setHeader('Access-Control-Allow-Origin', origin);
    res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization, X-Request-Id');
    res.setHeader('Vary', 'Origin');
  }

  _send(res, status, payload) {
    if (res.writableEnded) return;
    const text = JSON.stringify(payload);
    res.statusCode = status;
    res.setHeader('Content-Type', 'application/json; charset=utf-8');
    res.setHeader('Content-Length', Buffer.byteLength(text));
    if (this.state === 'draining') res.setHeader('Connection', 'close');
    res.end(text);
  }

  _envelope(ctx, id, result, error) {
    const envelope = {
      jsonrpc: '2.0',
      id: id === undefined ? null : id,
      requestId: ctx.requestId,
      projectId: ctx.projectId,
      projectRevision: ctx.projectRevision,
    };
    if (error) envelope.error = error.toJSON ? error.toJSON() : error;
    else envelope.result = result;
    return envelope;
  }

  _sendError(ctx, error, id) {
    if (ctx.responseSent || ctx.res.writableEnded) return;
    ctx.outcome = error.status === 401 || error.status === 403 ? 'denied' : (
      error.code === MCP_ERROR_CODES.REQUEST_TIMEOUT ? 'timeout' : 'rejected'
    );
    ctx.responseSent = true;
    this._send(ctx.res, error.status || 500, this._envelope(ctx, id, undefined, error));
  }

  _sendResult(ctx, id, result, status = 200) {
    if (ctx.responseSent || ctx.res.writableEnded) return;
    ctx.outcome = 'success';
    ctx.responseSent = true;
    this._send(ctx.res, status, this._envelope(ctx, id, result));
  }

  async _dispatch(payload, ctx) {
    if (!payload || typeof payload !== 'object' || Array.isArray(payload)) {
      throw mcpError(MCP_ERROR_CODES.INVALID_REQUEST, 'MCP request must be a JSON object.');
    }
    const method = safeMethod(payload.method);
    if (!method) throw mcpError(MCP_ERROR_CODES.INVALID_REQUEST, 'MCP request method is required.');
    ctx.tool = method;
    const params = payload.params && typeof payload.params === 'object' && !Array.isArray(payload.params)
      ? payload.params
      : {};
    ctx.projectId = safeProjectId(payload.projectId ?? params.projectId);
    ctx.projectRevision = safeProjectRevision(payload.projectRevision ?? params.projectRevision);
    const id = payload.id;

    if (method === 'initialize') {
      const version = this.negotiateProtocolVersion(payload.protocolVersion ?? params.protocolVersion);
      return {
        id,
        result: {
          protocolVersion: version,
          capabilities: this.capabilities,
          serverInfo: { name: this.serverName, version: this.serverVersion },
        },
      };
    }
    if (method === 'notifications/initialized') {
      return { id, result: null, status: 202 };
    }

    let handler = this.handlers[method];
    if (typeof handler !== 'function') handler = this.requestHandler;
    if (typeof handler !== 'function') {
      throw mcpError(MCP_ERROR_CODES.METHOD_NOT_FOUND, 'MCP method is not available.');
    }
    const handlerContext = {
      requestId: ctx.requestId,
      projectId: ctx.projectId,
      projectRevision: ctx.projectRevision,
      tokenId: ctx.tokenRecord ? ctx.tokenRecord.tokenId : null,
      route: ctx.route,
      peer: ctx.peer,
    };
    const result = this.handlers[method] === handler
      ? await handler(params, handlerContext)
      : await handler({ method, params, id }, handlerContext);
    return { id, result };
  }

  _handleRequest(req, res) {
    const ctx = {
      req,
      res,
      route: requestPath(req),
      peer: requestPeer(req),
      requestId: safeRequestId(req.headers['x-request-id']),
      tool: null,
      tokenRecord: null,
      projectId: null,
      projectRevision: null,
      responseSent: false,
      timedOut: false,
      auditRecorded: false,
      outcome: 'error',
      timeout: null,
      finalized: false,
    };
    this._setCors(req, res);

    if (req.method === 'OPTIONS') {
      res.statusCode = 204;
      res.end();
      return;
    }
    if (!isLoopbackOrigin(req.headers.origin)) {
      const error = mcpError(MCP_ERROR_CODES.UNAUTHORIZED, 'MCP requests must originate from loopback.');
      this._recordAudit(ctx, 'denied');
      this._send(res, error.status, this._envelope(ctx, null, undefined, error));
      return;
    }
    if (this.state !== 'running') {
      const error = mcpError(
        this.state === 'draining' ? MCP_ERROR_CODES.SERVER_DRAINING : MCP_ERROR_CODES.SERVER_NOT_RUNNING,
        'MCP server is not accepting requests.',
      );
      this._recordAudit(ctx, 'rejected');
      this._send(res, error.status, this._envelope(ctx, null, undefined, error));
      return;
    }
    if (this.activeRequests >= this.maxConcurrency) {
      const error = mcpError(MCP_ERROR_CODES.CONCURRENCY_LIMIT, 'MCP concurrency limit reached.');
      this._recordAudit(ctx, 'rejected');
      req.resume();
      this._send(res, error.status, this._envelope(ctx, null, undefined, error));
      return;
    }

    this.activeRequests += 1;
    const finalize = () => {
      if (ctx.finalized) return;
      ctx.finalized = true;
      if (ctx.timeout) clearTimeout(ctx.timeout);
      this.activeRequests = Math.max(0, this.activeRequests - 1);
      this._recordAudit(ctx, ctx.outcome);
      this._maybeEndDrainingSockets();
    };
    res.once('finish', finalize);
    res.once('close', finalize);
    ctx.timeout = setTimeout(() => {
      if (ctx.finalized || ctx.responseSent) return;
      ctx.timedOut = true;
      const error = mcpError(MCP_ERROR_CODES.REQUEST_TIMEOUT, 'MCP request timed out.');
      this._sendError(ctx, error, null);
      req.resume();
      req.destroy();
    }, this.requestTimeoutMs);

    (async () => {
      let id = null;
      try {
        ctx.tokenRecord = this.authenticateRequest(req);
        const body = await requestBody(req, this.maxRequestBytes);
        if (ctx.timedOut || ctx.responseSent) return;
        if (ctx.route === '/status' && req.method === 'GET') {
          this._sendResult(ctx, null, this._status());
          return;
        }
        if (!['/mcp', '/message', '/rpc', '/'].includes(ctx.route)) {
          throw mcpError(MCP_ERROR_CODES.INVALID_REQUEST, 'MCP route is not available.');
        }
        if (req.method !== 'POST') {
          throw mcpError(MCP_ERROR_CODES.INVALID_REQUEST, 'MCP endpoint requires POST.');
        }
        let payload;
        try {
          payload = JSON.parse(body);
        } catch {
          throw mcpError(MCP_ERROR_CODES.INVALID_REQUEST, 'MCP request body must be valid JSON.');
        }
        if (payload && typeof payload.requestId === 'string') ctx.requestId = safeRequestId(payload.requestId);
        const dispatched = await this._dispatch(payload, ctx);
        id = dispatched.id;
        if (ctx.timedOut || ctx.responseSent) return;
        this._sendResult(ctx, dispatched.id, dispatched.result, dispatched.status || 200);
      } catch (error) {
        if (ctx.timedOut || ctx.responseSent) return;
        const normalized = error instanceof McpServerError
          ? error
          : mcpError(MCP_ERROR_CODES.INTERNAL, 'MCP request failed.');
        this._sendError(ctx, normalized, id);
      }
    })();
  }

  _maybeEndDrainingSockets() {
    if (this.state !== 'draining' || this.activeRequests !== 0) return;
    for (const socket of this.sockets) {
      try { socket.end(); } catch { /* already closed */ }
    }
  }

  async start() {
    if (this.state === 'running') return this.getStatus();
    if (this.startPromise) return this.startPromise;
    if (this.state === 'draining') {
      throw mcpError(MCP_ERROR_CODES.SERVER_DRAINING, 'MCP server is draining connections.');
    }
    this.startPromise = (async () => {
      this._activeTokenRecord() || this.rotateToken();
      this.state = 'starting';
      this.lastError = null;
      const server = http.createServer((req, res) => this._handleRequest(req, res));
      this.server = server;
      server.on('connection', (socket) => {
        this.sockets.add(socket);
        socket.once('close', () => {
          this.sockets.delete(socket);
        });
      });
      await new Promise((resolve, reject) => {
        const onError = (error) => {
          server.off('listening', onListening);
          reject(error);
        };
        const onListening = () => {
          server.off('error', onError);
          resolve();
        };
        server.once('error', onError);
        server.once('listening', onListening);
        try {
          server.listen(this.port, this.host);
        } catch (error) {
          onError(error);
        }
      }).catch((error) => {
        this.state = 'error';
        this.server = null;
        this.boundPort = null;
        if (error instanceof McpServerError) throw error;
        throw mcpError(MCP_ERROR_CODES.BIND_REJECTED, 'MCP server could not bind to the loopback address.');
      });
      this.boundPort = server.address().port;
      this.startedAt = Date.now();
      this.state = 'running';
      server.on('error', (error) => {
        this.lastError = error instanceof Error ? error.message : String(error);
        if (this.state === 'running') this.state = 'error';
      });
      return this.getStatus();
    })();
    try {
      return await this.startPromise;
    } finally {
      this.startPromise = null;
    }
  }

  async stop(options = {}) {
    if (this.stopPromise) return this.stopPromise;
    if (!this.server) {
      this.state = 'stopped';
      this.startedAt = null;
      this.boundPort = null;
      return this.getStatus();
    }
    const timeoutMs = positiveInteger(options.timeoutMs, this.drainTimeoutMs, 'timeoutMs');
    this.stopPromise = (async () => {
      this.state = 'draining';
      const server = this.server;
      let closeResolve;
      let closeReject;
      const closePromise = new Promise((resolve, reject) => {
        closeResolve = resolve;
        closeReject = reject;
      });
      try {
        server.close((error) => error ? closeReject(error) : closeResolve());
      } catch (error) {
        if (error && error.code !== 'ERR_SERVER_NOT_RUNNING') closeReject(error);
        else closeResolve();
      }
      for (const socket of this.sockets) {
        socket.setTimeout(timeoutMs, () => socket.destroy());
      }
      this._maybeEndDrainingSockets();
      let drainTimer;
      const drainTimeout = new Promise((resolve) => {
        drainTimer = setTimeout(resolve, timeoutMs);
      });
      try {
        await Promise.race([closePromise, drainTimeout]);
      } finally {
        clearTimeout(drainTimer);
      }
      for (const socket of this.sockets) {
        try { socket.destroy(); } catch { /* already closed */ }
      }
      // A destroyed socket may emit `close` on a later turn. Clear the
      // projection now so a completed stop never reports stale connections.
      this.sockets.clear();
      this.server = null;
      this.boundPort = null;
      this.startedAt = null;
      this.state = 'stopped';
      return this.getStatus();
    })().catch((error) => {
      this.state = 'error';
      if (error instanceof McpServerError) throw error;
      throw mcpError(MCP_ERROR_CODES.INTERNAL, 'MCP server could not stop cleanly.');
    });
    try {
      return await this.stopPromise;
    } finally {
      this.stopPromise = null;
    }
  }

  async restart(options = {}) {
    await this.stop(options);
    return this.start();
  }
}

function createMcpServer(options = {}) {
  return new McpServer(options);
}

async function startMcpServer(options = {}) {
  const server = createMcpServer(options);
  await server.start();
  return server;
}

module.exports = {
  McpServer,
  MCPServer: McpServer,
  McpServerError,
  MCP_ERROR_CODES,
  SUPPORTED_PROTOCOL_VERSIONS,
  DEFAULT_PROTOCOL_VERSION,
  createMcpServer,
  startMcpServer,
  timingSafeTokenEqual,
  validateLoopbackHost,
};
