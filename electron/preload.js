'use strict';

const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('electronAPI', {
  // ─── Dialogs ───────────────────────────────────────────────────────────────
  openFile: () => ipcRenderer.invoke('dialog:openFile'),
  openGenericFile: (opts) => ipcRenderer.invoke('dialog:openGenericFile', opts),
  saveFile: (opts) => ipcRenderer.invoke('dialog:saveFile', opts),
  openDirectory: () => ipcRenderer.invoke('dialog:openDirectory'),

  // ─── File system ──────────────────────────────────────────────────────────
  writeFile: (opts) => ipcRenderer.invoke('fs:writeFile', opts),
  deleteFiles: (opts) => ipcRenderer.invoke('fs:deleteFiles', opts),
  writeTempTextFile: (opts) => ipcRenderer.invoke('fs:writeTempTextFile', opts),
  createTempPath: (opts) => ipcRenderer.invoke('fs:createTempPath', opts),
  readTextFile: (opts) => ipcRenderer.invoke('fs:readTextFile', opts),
  readFileBuffer: (opts) => ipcRenderer.invoke('fs:readFileBuffer', opts),
  pathToFileUrl: (opts) => ipcRenderer.invoke('fs:pathToFileUrl', opts),

  // ─── FFmpeg ────────────────────────────────────────────────────────────────
  ffmpegGetPath: () => ipcRenderer.invoke('ffmpeg:getPath'),
  ffmpegConvertToWav: (opts) => ipcRenderer.invoke('ffmpeg:convertToWav', opts),
  ffmpegExtractAudioForTranscription: (opts) => ipcRenderer.invoke('ffmpeg:extractAudioForTranscription', opts),
  ffmpegSliceChunks: (opts) => ipcRenderer.invoke('ffmpeg:sliceChunks', opts),
  ffmpegGetDuration: (opts) => ipcRenderer.invoke('ffmpeg:getDuration', opts),
  ffmpegGetVideoInfo: (opts) => ipcRenderer.invoke('ffmpeg:getVideoInfo', opts),
  ffmpegExtractWaveformPeaks: (opts) => ipcRenderer.invoke('ffmpeg:extractWaveformPeaks', opts),
  ffmpegRenderShortPreviewFrame: (opts) => ipcRenderer.invoke('ffmpeg:renderShortPreviewFrame', opts),
  ffmpegExportShortClip: (opts) => ipcRenderer.invoke('ffmpeg:exportShortClip', opts),
  hyperframesExportShortClip: (opts) => ipcRenderer.invoke('hyperframes:exportShortClip', opts),
  hyperframesCancelExport: (opts) => ipcRenderer.invoke('hyperframes:cancelExport', opts),
  onHyperframesExportProgress: (callback) => {
    const handler = (_event, payload) => callback(payload);
    ipcRenderer.on('hyperframes:export-progress', handler);
    return () => ipcRenderer.removeListener('hyperframes:export-progress', handler);
  },

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
  onOpenSettings: (callback) => {
    const handler = () => callback();
    ipcRenderer.on('app:open-settings', handler);
    return () => ipcRenderer.removeListener('app:open-settings', handler);
  },

  // ─── Shell ────────────────────────────────────────────────────────────────
  openExternal: (url) => ipcRenderer.invoke('shell:openExternal', url),

  // ─── Environment detection ────────────────────────────────────────────────
  isElectron: true,
});
