'use strict';

const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('electronAPI', {
  // ─── Dialogs ───────────────────────────────────────────────────────────────
  openFile: () => ipcRenderer.invoke('dialog:openFile'),
  openGenericFile: (opts) => ipcRenderer.invoke('dialog:openGenericFile', opts),
  saveFile: (opts) => ipcRenderer.invoke('dialog:saveFile', opts),

  // ─── File system ──────────────────────────────────────────────────────────
  writeFile: (opts) => ipcRenderer.invoke('fs:writeFile', opts),
  readTextFile: (opts) => ipcRenderer.invoke('fs:readTextFile', opts),
  readFileBuffer: (opts) => ipcRenderer.invoke('fs:readFileBuffer', opts),
  pathToFileUrl: (opts) => ipcRenderer.invoke('fs:pathToFileUrl', opts),

  // ─── FFmpeg ────────────────────────────────────────────────────────────────
  ffmpegGetPath: () => ipcRenderer.invoke('ffmpeg:getPath'),
  ffmpegConvertToWav: (opts) => ipcRenderer.invoke('ffmpeg:convertToWav', opts),
  ffmpegSliceChunks: (opts) => ipcRenderer.invoke('ffmpeg:sliceChunks', opts),
  ffmpegGetDuration: (opts) => ipcRenderer.invoke('ffmpeg:getDuration', opts),

  // ─── Local ASR ────────────────────────────────────────────────────────────
  localInstallAsrModel: (opts) => ipcRenderer.invoke('local-asr:installModel', opts),
  localRemoveAsrModel: (opts) => ipcRenderer.invoke('local-asr:removeModel', opts),
  localTranscribeChunk: (opts) => ipcRenderer.invoke('local-asr:transcribeChunk', opts),

  // ─── Local translation ───────────────────────────────────────────────────
  localInstallTranslationModel: (opts) => ipcRenderer.invoke('local-translation:installModel', opts),
  localRemoveTranslationModel: (opts) => ipcRenderer.invoke('local-translation:removeModel', opts),
  localResolveTranslationModelPath: (opts) => ipcRenderer.invoke('local-translation:resolveModelPath', opts),
  localTranslateText: (opts) => ipcRenderer.invoke('local-translation:translateText', opts),
  localGetModelDownloadStatus: (opts) => ipcRenderer.invoke('local-model:getDownloadStatus', opts),
  onLocalModelDownloadProgress: (callback) => {
    const handler = (_event, payload) => callback(payload);
    ipcRenderer.on('local-model:download-progress', handler);
    return () => ipcRenderer.removeListener('local-model:download-progress', handler);
  },

  // ─── Projects ────────────────────────────────────────────────────────────
  projectList: () => ipcRenderer.invoke('project:list'),
  projectSave: (project) => ipcRenderer.invoke('project:save', project),
  projectLoad: (opts) => ipcRenderer.invoke('project:load', opts),
  projectDelete: (opts) => ipcRenderer.invoke('project:delete', opts),
  projectClearAll: () => ipcRenderer.invoke('project:clearAll'),
  projectExport: (opts) => ipcRenderer.invoke('project:export', opts),
  projectExportAll: () => ipcRenderer.invoke('project:exportAll'),
  projectImport: () => ipcRenderer.invoke('project:import'),

  // ─── App info ─────────────────────────────────────────────────────────────
  getVersion: () => ipcRenderer.invoke('app:getVersion'),
  getPlatform: () => ipcRenderer.invoke('app:getPlatform'),
  getUserDataPath: () => ipcRenderer.invoke('app:getUserDataPath'),
  getSystemMemoryInfo: () => ipcRenderer.invoke('system:getMemoryInfo'),

  // ─── Shell ────────────────────────────────────────────────────────────────
  openExternal: (url) => ipcRenderer.invoke('shell:openExternal', url),

  // ─── Environment detection ────────────────────────────────────────────────
  isElectron: true,
});
