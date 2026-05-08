'use strict';

const { app, BrowserWindow, ipcMain, shell, dialog, Tray, Menu, nativeImage } = require('electron');
const path = require('path');
const fs = require('fs');
const os = require('os');
const { pathToFileURL } = require('url');
const { spawn, fork } = require('child_process');
const log = require('electron-log');
const {
  removeTranslationModel,
  resolveInstalledModelPath,
} = require('./llamacpp-model-store');

// ─── Logging ─────────────────────────────────────────────────────────────────
log.initialize();
log.transports.file.level = 'info';
log.transports.console.level = 'debug';
log.info('VaniScript starting up...');

// ─── Single instance lock ────────────────────────────────────────────────────
const gotLock = app.requestSingleInstanceLock();
if (!gotLock) {
  app.quit();
  process.exit(0);
}

// ─── FFmpeg path ─────────────────────────────────────────────────────────────
function getFfmpegPath() {
  if (app.isPackaged) {
    const resourcesPath = process.resourcesPath;
    const candidates = [
      path.join(resourcesPath, 'ffmpeg-bin', 'ffmpeg'),
      path.join(resourcesPath, 'ffmpeg-bin', 'ffmpeg.exe'),
    ];
    for (const c of candidates) {
      if (fs.existsSync(c)) { log.info('Using packaged ffmpeg:', c); return c; }
    }
  }
  // Development: use ffmpeg-static
  try {
    const staticPath = require('ffmpeg-static');
    if (staticPath && fs.existsSync(staticPath)) {
      log.info('Using ffmpeg-static:', staticPath);
      return staticPath;
    }
  } catch (e) {
    log.warn('ffmpeg-static not available:', e.message);
  }
  // System fallback
  const systemPaths = ['/usr/local/bin/ffmpeg', '/opt/homebrew/bin/ffmpeg', '/usr/bin/ffmpeg', 'ffmpeg'];
  for (const p of systemPaths) {
    if (p === 'ffmpeg' || fs.existsSync(p)) { log.info('Using system ffmpeg:', p); return p; }
  }
  return 'ffmpeg';
}

// ─── Windows ─────────────────────────────────────────────────────────────────
let mainWindow = null;
let localWhisperWorker = null;
let localParakeetWorker = null;
let localTranslationWorker = null;
let localRequestCounter = 0;
const localWhisperPending = new Map();
const localParakeetPending = new Map();
const localTranslationPending = new Map();
const DEV_SERVER_CANDIDATES = [
  process.env.ELECTRON_RENDERER_URL,
  process.env.VITE_DEV_SERVER_URL,
  process.env.RENDERER_URL,
  process.env.DEV_SERVER_URL,
].filter(Boolean);

const PARAKEET_MODEL_MAP = {
  'parakeet-english': 'istupakov/parakeet-tdt-0.6b-v2-onnx',
  'parakeet-multilingual': 'istupakov/parakeet-tdt-0.6b-v3-onnx',
};

const WHISPER_MODEL_FILES = {
  'whisper-medium-en': 'ggml-medium.en-q8_0.bin',
  'whisper-large-v3': 'ggml-large-v3-q8_0.bin',
};

const PARAKEET_MODEL_FILES = [
  'encoder-model.onnx',
  'encoder-model.onnx.data',
  'decoder_joint-model.onnx',
  'nemo128.onnx',
  'vocab.txt',
  'config.json',
];

const PARAKEET_MODEL_FILE_SIZES = {
  'encoder-model.onnx': 41770866,
  'encoder-model.onnx.data': 2435420160,
  'decoder_joint-model.onnx': 35792059,
  'nemo128.onnx': 139764,
  'vocab.txt': 9384,
  'config.json': 97,
};

function isParakeetModel(modelId) {
  return Object.prototype.hasOwnProperty.call(PARAKEET_MODEL_MAP, modelId);
}

function resolveLocalAsrStorageDir(kind) {
  return path.join(app.getPath('userData'), 'Models', kind);
}

function resolveLocalTranslationStorageDir() {
  return path.join(app.getPath('userData'), 'Models', 'translation');
}

function emitLocalModelDownloadProgress(payload) {
  if (!mainWindow || mainWindow.isDestroyed()) return;
  mainWindow.webContents.send('local-model:download-progress', payload);
}

function statSize(filePath) {
  try {
    return fs.statSync(filePath).size;
  } catch {
    return 0;
  }
}

function projectsRootDir() {
  const dir = path.join(app.getPath('documents'), 'VaniScript Projects');
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

function safeName(value, fallback = 'project') {
  return String(value || fallback)
    .replace(/[<>:"/\\|?*\x00-\x1F]/g, '_')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 120) || fallback;
}

function newProjectId() {
  return `vs-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
}

function projectDir(projectId) {
  const id = safeName(projectId, newProjectId());
  const dir = path.join(projectsRootDir(), id);
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

function projectJsonPath(projectId) {
  return path.join(projectDir(projectId), 'project.json');
}

function copyProjectAsset(projectId, sourcePath, folder, fallbackName) {
  if (!sourcePath || !fs.existsSync(sourcePath)) return sourcePath || '';
  const root = projectDir(projectId);
  if (path.resolve(sourcePath).startsWith(path.resolve(root))) return sourcePath;
  const dir = path.join(root, folder);
  fs.mkdirSync(dir, { recursive: true });
  const ext = path.extname(sourcePath);
  const name = safeName(path.basename(sourcePath, ext), fallbackName) + ext;
  const dest = path.join(dir, name);
  if (!fs.existsSync(dest) || fs.statSync(dest).size !== fs.statSync(sourcePath).size) {
    fs.copyFileSync(sourcePath, dest);
  }
  return dest;
}

function normalizeProjectSessionAssets(projectId, session) {
  if (!session) return session;
  const next = { ...session };
  next.sourceFile = copyProjectAsset(projectId, session.sourceFile, 'audio', 'source');
  next.wavPath = copyProjectAsset(projectId, session.wavPath, 'audio', 'working');
  next.chunks = Array.isArray(session.chunks)
    ? session.chunks.map((chunk, index) => ({
        ...chunk,
        filePath: copyProjectAsset(projectId, chunk.filePath, 'chunks', `chunk_${String(index).padStart(4, '0')}`),
      }))
    : [];
  return next;
}

function projectSummary(project) {
  const session = project.session || {};
  const chunks = Array.isArray(session.chunks) ? session.chunks : [];
  return {
    id: project.id,
    name: project.name || session.sourceFileName || 'Untitled Project',
    sourceFileName: session.sourceFileName || '',
    updatedAt: project.updatedAt || project.createdAt || '',
    createdAt: project.createdAt || project.updatedAt || '',
    currentIndex: session.currentIndex || 0,
    totalChunks: chunks.length,
    approvedChunks: chunks.filter((chunk) => chunk.approved).length,
    targetLang: session.targetLang || '',
  };
}

function readProject(projectId) {
  const filePath = projectJsonPath(projectId);
  if (!fs.existsSync(filePath)) throw new Error(`Project not found: ${projectId}`);
  return JSON.parse(fs.readFileSync(filePath, 'utf8'));
}

function listProjects() {
  const root = projectsRootDir();
  return fs.readdirSync(root, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => {
      try {
        return projectSummary(readProject(entry.name));
      } catch {
        return null;
      }
    })
    .filter(Boolean)
    .sort((a, b) => String(b.updatedAt).localeCompare(String(a.updatedAt)));
}

function saveProjectRecord(input) {
  const now = new Date().toISOString();
  const id = input.id || input.session?.projectId || newProjectId();
  const createdAt = input.createdAt || now;
  const session = normalizeProjectSessionAssets(id, {
    ...(input.session || {}),
    projectId: id,
    createdAt,
    updatedAt: now,
  });
  const project = {
    id,
    name: input.name || session.sourceFileName || 'Untitled Project',
    createdAt,
    updatedAt: now,
    screen: input.screen || 'review',
    session,
  };
  fs.writeFileSync(projectJsonPath(id), JSON.stringify(project, null, 2), 'utf8');
  return project;
}

function collectProjectAssets(project) {
  const seen = new Set();
  const assets = [];
  const add = (key, filePath) => {
    if (!filePath || seen.has(key) || !fs.existsSync(filePath)) return;
    seen.add(key);
    assets.push({
      key,
      name: path.basename(filePath),
      dataBase64: fs.readFileSync(filePath).toString('base64'),
    });
  };
  add('sourceFile', project.session?.sourceFile);
  add('wavPath', project.session?.wavPath);
  (project.session?.chunks || []).forEach((chunk, index) => add(`chunk:${index}`, chunk.filePath));
  return assets;
}

function writeProjectBundle(project, filePath) {
  const bundle = {
    format: 'vaniscript-project-v1',
    exportedAt: new Date().toISOString(),
    project,
    assets: collectProjectAssets(project),
  };
  fs.writeFileSync(filePath, JSON.stringify(bundle), 'utf8');
}

function importProjectBundle(filePath) {
  const bundle = JSON.parse(fs.readFileSync(filePath, 'utf8'));
  if (bundle.format !== 'vaniscript-project-v1' || !bundle.project) {
    throw new Error('This is not a VaniScript project bundle.');
  }
  const id = newProjectId();
  const dir = projectDir(id);
  const project = {
    ...bundle.project,
    id,
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  };
  const assetMap = new Map();
  for (const asset of bundle.assets || []) {
    const targetDir = asset.key?.startsWith('chunk:') ? path.join(dir, 'chunks') : path.join(dir, 'audio');
    fs.mkdirSync(targetDir, { recursive: true });
    const dest = path.join(targetDir, safeName(asset.name || asset.key, 'asset'));
    fs.writeFileSync(dest, Buffer.from(asset.dataBase64 || '', 'base64'));
    assetMap.set(asset.key, dest);
  }
  project.session = {
    ...(project.session || {}),
    projectId: id,
    sourceFile: assetMap.get('sourceFile') || project.session?.sourceFile || '',
    wavPath: assetMap.get('wavPath') || project.session?.wavPath || '',
    chunks: (project.session?.chunks || []).map((chunk, index) => ({
      ...chunk,
      filePath: assetMap.get(`chunk:${index}`) || chunk.filePath,
    })),
  };
  fs.writeFileSync(projectJsonPath(id), JSON.stringify(project, null, 2), 'utf8');
  return project;
}

function summarizeParakeetModel(modelId) {
  const repoId = PARAKEET_MODEL_MAP[modelId];
  if (!repoId) return { status: 'not_found', bytesDownloaded: 0 };

  const modelDir = path.join(resolveLocalAsrStorageDir('parakeet'), repoId.replace('/', '_'));
  if (!fs.existsSync(modelDir)) return { status: 'not_found', bytesDownloaded: 0 };

  let bytesDownloaded = 0;
  let completedFiles = 0;
  let currentFileName = null;
  let latestMtime = 0;

  for (const fileName of PARAKEET_MODEL_FILES) {
    const finalPath = path.join(modelDir, fileName);
    const partPath = `${finalPath}.part`;
    const finalSize = statSize(finalPath);
    const partSize = statSize(partPath);
    const expectedSize = PARAKEET_MODEL_FILE_SIZES[fileName] ?? 0;
    if (finalSize > 0 && (!expectedSize || finalSize === expectedSize)) completedFiles += 1;
    bytesDownloaded += finalSize + partSize;

    if (partSize > 0) {
      try {
        const mtime = fs.statSync(partPath).mtimeMs;
        if (mtime >= latestMtime) {
          latestMtime = mtime;
          currentFileName = `${fileName}.part`;
        }
      } catch {}
    }
  }

  return {
    status: completedFiles === PARAKEET_MODEL_FILES.length ? 'downloaded' : 'downloading',
    bytesDownloaded,
    completedFiles,
    totalFiles: PARAKEET_MODEL_FILES.length,
    currentFileName,
  };
}

function summarizeWhisperModel(modelId) {
  const fileName = WHISPER_MODEL_FILES[modelId];
  if (!fileName) return { status: 'not_found', bytesDownloaded: 0 };

  const modelDir = path.join(resolveLocalAsrStorageDir('whisper'), modelId);
  const finalPath = path.join(modelDir, fileName);
  const partPath = `${finalPath}.part`;
  const finalSize = statSize(finalPath);
  const partSize = statSize(partPath);

  return {
    status: finalSize > 0 ? 'downloaded' : partSize > 0 ? 'downloading' : 'not_found',
    bytesDownloaded: finalSize + partSize,
    currentFileName: partSize > 0 ? `${fileName}.part` : fileName,
  };
}

function summarizeTranslationModel(modelId) {
  const installedPath = resolveInstalledModelPath(resolveLocalTranslationStorageDir(), modelId);
  if (installedPath) {
    return {
      status: 'downloaded',
      bytesDownloaded: statSize(installedPath),
      currentFileName: path.basename(installedPath),
    };
  }

  const modelDir = path.join(resolveLocalTranslationStorageDir(), modelId);
  if (!fs.existsSync(modelDir)) return { status: 'not_found', bytesDownloaded: 0 };

  const partName = fs.readdirSync(modelDir).find((entry) => entry.endsWith('.part'));
  if (!partName) return { status: 'not_found', bytesDownloaded: 0 };

  return {
    status: 'downloading',
    bytesDownloaded: statSize(path.join(modelDir, partName)),
    currentFileName: partName,
  };
}

function decodeWavToFloat32(buffer) {
  const data = Buffer.isBuffer(buffer) ? buffer : Buffer.from(buffer);
  if (data.slice(0, 4).toString('ascii') !== 'RIFF' || data.slice(8, 12).toString('ascii') !== 'WAVE') {
    throw new Error('Only WAV chunk files are supported for local Parakeet transcription.');
  }

  let offset = 12;
  let audioFormat = 1;
  let numChannels = 1;
  let sampleRate = 16000;
  let bitsPerSample = 16;
  let dataOffset = -1;
  let dataSize = 0;

  while (offset + 8 <= data.length) {
    const id = data.slice(offset, offset + 4).toString('ascii');
    const size = data.readUInt32LE(offset + 4);
    const start = offset + 8;
    if (id === 'fmt ') {
      audioFormat = data.readUInt16LE(start + 0);
      numChannels = data.readUInt16LE(start + 2);
      sampleRate = data.readUInt32LE(start + 4);
      bitsPerSample = data.readUInt16LE(start + 14);
    } else if (id === 'data') {
      dataOffset = start;
      dataSize = size;
      break;
    }
    offset = start + size + (size % 2);
  }

  if (dataOffset < 0) throw new Error('WAV data chunk not found.');
  if (audioFormat !== 1) throw new Error(`Unsupported WAV format: ${audioFormat}`);
  if (bitsPerSample !== 16) throw new Error(`Unsupported WAV bit depth: ${bitsPerSample}`);

  const frameCount = Math.floor(dataSize / 2 / numChannels);
  const pcm = new Float32Array(frameCount);
  let src = dataOffset;
  for (let i = 0; i < frameCount; i++) {
    let mixed = 0;
    for (let ch = 0; ch < numChannels; ch++) {
      mixed += data.readInt16LE(src) / 32768;
      src += 2;
    }
    pcm[i] = mixed / numChannels;
  }

  if (sampleRate === 16000) return pcm;

  const ratio = sampleRate / 16000;
  const outLen = Math.max(1, Math.floor(pcm.length / ratio));
  const out = new Float32Array(outLen);
  for (let i = 0; i < outLen; i++) {
    const idx = i * ratio;
    const i0 = Math.floor(idx);
    const frac = idx - i0;
    const s0 = pcm[i0] || 0;
    const s1 = pcm[i0 + 1] || 0;
    out[i] = s0 + (s1 - s0) * frac;
  }
  return out;
}

function startLocalWhisperWorker() {
  const scriptPath = path.join(__dirname, 'local-transcription.worker.js');
  const child = fork(scriptPath, [], {
    silent: true,
    env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' },
    stdio: ['pipe', 'pipe', 'pipe', 'ipc'],
  });

  child.stdout?.on('data', (d) => log.info('[Local Whisper STDOUT]', String(d).trim()));
  child.stderr?.on('data', (d) => log.warn('[Local Whisper STDERR]', String(d).trim()));

  child.on('message', (m) => {
    if (!m || !m.type) return;
    if (m.type === 'download-progress') {
      emitLocalModelDownloadProgress({
        kind: 'asr',
        runtime: 'whisper',
        modelId: m.modelId,
        status: m.status || 'progress',
        percent: typeof m.percent === 'number' ? m.percent : 0,
        received: m.received ?? 0,
        total: m.total ?? 0,
      });
      return;
    }
    if (m.type === 'download-complete') {
      const entry = Array.from(localWhisperPending.entries()).find(([, value]) => value.modelId === m.modelId && value.kind === 'install');
      if (!entry) return;
      localWhisperPending.delete(entry[0]);
      entry[1].resolve({ path: m.path ?? null });
      return;
    }
    if (m.type === 'download-failed') {
      const entry = Array.from(localWhisperPending.entries()).find(([, value]) => value.modelId === m.modelId && value.kind === 'install');
      if (!entry) return;
      localWhisperPending.delete(entry[0]);
      entry[1].reject(new Error(m.error || 'Local Whisper model install failed'));
      return;
    }
    if (m.type === 'transcription_result') {
      const entry = localWhisperPending.get(m.id);
      if (!entry) return;
      localWhisperPending.delete(m.id);
      entry.resolve(m.result);
      return;
    }
    if (m.type === 'transcription_error') {
      const entry = localWhisperPending.get(m.id);
      if (!entry) return;
      localWhisperPending.delete(m.id);
      entry.reject(new Error(m.error || 'Local Whisper transcription failed'));
      return;
    }
  });

  child.on('exit', () => {
    localWhisperWorker = null;
    localWhisperPending.forEach(({ reject }) => reject(new Error('Local Whisper worker exited')));
    localWhisperPending.clear();
  });

  child.send({ type: 'set_base_dir', baseDir: resolveLocalAsrStorageDir('whisper') });
  return child;
}

function ensureLocalWhisperWorker() {
  if (localWhisperWorker && !localWhisperWorker.killed) return localWhisperWorker;
  localWhisperWorker = startLocalWhisperWorker();
  return localWhisperWorker;
}

function startLocalParakeetWorker() {
  const scriptPath = path.join(__dirname, '..', '..', 'parakeet.worker.js');
  const child = fork(scriptPath, [], {
    silent: true,
    env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' },
    stdio: ['pipe', 'pipe', 'pipe', 'ipc'],
  });

  child.stdout?.on('data', (d) => log.info('[Local Parakeet STDOUT]', String(d).trim()));
  child.stderr?.on('data', (d) => log.warn('[Local Parakeet STDERR]', String(d).trim()));

  child.on('message', (m) => {
    if (!m || !m.type) return;
    if (m.type === 'download_progress') {
      emitLocalModelDownloadProgress({
        kind: 'asr',
        runtime: 'parakeet',
        modelId: m.modelId,
        status: m.status || 'progress',
        percent: typeof m.progress === 'number' ? m.progress : 0,
        received: m.received ?? 0,
        total: m.total ?? 0,
        currentFile: m.currentFile ?? 0,
        totalFiles: m.totalFiles ?? 0,
        fileName: m.fileName ?? null,
      });
      return;
    }
    if (m.type === 'download-complete') {
      const entry = Array.from(localParakeetPending.entries()).find(([, value]) => value.modelId === m.modelId && value.kind === 'install');
      if (!entry) return;
      localParakeetPending.delete(entry[0]);
      entry[1].resolve({ path: m.path ?? null });
      return;
    }
    if (m.type === 'download-failed') {
      const entry = Array.from(localParakeetPending.entries()).find(([, value]) => value.modelId === m.modelId && value.kind === 'install');
      if (!entry) return;
      localParakeetPending.delete(entry[0]);
      entry[1].reject(new Error(m.error || 'Local Parakeet model install failed'));
      return;
    }
    if (m.type === 'transcription_result') {
      const entry = localParakeetPending.get(m.id);
      if (!entry) return;
      localParakeetPending.delete(m.id);
      entry.resolve(m.result);
      return;
    }
    if (m.type === 'transcription_error') {
      const entry = localParakeetPending.get(m.id);
      if (!entry) return;
      localParakeetPending.delete(m.id);
      entry.reject(new Error(m.error || 'Local Parakeet transcription failed'));
      return;
    }
  });

  child.on('exit', () => {
    localParakeetWorker = null;
    localParakeetPending.forEach(({ reject }) => reject(new Error('Local Parakeet worker exited')));
    localParakeetPending.clear();
  });

  child.send({
    type: 'init',
    payload: { cacheDir: resolveLocalAsrStorageDir('parakeet'), logLevel: 'info' },
  });
  return child;
}

function ensureLocalParakeetWorker() {
  if (localParakeetWorker && !localParakeetWorker.killed) return localParakeetWorker;
  localParakeetWorker = startLocalParakeetWorker();
  return localParakeetWorker;
}

function startLocalTranslationWorker() {
  const scriptPath = path.join(__dirname, 'local-translation.worker.js');
  const child = fork(scriptPath, [], {
    silent: true,
    env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' },
    stdio: ['pipe', 'pipe', 'pipe', 'ipc'],
  });

  child.stdout?.on('data', (d) => log.info('[Local Translation STDOUT]', String(d).trim()));
  child.stderr?.on('data', (d) => log.warn('[Local Translation STDERR]', String(d).trim()));

  child.on('message', (m) => {
    if (!m || !m.type) return;
    if (m.type === 'log') {
      const level = typeof m.level === 'string' ? m.level : 'info';
      const message = m.message || '[Local Translation]';
      if (level === 'warn') log.warn('[Local Translation]', message);
      else if (level === 'error') log.error('[Local Translation]', message);
      else log.info('[Local Translation]', message);
      return;
    }
    if (m.type === 'download-progress') {
      emitLocalModelDownloadProgress({
        kind: 'translation',
        runtime: 'llamacpp',
        modelId: m.modelId,
        status: m.status || 'progress',
        percent: typeof m.percent === 'number' ? m.percent : 0,
        received: m.received ?? 0,
        total: m.total ?? 0,
      });
      return;
    }
    if (m.type === 'download-complete') {
      const entry = Array.from(localTranslationPending.entries()).find(([, value]) => value.modelId === m.modelId && value.kind === 'install');
      if (!entry) return;
      localTranslationPending.delete(entry[0]);
      entry[1].resolve({ path: m.path ?? null });
      return;
    }
    if (m.type === 'download-failed') {
      const entry = Array.from(localTranslationPending.entries()).find(([, value]) => value.modelId === m.modelId && value.kind === 'install');
      if (!entry) return;
      localTranslationPending.delete(entry[0]);
      entry[1].reject(new Error(m.error || 'Local translation model install failed'));
      return;
    }
    if (m.type === 'translation_result') {
      const entry = localTranslationPending.get(m.id);
      if (!entry) return;
      localTranslationPending.delete(m.id);
      entry.resolve(m.result);
      return;
    }
    if (m.type === 'translation_error') {
      const entry = localTranslationPending.get(m.id);
      if (!entry) return;
      localTranslationPending.delete(m.id);
      log.warn('[Local Translation ERROR]', m.error || 'Local translation failed');
      entry.reject(new Error(m.error || 'Local translation failed'));
    }
  });

  child.on('exit', () => {
    localTranslationWorker = null;
    localTranslationPending.forEach(({ reject }) => reject(new Error('Local translation worker exited')));
    localTranslationPending.clear();
  });

  child.send({
    type: 'set_base_dir',
    baseDir: resolveLocalTranslationStorageDir(),
    isPackaged: app.isPackaged,
    resourcesPath: process.resourcesPath,
    vendorRoot: path.join(__dirname, '..', 'vendor', 'llamacpp'),
  });
  return child;
}

function ensureLocalTranslationWorker() {
  if (localTranslationWorker && !localTranslationWorker.killed) return localTranslationWorker;
  localTranslationWorker = startLocalTranslationWorker();
  return localTranslationWorker;
}

function removeLocalModelFiles(kind, modelId) {
  const modelDir = path.join(resolveLocalAsrStorageDir(kind), modelId);
  if (fs.existsSync(modelDir)) fs.rmSync(modelDir, { recursive: true, force: true });
  return { ok: true, id: modelId };
}

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1280,
    height: 820,
    minWidth: 900,
    minHeight: 640,
    titleBarStyle: 'hiddenInset',
    backgroundColor: '#0a0a12',
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
    },
    show: false,
    title: 'VaniScript',
  });

  const devServerUrl = DEV_SERVER_CANDIDATES.find((candidate) => /^https?:\/\//i.test(candidate));
  const builtIndexPath = path.join(__dirname, '..', 'dist', 'index.html');

  if (devServerUrl) {
    log.info('Loading renderer from dev server:', devServerUrl);
    mainWindow.loadURL(devServerUrl);
    // mainWindow.webContents.openDevTools();
  } else {
    log.info('Loading renderer from built file:', builtIndexPath);
    mainWindow.loadFile(builtIndexPath);
  }

  mainWindow.webContents.on('did-fail-load', (_event, errorCode, errorDescription, validatedURL) => {
    log.error('Renderer failed to load', { errorCode, errorDescription, validatedURL });
  });

  mainWindow.once('ready-to-show', () => {
    mainWindow.show();
  });

  mainWindow.on('closed', () => {
    mainWindow = null;
    cleanupTempDir();
  });
}

// ─── Temp directory ───────────────────────────────────────────────────────────
// Lazy getter — evaluated only after app is ready to ensure correct temp path
function getTempDir() {
  const dir = path.join(app.getPath('userData'), 'temp');
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
    log.info('Created temp dir:', dir);
  }
  return dir;
}

function cleanupTempDir() {
  try {
    const dir = path.join(app.getPath('userData'), 'temp');
    if (fs.existsSync(dir)) {
      fs.rmSync(dir, { recursive: true, force: true });
      log.info('Cleaned up temp dir:', dir);
    }
  } catch (e) {
    log.warn('Failed to cleanup temp dir:', e);
  }
}

async function callLocalWhisperWorker(message) {
  const worker = ensureLocalWhisperWorker();
  const id = ++localRequestCounter;
  return new Promise((resolve, reject) => {
    localWhisperPending.set(id, { resolve, reject, modelId: message.modelId, kind: message.type === 'install_model' ? 'install' : 'transcribe' });
    worker.send({ ...message, id });
  });
}

async function callLocalParakeetWorker(message) {
  const worker = ensureLocalParakeetWorker();
  const id = ++localRequestCounter;
  return new Promise((resolve, reject) => {
    localParakeetPending.set(id, { resolve, reject, modelId: message.modelId, kind: message.type === 'install_model' ? 'install' : 'transcribe' });
    worker.send({ ...message, id });
  });
}

async function callLocalTranslationWorker(message) {
  const worker = ensureLocalTranslationWorker();
  const id = ++localRequestCounter;
  return new Promise((resolve, reject) => {
    localTranslationPending.set(id, { resolve, reject, modelId: message.modelId, kind: message.type === 'install_model' ? 'install' : 'translate' });
    worker.send({ ...message, id });
  });
}

// ─── App lifecycle ────────────────────────────────────────────────────────────
app.whenReady().then(() => {
  getTempDir(); // create on startup
  createWindow();

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on('window-all-closed', () => {
  cleanupTempDir();
  if (process.platform !== 'darwin') app.quit();
});

app.on('second-instance', () => {
  if (mainWindow) {
    if (mainWindow.isMinimized()) mainWindow.restore();
    mainWindow.focus();
  }
});

// ─── IPC: File dialog ────────────────────────────────────────────────────────
ipcMain.handle('dialog:openFile', async () => {
  const result = await dialog.showOpenDialog(mainWindow, {
    properties: ['openFile'],
    filters: [
      { name: 'Audio / Video', extensions: ['mp3', 'wav', 'm4a', 'flac', 'ogg', 'mp4', 'mkv', 'webm', 'aac', 'wma', 'mov'] },
      { name: 'All Files', extensions: ['*'] },
    ],
  });
  return result.canceled ? null : result.filePaths[0];
});

ipcMain.handle('dialog:openGenericFile', async (_, { filters } = {}) => {
  const result = await dialog.showOpenDialog(mainWindow, {
    properties: ['openFile'],
    filters: filters || [{ name: 'All Files', extensions: ['*'] }],
  });
  return result.canceled ? null : result.filePaths[0];
});

ipcMain.handle('dialog:saveFile', async (_, { defaultName, filters }) => {
  const result = await dialog.showSaveDialog(mainWindow, {
    defaultPath: defaultName,
    filters: filters || [{ name: 'Text', extensions: ['txt'] }],
  });
  return result.canceled ? null : result.filePath;
});

// ─── IPC: Save file content ───────────────────────────────────────────────────
ipcMain.handle('fs:writeFile', async (_, { filePath, content }) => {
  try {
    fs.writeFileSync(filePath, content, 'utf-8');
    return { success: true };
  } catch (e) {
    return { success: false, error: e.message };
  }
});

ipcMain.handle('fs:readTextFile', async (_, { filePath }) => {
  try {
    return { success: true, content: fs.readFileSync(filePath, 'utf8') };
  } catch (e) {
    return { success: false, error: e.message };
  }
});

// ─── IPC: Get FFmpeg path ─────────────────────────────────────────────────────
ipcMain.handle('ffmpeg:getPath', () => {
  return getFfmpegPath();
});

// ─── Helper: run FFmpeg and return {success, outputPath, error, stderr} ───────
function runFfmpeg(args) {
  return new Promise(resolve => {
    const ffmpegPath = getFfmpegPath();
    log.info('FFmpeg cmd:', ffmpegPath, args.join(' '));
    let stderr = '';
    let proc;
    try {
      proc = spawn(ffmpegPath, args);
    } catch (e) {
      return resolve({ success: false, error: e.message, stderr: '' });
    }
    proc.stderr.on('data', d => { stderr += d.toString(); });
    proc.on('close', code => {
      if (code === 0) {
        resolve({ success: true, stderr });
      } else {
        log.error(`FFmpeg exit ${code}:`, stderr.slice(-800));
        // Extract the actual error line from stderr
        const lines = stderr.split('\n').filter(l => l.includes('Error') || l.includes('error') || l.includes('Invalid') || l.includes('No such'));
        const errMsg = lines.length > 0 ? lines[lines.length - 1].trim() : `FFmpeg exited with code ${code}`;
        resolve({ success: false, error: errMsg, stderr: stderr.slice(-800) });
      }
    });
    proc.on('error', e => {
      log.error('FFmpeg spawn error:', e);
      resolve({ success: false, error: e.message, stderr });
    });
  });
}

// ─── IPC: Convert audio to WAV 16kHz mono ────────────────────────────────────
ipcMain.handle('ffmpeg:convertToWav', async (_, { inputPath }) => {
  try {
    const tempDir = getTempDir();
    fs.mkdirSync(tempDir, { recursive: true });
    const outputPath = path.join(tempDir, `converted_${Date.now()}.wav`);

    // Check input exists
    if (!fs.existsSync(inputPath)) {
      return { success: false, error: `Input file not found: ${inputPath}` };
    }

    const args = ['-y', '-i', inputPath, '-vn', '-ar', '16000', '-ac', '1', '-c:a', 'pcm_s16le', outputPath];
    const result = await runFfmpeg(args);

    if (result.success) return { success: true, outputPath };
    return { success: false, error: result.error, stderr: result.stderr };
  } catch (e) {
    log.error('ffmpeg:convertToWav handler failed:', e);
    return { success: false, error: e?.message ?? String(e) };
  }
});

// ─── IPC: Slice audio into chunks using FFmpeg ────────────────────────────────
ipcMain.handle('ffmpeg:sliceChunks', async (_, { inputPath, cutPoints }) => {
  try {
    const tempDir = getTempDir();
    fs.mkdirSync(tempDir, { recursive: true });
    const chunkPaths = [];
    const boundaries = [0, ...cutPoints, null];

    for (let i = 0; i < boundaries.length - 1; i++) {
      const startSec = boundaries[i];
      const endSec = boundaries[i + 1];
      const outPath = path.join(tempDir, `chunk_${String(i).padStart(4, '0')}.wav`);

      const args = ['-y'];
      if (startSec > 0) args.push('-ss', String(startSec));
      args.push('-i', inputPath, '-vn');
      if (endSec !== null) args.push('-t', String(endSec - startSec));
      args.push('-ar', '16000', '-ac', '1', '-c:a', 'pcm_s16le', outPath);

      const result = await runFfmpeg(args);
      if (!result.success) {
        log.warn(`Chunk ${i} failed, skipping:`, result.error);
        continue;
      }
      chunkPaths.push(outPath);
    }

    return { success: chunkPaths.length > 0, chunkPaths };
  } catch (e) {
    log.error('ffmpeg:sliceChunks handler failed:', e);
    return { success: false, chunkPaths: [], error: e?.message ?? String(e) };
  }
});

// ─── IPC: Get audio duration ─────────────────────────────────────────────────
ipcMain.handle('ffmpeg:getDuration', async (_, { inputPath }) => {
  const args = ['-i', inputPath, '-f', 'null', '-'];
  const result = await runFfmpeg(args);
  // FFmpeg writes duration to stderr even on "error" (exit 1 for null output)
  const stderr = result.stderr || '';
  const m = stderr.match(/Duration:\s*(\d+):(\d+):(\d+\.?\d*)/);
  if (m) {
    const sec = parseInt(m[1]) * 3600 + parseInt(m[2]) * 60 + parseFloat(m[3]);
    return { success: true, durationSec: sec };
  }
  return { success: false, durationSec: 0 };
});

// ─── IPC: Read file as buffer (for Whisper) ───────────────────────────────────
ipcMain.handle('fs:readFileBuffer', async (_, { filePath }) => {
  try {
    const buf = fs.readFileSync(filePath);
    const data = buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength);
    return { success: true, data, byteOffset: 0, byteLength: buf.byteLength };
  } catch (e) {
    return { success: false, error: e.message };
  }
});

ipcMain.handle('fs:pathToFileUrl', async (_, { filePath }) => {
  try {
    if (!filePath || !fs.existsSync(filePath)) {
      return { success: false, error: `File not found: ${filePath}` };
    }
    return { success: true, url: pathToFileURL(filePath).href };
  } catch (e) {
    return { success: false, error: e.message };
  }
});

// ─── IPC: Shell open ──────────────────────────────────────────────────────────
ipcMain.handle('shell:openExternal', async (_, url) => {
  await shell.openExternal(url);
});

// ─── IPC: App info ────────────────────────────────────────────────────────────
ipcMain.handle('app:getVersion', () => app.getVersion());
ipcMain.handle('app:getPlatform', () => process.platform);
ipcMain.handle('app:getUserDataPath', () => app.getPath('userData'));
ipcMain.handle('system:getMemoryInfo', () => ({
  totalBytes: os.totalmem(),
  freeBytes: os.freemem(),
  platform: process.platform,
  arch: process.arch,
}));

// ─── IPC: Projects ─────────────────────────────────────────────────────────
ipcMain.handle('project:list', async () => {
  try {
    return { ok: true, projects: listProjects() };
  } catch (error) {
    return { ok: false, error: error.message || String(error) };
  }
});

ipcMain.handle('project:save', async (_event, project) => {
  try {
    const saved = saveProjectRecord(project);
    return { ok: true, project: saved };
  } catch (error) {
    return { ok: false, error: error.message || String(error) };
  }
});

ipcMain.handle('project:load', async (_event, { id }) => {
  try {
    return { ok: true, project: readProject(id) };
  } catch (error) {
    return { ok: false, error: error.message || String(error) };
  }
});

ipcMain.handle('project:delete', async (_event, { id }) => {
  try {
    fs.rmSync(projectDir(id), { recursive: true, force: true });
    return { ok: true };
  } catch (error) {
    return { ok: false, error: error.message || String(error) };
  }
});

ipcMain.handle('project:clearAll', async () => {
  try {
    fs.rmSync(projectsRootDir(), { recursive: true, force: true });
    fs.mkdirSync(projectsRootDir(), { recursive: true });
    return { ok: true };
  } catch (error) {
    return { ok: false, error: error.message || String(error) };
  }
});

ipcMain.handle('project:export', async (_event, { id }) => {
  try {
    const project = readProject(id);
    const result = await dialog.showSaveDialog(mainWindow, {
      defaultPath: `${safeName(project.name || project.session?.sourceFileName || 'VaniScript Project')}.vaniscript`,
      filters: [{ name: 'VaniScript Project', extensions: ['vaniscript'] }],
    });
    if (result.canceled || !result.filePath) return { ok: false, error: 'Export cancelled' };
    writeProjectBundle(project, result.filePath);
    return { ok: true, filePath: result.filePath };
  } catch (error) {
    return { ok: false, error: error.message || String(error) };
  }
});

ipcMain.handle('project:exportAll', async () => {
  try {
    const projects = listProjects().map((summary) => readProject(summary.id));
    const result = await dialog.showSaveDialog(mainWindow, {
      defaultPath: 'VaniScript Library.vaniscript-library',
      filters: [{ name: 'VaniScript Library', extensions: ['vaniscript-library'] }],
    });
    if (result.canceled || !result.filePath) return { ok: false, error: 'Export cancelled' };
    fs.writeFileSync(result.filePath, JSON.stringify({
      format: 'vaniscript-library-v1',
      exportedAt: new Date().toISOString(),
      bundles: projects.map((project) => ({
        project,
        assets: collectProjectAssets(project),
      })),
    }), 'utf8');
    return { ok: true, filePath: result.filePath };
  } catch (error) {
    return { ok: false, error: error.message || String(error) };
  }
});

ipcMain.handle('project:import', async () => {
  try {
    const result = await dialog.showOpenDialog(mainWindow, {
      properties: ['openFile'],
      filters: [
        { name: 'VaniScript Projects', extensions: ['vaniscript', 'vaniscript-library'] },
        { name: 'All Files', extensions: ['*'] },
      ],
    });
    if (result.canceled || !result.filePaths[0]) return { ok: false, error: 'Import cancelled' };
    const filePath = result.filePaths[0];
    const raw = JSON.parse(fs.readFileSync(filePath, 'utf8'));
    if (raw.format === 'vaniscript-library-v1') {
      const imported = [];
      for (const item of raw.bundles || []) {
        const tmp = path.join(app.getPath('temp'), `${newProjectId()}.vaniscript`);
        fs.writeFileSync(tmp, JSON.stringify({ format: 'vaniscript-project-v1', project: item.project, assets: item.assets }), 'utf8');
        imported.push(importProjectBundle(tmp));
        try { fs.unlinkSync(tmp); } catch {}
      }
      return { ok: true, project: imported[0] || null };
    }
    const project = importProjectBundle(filePath);
    return { ok: true, project };
  } catch (error) {
    return { ok: false, error: error.message || String(error) };
  }
});

// ─── IPC: Local ASR ──────────────────────────────────────────────────────────
ipcMain.handle('local-asr:installModel', async (_event, { modelId }) => {
  try {
    if (isParakeetModel(modelId)) {
      await callLocalParakeetWorker({ type: 'install_model', modelId: PARAKEET_MODEL_MAP[modelId] });
      return { ok: true, id: modelId };
    }
    const result = await callLocalWhisperWorker({ type: 'install_model', modelId });
    return { ok: true, id: modelId, path: result?.path ?? null };
  } catch (e) {
    return { ok: false, id: modelId, error: e?.message ?? String(e) };
  }
});

ipcMain.handle('local-asr:removeModel', async (_event, { modelId }) => {
  try {
    if (isParakeetModel(modelId)) {
      return removeLocalModelFiles('parakeet', PARAKEET_MODEL_MAP[modelId].replace('/', '_'));
    }
    return removeLocalModelFiles('whisper', modelId);
  } catch (e) {
    return { ok: false, id: modelId, error: e?.message ?? String(e) };
  }
});

ipcMain.handle('local-translation:installModel', async (_event, { modelId }) => {
  try {
    const result = await callLocalTranslationWorker({ type: 'install_model', modelId });
    return { ok: true, id: modelId, path: result.path ?? null };
  } catch (error) {
    return { ok: false, id: modelId, error: error.message || String(error) };
  }
});

ipcMain.handle('local-translation:removeModel', async (_event, { modelId }) => {
  try {
    removeTranslationModel(resolveLocalTranslationStorageDir(), modelId);
    return { ok: true, id: modelId };
  } catch (error) {
    return { ok: false, id: modelId, error: error.message || String(error) };
  }
});

ipcMain.handle('local-translation:resolveModelPath', async (_event, { modelId }) => {
  try {
    const modelPath = resolveInstalledModelPath(resolveLocalTranslationStorageDir(), modelId);
    return { ok: true, id: modelId, path: modelPath ?? null };
  } catch (error) {
    return { ok: false, id: modelId, error: error.message || String(error) };
  }
});

ipcMain.handle('local-model:getDownloadStatus', async (_event, { kind, modelId }) => {
  try {
    if (kind === 'translation') {
      return { ok: true, kind, modelId, ...summarizeTranslationModel(modelId) };
    }

    if (isParakeetModel(modelId)) {
      return { ok: true, kind, modelId, ...summarizeParakeetModel(modelId) };
    }

    return { ok: true, kind, modelId, ...summarizeWhisperModel(modelId) };
  } catch (error) {
    return { ok: false, kind, modelId, error: error.message || String(error) };
  }
});

ipcMain.handle('local-translation:translateText', async (_event, payload) => {
  return callLocalTranslationWorker({ type: 'translate_text', ...payload });
});

ipcMain.handle('local-asr:transcribeChunk', async (_event, { modelId, chunkPath, options = {} }) => {
  if (!chunkPath || !fs.existsSync(chunkPath)) throw new Error(`Chunk file not found: ${chunkPath}`);
  if (isParakeetModel(modelId)) {
    const wavBuffer = fs.readFileSync(chunkPath);
    const pcm = decodeWavToFloat32(wavBuffer);
    return callLocalParakeetWorker({
      type: 'transcribe',
      modelId: PARAKEET_MODEL_MAP[modelId],
      audioData: Buffer.from(pcm.buffer, pcm.byteOffset, pcm.byteLength),
    });
  }
  return callLocalWhisperWorker({ type: 'transcribe_chunk', modelId, chunkPath, options });
});

log.info('VaniScript main process ready');
