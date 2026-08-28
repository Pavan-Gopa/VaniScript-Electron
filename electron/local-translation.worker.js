'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn } = require('child_process');
const {
  installTranslationModel,
  resolveInstalledModelPath,
} = require('./llamacpp-model-store');
const {
  buildLlamaServerArgs,
  buildChatPolishMessages,
  buildChatTranslationMessages,
  buildPlainCompletionPrompt,
  buildPlainPolishPrompt,
  extractChatCompletionText,
  resolveLlamaCppBinaryPath,
  sanitizeTranslationOutput,
  serverBinaryPathFor,
} = require('./llamacpp-runtime');

let MODEL_BASE_DIR = path.join(process.cwd(), 'translation-models');
let LLAMACPP_BINARY_PATH = null;
let LLAMACPP_RUNTIME_OPTIONS = {};
let SERVER_STATE = null;
let TRANSLATION_QUEUE = Promise.resolve();

function clampContextSize(value) {
  const requested = Number(value);
  if (!Number.isFinite(requested) || requested <= 0) return 8192;
  return Math.max(4096, Math.min(32768, Math.floor(requested)));
}

function nextServerPort() {
  return 48180 + Math.floor(Math.random() * 1000);
}

function serverEnv(runtimeDir) {
  return {
    ...process.env,
    ...(process.platform === 'darwin' && runtimeDir ? { DYLD_LIBRARY_PATH: runtimeDir } : {}),
    ...(process.platform === 'linux' && runtimeDir ? { LD_LIBRARY_PATH: runtimeDir } : {}),
  };
}

async function sleep(ms) {
  await new Promise((resolve) => setTimeout(resolve, ms));
}

async function waitForServer(baseUrl, child, timeoutMs = 120000) {
  const started = Date.now();
  let lastError = '';
  while (Date.now() - started < timeoutMs) {
    if (child.exitCode !== null) {
      throw new Error(`llama-server exited before becoming ready. ${lastError}`);
    }
    try {
      const response = await fetch(`${baseUrl}/health`);
      if (response.ok) return;
      lastError = `${response.status} ${response.statusText}`;
    } catch (error) {
      lastError = error?.message || String(error);
    }
    await sleep(500);
  }
  throw new Error(`llama-server did not become ready within ${Math.round(timeoutMs / 1000)}s. ${lastError}`);
}

function stopServer() {
  if (!SERVER_STATE?.child) {
    SERVER_STATE = null;
    return;
  }
  SERVER_STATE.child.kill('SIGTERM');
  SERVER_STATE = null;
}

async function fetchWithTimeout(url, options = {}, timeoutMs = 120000) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetch(url, { ...options, signal: controller.signal });
  } catch (error) {
    if (error?.name === 'AbortError') {
      throw new Error(`llama-server request timed out after ${Math.round(timeoutMs / 1000)}s.`);
    }
    throw error;
  } finally {
    clearTimeout(timeout);
  }
}

async function ensureServer(modelId, modelPath, ctxSize = 8192) {
  if (!LLAMACPP_BINARY_PATH) {
    LLAMACPP_BINARY_PATH = resolveLlamaCppBinaryPath(LLAMACPP_RUNTIME_OPTIONS);
  }
  const resolvedCtxSize = clampContextSize(ctxSize);
  if (SERVER_STATE?.modelId === modelId && SERVER_STATE?.modelPath === modelPath && SERVER_STATE?.ctxSize === resolvedCtxSize) {
    return SERVER_STATE;
  }

  stopServer();

  const binaryPath = serverBinaryPathFor(LLAMACPP_BINARY_PATH.binaryPath);
  if (!fs.existsSync(binaryPath)) {
    throw new Error(`llama-server runtime not found: ${binaryPath}`);
  }

  const port = nextServerPort();
  const baseUrl = `http://127.0.0.1:${port}`;
  const args = buildLlamaServerArgs({
    modelPath,
    host: '127.0.0.1',
    port,
    ctxSize: resolvedCtxSize,
    threads: Math.max(1, Math.min(8, os.cpus().length || 1)),
    gpuLayers: 'all',
  });
  const child = spawn(binaryPath, args, {
    stdio: ['ignore', 'pipe', 'pipe'],
    env: serverEnv(LLAMACPP_BINARY_PATH.dirPath),
  });
  let stderr = '';
  child.stderr.on('data', (chunk) => {
    if (stderr.length < 30000) stderr += chunk.toString();
  });
  child.on('exit', (code, signal) => {
    if (SERVER_STATE?.child === child) {
      SERVER_STATE = null;
      process.send?.({ type: 'log', level: 'warn', code: 'PROVIDER_ERROR', message: 'Local translation server exited; retry may be attempted.', args: [] });
    }
  });

  SERVER_STATE = { modelId, modelPath, ctxSize: resolvedCtxSize, child, baseUrl };
  await waitForServer(baseUrl, child);
  return SERVER_STATE;
}

async function runServerTranslation(state, message) {
  const requestTimeoutMs = Math.max(30000, Math.min(600000, Number(message.requestTimeoutMs) || (message.mode === 'custom' ? 180000 : 120000)));
  const messages = message.mode === 'custom'
    ? [
        {
          role: 'system',
          content: 'Follow the user formatting prompt exactly. Return only the requested document content.',
        },
        {
          role: 'user',
          content: message.text,
        },
      ]
    : message.mode === 'polish'
    ? buildChatPolishMessages({
        text: message.text,
        targetLang: message.targetLang,
        glossaryBlock: message.glossaryBlock,
      })
    : buildChatTranslationMessages({
        text: message.text,
        targetLang: message.targetLang,
        glossaryBlock: message.glossaryBlock,
      });

  const chatResponse = await fetchWithTimeout(`${state.baseUrl}/v1/chat/completions`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      model: message.modelId || 'local-model',
      messages,
      max_tokens: message.maxTokens ?? 512,
      temperature: 0.2,
      top_p: 0.9,
      stop: ['</s>', '<end_of_turn>'],
      stream: false,
      cache_prompt: false,
    }),
  }, requestTimeoutMs);

  if (chatResponse.ok) {
    const json = await chatResponse.json();
    const raw = extractChatCompletionText(json);
    const text = sanitizeTranslationOutput(raw);
    if (text) {
      return {
        text,
        backendName: 'llama-server',
        runtimeName: 'llama-server',
      };
    }
    process.send?.({ type: 'log', level: 'warn', code: 'PROVIDER_ERROR', message: 'Local translation returned empty output; retrying.', args: [] });
  } else if (chatResponse.status !== 404) {
    const body = await chatResponse.text().catch(() => '');
    process.send?.({ type: 'log', level: 'warn', code: 'PROVIDER_ERROR', message: 'Local translation request failed; retrying.', args: [] });
  }

  const prompt = message.mode === 'custom'
    ? message.text
    : message.mode === 'polish'
    ? buildPlainPolishPrompt({
        text: message.text,
        targetLang: message.targetLang,
        glossaryBlock: message.glossaryBlock,
      })
    : buildPlainCompletionPrompt({
        text: message.text,
        targetLang: message.targetLang,
        glossaryBlock: message.glossaryBlock,
      });
  const response = await fetchWithTimeout(`${state.baseUrl}/completion`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      prompt,
      n_predict: message.maxTokens ?? 512,
      temperature: 0.2,
      top_p: 0.9,
      stop: ['</s>', '<end_of_turn>'],
      cache_prompt: false,
    }),
  }, requestTimeoutMs);
  if (!response.ok) {
    const body = await response.text().catch(() => '');
    throw new Error(`llama-server completion failed: ${response.status} ${response.statusText}${body ? `: ${body.slice(0, 600)}` : ''}`);
  }
  const json = await response.json();
  const raw = json.content ?? json.text ?? json.response ?? '';
  const text = sanitizeTranslationOutput(raw);
  if (!text) throw new Error('llama-server returned empty output.');
  return {
    text,
    backendName: 'llama-server',
    runtimeName: 'llama-server',
  };
}

async function installModel(modelId) {
  process.send?.({ type: 'download-progress', modelId, status: 'start', received: 0, total: 0, percent: 0 });
  const result = await installTranslationModel(MODEL_BASE_DIR, modelId, (received, total) => {
    const percent = total > 0 ? Math.round((received / total) * 100) : 0;
    process.send?.({ type: 'download-progress', modelId, status: 'progress', received, total, percent });
  });
  process.send?.({ type: 'download-complete', modelId, path: result.path });
}

async function translateText(message) {
  if (!LLAMACPP_BINARY_PATH) {
    LLAMACPP_BINARY_PATH = resolveLlamaCppBinaryPath(LLAMACPP_RUNTIME_OPTIONS);
  }
  const modelPath = resolveInstalledModelPath(MODEL_BASE_DIR, message.modelId);
  if (!modelPath) {
    throw new Error(`Translation model is not installed: ${message.modelId}`);
  }

  const ctxSize = clampContextSize(message.ctxSize);
  let server = await ensureServer(message.modelId, modelPath, ctxSize);
  let result;
  try {
    result = await runServerTranslation(server, message);
  } catch (error) {
    const errorMessage = error?.message || String(error);
    if (/empty output|completion failed/i.test(errorMessage)) {
      process.send?.({ type: 'log', level: 'warn', code: 'PROVIDER_ERROR', message: 'Retrying local translation after server reset.', args: [] });
      stopServer();
      server = await ensureServer(message.modelId, modelPath, ctxSize);
      result = await runServerTranslation(server, message);
    } else {
      throw error;
    }
  }

  process.send?.({
    type: 'translation_result',
    id: message.id,
    result,
  });
}

process.on('message', async (message) => {
  try {
    switch (message?.type) {
      case 'set_base_dir':
        if (message.baseDir) {
          MODEL_BASE_DIR = message.baseDir;
        }
        LLAMACPP_RUNTIME_OPTIONS = {
          isPackaged: Boolean(message.isPackaged),
          resourcesPath: message.resourcesPath || '',
          vendorRoot: message.vendorRoot,
        };
        return;
      case 'install_model':
        await installModel(message.modelId);
        return;
      case 'translate_text':
        TRANSLATION_QUEUE = TRANSLATION_QUEUE
          .catch(() => {})
          .then(() => translateText(message));
        await TRANSLATION_QUEUE;
        return;
      case 'dispose':
        stopServer();
        process.exit(0);
        return;
      default:
        return;
    }
  } catch (error) {
    if (message?.type === 'install_model') {
      process.send?.({ type: 'download-failed', modelId: message.modelId, code: 'MODEL_UNAVAILABLE', error: 'Local translation model download failed.' });
      return;
    }
    process.send?.({ type: 'translation_error', id: message?.id, code: 'PROVIDER_ERROR', error: 'Local translation failed.' });
  }
});
