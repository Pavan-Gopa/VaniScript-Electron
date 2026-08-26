'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const fixture = require('./fixtures/shorts-render-contract.json');
const {
  createHyperFramesExportCoordinator,
  validateShortsExportSnapshot,
} = require('../electron/hyperframes-export-session');

const silentLog = {
  info() {},
  warn() {},
  error() {},
};

function clone(value) {
  return JSON.parse(JSON.stringify(value));
}

function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

function makeCase(jobId = fixture.snapshot.jobId) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'vaniscript-d5-s4-'));
  const outputDir = path.join(root, 'outputs');
  const runtimeRoot = path.join(root, 'runtime');
  const sourcePath = path.join(root, 'source.mp4');
  fs.mkdirSync(outputDir, { recursive: true });
  fs.writeFileSync(sourcePath, 'test source placeholder');

  const snapshot = clone(fixture.snapshot);
  snapshot.jobId = jobId;
  snapshot.source.inputVideoPath = sourcePath;
  snapshot.clips.forEach((clip) => {
    clip.outputPath = path.join(outputDir, clip.fileName);
  });
  return { root, outputDir, runtimeRoot, sourcePath, snapshot };
}

function cleanupCase(testCase) {
  fs.rmSync(testCase.root, { recursive: true, force: true });
}

function createCoordinator(testCase, render, events, extra = {}) {
  return createHyperFramesExportCoordinator({
    runtimeRoot: testCase.runtimeRoot,
    renderShortClip: render,
    sendEvent: (event) => events.push(event),
    log: silentLog,
    ...extra,
  });
}

function outputBytes(project) {
  return Buffer.from(JSON.stringify({
    id: project.id,
    title: project.title,
    cue: project.subtitles[0]?.text,
    zoom: project.frameKeyframes[1]?.zoom,
    text: project.textTracks[0]?.blocks[0]?.text,
    color: project.captionStyle.textColor,
  }));
}

function partialPath(finalPath, jobId) {
  return path.join(path.dirname(finalPath), `.${path.basename(finalPath)}.${jobId}.partial`);
}

function assertTerminalMatches(event, expected, snapshot) {
  assert.equal(event.kind, 'terminal');
  assert.equal(event.state, expected.state);
  assert.equal(event.cleanupComplete, expected.cleanupComplete);
  assert.deepEqual(event.outputs, expected.outputs === 'all-final-paths'
    ? snapshot.clips.map((clip) => clip.outputPath)
    : expected.outputs);
  if (expected.progress !== undefined) assert.equal(event.progress, expected.progress);
  if (expected.completed !== undefined) assert.equal(event.completed, expected.completed);
  if (expected.failedClipIndex !== undefined) assert.equal(event.failedClipIndex, expected.failedClipIndex);
  if (expected.failedStableID !== undefined) assert.equal(event.failedStableID, expected.failedStableID);
}

test('O2 fixture is a valid source/target snapshot and stays immutable after export starts', async () => {
  const testCase = makeCase('s4-immutable');
  const events = [];
  const firstStarted = deferred();
  const firstRelease = deferred();
  const renderInputs = [];
  const renderedBytes = [];
  const expectedBytes = testCase.snapshot.clips.map((clip) => outputBytes(clip.project).toString('hex'));
  let coordinator;

  try {
    assert.equal(validateShortsExportSnapshot(testCase.snapshot).ok, true);
    assert.deepEqual(
      testCase.snapshot.clips.map((clip) => [clip.stableID, clip.language]),
      fixture.expectations.orderedUnits,
    );
    assert.deepEqual(
      testCase.snapshot.clips.map((clip) => clip.fileName),
      fixture.expectations.deterministicFileNames,
    );

    const render = async ({ project, outputPath, onProgress }) => {
      renderInputs.push(project);
      if (renderInputs.length === 1) {
        firstStarted.resolve();
        await firstRelease.promise;
      }
      const bytes = outputBytes(project);
      renderedBytes.push(bytes.toString('hex'));
      fs.writeFileSync(outputPath, bytes);
      onProgress({ progress: 0.6, stage: 'render', message: 'rendered' });
      return { success: true, outputPath };
    };
    coordinator = createCoordinator(testCase, render, events);
    const exportPromise = coordinator.start(testCase.snapshot);
    await firstStarted.promise;

    testCase.snapshot.source.sourceFileName = 'mutated-source-name.mp4';
    testCase.snapshot.options.qualityPreset = 'compact';
    testCase.snapshot.clips[0].project.title = 'MUTATED SOURCE TITLE';
    testCase.snapshot.clips[0].project.subtitles[0].text = 'MUTATED SOURCE CUE';
    testCase.snapshot.clips[0].project.frameKeyframes[1].zoom = 2.9;
    testCase.snapshot.clips[1].project.title = 'MUTATED TARGET TITLE';
    testCase.snapshot.clips[1].project.subtitles[0].text = 'MUTATED TARGET CUE';
    testCase.snapshot.clips[1].project.textTracks[0].blocks[0].text = 'MUTATED TARGET TEXT';

    firstRelease.resolve();
    const terminal = await exportPromise;

    assertTerminalMatches(terminal, fixture.expectations.terminal.succeeded, testCase.snapshot);
    assert.deepEqual(renderInputs.map((project) => project.id), [
      'fixture-plan-01-source',
      'fixture-plan-01-target',
    ]);
    assert(renderInputs.every((project) => Object.isFrozen(project)));
    assert.equal(renderedBytes.length, 2);
    assert.deepEqual(renderedBytes, expectedBytes);
    assert.deepEqual(
      testCase.snapshot.clips.map((clip) => fs.readFileSync(clip.outputPath).toString('hex')),
      expectedBytes,
    );
    assert.equal(events.filter((event) => event.kind === 'terminal').length, 1);
  } finally {
    cleanupCase(testCase);
  }
});

test('two clips render in deterministic order with one active renderer at a time', async () => {
  const testCase = makeCase('s4-serial');
  const events = [];
  const firstStarted = deferred();
  const firstRelease = deferred();
  const secondStarted = deferred();
  const secondRelease = deferred();
  const calls = [];
  let active = 0;
  let maxActive = 0;

  try {
    const render = async ({ project, outputPath, onProgress }) => {
      calls.push(project.id);
      active += 1;
      maxActive = Math.max(maxActive, active);
      const gate = calls.length === 1 ? firstRelease : secondRelease;
      if (calls.length === 1) firstStarted.resolve();
      if (calls.length === 2) secondStarted.resolve();
      try {
        await gate.promise;
        fs.writeFileSync(outputPath, project.id);
        onProgress({ progress: 0.4, stage: 'render', message: project.id });
        return { success: true, outputPath };
      } finally {
        active -= 1;
      }
    };
    const coordinator = createCoordinator(testCase, render, events);
    const exportPromise = coordinator.start(testCase.snapshot);

    await firstStarted.promise;
    assert.deepEqual(calls, ['fixture-plan-01-source']);
    firstRelease.resolve();
    await secondStarted.promise;
    assert.deepEqual(calls, ['fixture-plan-01-source', 'fixture-plan-01-target']);
    assert.equal(maxActive, 1);
    secondRelease.resolve();

    const terminal = await exportPromise;
    assertTerminalMatches(terminal, fixture.expectations.terminal.succeeded, testCase.snapshot);
    assert.equal(active, 0);
  } finally {
    cleanupCase(testCase);
  }
});

test('active duplicate and busy starts are rejected before another producer call', async () => {
  const testCase = makeCase('s4-gate-primary');
  const busyCase = makeCase('s4-gate-other');
  const events = [];
  const rendererStarted = deferred();
  const rendererRelease = deferred();
  let producerCalls = 0;

  try {
    const render = async ({ outputPath }) => {
      producerCalls += 1;
      fs.writeFileSync(outputPath, 'active partial');
      rendererStarted.resolve();
      await rendererRelease.promise;
      return { success: true, outputPath };
    };
    const coordinator = createCoordinator(testCase, render, events);
    const exportPromise = coordinator.start(testCase.snapshot);
    await rendererStarted.promise;

    const duplicate = coordinator.start(clone(testCase.snapshot));
    const busySnapshot = clone(busyCase.snapshot);
    const busy = coordinator.start(busySnapshot);
    assert.equal(duplicate.errorCode, 'EXPORT_DUPLICATE');
    assert.equal(busy.errorCode, 'EXPORT_BUSY');
    assert.equal(producerCalls, 1);
    assert.equal(events.filter((event) => event.kind === 'terminal').length, 0);

    const cancelResult = coordinator.cancel({ jobId: testCase.snapshot.jobId });
    assert.equal(cancelResult.accepted, true);
    rendererRelease.resolve();
    const terminal = await exportPromise;
    assertTerminalMatches(terminal, fixture.expectations.terminal.cancelled, testCase.snapshot);
  } finally {
    cleanupCase(testCase);
    cleanupCase(busyCase);
  }
});

test('producer progress is monotonic at the batch boundary and completion is not terminal', async () => {
  const testCase = makeCase('s4-progress');
  const events = [];
  const producerCompletionEventKinds = [];
  let calls = 0;

  try {
    const render = async ({ outputPath, onProgress }) => {
      calls += 1;
      onProgress({ status: 'processing', progress: 0.4, stage: 'render', message: '40%' });
      onProgress({ status: 'processing', progress: 0.2, stage: 'render', message: '20% late callback' });
      onProgress({ status: 'completed', progress: 1, stage: 'producer-completed', message: 'producer completed' });
      producerCompletionEventKinds.push(events.at(-1)?.kind);
      fs.writeFileSync(outputPath, `clip-${calls}`);
      return { success: true, outputPath };
    };
    const coordinator = createCoordinator(testCase, render, events);
    const terminal = await coordinator.start(testCase.snapshot);

    const sequences = events.map((event) => event.sequence);
    const progresses = events.map((event) => event.progress);
    for (let index = 1; index < sequences.length; index += 1) {
      assert.ok(sequences[index] > sequences[index - 1]);
      assert.ok(progresses[index] >= progresses[index - 1]);
    }
    assert.deepEqual(producerCompletionEventKinds, ['progress', 'progress']);
    assert.equal(events.filter((event) => event.kind === 'terminal').length, 1);
    assertTerminalMatches(terminal, fixture.expectations.terminal.succeeded, testCase.snapshot);
  } finally {
    cleanupCase(testCase);
  }
});

test('cancel after a first final and second partial candidate retains the controller until settle and cleans everything', async () => {
  const testCase = makeCase('s4-cancel-after-candidate');
  const events = [];
  const secondStarted = deferred();
  const secondRelease = deferred();
  let calls = 0;
  let firstFinalPath;
  let secondPartialPath;
  let runtimeDir;
  let abortObserved = false;
  let lateProgress;
  const cleanupCalls = [];

  try {
    const render = async ({ outputPath, runtimeChildDir, abortSignal, onProgress }) => {
      calls += 1;
      runtimeDir = runtimeChildDir;
      fs.mkdirSync(path.join(runtimeChildDir, `clip-${calls}`), { recursive: true });
      fs.writeFileSync(path.join(runtimeChildDir, `clip-${calls}`, 'runtime.asset'), 'runtime');
      fs.writeFileSync(outputPath, `candidate-${calls}`);
      if (calls === 1) {
        firstFinalPath = testCase.snapshot.clips[0].outputPath;
        onProgress({ progress: 0.9, stage: 'render', message: 'first candidate' });
        return { success: true, outputPath };
      }
      secondPartialPath = outputPath;
      lateProgress = onProgress;
      abortSignal.addEventListener('abort', () => { abortObserved = true; }, { once: true });
      secondStarted.resolve();
      await secondRelease.promise;
      return { success: true, outputPath };
    };
    const coordinator = createCoordinator(testCase, render, events, {
      cleanupSession: async ({ runtimeDir, partialPaths, ownedFinalPaths, preserveOutputs }) => {
        cleanupCalls.push({
          runtimeDir,
          partialPaths: [...partialPaths],
          ownedFinalPaths: [...ownedFinalPaths],
          preserveOutputs,
        });
        for (const filePath of [...partialPaths, ...ownedFinalPaths, runtimeDir]) {
          fs.rmSync(filePath, { recursive: true, force: true });
        }
      },
    });
    const exportPromise = coordinator.start(testCase.snapshot);
    await secondStarted.promise;

    assert.equal(fs.existsSync(firstFinalPath), true);
    assert.equal(fs.existsSync(secondPartialPath), true);
    const sessionBeforeCancel = coordinator.getSession(testCase.snapshot.jobId);
    const controller = sessionBeforeCancel.controller;
    const cancelResult = coordinator.cancel({ jobId: testCase.snapshot.jobId });
    assert.equal(cancelResult.accepted, true);
    assert.equal(abortObserved, true);
    assert.equal(coordinator.getSession(testCase.snapshot.jobId).controller, controller);
    assert.equal(coordinator.getSession(testCase.snapshot.jobId).state, 'cancelling');
    assert.equal(events.filter((event) => event.kind === 'terminal').length, 0);

    secondRelease.resolve();
    const terminal = await exportPromise;
    assertTerminalMatches(terminal, fixture.expectations.terminal.cancelled, testCase.snapshot);
    assert.equal(events.filter((event) => event.kind === 'terminal').length, 1);
    assert.equal(fs.existsSync(firstFinalPath), false);
    assert.equal(fs.existsSync(secondPartialPath), false);
    assert.equal(fs.existsSync(runtimeDir), false);
    assert.equal(cleanupCalls.length, 1);
    assert.equal(cleanupCalls[0].runtimeDir, runtimeDir);
    assert.deepEqual(cleanupCalls[0].partialPaths, [secondPartialPath]);
    assert.deepEqual(cleanupCalls[0].ownedFinalPaths, [firstFinalPath]);
    assert.equal(cleanupCalls[0].preserveOutputs, false);
    const eventCountAfterTerminal = events.length;
    lateProgress?.({ progress: 1, stage: 'late', message: 'late producer callback' });
    assert.equal(events.length, eventCountAfterTerminal);
    assert.equal(coordinator.getSession(testCase.snapshot.jobId), undefined);
    assert.equal(coordinator.getActiveJobId(), null);
  } finally {
    cleanupCase(testCase);
  }
});

test('cancellation before rename avoids ownership and cancellation after rename removes the owned final', async () => {
  const beforeCase = makeCase('s4-cancel-before-rename');
  const afterCase = makeCase('s4-cancel-after-rename');
  const events = [];
  const beforeStarted = deferred();
  const beforeRelease = deferred();
  let coordinator;
  let afterCancelResult;
  let afterRenameObserved = false;
  let mode = 'before';
  const sendEvent = (event) => {
    events.push(event);
    if (mode === 'after'
      && event.jobId === afterCase.snapshot.jobId
      && event.kind === 'progress'
      && event.stage === 'complete'
      && !afterCancelResult) {
      afterRenameObserved = fs.existsSync(afterCase.snapshot.clips[0].outputPath);
      afterCancelResult = coordinator.cancel({ jobId: afterCase.snapshot.jobId });
    }
  };

  try {
    const render = async ({ outputPath, runtimeChildDir }) => {
      fs.writeFileSync(outputPath, `candidate-${mode}`);
      fs.writeFileSync(path.join(runtimeChildDir, 'runtime.asset'), 'runtime');
      if (mode === 'before') {
        beforeStarted.resolve();
        await beforeRelease.promise;
      }
      return { success: true, outputPath };
    };
    coordinator = createCoordinator(beforeCase, render, events, { sendEvent });
    const beforePromise = coordinator.start(beforeCase.snapshot);
    await beforeStarted.promise;
    const beforeFinalPath = beforeCase.snapshot.clips[0].outputPath;
    assert.equal(fs.existsSync(beforeFinalPath), false);
    const beforeCancel = coordinator.cancel({ jobId: beforeCase.snapshot.jobId });
    assert.equal(beforeCancel.accepted, true);
    assert.equal(fs.existsSync(beforeFinalPath), false);
    beforeRelease.resolve();
    const beforeTerminal = await beforePromise;
    assertTerminalMatches(beforeTerminal, fixture.expectations.terminal.cancelled, beforeCase.snapshot);
    assert.equal(fs.existsSync(beforeFinalPath), false);
    assert.equal(fs.existsSync(path.join(beforeCase.runtimeRoot, beforeCase.snapshot.jobId)), false);

    mode = 'after';
    const afterFinalPath = afterCase.snapshot.clips[0].outputPath;
    const afterPromise = coordinator.start(afterCase.snapshot);
    const afterTerminal = await afterPromise;
    assert.equal(afterCancelResult.accepted, true);
    assert.equal(afterRenameObserved, true);
    assertTerminalMatches(afterTerminal, fixture.expectations.terminal.cancelled, afterCase.snapshot);
    assert.equal(fs.existsSync(afterFinalPath), false);
    assert.equal(fs.existsSync(path.join(afterCase.runtimeRoot, afterCase.snapshot.jobId)), false);
  } finally {
    cleanupCase(beforeCase);
    cleanupCase(afterCase);
  }
});

test('clip two failure reports its identity and removes clip one, partial, and runtime artifacts', async () => {
  const testCase = makeCase('s4-clip-two-failure');
  const events = [];
  let calls = 0;

  try {
    const render = async ({ project, outputPath, runtimeChildDir, onProgress }) => {
      calls += 1;
      fs.mkdirSync(path.join(runtimeChildDir, `clip-${calls}`), { recursive: true });
      fs.writeFileSync(path.join(runtimeChildDir, `clip-${calls}`, 'runtime.asset'), 'runtime');
      fs.writeFileSync(outputPath, `candidate-${calls}`);
      onProgress({ progress: 0.5, stage: 'render', message: project.title });
      if (calls === 2) {
        const error = new Error('clip two failed in producer');
        error.code = 'CLIP_TWO_FAILED';
        throw error;
      }
      return { success: true, outputPath };
    };
    const coordinator = createCoordinator(testCase, render, events);
    const terminal = await coordinator.start(testCase.snapshot);

    assertTerminalMatches(terminal, fixture.expectations.terminal.failed, testCase.snapshot);
    assert.equal(terminal.errorCode, 'CLIP_TWO_FAILED');
    assert.match(terminal.message, /clip two failed in producer/);
    assert.equal(calls, 2);
    assert.equal(fs.readdirSync(testCase.outputDir).length, 0);
    assert.equal(fs.existsSync(partialPath(testCase.snapshot.clips[0].outputPath, testCase.snapshot.jobId)), false);
    assert.equal(fs.existsSync(partialPath(testCase.snapshot.clips[1].outputPath, testCase.snapshot.jobId)), false);
    assert.equal(fs.existsSync(path.join(testCase.runtimeRoot, testCase.snapshot.jobId)), false);
    assert.equal(events.filter((event) => event.kind === 'terminal').length, 1);
  } finally {
    cleanupCase(testCase);
  }
});

test('existing final output rejects before rendering and is never overwritten', () => {
  const testCase = makeCase('s4-collision');
  const events = [];
  let producerCalls = 0;

  try {
    const existingPath = testCase.snapshot.clips[0].outputPath;
    fs.writeFileSync(existingPath, 'user-owned output');
    const render = async () => {
      producerCalls += 1;
      throw new Error('producer must not start');
    };
    const coordinator = createCoordinator(testCase, render, events);
    const result = coordinator.start(testCase.snapshot);

    assert.equal(result.success, false);
    assert.equal(result.errorCode, 'OUTPUT_EXISTS');
    assert.equal(producerCalls, 0);
    assert.deepEqual(events, []);
    assert.equal(fs.readFileSync(existingPath, 'utf8'), 'user-owned output');
    assert.equal(fs.existsSync(testCase.runtimeRoot), false);
    assert.equal(coordinator.getActiveJobId(), null);
  } finally {
    cleanupCase(testCase);
  }
});

test('fresh failure and cancellation retries use new controllers and runtimes only after terminal cleanup', async () => {
  const attempts = [
    { jobId: 's4-retry-failure', mode: 'failure' },
    { jobId: 's4-retry-cancel', mode: 'cancel' },
    { jobId: 's4-retry-success', mode: 'success' },
  ];
  const cases = attempts.map(({ jobId }) => makeCase(jobId));
  const events = [];
  const controllers = new Map();
  const runtimeDirs = new Map();
  const observations = [];
  const callCount = new Map();
  let active = 0;
  let maxActive = 0;
  let coordinator;

  try {
    const render = async ({ project, outputPath, runtimeChildDir }) => {
      const jobId = path.basename(runtimeChildDir);
      const count = (callCount.get(jobId) || 0) + 1;
      callCount.set(jobId, count);
      const previous = attempts[attempts.findIndex((attempt) => attempt.jobId === jobId) - 1];
      observations.push({
        jobId,
        previousTerminal: !previous || events.some((event) => event.jobId === previous.jobId && event.kind === 'terminal'),
        previousRuntimeGone: !previous || !fs.existsSync(runtimeDirs.get(previous.jobId)),
      });
      const session = coordinator.getSession(jobId);
      controllers.set(jobId, session.controller);
      runtimeDirs.set(jobId, runtimeChildDir);
      active += 1;
      maxActive = Math.max(maxActive, active);
      try {
        fs.writeFileSync(outputPath, `${jobId}-${count}`);
        if (jobId === 's4-retry-failure') {
          const error = new Error('retry failure');
          error.code = 'RETRY_FAILURE';
          throw error;
        }
        if (jobId === 's4-retry-cancel') {
          coordinator.cancel({ jobId });
        }
        return { success: true, outputPath };
      } finally {
        active -= 1;
      }
    };
    coordinator = createCoordinator(cases[0], render, events);
    const firstTerminal = await coordinator.start(cases[0].snapshot);
    assert.equal(firstTerminal.state, 'failed');
    assert.equal(coordinator.getSession(attempts[0].jobId), undefined);
    assert.equal(fs.existsSync(runtimeDirs.get(attempts[0].jobId)), false);

    const secondTerminal = await coordinator.start(cases[1].snapshot);
    assert.equal(secondTerminal.state, 'cancelled');
    assert.equal(coordinator.getSession(attempts[1].jobId), undefined);
    assert.equal(fs.existsSync(runtimeDirs.get(attempts[1].jobId)), false);

    const thirdTerminal = await coordinator.start(cases[2].snapshot);
    assertTerminalMatches(thirdTerminal, fixture.expectations.terminal.succeeded, cases[2].snapshot);
    assert.equal(coordinator.getSession(attempts[2].jobId), undefined);
    assert.equal(fs.existsSync(runtimeDirs.get(attempts[2].jobId)), false);
    assert.equal(fs.existsSync(cases[2].snapshot.clips[0].outputPath), true);
    assert.equal(fs.existsSync(cases[2].snapshot.clips[1].outputPath), true);

    assert.equal(maxActive, 1);
    assert.deepEqual(observations, [
      { jobId: 's4-retry-failure', previousTerminal: true, previousRuntimeGone: true },
      { jobId: 's4-retry-cancel', previousTerminal: true, previousRuntimeGone: true },
      { jobId: 's4-retry-success', previousTerminal: true, previousRuntimeGone: true },
      { jobId: 's4-retry-success', previousTerminal: true, previousRuntimeGone: true },
    ]);
    assert.notEqual(controllers.get('s4-retry-failure'), controllers.get('s4-retry-cancel'));
    assert.notEqual(controllers.get('s4-retry-cancel'), controllers.get('s4-retry-success'));
    assert.notEqual(runtimeDirs.get('s4-retry-failure'), runtimeDirs.get('s4-retry-cancel'));
    assert.notEqual(runtimeDirs.get('s4-retry-cancel'), runtimeDirs.get('s4-retry-success'));
  } finally {
    cases.forEach(cleanupCase);
  }
});
test('terminal waits for session cleanup before releasing registry ownership', async () => {
  const testCase = makeCase('s4-cleanup-boundary');
  const events = [];
  const cleanupStarted = deferred();
  const cleanupRelease = deferred();
  let coordinator;

  try {
    const render = async ({ outputPath, runtimeChildDir }) => {
      fs.writeFileSync(outputPath, 'successful output');
      fs.writeFileSync(path.join(runtimeChildDir, 'runtime.asset'), 'runtime');
      return { success: true, outputPath };
    };
    coordinator = createCoordinator(testCase, render, events, {
      cleanupSession: async ({ runtimeDir, preserveOutputs }) => {
        assert.equal(preserveOutputs, true);
        assert.equal(coordinator.getSession(testCase.snapshot.jobId).state, 'succeeded');
        cleanupStarted.resolve();
        await cleanupRelease.promise;
        fs.rmSync(runtimeDir, { recursive: true, force: true });
      },
    });

    const exportPromise = coordinator.start(testCase.snapshot);
    await cleanupStarted.promise;

    const sessionDuringCleanup = coordinator.getSession(testCase.snapshot.jobId);
    assert.ok(sessionDuringCleanup);
    assert.equal(sessionDuringCleanup.state, 'succeeded');
    assert.ok(sessionDuringCleanup.controller instanceof AbortController);
    assert.equal(coordinator.getActiveJobId(), testCase.snapshot.jobId);
    assert.equal(events.filter((event) => event.kind === 'terminal').length, 0);

    cleanupRelease.resolve();
    const terminal = await exportPromise;
    assertTerminalMatches(terminal, fixture.expectations.terminal.succeeded, testCase.snapshot);
    assert.equal(events.filter((event) => event.kind === 'terminal').length, 1);
    assert.equal(coordinator.getSession(testCase.snapshot.jobId), undefined);
    assert.equal(coordinator.getActiveJobId(), null);
    assert.equal(fs.existsSync(path.join(testCase.runtimeRoot, testCase.snapshot.jobId)), false);
    assert.equal(fs.existsSync(testCase.snapshot.clips[0].outputPath), true);
    assert.equal(fs.existsSync(testCase.snapshot.clips[1].outputPath), true);
  } finally {
    cleanupRelease.resolve();
    cleanupCase(testCase);
  }
});
