'use strict';

const fs = require('fs');
const path = require('path');
const https = require('https');
const DOWNLOAD_IDLE_TIMEOUT_MS = 30000;

const TRANSLATION_MODEL_CATALOG = {
  'qwen35-08b-instruct-q4_k_m': {
    id: 'qwen35-08b-instruct-q4_k_m',
    repositoryId: 'bartowski/Qwen_Qwen3.5-0.8B-GGUF',
    fileName: 'Qwen_Qwen3.5-0.8B-Q4_K_M.gguf',
    label: 'Qwen 3.5 0.8B Q4_K_M',
  },
  'qwen35-2b-instruct-q4_k_m': {
    id: 'qwen35-2b-instruct-q4_k_m',
    repositoryId: 'bartowski/Qwen_Qwen3.5-2B-GGUF',
    fileName: 'Qwen_Qwen3.5-2B-Q4_K_M.gguf',
    label: 'Qwen 3.5 2B Q4_K_M',
  },
  'qwen35-4b-instruct-q4_k_m': {
    id: 'qwen35-4b-instruct-q4_k_m',
    repositoryId: 'bartowski/Qwen_Qwen3.5-4B-GGUF',
    fileName: 'Qwen_Qwen3.5-4B-Q4_K_M.gguf',
    label: 'Qwen 3.5 4B Q4_K_M',
  },
  'qwen35-9b-instruct-q4_k_m': {
    id: 'qwen35-9b-instruct-q4_k_m',
    repositoryId: 'bartowski/Qwen_Qwen3.5-9B-GGUF',
    fileName: 'Qwen_Qwen3.5-9B-Q4_K_M.gguf',
    label: 'Qwen 3.5 9B Q4_K_M',
  },
  'nemotron3-nano-4b-q4_k_m': {
    id: 'nemotron3-nano-4b-q4_k_m',
    repositoryId: 'nvidia/NVIDIA-Nemotron-3-Nano-4B-GGUF',
    fileName: 'NVIDIA-Nemotron3-Nano-4B-Q4_K_M.gguf',
    label: 'NVIDIA Nemotron-3 Nano 4B Q4_K_M',
  },
};

function ensureDir(dirPath) {
  fs.mkdirSync(dirPath, { recursive: true });
}

function getTranslationModelDescriptor(modelId) {
  const descriptor = TRANSLATION_MODEL_CATALOG[modelId];
  if (!descriptor) {
    throw new Error(`Unsupported local translation model: ${modelId}`);
  }
  return descriptor;
}

function getModelDirectory(baseDir, modelId) {
  return path.join(baseDir, modelId);
}

function resolveCustomInstalledModelPath(baseDir, modelId) {
  const safeName = path.basename(String(modelId || ''));
  if (!safeName) return null;

  const directPath = path.join(baseDir, safeName);
  if (safeName.toLowerCase().endsWith('.gguf') && fs.existsSync(directPath) && fs.statSync(directPath).size > 0) {
    return directPath;
  }

  const modelDir = path.join(baseDir, safeName);
  if (!fs.existsSync(modelDir) || !fs.statSync(modelDir).isDirectory()) return null;
  const fileName = fs.readdirSync(modelDir).find((entry) => entry.toLowerCase().endsWith('.gguf'));
  if (!fileName) return null;
  const filePath = path.join(modelDir, fileName);
  return fs.existsSync(filePath) && fs.statSync(filePath).size > 0 ? filePath : null;
}

function getInstalledModelPath(baseDir, modelId) {
  const descriptor = getTranslationModelDescriptor(modelId);
  return path.join(getModelDirectory(baseDir, modelId), descriptor.fileName);
}

function resolveInstalledModelPath(baseDir, modelId) {
  const descriptor = TRANSLATION_MODEL_CATALOG[modelId];
  if (!descriptor) return resolveCustomInstalledModelPath(baseDir, modelId);
  const filePath = path.join(getModelDirectory(baseDir, modelId), descriptor.fileName);
  return fs.existsSync(filePath) && fs.statSync(filePath).size > 0 ? filePath : null;
}

function buildDownloadUrl(modelId) {
  const descriptor = getTranslationModelDescriptor(modelId);
  return `https://huggingface.co/${descriptor.repositoryId}/resolve/main/${encodeURIComponent(descriptor.fileName)}`;
}

function downloadFileWithProgress(url, destinationPath, onProgress) {
  ensureDir(path.dirname(destinationPath));
  return new Promise((resolve, reject) => {
    const temporaryPath = `${destinationPath}.part`;
    let existingBytes = fs.existsSync(temporaryPath) ? fs.statSync(temporaryPath).size : 0;
    let out = fs.createWriteStream(temporaryPath, { flags: existingBytes > 0 ? 'a' : 'w' });
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
      out = fs.createWriteStream(temporaryPath, { flags });
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
            fs.renameSync(temporaryPath, destinationPath);
            resolve(destinationPath);
          } catch (error) {
            fail(error);
          }
          return;
        }
        if (res.statusCode !== 200) {
          if (res.statusCode !== 206) {
            res.resume();
            return fail(new Error(`HTTP ${res.statusCode} for ${targetUrl}`));
          }
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
        onProgress?.(received, total);
        res.on('data', (chunk) => {
          received += chunk.length;
          onProgress?.(received, total);
        });
        res.setTimeout(DOWNLOAD_IDLE_TIMEOUT_MS, () => {
          res.destroy(new Error(`Download stalled for ${DOWNLOAD_IDLE_TIMEOUT_MS / 1000}s: ${path.basename(destinationPath)}`));
        });
        res.on('error', fail);

        res.pipe(out);
        out.on('finish', () => {
          out.close(() => {
            try {
              settled = true;
              fs.renameSync(temporaryPath, destinationPath);
              resolve(destinationPath);
            } catch (error) {
              fail(error);
            }
          });
        });
      });

      req.setTimeout(DOWNLOAD_IDLE_TIMEOUT_MS, () => {
        req.destroy(new Error(`Download connection timed out after ${DOWNLOAD_IDLE_TIMEOUT_MS / 1000}s: ${path.basename(destinationPath)}`));
      });
      req.on('error', fail);
    };

    handle(url);
  });
}

async function installTranslationModel(baseDir, modelId, onProgress) {
  const existingPath = resolveInstalledModelPath(baseDir, modelId);
  if (existingPath) return { path: existingPath };

  const destinationPath = getInstalledModelPath(baseDir, modelId);
  const downloadUrl = buildDownloadUrl(modelId);
  await downloadFileWithProgress(downloadUrl, destinationPath, onProgress);

  if (!fs.existsSync(destinationPath) || fs.statSync(destinationPath).size === 0) {
    throw new Error(`Downloaded model is incomplete: ${modelId}`);
  }

  return { path: destinationPath };
}

function removeTranslationModel(baseDir, modelId) {
  const customPath = TRANSLATION_MODEL_CATALOG[modelId] ? null : resolveCustomInstalledModelPath(baseDir, modelId);
  if (customPath && path.dirname(customPath) === baseDir) {
    fs.rmSync(customPath, { force: true });
    return;
  }
  const modelDir = getModelDirectory(baseDir, path.basename(String(modelId || '')));
  if (fs.existsSync(modelDir)) {
    fs.rmSync(modelDir, { recursive: true, force: true });
  }
}

module.exports = {
  TRANSLATION_MODEL_CATALOG,
  buildDownloadUrl,
  getInstalledModelPath,
  getTranslationModelDescriptor,
  installTranslationModel,
  removeTranslationModel,
  resolveInstalledModelPath,
};
