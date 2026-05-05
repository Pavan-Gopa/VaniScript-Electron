'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const https = require('https');

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
    segments = res.transcription.map(([t0, t1, text]) => ({ t0, t1, text }));
  }

  const stitched = segments.map((s) => s?.text || '').join(' ').trim();
  const text = typeof res?.text === 'string' && res.text.trim() ? res.text.trim() : stitched;
  const rawEngine = String(res?.engine || res?.backend || '').toLowerCase();
  let engine = 'cpu';
  if (rawEngine.includes('metal')) engine = 'metal';
  else if (rawEngine.includes('vulkan')) engine = 'vulkan';
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
    const out = fs.createWriteStream(tmp);
    let received = 0;
    let total = 0;

    const handle = (targetUrl) => {
      const req = https.get(targetUrl, (res) => {
        if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
          res.destroy();
          return handle(res.headers.location);
        }
        if (res.statusCode !== 200) {
          res.resume();
          return reject(new Error(`HTTP ${res.statusCode} for ${targetUrl}`));
        }
        total = Number(res.headers['content-length'] || 0);
        res.on('data', (chunk) => {
          received += chunk.length;
          if (onProgress) onProgress(received, total);
        });
        res.pipe(out);
        out.on('finish', () => {
          out.close(() => {
            try {
              fs.renameSync(tmp, dest);
              resolve(dest);
            } catch (error) {
              reject(error);
            }
          });
        });
      });
      req.on('error', (error) => {
        try { out.close(); } catch {}
        try { fs.unlinkSync(tmp); } catch {}
        reject(error);
      });
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

  const base = {
    fname_inp: chunkPath,
    model: modelPath,
    language: options?.language || info.lang || 'auto',
    task: 'transcribe',
    translate: false,
    use_gpu: options?.forceCpu ? false : true,
    threads: options?.threads || Math.max(1, os.cpus().length || 1),
  };

  const start = Date.now();
  const raw = await whisper.transcribe(base);
  const normalized = normalizeResult(raw, { useGpu: base.use_gpu });
  normalized.durationMs = Date.now() - start;
  process.send?.({ type: 'transcription_result', id, result: normalized });
}

function loadAddon() {
  whisper = require('@kutalia/whisper-node-addon');
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
