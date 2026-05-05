'use strict';

const { app, BrowserWindow, ipcMain, shell, dialog, Tray, Menu, nativeImage } = require('electron');
const path = require('path');
const fs = require('fs');
const { spawn, fork } = require('child_process');
const log = require('electron-log');

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
let localRequestCounter = 0;
const localWhisperPending = new Map();
const localParakeetPending = new Map();

const PARAKEET_MODEL_MAP = {
  'parakeet-english': 'istupakov/parakeet-tdt-0.6b-v2-onnx',
  'parakeet-multilingual': 'istupakov/parakeet-tdt-0.6b-v3-onnx',
};

function isParakeetModel(modelId) {
  return Object.prototype.hasOwnProperty.call(PARAKEET_MODEL_MAP, modelId);
}

function resolveLocalAsrStorageDir(kind) {
  return path.join(app.getPath('userData'), 'Models', kind);
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

  if (process.env.NODE_ENV === 'development' || !app.isPackaged) {
    mainWindow.loadURL('http://localhost:3000');
    // mainWindow.webContents.openDevTools();
  } else {
    mainWindow.loadFile(path.join(__dirname, '..', 'dist', 'index.html'));
  }

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
    return { success: true, data: buf.buffer, byteOffset: buf.byteOffset, byteLength: buf.byteLength };
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
