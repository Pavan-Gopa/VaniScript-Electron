'use strict';

const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('electronAPI', {
  // ─── Dialogs ───────────────────────────────────────────────────────────────
  openFile: () => ipcRenderer.invoke('dialog:openFile'),
  saveFile: (opts) => ipcRenderer.invoke('dialog:saveFile', opts),

  // ─── File system ──────────────────────────────────────────────────────────
  writeFile: (opts) => ipcRenderer.invoke('fs:writeFile', opts),
  readFileBuffer: (opts) => ipcRenderer.invoke('fs:readFileBuffer', opts),

  // ─── FFmpeg ────────────────────────────────────────────────────────────────
  ffmpegGetPath: () => ipcRenderer.invoke('ffmpeg:getPath'),
  ffmpegConvertToWav: (opts) => ipcRenderer.invoke('ffmpeg:convertToWav', opts),
  ffmpegSliceChunks: (opts) => ipcRenderer.invoke('ffmpeg:sliceChunks', opts),
  ffmpegGetDuration: (opts) => ipcRenderer.invoke('ffmpeg:getDuration', opts),

  // ─── Local ASR ────────────────────────────────────────────────────────────
  localInstallAsrModel: (opts) => ipcRenderer.invoke('local-asr:installModel', opts),
  localRemoveAsrModel: (opts) => ipcRenderer.invoke('local-asr:removeModel', opts),
  localTranscribeChunk: (opts) => ipcRenderer.invoke('local-asr:transcribeChunk', opts),

  // ─── App info ─────────────────────────────────────────────────────────────
  getVersion: () => ipcRenderer.invoke('app:getVersion'),
  getPlatform: () => ipcRenderer.invoke('app:getPlatform'),
  getUserDataPath: () => ipcRenderer.invoke('app:getUserDataPath'),

  // ─── Shell ────────────────────────────────────────────────────────────────
  openExternal: (url) => ipcRenderer.invoke('shell:openExternal', url),

  // ─── Environment detection ────────────────────────────────────────────────
  isElectron: true,
});
