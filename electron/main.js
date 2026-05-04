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
    // In packaged app, extraResources lands at Resources/ffmpeg-bin/
    const resourcesPath = process.resourcesPath;
    const candidates = [
      path.join(resourcesPath, 'ffmpeg-bin', 'ffmpeg'),
      path.join(resourcesPath, 'ffmpeg-bin', 'ffmpeg.exe'),
    ];
    for (const c of candidates) {
      if (fs.existsSync(c)) return c;
    }
  }
  // Development: use ffmpeg-static
  try {
    return require('ffmpeg-static');
  } catch {
    return 'ffmpeg'; // system fallback
  }
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

// ─── IPC: Convert audio to WAV 16kHz mono ────────────────────────────────────
ipcMain.handle('ffmpeg:convertToWav', async (_, { inputPath }) => {
  return new Promise((resolve, reject) => {
    const ffmpegPath = getFfmpegPath();
    const outputPath = path.join(TEMP_DIR, `converted_${Date.now()}.wav`);

    const args = [
      '-y',
      '-i', inputPath,
      '-ar', '16000',
      '-ac', '1',
      '-c:a', 'pcm_s16le',
      outputPath,
    ];

    log.info('FFmpeg convert:', ffmpegPath, args.join(' '));
    const proc = spawn(ffmpegPath, args);
    let stderr = '';
    proc.stderr.on('data', d => { stderr += d.toString(); });
    proc.on('close', code => {
      if (code === 0) {
        resolve({ success: true, outputPath });
      } else {
        log.error('FFmpeg convert failed:', stderr);
        reject(new Error(`FFmpeg exited with code ${code}`));
      }
    });
    proc.on('error', e => reject(e));
  });
});

// ─── IPC: Slice audio into chunks using FFmpeg ────────────────────────────────
ipcMain.handle('ffmpeg:sliceChunks', async (_, { inputPath, cutPoints }) => {
  const ffmpegPath = getFfmpegPath();
  const ext = path.extname(inputPath).slice(1) || 'wav';
  const chunkPaths = [];
  const boundaries = [0, ...cutPoints, null]; // null = end of file

  for (let i = 0; i < boundaries.length - 1; i++) {
    const startSec = boundaries[i];
    const endSec = boundaries[i + 1];
    const outPath = path.join(TEMP_DIR, `chunk_${String(i).padStart(4, '0')}.wav`);

    await new Promise((resolve, reject) => {
      const args = ['-y'];
      if (startSec > 0) args.push('-ss', String(startSec));
      args.push('-i', inputPath);
      if (endSec !== null) args.push('-t', String(endSec - startSec));
      args.push('-ar', '16000', '-ac', '1', '-c:a', 'pcm_s16le', outPath);

      const proc = spawn(ffmpegPath, args);
      let stderr = '';
      proc.stderr.on('data', d => { stderr += d.toString(); });
      proc.on('close', code => {
        if (code === 0) resolve();
        else reject(new Error(`FFmpeg slice failed: ${stderr.slice(-200)}`));
      });
      proc.on('error', reject);
    });

    chunkPaths.push(outPath);
  }

  return { success: true, chunkPaths };
});

// ─── IPC: Get audio duration ─────────────────────────────────────────────────
ipcMain.handle('ffmpeg:getDuration', async (_, { inputPath }) => {
  return new Promise((resolve, reject) => {
    const ffmpegPath = getFfmpegPath();
    const args = ['-i', inputPath, '-f', 'null', '-'];
    let stderr = '';
    const proc = spawn(ffmpegPath, args);
    proc.stderr.on('data', d => { stderr += d.toString(); });
    proc.on('close', () => {
      // Parse "Duration: HH:MM:SS.ms"
      const m = stderr.match(/Duration:\s*(\d+):(\d+):(\d+\.?\d*)/);
      if (m) {
        const sec = parseInt(m[1]) * 3600 + parseInt(m[2]) * 60 + parseFloat(m[3]);
        resolve({ success: true, durationSec: sec });
      } else {
        resolve({ success: false, durationSec: 0 });
      }
    });
    proc.on('error', reject);
  });
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
