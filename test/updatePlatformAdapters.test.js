'use strict';

/**
 * UPD-02 — Platform feed, verification, target matching, and Linux policy.
 * Run via: node --test test/updatePlatformAdapters.test.js
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');

const {
  createUpdateDescriptor,
} = require('../shared/contracts/updates.ts');
const {
  createPlatformAdapter,
  createPlatformUpdateService,
  normalizeFeedForService,
} = require('../electron/main/updates/platformAdapters.js');

const PLATFORM_CASES = [
  { platform: 'darwin', arch: 'arm64', artifactType: 'zip', signature: 'signed-darwin' },
  { platform: 'win32', arch: 'x64', artifactType: 'nsis-web', signature: 'signed-win32' },
  { platform: 'linux', arch: 'x64', artifactType: 'appimage', signature: 'signed-linux' },
];

function descriptor(platform, arch, artifactType, overrides = {}) {
  return createUpdateDescriptor({
    version: '1.2.0',
    build: '120',
    title: 'VaniScript 1.2.0',
    notes: 'Platform update',
    sizeBytes: 10,
    platform,
    arch,
    channel: 'stable',
    artifactType,
    artifactHash: `sha256-${platform}-${artifactType}`,
    ...overrides,
  });
}

function makeAdapter({
  platform,
  arch,
  artifactType,
  signature,
  update = descriptor(platform, arch, artifactType),
  verifyFeedSignature = (feed, actualSignature) => feed.signature === signature && actualSignature === signature,
  verifyArtifact = (candidate, result) => result.artifactHash === candidate.artifactHash,
  install,
  probes,
  flushers,
} = {}) {
  return createPlatformAdapter({
    platform,
    arch,
    channel: 'stable',
    fetchFeed: async () => ({ updates: [update], signature }),
    download: async (candidate) => ({ artifactHash: candidate.artifactHash }),
    verifyFeedSignature,
    verifyArtifact,
    install: install || (async () => ({ outcome: 'success' })),
    probes,
    flushers,
  });
}

function makeServiceForCase(item, overrides = {}) {
  const adapter = makeAdapter({ ...item, ...overrides });
  const service = adapter.createUpdateService({
    currentVersion: '1.0.0',
    currentBuild: '100',
    probes: overrides.probes,
    flushers: overrides.flushers,
  });
  return { adapter, service };
}

function isAppError(error, code) {
  return Boolean(error && error.name === 'AppError' && error.code === code);
}
function sha256(bytes) {
  return `sha256:${crypto.createHash('sha256').update(bytes).digest('hex')}`;
}

for (const item of PLATFORM_CASES) {
  test(`${item.platform} accepts a valid signed feed and records the verified artifact hash`, async () => {
    const order = [];
    const { adapter, service } = makeServiceForCase(item, {
      verifyFeedSignature: (feed, actualSignature) => {
        order.push('feed-signature');
        return feed.signature === item.signature && actualSignature === item.signature;
      },
      verifyArtifact: (candidate, result) => {
        order.push('artifact-verification');
        return result.artifactHash === candidate.artifactHash;
      },
      install: async (candidate) => {
        order.push(`install:${candidate.artifactType}`);
        return { outcome: 'success' };
      },
    });

    assert.equal(adapter.platform, item.platform);
    assert.equal(adapter.arch, item.arch);
    await service.checkNow();
    await service.downloadNow();
    assert.equal(service.getState().state, 'readyToInstall');
    const result = await service.installNow();

    assert.deepEqual(order, ['feed-signature', 'artifact-verification', `install:${item.artifactType}`]);
    assert.equal(result.receipt.outcome, 'success');
    assert.equal(result.receipt.artifactHash, item.updateArtifactHash || `sha256-${item.platform}-${item.artifactType}`);
    assert.equal(service.getState().state, 'idle');
  });
}

test('tampered feed payload/signature is rejected as TAMPERED before download or install', async () => {
  let downloaded = 0;
  let installed = 0;
  const item = PLATFORM_CASES[0];
  const update = descriptor(item.platform, item.arch, item.artifactType);
  const adapter = createPlatformAdapter({
    platform: item.platform,
    arch: item.arch,
    fetchFeed: async () => ({ updates: [update], payload: 'mutated', signature: 'forged' }),
    verifyFeedSignature: (feed, signature) => feed.payload === 'original' && signature === 'trusted',
    download: async () => {
      downloaded += 1;
      return { artifactHash: update.artifactHash };
    },
    install: async () => {
      installed += 1;
      return { outcome: 'success' };
    },
  });
  const service = adapter.createUpdateService({ currentVersion: '1.0.0', currentBuild: '100' });

  await assert.rejects(() => service.checkNow(), (error) => isAppError(error, 'TAMPERED'));
  assert.equal(service.getState().state, 'failed');
  assert.equal(downloaded, 0);
  assert.equal(installed, 0);
});

test('unsigned feeds fail closed as TAMPERED before any download', async () => {
  const item = PLATFORM_CASES[2];
  const update = descriptor(item.platform, item.arch, item.artifactType);
  let downloaded = 0;
  const adapter = createPlatformAdapter({
    platform: item.platform,
    arch: item.arch,
    fetchFeed: async () => ({ updates: [update] }),
    verifyFeedSignature: () => true,
    download: async () => {
      downloaded += 1;
      return { artifactHash: update.artifactHash };
    },
  });
  const service = adapter.createUpdateService({ currentVersion: '1.0.0', currentBuild: '100' });

  await assert.rejects(() => service.checkNow(), (error) => isAppError(error, 'TAMPERED'));
  assert.equal(downloaded, 0);
});

test('tampered artifact signature/hash is rejected before install', async () => {
  const item = PLATFORM_CASES[1];
  let installed = 0;
  const { service } = makeServiceForCase(item, {
    verifyArtifact: () => ({ ok: false, reason: 'Authenticode signature mismatch' }),
    install: async () => {
      installed += 1;
      return { outcome: 'success' };
    },
  });

  await service.checkNow();
  await assert.rejects(() => service.downloadNow(), (error) => isAppError(error, 'TAMPERED'));
  assert.equal(service.getState().state, 'failed');
  assert.equal(installed, 0);
});

test('artifact bytes outrank a lying declared hash', async () => {
  const item = PLATFORM_CASES[0];
  const trustedBytes = Buffer.from('trusted artifact');
  const expectedHash = sha256(trustedBytes);
  const update = descriptor(item.platform, item.arch, item.artifactType, {
    artifactHash: expectedHash,
  });
  const adapter = makeAdapter({
    ...item,
    update,
    verifyArtifact: () => true,
  });

  await assert.rejects(
    () => adapter.verify(update, {
      artifact: Buffer.from('tampered artifact'),
      artifactHash: expectedHash,
    }),
    (error) => isAppError(error, 'TAMPERED'),
  );
});

test('honest artifact bytes are hashed when the result omits a declared hash', async () => {
  const item = PLATFORM_CASES[0];
  const trustedBytes = Buffer.from('trusted artifact');
  const expectedHash = sha256(trustedBytes);
  const update = descriptor(item.platform, item.arch, item.artifactType, {
    artifactHash: expectedHash,
  });
  const adapter = makeAdapter({
    ...item,
    update,
    verifyArtifact: () => true,
  });

  const verification = await adapter.verify(update, { artifact: trustedBytes });
  assert.equal(verification.ok, true);
  assert.equal(verification.artifactHash, expectedHash);
});

test('byte-level hash mismatch is rejected even without a declared result hash', async () => {
  const item = PLATFORM_CASES[2];
  const expectedHash = sha256(Buffer.from('trusted artifact'));
  const update = descriptor(item.platform, item.arch, item.artifactType, {
    artifactHash: expectedHash,
  });
  const adapter = makeAdapter({
    ...item,
    update,
    verifyArtifact: () => true,
  });

  await assert.rejects(
    () => adapter.verify(update, { artifact: Buffer.from('corrupt artifact') }),
    (error) => isAppError(error, 'TAMPERED'),
  );
});

test('hashless artifact without a verification hook fails closed', async () => {
  const item = PLATFORM_CASES[1];
  const update = descriptor(item.platform, item.arch, item.artifactType, { artifactHash: null });
  const adapter = makeAdapter({
    ...item,
    update,
    verifyArtifact: null,
  });

  await assert.rejects(
    () => adapter.verify(update, { artifact: Buffer.from('unverified artifact') }),
    (error) => {
      assert.equal(isAppError(error, 'TAMPERED'), true);
      assert.match(error.message, /No artifact signature or hash verifier/);
      return true;
    },
  );
});

test('corrupt bytes without a declared hash are rejected by the artifact verifier', async () => {
  const item = PLATFORM_CASES[1];
  const update = descriptor(item.platform, item.arch, item.artifactType, { artifactHash: null });
  let sawBytes = false;
  const adapter = makeAdapter({
    ...item,
    update,
    verifyArtifact: (_candidate, result) => {
      sawBytes = Buffer.isBuffer(result.artifact);
      return false;
    },
  });

  await assert.rejects(
    () => adapter.verify(update, { artifact: Buffer.from('corrupt artifact') }),
    (error) => isAppError(error, 'TAMPERED'),
  );
  assert.equal(sawBytes, true);
});

test('verification is bound to the exact descriptor object used at install', async () => {
  const item = PLATFORM_CASES[0];
  const first = descriptor(item.platform, item.arch, item.artifactType, {
    artifactHash: null,
    infoUrl: 'https://updates.example.test/first',
  });
  const second = descriptor(item.platform, item.arch, item.artifactType, {
    artifactHash: null,
    infoUrl: 'https://updates.example.test/second',
  });
  let installed = 0;
  const adapter = makeAdapter({
    ...item,
    update: first,
    verifyArtifact: () => true,
    install: async () => {
      installed += 1;
      return { outcome: 'success' };
    },
  });

  await adapter.verify(first, {});
  await assert.rejects(
    () => adapter.install(second),
    (error) => isAppError(error, 'TAMPERED'),
  );
  await adapter.install(first);
  assert.equal(installed, 1);
});

test('top-level array feeds normalize but fail closed as unsigned', async () => {
  const item = PLATFORM_CASES[0];
  const update = descriptor(item.platform, item.arch, item.artifactType);
  const normalized = normalizeFeedForService([update], item.platform);
  assert.equal(normalized.signature, null);
  assert.equal(normalized.updates.length, 1);
  const adapter = createPlatformAdapter({
    platform: item.platform,
    arch: item.arch,
    fetchFeed: async () => [update],
    verifyFeedSignature: () => true,
  });
  assert.throws(
    () => adapter.assertFeedIntegrity([update]),
    (error) => isAppError(error, 'TAMPERED'),
  );
  const service = adapter.createUpdateService({
    currentVersion: '1.0.0',
    currentBuild: '100',
  });

  await assert.rejects(
    () => service.checkNow(),
    (error) => isAppError(error, 'TAMPERED'),
  );
});

test('bare descriptor feeds normalize through signed target and install flow', async () => {
  const item = PLATFORM_CASES[0];
  const update = descriptor(item.platform, item.arch, item.artifactType);
  const bareFeed = { ...update, signature: item.signature };
  const order = [];
  const adapter = createPlatformAdapter({
    platform: item.platform,
    arch: item.arch,
    fetchFeed: async () => bareFeed,
    verifyFeedSignature: (feed, signature) => {
      order.push('feed-signature');
      return feed === bareFeed && signature === item.signature;
    },
    download: async (candidate) => {
      order.push('download');
      return { artifactHash: candidate.artifactHash };
    },
    verifyArtifact: (candidate, result) => {
      order.push('artifact-verification');
      return result.artifactHash === candidate.artifactHash;
    },
    install: async () => {
      order.push('install');
      return { outcome: 'success' };
    },
  });
  const service = adapter.createUpdateService({
    currentVersion: '1.0.0',
    currentBuild: '100',
  });

  await service.checkNow();
  await service.downloadNow();
  const result = await service.installNow();
  assert.deepEqual(order, ['feed-signature', 'download', 'artifact-verification', 'install']);
  assert.equal(result.receipt.outcome, 'success');
});

for (const field of ['channel', 'platform', 'arch']) {
  test(`${field} mismatch is rejected before download`, async () => {
    const item = PLATFORM_CASES[0];
    const values = {
      channel: 'beta',
      platform: 'win32',
      arch: 'x64',
    };
    const update = descriptor(item.platform, item.arch, item.artifactType, { [field]: values[field] });
    let downloaded = 0;
    const adapter = createPlatformAdapter({
      platform: item.platform,
      arch: item.arch,
      channel: 'stable',
      fetchFeed: async () => ({ updates: [update], signature: item.signature }),
      verifyFeedSignature: () => true,
      download: async () => {
        downloaded += 1;
        return { artifactHash: update.artifactHash };
      },
    });
    const service = adapter.createUpdateService({ currentVersion: '1.0.0', currentBuild: '100' });

    await assert.rejects(() => service.checkNow(), (error) => {
      assert.equal(error.code, 'VALIDATION_FAILED');
      assert.equal(error.details.kind, 'update-target-mismatch');
      assert.equal(error.details.field, field);
      return true;
    });
    assert.equal(downloaded, 0);
  });
}

test('every descriptor is target-checked even when one candidate matches', async () => {
  const item = PLATFORM_CASES[0];
  const good = descriptor(item.platform, item.arch, item.artifactType, { version: '1.3.0' });
  const wrong = descriptor(item.platform, 'x64', item.artifactType, { version: '1.4.0' });
  let downloaded = 0;
  const adapter = createPlatformAdapter({
    platform: item.platform,
    arch: item.arch,
    fetchFeed: async () => ({ updates: [good, wrong], signature: item.signature }),
    verifyFeedSignature: () => true,
    download: async () => {
      downloaded += 1;
      return { artifactHash: good.artifactHash };
    },
  });
  const service = adapter.createUpdateService({ currentVersion: '1.0.0', currentBuild: '100' });

  await assert.rejects(() => service.checkNow(), (error) => error.code === 'VALIDATION_FAILED');
  assert.equal(downloaded, 0);
});

test('Linux capability matrix exposes AppImage in-app and deb/rpm manual-or-repository policy', () => {
  const adapter = createPlatformAdapter({ platform: 'linux', arch: 'x64' });
  const appImage = adapter.getCapabilities('appimage');
  const deb = adapter.capabilityProbe('deb');
  const rpm = adapter.probeCapabilities('rpm');

  assert.equal(appImage.autoUpdateCapable, true);
  assert.equal(appImage.installAvailable, true);
  assert.equal(appImage.installPolicy, 'in-app');
  assert.equal(deb.autoUpdateCapable, false);
  assert.equal(deb.installAvailable, false);
  assert.equal(deb.installPolicy, 'manual-or-repo');
  assert.equal(rpm.autoUpdateCapable, false);
  assert.equal(rpm.installAvailable, false);
  assert.equal(rpm.installPolicy, 'manual-or-repo');
});

test('darwin DMG updates are manual while ZIP remains the in-app vehicle', () => {
  const adapter = createPlatformAdapter({ platform: 'darwin', arch: 'arm64' });
  const dmg = adapter.getCapabilities('dmg');
  const zip = adapter.getCapabilities('zip');

  assert.equal(dmg.installAvailable, false);
  assert.equal(dmg.installPolicy, 'manual');
  assert.equal(dmg.autoUpdateCapable, false);
  assert.equal(zip.installAvailable, true);
  assert.equal(zip.installPolicy, 'in-app');
});

for (const artifactType of ['deb', 'rpm']) {
  test(`Linux ${artifactType} update never invokes in-app installer`, async () => {
    const item = PLATFORM_CASES[2];
    const update = descriptor(item.platform, item.arch, artifactType);
    let installed = 0;
    const adapter = createPlatformAdapter({
      platform: item.platform,
      arch: item.arch,
      fetchFeed: async () => ({ updates: [update], signature: item.signature }),
      verifyFeedSignature: () => true,
      verifyArtifact: () => true,
      download: async () => ({ artifactHash: update.artifactHash }),
      install: async () => {
        installed += 1;
        return { outcome: 'success' };
      },
    });
    const service = adapter.createUpdateService({ currentVersion: '1.0.0', currentBuild: '100' });

    await service.checkNow();
    await service.downloadNow();
    await assert.rejects(() => service.installNow(), (error) => isAppError(error, 'CAPABILITY_UNAVAILABLE'));
    assert.equal(installed, 0);
  });
}

test('adapter-attached service preserves D1 blockers and quit-prep gates', async () => {
  const item = PLATFORM_CASES[0];
  let blocked = true;
  let installCalls = 0;
  const service = createPlatformUpdateService({
    platform: item.platform,
    arch: item.arch,
    currentVersion: '1.0.0',
    currentBuild: '100',
    fetchFeed: async () => ({ updates: [descriptor(item.platform, item.arch, item.artifactType)], signature: item.signature }),
    verifyFeedSignature: () => true,
    verifyArtifact: () => true,
    download: async (candidate) => ({ artifactHash: candidate.artifactHash }),
    install: async () => {
      installCalls += 1;
      return { outcome: 'success' };
    },
    probes: { recording: () => blocked },
    flushers: { settings: async () => { throw new Error('settings flush failed'); } },
    quitTimeoutMs: 1,
  });

  assert.equal(service.platformAdapter.platform, item.platform);
  await service.checkNow();
  await service.downloadNow();
  await assert.rejects(() => service.installNow(), (error) => {
    assert.equal(error.code, 'UPDATE_BLOCKED');
    assert.equal(error.details.kind, 'blockers');
    return true;
  });
  assert.equal(installCalls, 0);

  blocked = false;
  await assert.rejects(() => service.installNow(), (error) => {
    assert.equal(error.code, 'UPDATE_BLOCKED');
    assert.equal(error.details.kind, 'quit-prep');
    return true;
  });
  assert.equal(installCalls, 0);
});
