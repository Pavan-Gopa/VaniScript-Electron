'use strict';

/**
 * Platform capability registry (VaniScript Electron Migration Plan §5 — CAP-01).
 *
 * Probes host OS features and returns a structured `CapabilityStatus` for each
 * capability — never a bare boolean. When a feature is unavailable the status
 * always carries a `reasonCode`, `userMessage`, and `remediation` so the UI
 * can surface guidance instead of silently falling back to another backend.
 *
 * The probe is fully injected via a `HostEnvironment`, so unit tests can
 * evaluate the matrix under any OS/arch/loopback combination without touching
 * the real `process`. `detectHostEnvironment()` resolves the real host and is
 * only used when no environment is injected.
 *
 * This module is CommonJS. It `require`s the shared `.ts` contract directly
 * (Node v22+ type-strips `.ts` on require), keeping a single source of truth
 * for the capability keys and the `capabilities:get` command string.
 */

const {
  CAPABILITY_KEYS,
  CAPABILITIES_GET_COMMAND,
} = require('../../../shared/contracts/capabilities.ts');

const APPLE_SILICON = 'arm64';

/** Build an "available" status for a concrete backend. */
function ok(backend) {
  return Object.freeze({ available: true, reasonCode: 'OK', backend });
}

/**
 * Build an "unavailable" status. A reason is mandatory so callers always know
 * *why* — there is no silent fallback path.
 */
function no(reasonCode, userMessage, remediation) {
  return Object.freeze({
    available: false,
    reasonCode,
    userMessage,
    remediation,
  });
}

/**
 * Capability matrix. Each entry maps to a `probe(env)` that decides
 * availability purely from injected host facts. Keep this data-driven so the
 * OS/arch rules live in one auditable place.
 */
const CAPABILITY_DEFINITIONS = {
  // Portable local translation backend — available everywhere we ship.
  llamacpp_translation: {
    probe() {
      return ok('llamacpp');
    },
  },
  // Portable local ASR backend — available everywhere we ship.
  whisper_cpp_asr: {
    probe() {
      return ok('whispercpp');
    },
  },
  // Core ML ASR: macOS Apple Silicon only.
  coreml_asr: {
    probe(env) {
      if (env.platform !== 'darwin') {
        return no(
          'UNSUPPORTED_OS',
          'Core ML speech recognition is only available on macOS.',
          'Use Whisper.cpp or a cloud provider for transcription on this platform.',
        );
      }
      if (env.arch !== APPLE_SILICON) {
        return no(
          'UNSUPPORTED_ARCH',
          'Core ML speech recognition requires Apple Silicon.',
          'Use Whisper.cpp or a cloud provider for transcription on this Mac.',
        );
      }
      return ok('whisperkit');
    },
  },
  // Core ML Parakeet/Canary family: macOS Apple Silicon only.
  coreml_parakeet: {
    probe(env) {
      if (env.platform !== 'darwin') {
        return no(
          'UNSUPPORTED_OS',
          'Core ML Parakeet/Canary models run only on macOS.',
          'Use Whisper.cpp or a cloud provider for this model on this platform.',
        );
      }
      if (env.arch !== APPLE_SILICON) {
        return no(
          'UNSUPPORTED_ARCH',
          'Core ML Parakeet/Canary models require Apple Silicon.',
          'Use Whisper.cpp or a cloud provider for this model on this Mac.',
        );
      }
      return ok('coreml');
    },
  },
  // MLX translation: macOS Apple Silicon only (llama.cpp remains the fallback).
  mlx_translation: {
    probe(env) {
      if (env.platform !== 'darwin') {
        return no(
          'UNSUPPORTED_OS',
          'MLX translation is only available on macOS.',
          'llama.cpp remains the local translation backend on this platform.',
        );
      }
      if (env.arch !== APPLE_SILICON) {
        return no(
          'UNSUPPORTED_ARCH',
          'MLX translation requires Apple Silicon.',
          'llama.cpp remains the local translation backend on this platform.',
        );
      }
      return ok('mlx');
    },
  },
  // System audio loopback: yes on macOS/Windows, maybe on Linux.
  system_audio_loopback: {
    probe(env) {
      if (env.platform === 'darwin') return ok('coreaudio');
      if (env.platform === 'win32') return ok('wasapi');
      if (env.platform === 'linux') {
        if (env.audioLoopbackAvailable) return ok('pipewire');
        return no(
          'LOOPBACK_UNAVAILABLE',
          'System audio capture on Linux needs a PipeWire or PulseAudio loopback.',
          'Install PipeWire/PulseAudio and grant capture permission, then retry.',
        );
      }
      return no(
        'UNSUPPORTED_OS',
        'System audio capture is not supported on this platform.',
        'Capture microphone audio instead.',
      );
    },
  },
  // Metal compositor: macOS only (Apple Silicon preferred).
  metal_compositor: {
    probe(env) {
      if (env.platform !== 'darwin') {
        return no(
          'UNSUPPORTED_OS',
          'The Metal compositor is only available on macOS.',
          'FFmpeg/Hyperframes/WebGPU are used on this platform.',
        );
      }
      if (env.arch === APPLE_SILICON) return ok('metal');
      return no(
        'UNSUPPORTED_ARCH',
        'The Metal compositor is not available on Intel Macs.',
        'FFmpeg/Hyperframes/WebGPU are used instead.',
      );
    },
  },
  // Microphone capture: all supported platforms given OS permission.
  microphone_capture: {
    probe() {
      return ok('webrtc');
    },
  },
};

/** Probes whether system audio loopback is available on the real host. */
function probeAudioLoopback(platform) {
  if (platform === 'darwin' || platform === 'win32') return true;
  if (platform === 'linux') {
    try {
      const uid = typeof process.getuid === 'function' ? process.getuid() : null;
      const runtimeDir =
        process.env.XDG_RUNTIME_DIR || (uid != null ? `/run/user/${uid}` : null);
      if (!runtimeDir) return false;
      const fs = require('node:fs');
      const path = require('node:path');
      return [
        path.join(runtimeDir, 'pipewire-0'),
        path.join(runtimeDir, 'pulse', 'native'),
      ].some((socket) => {
        try {
          return fs.existsSync(socket);
        } catch {
          return false;
        }
      });
    } catch {
      return false;
    }
  }
  return false;
}

/**
 * Resolve the real host into a `HostEnvironment`. Pure callers inject their own
 * environment for deterministic tests; production passes nothing and gets the
 * probed host.
 */
function detectHostEnvironment() {
  const platform = process.platform;
  const arch = process.arch;
  const audioLoopbackAvailable = probeAudioLoopback(platform);
  return Object.freeze({ platform, arch, audioLoopbackAvailable });
}

/**
 * Create a capability registry bound to `env` (defaults to the real host).
 * Returns helpers for probing one or all capabilities, plus the resolved host.
 */
function createCapabilityRegistry(env) {
  const host = env || detectHostEnvironment();

  function evaluate(key) {
    const def = CAPABILITY_DEFINITIONS[key];
    if (!def) {
      return no(
        'UNKNOWN_CAPABILITY',
        `Unknown capability "${key}".`,
        'Report this to the maintainers.',
      );
    }
    return def.probe(host);
  }

  return {
    /** Probe one capability by key. */
    get(key) {
      return evaluate(key);
    },
    /** Probe every capability, returned as a stable report. */
    getAll() {
      const report = {};
      for (const key of CAPABILITY_KEYS) report[key] = evaluate(key);
      return Object.freeze(report);
    },
    /**
     * Convenience boolean derived from an explicit status. This is NOT a
     * fallback: the full status is always available via `get`/`getAll`.
     */
    isAvailable(key) {
      return evaluate(key).available;
    },
    /** The host facts this registry was built against. */
    getHost() {
      return {
        platform: host.platform,
        arch: host.arch,
        audioLoopbackAvailable: host.audioLoopbackAvailable,
      };
    },
  };
}

/**
 * Build the IPC handler map for `capabilities:get`. The handler returns the
 * full report plus the host summary; the router wraps it in a ResultEnvelope.
 */
function createCapabilityHandlers(env) {
  const registry = createCapabilityRegistry(env);
  return {
    [CAPABILITIES_GET_COMMAND]: () => ({
      capabilities: registry.getAll(),
      host: registry.getHost(),
    }),
  };
}

module.exports = {
  CAPABILITY_DEFINITIONS,
  detectHostEnvironment,
  createCapabilityRegistry,
  createCapabilityHandlers,
};
