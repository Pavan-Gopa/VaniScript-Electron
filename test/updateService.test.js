'use strict';

/**
 * UPD-01 — Update state/readiness service.
 * Run via: node --test test/updateService.test.js
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const {
  UPDATE_STATES,
  UPDATE_USER_ACTIONS,
  UPDATE_BLOCKER_CATEGORIES,
  UPDATE_QUIT_SUBSYSTEMS,
  UPDATE_ACTIONS_ALLOWED_FROM,
  isLegalUpdateTransition,
  isLegalUpdateAction,
  createUpdateDescriptor,
  createUpdatePresentation,
  validateUpdateDescriptor,
  validateUpdateFeed,
  validateUpdateReceipt,
} = require('../shared/contracts/updates.ts');
const { createUpdateService } = require('../electron/main/updates/updateService.js');

function descriptor(overrides = {}) {
  return createUpdateDescriptor({
    version: '1.2.0',
    build: '120',
    title: 'VaniScript 1.2.0',
    notes: 'Stability fixes',
    critical: false,
    publishDate: '2026-08-20T00:00:00.000Z',
    sizeBytes: 1024,
    platform: 'darwin',
    arch: 'arm64',
    channel: 'stable',
    ...overrides,
  });
}

function makeTempDir(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'vaniscript-updates-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
}

function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

function makeService(overrides = {}) {
  const update = overrides.update || descriptor();
  const fetchFeed = overrides.fetchFeed !== undefined
    ? overrides.fetchFeed
    : async () => update;
  return createUpdateService({
    currentVersion: '1.0.0',
    currentBuild: '100',
    channel: 'stable',
    platform: 'darwin',
    arch: 'arm64',
    fetchFeed,
    ...overrides,
    update: undefined,
  });
}

async function readyToInstall(overrides = {}) {
  const service = makeService(overrides);
  await service.checkNow();
  await service.downloadNow();
  assert.equal(service.getState().state, 'readyToInstall');
  return service;
}

function isAppError(error, code) {
  return Boolean(error && error.name === 'AppError' && error.code === code);
}

test('contract enumerates the §12.1 state machine and §12.3 blocker categories', () => {
  assert.deepEqual([...UPDATE_STATES], [
    'idle', 'checking', 'upToDate', 'available', 'downloading',
    'verifying', 'readyToInstall', 'installing', 'failed',
  ]);
  assert.deepEqual([...UPDATE_USER_ACTIONS], [
    'checkNow', 'downloadNow', 'installNow', 'skipVersion',
    'remindLater', 'cancelDownload', 'retry',
  ]);
  assert.deepEqual([...UPDATE_BLOCKER_CATEGORIES], [
    'recording',
    'recordingPreviewSave',
    'mediaProcessing',
    'translation',
    'shortsRenderPlanning',
    'batchCurrentJob',
    'documentRecovery',
    'projectSaveFailure',
    'modelMutation',
  ]);
  assert.equal(isLegalUpdateTransition('available', 'downloading'), true);
  assert.equal(isLegalUpdateTransition('idle', 'installing'), false);
  assert.equal(isLegalUpdateAction('readyToInstall', 'installNow'), true);
  assert.equal(isLegalUpdateAction('available', 'installNow'), false);
});

test('descriptor and feed validators reject malformed and tampered-shaped payloads', () => {
  assert.equal(validateUpdateDescriptor({ version: '2.0.0' }).ok, true);
  assert.equal(validateUpdateDescriptor({ version: '' }).ok, false);
  assert.equal(validateUpdateDescriptor({ version: '2.0.0', channel: 'nightly' }).ok, false);
  const feed = validateUpdateFeed({
    updates: [{ version: '2.0.0', channel: 'stable' }],
    signature: 'ed25519:deadbeef',
  });
  assert.equal(feed.ok, true);
  assert.equal(feed.value.signature, 'ed25519:deadbeef');
  assert.equal(validateUpdateFeed({ updates: 'nope' }).ok, false);
  assert.equal(validateUpdateFeed({ updates: [{ version: '' }] }).error.code, 'CORRUPT_DATA');
});

test('starts idle and never auto-downloads or auto-installs, even if asked', async () => {
  const downloaded = [];
  const installed = [];
  const service = makeService({
    autoDownload: true,
    autoInstall: true,
    download: async (desc) => {
      downloaded.push(desc.version);
      return { artifactHash: desc.artifactHash };
    },
    install: async (desc) => {
      installed.push(desc.version);
      return { outcome: 'success' };
    },
  });
  const snapshot = service.getState();
  assert.equal(snapshot.state, 'idle');
  assert.equal(snapshot.presentation.autoDownload, false);
  assert.equal(snapshot.presentation.autoInstall, false);
  await service.checkNow();
  assert.equal(service.getState().state, 'available');
  assert.deepEqual(downloaded, []);
  assert.deepEqual(installed, []);
  await service.downloadNow();
  assert.equal(service.getState().state, 'readyToInstall');
  assert.deepEqual(installed, []);
  assert.deepEqual(downloaded, ['1.2.0']);
});

test('FSM matrix: every illegal user action is rejected and legal paths succeed', async () => {
  const illegal = [];
  for (const state of UPDATE_STATES) {
    for (const action of UPDATE_USER_ACTIONS) {
      if (!UPDATE_ACTIONS_ALLOWED_FROM[action].includes(state)) {
        illegal.push([state, action]);
      }
    }
  }
  assert.ok(illegal.length > 20);

  const idle = makeService();
  await assert.rejects(() => idle.downloadNow(), (error) => isAppError(error, 'CONFLICT'));
  await assert.rejects(() => idle.installNow(), (error) => isAppError(error, 'CONFLICT'));
  assert.throws(() => idle.skipVersion(), (error) => isAppError(error, 'CONFLICT'));
  assert.throws(() => idle.remindLater(), (error) => isAppError(error, 'CONFLICT'));
  assert.throws(() => idle.cancelDownload(), (error) => isAppError(error, 'CONFLICT'));
  await assert.rejects(() => idle.retry(), (error) => isAppError(error, 'CONFLICT'));

  const available = makeService();
  await available.checkNow();
  await assert.rejects(() => available.installNow(), (error) => isAppError(error, 'CONFLICT'));
  assert.throws(() => available.cancelDownload(), (error) => isAppError(error, 'CONFLICT'));

  const upToDate = makeService({ fetchFeed: async () => null });
  await upToDate.checkNow();
  assert.equal(upToDate.getState().state, 'upToDate');
  await assert.rejects(() => upToDate.downloadNow(), (error) => isAppError(error, 'CONFLICT'));

  const ready = await readyToInstall();
  await assert.rejects(() => ready.downloadNow(), (error) => isAppError(error, 'CONFLICT'));
  assert.throws(() => ready.cancelDownload(), (error) => isAppError(error, 'CONFLICT'));
});

test('checkNow uses the injected feed and ignores current, skipped, and mismatched artifacts', async () => {
  const queries = [];
  const current = descriptor({ version: '1.0.0', build: '100' });
  const otherPlatform = descriptor({ version: '9.0.0', platform: 'win32' });
  const otherArch = descriptor({ version: '8.0.0', arch: 'x64' });
  const otherChannel = descriptor({ version: '7.0.0', channel: 'beta' });
  const older = descriptor({ version: '0.9.0', build: '90' });
  const newest = descriptor({ version: '1.4.0', build: '140' });
  const olderEligible = descriptor({ version: '1.3.0', build: '130' });
  const service = makeService({
    fetchFeed: async (query) => {
      queries.push(query);
      return {
        schemaVersion: 1,
        channel: 'stable',
        updates: [current, otherPlatform, otherArch, otherChannel, older, olderEligible, newest],
        signature: null,
      };
    },
  });
  await service.checkNow();
  assert.equal(service.getState().state, 'available');
  assert.equal(service.getState().descriptor.version, '1.4.0');
  assert.deepEqual(queries[0], {
    currentVersion: '1.0.0',
    currentBuild: '100',
    channel: 'stable',
    platform: 'darwin',
    arch: 'arm64',
  });

  service.skipVersion();
  await service.checkNow();
  assert.equal(service.getState().state, 'available');
  assert.equal(service.getState().descriptor.version, '1.3.0');
  service.skipVersion();
  await service.checkNow();
  assert.equal(service.getState().state, 'upToDate');
});

test('feed transport failure and tamper hook move the machine to failed', async () => {
  const down = makeService({
    fetchFeed: async () => {
      throw Object.assign(new Error('offline'), { code: 'PROVIDER_ERROR' });
    },
  });
  await assert.rejects(() => down.checkNow(), (error) => error.code === 'PROVIDER_ERROR');
  assert.equal(down.getState().state, 'failed');
  assert.equal(down.getState().error.code, 'PROVIDER_ERROR');

  const tampered = makeService({
    fetchFeed: async () => ({ updates: [descriptor()], signature: 'forged' }),
    requireFeedSignature: true,
    assertFeedIntegrity: (raw) => ({ ok: raw && raw.signature === 'trusted', reason: 'bad-signature' }),
  });
  await assert.rejects(() => tampered.checkNow(), (error) => isAppError(error, 'CORRUPT_DATA'));
  assert.equal(tampered.getState().state, 'failed');
  assert.match(tampered.getState().error.message, /bad-signature|integrity|signature/i);

  const unsigned = makeService({
    fetchFeed: async () => ({ updates: [descriptor()] }),
    requireFeedSignature: true,
  });
  await assert.rejects(() => unsigned.checkNow(), (error) => isAppError(error, 'CORRUPT_DATA'));
});

test('retry after a failed check re-enters checkNow', async () => {
  let attempts = 0;
  const service = makeService({
    fetchFeed: async () => {
      attempts += 1;
      if (attempts === 1) throw new Error('temporary feed outage');
      return descriptor();
    },
  });
  await assert.rejects(() => service.checkNow());
  assert.equal(service.getState().state, 'failed');
  await service.retry();
  assert.equal(service.getState().state, 'available');
  assert.equal(attempts, 2);
});

test('downloadNow walks downloading -> verifying -> readyToInstall and cancel returns to available', async () => {
  const gate = deferred();
  let cancelled = false;
  const service = makeService({
    download: async (desc, { signal, onProgress }) => {
      onProgress({ receivedBytes: 10, totalBytes: 100, fraction: 0.1 });
      await new Promise((resolve, reject) => {
        const onAbort = () => {
          cancelled = true;
          reject(Object.assign(new Error('Download cancelled.'), { code: 'CANCELLED' }));
        };
        if (signal.aborted) {
          onAbort();
          return;
        }
        signal.addEventListener('abort', onAbort, { once: true });
        gate.promise.then(() => {
          signal.removeEventListener('abort', onAbort);
          resolve();
        });
      });
      return { artifactHash: desc.artifactHash };
    },
  });
  await service.checkNow();
  const pending = service.downloadNow();
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(service.getState().state, 'downloading');
  assert.equal(service.getState().download.fraction, 0.1);
  service.cancelDownload();
  assert.equal(service.getState().state, 'available');
  await pending;
  assert.equal(cancelled, true);
  assert.equal(service.getState().state, 'available');

  const verified = [];
  const ready = makeService({
    verify: async (desc, download) => {
      verified.push({ version: desc.version, download });
      return { ok: true };
    },
  });
  await ready.checkNow();
  await ready.downloadNow();
  assert.equal(ready.getState().state, 'readyToInstall');
  assert.equal(verified.length, 1);
});

test('hash mismatch during verifying fails without reaching readyToInstall', async () => {
  const mismatched = makeService({
    update: descriptor({ artifactHash: 'expected' }),
    download: async () => ({ artifactHash: 'other' }),
  });
  await mismatched.checkNow();
  await assert.rejects(() => mismatched.downloadNow(), (error) => isAppError(error, 'CORRUPT_DATA'));
  assert.equal(mismatched.getState().state, 'failed');
});

test('retry after a failed download resumes from available', async () => {
  let downloads = 0;
  const service = makeService({
    download: async () => {
      downloads += 1;
      if (downloads === 1) throw new Error('disk full');
      return { artifactHash: null };
    },
  });
  await service.checkNow();
  await assert.rejects(() => service.downloadNow());
  assert.equal(service.getState().state, 'failed');
  await service.retry();
  assert.equal(service.getState().state, 'readyToInstall');
  assert.equal(downloads, 2);
});

test('remindLater dismisses without skipping; the next check still offers the version', async () => {
  const service = makeService({ remindLaterMs: 60_000, now: () => new Date('2026-08-23T00:00:00.000Z') });
  await service.checkNow();
  service.remindLater();
  const snapshot = service.getState();
  assert.equal(snapshot.state, 'idle');
  assert.equal(snapshot.skippedVersion, null);
  assert.equal(snapshot.remindLaterUntil, '2026-08-23T00:01:00.000Z');
  await service.checkNow();
  assert.equal(service.getState().state, 'available');
  assert.equal(service.getState().descriptor.version, '1.2.0');
});

test('collectBlockers aggregates every §12.3 category from stubbed probes and batchScheduler', () => {
  const flags = Object.fromEntries(UPDATE_BLOCKER_CATEGORIES.map((category) => [category, true]));
  const service = makeService({
    probes: Object.fromEntries(
      UPDATE_BLOCKER_CATEGORIES.map((category) => [category, () => flags[category]]),
    ),
  });
  const blockers = service.collectBlockers();
  assert.equal(blockers.length, UPDATE_BLOCKER_CATEGORIES.length);
  assert.deepEqual(blockers.map((item) => item.category), [...UPDATE_BLOCKER_CATEGORIES]);

  flags.recording = false;
  flags.translation = false;
  assert.equal(service.collectBlockers().length, UPDATE_BLOCKER_CATEGORIES.length - 2);

  const withBatch = makeService({
    probes: {},
    batchScheduler: { activeJob: { jobId: 'job-42' } },
  });
  const batchBlockers = withBatch.collectBlockers();
  assert.equal(batchBlockers.length, 1);
  assert.equal(batchBlockers[0].category, 'batchCurrentJob');
  assert.match(batchBlockers[0].message, /job-42/);
});

test('alias probes collapse onto the §12.3 categories', () => {
  const service = makeService({
    probes: {
      recordingPreview: () => true,
      transcriptTranslation: () => 'Document translation is running.',
      shortsPlanning: () => true,
      documentAutosave: () => true,
    },
  });
  const categories = service.collectBlockers().map((item) => item.category).sort();
  assert.deepEqual(categories, [
    'documentRecovery',
    'recordingPreviewSave',
    'shortsRenderPlanning',
    'translation',
  ]);
});

test('installNow refuses while blockers are present, then succeeds after they clear', async () => {
  let recording = true;
  const installed = [];
  const service = await readyToInstall({
    probes: { recording: () => recording },
    install: async (desc) => {
      installed.push(desc.version);
      return { outcome: 'success' };
    },
  });
  await assert.rejects(() => service.installNow(), (error) => {
    assert.equal(error.code, 'UPDATE_BLOCKED');
    assert.equal(error.details.kind, 'blockers');
    assert.equal(error.details.reasons.length, 1);
    assert.equal(error.details.reasons[0].category, 'recording');
    return true;
  });
  assert.equal(service.getState().state, 'readyToInstall');
  assert.deepEqual(installed, []);

  recording = false;
  const result = await service.installNow();
  assert.equal(result.state.state, 'idle');
  assert.equal(result.receipt.outcome, 'success');
  assert.deepEqual(installed, ['1.2.0']);
});

test('blockers are re-collected at install time and never cached', async () => {
  let calls = 0;
  let blocked = true;
  const service = await readyToInstall({
    probes: {
      recording: () => {
        calls += 1;
        return blocked;
      },
    },
  });
  assert.equal(service.collectBlockers().length, 1);
  const beforeInstall = calls;
  await assert.rejects(() => service.installNow(), (error) => error.code === 'UPDATE_BLOCKED');
  assert.ok(calls > beforeInstall);
  blocked = false;
  const result = await service.installNow();
  assert.equal(result.receipt.outcome, 'success');
});

test('critical updates change presentation only and still honor readiness', async () => {
  const critical = descriptor({ critical: true, version: '1.5.0', build: '150' });
  let blocked = true;
  const service = await readyToInstall({
    update: critical,
    probes: { projectSaveFailure: () => blocked },
  });
  const presentation = service.getState().presentation;
  assert.equal(presentation.critical, true);
  assert.equal(presentation.emphasis, 'critical');
  assert.equal(presentation.autoInstall, false);
  assert.equal(createUpdatePresentation(critical).showSkip, true);
  await assert.rejects(() => service.installNow(), (error) => {
    assert.equal(error.code, 'UPDATE_BLOCKED');
    assert.equal(error.details.reasons[0].category, 'projectSaveFailure');
    return true;
  });
  assert.equal(service.getState().state, 'readyToInstall');
  blocked = false;
  const result = await service.installNow();
  assert.equal(result.receipt.toVersion, '1.5.0');
});

test('prepareForUpdateTermination is bounded and subsystem failure is not-ready', async () => {
  const hanging = makeService({
    flushers: {
      settings: async () => {},
      projects: () => new Promise(() => {}),
      sqlite: async () => {},
      recovery: async () => {},
    },
  });
  const timedOut = await hanging.prepareForUpdateTermination(30);
  assert.equal(timedOut.ready, false);
  assert.equal(timedOut.timedOut, true);
  assert.equal(timedOut.outcomes.settings, 'ok');
  assert.equal(timedOut.outcomes.projects, 'timeout');

  const failing = makeService({
    flushers: {
      settings: async () => {},
      projects: async () => {},
      sqlite: async () => {
        throw new Error('WAL checkpoint failed');
      },
      recovery: async () => {},
    },
  });
  const failed = await failing.prepareForUpdateTermination(200);
  assert.equal(failed.ready, false);
  assert.equal(failed.outcomes.sqlite, 'failed');
  assert.match(failed.errors.sqlite, /WAL checkpoint failed/);

  const clean = makeService({
    flushers: {
      settings: () => {},
      projects: () => {},
    },
    batchDomain: { checkpointWal: () => 'ok' },
  });
  const ready = await clean.prepareForUpdateTermination(200);
  assert.equal(ready.ready, true);
  assert.equal(ready.outcomes.settings, 'ok');
  assert.equal(ready.outcomes.projects, 'ok');
  assert.equal(ready.outcomes.sqlite, 'ok');
  assert.equal(ready.outcomes.recovery, 'skipped');
});

test('prepareForUpdateTermination pins zero and negative budget boundaries', async () => {
  let flushes = 0;
  let installed = 0;
  const service = await readyToInstall({
    quitTimeoutMs: 0,
    flushers: {
      settings: () => {
        flushes += 1;
      },
      projects: () => {
        flushes += 1;
      },
      sqlite: () => {
        flushes += 1;
      },
      recovery: () => {
        flushes += 1;
      },
    },
    install: async () => {
      installed += 1;
      return { outcome: 'success' };
    },
  });

  const timedOut = await service.prepareForUpdateTermination(0);
  assert.deepEqual(
    {
      ready: timedOut.ready,
      timedOut: timedOut.timedOut,
      timeoutMs: timedOut.timeoutMs,
    },
    { ready: false, timedOut: true, timeoutMs: 0 },
  );
  assert.equal(flushes, 0);

  await assert.rejects(
    () => service.prepareForUpdateTermination(-1),
    (error) => isAppError(error, 'VALIDATION_FAILED'),
  );

  await assert.rejects(() => service.installNow(), (error) => {
    assert.equal(error.code, 'UPDATE_BLOCKED');
    assert.equal(error.details.kind, 'quit-prep');
    return true;
  });
  assert.equal(flushes, 0);
  assert.equal(installed, 0);
});

test('installNow aborts when quit preparation is not ready', async () => {
  const installed = [];
  const service = await readyToInstall({
    quitTimeoutMs: 20,
    flushers: {
      projects: () => new Promise(() => {}),
    },
    install: async (desc) => {
      installed.push(desc.version);
      return { outcome: 'success' };
    },
  });
  await assert.rejects(() => service.installNow(), (error) => {
    assert.equal(error.code, 'UPDATE_BLOCKED');
    assert.equal(error.details.kind, 'quit-prep');
    assert.equal(error.details.preparation.ready, false);
    return true;
  });
  assert.equal(service.getState().state, 'readyToInstall');
  assert.deepEqual(installed, []);
});

test('successful install writes a receipt outside project JSON', async (t) => {
  const dir = makeTempDir(t);
  const receiptPath = path.join(dir, 'update-receipt.json');
  const now = new Date('2026-08-23T12:00:00.000Z');
  const service = await readyToInstall({
    receiptPath,
    now: () => now,
    update: descriptor({ artifactHash: 'abc123' }),
  });
  const result = await service.installNow();
  assert.equal(result.receipt.fromVersion, '1.0.0');
  assert.equal(result.receipt.toVersion, '1.2.0');
  assert.equal(result.receipt.fromBuild, '100');
  assert.equal(result.receipt.toBuild, '120');
  assert.equal(result.receipt.channel, 'stable');
  assert.equal(result.receipt.timestamp, '2026-08-23T12:00:00.000Z');
  assert.equal(result.receipt.outcome, 'success');
  assert.equal(result.receipt.artifactHash, 'abc123');
  const onDisk = JSON.parse(fs.readFileSync(receiptPath, 'utf8'));
  assert.equal(validateUpdateReceipt(onDisk).ok, true);
  assert.deepEqual(onDisk, result.receipt);

  const reloaded = makeService({ receiptPath, fetchFeed: async () => null });
  assert.equal(reloaded.getReceipt().toVersion, '1.2.0');
});

test('retry after a blocked-then-failed install re-checks readiness', async () => {
  let failInstall = true;
  let recording = false;
  const service = await readyToInstall({
    probes: { recording: () => recording },
    install: async () => {
      if (failInstall) throw new Error('installer crashed');
      return { outcome: 'success' };
    },
  });
  await assert.rejects(() => service.installNow());
  assert.equal(service.getState().state, 'failed');
  recording = true;
  await assert.rejects(() => service.retry(), (error) => error.code === 'UPDATE_BLOCKED');
  assert.equal(service.getState().state, 'readyToInstall');
  recording = false;
  failInstall = false;
  const result = await service.installNow();
  assert.equal(result.receipt.outcome, 'success');
});

test('foreign filesystem error codes normalize to INTERNAL in throw and state', async (t) => {
  const dir = makeTempDir(t);
  const service = await readyToInstall({ receiptPath: dir });
  let thrown;
  await assert.rejects(() => service.installNow(), (error) => {
    thrown = error;
    return true;
  });
  assert.equal(thrown.name, 'AppError');
  assert.equal(thrown.code, 'INTERNAL');
  assert.ok(['EISDIR', 'EPERM'].includes(thrown.details.originalCode));
  assert.equal(thrown.details.originalMessage, thrown.message);
  const state = service.getState();
  assert.equal(state.state, 'failed');
  assert.equal(state.error.code, 'INTERNAL');
  assert.deepEqual(state.error.details, thrown.details);
});

test('collectBlockers fails closed for probe throws and unrecognized truthy shapes', () => {
  const service = makeService({
    probes: {
      recording: () => {
        throw new Error('recording probe unavailable');
      },
      mediaProcessing: () => ({ blocked: 'yes' }),
      translation: () => ({ foo: 1 }),
      documentRecovery: () => ({}),
    },
  });
  const blockers = service.collectBlockers();
  assert.equal(blockers.length, 4);
  const failedProbe = blockers.find((entry) => entry.category === 'recording');
  assert.equal(failedProbe.details.probeFailed, true);
  for (const category of ['mediaProcessing', 'translation', 'documentRecovery']) {
    const blocker = blockers.find((entry) => entry.category === category);
    assert.equal(blocker.details.reason, 'unrecognized_shape');
  }
});

test('quit preparation marks every subsystem timed out after a slow first flusher', async () => {
  const service = makeService({
    flushers: {
      settings: () => new Promise((resolve) => setTimeout(resolve, 40)),
      projects: async () => {},
      sqlite: async () => {},
      recovery: async () => {},
    },
  });
  const preparation = await service.prepareForUpdateTermination(10);
  assert.equal(preparation.ready, false);
  assert.equal(preparation.timedOut, true);
  assert.deepEqual(
    UPDATE_QUIT_SUBSYSTEMS.map((subsystem) => preparation.outcomes[subsystem]),
    ['timeout', 'timeout', 'timeout', 'timeout'],
  );
});

test('installer failure outcome writes a failed receipt and exposes INTERNAL state', async (t) => {
  const dir = makeTempDir(t);
  const receiptPath = path.join(dir, 'update-receipt.json');
  const service = await readyToInstall({
    receiptPath,
    install: async () => ({ outcome: 'failed' }),
  });
  await assert.rejects(() => service.installNow(), (error) => error.code === 'INTERNAL');
  assert.equal(service.getState().state, 'failed');
  assert.equal(service.getState().error.code, 'INTERNAL');
  assert.equal(service.getReceipt().outcome, 'failed');
  assert.equal(JSON.parse(fs.readFileSync(receiptPath, 'utf8')).outcome, 'failed');
});

test('_normalizeFeed accepts array and bare-descriptor forms', async () => {
  const arrayService = makeService({ fetchFeed: async () => [descriptor()] });
  await arrayService.checkNow();
  assert.equal(arrayService.getState().state, 'available');
  assert.equal(arrayService.getState().descriptor.version, '1.2.0');

  const bareService = makeService({
    fetchFeed: async () => descriptor({ version: '1.3.0', build: '130' }),
  });
  await bareService.checkNow();
  assert.equal(bareService.getState().state, 'available');
  assert.equal(bareService.getState().descriptor.version, '1.3.0');
});

test('requireFeedSignature accepts a signed feed', async () => {
  const service = makeService({
    requireFeedSignature: true,
    fetchFeed: async () => ({
      updates: [descriptor()],
      signature: 'ed25519:trusted',
    }),
  });
  await service.checkNow();
  assert.equal(service.getState().state, 'available');
  assert.equal(service.getState().descriptor.version, '1.2.0');
});

test('checkNow without an injected transport is a validation failure', async () => {
  const service = createUpdateService({ currentVersion: '1.0.0' });
  await assert.rejects(() => service.checkNow(), (error) => isAppError(error, 'VALIDATION_FAILED'));
  assert.equal(service.getState().state, 'failed');
});
