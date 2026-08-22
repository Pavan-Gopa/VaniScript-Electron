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

test('preload exposes the Batch typed bridge and rejects malformed commands locally', async () => {
  const { createTypedIpcBridge, IpcBridgeError } = await import(PRELOAD);
  const { createSuccess } = await import(IPC);
  const { BATCH_COMMANDS } = await import('../shared/contracts/batch.ts');
  const calls = [];
  const api = createTypedIpcBridge({
    invoke: async (channel, envelope) => {
      calls.push({ channel, envelope });
      return createSuccess(envelope.requestId, { mode: 'stopped', activeJobId: null, badge: 'idle', updatedAt: '' });
    },
    send: () => {},
  });

  await api.getBatchState();
  assert.equal(calls.at(-1).envelope.payload.method, BATCH_COMMANDS.getState);
  await api.listBatchJobs({ limit: 10, offset: 0 });
  assert.equal(calls.at(-1).envelope.payload.method, BATCH_COMMANDS.listJobs);

  await assert.rejects(
    () => api.createBatchProfile({ name: 'missing path' }),
    (error) => error instanceof IpcBridgeError && error.appError.code === 'VALIDATION_FAILED',
  );
  await assert.rejects(
    () => api.getBatchJobDetails({ jobId: '' }),
    (error) => error instanceof IpcBridgeError && error.appError.code === 'VALIDATION_FAILED',
  );
});

test('Batch IPC handlers project D1-D5 APIs and expose deterministic queue controls', async () => {
  const { createBatchHandlers, dispatch } = await import(ROUTER);
  const { createRequest } = await import(IPC);
  const { BATCH_COMMANDS } = await import('../shared/contracts/batch.ts');
  const job = {
    jobId: 'job-1',
    profileId: 'profile-1',
    sourcePath: '/audio/source.mp3',
    outputPath: '/audio/source.txt',
    state: 'pending',
    phase: 'planning',
    attempt: 0,
    maxAttempts: 3,
    progress: 0,
    lastError: null,
  };
  const profile = {
    profileId: 'profile-1',
    name: 'Audio',
    sourcePath: '/audio',
    accessRef: null,
    enabled: true,
    recursive: true,
  };
  const calls = [];
  const domain = {
    listProfiles: () => [profile],
    createProfile: (input) => ({ ...profile, ...input }),
    listJobs: () => [job],
    getJob: () => job,
    listCheckpoints: () => [],
    listEvents: () => [],
    transitionJob: (jobId, state) => ({ ...job, jobId, state }),
  };
  const scheduler = {
    mode: 'stopped',
    activeJob: null,
    async start() { this.mode = 'running'; },
    async pauseAfterCurrent() { this.mode = 'pause-after-current'; },
    async resume() { this.mode = 'running'; },
    async drain() { this.mode = 'stopped'; return { drained: true, pending: 0 }; },
    async cancel(jobId) { calls.push(['cancel', jobId]); return { ...job, jobId, state: 'cancelled' }; },
  };
  const handlers = createBatchHandlers({
    domain,
    scheduler,
    watcher: { start: async () => ({ scanned: 1 }) },
    getIssues: () => [{ type: 'watcher-error', message: 'offline' }],
  });

  const list = await dispatch(createRequest({ method: BATCH_COMMANDS.listJobs, args: { limit: 10 } }), handlers);
  assert.equal(list.ok, true);
  assert.equal(list.value.jobs[0].jobId, 'job-1');
  const details = await dispatch(createRequest({ method: BATCH_COMMANDS.getJobDetails, args: { jobId: 'job-1' } }), handlers);
  assert.equal(details.ok, true);
  assert.deepEqual(details.value.checkpoints, []);
  const issues = await dispatch(createRequest({ method: BATCH_COMMANDS.listIssues, args: null }), handlers);
  assert.equal(issues.value.issues[0].type, 'watcher-error');

  const started = await dispatch(createRequest({ method: BATCH_COMMANDS.start, args: null }), handlers);
  assert.equal(started.value.badge, 'running');
  const paused = await dispatch(createRequest({ method: BATCH_COMMANDS.pauseAfterCurrent, args: null }), handlers);
  assert.equal(paused.value.mode, 'pause-after-current');
  const resumed = await dispatch(createRequest({ method: BATCH_COMMANDS.resume, args: null }), handlers);
  assert.equal(resumed.value.mode, 'running');
  const drained = await dispatch(createRequest({ method: BATCH_COMMANDS.drain, args: null }), handlers);
  assert.equal(drained.value.state.mode, 'stopped');
  const cancelled = await dispatch(createRequest({ method: BATCH_COMMANDS.cancel, args: { jobId: 'job-1' } }), handlers);
  assert.equal(cancelled.value.state, 'cancelled');
  assert.deepEqual(calls, [['cancel', 'job-1']]);
});
