'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const http = require('node:http');
const os = require('node:os');
const path = require('node:path');
const React = require('react');
const ReactDOMServer = require('react-dom/server');
const ReactDOMClient = require('react-dom/client');
const { JSDOM } = require('jsdom');
require('tsx/cjs');

const {
  createAgentClients,
} = require('../electron/main/agents/agentClients.js');

const STORE = '../src/stores/assistantStore.ts';
const SIDEBAR = '../src/components/AssistantSidebar.tsx';
const APP = '../src/App.tsx';
const CHAT_SIDEBAR = '../src/components/ChatSidebar.tsx';

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

async function createScriptServer(script) {
  const server = http.createServer((req, res) => {
    let body = '';
    req.setEncoding('utf8');
    req.on('data', (chunk) => { body += chunk; });
    req.on('end', async () => {
      try {
        await script({
          write: (chunk) => res.write(chunk),
          end: () => res.end(),
          waitForClose: () => new Promise((resolve) => {
            if (res.destroyed || res.writableEnded) resolve();
            else res.once('close', resolve);
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
    close: () => new Promise((resolve) => server.close(() => resolve())),
  };
}

function providerChunk(text) {
  return `data: ${JSON.stringify({ type: 'response.output_text.delta', delta: text })}\n\n`;
}

function providerDone() {
  return 'event: response.completed\ndata: {"type":"response.completed","response":{"usage":{"input_tokens":3,"output_tokens":2}}}\n\n';
}

function createMockStream() {
  const listeners = { token: new Set(), done: new Set(), error: new Set() };
  return {
    id: 'stream-mock',
    cancelCalls: 0,
    onToken(listener) { listeners.token.add(listener); },
    onDone(listener) { listeners.done.add(listener); },
    onError(listener) { listeners.error.add(listener); },
    emit(kind, value) {
      for (const listener of listeners[kind]) listener(value);
    },
    cancel() {
      this.cancelCalls += 1;
      this.emit('error', { code: 'CANCELLED', message: 'cancelled' });
      return Promise.resolve({ state: 'cancelled' });
    },
  };
}

async function loadStore() {
  return import(STORE);
}

test('selector wiring follows D4 profile defaults and hides Grok reasoning', async () => {
  const { createAssistantStore, modelsForProfile, supportsReasoning } = await loadStore();
  const store = createAssistantStore({
    listProfiles: () => [
      { id: 'codex', label: 'Codex', provider: 'openai', defaultModel: 'gpt-5', requiresKey: true },
      { id: 'grok', label: 'Grok', provider: 'xai', defaultModel: 'grok-4.1', requiresKey: true },
      { id: 'qwen', label: 'Qwen', provider: 'dashscope', defaultModel: 'qwen-max', requiresKey: true },
    ],
    start: () => createMockStream(),
  });
  await store.refreshProfiles();
  assert.deepEqual(store.getState().profiles.map((profile) => profile.id), ['codex', 'grok', 'qwen']);
  store.setProfile('qwen');
  assert.equal(store.getState().profileId, 'qwen');
  assert.equal(store.getState().model, 'qwen-max');
  store.setModel('qwen-plus');
  store.setReasoning('high');
  assert.equal(store.getState().model, 'qwen-plus');
  assert.equal(store.getState().reasoning, 'high');
  assert.equal(supportsReasoning('grok'), false);
  assert.equal(supportsReasoning('codex'), true);
  assert.ok(modelsForProfile(store.getState().profiles[2]).includes('qwen-max'));
});

test('store FSM streams tokens then settles done with redactions', async () => {
  const { createAssistantStore } = await loadStore();
  const stream = createMockStream();
  const store = createAssistantStore({ start: () => stream });
  store.setDraft('hello');
  await store.send();
  assert.equal(store.getState().phase, 'starting');
  stream.emit('token', 'Hi');
  stream.emit('token', ' there');
  assert.equal(store.getState().phase, 'streaming');
  assert.equal(store.getState().streamingText, 'Hi there');
  stream.emit('done', { output: 'Hi there', redactions: [{ kind: 'path', count: 1 }, { kind: 'secret', count: 2 }] });
  assert.equal(store.getState().phase, 'done');
  assert.equal(store.getState().streamId, null);
  assert.equal(store.getState().canCancel, false);
  assert.equal(store.getState().messages.at(-1).text, 'Hi there');
  assert.deepEqual(store.getState().lastRedactions, [{ kind: 'path', count: 1 }, { kind: 'secret', count: 2 }]);
});

test('store FSM records provider errors without leaving an active stream', async () => {
  const { createAssistantStore } = await loadStore();
  const stream = createMockStream();
  const store = createAssistantStore({ start: () => stream });
  store.setDraft('fail');
  await store.send();
  stream.emit('error', { code: 'PROVIDER_ERROR', message: 'upstream failed' });
  assert.equal(store.getState().phase, 'error');
  assert.equal(store.getState().lastError, 'upstream failed');
  assert.equal(store.getState().streamId, null);
  assert.equal(store.getState().canCancel, false);
});

test('J2 cancel path reaches AgentStream.cancel and leaves no orphaned stream', async (t) => {
  const { createAssistantStore } = await loadStore();
  let firstChunkSent = false;
  const server = await createScriptServer(async ({ write, waitForClose }) => {
    write(providerChunk('first'));
    firstChunkSent = true;
    await waitForClose();
  });
  t.after(() => server.close());
  const historyPath = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'vs-assistant-')), 'history.json');
  const clients = createAgentClients({
    historyPath,
    profileConfigs: { codex: { endpoint: server.endpoint, keyRef: 'codex-ref', model: 'gpt-5' } },
    vault: { getSecret: () => 'cancel-secret' },
  });
  let lastStream;
  const store = createAssistantStore({
    listProfiles: () => clients.listProfiles(),
    start: (profile, request) => {
      lastStream = clients.start(profile, request);
      return lastStream;
    },
  });
  store.setDraft('cancel this');
  await store.send();
  await waitFor(() => firstChunkSent && store.getState().phase === 'streaming');
  assert.equal(store.getState().canCancel, true);
  assert.ok(store.getState().streamId);
  await store.cancel();
  assert.equal(store.getState().phase, 'cancelled');
  assert.equal(store.getState().streamId, null);
  assert.equal(store.getState().canCancel, false);
  await lastStream.settled;
  assert.equal(lastStream.state, 'cancelled');
  assert.equal(clients.status().active.length, 0);
  lastStream.onToken(() => {
    throw new Error('late token after cancel must not be observed by the store');
  });
  assert.equal(store.getState().phase, 'cancelled');
});

test('send-to-assistant shapes a bounded preview and refuses empty dumps', async () => {
  const { createAssistantStore, shapeSendToAssistant, composeAssistantInput, MAX_SELECTION_CHARS } = await loadStore();
  assert.equal(shapeSendToAssistant({ source: 'transcript', text: '   ' }), null);
  const long = 'word '.repeat(5000);
  const shaped = shapeSendToAssistant({ source: 'transcript', text: long, label: 'Source' });
  assert.ok(shaped);
  assert.equal(shaped.text.length, MAX_SELECTION_CHARS);
  assert.ok(shaped.preview.length <= 280);
  assert.equal(shaped.truncated, true);
  const store = createAssistantStore({ start: () => createMockStream() });
  const queued = store.queueSelection({ source: 'shorts', text: 'Hook line\nTitle', label: 'Clip' });
  assert.equal(queued.source, 'shorts');
  assert.ok(store.getState().selection.preview.includes('Hook line'));
  const input = composeAssistantInput('rewrite this', store.getState().selection, []);
  assert.match(input, /\[shorts · Clip\]/);
  assert.match(input, /rewrite this/);
});

test('confirmation approval uses mocked mcp:confirmChallenge and is never auto-accepted', async () => {
  const { createAssistantStore, MCP_CONFIRM_CHALLENGE_CHANNEL } = await loadStore();
  const approvals = [];
  const stream = createMockStream();
  const store = createAssistantStore({
    start: () => stream,
    confirmChallenge: (challengeId) => {
      approvals.push(challengeId);
      return true;
    },
  });
  store.setDraft('mutate the chunk');
  await store.send();
  store.noteRunningTool('update_chunk_text');
  stream.emit('error', {
    code: 'MCP_CONFIRMATION_REQUIRED',
    message: 'Human confirmation required',
    details: { challengeId: 'chal-1', confirmationText: 'Update chunk 3 text?', requiresHumanConfirmation: true },
  });
  assert.equal(store.getState().challenges.length, 1);
  assert.equal(store.getState().challenges[0].challengeId, 'chal-1');
  assert.equal(approvals.length, 0);
  assert.equal(store.getState().runningTool, 'update_chunk_text');
  const approved = await store.approveChallenge('chal-1');
  assert.equal(approved, true);
  assert.deepEqual(approvals, ['chal-1']);
  assert.equal(store.getState().challenges.length, 0);
  assert.equal(MCP_CONFIRM_CHALLENGE_CHANNEL, 'mcp:confirmChallenge');
});

test('dictation UI stays deferred without inventing a transcript', async () => {
  const { createAssistantStore, DICTATION_DEFERRED } = await loadStore();
  const store = createAssistantStore({ start: () => createMockStream() });
  await store.startDictation();
  assert.equal(store.getState().dictationStatus, 'deferred');
  assert.equal(store.getState().dictationMessage, DICTATION_DEFERRED);
  assert.equal(store.getState().draft, '');
  await store.stopDictation();
  assert.equal(store.getState().draft, '');
});

test('attachments require an opaque handle and explicit preview', async () => {
  const { createAssistantStore } = await loadStore();
  const store = createAssistantStore({
    start: () => createMockStream(),
    pickAttachment: () => ({ handle: '/Users/pavan/secret.docx', previewLabel: 'secret.docx', previewKind: 'file' }),
    pickScreenshot: () => ({ handle: 'shot-1', previewLabel: 'Screenshot', previewKind: 'screenshot', previewUrl: 'data:image/png;base64,abc' }),
  });
  await store.pickAttachment();
  assert.equal(store.getState().attachments.length, 0);
  assert.match(store.getState().lastError, /opaque handle/);
  await store.pickScreenshot();
  assert.equal(store.getState().attachments.length, 1);
  assert.equal(store.getState().attachments[0].handle, 'shot-1');
  assert.ok(store.getState().attachments[0].previewUrl.startsWith('data:'));
});

test('copy and retry use the last turn without starting a second live stream', async () => {
  const { createAssistantStore } = await loadStore();
  const copied = [];
  let starts = 0;
  const first = createMockStream();
  const second = createMockStream();
  const store = createAssistantStore({
    start: () => {
      starts += 1;
      return starts === 1 ? first : second;
    },
    copyText: (text) => { copied.push(text); },
  });
  store.setDraft('first prompt');
  await store.send();
  first.emit('token', 'answer');
  first.emit('done', { output: 'answer' });
  assert.equal(await store.copyLast(), 'answer');
  assert.deepEqual(copied, ['answer']);
  await store.retryLast();
  assert.equal(starts, 2);
  assert.equal(store.getState().messages.filter((message) => message.role === 'user').length, 2);
});
test('Assistant sidebar exposes a localized Help Center entry and App wiring', async () => {
  const { createAssistantStore } = await loadStore();
  const { AssistantSidebar } = require(SIDEBAR);
  const store = createAssistantStore({ start: () => createMockStream() });
  let opened = 0;

  const russianMarkup = ReactDOMServer.renderToStaticMarkup(
    React.createElement(AssistantSidebar, {
      isOpen: true,
      onClose: () => {},
      onOpenHelp: () => { opened += 1; },
      helpLocale: 'ru',
      store,
    }),
  );
  assert.match(russianMarkup, /data-testid="assistant-open-help"/);
  assert.match(russianMarkup, /Центр помощи/);

  const appSource = fs.readFileSync(path.join(__dirname, APP), 'utf8');
  assert.match(appSource, /<AssistantSidebar[\s\S]*?onOpenHelp=\{openHelpCenter\}/);
  assert.match(appSource, /<AssistantSidebar[\s\S]*?helpLocale=\{settings\.helpLocale\}/);

  const dom = new JSDOM('<!doctype html><main id="assistant-root"></main>', { url: 'http://localhost' });
  const previousWindow = global.window;
  const previousDocument = global.document;
  const previousActEnvironment = global.IS_REACT_ACT_ENVIRONMENT;
  try {
    global.window = dom.window;
    global.document = dom.window.document;
    global.IS_REACT_ACT_ENVIRONMENT = true;
    dom.window.HTMLElement.prototype.scrollIntoView = () => {};
    const root = ReactDOMClient.createRoot(dom.window.document.querySelector('#assistant-root'));
    await React.act(async () => {
      root.render(React.createElement(AssistantSidebar, {
        isOpen: true,
        onClose: () => {},
        onOpenHelp: () => { opened += 1; },
        store,
      }));
    });
    await React.act(async () => {
      dom.window.document.querySelector('[data-testid="assistant-open-help"]').dispatchEvent(
        new dom.window.MouseEvent('click', { bubbles: true }),
      );
    });
    assert.equal(opened, 1);
    await React.act(async () => {
      root.unmount();
    });
    await sleep(0);
  } finally {
    if (previousWindow === undefined) delete global.window;
    else global.window = previousWindow;
    if (previousDocument === undefined) delete global.document;
    else global.document = previousDocument;
    if (previousActEnvironment === undefined) delete global.IS_REACT_ACT_ENVIRONMENT;
    else global.IS_REACT_ACT_ENVIRONMENT = previousActEnvironment;
    dom.window.close();
  }
});

test('direct provider paths do not auto-claim MCP tool execution', async () => {
  const { createAssistantStore } = await loadStore();
  const { AssistantSidebar } = require(SIDEBAR);
  const stream = createMockStream();
  const store = createAssistantStore({ start: () => stream });
  store.setDraft('How do I export subtitles?');
  await store.send();
  stream.emit('token', 'Open Help Center.');

  const markup = ReactDOMServer.renderToStaticMarkup(
    React.createElement(AssistantSidebar, {
      isOpen: true,
      onClose: () => {},
      onOpenHelp: () => {},
      store,
    }),
  );
  assert.doesNotMatch(markup, /Running tool:/);
  assert.equal(store.getState().runningTool, null);

  const chatSource = fs.readFileSync(path.join(__dirname, CHAT_SIDEBAR), 'utf8');
  const directApiStart = chatSource.indexOf('const handleSend =');
  const grokStart = chatSource.indexOf('const handleSendGrok =');
  assert.ok(directApiStart >= 0 && grokStart > directApiStart);
  const directApiSource = chatSource.slice(directApiStart, grokStart);
  assert.match(directApiSource, /DIRECT_API_SYSTEM_PROMPT/);
  assert.doesNotMatch(directApiSource, /executeMcpTool|MCP_TOOL_DECLARATIONS/);
  for (const toolName of ['list_help_topics', 'get_help_topic', 'search_help', 'get_contextual_help', 'get_onboarding_checklist']) {
    assert.match(chatSource, new RegExp(`name: '${toolName}'`));
  }
});


test('Assistant sidebar jsdom render shows selectors, cancel, preview, and challenge approve', async () => {
  const { createAssistantStore } = await loadStore();
  const { AssistantSidebar } = require(SIDEBAR);
  const stream = createMockStream();
  const approvals = [];
  const store = createAssistantStore({
    start: () => stream,
    confirmChallenge: (challengeId) => {
      approvals.push(challengeId);
      return true;
    },
  });
  store.queueSelection({ source: 'editor', text: 'Selected caption line', label: 'Clip editor' });
  store.surfaceChallenge({ challengeId: 'chal-ui', confirmationText: 'Apply subtitle edit?' });
  store.noteRunningTool('update_shorts_plan');
  store.setDraft('please edit');
  await store.send();
  stream.emit('token', 'working');

  const markup = ReactDOMServer.renderToStaticMarkup(
    React.createElement(AssistantSidebar, { isOpen: true, onClose: () => {}, store }),
  );
  const dom = new JSDOM(`<!doctype html><main id="fixture">${markup}</main>`);
  const root = dom.window.document;
  assert.ok(root.querySelector('[data-testid="assistant-sidebar"]'));
  assert.ok(root.querySelector('[data-testid="assistant-profile"]'));
  assert.ok(root.querySelector('[data-testid="assistant-model"]'));
  assert.ok(root.querySelector('[data-testid="assistant-reasoning"]'));
  assert.equal(root.querySelector('[data-testid="assistant-phase"]').textContent.includes('streaming'), true);
  assert.ok(root.querySelector('[data-testid="assistant-cancel"]'));
  assert.equal(root.querySelector('[data-testid="assistant-selection-preview"]').textContent.includes('Selected caption line'), true);
  assert.equal(root.querySelector('[data-testid="assistant-running-tool"]').textContent.includes('update_shorts_plan'), true);
  assert.equal(root.querySelector('[data-testid="assistant-challenge"]').textContent.includes('Apply subtitle edit?'), true);
  assert.ok(root.querySelector('[data-testid="assistant-approve"]'));
  assert.equal(approvals.length, 0);
  dom.window.close();
});

test('E2E-style mocked transport surfaces a tool confirmation and only approves through IPC', async () => {
  const { createAssistantStore } = await loadStore();
  const { AssistantSidebar } = require(SIDEBAR);
  const ipc = [];
  const stream = createMockStream();
  const store = createAssistantStore({
    start: () => stream,
    confirmChallenge: async (challengeId) => {
      ipc.push({ channel: 'mcp:confirmChallenge', challengeId });
      return true;
    },
  });
  store.setDraft('rename the lecturer');
  await store.send();
  store.noteRunningTool('update_chunk_text');
  stream.emit('error', {
    code: 'MCP_CONFIRMATION_REQUIRED',
    details: { challengeId: 'chal-e2e', confirmationText: 'Update lecturer name in chunk 2?' },
  });
  const markup = ReactDOMServer.renderToStaticMarkup(
    React.createElement(AssistantSidebar, { isOpen: true, onClose: () => {}, store }),
  );
  assert.match(markup, /Update lecturer name in chunk 2\?/);
  assert.equal(ipc.length, 0);
  assert.equal(await store.approveChallenge('chal-e2e'), true);
  assert.deepEqual(ipc, [{ channel: 'mcp:confirmChallenge', challengeId: 'chal-e2e' }]);
  assert.equal(store.getState().challenges.length, 0);
});
