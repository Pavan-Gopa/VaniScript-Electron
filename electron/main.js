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
const TEMP_DIR = path.join(app.getPath('temp'), 'vaniscript');

function ensureTempDir() {
  if (!fs.existsSync(TEMP_DIR)) fs.mkdirSync(TEMP_DIR, { recursive: true });
}

function cleanupTempDir() {
  try {
    if (fs.existsSync(TEMP_DIR)) {
      fs.rmSync(TEMP_DIR, { recursive: true, force: true });
    }
  } catch (e) {
    log.warn('Failed to cleanup temp dir:', e);
  }
}

// ─── App lifecycle ────────────────────────────────────────────────────────────
app.whenReady().then(() => {
  ensureTempDir();
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
  ensureTempDir();
  const outputPath = path.join(TEMP_DIR, `converted_${Date.now()}.wav`);

  // Check input exists
  if (!fs.existsSync(inputPath)) {
    return { success: false, error: `Input file not found: ${inputPath}` };
  }

  const args = ['-y', '-i', inputPath, '-vn', '-ar', '16000', '-ac', '1', '-c:a', 'pcm_s16le', outputPath];
  const result = await runFfmpeg(args);

  if (result.success) return { success: true, outputPath };
  return { success: false, error: result.error, stderr: result.stderr };
});

// ─── IPC: Slice audio into chunks using FFmpeg ────────────────────────────────
ipcMain.handle('ffmpeg:sliceChunks', async (_, { inputPath, cutPoints }) => {
  ensureTempDir();
  const chunkPaths = [];
  const boundaries = [0, ...cutPoints, null];

  for (let i = 0; i < boundaries.length - 1; i++) {
    const startSec = boundaries[i];
    const endSec = boundaries[i + 1];
    const outPath = path.join(TEMP_DIR, `chunk_${String(i).padStart(4, '0')}.wav`);

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

log.info('VaniScript main process ready');
