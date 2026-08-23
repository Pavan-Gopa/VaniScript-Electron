'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const http = require('node:http');
const os = require('node:os');
const path = require('node:path');

const {
  AGENT_PROFILES,
  AgentClientError,
  createAgentClients,
} = require('../electron/main/agents/agentClients.js');

function makeTempDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'vs-agent-client-'));
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function waitFor(predicate, timeoutMs = 2_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) return;
    await sleep(5);
  }
  assert.equal(predicate(), true, 'condition did not become true before timeout');
}

/**
 * A tiny scripted HTTP server gives the client a real socket to close during
 * abort tests while keeping every provider response deterministic and local.
 */
async function createScriptServer(script) {
  const requests = [];
  let closedResponses = 0;
  const server = http.createServer((req, res) => {
    let body = '';
    req.setEncoding('utf8');
    req.on('data', (chunk) => { body += chunk; });
    res.on('close', () => { closedResponses += 1; });
    req.on('end', async () => {
      requests.push({ method: req.method, headers: req.headers, body });
      try {
        await script({
          req,
          res,
          write: (chunk) => res.write(chunk),
          end: () => res.end(),
          waitForClose: () => new Promise((resolve) => {
            if (res.destroyed || res.writableEnded) {
              resolve();
            } else {
              res.once('close', resolve);
            }
          }),
        });
      } catch {
        if (!res.writableEnded) res.destroy();
      }
    });
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  return {
    endpoint: `http://127.0.0.1:${server.address().port}/stream`,
    requests,
    get closedResponses() { return closedResponses; },
    close: () => new Promise((resolve) => server.close(() => resolve())),
  };
}

function providerChunk(profile, text) {
  if (profile === 'codex') {
    return `data: ${JSON.stringify({ type: 'response.output_text.delta', delta: text })}\n\n`;
  }
  return `data: ${JSON.stringify({ choices: [{ delta: { content: text } }] })}\n\n`;
}

function providerDone(profile) {
  if (profile === 'codex') {
    return 'event: response.completed\ndata: {"type":"response.completed","response":{"usage":{"input_tokens":3,"output_tokens":2}}}\n\n';
  }
  return 'data: {"choices":[{"delta":{},"finish_reason":"stop"}],"usage":{"prompt_tokens":3,"completion_tokens":2}}\n\ndata: [DONE]\n\n';
}

async function runStream(client, profile, request, hooks = {}) {
  const tokens = [];
  const errors = [];
  let done;
  const handle = client.start(profile, request);
  const settled = new Promise((resolve) => {
    handle.onToken((token) => {
      tokens.push(token);
      hooks.onToken?.(token);
    });
    handle.onError((error) => {
      errors.push(error);
      resolve({ tokens, errors, done: null });
    });
    handle.onDone((value) => {
      done = value;
      resolve({ tokens, errors, done });
    });
  });
  return { handle, result: settled };
}

function profileConfig(profile, endpoint) {
  return { endpoint, keyRef: `${profile}-ref`, model: `${profile}-test-model` };
}

test('listProfiles exposes Codex, Grok, and Qwen without credentials or paths', () => {
  const clients = createAgentClients({
    historyPath: path.join(makeTempDir(), 'history.json'),
    keyRefs: { codex: 'codex-ref', grok: 'grok-ref', qwen: 'qwen-ref' },
    vault: { getSecret: () => 'unused' },
  });
  assert.deepEqual(clients.listProfiles().map((profile) => profile.id), AGENT_PROFILES);
  assert.equal(clients.status().active.length, 0);
  assert.equal(JSON.stringify(clients.listProfiles()).includes('unused'), false);
  assert.equal(JSON.stringify(clients.status()).includes('history'), false);
});

test('each provider adapter streams ordered deltas, forwards selectors, and resolves keys from the vault', async (t) => {
  const secret = 'sk-live-agent-secret-123456789';
  const requestedRefs = [];
  for (const profile of AGENT_PROFILES) {
    const server = await createScriptServer(async ({ write, end }) => {
      write(providerChunk(profile, 'Hello '));
      write(providerChunk(profile, 'world'));
      write(providerDone(profile));
      end();
    });
    t.after(() => server.close());
    const tempDir = makeTempDir();
    const historyPath = path.join(tempDir, 'agent-history.json');
    const clients = createAgentClients({
      historyPath,
      profileConfigs: { [profile]: profileConfig(profile, server.endpoint) },
      vault: {
        getSecret(ref) {
          requestedRefs.push(ref);
          return secret;
        },
      },
    });
    const { result } = await runStream(clients, profile, {
      model: `${profile}-selected-model`,
      reasoning: 'high',
      input: 'Say hello',
      context: { projectId: `project-${profile}` },
    });
    const outcome = await result;
    assert.deepEqual(outcome.tokens, ['Hello ', 'world']);
    assert.equal(outcome.errors.length, 0);
    assert.equal(outcome.done.state, 'done');
    assert.equal(outcome.done.usage.completionTokens, 2);
    assert.equal(outcome.done.historyPersisted, true);
    assert.equal(requestedRefs.includes(`${profile}-ref`), true);

    const request = server.requests[0];
    assert.equal(request.method, 'POST');
    assert.equal(request.headers.authorization, `Bearer ${secret}`);
    assert.equal(request.headers.accept, 'text/event-stream');
    const body = JSON.parse(request.body);
    assert.equal(body.model, `${profile}-selected-model`);
    assert.equal(body.stream, true);
    if (profile === 'codex') {
      assert.deepEqual(body.reasoning, { effort: 'high' });
      assert.equal(body.input.at(-1).content, 'Say hello');
    } else {
      assert.equal(body.messages.at(-1).content, 'Say hello');
      if (profile === 'grok') assert.equal(body.reasoning_effort, 'high');
      if (profile === 'qwen') assert.equal(body.enable_thinking, true);
    }
    const persisted = JSON.parse(fs.readFileSync(historyPath, 'utf8'));
    assert.equal(JSON.stringify(persisted).includes(secret), false);
    assert.equal(JSON.stringify(outcome).includes(secret), false);
  }
});

test('malformed streaming payloads become typed provider errors for every adapter', async (t) => {
  for (const profile of AGENT_PROFILES) {
    const server = await createScriptServer(async ({ write, end }) => {
      write('data: {not valid json}\n\n');
      end();
    });
    t.after(() => server.close());
    const clients = createAgentClients({
      historyPath: path.join(makeTempDir(), 'history.json'),
      profileConfigs: { [profile]: profileConfig(profile, server.endpoint) },
      vault: { getSecret: () => 'secret-value' },
    });
    const { result } = await runStream(clients, profile, {
      input: 'parse this',
      context: { projectId: `malformed-${profile}` },
    });
    const outcome = await result;
    assert.equal(outcome.done, null);
    assert.equal(outcome.errors.length, 1);
    assert.ok(outcome.errors[0] instanceof AgentClientError);
    assert.equal(outcome.errors[0].code, 'PROVIDER_ERROR');
    assert.equal(outcome.errors[0].details.reason, 'invalid_json');
  }
});
test('mid-stream cancel aborts the socket and is idempotent without later tokens', async (t) => {
  for (const profile of AGENT_PROFILES) {
    let firstChunkSent = false;
    const server = await createScriptServer(async ({ write, waitForClose }) => {
      write(providerChunk(profile, 'first'));
      firstChunkSent = true;
      await waitForClose();
    });
    t.after(() => server.close());
    const clients = createAgentClients({
      historyPath: path.join(makeTempDir(), 'history.json'),
      profileConfigs: { [profile]: profileConfig(profile, server.endpoint) },
      vault: { getSecret: () => 'cancel-secret' },
    });
    let firstTokenSeen = false;
    const { handle, result } = await runStream(clients, profile, {
      input: 'cancel this',
      context: { projectId: `cancel-${profile}` },
    }, {
      onToken: () => { firstTokenSeen = true; },
    });
    await waitFor(() => firstChunkSent && firstTokenSeen);
    const firstCancel = handle.cancel();
    const secondCancel = handle.cancel();
    assert.strictEqual(firstCancel, secondCancel);
    const outcome = await result;
    assert.deepEqual(outcome.tokens, ['first']);
    assert.equal(outcome.done, null);
    assert.equal(outcome.errors.length, 1);
    assert.equal(outcome.errors[0].code, 'CANCELLED');
    await waitFor(() => server.closedResponses > 0);
    assert.equal(clients.getHistory(profile, `cancel-${profile}`).length, 0);
  }
});

test('history is bounded per profile/project and redacts secrets, manuscript fields, and paths', async (t) => {
  const secret = 'xai-live-history-secret-123456789';
  const server = await createScriptServer(async ({ write, end }) => {
    write(providerChunk('grok', secret));
    write(providerDone('grok'));
    end();
  });
  t.after(() => server.close());
  const tempDir = makeTempDir();
  const historyPath = path.join(tempDir, 'agent-history.json');
  const projectJsonPath = path.join(tempDir, 'project.json');
  fs.writeFileSync(projectJsonPath, '{"revision":7,"manuscript":"untouched"}');
  const clients = createAgentClients({
    historyPath,
    historyLimit: 2,
    profileConfigs: { grok: profileConfig('grok', server.endpoint) },
    vault: { getSecret: () => secret },
  });
  for (let i = 0; i < 3; i += 1) {
    const { result } = await runStream(clients, 'grok', {
      input: `turn-${i}`,
      context: {
        projectId: 'bounded-project',
        manuscript: 'PRIVATE MANUSCRIPT TEXT',
        sourcePath: '/Users/pavan/private/manuscript.docx',
      },
    });
    const outcome = await result;
    assert.equal(outcome.done.state, 'done');
  }
  const history = clients.getHistory('grok', 'bounded-project');
  assert.equal(history.length, 2);
  assert.equal(history[0].input, 'turn-1');
  assert.equal(history[1].input, 'turn-2');
  const persistedText = fs.readFileSync(historyPath, 'utf8');
  assert.equal(persistedText.includes(secret), false);
  assert.equal(persistedText.includes('PRIVATE MANUSCRIPT TEXT'), false);
  assert.equal(persistedText.includes('/Users/pavan/private/manuscript.docx'), false);
  assert.equal(persistedText.includes('[REDACTED]'), true);
  assert.equal(fs.readFileSync(projectJsonPath, 'utf8'), '{"revision":7,"manuscript":"untouched"}');
});

test('outbound redaction keeps token-shaped words, strips paths visibly, and substitutes only exact vault secrets', async (t) => {
  const secret = 'sk-live-agent-secret-123456789';
  const server = await createScriptServer(async ({ write, end }) => {
    write(providerChunk('grok', 'token_budget_exceeded_warning stays'));
    write(providerChunk('grok', secret));
    write(providerDone('grok'));
    end();
  });
  t.after(() => server.close());
  const clients = createAgentClients({
    historyPath: path.join(makeTempDir(), 'history.json'),
    profileConfigs: { grok: profileConfig('grok', server.endpoint) },
    vault: { getSecret: () => secret },
  });
  const handle = clients.start('grok', {
    input: 'token_budget_exceeded_warning see /Users/x/novel.docx',
    context: { projectId: 'redact-contract' },
  });
  const live = clients.status().active[0];
  assert.ok(live);
  assert.ok(live.redactions.some((entry) => entry.kind === 'path' && entry.count >= 1));
  const tokens = [];
  const errors = [];
  const outcome = await new Promise((resolve) => {
    handle.onToken((token) => tokens.push(token));
    handle.onError((error) => resolve({ tokens, errors: [...errors, error], done: null }));
    handle.onDone((done) => resolve({ tokens, errors, done }));
  });

  assert.equal(server.requests.length, 1);
  const body = JSON.parse(server.requests[0].body);
  assert.equal(body.messages.at(-1).content.includes('token_budget_exceeded_warning'), true);
  assert.equal(body.messages.at(-1).content.includes('/Users/x/novel.docx'), false);
  assert.equal(body.messages.at(-1).content.includes('[REDACTED_PATH]'), true);
  assert.deepEqual(outcome.tokens, ['token_budget_exceeded_warning stays', '[REDACTED]']);
  assert.equal(outcome.errors.length, 0);
  assert.ok(outcome.done.redactions.some((entry) => entry.kind === 'path' && entry.count >= 1));
  assert.ok(outcome.done.redactions.some((entry) => entry.kind === 'secret' && entry.count >= 1));
});

test('Codex ignores annotation and non-text deltas and completes with output_text only', async (t) => {
  const server = await createScriptServer(async ({ write, end }) => {
    write('data: {"type":"response.output_text.delta","delta":"Hello"}\n\n');
    write('data: {"type":"response.output_text.annotation.added","annotation":{"type":"url_citation"}}\n\n');
    write('data: {"type":"response.reasoning_summary_text.delta","delta":"hidden thought"}\n\n');
    write('data: {"type":"response.function_call_arguments.delta","delta":"{\\"arg\\":1}"}\n\n');
    write('event: response.completed\ndata: {"type":"response.completed"}\n\n');
    end();
  });
  t.after(() => server.close());
  const clients = createAgentClients({
    historyPath: path.join(makeTempDir(), 'history.json'),
    profileConfigs: { codex: profileConfig('codex', server.endpoint) },
    vault: { getSecret: () => 'codex-secret' },
  });
  const { result } = await runStream(clients, 'codex', {
    input: 'annotate this',
    context: { projectId: 'codex-annotation' },
  });
  const outcome = await result;
  assert.deepEqual(outcome.tokens, ['Hello']);
  assert.equal(outcome.errors.length, 0);
  assert.equal(outcome.done.state, 'done');
});

test('Codex failed and incomplete events settle as PROVIDER_ERROR', async (t) => {
  for (const type of ['response.failed', 'response.incomplete']) {
    const server = await createScriptServer(async ({ write, end }) => {
      write(`data: ${JSON.stringify({ type })}\n\n`);
      end();
    });
    t.after(() => server.close());
    const clients = createAgentClients({
      historyPath: path.join(makeTempDir(), 'history.json'),
      profileConfigs: { codex: profileConfig('codex', server.endpoint) },
      vault: { getSecret: () => 'codex-secret' },
    });
    const { result } = await runStream(clients, 'codex', {
      input: 'fail this',
      context: { projectId: `codex-${type}` },
    });
    const outcome = await result;
    assert.equal(outcome.done, null);
    assert.equal(outcome.errors.length, 1);
    assert.equal(outcome.errors[0].code, 'PROVIDER_ERROR');
    assert.equal(clients.getHistory('codex', `codex-${type}`).length, 0);
  }
});

test('truncated stream without a terminal event is incomplete_stream and does not persist history', async (t) => {
  const server = await createScriptServer(async ({ write, end }) => {
    write(providerChunk('grok', 'partial'));
    end();
  });
  t.after(() => server.close());
  const historyPath = path.join(makeTempDir(), 'history.json');
  const clients = createAgentClients({
    historyPath,
    profileConfigs: { grok: profileConfig('grok', server.endpoint) },
    vault: { getSecret: () => 'trunc-secret' },
  });
  const { result } = await runStream(clients, 'grok', {
    input: 'cut off',
    context: { projectId: 'trunc-project' },
  });
  const outcome = await result;
  assert.deepEqual(outcome.tokens, ['partial']);
  assert.equal(outcome.done, null);
  assert.equal(outcome.errors.length, 1);
  assert.equal(outcome.errors[0].code, 'PROVIDER_ERROR');
  assert.equal(outcome.errors[0].details.reason, 'incomplete_stream');
  assert.equal(outcome.errors[0].details.redactions.some((entry) => entry.kind === 'path'), true);
  assert.equal(clients.getHistory('grok', 'trunc-project').length, 0);
  assert.equal(fs.existsSync(historyPath), false);
});

test('chat adapters ignore reasoning_content and persist only answer text', async (t) => {
  const server = await createScriptServer(async ({ write, end }) => {
    write('data: {"choices":[{"delta":{"reasoning_content":"hidden thought"}}]}\n\n');
    write('data: {"choices":[{"delta":{"content":"visible answer"}}]}\n\n');
    write(providerDone('grok'));
    end();
  });
  t.after(() => server.close());
  const clients = createAgentClients({
    historyPath: path.join(makeTempDir(), 'history.json'),
    profileConfigs: { grok: profileConfig('grok', server.endpoint) },
    vault: { getSecret: () => 'reason-secret' },
  });
  const { result } = await runStream(clients, 'grok', {
    input: 'think then answer',
    context: { projectId: 'reason-project' },
  });
  const outcome = await result;
  assert.deepEqual(outcome.tokens, ['visible answer']);
  assert.equal(outcome.errors.length, 0);
  assert.equal(outcome.done.state, 'done');
  const history = clients.getHistory('grok', 'reason-project');
  assert.equal(history.length, 1);
  assert.equal(history[0].output, 'visible answer');
  assert.equal(JSON.stringify(history).includes('hidden thought'), false);
});

