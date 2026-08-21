/**
 * FND-02 acceptance tests: typed preload bridge + IPC router facade.
 *
 * Loads the `.mts` facade modules (type-stripped by Node v26) and the shared
 * contracts directly via dynamic `import`, proving that:
 *   - malformed envelopes are rejected before any handler runs,
 *   - unauthorized/unknown senders are rejected,
 *   - unknown methods and bad args are rejected,
 *   - valid commands route to handlers and responses unwrap correctly.
 */
const test = require('node:test');
const assert = require('node:assert/strict');

const PRELOAD = '../electron/preload/index.mts';
const ROUTER = '../electron/main/ipc/index.mts';
const IPC = '../shared/contracts/ipc.ts';
const ERRORS = '../shared/contracts/errors.ts';

test('preload invoke wraps payload on ipc:dispatch and unwraps success', async () => {
  const { createTypedIpcBridge } = await import(PRELOAD);
  const { IPC_DISPATCH_CHANNEL } = await import(ROUTER);
  const { createSuccess } = await import(IPC);

  const captured = {};
  const api = createTypedIpcBridge({
    invoke: async (channel, envelope) => {
      captured.channel = channel;
      captured.envelope = envelope;
      return createSuccess(envelope.requestId, { ok: true });
    },
    send: async (channel, envelope) => {
      captured.channel = channel;
      captured.envelope = envelope;
    },
  });

  const result = await api.getVersion();

  assert.equal(captured.channel, IPC_DISPATCH_CHANNEL);
  assert.equal(captured.envelope.payload.method, 'app:getVersion');
  assert.equal(captured.envelope.protocolVersion, 1);
  assert.deepEqual(result, { ok: true });
});

test('preload rejects invalid args locally without invoking ipc', async () => {
  const { createTypedIpcBridge, IpcBridgeError } = await import(PRELOAD);
  const { createSuccess } = await import(IPC);

  let invoked = false;
  const api = createTypedIpcBridge({
    invoke: async () => {
      invoked = true;
      return createSuccess('x', null);
    },
    send: async () => {},
  });

  await assert.rejects(
    () => api.writeFile({ filePath: 'a' /* missing content */ }),
    (err) => err instanceof IpcBridgeError && err.appError.code === 'VALIDATION_FAILED',
  );
  assert.equal(invoked, false);

  // A well-formed call must still proceed.
  await api.writeFile({ filePath: 'a', content: 'b' });
  assert.equal(invoked, true);
});

test('preload invoke throws IpcBridgeError on a failure envelope', async () => {
  const { createTypedIpcBridge, IpcBridgeError } = await import(PRELOAD);
  const { createFailure } = await import(IPC);
  const { createAppError } = await import(ERRORS);

  const api = createTypedIpcBridge({
    invoke: async (channel, envelope) =>
      createFailure(envelope.requestId, createAppError('NOT_FOUND', 'missing')),
    send: async () => {},
  });

  await assert.rejects(
    () => api.listProjects(),
    (err) => err instanceof IpcBridgeError && err.appError.code === 'NOT_FOUND',
  );
});

test('preload send wraps envelope and fires on ipc:dispatch', async () => {
  const { createTypedIpcBridge } = await import(PRELOAD);
  const { IPC_DISPATCH_CHANNEL } = await import(ROUTER);

  const sent = {};
  const api = createTypedIpcBridge({
    invoke: async () => {},
    send: (channel, envelope) => {
      sent.channel = channel;
      sent.envelope = envelope;
    },
  });

  api.send('app:ping');
  assert.equal(sent.channel, IPC_DISPATCH_CHANNEL);
  assert.equal(sent.envelope.payload.method, 'app:ping');
  assert.equal(sent.envelope.protocolVersion, 1);
});

test('router rejects a malformed envelope before any handler runs', async () => {
  const { dispatch } = await import(ROUTER);
  const { createRequest } = await import(IPC);

  let called = false;
  const handlers = { echo: async (args) => { called = true; return args; } };

  // Missing required `payload`/`requestId` fields.
  const result = await dispatch({ protocolVersion: 1 }, handlers);
  assert.equal(result.ok, false);
  assert.equal(result.error.code, 'VALIDATION_FAILED');
  assert.equal(called, false);

  // Fully valid request confirms the handler would have run.
  const ok = await dispatch(createRequest({ method: 'echo', args: 1 }), handlers);
  assert.equal(ok.ok, true);
});

test('router rejects an unauthorized sender with PERMISSION_DENIED', async () => {
  const { dispatch } = await import(ROUTER);
  const { createRequest } = await import(IPC);

  let called = false;
  const handlers = { echo: async () => { called = true; return 1; } };

  const result = await dispatch(createRequest({ method: 'echo', args: 1 }), handlers, {
    validateSender: () => false,
  });
  assert.equal(result.ok, false);
  const { createSenderValidator } = await import(ROUTER);

  const validate = createSenderValidator(['https://app.vaniscript.local']);
  assert.equal(validate({ senderFrame: { url: 'https://app.vaniscript.local/index.html' } }), true);
  assert.equal(validate({ senderFrame: { url: 'https://evil.test/x' } }), false);
  assert.equal(validate(undefined), false);
});

test('router routes a valid command to its handler with context', async () => {
  const { dispatch } = await import(ROUTER);
  const { createRequest } = await import(IPC);

  let receivedArgs = null;
  let receivedCtx = null;
  const handlers = {
    echo: async (args, ctx) => {
      receivedArgs = args;
      receivedCtx = ctx;
      return { echo: args };
    },
  };

  const envelope = createRequest({ method: 'echo', args: { hi: 1 } }, {
    requestId: 'r1',
    projectId: 'p9',
  });
  const result = await dispatch(envelope, handlers);

  assert.equal(result.ok, true);
  assert.deepEqual(result.value, { echo: { hi: 1 } });
  assert.deepEqual(receivedArgs, { hi: 1 });
  assert.equal(receivedCtx.requestId, 'r1');
  assert.equal(receivedCtx.projectId, 'p9');
});

test('router rejects unknown methods and surfaced handler errors', async () => {
  const { dispatch } = await import(ROUTER);
  const { createRequest } = await import(IPC);
  const { createAppError } = await import(ERRORS);

  const handlers = {
    echo: async (args) => args,
    boom: async () => { throw createAppError('CONFLICT', 'x'); },
    bang: async () => { throw new Error('explode'); },
  };

  const unknown = await dispatch(createRequest({ method: 'nope', args: null }), handlers);
  assert.equal(unknown.ok, false);
  assert.equal(unknown.error.code, 'CAPABILITY_UNAVAILABLE');

  const appErr = await dispatch(createRequest({ method: 'boom', args: null }), handlers);
  assert.equal(appErr.ok, false);
  assert.equal(appErr.error.code, 'CONFLICT');

  const generic = await dispatch(createRequest({ method: 'bang', args: null }), handlers);
  assert.equal(generic.ok, false);
  assert.equal(generic.error.code, 'INTERNAL');
});

test('registerIpcRouter wires ipc:dispatch to dispatch', async () => {
  const { registerIpcRouter, IPC_DISPATCH_CHANNEL } = await import(ROUTER);
  const { createRequest } = await import(IPC);

  let recorded = null;
  const fakeIpcMain = { handle: (channel, fn) => { recorded = { channel, fn }; } };
  const handlers = { echo: async (args) => args };

  registerIpcRouter(fakeIpcMain, handlers);
  assert.equal(recorded.channel, IPC_DISPATCH_CHANNEL);

  const event = { senderFrame: { url: 'app://app/x' } };
  const result = await recorded.fn(event, createRequest({ method: 'echo', args: 7 }));
  assert.equal(result.ok, true);
  assert.equal(result.value, 7);
});
