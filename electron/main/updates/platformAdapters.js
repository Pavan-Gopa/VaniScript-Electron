'use strict';

/**
 * UPD-02 — Platform updater adapters.
 *
 * The adapter is the only place that knows about package/feed mechanics. The
 * UpdateService still owns the lifecycle, readiness blockers, quit preparation,
 * and receipt persistence. No updater dependency is required here: production
 * transports/installers and cryptographic verifiers are explicit seams, while
 * tests can use deterministic fakes.
 */

const crypto = require('node:crypto');
const {
  createAppError,
  isErrorCode,
} = require('../../../shared/contracts/errors.ts');
const {
  UPDATE_SCHEMA_VERSION,
  validateUpdateDescriptor,
} = require('../../../shared/contracts/updates.ts');
const { createUpdateService } = require('./updateService.js');

const SUPPORTED_PLATFORMS = Object.freeze(['darwin', 'win32', 'linux']);
const LINUX_ARTIFACT_TYPES = Object.freeze(['appimage', 'deb', 'rpm']);
const DEFAULT_ARTIFACT_TYPE = Object.freeze({
  darwin: 'zip',
  win32: 'nsis',
  linux: 'appimage',
});

/**
 * Platform policy is data so the security-sensitive differences remain easy to
 * audit. `inAppInstall` is deliberately distinct from `autoUpdateCapable`:
 * UpdateService never auto-downloads or auto-installs, even when a platform can
 * perform an in-app update after the user explicitly asks for it.
 */
const PLATFORM_POLICIES = Object.freeze({
  darwin: Object.freeze({
    feedSemantics: 'squirrel-mac/electron-updater-zip-json',
    acceptedArtifactTypes: Object.freeze(['zip', 'zip+json', 'squirrel', 'dmg']),
    backend: 'injected-squirrel-mac',
    autoUpdateCapable: true,
    inAppInstall: true,
    installPolicy: 'in-app',
    signatureScheme: 'ed25519-or-dsa-hook',
  }),
  win32: Object.freeze({
    feedSemantics: 'nsis-web/squirrel',
    acceptedArtifactTypes: Object.freeze(['nsis', 'nsis-web', 'squirrel']),
    backend: 'injected-nsis',
    autoUpdateCapable: true,
    inAppInstall: true,
    installPolicy: 'in-app',
    signatureScheme: 'authenticode-or-hash-hook',
  }),
  linux: Object.freeze({
    feedSemantics: 'appimage-deb-rpm',
    acceptedArtifactTypes: LINUX_ARTIFACT_TYPES,
    backend: 'injected-linux-package',
    autoUpdateCapable: true,
    inAppInstall: true,
    installPolicy: 'format-dependent',
    signatureScheme: 'signature-or-hash-hook',
  }),
});

function isPlainObject(value) {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function errorMessage(error) {
  return error && typeof error.message === 'string' && error.message.length > 0
    ? error.message
    : String(error);
}

function isThenable(value) {
  return Boolean(value) && typeof value.then === 'function';
}

function tampered(message, details = {}) {
  return createAppError('TAMPERED', message, details);
}

function preserveTypedError(error) {
  if (error && error.name === 'AppError' && isErrorCode(error.code)) return error;
  return null;
}

function mismatch(field, expected, actual, index = undefined) {
  return createAppError(
    'VALIDATION_FAILED',
    `Update ${field} does not match the current target.`,
    {
      kind: 'update-target-mismatch',
      field,
      expected,
      actual,
      ...(index === undefined ? {} : { index }),
    },
  );
}

function valueFrom(entry, keys) {
  if (!isPlainObject(entry)) return undefined;
  for (const key of keys) {
    const value = entry[key];
    if (typeof value === 'string' && value.length > 0) return value;
  }
  return undefined;
}

function normalizeArtifactType(value, fallback) {
  if (typeof value !== 'string' || value.length === 0) return fallback;
  const lower = value.toLowerCase();
  if (lower === 'app-image' || lower === 'app_image') return 'appimage';
  if (lower === 'nsisweb' || lower === 'nsis_web') return 'nsis-web';
  if (lower === 'mac-zip' || lower === 'zip-json' || lower === 'zip_json') return 'zip+json';
  return lower;
}

function artifactTypeFromEntry(entry, platform) {
  const explicit = valueFrom(entry, ['artifactType', 'packageType', 'format', 'target']);
  if (explicit) return normalizeArtifactType(explicit, DEFAULT_ARTIFACT_TYPE[platform]);

  const files = Array.isArray(entry && entry.files) ? entry.files : [];
  const fileName = valueFrom(entry, ['path', 'url', 'fileName', 'name'])
    || (files.length > 0 ? valueFrom(files[0], ['path', 'url', 'fileName', 'name']) : undefined);
  if (fileName) {
    const lower = fileName.toLowerCase();
    if (lower.endsWith('.appimage')) return 'appimage';
    if (lower.endsWith('.deb')) return 'deb';
    if (lower.endsWith('.rpm')) return 'rpm';
    if (lower.endsWith('.zip')) return platform === 'darwin' ? 'zip' : 'squirrel';
    if (lower.endsWith('.exe')) return platform === 'win32' ? 'nsis' : DEFAULT_ARTIFACT_TYPE[platform];
    if (lower.endsWith('.dmg')) return 'dmg';
  }
  return DEFAULT_ARTIFACT_TYPE[platform];
}

function artifactHashFromEntry(entry) {
  const direct = valueFrom(entry, ['artifactHash', 'sha512', 'sha256', 'hash']);
  if (direct) return direct;
  const files = Array.isArray(entry && entry.files) ? entry.files : [];
  return files.length > 0 ? valueFrom(files[0], ['artifactHash', 'sha512', 'sha256', 'hash']) : undefined;
}

function normalizeDescriptorInput(entry, platform) {
  if (!isPlainObject(entry)) return entry;
  const artifactType = artifactTypeFromEntry(entry, platform);
  const artifactHash = artifactHashFromEntry(entry);
  return {
    ...entry,
    artifactType,
    ...(artifactHash ? { artifactHash } : {}),
  };
}

/**
 * Feed signatures are read only from object envelopes. Top-level array feeds
 * have no signature-bearing location, so normalization preserves them as an
 * unsigned envelope and assertFeedIntegrity rejects them fail-closed.
 */
function extractFeedSignature(feed) {
  if (!isPlainObject(feed)) return null;
  const direct = valueFrom(feed, ['signature', 'feedSignature']);
  if (direct) return direct;
  if (isPlainObject(feed.metadata)) return valueFrom(feed.metadata, ['signature', 'feedSignature']);
  if (isPlainObject(feed.release)) return valueFrom(feed.release, ['signature', 'feedSignature']);
  return null;
}

function extractFeedEntries(feed) {
  if (Array.isArray(feed)) return feed;
  if (!isPlainObject(feed)) return [];
  if (Array.isArray(feed.updates)) return feed.updates;
  if (Array.isArray(feed.releases)) return feed.releases;
  if (isPlainObject(feed.release)) return [feed.release];
  if (typeof feed.version === 'string' && feed.version.length > 0) return [feed];
  return [];
}

/**
 * Array feeds intentionally normalize to an envelope with `signature: null`.
 * There is no canonical signature location on the source array, so the
 * adapter's integrity seam must reject the result rather than infer one.
 */
function normalizeFeedForService(feed, platform) {
  const signature = extractFeedSignature(feed);
  const entries = extractFeedEntries(feed);
  if (Array.isArray(feed)) {
    return {
      schemaVersion: UPDATE_SCHEMA_VERSION,
      channel: null,
      updates: entries.map((entry) => normalizeDescriptorInput(entry, platform)),
      signature,
    };
  }
  if (!isPlainObject(feed)) return feed;
  if (Array.isArray(feed.updates) || Array.isArray(feed.releases) || isPlainObject(feed.release)) {
    return {
      ...feed,
      schemaVersion: feed.schemaVersion === undefined ? UPDATE_SCHEMA_VERSION : feed.schemaVersion,
      updates: entries.map((entry) => normalizeDescriptorInput(entry, platform)),
      signature,
    };
  }
  if (typeof feed.version === 'string' && feed.version.length > 0) {
    return normalizeDescriptorInput(feed, platform);
  }
  return feed;
}

function extractArtifactHash(value) {
  if (!isPlainObject(value)) return null;
  return valueFrom(value, ['artifactHash', 'sha512', 'sha256', 'hash']);
}

function artifactBytes(value) {
  if (Buffer.isBuffer(value)) return value;
  if (value instanceof Uint8Array) return Buffer.from(value);
  if (isPlainObject(value)) {
    if (Buffer.isBuffer(value.artifact)) return value.artifact;
    if (value.artifact instanceof Uint8Array) return Buffer.from(value.artifact);
    if (Buffer.isBuffer(value.buffer)) return value.buffer;
    if (value.buffer instanceof Uint8Array) return Buffer.from(value.buffer);
  }
  return null;
}

function computeArtifactHash(result, expected) {
  const bytes = artifactBytes(result);
  if (!bytes || typeof expected !== 'string' || expected.length === 0) return null;
  const separator = expected.indexOf(':');
  const algorithm = separator > 0 ? expected.slice(0, separator) : 'sha256';
  const digest = separator > 0 ? expected.slice(separator + 1) : expected;
  if (!/^[a-z0-9-]+$/i.test(algorithm) || !/^[a-f0-9]+$/i.test(digest)) return null;
  try {
    const actual = crypto.createHash(algorithm).update(bytes).digest('hex');
    return `${algorithm.toLowerCase()}:${actual}`;
  } catch {
    return null;
  }
}

function hashesMatch(expected, actual) {
  if (typeof expected !== 'string' || expected.length === 0) return true;
  if (typeof actual !== 'string' || actual.length === 0) return false;
  const normalize = (value) => {
    const separator = value.indexOf(':');
    return (separator > 0 ? value : `sha256:${value}`).toLowerCase();
  };
  return normalize(expected) === normalize(actual);
}

function descriptorKey(descriptor) {
  return [
    descriptor.version,
    descriptor.build,
    descriptor.platform,
    descriptor.arch,
    descriptor.channel,
    descriptor.artifactType || '',
    descriptor.artifactHash || '',
    descriptor.infoUrl || '',
    descriptor.feedSignature || '',
  ].join('\u0000');
}


function verifierVerdict(verdict, operation) {
  if (isThenable(verdict)) {
    throw tampered(`${operation} verifier must be synchronous at the feed-integrity seam.`);
  }
  if (verdict === false || (isPlainObject(verdict) && verdict.ok === false)) {
    const reason = isPlainObject(verdict) && (verdict.reason || verdict.message)
      ? (verdict.reason || verdict.message)
      : `${operation} verification failed.`;
    throw tampered(reason, isPlainObject(verdict) ? verdict : { ok: false });
  }
  return verdict;
}


class PlatformUpdateAdapter {
  constructor(options = {}, policy = null) {
    if (!isPlainObject(options)) options = {};
    this.platform = options.platform || process.platform;
    this.arch = options.arch || process.arch;
    this.channel = options.channel === 'beta' ? 'beta' : 'stable';
    this.policy = policy || PLATFORM_POLICIES[this.platform] || null;
    if (!this.policy) {
      throw createAppError('CAPABILITY_UNAVAILABLE', `No update adapter is available for ${this.platform}.`, {
        platform: this.platform,
      });
    }

    this.fetchFeedInput = typeof options.fetchFeed === 'function'
      ? options.fetchFeed
      : options.feedTransport && typeof options.feedTransport.fetch === 'function'
        ? options.feedTransport.fetch.bind(options.feedTransport)
        : options.transport && typeof options.transport.fetch === 'function'
          ? options.transport.fetch.bind(options.transport)
          : null;
    this.downloadInput = typeof options.download === 'function'
      ? options.download
      : typeof options.downloadUpdate === 'function'
        ? options.downloadUpdate
        : null;
    this.installInput = typeof options.install === 'function'
      ? options.install
      : typeof options.installUpdate === 'function'
        ? options.installUpdate
        : null;
    this.verifyFeedSignature = typeof options.verifyFeedSignature === 'function'
      ? options.verifyFeedSignature
      : typeof options.verifySignature === 'function'
        ? options.verifySignature
        : null;
    this.verifyArtifactInput = typeof options.verifyArtifact === 'function'
      ? options.verifyArtifact
      : typeof options.verifyArtifactSignature === 'function'
        ? options.verifyArtifactSignature
        : typeof options.verifyPackage === 'function'
          ? options.verifyPackage
          : typeof options.verify === 'function'
            ? options.verify
            : null;
    this.externalFeedIntegrity = typeof options.assertFeedIntegrity === 'function'
      ? options.assertFeedIntegrity
      : null;

    this._feedSources = new WeakMap();
    this._verifiedFeeds = new WeakSet();
    this._verifiedDescriptors = new WeakSet();
    this._verifiedDescriptorKeys = new WeakMap();
  }

  getCapabilities(artifactType = null) {
    const policy = this.getPolicy(artifactType);
    return {
      available: true,
      platform: this.platform,
      arch: this.arch,
      backend: this.policy.backend,
      feedSemantics: this.policy.feedSemantics,
      signatureScheme: this.policy.signatureScheme,
      requiresFeedSignature: true,
      feedTransportAvailable: typeof this.fetchFeedInput === 'function',
      verificationHookAvailable: typeof this.verifyFeedSignature === 'function',
      artifactVerificationHookAvailable: typeof this.verifyArtifactInput === 'function',
      autoUpdateCapable: policy.autoUpdateCapable,
      inAppInstall: policy.inAppInstall,
      installAvailable: policy.installAvailable,
      installPolicy: policy.installPolicy,
      artifactType: policy.artifactType,
      acceptedArtifactTypes: [...this.policy.acceptedArtifactTypes],
      reasonCode: policy.reasonCode,
      userMessage: policy.userMessage,
    };
  }

  capabilityProbe(artifactType = null) {
    return this.getCapabilities(artifactType);
  }

  probeCapabilities(artifactType = null) {
    return this.getCapabilities(artifactType);
  }

  getPolicy(descriptorOrType = null) {
    const artifactType = typeof descriptorOrType === 'string'
      ? normalizeArtifactType(descriptorOrType, DEFAULT_ARTIFACT_TYPE[this.platform])
      : descriptorOrType && typeof descriptorOrType === 'object'
        ? normalizeArtifactType(descriptorOrType.artifactType, DEFAULT_ARTIFACT_TYPE[this.platform])
        : DEFAULT_ARTIFACT_TYPE[this.platform];
    const accepted = this.policy.acceptedArtifactTypes.includes(artifactType);
    if (this.platform !== 'linux') {
      const manualDarwinDmg = this.platform === 'darwin' && artifactType === 'dmg';
      return {
        platform: this.platform,
        artifactType,
        accepted,
        autoUpdateCapable: accepted && !manualDarwinDmg && this.policy.autoUpdateCapable,
        installAvailable: accepted && !manualDarwinDmg && this.policy.inAppInstall,
        installPolicy: !accepted
          ? 'unsupported-format'
          : manualDarwinDmg
            ? 'manual'
            : this.policy.installPolicy,
        reasonCode: !accepted
          ? 'UNSUPPORTED_ARTIFACT_FORMAT'
          : manualDarwinDmg
            ? 'MANUAL_INSTALL_REQUIRED'
            : 'OK',
        userMessage: !accepted
          ? `Artifact format ${artifactType} is not supported on ${this.platform}.`
          : manualDarwinDmg
            ? 'DMG updates require a manual installer.'
            : 'In-app update is available after explicit user confirmation.',
      };
    }

    const installAvailable = artifactType === 'appimage';
    const autoUpdateCapable = artifactType === 'appimage';
    const installPolicy = artifactType === 'appimage' ? 'in-app' : 'manual-or-repo';
    const acceptedLinux = LINUX_ARTIFACT_TYPES.includes(artifactType);
    return {
      platform: this.platform,
      artifactType,
      accepted: acceptedLinux,
      autoUpdateCapable: acceptedLinux && autoUpdateCapable,
      installAvailable: acceptedLinux && installAvailable,
      installPolicy: acceptedLinux ? installPolicy : 'unsupported-format',
      reasonCode: !acceptedLinux
        ? 'UNSUPPORTED_ARTIFACT_FORMAT'
        : installAvailable
          ? 'OK'
          : 'MANUAL_OR_REPOSITORY_REQUIRED',
      userMessage: !acceptedLinux
        ? `Artifact format ${artifactType} is not supported on linux.`
        : installAvailable
          ? 'AppImage can be installed in-app after explicit user confirmation.'
          : `${artifactType} updates notify the user and require a manual installer or package repository.`,
    };
  }

  createServiceOptions() {
    return {
      channel: this.channel,
      platform: this.platform,
      arch: this.arch,
      fetchFeed: this.fetchFeed.bind(this),
      download: this.download.bind(this),
      verify: this.verify.bind(this),
      install: this.install.bind(this),
      // These are mandatory for every adapter; caller options cannot disable
      // feed signature checking at the UpdateService seam.
      requireFeedSignature: true,
      assertFeedIntegrity: this.assertFeedIntegrity.bind(this),
    };
  }

  createUpdateService(options = {}) {
    return createUpdateService({
      ...options,
      ...this.createServiceOptions(),
    });
  }

  async fetchFeed(query = {}) {
    if (typeof this.fetchFeedInput !== 'function') {
      throw createAppError('CAPABILITY_UNAVAILABLE', 'A platform update feed transport is required.', {
        platform: this.platform,
      });
    }
    const request = {
      ...query,
      channel: this.channel,
      platform: this.platform,
      arch: this.arch,
    };
    const raw = await this.fetchFeedInput(request);
    const normalized = normalizeFeedForService(raw, this.platform);
    if (isPlainObject(raw) && isPlainObject(normalized)) this._feedSources.set(normalized, raw);
    this.assertFeedIntegrity(normalized);
    this._assertFeedTargets(normalized);
    return normalized;
  }

  async download(descriptor, context = {}) {
    const checked = this._validateDescriptor(descriptor);
    this._assertArtifactPolicy(checked);
    if (typeof this.downloadInput !== 'function') {
      throw createAppError('CAPABILITY_UNAVAILABLE', 'A platform update download transport is required.', {
        platform: this.platform,
        artifactType: checked.artifactType,
      });
    }
    return this.downloadInput(checked, context);
  }

  async verify(descriptor, result = {}) {
    const checked = this._validateDescriptor(descriptor);
    this._assertArtifactPolicy(checked);
    let verdict;
    if (typeof this.verifyArtifactInput === 'function') {
      try {
        verdict = await this.verifyArtifactInput(checked, result, {
          platform: this.platform,
          arch: this.arch,
          channel: this.channel,
          artifactType: checked.artifactType,
          signatureScheme: this.policy.signatureScheme,
        });
      } catch (error) {
        if (error && error.code === 'TAMPERED') throw error;
        throw tampered(`Downloaded ${this.platform} artifact failed verification: ${errorMessage(error)}`, {
          cause: error && error.code ? error.code : undefined,
        });
      }
      if (verdict === false || (isPlainObject(verdict) && verdict.ok === false)) {
        const reason = isPlainObject(verdict) && (verdict.reason || verdict.message)
          ? (verdict.reason || verdict.message)
          : `Downloaded ${this.platform} artifact failed verification.`;
        throw tampered(reason, isPlainObject(verdict) ? verdict : { ok: false });
      }
    }

    const expected = checked.artifactHash;
    const declaredHashes = [
      extractArtifactHash(result),
      extractArtifactHash(verdict),
    ].filter((hash) => typeof hash === 'string' && hash.length > 0);
    const bytes = artifactBytes(result);
    let actual = declaredHashes[0] || null;
    if (expected && bytes) {
      const computed = computeArtifactHash(bytes, expected);
      if (!computed) {
        throw tampered('Downloaded artifact hash could not be computed from artifact bytes.', {
          platform: this.platform,
          artifactType: checked.artifactType,
          expected,
        });
      }
      if (!hashesMatch(expected, computed)) {
        throw tampered('Downloaded artifact hash does not match the signed descriptor.', {
          platform: this.platform,
          artifactType: checked.artifactType,
          expected,
          actual: computed,
        });
      }
      for (const declared of declaredHashes) {
        if (!hashesMatch(declared, computed)) {
          throw tampered('Downloaded artifact hash declaration does not match the verified artifact bytes.', {
            platform: this.platform,
            artifactType: checked.artifactType,
            expected,
            actual: computed,
            declared,
          });
        }
      }
      actual = computed;
    } else if (expected && !hashesMatch(expected, actual)) {
      throw tampered('Downloaded artifact hash does not match the signed descriptor.', {
        platform: this.platform,
        artifactType: checked.artifactType,
        expected,
        actual,
      });
    }
    if (declaredHashes.length > 1 && !hashesMatch(declaredHashes[0], declaredHashes[1])) {
      throw tampered('Downloaded artifact hash declarations disagree.', {
        platform: this.platform,
        artifactType: checked.artifactType,
        resultHash: declaredHashes[0],
        verifierHash: declaredHashes[1],
      });
    }
    if (!this.verifyArtifactInput && !expected) {
      throw tampered('No artifact signature or hash verifier is configured.', {
        platform: this.platform,
        artifactType: checked.artifactType,
      });
    }

    this._verifiedDescriptors.add(descriptor);
    this._verifiedDescriptorKeys.set(descriptor, descriptorKey(checked));
    return {
      ok: true,
      ...(actual ? { artifactHash: actual } : expected ? { artifactHash: expected } : {}),
      ...(isPlainObject(verdict) ? verdict : {}),
    };
  }

  async install(descriptor, context = {}) {
    const checked = this._validateDescriptor(descriptor);
    const policy = this._assertArtifactPolicy(checked);
    const descriptorIdentity = descriptorKey(checked);
    if (
      !this._verifiedDescriptors.has(descriptor)
      || this._verifiedDescriptorKeys.get(descriptor) !== descriptorIdentity
    ) {
      throw tampered('Install refused because the artifact was not verified by the platform adapter.', {
        platform: this.platform,
        artifactType: checked.artifactType,
      });
    }
    if (!policy.installAvailable) {
      throw createAppError(
        'CAPABILITY_UNAVAILABLE',
        `${checked.artifactType} updates on ${this.platform} require a manual installer or package repository.`,
        {
          platform: this.platform,
          artifactType: checked.artifactType,
          installPolicy: policy.installPolicy,
        },
      );
    }
    if (typeof this.installInput !== 'function') {
      throw createAppError('CAPABILITY_UNAVAILABLE', 'A platform update installer is required.', {
        platform: this.platform,
        artifactType: checked.artifactType,
      });
    }
    return this.installInput(checked, {
      ...context,
      platform: this.platform,
      arch: this.arch,
      channel: this.channel,
      artifactType: checked.artifactType,
      policy,
    });
  }

  assertFeedIntegrity(feed) {
    if (Array.isArray(feed)) {
      throw tampered('Top-level array update feeds cannot carry a signature; use a signed feed envelope.', {
        platform: this.platform,
        channel: this.channel,
      });
    }
    if (!isPlainObject(feed) || this._verifiedFeeds.has(feed)) return true;
    const source = this._feedSources.get(feed) || feed;
    const signature = extractFeedSignature(feed) || extractFeedSignature(source);
    if (!signature) {
      throw tampered('Update feed is unsigned; a platform signature is required.', {
        platform: this.platform,
        channel: this.channel,
      });
    }
    if (typeof this.verifyFeedSignature !== 'function') {
      throw tampered('No platform feed signature verifier is configured.', {
        platform: this.platform,
        signatureScheme: this.policy.signatureScheme,
      });
    }
    let verdict;
    try {
      verdict = this.verifyFeedSignature(source, signature, {
        platform: this.platform,
        arch: this.arch,
        channel: this.channel,
        feed,
      });
      verifierVerdict(verdict, 'Feed signature');
    } catch (error) {
      if (error && error.code === 'TAMPERED') throw error;
      const typed = preserveTypedError(error);
      throw tampered(`Update feed signature verification failed: ${errorMessage(typed || error)}`, {
        platform: this.platform,
        signatureScheme: this.policy.signatureScheme,
        cause: typed ? typed.code : undefined,
      });
    }
    if (this.externalFeedIntegrity) {
      let externalVerdict;
      try {
        externalVerdict = this.externalFeedIntegrity(source);
        verifierVerdict(externalVerdict, 'Feed integrity');
      } catch (error) {
        if (error && error.code === 'TAMPERED') throw error;
        throw tampered(`Update feed integrity verification failed: ${errorMessage(error)}`, {
          platform: this.platform,
          cause: error && error.code ? error.code : undefined,
        });
      }
    }
    this._verifiedFeeds.add(feed);
    return true;
  }

  _validateDescriptor(descriptor) {
    const result = validateUpdateDescriptor(descriptor);
    if (!result.ok) {
      throw createAppError('CORRUPT_DATA', 'Platform adapter received an invalid update descriptor.', {
        cause: result.error.message,
        platform: this.platform,
      });
    }
    this._assertDescriptorTarget(result.value);
    return result.value;
  }

  _assertFeedTargets(feed) {
    if (!isPlainObject(feed)) return;
    if (feed.channel !== null && feed.channel !== undefined && feed.channel !== this.channel) {
      throw mismatch('channel', this.channel, feed.channel);
    }
    const entries = Array.isArray(feed.updates) ? feed.updates : extractFeedEntries(feed);
    entries.forEach((entry, index) => {
      const result = validateUpdateDescriptor(entry);
      if (!result.ok) {
        throw createAppError('CORRUPT_DATA', `Feed update[${index}] is invalid.`, {
          cause: result.error.message,
          platform: this.platform,
        });
      }
      this._assertDescriptorTarget(result.value, index);
      this._assertArtifactPolicy(result.value, index);
    });
  }

  _assertDescriptorTarget(descriptor, index = undefined) {
    if (descriptor.channel !== this.channel) {
      throw mismatch('channel', this.channel, descriptor.channel, index);
    }
    if (descriptor.platform !== this.platform) {
      throw mismatch('platform', this.platform, descriptor.platform, index);
    }
    if (descriptor.arch !== this.arch) {
      throw mismatch('arch', this.arch, descriptor.arch, index);
    }
  }

  _assertArtifactPolicy(descriptor, index = undefined) {
    const policy = this.getPolicy(descriptor);
    if (!policy.accepted) {
      throw createAppError(
        'VALIDATION_FAILED',
        `Artifact format ${policy.artifactType} is not supported by the ${this.platform} updater adapter.`,
        {
          kind: 'unsupported-artifact-format',
          platform: this.platform,
          artifactType: policy.artifactType,
          acceptedArtifactTypes: [...this.policy.acceptedArtifactTypes],
          ...(index === undefined ? {} : { index }),
        },
      );
    }
    return policy;
  }
}

class DarwinUpdateAdapter extends PlatformUpdateAdapter {
  constructor(options = {}) {
    super({ ...options, platform: 'darwin' }, PLATFORM_POLICIES.darwin);
  }
}

class WindowsUpdateAdapter extends PlatformUpdateAdapter {
  constructor(options = {}) {
    super({ ...options, platform: 'win32' }, PLATFORM_POLICIES.win32);
  }
}

class LinuxUpdateAdapter extends PlatformUpdateAdapter {
  constructor(options = {}) {
    super({ ...options, platform: 'linux' }, PLATFORM_POLICIES.linux);
  }
}

function createPlatformAdapter(platformOrOptions = {}, extraOptions = {}) {
  const options = typeof platformOrOptions === 'string'
    ? { ...extraOptions, platform: platformOrOptions }
    : { ...platformOrOptions };
  const platform = options.platform || process.platform;
  if (platform === 'darwin') return new DarwinUpdateAdapter(options);
  if (platform === 'win32') return new WindowsUpdateAdapter(options);
  if (platform === 'linux') return new LinuxUpdateAdapter(options);
  throw createAppError('CAPABILITY_UNAVAILABLE', `No update adapter is available for ${platform}.`, {
    platform,
  });
}

const selectPlatformAdapter = createPlatformAdapter;

function createPlatformUpdateService(options = {}) {
  const adapter = options.adapter || createPlatformAdapter(options);
  const service = adapter.createUpdateService(options);
  Object.defineProperty(service, 'platformAdapter', {
    configurable: false,
    enumerable: false,
    value: adapter,
    writable: false,
  });
  return service;
}

const createUpdateServiceWithAdapter = createPlatformUpdateService;

module.exports = {
  SUPPORTED_PLATFORMS,
  LINUX_ARTIFACT_TYPES,
  DEFAULT_ARTIFACT_TYPE,
  PLATFORM_POLICIES,
  PlatformUpdateAdapter,
  DarwinUpdateAdapter,
  WindowsUpdateAdapter,
  LinuxUpdateAdapter,
  createPlatformAdapter,
  selectPlatformAdapter,
  createPlatformUpdateService,
  createUpdateServiceWithAdapter,
  normalizeArtifactType,
  normalizeFeedForService,
};
