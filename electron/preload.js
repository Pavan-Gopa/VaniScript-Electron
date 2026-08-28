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

  // ─── Recording ────────────────────────────────────────────────────────────
  recordingStart: (opts) => ipcRenderer.invoke('recording:start', opts),
  recordingAppendChunk: (opts) => ipcRenderer.invoke('recording:appendChunk', opts),
  recordingPreview: (opts) => ipcRenderer.invoke('recording:preview', opts),
  recordingFinish: (opts) => ipcRenderer.invoke('recording:finish', opts),
  recordingCancel: (opts) => ipcRenderer.invoke('recording:cancel', opts),
  recordingOpenFolder: () => ipcRenderer.invoke('recording:openFolder'),

  // ─── Link imports ─────────────────────────────────────────────────────────
  linkImportStart: (opts) => ipcRenderer.invoke('link-import:start', opts),
  linkImportCancel: (opts) => ipcRenderer.invoke('link-import:cancel', opts),
  linkImportOpenFolder: () => ipcRenderer.invoke('link-import:openFolder'),
  onLinkImportProgress: (callback) => {
    const handler = (_event, payload) => callback(payload);
    ipcRenderer.on('link-import:progress', handler);
    return () => ipcRenderer.removeListener('link-import:progress', handler);
  },

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
  hyperframesExportShorts: (snapshot) => ipcRenderer.invoke('hyperframes:exportShorts', snapshot),
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
	  localScanModels: () => ipcRenderer.invoke('local-models:scan'),
	  localReconcileModels: (opts) => ipcRenderer.invoke('local-models:reconcile', opts),
	  // MOD-01 — secure local model manager (scan / verify / relocate).
	  // Channel is canonical in shared/contracts/models.ts (MODELS_MANAGE_CHANNEL).
	  manageModels: (action, payload = {}) => ipcRenderer.invoke('models:manage', { action, ...payload }),
	  onLocalModelsUpdated: (callback) => {
    const handler = (_event, payload) => callback(payload);
    ipcRenderer.on('local-models:updated', handler);
    return () => ipcRenderer.removeListener('local-models:updated', handler);
  },

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

  // ─── Main-owned usage ledger / safe diagnostics ──────────────────────────
  usageGet: (range) => ipcRenderer.invoke('usage:get', range),
  usageRecord: (input) => ipcRenderer.invoke('usage:record', input),
  usageReset: () => ipcRenderer.invoke('usage:reset'),
  usageExport: (range) => ipcRenderer.invoke('usage:export', range),
  diagnosticsGet: () => ipcRenderer.invoke('diagnostics:get'),
  diagnosticsExport: () => ipcRenderer.invoke('diagnostics:export'),
  diagnosticsOpenLogs: () => ipcRenderer.invoke('diagnostics:openLogs'),
  reportRendererEvent: (payload) => ipcRenderer.invoke('renderer:report', payload),
  onOpenSettings: (callback) => {
    const handler = () => callback();
    ipcRenderer.on('app:open-settings', handler);
    return () => ipcRenderer.removeListener('app:open-settings', handler);
  },

  openExternal: (url) => ipcRenderer.invoke('shell:openExternal', url),
  openPath: (path) => ipcRenderer.invoke('shell:openPath', path),
  showItemInFolder: (path) => ipcRenderer.invoke('shell:showItemInFolder', path),
  ffmpegGetSourceMediaInfo: (opts) => ipcRenderer.invoke('ffmpeg:getSourceMediaInfo', opts),

  // ─── MCP Integration ──────────────────────────────────────────────────────
  onMcpCallTool: (callback) => {
    const handler = (_event, payload) => callback(payload);
    ipcRenderer.on('mcp:call-tool', handler);
    return () => ipcRenderer.removeListener('mcp:call-tool', handler);
  },
  mcpToolResponse: (payload) => ipcRenderer.invoke('mcp:tool-response', payload),

  // ─── MCP Exports compute bridges (S4-C) ──────────────────────────────────
  onMcpBuildTranscriptArtifact: (callback) => {
    const handler = (_event, payload) => callback(payload);
    ipcRenderer.on('mcp:build-transcript-artifact', handler);
    return () => ipcRenderer.removeListener('mcp:build-transcript-artifact', handler);
  },
  mcpBuildTranscriptArtifactResponse: (payload) => ipcRenderer.invoke('mcp:build-transcript-artifact-response', payload),
  onMcpGetActiveProject: (callback) => {
    const handler = (_event, payload) => callback(payload);
    ipcRenderer.on('mcp:get-active-project', handler);
    return () => ipcRenderer.removeListener('mcp:get-active-project', handler);
  },
  mcpGetActiveProjectResponse: (payload) => ipcRenderer.invoke('mcp:get-active-project-response', payload),
  onMcpGetExportReadiness: (callback) => {
    const handler = (_event, payload) => callback(payload);
    ipcRenderer.on('mcp:get-export-readiness', handler);
    return () => ipcRenderer.removeListener('mcp:get-export-readiness', handler);
  },
  mcpGetExportReadinessResponse: (payload) => ipcRenderer.invoke('mcp:get-export-readiness-response', payload),

  // ─── Embedded Grok chat (headless CLI) ──────────────────────────────────
  grokChat: (payload) => ipcRenderer.invoke('grok:chat', payload),
  onGrokChunk: (callback) => {
    const handler = (_event, payload) => callback(payload);
    ipcRenderer.on('grok:chunk', handler);
    return () => ipcRenderer.removeListener('grok:chunk', handler);
  },
  onGrokError: (callback) => {
    const handler = (_event, payload) => callback(payload);
    ipcRenderer.on('grok:error', handler);
    return () => ipcRenderer.removeListener('grok:error', handler);
  },
  onGrokDone: (callback) => {
    const handler = (_event, payload) => callback(payload);
    ipcRenderer.on('grok:done', handler);
    return () => ipcRenderer.removeListener('grok:done', handler);
  },

  // ─── Embedded Qwen chat (headless CLI) ──────────────────────────────────
  qwenChat: (payload) => ipcRenderer.invoke('qwen:chat', payload),
  onQwenChunk: (callback) => {
    const handler = (_event, payload) => callback(payload);
    ipcRenderer.on('qwen:chunk', handler);
    return () => ipcRenderer.removeListener('qwen:chunk', handler);
  },
  onQwenError: (callback) => {
    const handler = (_event, payload) => callback(payload);
    ipcRenderer.on('qwen:error', handler);
    return () => ipcRenderer.removeListener('qwen:error', handler);
  },
  onQwenDone: (callback) => {
    const handler = (_event, payload) => callback(payload);
    ipcRenderer.on('qwen:done', handler);
    return () => ipcRenderer.removeListener('qwen:done', handler);
  },

  // ─── Environment detection ────────────────────────────────────────────────
  isElectron: true,
  // ─── Legacy settings migration (one-shot localStorage → Main disk store) ──
  migrateLegacySettings: (payload) => ipcRenderer.invoke('settings:migrateLegacy', payload),
});
