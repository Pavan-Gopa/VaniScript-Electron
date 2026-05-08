'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const https = require('https');
const DOWNLOAD_IDLE_TIMEOUT_MS = 30000;

let whisper = null;
let MODEL_BASE_DIR = path.join(os.homedir(), '.vaniscript', 'Models', 'asr');

const HF_BASE = 'https://huggingface.co/ggerganov/whisper.cpp/resolve/main/';
const MODEL_CONFIGS = {
  'whisper-medium-en': {
    filename: 'ggml-medium.en-q8_0.bin',
    lang: 'en',
  },
  'whisper-large-v3': {
    filename: 'ggml-large-v3-q8_0.bin',
    lang: 'auto',
    url: 'https://github.com/sergheinenov/whisper-large-v3-ggml/releases/download/v1.0.0/ggml-large-v3-q8_0.bin',
  },
};

function ensureDir(dirPath) {
  try {
    fs.mkdirSync(dirPath, { recursive: true });
  } catch {}
}

function normalizeResult(res, { useGpu }) {
  let segments = [];
  if (Array.isArray(res?.segments)) segments = res.segments;
  else if (Array.isArray(res?.transcription)) {
    segments = res.transcription
      .map((entry) => {
        if (Array.isArray(entry)) {
          const [t0, t1, text] = entry;
          return { t0, t1, text };
        }
        return { text: String(entry || '') };
      })
      .filter((segment) => String(segment.text || '').trim());
  }

  const stitched = segments.map((s) => s?.text || '').join(' ').trim();
  const text = typeof res?.text === 'string' && res.text.trim() ? res.text.trim() : stitched;
  const rawEngine = String(res?.engine || res?.backend || '').toLowerCase();
  let engine = 'cpu';
  if (rawEngine.includes('metal')) engine = 'metal';
  else if (rawEngine.includes('vulkan')) engine = 'vulkan';
  else if (rawEngine.includes('cpu')) engine = 'cpu';
  else if (useGpu) engine = process.platform === 'darwin' ? 'metal' : 'vulkan';
  return { text, segments, engine };
}

function getModelPaths(modelId) {
  const info = MODEL_CONFIGS[modelId];
  if (!info) throw new Error(`Unknown local ASR model: ${modelId}`);
  const dir = path.join(MODEL_BASE_DIR, modelId);
  ensureDir(dir);
  const modelPath = path.join(dir, info.filename);
  return { info, dir, modelPath };
}

function downloadFileWithProgress(url, dest, onProgress) {
  ensureDir(path.dirname(dest));
  return new Promise((resolve, reject) => {
    const tmp = `${dest}.part`;
    let existingBytes = fs.existsSync(tmp) ? fs.statSync(tmp).size : 0;
    let out = fs.createWriteStream(tmp, { flags: existingBytes > 0 ? 'a' : 'w' });
    let received = existingBytes;
    let total = 0;
    let settled = false;

    const fail = (error) => {
      if (settled) return;
      settled = true;
      try { out.close(); } catch {}
      reject(error);
    };

    const reopenOutput = (flags) => {
      try { out.close(); } catch {}
      out = fs.createWriteStream(tmp, { flags });
    };

    const parseContentRangeTotal = (value) => {
      const match = String(value || '').match(/\/(\d+)$/);
      return match ? Number(match[1]) : 0;
    };

    const handle = (targetUrl) => {
      const headers = existingBytes > 0 ? { Range: `bytes=${existingBytes}-` } : undefined;
      const req = https.get(targetUrl, { headers }, (res) => {
        if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
          res.destroy();
          return handle(res.headers.location);
        }
        if (res.statusCode === 416 && existingBytes > 0) {
          res.resume();
          settled = true;
          try {
            fs.renameSync(tmp, dest);
            resolve(dest);
          } catch (error) {
            fail(error);
          }
          return;
        }
        if (existingBytes > 0 && res.statusCode === 200) {
          existingBytes = 0;
          received = 0;
          reopenOutput('w');
        }
        if (res.statusCode !== 200 && res.statusCode !== 206) {
          res.resume();
          return fail(new Error(`HTTP ${res.statusCode} for ${targetUrl}`));
        }
        const contentLength = Number(res.headers['content-length'] || 0);
        total = res.statusCode === 206
          ? parseContentRangeTotal(res.headers['content-range']) || existingBytes + contentLength
          : contentLength;
        if (onProgress) onProgress(received, total);
        res.on('data', (chunk) => {
          received += chunk.length;
          if (onProgress) onProgress(received, total);
        });
        res.setTimeout(DOWNLOAD_IDLE_TIMEOUT_MS, () => {
          res.destroy(new Error(`Download stalled for ${DOWNLOAD_IDLE_TIMEOUT_MS / 1000}s: ${path.basename(dest)}`));
        });
        res.on('error', fail);
        res.pipe(out);
        out.on('finish', () => {
          out.close(() => {
            try {
              settled = true;
              fs.renameSync(tmp, dest);
              resolve(dest);
            } catch (error) {
              fail(error);
            }
          });
        });
      });
      req.setTimeout(DOWNLOAD_IDLE_TIMEOUT_MS, () => {
        req.destroy(new Error(`Download connection timed out after ${DOWNLOAD_IDLE_TIMEOUT_MS / 1000}s: ${path.basename(dest)}`));
      });
      req.on('error', fail);
    };

    handle(url);
  });
}

async function installModel(modelId) {
  const { info, modelPath } = getModelPaths(modelId);
  const url = info.url || `${HF_BASE}${info.filename}`;

  if (fs.existsSync(modelPath) && fs.statSync(modelPath).size > 0) {
    process.send?.({ type: 'download-complete', modelId, path: modelPath });
    return;
  }

  process.send?.({ type: 'download-progress', modelId, status: 'start', received: 0, total: 0, percent: 0 });
  await downloadFileWithProgress(url, modelPath, (received, total) => {
    const percent = total > 0 ? Math.round((received / total) * 100) : 0;
    process.send?.({ type: 'download-progress', modelId, status: 'progress', received, total, percent });
  });
  process.send?.({ type: 'download-complete', modelId, path: modelPath });
}

async function transcribeChunk({ id, modelId, chunkPath, options }) {
  if (!whisper) throw new Error('Whisper addon not available');

  const { info, modelPath } = getModelPaths(modelId);
  if (!fs.existsSync(modelPath)) throw new Error(`Model not installed: ${modelId}`);
  if (!chunkPath || !fs.existsSync(chunkPath)) throw new Error(`Chunk file not found: ${chunkPath}`);

  const useGpu = true;
  if (options?.forceCpu) {
    process.send?.({
      type: 'log',
      level: 'warn',
      message: 'Ignoring forceCpu for Whisper ASR. VaniScript requires GPU/Metal for local Whisper models.',
      args: [],
    });
  }

  const base = {
    fname_inp: chunkPath,
    model: modelPath,
    language: options?.language || info.lang || 'auto',
    task: 'transcribe',
    translate: false,
    no_timestamps: false,
    no_prints: true,
    use_gpu: useGpu,
    n_threads: options?.threads || Math.max(1, os.cpus().length || 1),
  };

  const start = Date.now();
  const raw = await whisper.transcribe(base);
  const normalized = normalizeResult(raw, { useGpu: base.use_gpu });
  if (process.platform === 'darwin' && normalized.engine !== 'metal') {
    throw new Error(`Whisper ASR returned ${normalized.engine || 'unknown'} backend. Metal GPU execution is required.`);
  }
  normalized.durationMs = Date.now() - start;
  process.send?.({ type: 'transcription_result', id, result: normalized });
}

function loadAddon() {
  const attempts = [
    () => require('@kutalia/whisper-node-addon'),
    () => require(path.join(__dirname, '..', '..', 'node_modules', '@kutalia', 'whisper-node-addon')),
  ];
  const errors = [];

  for (const attempt of attempts) {
    try {
      whisper = attempt();
      return;
    } catch (error) {
      errors.push(error?.message || String(error));
    }
  }

  throw new Error(`Failed to load @kutalia/whisper-node-addon. ${errors.join(' | ')}`);
}

try {
  loadAddon();
} catch (error) {
  process.send?.({ type: 'log', level: 'error', message: `Failed to load whisper addon: ${error.message}`, args: [] });
}

process.on('message', async (msg) => {
  try {
    switch (msg?.type) {
      case 'set_base_dir':
        if (msg.baseDir) {
          MODEL_BASE_DIR = msg.baseDir;
          ensureDir(MODEL_BASE_DIR);
        }
        return;
      case 'install_model':
        await installModel(msg.modelId);
        return;
      case 'transcribe_chunk':
        await transcribeChunk(msg);
        return;
      case 'dispose':
        process.exit(0);
        return;
      default:
        return;
    }
  } catch (error) {
    process.send?.({ type: 'transcription_error', id: msg?.id, error: error?.message || String(error) });
  }
});
