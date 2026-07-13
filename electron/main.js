'use strict';

const { app, BrowserWindow, ipcMain, shell, dialog, Tray, Menu, nativeImage, session, desktopCapturer } = require('electron');
const path = require('path');
const fs = require('fs');
const os = require('os');
const crypto = require('crypto');
const { pathToFileURL } = require('url');
const { spawn, fork, execSync } = require('child_process');
const log = require('electron-log');
const {
  removeTranslationModel,
  resolveInstalledModelPath,
} = require('./llamacpp-model-store');
const {
  renderShortClipWithHyperFrames,
} = require('./hyperframes-renderer');
const { modelsDir, resolveModelsRoot } = require('../shared/localModelsRoot');
const { scanLocalModels } = require('../shared/scanLocalModels');
const {
  normalizeImportedProjectSession,
  resolveSessionCurrentIndex,
  resolveSessionReviewProgressIndex,
} = require('./project-session');

for (const stream of [process.stdout, process.stderr]) {
  stream?.on?.('error', (error) => {
    if (error?.code !== 'EPIPE') throw error;
  });
}

// ─── Logging ─────────────────────────────────────────────────────────────────
log.initialize();
log.transports.file.level = 'info';
log.transports.console.level = 'debug';
log.info('VaniScript starting up...');

const hyperframesRenderControllers = new Map();
const recordingSessions = new Map();
const linkImportJobs = new Map();
const APP_NAME = 'VaniScript-Electron';
let tray = null;
let isQuitting = false;

app.setName(APP_NAME);
if (process.platform === 'darwin') {
  app.setAboutPanelOptions({
    applicationName: APP_NAME,
    applicationVersion: app.getVersion(),
    copyright: '© 2026 VaniScript Audio Processor',
  });
}

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

function getYtDlpPath() {
  const executable = process.platform === 'win32' ? 'yt-dlp.exe' : 'yt-dlp';
  if (app.isPackaged) {
    const resourcesPath = process.resourcesPath;
    const platformDir = process.platform === 'darwin' ? 'darwin' : process.platform === 'win32' ? 'win32' : 'linux';
    const candidates = [
      path.join(resourcesPath, 'yt-dlp-bin', platformDir, executable),
      path.join(resourcesPath, 'yt-dlp-bin', executable),
    ];
    for (const candidate of candidates) {
      if (fs.existsSync(candidate)) {
        try { if (process.platform !== 'win32') fs.chmodSync(candidate, 0o755); } catch {}
        log.info('Using packaged yt-dlp:', candidate);
        return candidate;
      }
    }
  }

  const devCandidates = [
    path.join(__dirname, '..', 'vendor', 'yt-dlp', process.platform === 'darwin' ? 'darwin' : process.platform === 'win32' ? 'win32' : 'linux', executable),
    path.join(__dirname, '..', 'vendor', 'yt-dlp', executable),
    '/opt/homebrew/bin/yt-dlp',
    '/usr/local/bin/yt-dlp',
    '/usr/bin/yt-dlp',
    'yt-dlp',
  ];
  for (const candidate of devCandidates) {
    if (candidate === 'yt-dlp' || fs.existsSync(candidate)) {
      try { if (candidate !== 'yt-dlp' && process.platform !== 'win32') fs.chmodSync(candidate, 0o755); } catch {}
      log.info('Using yt-dlp:', candidate);
      return candidate;
    }
  }
  return 'yt-dlp';
}

function getYtDlpJavaScriptRuntimeArgs() {
  const candidatePaths = [
    process.env.YTDLP_NODE_PATH,
    process.env.NODE_PATH,
    '/opt/homebrew/bin/node',
    '/usr/local/bin/node',
    '/usr/bin/node',
    'node',
  ].filter(Boolean);

  for (const candidate of candidatePaths) {
    if (candidate === 'node' || fs.existsSync(candidate)) {
      return ['--js-runtimes', `node:${candidate}`];
    }
  }

  log.warn('No Node.js runtime found for yt-dlp JavaScript challenges; YouTube downloads may be slow or incomplete.');
  return [];
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

function legacyVaniScriptModelsRoot() {
  return path.join(app.getPath('userData'), 'Models');
}

function localModelsOptions() {
  return { legacyRoot: legacyVaniScriptModelsRoot() };
}

function resolveLocalAsrStorageDir(kind) {
  return modelsDir(kind === 'parakeet' ? 'mlx' : 'ggml', localModelsOptions());
}

function resolveLocalTranslationStorageDir() {
  return modelsDir('gguf', localModelsOptions());
}

function scanSharedLocalModels() {
  const root = resolveModelsRoot(localModelsOptions());
  const entries = scanLocalModels({ ...localModelsOptions(), root });
  return { root, entries };
}

function broadcastSharedLocalModels() {
  try {
    const payload = scanSharedLocalModels();
    if (mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.webContents.send('local-models:updated', payload);
    }
    return { ok: true, ...payload };
  } catch (error) {
    log.warn('Failed to scan shared local models:', error.message || String(error));
    return { ok: false, error: error.message || String(error), entries: [] };
  }
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
  next.sourceFile = copyProjectAsset(projectId, session.sourceFile, session.sourceMediaKind === 'video' ? 'video' : 'audio', 'source');
  next.originalVideoPath = copyProjectAsset(projectId, session.originalVideoPath, 'video', 'source-video');
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
    currentIndex: resolveSessionReviewProgressIndex(session, chunks.length),
    totalChunks: chunks.length,
    approvedChunks: chunks.filter((chunk) => chunk.approved).length,
    targetLang: session.targetLang || '',
    sourceMediaInfo: session.sourceMediaInfo || project.sourceMediaInfo || null,
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

// Two project assets frequently duplicate bytes already bundled elsewhere:
// for a video import, `originalVideoPath` is the source video (the same file as
// `sourceFile`), and `wavPath` is an extracted uncompressed intermediate whose
// audio is already fully covered by the per-chunk WAVs. Including both inflates
// exported bundles ~3-4x. We drop `wavPath` entirely and skip `originalVideoPath`
// when it is a byte-duplicate of `sourceFile`.
function isDuplicateMedia(candidatePath, referencePath) {
  if (!candidatePath || !referencePath) return false;
  try {
    const candidate = fs.statSync(candidatePath);
    const reference = fs.statSync(referencePath);
    return candidate.size > 0 && candidate.size === reference.size;
  } catch {
    return false;
  }
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
  add('originalVideoPath', project.session?.originalVideoPath);
  add('wavPath', project.session?.wavPath);
  (project.session?.chunks || []).forEach((chunk, index) => add(`chunk:${index}`, chunk.filePath));
  return assets;
}

function writeProjectBundle(project, filePath) {
  const assets = [];
  const add = (key, fp) => {
    if (!fp || !fs.existsSync(fp)) return;
    assets.push({ key, name: path.basename(fp), filePath: fp, size: fs.statSync(fp).size });
  };
  const sourceFilePath = project.session?.sourceFile;
  add('sourceFile', sourceFilePath);
  // Skip originalVideoPath when it byte-duplicates sourceFile (typical video import).
  if (!isDuplicateMedia(project.session?.originalVideoPath, sourceFilePath)) {
    add('originalVideoPath', project.session?.originalVideoPath);
  }
  // wavPath intentionally excluded: it is a derived intermediate whose audio is
  // already fully contained in the chunk WAVs, and import never re-transcribes.
  (project.session?.chunks || []).forEach((chunk, index) => add(`chunk:${index}`, chunk.filePath));

  const fd = fs.openSync(filePath, 'w');

  // 1. Write magic header
  fs.writeSync(fd, 'VANISCRIPT_BUNDLE_V2\n');

  // 2. Write metadata JSON
  const metadata = {
    format: 'vaniscript-project-v2',
    schemaVersion: 3,
    exportedAt: new Date().toISOString(),
    project,
    assetMeta: assets.map(a => ({ key: a.key, name: a.name, size: a.size }))
  };
  const jsonStr = JSON.stringify(metadata, null, 2);
  const jsonBuffer = Buffer.from(jsonStr, 'utf8');

  // Write JSON length padded to 12 chars
  const lenStr = String(jsonBuffer.length).padStart(12, '0') + '\n';
  fs.writeSync(fd, lenStr);
  fs.writeSync(fd, jsonBuffer);

  // 3. Write each asset
  const buffer = Buffer.alloc(1024 * 1024); // 1 MB copy buffer
  for (const asset of assets) {
    fs.writeSync(fd, 'START_ASSET\n');
    fs.writeSync(fd, `${asset.key}\n`);
    fs.writeSync(fd, `${asset.name}\n`);
    fs.writeSync(fd, `${asset.size}\n`);

    const inFd = fs.openSync(asset.filePath, 'r');
    let remaining = asset.size;
    let inOffset = 0;
    while (remaining > 0) {
      const toRead = Math.min(remaining, buffer.length);
      const bytesRead = fs.readSync(inFd, buffer, 0, toRead, inOffset);
      if (bytesRead === 0) break;
      fs.writeSync(fd, buffer, 0, bytesRead);
      inOffset += bytesRead;
      remaining -= bytesRead;
    }
    fs.closeSync(inFd);

    fs.writeSync(fd, 'END_ASSET\n');
  }

  fs.closeSync(fd);
}

function importProjectBundle(filePath) {
  const fd = fs.openSync(filePath, 'r');

  // Read first 21 bytes to check format
  const magicBuf = Buffer.alloc(21);
  const bytesRead = fs.readSync(fd, magicBuf, 0, 21, 0);
  const headerStr = magicBuf.toString('utf8');

  if (headerStr === 'VANISCRIPT_BUNDLE_V2\n') {
    // ─── Format V2 (Chunk-by-chunk stream copy) ───
    let offset = 21;
    const readLine = () => {
      let line = '';
      const buf = Buffer.alloc(1);
      while (true) {
        const bytes = fs.readSync(fd, buf, 0, 1, offset);
        if (bytes === 0) break;
        offset += 1;
        const char = buf.toString('utf8');
        if (char === '\n') break;
        line += char;
      }
      return line.trim();
    };

    // Read JSON length
    const jsonLenStr = readLine();
    const jsonLen = parseInt(jsonLenStr, 10);

    // Read JSON metadata
    const jsonBuf = Buffer.alloc(jsonLen);
    fs.readSync(fd, jsonBuf, 0, jsonLen, offset);
    offset += jsonLen;
    const metadata = JSON.parse(jsonBuf.toString('utf8'));

    const id = newProjectId();
    const dir = projectDir(id);
    const project = {
      ...metadata.project,
      id,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    };

    const assetMap = new Map();
    const buffer = Buffer.alloc(1024 * 1024); // 1 MB copy buffer

    while (true) {
      const marker = readLine();
      if (!marker || marker !== 'START_ASSET') {
        break;
      }

      const key = readLine();
      const name = readLine();
      const sizeStr = readLine();
      const size = parseInt(sizeStr, 10);

      const targetDir = key.startsWith('chunk:') ? path.join(dir, 'chunks') : path.join(dir, 'audio');
      fs.mkdirSync(targetDir, { recursive: true });
      const dest = path.join(targetDir, safeName(name || key, 'asset'));

      const outFd = fs.openSync(dest, 'w');
      let remaining = size;
      while (remaining > 0) {
        const toRead = Math.min(remaining, buffer.length);
        const read = fs.readSync(fd, buffer, 0, toRead, offset);
        if (read === 0) {
          fs.closeSync(outFd);
          fs.closeSync(fd);
          throw new Error('Unexpected EOF while reading asset data');
        }
        fs.writeSync(outFd, buffer, 0, read);
        offset += read;
        remaining -= read;
      }
      fs.closeSync(outFd);
      assetMap.set(key, dest);

      readLine(); // Consume END_ASSET line
    }

    fs.closeSync(fd);

    project.session = normalizeImportedProjectSession(project.session, { projectId: id, assetMap });
    fs.writeFileSync(projectJsonPath(id), JSON.stringify(project, null, 2), 'utf8');
    return project;
  } else {
    // ─── Format V1 (Legacy Base64 JSON) ───
    fs.closeSync(fd);
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
    project.session = normalizeImportedProjectSession(project.session, { projectId: id, assetMap });
    fs.writeFileSync(projectJsonPath(id), JSON.stringify(project, null, 2), 'utf8');
    return project;
  }
}

function writeLibraryBundle(projects, filePath) {
  const bundles = [];
  for (const project of projects) {
    const assets = [];
    const add = (key, fp) => {
      if (!fp || !fs.existsSync(fp)) return;
      assets.push({ key, name: path.basename(fp), filePath: fp, size: fs.statSync(fp).size });
    };
    const sourceFilePath = project.session?.sourceFile;
    add('sourceFile', sourceFilePath);
    if (!isDuplicateMedia(project.session?.originalVideoPath, sourceFilePath)) {
      add('originalVideoPath', project.session?.originalVideoPath);
    }
    // wavPath intentionally excluded (see writeProjectBundle).
    (project.session?.chunks || []).forEach((chunk, index) => add(`chunk:${index}`, chunk.filePath));

    bundles.push({
      project,
      assets
    });
  }

  const fd = fs.openSync(filePath, 'w');

  // 1. Write magic header
  fs.writeSync(fd, 'VANISCRIPT_LIBRARY_V2\n');

  // 2. Write metadata JSON
  const metadata = {
    format: 'vaniscript-library-v2',
    schemaVersion: 3,
    exportedAt: new Date().toISOString(),
    bundles: bundles.map((b, pIdx) => ({
      project: b.project,
      assetMeta: b.assets.map(a => ({ key: a.key, name: a.name, size: a.size }))
    }))
  };
  const jsonStr = JSON.stringify(metadata, null, 2);
  const jsonBuffer = Buffer.from(jsonStr, 'utf8');

  // Write JSON length padded to 12 chars
  const lenStr = String(jsonBuffer.length).padStart(12, '0') + '\n';
  fs.writeSync(fd, lenStr);
  fs.writeSync(fd, jsonBuffer);

  // 3. Write each asset for each project
  const buffer = Buffer.alloc(1024 * 1024); // 1 MB copy buffer
  for (let pIdx = 0; pIdx < bundles.length; pIdx++) {
    const b = bundles[pIdx];
    for (const asset of b.assets) {
      fs.writeSync(fd, 'START_ASSET\n');
      fs.writeSync(fd, `${pIdx}\n`);
      fs.writeSync(fd, `${asset.key}\n`);
      fs.writeSync(fd, `${asset.name}\n`);
      fs.writeSync(fd, `${asset.size}\n`);

      const inFd = fs.openSync(asset.filePath, 'r');
      let remaining = asset.size;
      let inOffset = 0;
      while (remaining > 0) {
        const toRead = Math.min(remaining, buffer.length);
        const bytesRead = fs.readSync(inFd, buffer, 0, toRead, inOffset);
        if (bytesRead === 0) break;
        fs.writeSync(fd, buffer, 0, bytesRead);
        inOffset += bytesRead;
        remaining -= bytesRead;
      }
      fs.closeSync(inFd);

      fs.writeSync(fd, 'END_ASSET\n');
    }
  }

  fs.closeSync(fd);
}

function importLibraryBundle(filePath) {
  const fd = fs.openSync(filePath, 'r');

  // Read first 21 bytes to check format
  const magicBuf = Buffer.alloc(21);
  const bytesRead = fs.readSync(fd, magicBuf, 0, 21, 0);
  const headerStr = magicBuf.toString('utf8');
  if (headerStr !== 'VANISCRIPT_LIBRARY_V2\n') {
    fs.closeSync(fd);
    throw new Error('Not a valid VaniScript library bundle V2');
  }

  let offset = 21;
  const readLine = () => {
    let line = '';
    const buf = Buffer.alloc(1);
    while (true) {
      const bytes = fs.readSync(fd, buf, 0, 1, offset);
      if (bytes === 0) break;
      offset += 1;
      const char = buf.toString('utf8');
      if (char === '\n') break;
      line += char;
    }
    return line.trim();
  };

  // Read JSON length
  const jsonLenStr = readLine();
  const jsonLen = parseInt(jsonLenStr, 10);

  // Read JSON metadata
  const jsonBuf = Buffer.alloc(jsonLen);
  fs.readSync(fd, jsonBuf, 0, jsonLen, offset);
  offset += jsonLen;
  const metadata = JSON.parse(jsonBuf.toString('utf8'));

  const importedProjects = [];
  const projectDirs = [];
  const projectAssetMaps = [];

  for (let i = 0; i < metadata.bundles.length; i++) {
    const id = newProjectId();
    const dir = projectDir(id);
    const projMeta = metadata.bundles[i].project;
    const project = {
      ...projMeta,
      id,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    };
    importedProjects.push(project);
    projectDirs.push(dir);
    projectAssetMaps.push(new Map());
  }

  const buffer = Buffer.alloc(1024 * 1024);

  while (true) {
    const marker = readLine();
    if (!marker || marker !== 'START_ASSET') {
      break;
    }

    const pIdxStr = readLine();
    const pIdx = parseInt(pIdxStr, 10);
    const key = readLine();
    const name = readLine();
    const sizeStr = readLine();
    const size = parseInt(sizeStr, 10);

    const dir = projectDirs[pIdx];
    const assetMap = projectAssetMaps[pIdx];

    const targetDir = key.startsWith('chunk:') ? path.join(dir, 'chunks') : path.join(dir, 'audio');
    fs.mkdirSync(targetDir, { recursive: true });
    const dest = path.join(targetDir, safeName(name || key, 'asset'));

    const outFd = fs.openSync(dest, 'w');
    let remaining = size;
    while (remaining > 0) {
      const toRead = Math.min(remaining, buffer.length);
      const read = fs.readSync(fd, buffer, 0, toRead, offset);
      if (read === 0) {
        fs.closeSync(outFd);
        fs.closeSync(fd);
        throw new Error('Unexpected EOF while reading library asset data');
      }
      fs.writeSync(outFd, buffer, 0, read);
      offset += read;
      remaining -= read;
    }
    fs.closeSync(outFd);
    assetMap.set(key, dest);

    readLine(); // Consume END_ASSET line
  }

  fs.closeSync(fd);

  for (let i = 0; i < importedProjects.length; i++) {
    const project = importedProjects[i];
    const id = project.id;
    const assetMap = projectAssetMaps[i];

    project.session = normalizeImportedProjectSession(project.session, { projectId: id, assetMap });
    fs.writeFileSync(projectJsonPath(id), JSON.stringify(project, null, 2), 'utf8');
  }

  return importedProjects;
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

  const status = completedFiles === PARAKEET_MODEL_FILES.length
    ? 'downloaded'
    : currentFileName
      ? 'downloading'
      : bytesDownloaded > 0
        ? 'incomplete'
        : 'not_found';

  return {
    status,
    path: status === 'downloaded' ? modelDir : null,
    bytesDownloaded,
    completedFiles,
    totalFiles: PARAKEET_MODEL_FILES.length,
    currentFileName,
  };
}

function summarizeWhisperModel(modelId) {
  const fileName = WHISPER_MODEL_FILES[modelId];
  if (!fileName) {
    const customPath = resolveCustomWhisperModelPath(modelId);
    if (customPath) {
      return {
        status: 'downloaded',
        path: customPath,
        bytesDownloaded: statSize(customPath),
        currentFileName: path.basename(customPath),
      };
    }
    return { status: 'not_found', path: null, bytesDownloaded: 0 };
  }

  const modelDir = path.join(resolveLocalAsrStorageDir('whisper'), modelId);
  const finalPath = path.join(modelDir, fileName);
  const partPath = `${finalPath}.part`;
  const finalSize = statSize(finalPath);
  const partSize = statSize(partPath);

  return {
    status: finalSize > 0 ? 'downloaded' : partSize > 0 ? 'downloading' : 'not_found',
    path: finalSize > 0 ? finalPath : null,
    bytesDownloaded: finalSize + partSize,
    currentFileName: partSize > 0 ? `${fileName}.part` : fileName,
  };
}

function resolveCustomWhisperModelPath(modelId) {
  const safeName = path.basename(String(modelId || ''));
  if (!safeName) return null;

  const baseDir = resolveLocalAsrStorageDir('whisper');
  const directPath = path.join(baseDir, safeName);
  if (isCompleteGGMLFile(directPath)) return directPath;

  const modelDir = path.join(baseDir, safeName);
  if (!fs.existsSync(modelDir) || !fs.statSync(modelDir).isDirectory()) return null;
  const fileName = fs.readdirSync(modelDir).find((entry) => isCompleteGGMLFile(path.join(modelDir, entry)));
  return fileName ? path.join(modelDir, fileName) : null;
}

function isCompleteGGMLFile(filePath) {
  const name = path.basename(filePath).toLowerCase();
  return name.startsWith('ggml-')
    && name.endsWith('.bin')
    && fs.existsSync(filePath)
    && fs.statSync(filePath).size > 0;
}

function summarizeTranslationModel(modelId) {
  const installedPath = resolveInstalledModelPath(resolveLocalTranslationStorageDir(), modelId);
  if (installedPath) {
    return {
      status: 'downloaded',
      path: installedPath,
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

function showMainWindow() {
  if (!mainWindow || mainWindow.isDestroyed()) {
    createWindow();
    return;
  }
  revealMainWindow('show-main-window');
}

function openSettingsFromShell() {
  showMainWindow();
  if (!mainWindow) return;
  if (mainWindow.webContents.isLoadingMainFrame()) {
    mainWindow.webContents.once('did-finish-load', () => {
      mainWindow?.webContents.send('app:open-settings');
    });
    return;
  }
  mainWindow.webContents.send('app:open-settings');
}

function createVaniScriptIcon(template = false, size = 0) {
  const candidates = [
    path.join(__dirname, '..', 'assets', 'VS_Logo x256.png'),
    path.join(__dirname, '..', 'assets', 'icon.png'),
    path.join(process.resourcesPath || '', 'assets', 'VS_Logo x256.png'),
    path.join(process.resourcesPath || '', 'assets', 'icon.png'),
  ];
  const iconPath = candidates.find((candidate) => candidate && fs.existsSync(candidate));
  const source = iconPath ? nativeImage.createFromPath(iconPath) : nativeImage.createEmpty();
  const image = size > 0 && !source.isEmpty() ? source.resize({ width: size, height: size }) : source;
  image.setTemplateImage(template);
  return image;
}

function revealMainWindow(reason) {
  if (!mainWindow || mainWindow.isDestroyed()) return;
  if (mainWindow.isMinimized()) mainWindow.restore();
  mainWindow.show();
  mainWindow.moveTop();
  mainWindow.focus();
  if (process.platform === 'darwin') {
    app.focus({ steal: true });
  }
  log.info('Main window reveal', {
    reason,
    visible: mainWindow.isVisible(),
    focused: mainWindow.isFocused(),
    bounds: mainWindow.getBounds(),
  });
}

function installAppMenu() {
  const template = [
    {
      label: APP_NAME,
      submenu: [
        { role: 'about', label: `About ${APP_NAME}` },
        { type: 'separator' },
        {
          label: 'Settings…',
          accelerator: 'CommandOrControl+,',
          click: openSettingsFromShell,
        },
        { type: 'separator' },
        { role: 'hide', label: `Hide ${APP_NAME}` },
        { role: 'hideOthers' },
        { role: 'unhide' },
        { type: 'separator' },
        {
          label: `Quit ${APP_NAME}`,
          accelerator: 'CommandOrControl+Q',
          click: () => {
            isQuitting = true;
            app.quit();
          },
        },
      ],
    },
    {
      label: 'File',
      submenu: [
        { label: 'Settings…', accelerator: 'CommandOrControl+,', click: openSettingsFromShell },
        { type: 'separator' },
        { role: 'close' },
      ],
    },
    {
      label: 'Edit',
      submenu: [
        { role: 'undo' },
        { role: 'redo' },
        { type: 'separator' },
        { role: 'cut' },
        { role: 'copy' },
        { role: 'paste' },
        { role: 'selectAll' },
      ],
    },
    {
      label: 'View',
      submenu: [
        { role: 'reload' },
        { role: 'forceReload' },
        { role: 'toggleDevTools' },
        { type: 'separator' },
        { role: 'resetZoom' },
        { role: 'zoomIn' },
        { role: 'zoomOut' },
        { type: 'separator' },
        { role: 'togglefullscreen' },
      ],
    },
    {
      label: 'Window',
      submenu: [
        { role: 'minimize' },
        { role: 'zoom' },
        { type: 'separator' },
        { role: 'front' },
      ],
    },
  ];
  Menu.setApplicationMenu(Menu.buildFromTemplate(template));
}

function installTray() {
  if (tray) return;
  const trayIcon = createVaniScriptIcon(false, process.platform === 'darwin' ? 18 : 0);
  const dockIcon = createVaniScriptIcon(false);
  if (process.platform === 'darwin' && app.dock && !dockIcon.isEmpty()) {
    app.dock.setIcon(dockIcon);
  }
  tray = new Tray(trayIcon);
  tray.setToolTip(APP_NAME);
  const trayMenu = Menu.buildFromTemplate([
    { label: `Open ${APP_NAME}`, click: showMainWindow },
    { label: 'Settings…', click: openSettingsFromShell },
    { type: 'separator' },
    {
      label: `Quit ${APP_NAME}`,
      click: () => {
        isQuitting = true;
        app.quit();
      },
    },
  ]);
  if (process.platform === 'darwin') {
    tray.on('click', showMainWindow);
    tray.on('right-click', () => tray?.popUpContextMenu(trayMenu));
  } else {
    tray.setContextMenu(trayMenu);
  }
}

function removeLocalModelFiles(kind, modelId) {
  const baseDir = resolveLocalAsrStorageDir(kind);
  const modelPath = kind === 'whisper' && /\.bin$/i.test(String(modelId || ''))
    ? path.join(baseDir, path.basename(String(modelId)))
    : path.join(baseDir, modelId);
  if (fs.existsSync(modelPath)) fs.rmSync(modelPath, { recursive: true, force: true });
  return { ok: true, id: modelId };
}

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1536,
    height: 984,
    minWidth: 900,
    minHeight: 640,
    titleBarStyle: 'hiddenInset',
    backgroundColor: '#0a0a12',
    icon: createVaniScriptIcon(false),
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
    },
    show: false,
    title: APP_NAME,
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
    revealMainWindow('renderer-failed-load');
  });

  mainWindow.webContents.on('did-finish-load', () => {
    log.info('Renderer finished loading');
    revealMainWindow('renderer-finished-load');
    broadcastSharedLocalModels();
  });

  mainWindow.webContents.on('dom-ready', () => {
    log.info('Renderer DOM ready');
    revealMainWindow('renderer-dom-ready');
  });

  mainWindow.webContents.on('render-process-gone', (_event, details) => {
    log.error('Renderer process gone', details);
  });

  mainWindow.webContents.on('console-message', (_event, level, message, line, sourceId) => {
    const payload = `[renderer:${level}] ${message} (${sourceId}:${line})`;
    if (level >= 2) log.warn(payload);
    else log.info(payload);
  });

  mainWindow.once('ready-to-show', () => {
    log.info('Main window ready to show');
    revealMainWindow('ready-to-show');
  });

  setTimeout(() => {
    revealMainWindow('startup-fallback');
  }, 1200);

  mainWindow.on('close', (event) => {
    if (isQuitting) return;
    event.preventDefault();
    mainWindow.hide();
  });

  mainWindow.on('closed', () => {
    mainWindow = null;
  });
}

function configureDisplayMediaCapture() {
  session.defaultSession.setDisplayMediaRequestHandler(async (request, callback) => {
    try {
      const sources = await desktopCapturer.getSources({
        types: ['window', 'screen'],
        thumbnailSize: { width: 320, height: 180 },
        fetchWindowIcons: true,
      });
      const video = sources[0];
      if (!video) return callback({});
      callback({
        video,
        audio: request.audioRequested && process.platform === 'win32' ? 'loopback' : undefined,
      });
    } catch (error) {
      log.error('Display media request failed:', error);
      callback({});
    }
  }, { useSystemPicker: true });
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
  configureDisplayMediaCapture();
  installAppMenu();
  installTray();
  createWindow();
  startMcpServer();

  app.on('activate', () => {
    showMainWindow();
  });
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});

app.on('before-quit', () => {
  isQuitting = true;
  cleanupTempDir();
  stopMcpServer();
});

app.on('second-instance', () => {
  showMainWindow();
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

ipcMain.handle('dialog:openDirectory', async () => {
  const result = await dialog.showOpenDialog(mainWindow, {
    properties: ['openDirectory', 'createDirectory'],
  });
  return result.canceled ? null : result.filePaths[0];
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

ipcMain.handle('fs:deleteFiles', async (_, { filePaths }) => {
  try {
    for (const filePath of Array.isArray(filePaths) ? filePaths : []) {
      if (!filePath || typeof filePath !== 'string') continue;
      try {
        if (fs.existsSync(filePath)) fs.rmSync(filePath, { recursive: false, force: true });
      } catch (error) {
        log.warn('Could not delete export artifact:', filePath, error.message || String(error));
      }
    }
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

ipcMain.handle('fs:writeTempTextFile', async (_, { fileName, content }) => {
  try {
    const tempDir = getTempDir();
    fs.mkdirSync(tempDir, { recursive: true });
    const safeFileName = safeName(path.basename(fileName || `vaniscript_${Date.now()}.txt`), 'temp.txt');
    const filePath = path.join(tempDir, safeFileName);
    fs.writeFileSync(filePath, String(content || ''), 'utf8');
    return { success: true, filePath };
  } catch (e) {
    return { success: false, error: e.message };
  }
});

ipcMain.handle('fs:createTempPath', async (_, { fileName }) => {
  try {
    const tempDir = getTempDir();
    fs.mkdirSync(tempDir, { recursive: true });
    const safeFileName = safeName(path.basename(fileName || `vaniscript_${Date.now()}.tmp`), 'temp.tmp');
    return { success: true, filePath: path.join(tempDir, `${Date.now()}_${safeFileName}`) };
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

function recordingsRootDir() {
  const dir = path.join(projectsRootDir(), 'Recordings');
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

function linkImportsRootDir() {
  const dir = path.join(projectsRootDir(), 'Link Imports');
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

function emitLinkImportProgress(payload) {
  if (!mainWindow || mainWindow.isDestroyed()) return;
  mainWindow.webContents.send('link-import:progress', payload);
}

function normalizeImportUrl(value) {
  const url = String(value || '').trim();
  if (!/^https?:\/\/\S+$/i.test(url)) {
    throw new Error('Enter a valid http or https link.');
  }
  return url;
}

function parseYtDlpProgress(line) {
  const trimmed = String(line || '').replace(/\u001b\[[0-9;]*m/g, '').trim();
  const templateMatch = trimmed.match(/download:([^|]+)\|([^|]*)\|([^|]*)/);
  const compactTemplateMatch = trimmed.match(/^([0-9.]+%?)\|([^|]*)\|([^|]*)$/);
  const nativeMatch = trimmed.match(/\[download\]\s+([0-9.]+)%.*?(?:at\s+([^\s]+\/s))?.*?(?:ETA\s+([0-9:]+))?/i);
  const match = templateMatch || compactTemplateMatch || nativeMatch;
  if (!match) return null;
  const rawPercent = match[1].replace('%', '').trim();
  const progress = Number.parseFloat(rawPercent);
  return {
    progress: Number.isFinite(progress) ? Math.max(0, Math.min(100, progress)) : undefined,
    speed: (match[2] || '').trim(),
    eta: (match[3] || '').trim(),
  };
}

function latestFileInDirectory(dir, startedAtMs) {
  try {
    const entries = fs.readdirSync(dir)
      .map((name) => {
        const filePath = path.join(dir, name);
        const stat = fs.statSync(filePath);
        return { filePath, stat };
      })
      .filter(({ stat }) => stat.isFile() && stat.mtimeMs >= startedAtMs - 1000)
      .sort((a, b) => b.stat.mtimeMs - a.stat.mtimeMs);
    return entries[0]?.filePath || null;
  } catch {
    return null;
  }
}

function bytesInRecentPartialFiles(dir, startedAtMs) {
  try {
    return fs.readdirSync(dir)
      .map((name) => {
        const filePath = path.join(dir, name);
        const stat = fs.statSync(filePath);
        return { name, stat };
      })
      .filter(({ name, stat }) => stat.isFile() && name.endsWith('.part') && stat.mtimeMs >= startedAtMs - 1000)
      .reduce((total, { stat }) => total + stat.size, 0);
  } catch {
    return 0;
  }
}

function cleanupRecentPartialFiles(dir, startedAtMs) {
  try {
    for (const name of fs.readdirSync(dir)) {
      if (!name.includes('.part')) continue;
      const filePath = path.join(dir, name);
      const stat = fs.statSync(filePath);
      if (stat.isFile() && stat.mtimeMs >= startedAtMs - 1000) {
        fs.rmSync(filePath, { force: true });
      }
    }
  } catch (error) {
    log.warn('Could not clean partial link import files:', error?.message || String(error));
  }
}

function humanFileSize(bytes) {
  if (!Number.isFinite(bytes) || bytes <= 0) return '';
  const units = ['B', 'KB', 'MB', 'GB'];
  let value = bytes;
  let unitIndex = 0;
  while (value >= 1024 && unitIndex < units.length - 1) {
    value /= 1024;
    unitIndex += 1;
  }
  return `${value >= 10 || unitIndex === 0 ? Math.round(value) : value.toFixed(1)} ${units[unitIndex]}`;
}

function importLinkWithYtDlp({ url, mode = 'video', jobId }) {
  const safeMode = mode === 'audio' ? 'audio' : 'video';
  const id = jobId || `link-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  const importUrl = normalizeImportUrl(url);
  const outputDir = linkImportsRootDir();
  const startedAtMs = Date.now();
  const ytDlpPath = getYtDlpPath();
  const outputTemplate = path.join(outputDir, '%(title).180B_%(id)s.%(ext)s');
  const jsRuntimeArgs = getYtDlpJavaScriptRuntimeArgs();
  const baseArgs = [
    '--no-playlist',
    '--newline',
    '--progress',
    '--no-warnings',
    '--force-ipv4',
    '--concurrent-fragments',
    '12',
    '--throttled-rate',
    '250K',
    '--retries',
    '3',
    '--fragment-retries',
    '3',
    '--extractor-retries',
    '3',
    '--socket-timeout',
    '30',
    '--progress-template',
    '%(progress._percent_str)s|%(progress._speed_str)s|%(progress._eta_str)s',
    '--print',
    'after_move:filepath',
    '-o',
    outputTemplate,
  ];
  const strategies = safeMode === 'audio'
    ? [{
        key: 'audio',
        label: 'audio stream',
        args: [...baseArgs, '-f', 'ba/b', '-x', '--audio-format', 'mp3', '--audio-quality', '0'],
        resolveMessage: 'Resolving audio stream…',
        stallTimeoutMs: 60000,
        stallMinBytes: 3 * 1024 * 1024,
      }]
    : [{
        key: 'hls',
        label: 'maximum-quality adaptive video stream',
        args: [
          ...baseArgs,
          ...jsRuntimeArgs,
          '-f',
          'bestvideo[protocol^=m3u8]+bestaudio[protocol^=m3u8]/best[protocol^=m3u8]/bv*+ba/b',
          '--merge-output-format',
          'mp4',
        ],
        resolveMessage: 'Resolving maximum-quality adaptive video stream…',
        stallTimeoutMs: 120000,
        stallMinBytes: 8 * 1024 * 1024,
      }, {
        key: 'direct',
        label: 'direct best-quality stream',
        args: [
          ...baseArgs,
          '-f',
          'bv*+ba/b',
          '--merge-output-format',
          'mp4',
        ],
        resolveMessage: 'Resolving direct video stream…',
        stallTimeoutMs: 60000,
        stallMinBytes: 3 * 1024 * 1024,
      }, {
        key: 'compatible',
        label: 'fast compatible MP4 stream',
        args: [
          ...baseArgs,
          '-f',
          'best[ext=mp4][vcodec^=avc1]/best[ext=mp4]/b',
          '--merge-output-format',
          'mp4',
        ],
        resolveMessage: 'Resolving fast compatible MP4 stream…',
        stallTimeoutMs: 60000,
        stallMinBytes: 3 * 1024 * 1024,
      }];

  const job = { proc: null, outputDir, cancelled: false };
  linkImportJobs.set(id, job);
  emitLinkImportProgress({ jobId: id, status: 'starting', progress: 0, message: 'Preparing link import…' });

  const runStrategy = (strategy, index) => new Promise((resolve) => {
    const args = [...strategy.args, importUrl];
    let stdout = '';
    let stderr = '';
    let resolvedPath = '';
    let lastProgress = 0;
    let lastOutputAt = Date.now();
    let lastStatus = 'starting';
    const strategyStartedAt = Date.now();
    let stalled = false;
    let proc;
    try {
      log.info(`Starting link import ${id} with ${strategy.key} strategy:`, ytDlpPath, args.join(' '));
      proc = spawn(ytDlpPath, args, {
        env: {
          ...process.env,
          PYTHONIOENCODING: 'utf-8',
        },
      });
    } catch (error) {
      resolve({ success: false, error: error?.message || String(error), retryable: index < strategies.length - 1 });
      return;
    }

    job.proc = proc;
    emitLinkImportProgress({
      jobId: id,
      status: 'resolving',
      progress: 0,
      message: index === 0 ? strategy.resolveMessage : `Retrying with ${strategy.label}…`,
    });

    let stdoutBuffer = '';
    let stderrBuffer = '';
    const heartbeat = setInterval(() => {
      if (job.cancelled || !proc || proc.killed) return;
      const idleMs = Date.now() - lastOutputAt;
      if (idleMs < 12000) return;
      const partialBytes = bytesInRecentPartialFiles(outputDir, startedAtMs);
      const sizeText = partialBytes ? ` (${humanFileSize(partialBytes)} downloaded)` : '';
      if (lastStatus === 'downloading') {
        emitLinkImportProgress({
          jobId: id,
          status: 'downloading',
          progress: lastProgress,
          message: `Downloading${sizeText}…`,
        });
      } else {
        emitLinkImportProgress({
          jobId: id,
          status: 'resolving',
          progress: lastProgress,
          message: `${strategy.resolveMessage} YouTube can take a minute or two before media download starts.`,
        });
      }
      if (strategy.stallTimeoutMs && Date.now() - strategyStartedAt > strategy.stallTimeoutMs && lastProgress < 2 && partialBytes < strategy.stallMinBytes) {
        stalled = true;
        proc.kill('SIGTERM');
      }
    }, 5000);

    const emitProcessLine = (line) => {
      const trimmed = line.trim();
      if (!trimmed) return;
      if (/Extracting URL|Downloading webpage|Downloading player|Solving JS challenges|Downloading m3u8 information|Downloading API JSON|Downloading android/i.test(trimmed)) {
        lastStatus = 'resolving';
        emitLinkImportProgress({ jobId: id, status: 'resolving', progress: lastProgress, message: strategy.resolveMessage });
      } else if (/Merging formats|ffmpeg/i.test(trimmed)) {
        lastStatus = 'processing';
        emitLinkImportProgress({ jobId: id, status: 'processing', progress: Math.max(lastProgress, 98), message: 'Merging video and audio…' });
      } else if (/Downloading 1 format/i.test(trimmed)) {
        lastStatus = 'downloading';
        emitLinkImportProgress({ jobId: id, status: 'downloading', progress: lastProgress, message: 'Starting download…' });
      }
    };

    const handleOutput = (chunk, source) => {
      const text = chunk.toString();
      lastOutputAt = Date.now();
      if (source === 'stderr') stderr += text;
      else stdout += text;
      let buffer = (source === 'stderr' ? stderrBuffer : stdoutBuffer) + text.replace(/\r/g, '\n');
      const lines = buffer.split(/\n/);
      buffer = lines.pop() || '';
      if (source === 'stderr') stderrBuffer = buffer;
      else stdoutBuffer = buffer;
      for (const line of lines) {
        const progress = parseYtDlpProgress(line);
        if (progress) {
          lastProgress = progress.progress ?? lastProgress;
          lastStatus = 'downloading';
          emitLinkImportProgress({
            jobId: id,
            status: 'downloading',
            progress: lastProgress,
            speed: progress.speed,
            eta: progress.eta,
            message: progress.progress !== undefined ? `Downloading ${Math.round(progress.progress)}%` : 'Downloading…',
          });
          continue;
        }
        emitProcessLine(line);
        const trimmed = line.trim();
        if (trimmed && !trimmed.startsWith('[') && !trimmed.includes('|') && !/warning|error|youtube|info/i.test(trimmed)) {
          resolvedPath = trimmed;
        }
      }
    };

    proc.stdout.on('data', (chunk) => handleOutput(chunk, 'stdout'));
    proc.stderr.on('data', (chunk) => handleOutput(chunk, 'stderr'));
    proc.on('error', (error) => {
      clearInterval(heartbeat);
      log.error(`Link import ${id} ${strategy.key} spawn error:`, error);
      emitLinkImportProgress({ jobId: id, status: 'error', progress: lastProgress, message: error?.message || String(error) });
      resolve({ success: false, error: error?.message || String(error), stderr, retryable: index < strategies.length - 1 });
    });
    proc.on('close', (code, signal) => {
      clearInterval(heartbeat);
      log.info(`Link import ${id} ${strategy.key} closed: code=${code} signal=${signal} progress=${lastProgress}`);
      if (signal === 'SIGTERM' || signal === 'SIGKILL') {
        if (stalled) {
          resolve({ success: false, stalled: true, retryable: index < strategies.length - 1, error: `${strategy.label} was throttled or stalled.` });
          return;
        }
        if (job.cancelled) {
          emitLinkImportProgress({ jobId: id, status: 'cancelled', progress: lastProgress, message: 'Import cancelled.' });
          resolve({ success: false, cancelled: true, error: 'Import cancelled.' });
          return;
        }
        resolve({ success: false, retryable: index < strategies.length - 1, error: `${strategy.label} stopped.` });
        return;
      }
      if (code !== 0) {
        const lines = stderr.split('\n').map((line) => line.trim()).filter(Boolean);
        const message = lines.findLast?.((line) => /error/i.test(line)) || lines.at(-1) || `yt-dlp exited with code ${code}`;
        log.warn(`Link import ${id} ${strategy.key} failed:`, message, stderr.slice(-1200));
        resolve({ success: false, error: message, stderr: stderr.slice(-1600), retryable: index < strategies.length - 1 });
        return;
      }
      const filePath = (resolvedPath && fs.existsSync(resolvedPath)) ? resolvedPath : latestFileInDirectory(outputDir, startedAtMs);
      if (!filePath) {
        resolve({ success: false, retryable: index < strategies.length - 1, error: 'Import finished, but no media file was found.', stderr: stderr.slice(-1600), stdout: stdout.slice(-1600) });
        return;
      }
      emitLinkImportProgress({ jobId: id, status: 'complete', progress: 100, message: 'Import complete.' });
      resolve({
        success: true,
        path: filePath,
        name: path.basename(filePath),
        directory: outputDir,
        url: pathToFileURL(filePath).toString(),
        mode: safeMode,
      });
    });
  });

  return (async () => {
    let lastResult = null;
    for (let i = 0; i < strategies.length; i += 1) {
      if (job.cancelled) break;
      const result = await runStrategy(strategies[i], i);
      lastResult = result;
      if (result?.success || result?.cancelled) {
        linkImportJobs.delete(id);
        return result;
      }
      if (!result?.retryable) break;
      cleanupRecentPartialFiles(outputDir, startedAtMs);
      emitLinkImportProgress({
        jobId: id,
        status: 'resolving',
        progress: 0,
        message: `The previous download path was too slow. Trying ${strategies[i + 1]?.label || 'another route'}…`,
      });
    }
    linkImportJobs.delete(id);
    const wasThrottled = Boolean(lastResult?.stalled);
    const message = wasThrottled
      ? 'YouTube is throttling this link too heavily for local import. Try Audio only, a different link, or download the file externally and upload it to VaniScript.'
      : (lastResult?.error || 'Link import failed.');
    cleanupRecentPartialFiles(outputDir, startedAtMs);
    emitLinkImportProgress({ jobId: id, status: 'error', progress: 0, message });
    return { ...(lastResult || { success: false }), success: false, error: message };
  })();
}

function mimeToRecordingExtension(mimeType) {
  const normalized = String(mimeType || '').toLowerCase();
  if (normalized.includes('mp4')) return 'mp4';
  if (normalized.includes('ogg')) return 'ogg';
  if (normalized.includes('wav')) return 'wav';
  if (normalized.includes('aac')) return 'aac';
  if (normalized.includes('mpeg') || normalized.includes('mp3')) return 'mp3';
  return 'webm';
}

function recordingTimestamp() {
  return new Date().toISOString().replace(/[:.]/g, '-').replace('T', '_').replace('Z', '');
}

function createRecordingSession({ mimeType, fileBaseName }) {
  const id = crypto.randomUUID ? crypto.randomUUID() : `rec-${Date.now()}-${Math.random().toString(36).slice(2)}`;
  const ext = mimeToRecordingExtension(mimeType);
  const base = safeName(fileBaseName || 'VaniScript Recording', 'VaniScript Recording');
  const tempPath = path.join(getTempDir(), `${base}_${recordingTimestamp()}_${id}.${ext}`);
  recordingSessions.set(id, {
    id,
    mimeType: mimeType || '',
    tempPath,
    base,
    bytes: 0,
  });
  return recordingSessions.get(id);
}

async function finishRecordingSession(id) {
  const session = recordingSessions.get(id);
  if (!session) return { success: false, error: 'Recording session not found.' };
  recordingSessions.delete(id);

  if (!fs.existsSync(session.tempPath) || session.bytes <= 0) {
    try { if (fs.existsSync(session.tempPath)) fs.rmSync(session.tempPath, { force: true }); } catch {}
    return { success: false, error: 'Recording produced no audio data.' };
  }

  const outputDir = recordingsRootDir();
  const outputPath = path.join(outputDir, `${session.base}_${recordingTimestamp()}.mp3`);
  try {
    const result = await runFfmpeg([
      '-y',
      '-i', session.tempPath,
      '-vn',
      '-map', '0:a:0',
      '-c:a', 'libmp3lame',
      '-b:a', '320k',
      '-ar', '48000',
      '-ac', '2',
      outputPath,
    ]);
    if (!result.success) return { success: false, error: result.error, stderr: result.stderr };
    return {
      success: true,
      path: outputPath,
      name: path.basename(outputPath),
      directory: outputDir,
      bytes: fs.existsSync(outputPath) ? fs.statSync(outputPath).size : 0,
    };
  } finally {
    try { if (fs.existsSync(session.tempPath)) fs.rmSync(session.tempPath, { force: true }); } catch (error) {
      log.warn('Could not remove temporary recording:', session.tempPath, error.message || String(error));
    }
  }
}

function cancelRecordingSession(id) {
  const session = recordingSessions.get(id);
  if (!session) return { success: true };
  recordingSessions.delete(id);
  try { if (fs.existsSync(session.tempPath)) fs.rmSync(session.tempPath, { force: true }); } catch {}
  return { success: true };
}

function getRecordingPreview(id) {
  const session = recordingSessions.get(id);
  if (!session) return { success: false, error: 'Recording session not found.' };
  if (!fs.existsSync(session.tempPath) || session.bytes <= 0) {
    return { success: false, error: 'Recording produced no previewable media.' };
  }
  return {
    success: true,
    path: session.tempPath,
    url: pathToFileURL(session.tempPath).toString(),
    bytes: session.bytes,
    mimeType: session.mimeType,
  };
}

ipcMain.handle('recording:start', async (_, { mimeType, fileBaseName } = {}) => {
  try {
    const session = createRecordingSession({ mimeType, fileBaseName });
    return { success: true, sessionId: session.id };
  } catch (e) {
    log.error('recording:start failed:', e);
    return { success: false, error: e?.message ?? String(e) };
  }
});

ipcMain.handle('recording:appendChunk', async (_, { sessionId, chunk }) => {
  try {
    const session = recordingSessions.get(sessionId);
    if (!session) return { success: false, error: 'Recording session not found.' };
    const buffer = Buffer.from(chunk);
    if (buffer.length === 0) return { success: true, bytes: session.bytes };
    fs.appendFileSync(session.tempPath, buffer);
    session.bytes += buffer.length;
    return { success: true, bytes: session.bytes };
  } catch (e) {
    log.error('recording:appendChunk failed:', e);
    return { success: false, error: e?.message ?? String(e) };
  }
});

ipcMain.handle('recording:finish', async (_, { sessionId }) => {
  try {
    return await finishRecordingSession(sessionId);
  } catch (e) {
    log.error('recording:finish failed:', e);
    return { success: false, error: e?.message ?? String(e) };
  }
});

ipcMain.handle('recording:preview', async (_, { sessionId }) => {
  try {
    return getRecordingPreview(sessionId);
  } catch (e) {
    log.error('recording:preview failed:', e);
    return { success: false, error: e?.message ?? String(e) };
  }
});

ipcMain.handle('recording:cancel', async (_, { sessionId }) => {
  try {
    return cancelRecordingSession(sessionId);
  } catch (e) {
    log.error('recording:cancel failed:', e);
    return { success: false, error: e?.message ?? String(e) };
  }
});

ipcMain.handle('recording:openFolder', async () => {
  try {
    const directory = recordingsRootDir();
    await shell.openPath(directory);
    return { success: true, directory };
  } catch (e) {
    return { success: false, error: e?.message ?? String(e) };
  }
});

ipcMain.handle('link-import:start', async (_, { url, mode, jobId } = {}) => {
  try {
    return await importLinkWithYtDlp({ url, mode, jobId });
  } catch (e) {
    log.error('link-import:start failed:', e);
    return { success: false, error: e?.message ?? String(e) };
  }
});

ipcMain.handle('link-import:cancel', async (_, { jobId } = {}) => {
  try {
    const job = linkImportJobs.get(jobId);
    if (job) job.cancelled = true;
    if (job?.proc && !job.proc.killed) {
      job.proc.kill('SIGTERM');
    }
    return { success: true };
  } catch (e) {
    return { success: false, error: e?.message ?? String(e) };
  }
});

ipcMain.handle('link-import:openFolder', async () => {
  try {
    const directory = linkImportsRootDir();
    await shell.openPath(directory);
    return { success: true, directory };
  } catch (e) {
    return { success: false, error: e?.message ?? String(e) };
  }
});

function escapeFfmpegFilterPath(filePath) {
  return String(filePath || '')
    .replace(/\\/g, '\\\\')
    .replace(/:/g, '\\:')
    .replace(/'/g, "\\'");
}

function assSubtitleFilter(filePath) {
  return `ass=filename='${escapeFfmpegFilterPath(filePath)}'`;
}

function assSubtitleFilterGraph(filePath) {
  return `ass=filename=${escapeFfmpegFilterPath(filePath).replace(/ /g, '\\ ')}`;
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

ipcMain.handle('ffmpeg:extractAudioForTranscription', async (_, { inputPath }) => {
  try {
    const tempDir = getTempDir();
    fs.mkdirSync(tempDir, { recursive: true });
    const outputPath = path.join(tempDir, `video_audio_${Date.now()}.wav`);
    if (!fs.existsSync(inputPath)) {
      return { success: false, error: `Input file not found: ${inputPath}` };
    }
    const result = await runFfmpeg([
      '-y',
      '-i', inputPath,
      '-vn',
      '-ar', '16000',
      '-ac', '1',
      '-c:a', 'pcm_s16le',
      outputPath,
    ]);
    if (result.success) return { success: true, outputPath };
    return { success: false, error: result.error, stderr: result.stderr };
  } catch (e) {
    log.error('ffmpeg:extractAudioForTranscription handler failed:', e);
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

ipcMain.handle('ffmpeg:getVideoInfo', async (_, { inputPath }) => {
  const stderr = await new Promise((resolve) => {
    const ffmpegPath = getFfmpegPath();
    log.info('FFmpeg probe cmd:', ffmpegPath, '-hide_banner -i', inputPath);
    let collected = '';
    let proc;
    try {
      proc = spawn(ffmpegPath, ['-hide_banner', '-i', inputPath], { stdio: ['ignore', 'ignore', 'pipe'] });
    } catch (e) {
      return resolve('');
    }
    proc.stderr.on('data', d => { collected += d.toString(); });
    proc.on('close', () => resolve(collected));
    proc.on('error', () => resolve(collected));
  });
  const videoMatch = stderr.match(/Video:\s.*?,\s*(\d{2,5})x(\d{2,5})[\s,\[]/);
  const durationMatch = stderr.match(/Duration:\s*(\d+):(\d+):(\d+\.?\d*)/);
  const fpsMatch = stderr.match(/,\s*([0-9]+(?:\.[0-9]+)?)\s*fps[, ]/);
  if (!videoMatch) return { success: false, error: 'Could not read video dimensions.' };
  const durationSec = durationMatch
    ? (parseInt(durationMatch[1], 10) * 3600) + (parseInt(durationMatch[2], 10) * 60) + parseFloat(durationMatch[3])
    : 0;
  const fps = fpsMatch ? Number(fpsMatch[1]) : undefined;
  return {
    success: true,
    width: Number(videoMatch[1]),
    height: Number(videoMatch[2]),
    durationSec,
    fps,
  };
});

ipcMain.handle('ffmpeg:extractWaveformPeaks', async (_, {
  inputPath,
  startSec = 0,
  durationSec = 0,
  peakCount = 180,
}) => {
  try {
    if (!inputPath || !fs.existsSync(inputPath)) {
      return { success: false, error: `Input file not found: ${inputPath}` };
    }

    const ffmpegPath = getFfmpegPath();
    const safeDuration = Math.max(0.1, Number(durationSec) || 0.1);
    const safePeakCount = Math.min(600, Math.max(40, Number(peakCount) || 180));
    const args = [
      '-v', 'error',
      '-ss', String(Math.max(0, Number(startSec) || 0)),
      '-t', String(safeDuration),
      '-i', inputPath,
      '-vn',
      '-ac', '1',
      '-ar', '8000',
      '-f', 'f32le',
      'pipe:1',
    ];

    log.info('FFmpeg waveform cmd:', ffmpegPath, args.join(' '));
    const result = await new Promise(resolve => {
      let stderr = '';
      const chunks = [];
      let proc;
      try {
        proc = spawn(ffmpegPath, args, { stdio: ['ignore', 'pipe', 'pipe'] });
      } catch (e) {
        resolve({ success: false, error: e.message, stderr: '' });
        return;
      }
      proc.stdout.on('data', d => chunks.push(Buffer.from(d)));
      proc.stderr.on('data', d => { stderr += d.toString(); });
      proc.on('error', e => resolve({ success: false, error: e.message, stderr }));
      proc.on('close', code => {
        if (code !== 0) {
          resolve({ success: false, error: `FFmpeg exited with code ${code}`, stderr: stderr.slice(-800) });
          return;
        }
        resolve({ success: true, buffer: Buffer.concat(chunks), stderr });
      });
    });

    if (!result.success) return result;
    const sampleCount = Math.floor(result.buffer.byteLength / 4);
    if (sampleCount === 0) return { success: false, error: 'No waveform samples returned.' };

    const view = new DataView(result.buffer.buffer, result.buffer.byteOffset, sampleCount * 4);
    const bucketSize = Math.max(1, Math.floor(sampleCount / safePeakCount));
    const peaks = [];
    for (let i = 0; i < safePeakCount; i++) {
      const start = i * bucketSize;
      const end = i === safePeakCount - 1 ? sampleCount : Math.min(sampleCount, start + bucketSize);
      let peak = 0;
      for (let j = start; j < end; j++) peak = Math.max(peak, Math.abs(view.getFloat32(j * 4, true) || 0));
      peaks.push(Math.min(1, peak));
    }
    const maxPeak = Math.max(0.0001, ...peaks);
    return { success: true, peaks: peaks.map(peak => peak / maxPeak) };
  } catch (e) {
    log.error('ffmpeg:extractWaveformPeaks failed:', e);
    return { success: false, error: e.message || String(e) };
  }
});

ipcMain.handle('ffmpeg:renderShortPreviewFrame', async (_, {
  inputVideoPath,
  outputPath,
  atSec,
  videoFilter,
  videoFilterGraph,
  assSubtitlePath,
}) => {
  try {
    const args = videoFilterGraph ? [
      '-y',
      '-ss', String(atSec),
      '-i', inputVideoPath,
      '-frames:v', '1',
      '-filter_complex', `${videoFilterGraph};[vbase]${assSubtitleFilterGraph(assSubtitlePath)}[vout]`,
      '-map', '[vout]',
      '-update', '1',
      outputPath,
    ] : [
      '-y',
      '-ss', String(atSec),
      '-i', inputVideoPath,
      '-frames:v', '1',
      '-vf', `setpts=PTS-STARTPTS,${videoFilter},${assSubtitleFilter(assSubtitlePath)}`,
      '-af', 'asetpts=PTS-STARTPTS',
      '-update', '1',
      outputPath,
    ];
    const result = await runFfmpeg(args);
    return result.success ? { success: true, outputPath } : result;
  } catch (e) {
    log.error('ffmpeg:renderShortPreviewFrame failed:', e);
    return { success: false, error: e.message || String(e) };
  }
});

ipcMain.handle('ffmpeg:exportShortClip', async (_, {
  inputVideoPath,
  outputPath,
  startSec,
  durationSec,
  videoFilter,
  videoFilterGraph,
  assSubtitlePath,
  crf,
  format,
}) => {
  try {
    const args = videoFilterGraph ? [
      '-y',
      '-ss', String(startSec),
      '-i', inputVideoPath,
      '-t', String(durationSec),
      '-filter_complex', `${videoFilterGraph};[vbase]${assSubtitleFilterGraph(assSubtitlePath)}[vout]`,
      '-map', '[vout]',
      '-map', '0:a?',
      '-af', 'asetpts=PTS-STARTPTS',
      '-c:v', 'libx264',
      '-preset', 'veryfast',
      '-crf', String(crf ?? 18),
      '-c:a', 'aac',
      '-b:a', '160k',
      '-movflags', '+faststart',
      format === 'mov' ? '-f' : null,
      format === 'mov' ? 'mov' : null,
      outputPath,
    ] : [
      '-y',
      '-ss', String(startSec),
      '-i', inputVideoPath,
      '-t', String(durationSec),
      '-vf', `setpts=PTS-STARTPTS,${videoFilter},${assSubtitleFilter(assSubtitlePath)}`,
      '-af', 'asetpts=PTS-STARTPTS',
      '-c:v', 'libx264',
      '-preset', 'veryfast',
      '-crf', String(crf ?? 18),
      '-c:a', 'aac',
      '-b:a', '160k',
      '-movflags', '+faststart',
      format === 'mov' ? '-f' : null,
      format === 'mov' ? 'mov' : null,
      outputPath,
    ];
    const result = await runFfmpeg(args.filter(Boolean));
    return result.success ? { success: true, outputPath } : result;
  } catch (e) {
    log.error('ffmpeg:exportShortClip failed:', e);
    return { success: false, error: e.message || String(e) };
  }
});

ipcMain.handle('hyperframes:exportShortClip', async (_, {
  jobId,
  project,
  inputVideoPath,
  outputPath,
  format,
  qualityPreset,
}) => {
  const renderJobId = String(jobId || `hyperframes_${Date.now()}`);
  const abortController = new AbortController();
  hyperframesRenderControllers.set(renderJobId, abortController);
  try {
    if (!project || !outputPath || !inputVideoPath) {
      return { success: false, error: 'Missing HyperFrames render project, output path, or input video path.' };
    }
    const ffmpegPath = getFfmpegPath();
    mainWindow?.webContents.send('hyperframes:export-progress', {
      jobId: renderJobId,
      status: 'starting',
      progress: 0,
      stage: 'prepare',
      message: 'Preparing render job',
    });
    return await renderShortClipWithHyperFrames({
      app,
      project,
      inputVideoPath,
      outputPath,
      format,
      qualityPreset,
      ffmpegPath,
      log,
      abortSignal: abortController.signal,
      onProgress: (payload) => {
        mainWindow?.webContents.send('hyperframes:export-progress', {
          jobId: renderJobId,
          ...payload,
        });
      },
    });
  } catch (e) {
    if (abortController.signal.aborted || e?.name === 'RenderCancelledError' || e?.message === 'render_cancelled') {
      try { if (outputPath && fs.existsSync(outputPath)) fs.rmSync(outputPath, { force: true }); } catch {}
      return { success: false, cancelled: true, error: 'Export cancelled' };
    }
    log.error('hyperframes:exportShortClip failed:', e);
    return { success: false, error: e.message || String(e) };
  } finally {
    hyperframesRenderControllers.delete(renderJobId);
  }
});

ipcMain.handle('hyperframes:cancelExport', async (_, { jobId }) => {
  const renderJobId = String(jobId || '');
  const controller = hyperframesRenderControllers.get(renderJobId);
  if (!controller) return { success: false, error: 'No active HyperFrames export job.' };
  controller.abort(new Error('Export cancelled'));
  hyperframesRenderControllers.delete(renderJobId);
  return { success: true };
});

async function getSourceMediaInfoHelper(inputPath, originalURL, title, durationSec) {
  if (!inputPath || !fs.existsSync(inputPath)) {
    return null;
  }
  try {
    const stats = fs.statSync(inputPath);
    const fileSizeBytes = stats.size;
    const fileName = path.basename(inputPath);
    const container = path.extname(inputPath).replace('.', '').toLowerCase();
    
    // Probe with FFmpeg to get metadata
    const stderr = await new Promise((resolve) => {
      const ffmpegPath = getFfmpegPath();
      let collected = '';
      let proc;
      try {
        proc = spawn(ffmpegPath, ['-hide_banner', '-i', inputPath], { stdio: ['ignore', 'ignore', 'pipe'] });
      } catch (e) {
        return resolve('');
      }
      proc.stderr.on('data', d => { collected += d.toString(); });
      proc.on('close', () => resolve(collected));
      proc.on('error', () => resolve(collected));
    });

    const isVideo = /Stream #.*Video:/i.test(stderr);
    const kind = isVideo ? 'video' : 'audio';

    const videoMatch = stderr.match(/Video:\s.*?,\s*(\d{2,5})x(\d{2,5})[\s,\[]/);
    const durationMatch = stderr.match(/Duration:\s*(\d+):(\d+):(\d+\.?\d*)/);
    const fpsMatch = stderr.match(/,\s*([0-9]+(?:\.[0-9]+)?)\s*fps[, ]/);
    
    let videoCodec = null;
    const videoStreamMatch = stderr.match(/Stream #.*Video:\s*([a-zA-Z0-9_-]+)/);
    if (videoStreamMatch) {
      videoCodec = videoStreamMatch[1];
    }

    let audioCodec = null;
    const audioStreamMatch = stderr.match(/Stream #.*Audio:\s*([a-zA-Z0-9_-]+)/);
    if (audioStreamMatch) {
      audioCodec = audioStreamMatch[1];
    }

    let audioSampleRateHz = null;
    const sampleRateMatch = stderr.match(/,\s*(\d+)\s*Hz/);
    if (sampleRateMatch) {
      audioSampleRateHz = Number(sampleRateMatch[1]);
    }

    let audioChannelCount = null;
    if (/mono/i.test(stderr)) {
      audioChannelCount = 1;
    } else if (/stereo/i.test(stderr)) {
      audioChannelCount = 2;
    } else {
      const channelsMatch = stderr.match(/,\s*(\d+)\s*channels/i);
      if (channelsMatch) {
        audioChannelCount = Number(channelsMatch[1]);
      }
    }

    const resolvedDuration = durationMatch
      ? (parseInt(durationMatch[1], 10) * 3600) + (parseInt(durationMatch[2], 10) * 60) + parseFloat(durationMatch[3])
      : (durationSec || 0);

    const width = videoMatch ? Number(videoMatch[1]) : null;
    const height = videoMatch ? Number(videoMatch[2]) : null;
    const fps = fpsMatch ? Number(fpsMatch[1]) : null;

    return {
      originalURL: originalURL || null,
      filePath: inputPath,
      fileName,
      title: title || null,
      kind,
      durationSec: resolvedDuration,
      fileSizeBytes,
      width,
      height,
      frameRate: fps,
      videoCodec,
      audioCodec,
      container,
      overallBitrateBps: resolvedDuration > 0 ? (fileSizeBytes * 8) / resolvedDuration : null,
      importedAt: new Date().toISOString()
    };
  } catch (err) {
    log.error('getSourceMediaInfoHelper failed:', err);
    return null;
  }
}

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
ipcMain.handle('shell:openPath', async (_, filePath) => {
  return await shell.openPath(filePath);
});
ipcMain.handle('shell:showItemInFolder', async (_, filePath) => {
  shell.showItemInFolder(filePath);
});
ipcMain.handle('ffmpeg:getSourceMediaInfo', async (_, { inputPath, originalURL, title, durationSec }) => {
  return await getSourceMediaInfoHelper(inputPath, originalURL, title, durationSec);
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
    const project = readProject(id);
    if (project && project.session) {
      project.session = normalizeImportedProjectSession(project.session, { projectId: project.id });
    }
    if (project && project.session && !project.session.sourceMediaInfo) {
      const mediaPath = project.session.originalVideoPath || project.session.sourceFile;
      if (mediaPath && fs.existsSync(mediaPath)) {
        try {
          const info = await getSourceMediaInfoHelper(
            mediaPath,
            project.session.originalVideoPath ? undefined : project.session.sourceFile,
            project.name || project.session.sourceFileName,
            project.session.chunks?.reduce((acc, c) => acc + (c.duration || 0), 0)
          );
          if (info) {
            project.session.sourceMediaInfo = info;
            saveProjectRecord(project);
          }
        } catch (err) {
          log.warn('Failed to retrospectively probe media:', err);
        }
      }
    }
    return { ok: true, project };
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
    writeLibraryBundle(projects, result.filePath);
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

    // Read the first 21 bytes to check format
    const fd = fs.openSync(filePath, 'r');
    const magicBuf = Buffer.alloc(21);
    let bytesRead = 0;
    try {
      bytesRead = fs.readSync(fd, magicBuf, 0, 21, 0);
    } finally {
      fs.closeSync(fd);
    }
    const headerStr = magicBuf.toString('utf8');

    if (headerStr === 'VANISCRIPT_BUNDLE_V2\n') {
      const project = importProjectBundle(filePath);
      return { ok: true, project };
    } else if (headerStr === 'VANISCRIPT_LIBRARY_V2\n') {
      const imported = await importLibraryBundle(filePath);
      return { ok: true, project: imported[0] || null };
    } else {
      // Check file size before reading the whole file to prevent crashes
      const size = fs.statSync(filePath).size;
      if (size > 50 * 1024 * 1024) {
        throw new Error(`File is too large (${(size / (1024 * 1024)).toFixed(1)} MB) and does not have a valid streaming header.`);
      }

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
      } else if (raw.format === 'vaniscript-project-v1') {
        const project = importProjectBundle(filePath);
        return { ok: true, project };
      } else {
        throw new Error('Unsupported or corrupted VaniScript file format.');
      }
    }
  } catch (error) {
    return { ok: false, error: error.message || String(error) };
  }
});

// ─── IPC: Local ASR ──────────────────────────────────────────────────────────
ipcMain.handle('local-models:scan', async () => broadcastSharedLocalModels());

ipcMain.handle('local-models:reconcile', async (_event, { asrIds = [], translationIds = [] } = {}) => {
  try {
    const asr = {};
    const translation = {};

    for (const modelId of asrIds) {
      asr[modelId] = isParakeetModel(modelId)
        ? summarizeParakeetModel(modelId)
        : summarizeWhisperModel(modelId);
    }

    for (const modelId of translationIds) {
      translation[modelId] = summarizeTranslationModel(modelId);
    }

    return { ok: true, asr, translation };
  } catch (error) {
    return { ok: false, asr: {}, translation: {}, error: error.message || String(error) };
  }
});

ipcMain.handle('local-asr:installModel', async (_event, { modelId }) => {
  try {
    if (isParakeetModel(modelId)) {
      await callLocalParakeetWorker({ type: 'install_model', modelId: PARAKEET_MODEL_MAP[modelId] });
      broadcastSharedLocalModels();
      return { ok: true, id: modelId };
    }
    const result = await callLocalWhisperWorker({ type: 'install_model', modelId });
    broadcastSharedLocalModels();
    return { ok: true, id: modelId, path: result?.path ?? null };
  } catch (e) {
    return { ok: false, id: modelId, error: e?.message ?? String(e) };
  }
});

ipcMain.handle('local-asr:removeModel', async (_event, { modelId }) => {
  try {
    if (isParakeetModel(modelId)) {
      const result = removeLocalModelFiles('parakeet', PARAKEET_MODEL_MAP[modelId].replace('/', '_'));
      broadcastSharedLocalModels();
      return result;
    }
    const result = removeLocalModelFiles('whisper', modelId);
    broadcastSharedLocalModels();
    return result;
  } catch (e) {
    return { ok: false, id: modelId, error: e?.message ?? String(e) };
  }
});

ipcMain.handle('local-translation:installModel', async (_event, { modelId }) => {
  try {
    const result = await callLocalTranslationWorker({ type: 'install_model', modelId });
    broadcastSharedLocalModels();
    return { ok: true, id: modelId, path: result.path ?? null };
  } catch (error) {
    return { ok: false, id: modelId, error: error.message || String(error) };
  }
});

ipcMain.handle('local-translation:removeModel', async (_event, { modelId }) => {
  try {
    removeTranslationModel(resolveLocalTranslationStorageDir(), modelId);
    broadcastSharedLocalModels();
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
  const modelPath = resolveInstalledModelPath(resolveLocalTranslationStorageDir(), payload?.modelId);
  if (!modelPath) {
    throw new Error(`Local translation model ${payload?.modelId || ''} is not installed. Download it in Settings.`);
  }
  return callLocalTranslationWorker({ type: 'translate_text', ...payload });
});

ipcMain.handle('local-asr:transcribeChunk', async (_event, { modelId, chunkPath, options = {} }) => {
  if (!chunkPath || !fs.existsSync(chunkPath)) throw new Error(`Chunk file not found: ${chunkPath}`);
  if (isParakeetModel(modelId)) {
    const parakeetStatus = summarizeParakeetModel(modelId);
    if (parakeetStatus.status !== 'downloaded') {
      throw new Error(`Local ASR model ${modelId} is not installed. Download it in Settings.`);
    }
    const wavBuffer = fs.readFileSync(chunkPath);
    const pcm = decodeWavToFloat32(wavBuffer);
    return callLocalParakeetWorker({
      type: 'transcribe',
      modelId: PARAKEET_MODEL_MAP[modelId],
      audioData: Buffer.from(pcm.buffer, pcm.byteOffset, pcm.byteLength),
    });
  }
  const whisperStatus = summarizeWhisperModel(modelId);
  if (whisperStatus.status !== 'downloaded') {
    throw new Error(`Local ASR model ${modelId} is not installed. Download it in Settings.`);
  }
  return callLocalWhisperWorker({ type: 'transcribe_chunk', modelId, chunkPath, options });
});

log.info('VaniScript main process ready');

// ─── MCP Server & Renderer IPC Bridge ───────────────────────────────────────
let mcpHttpServer = null;
const activeSseConnections = new Map(); // sessionId -> response object
const pendingMcpRequests = new Map(); // requestId -> { resolve, reject }

function startMcpServer() {
  const http = require('http');
  const { parse: parseUrl } = require('url');

  mcpHttpServer = http.createServer((req, res) => {
    const parsed = parseUrl(req.url, true);
    const pathname = parsed.pathname;

    // Set CORS headers
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

    if (req.method === 'OPTIONS') {
      res.writeHead(204);
      res.end();
      return;
    }

    if (pathname === '/sse' && req.method === 'GET') {
      res.writeHead(200, {
        'Content-Type': 'text/event-stream',
        'Cache-Control': 'no-cache',
        'Connection': 'keep-alive',
      });

      const sessionId = crypto.randomUUID();
      activeSseConnections.set(sessionId, res);

      // Send the initial event indicating where the client should POST messages
      res.write(`event: endpoint\ndata: /message?sessionId=${sessionId}\n\n`);

      req.on('close', () => {
        activeSseConnections.delete(sessionId);
        log.info(`MCP SSE client disconnected: ${sessionId}`);
      });
      
      log.info(`MCP SSE client connected: ${sessionId}`);
      return;
    }

    if (pathname === '/message' && req.method === 'POST') {
      const sessionId = parsed.query.sessionId;
      let body = '';
      req.on('data', chunk => { body += chunk; });
      req.on('end', async () => {
        try {
          const rpc = JSON.parse(body);
          log.info(`MCP JSON-RPC request for session ${sessionId}:`, rpc.method);

          // Standard SSE protocol: POST receives immediate 202, actual response goes via SSE
          res.writeHead(202);
          res.end();

          const sseResponse = activeSseConnections.get(sessionId);
          if (!sseResponse) {
            log.error(`No active SSE connection for session ${sessionId}`);
            return;
          }

          if (rpc.method === 'initialize') {
            const response = {
              jsonrpc: '2.0',
              id: rpc.id,
              result: {
                protocolVersion: '2024-11-05',
                capabilities: {
                  tools: {}
                },
                serverInfo: {
                  name: 'vaniscript-electron-mcp',
                  version: '1.0.0'
                }
              }
            };
            sseResponse.write(`event: message\ndata: ${JSON.stringify(response)}\n\n`);
            return;
          }

          if (rpc.method === 'notifications/initialized') {
            return; // no response
          }

          if (rpc.method === 'tools/list') {
            const response = {
              jsonrpc: '2.0',
              id: rpc.id,
              result: {
                tools: [
                  {
                    name: 'get_project_state',
                    description: 'Get the active VaniScript project state (session, settings, screen, shorts plans, styles)',
                    inputSchema: { type: 'object', properties: {} }
                  },
                  {
                    name: 'update_chunk_text',
                    description: 'Update the transcription or translation text of a segment',
                    inputSchema: {
                      type: 'object',
                      properties: {
                        chunkIndex: { type: 'number', description: 'Index of the segment (0-based)' },
                        original: { type: 'string', description: 'New original transcript text (optional)' },
                        translated: { type: 'string', description: 'New translation text (optional)' }
                      },
                      required: ['chunkIndex']
                    }
                  },
                  {
                    name: 'approve_chunk',
                    description: 'Approve or revoke approval for a specific segment',
                    inputSchema: {
                      type: 'object',
                      properties: {
                        chunkIndex: { type: 'number', description: 'Index of the segment (0-based)' },
                        approved: { type: 'boolean', description: 'True to approve, false to revoke' }
                      },
                      required: ['chunkIndex', 'approved']
                    }
                  },
                  {
                    name: 'get_subtitle_style',
                    description: 'Get active subtitle style settings',
                    inputSchema: { type: 'object', properties: {} }
                  },
                  {
                    name: 'update_subtitle_style',
                    description: 'Update the style properties for video subtitles',
                    inputSchema: {
                      type: 'object',
                      properties: {
                        stylePatch: {
                          type: 'object',
                          description: 'Partial patch for subtitle style parameters (textColor, fontSize, fontFamily, bold, outline, shadow, etc.)'
                        }
                      },
                      required: ['stylePatch']
                    }
                  },
                  {
                    name: 'get_shorts_plans',
                    description: 'List all vertical shorts clip plans planned in timeline',
                    inputSchema: { type: 'object', properties: {} }
                  },
                  {
                    name: 'create_shorts_plan',
                    description: 'Create a new vertical shorts plan segment in timeline',
                    inputSchema: {
                      type: 'object',
                      properties: {
                        plan: {
                          type: 'object',
                          description: 'Plan properties like title, start (MM:SS), end (MM:SS), hook, summary, etc.'
                        }
                      },
                      required: ['plan']
                    }
                  },
                  {
                    name: 'set_background_settings',
                    description: 'Update background settings for active shorts plan (solid color, blur, linear/radial gradient, feathering)',
                    inputSchema: {
                      type: 'object',
                      properties: {
                        settings: {
                          type: 'object',
                          description: 'Partial background configuration properties (e.g. solidEnabled, blurEnabled, featherTop, etc.)'
                        }
                      },
                      required: ['settings']
                    }
                  },
                  {
                    name: 'trigger_render',
                    description: 'Trigger rendering and export for a shorts plan index',
                    inputSchema: {
                      type: 'object',
                      properties: {
                        planIndex: { type: 'number', description: 'Index of the shorts plan to export' }
                      },
                      required: ['planIndex']
                    }
                  }
                ]
              }
            };
            sseResponse.write(`event: message\ndata: ${JSON.stringify(response)}\n\n`);
            return;
          }

          if (rpc.method === 'tools/call') {
            const { name, arguments: args } = rpc.params || {};
            if (!mainWindow) {
              const errResponse = {
                jsonrpc: '2.0',
                id: rpc.id,
                error: { code: -32603, message: 'VaniScript main window is not active.' }
              };
              sseResponse.write(`event: message\ndata: ${JSON.stringify(errResponse)}\n\n`);
              return;
            }

            const requestId = crypto.randomUUID();
            pendingMcpRequests.set(requestId, {
              resolve: (result) => {
                const response = {
                  jsonrpc: '2.0',
                  id: rpc.id,
                  result: {
                    content: [
                      { type: 'text', text: typeof result === 'string' ? result : JSON.stringify(result, null, 2) }
                    ]
                  }
                };
                sseResponse.write(`event: message\ndata: ${JSON.stringify(response)}\n\n`);
              },
              reject: (error) => {
                const response = {
                  jsonrpc: '2.0',
                  id: rpc.id,
                  error: { code: -32603, message: error.message || String(error) }
                };
                sseResponse.write(`event: message\ndata: ${JSON.stringify(response)}\n\n`);
              }
            });

            // Forward tool call to React renderer
            mainWindow.webContents.send('mcp:call-tool', { name, arguments: args, requestId });
            return;
          }

          // Unhandled
          const unhandled = {
            jsonrpc: '2.0',
            id: rpc.id,
            error: { code: -32601, message: `Method not found: ${rpc.method}` }
          };
          sseResponse.write(`event: message\ndata: ${JSON.stringify(unhandled)}\n\n`);
        } catch (err) {
          log.error('Error parsing JSON-RPC request:', err);
        }
      });
      return;
    }

    res.writeHead(404);
    res.end();
  });

  mcpHttpServer.listen(19789, '127.0.0.1', () => {
    log.info('MCP HTTP/SSE Server listening on http://127.0.0.1:19789/sse');
  });

  mcpHttpServer.on('error', (err) => {
    log.error('MCP Server error:', err);
  });
}

function stopMcpServer() {
  if (mcpHttpServer) {
    try {
      mcpHttpServer.close();
      log.info('MCP HTTP/SSE Server closed.');
    } catch (e) {
      log.error('Error closing MCP server:', e);
    }
    mcpHttpServer = null;
  }
}

// ─── Embedded Grok chat (headless CLI) ───────────────────────────────────────
// Mirrors the Apple Silicon GrokAgentService: spawn the locally installed `grok`
// CLI headless against the in-app MCP SSE server (port 19789). That server already
// forwards tool calls to the renderer through the existing mcp:call-tool bridge, so
// Grok's tools are executed via the same executeMcpTool path. There is NO silent
// fallback to Gemini or any other provider.
const GROK_MCP_PORT = 19789;
const GROK_EMBEDDED_SERVER_ID = 'vaniscript_embedded';

function resolveGrokExecutable() {
  const candidates = [
    path.join(os.homedir(), '.grok', 'bin', 'grok'),
    '/usr/local/bin/grok',
    '/opt/homebrew/bin/grok',
  ];
  for (const candidate of candidates) {
    try {
      if (fs.existsSync(candidate) && fs.statSync(candidate).isFile()) return candidate;
    } catch { /* ignore */ }
  }
  try {
    const resolved = execSync('command -v grok', { encoding: 'utf8' }).trim();
    if (resolved) return resolved;
  } catch { /* ignore */ }
  return null;
}

function ensureGrokWorkspace() {
  const dir = path.join(app.getPath('userData'), 'GrokAgentWorkspace');
  fs.mkdirSync(dir, { recursive: true });
  try { fs.chmodSync(dir, 0o700); } catch { /* ignore */ }
  return dir;
}

function buildGrokPrompt(messages, systemPrompt) {
  const conversation = (messages || [])
    .filter((m) => m.role === 'user' || m.role === 'assistant')
    .map((m) => `${m.role === 'user' ? 'User' : 'Assistant'}: ${m.text}`)
    .join('\n\n');
  const base = systemPrompt || `You are the embedded VaniScript text assistant. Reply directly in this VaniScript chat panel.

Use only the MCP server named ${GROK_EMBEDDED_SERVER_ID} for VaniScript project information and actions. Do not use shell commands, files, browser, computer-use, web, skills, plugins, or any other MCP server.

For requests about the current project, prefer the narrowest authoritative read tool (get_project_state, get_subtitle_style, get_shorts_plans) and the edit tools available on the ${GROK_EMBEDDED_SERVER_ID} server. Never claim an edit occurred unless the MCP tool confirms it.

Reply in the same language as the user's latest message. Keep replies concise and describe completed actions clearly.`;
  return `${base}\n\nConversation:\n${conversation}\n\nAssistant:`;
}

// Tolerant parser for `grok`'s streaming-json output. The exact shape should be
// verified against `grok --help` / real output; the branches below cover the most
// common streaming-json dialects.
function extractGrokStreamingText(obj) {
  if (!obj || typeof obj !== 'object') return '';
  if (typeof obj.text === 'string' && obj.text) return obj.text;
  if (Array.isArray(obj.content)) {
    return obj.content.map((c) => (typeof c === 'string' ? c : (c?.text || c?.input || ''))).join('');
  }
  if (obj.message && typeof obj.message === 'object') {
    if (typeof obj.message.content === 'string') return obj.message.content;
    if (Array.isArray(obj.message.content)) return obj.message.content.map((c) => c?.text || '').join('');
  }
  if (typeof obj.delta === 'string' && obj.delta) return obj.delta;
  return '';
}

ipcMain.handle('grok:chat', async (event, { messages, systemPrompt, model } = {}) => {
  const sender = event.sender;
  const grokPath = resolveGrokExecutable();
  if (!grokPath) {
    sender.send('grok:error', {
      error: 'grokNotInstalled',
      message: 'Grok CLI was not found. Install the Grok CLI (for example via Homebrew or `curl` from xAI) and run `grok login` before using the embedded Grok chat.',
    });
    return { ok: false, error: 'grokNotInstalled' };
  }

  const workspace = ensureGrokWorkspace();
  const mcpEndpoint = `http://127.0.0.1:${GROK_MCP_PORT}/sse`;
  const configOverride = `mcp_servers.${GROK_EMBEDDED_SERVER_ID}={url="${mcpEndpoint}", default_tools_approval_mode="approve", required=true}`;
  const prompt = buildGrokPrompt(messages, systemPrompt);
  const resolvedModel = model || 'grok-4.5';

  const child = spawn(grokPath, [
    '-p',
    '--output-format', 'streaming-json',
    '--ephemeral',
    '--model', resolvedModel,
    '--ignore-user-config',
    '--sandbox', 'read-only',
    '-c', 'approval_policy="never"',
    '-c', configOverride,
    '-C', workspace,
    '-',
  ], {
    cwd: workspace,
    env: {
      ...process.env,
      NO_PROXY: '127.0.0.1,localhost',
      no_proxy: '127.0.0.1,localhost',
    },
  });

  let buffer = '';

  const flushLine = (line) => {
    if (!line) return;
    try {
      const obj = JSON.parse(line);
      const text = extractGrokStreamingText(obj);
      if (text) sender.send('grok:chunk', { text });
    } catch { /* not a complete JSON line yet */ }
  };

  child.stdout.on('data', (d) => {
    buffer += d.toString();
    let idx;
    while ((idx = buffer.indexOf('\n')) >= 0) {
      const line = buffer.slice(0, idx).trim();
      buffer = buffer.slice(idx + 1);
      flushLine(line);
    }
  });

  child.stderr.on('data', (d) => {
    log.warn('[grok stderr]', String(d).trim());
  });

  child.on('error', (err) => {
    sender.send('grok:error', { error: 'launchFailed', message: `Could not start Grok: ${err.message}` });
  });

  child.on('close', (code) => {
    const tail = buffer.trim();
    if (tail) flushLine(tail);
    if (code === 0) {
      sender.send('grok:done', {});
    } else {
      sender.send('grok:error', { error: 'unavailable', message: `Grok finished with exit code ${code}.` });
    }
  });

  try {
    child.stdin.write(prompt);
    child.stdin.end();
  } catch (err) {
    sender.send('grok:error', { error: 'launchFailed', message: `Could not send prompt to Grok: ${err.message}` });
  }

  return { ok: true };
});

// Receive tool responses from renderer and route to pending client promises
ipcMain.handle('mcp:tool-response', async (_event, { requestId, success, result, error }) => {
  const pending = pendingMcpRequests.get(requestId);
  if (pending) {
    pendingMcpRequests.delete(requestId);
    if (success) {
      pending.resolve(result);
    } else {
      pending.reject(new Error(error));
    }
  }
});
