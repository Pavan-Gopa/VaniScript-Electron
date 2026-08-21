/**
 * CAP-01 acceptance tests: platform capability registry.
 *
 * Loads the `.mts` facade and the CJS registry directly via dynamic `import`
 * (Node v26 type-strips `.ts`/`.mts`), proving that:
 *   - dispatch routes `capabilities:get` to the registry handler,
 *   - each capability yields a *structured* status with reason/remediation (not a bare boolean),
 *   - macOS Apple Silicon enables Core ML / MLX while other OS/arch explain why not,
 *   - system audio loopback is yes on macOS/Windows and "maybe" on Linux,
 *   - available capabilities name a backend; unavailable ones never imply a fallback.
 */
const test = require('node:test');
const assert = require('node:assert/strict');

const ROUTER = '../electron/main/ipc/index.mts';
const REGISTRY = '../electron/main/platform/capabilityRegistry.js';
const IPC = '../shared/contracts/ipc.ts';
const CAPABILITIES = '../shared/contracts/capabilities.ts';

// Build a registry for a given host combination.
async function registryFor(env) {
  const { createCapabilityRegistry } = await import(REGISTRY);
  return createCapabilityRegistry(env);
}

test('dispatch routes capabilities:get to the registry handler', async () => {
  const { dispatch, createCapabilityHandlers } = await import(ROUTER);
  const { createRequest } = await import(IPC);
  const { CAPABILITIES_GET_COMMAND } = await import(CAPABILITIES);

  const handlers = createCapabilityHandlers({
    platform: 'linux',
    arch: 'x64',
    audioLoopbackAvailable: false,
  });
  const result = await dispatch(
    createRequest({ method: CAPABILITIES_GET_COMMAND, args: null }),
    handlers,
  );

  assert.equal(result.ok, true);
  assert.ok(result.value.capabilities);
  assert.ok(result.value.host);
  assert.equal(result.value.host.platform, 'linux');
  assert.equal(result.value.capabilities.coreml_asr.reasonCode, 'UNSUPPORTED_OS');
});

test('every capability key resolves to a structured status', async () => {
  const reg = await registryFor({
    platform: 'darwin',
    arch: 'arm64',
    audioLoopbackAvailable: true,
  });
  const { CAPABILITY_KEYS } = await import(CAPABILITIES);
  const report = reg.getAll();

  for (const key of CAPABILITY_KEYS) {
    const s = report[key];
    assert.ok(s, `missing status for ${key}`);
    assert.equal(typeof s.available, 'boolean');
    assert.equal(typeof s.reasonCode, 'string');
    if (s.available) assert.equal(typeof s.backend, 'string');
    else assert.equal(s.backend, undefined, `unavailable ${key} must not name a backend`);
  }
});

test('macOS Apple Silicon enables Core ML / MLX backends', async () => {
  const reg = await registryFor({
    platform: 'darwin',
    arch: 'arm64',
    audioLoopbackAvailable: true,
  });
  assert.equal(reg.get('coreml_asr').available, true);
  assert.equal(reg.get('coreml_asr').backend, 'whisperkit');
  assert.equal(reg.get('coreml_parakeet').backend, 'coreml');
  assert.equal(reg.get('mlx_translation').backend, 'mlx');
  assert.equal(reg.get('system_audio_loopback').backend, 'coreaudio');
  assert.equal(reg.get('llamacpp_translation').backend, 'llamacpp');
});

test('macOS on Intel reports UNSUPPORTED_ARCH for Core ML / MLX', async () => {
  const reg = await registryFor({
    platform: 'darwin',
    arch: 'x64',
    audioLoopbackAvailable: true,
  });
  assert.equal(reg.get('coreml_asr').available, false);
  assert.equal(reg.get('coreml_asr').reasonCode, 'UNSUPPORTED_ARCH');
  assert.equal(reg.get('mlx_translation').reasonCode, 'UNSUPPORTED_ARCH');
  assert.equal(reg.get('coreml_asr').backend, undefined);
  // Portable backends stay available.
  assert.equal(reg.get('llamacpp_translation').available, true);
});

test('non-macOS reports UNSUPPORTED_OS for Core ML / Metal', async () => {
  for (const platform of ['win32', 'linux']) {
    const reg = await registryFor({ platform, arch: 'x64', audioLoopbackAvailable: false });
    const coreMl = reg.get('coreml_asr');
    assert.equal(coreMl.available, false);
    assert.equal(coreMl.reasonCode, 'UNSUPPORTED_OS');
    assert.ok(coreMl.userMessage && coreMl.remediation, 'unavailable must explain why');
    assert.equal(reg.get('mlx_translation').reasonCode, 'UNSUPPORTED_OS');
    assert.equal(reg.get('metal_compositor').reasonCode, 'UNSUPPORTED_OS');
  }
});

test('system audio loopback: yes on macOS/Windows, maybe on Linux', async () => {
  const darwin = await registryFor({ platform: 'darwin', arch: 'arm64', audioLoopbackAvailable: true });
  assert.equal(darwin.get('system_audio_loopback').available, true);
  assert.equal(darwin.get('system_audio_loopback').backend, 'coreaudio');

  const win = await registryFor({ platform: 'win32', arch: 'x64', audioLoopbackAvailable: false });
  assert.equal(win.get('system_audio_loopback').available, true);
  assert.equal(win.get('system_audio_loopback').backend, 'wasapi');

  const linuxNo = await registryFor({ platform: 'linux', arch: 'x64', audioLoopbackAvailable: false });
  assert.equal(linuxNo.get('system_audio_loopback').available, false);
  assert.equal(linuxNo.get('system_audio_loopback').reasonCode, 'LOOPBACK_UNAVAILABLE');

  const linuxYes = await registryFor({ platform: 'linux', arch: 'x64', audioLoopbackAvailable: true });
  assert.equal(linuxYes.get('system_audio_loopback').available, true);
  assert.equal(linuxYes.get('system_audio_loopback').backend, 'pipewire');
});

test('default capabilityHandlers (no env) routes through dispatch with real host', async () => {
  const { dispatch } = await import(ROUTER);
  const { createRequest } = await import(IPC);
  const { capabilityHandlers } = await import(ROUTER);
  const { CAPABILITIES_GET_COMMAND } = await import(CAPABILITIES);

  const result = await dispatch(
    createRequest({ method: CAPABILITIES_GET_COMMAND, args: null }),
    capabilityHandlers,
  );
  assert.equal(result.ok, true);
  assert.ok(result.value.capabilities.coreml_asr);
  assert.equal(typeof result.value.host.platform, 'string');
});
