'use strict';

const { app, BrowserWindow, ipcMain, shell, dialog, Tray, Menu, nativeImage, session, desktopCapturer } = require('electron');
const path = require('path');
const fs = require('fs');
const os = require('os');
const crypto = require('crypto');
const { pathToFileURL } = require('url');
const { spawn, fork, execSync } = require('child_process');
const electronLog = require('electron-log');
const {
  removeTranslationModel,
  resolveInstalledModelPath,
} = require('./llamacpp-model-store');
const settingsStore = require('./main/storage/settingsStore.js');
const {
  configureElectronLog,
  createObservability,
  createLegacyAuditRecorder,
  safeIpcError,
  safeMcpError,
} = require('./main/observability.js');
const {
  renderShortClipWithHyperFrames,
} = require('./hyperframes-renderer');
const {
  createHyperFramesExportSession,
} = require('./hyperframes-export-session');
const { modelsDir, resolveModelsRoot } = require('../shared/localModelsRoot');
const { scanLocalModels } = require('../shared/scanLocalModels');
const {
  normalizeImportedProjectSession,
  resolveSessionCurrentIndex,
  resolveSessionReviewProgressIndex,
} = require('./project-session');
const { normalizeShortsSessionState } = require('../shared/shorts-state');
const {
  createStreamingBundleService,
} = require('./main/projects/streamingBundle');
const windowManager = require('./main/windows/window-manager');
const { handleMigrateLegacy } = require('./main/storage/migrationHandler');
const vault = require('./main/storage/vault.js');
const { invokeProvider } = require('./main/providers/router');
const { manageModels, MODELS_MANAGE_CHANNEL } = require('./main/models/modelManager.js');
const { registerAppLifecycle } = require('./main/bootstrap/app-lifecycle');
const { createMcpExportStore } = require('./main/projects/mcpExportStore');
const { createExportCatalog } = require('./main/mcp/mcpTools/exportCatalog');
const { createReadCatalog } = require('./main/mcp/mcpTools/readCatalog');

for (const stream of [process.stdout, process.stderr]) {
  stream?.on?.('error', (error) => {
    if (error?.code !== 'EPIPE') throw error;
  });
}

const configuredLogPath = configureElectronLog(electronLog, {
  userDataPath: app.getPath('userData'),
});
const observability = createObservability({
  sink: electronLog,
  settingsStore: {
    readSettings: () => settingsStore.readSettings(),
    writeSettings: (settings) => settingsStore.writeSettings(settings),
  },
  appInfo: () => ({
    appVersion: app.getVersion(),
    electronVersion: process.versions.electron,
    platform: process.platform,
    arch: process.arch,
  }),
  capabilities: () => {
    const registry = require('./main/platform/capabilityRegistry.js').createCapabilityRegistry();
    return { capabilities: registry.getAll(), host: registry.getHost() };
  },
  models: () => scanSharedLocalModels(),
  clock: () => new Date(),
  logsAvailable: () => Boolean(configuredLogPath),
});
const safeLogger = observability.logger;
windowManager.setLogger(safeLogger);
vault.setLogger(safeLogger);
safeLogger.info({ category: 'runtime', event: 'runtime.startup' });
const safeErrorText = (error, code = 'INTERNAL') => safeIpcError(error, code).message;

const recordingSessions = new Map();
const linkImportJobs = new Map();
const hyperframesExportSession = createHyperFramesExportSession({
  app,
  renderShortClip: renderShortClipWithHyperFrames,
  getFfmpegPath,
  logger: safeLogger,
  sendEvent: (payload) => {
    windowManager.getMainWindow()?.webContents.send('hyperframes:export-progress', payload);
  },
});

// ─── FFmpeg path ─────────────────────────────────────────────────────────────
function getFfmpegPath() {
  if (app.isPackaged) {
    const resourcesPath = process.resourcesPath;
    const candidates = [
      path.join(resourcesPath, 'ffmpeg-bin', 'ffmpeg'),
      path.join(resourcesPath, 'ffmpeg-bin', 'ffmpeg.exe'),
    ];
    for (const c of candidates) {
      if (fs.existsSync(c)) { safeLogger.info({ category: 'ffmpeg', event: 'ffmpeg.path-selected', data: { phase: 'packaged', path: c } }); return c; }
    }
  }
  // Development: use ffmpeg-static
  try {
    const staticPath = require('ffmpeg-static');
    if (staticPath && fs.existsSync(staticPath)) {
      safeLogger.info({ category: 'ffmpeg', event: 'ffmpeg.path-selected', data: { phase: 'static', path: staticPath } });
      return staticPath;
    }
  } catch (e) {
    safeLogger.warn({ category: 'ffmpeg', event: 'ffmpeg.path-unavailable', data: { phase: 'static' }, error: e });
  }
  // System fallback
  const systemPaths = ['/usr/local/bin/ffmpeg', '/opt/homebrew/bin/ffmpeg', '/usr/bin/ffmpeg', 'ffmpeg'];
  for (const p of systemPaths) {
    if (p === 'ffmpeg' || fs.existsSync(p)) { safeLogger.info({ category: 'ffmpeg', event: 'ffmpeg.path-selected', data: { phase: 'system', path: p } }); return p; }
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
        safeLogger.info({ category: 'runtime', event: 'runtime.binary-selected', data: { type: 'yt-dlp', path: candidate } });
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
      safeLogger.info({ category: 'runtime', event: 'runtime.binary-selected', data: { type: 'yt-dlp', path: candidate } });
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

  safeLogger.warn({ category: 'runtime', event: 'runtime.binary-unavailable', data: { type: 'yt-dlp-javascript' } });
  return [];
}

let localWhisperWorker = null;
let localParakeetWorker = null;
let localTranslationWorker = null;
let localRequestCounter = 0;
const localWhisperPending = new Map();
const localParakeetPending = new Map();
const localTranslationPending = new Map();

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
    if (windowManager.getMainWindow() && !windowManager.getMainWindow().isDestroyed()) {
      windowManager.getMainWindow().webContents.send('local-models:updated', payload);
    }
    return { ok: true, ...payload };
  } catch (error) {
    safeLogger.warn({ category: 'runtime', event: 'runtime.models-scan-failed', error });
    return { ok: false, error: safeErrorText(error, 'MODEL_UNAVAILABLE'), entries: [] };
  }
}

function emitLocalModelDownloadProgress(payload) {
  if (!windowManager.getMainWindow() || windowManager.getMainWindow().isDestroyed()) return;
  windowManager.getMainWindow().webContents.send('local-model:download-progress', payload);
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

// Single hardened bundle service for the whole process: every project/library
// export and import IPC route goes through this one instance.
const streamingBundleService = createStreamingBundleService({
  projectsRootDir,
  newProjectId,
});

// ─── MCP Exports composition (P3E.D3-S4-C) ──────────────────────────────────
// Production wiring for the protected MCP Exports lane: one store, one file
// export catalogue, and one export-preflight read catalogue, built exactly
// once at startup. Renderer-side compute (transcript artifacts, active
// project, readiness snapshot) arrives over three request/response IPC
// bridges that mirror the pendingMcpRequests round-trip used by the
// mcp:call-tool forwarding path.
const mcpExportStore = createMcpExportStore({
  exportsRoot: () => path.join(app.getPath('userData'), 'MCP Exports'),
});

const pendingMcpBridgeRequests = new Map(); // requestId -> { resolve, reject }

// Renderer rejections cross the IPC boundary as plain strings; the machine-
// prefixed failures below are retyped as their MCP codes here.
function rejectMcpBridgeError(message) {
  const error = new Error(typeof message === 'string' ? message : String(message ?? ''));
  if (error.message.startsWith('NO_ACTIVE_PROJECT')) {
    error.code = 'MCP_NOT_FOUND';
    error.mcpCode = 'MCP_NOT_FOUND';
  }
  if (error.message.startsWith('NO_TRANSLATION_LANGUAGE')) {
    error.code = 'MCP_INVALID_REQUEST';
    error.mcpCode = 'MCP_INVALID_REQUEST';
  }
  return error;
}

function settleMcpBridgeReply(payload = {}) {
  const requestId = String(payload.requestId ?? '');
  const pending = pendingMcpBridgeRequests.get(requestId);
  if (!pending) return;
  pendingMcpBridgeRequests.delete(requestId);
  if (payload.success) {
    pending.resolve(payload.result);
  } else {
    pending.reject(rejectMcpBridgeError(payload.error));
  }
}

for (const bridgeReplyChannel of [
  'mcp:build-transcript-artifact-response',
  'mcp:get-active-project-response',
  'mcp:get-export-readiness-response',
]) {
  ipcMain.handle(bridgeReplyChannel, (_event, payload) => settleMcpBridgeReply(payload));
}

function requestRendererForMcpExport(eventChannel, args = {}) {
  const win = windowManager.getMainWindow();
  if (!win || win.isDestroyed()) {
    return Promise.reject(new Error('VaniScript main window is not active.'));
  }
  const requestId = crypto.randomUUID();
  return new Promise((resolve, reject) => {
    pendingMcpBridgeRequests.set(requestId, { resolve, reject });
    win.webContents.send(eventChannel, { requestId, arguments: args });
  }).finally(() => pendingMcpBridgeRequests.delete(requestId));
}

const rendererBridge = {
  buildTranscriptArtifact: (args) => requestRendererForMcpExport('mcp:build-transcript-artifact', args),
  // Explicit id resolves from the project store; no id asks the renderer for
  // the active project. Unknown ids collapse to null so the catalogue raises
  // its own typed NOT_FOUND.
  resolveProject: async (projectId) => {
    let resolvedId = projectId;
    if (resolvedId === undefined || resolvedId === null || resolvedId === '') {
      const activeId = await requestRendererForMcpExport('mcp:get-active-project');
      if (typeof activeId !== 'string' || activeId.length === 0) return null;
      resolvedId = activeId;
    }
    try {
      return readProject(resolvedId);
    } catch {
      return null;
    }
  },
  // Existence is main-process truth: the renderer publishes only the path
  // string, and the store-side preflight consumes the boolean verdict.
  readiness: async () => {
    const snapshot = await requestRendererForMcpExport('mcp:get-export-readiness');
    const sourceVideoPath = snapshot && typeof snapshot.sourceVideoPath === 'string' && snapshot.sourceVideoPath.length > 0
      ? snapshot.sourceVideoPath
      : null;
    return {
      ...snapshot,
      sourceVideoExists: sourceVideoPath !== null ? fs.existsSync(sourceVideoPath) : null,
    };
  },
};

const exportCatalog = createExportCatalog({
  filePermissionEnabled: true,
  createExportDirectory: (label) => mcpExportStore.makeDirectory(label),
  writeFile: (filePath, content) => mcpExportStore.writeFile(filePath, content),
  registerFiles: (id, files) => mcpExportStore.register(id, files),
  revealRecord: (id) => mcpExportStore.reveal(id),
  shellReveal: (p) => { shell.showItemInFolder(p); },
  buildTranscriptArtifact: (args) => rendererBridge.buildTranscriptArtifact(args),
  resolveProject: (projectId) => rendererBridge.resolveProject(projectId),
  bundleWriter: (project, destPath) => streamingBundleService.writeProjectBundle(project, destPath),
});

const exportPreflightCatalog = createReadCatalog({
  exportReadiness: () => rendererBridge.readiness(),
  // Shorts reads are Main-owned but resolve the renderer's active project ID
  // only as a lookup key; the returned legacy record is the sole data source.
  resolveShortsProject: (projectId) => rendererBridge.resolveProject(projectId),
});

const MCP_PREFLIGHT_TOOL_NAMES = Object.freeze(['list_export_options', 'validate_export']);
const MCP_SHORTS_READ_TOOL_NAMES = Object.freeze([
  'get_shorts_plans',
  'get_shorts_plan',
  'list_rejected_shorts_plans',
  'validate_shorts_plan',
  'get_visual_editor_state',
]);
const MCP_EXPORT_TOOL_NAMES = Object.freeze([...exportCatalog.names, ...MCP_PREFLIGHT_TOOL_NAMES]);
// The export, preflight, and Shorts read entries reuse the catalogues' own
// definition objects rather than being retyped in the transport.
const MCP_MAIN_TOOL_DEFINITIONS = Object.freeze([
  ...exportCatalog.tools,
  ...exportPreflightCatalog.tools.filter((tool) => (
    MCP_PREFLIGHT_TOOL_NAMES.includes(tool.name) || MCP_SHORTS_READ_TOOL_NAMES.includes(tool.name)
  )),
]);

// Typed catalogue failures map onto deterministic JSON-RPC codes; messages are
// stripped of known absolute roots so no filesystem layout reaches a client.
const MCP_EXPORT_RPC_CODES = Object.freeze({
  MCP_INVALID_REQUEST: -32602,
  MCP_NOT_FOUND: -32001,
  MCP_PERMISSION_DENIED: -32002,
  MCP_CAPABILITY_UNAVAILABLE: -32003,
});

function redactKnownRoots(message) {
  let text = String(message ?? '');
  for (const root of [app.getPath('userData'), app.getPath('home'), app.getPath('temp'), app.getPath('documents')]) {
    if (root && root.length > 1) text = text.split(root).join('[path]');
  }
  return text;
}

function mcpToolRpcError(error) {
  // ExportCatalogError sets .code/.mcpCode; ReadCatalogError sets .mcpCode only.
  const typedCode = error && typeof error.mcpCode === 'string'
    ? error.mcpCode
    : error && typeof error.code === 'string' ? error.code : '';
  const rpcCode = MCP_EXPORT_RPC_CODES[typedCode];
  if (rpcCode !== undefined) {
    return { code: rpcCode, message: redactKnownRoots(error.message) };
  }
  return { code: -32603, message: 'MCP tool call failed.' };
}

function dispatchedMcpToolCatalog(name) {
  if (exportCatalog.names.includes(name)) return exportCatalog;
  if (MCP_PREFLIGHT_TOOL_NAMES.includes(name) || MCP_SHORTS_READ_TOOL_NAMES.includes(name)) return exportPreflightCatalog;
  return null;
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
  const project = JSON.parse(fs.readFileSync(filePath, 'utf8'));
  if (project?.session) project.session = normalizeShortsSessionState(project.session);
  return project;
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
  const session = normalizeShortsSessionState(normalizeProjectSessionAssets(id, {
    ...(input.session || {}),
    projectId: id,
    createdAt,
    updatedAt: now,
  }));
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

  child.stdout?.on('data', () => safeLogger.info({ category: 'worker', event: 'worker.stdout', data: { worker: 'local-whisper', stream: 'stdout' } }));
  child.stderr?.on('data', () => safeLogger.warn({ category: 'worker', event: 'worker.stderr', data: { worker: 'local-whisper', stream: 'stderr' } }));

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

  child.stdout?.on('data', () => safeLogger.info({ category: 'worker', event: 'worker.stdout', data: { worker: 'local-parakeet', stream: 'stdout' } }));
  child.stderr?.on('data', () => safeLogger.warn({ category: 'worker', event: 'worker.stderr', data: { worker: 'local-parakeet', stream: 'stderr' } }));

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

  child.stdout?.on('data', () => safeLogger.info({ category: 'worker', event: 'worker.stdout', data: { worker: 'local-translation', stream: 'stdout' } }));
  child.stderr?.on('data', () => safeLogger.warn({ category: 'worker', event: 'worker.stderr', data: { worker: 'local-translation', stream: 'stderr' } }));

  child.on('message', (m) => {
    if (!m || !m.type) return;
    if (m.type === 'log') {
      const level = typeof m.level === 'string' ? m.level : 'info';
      const message = m.message || '[Local Translation]';
      if (level === 'warn') safeLogger.warn({ category: 'worker', event: 'worker.message', data: { worker: 'local-translation', level: 'warn' } });
      else if (level === 'error') safeLogger.error({ category: 'worker', event: 'worker.message', data: { worker: 'local-translation', level: 'error' } });
      else safeLogger.info({ category: 'worker', event: 'worker.message', data: { worker: 'local-translation', level: 'info' } });
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
      safeLogger.warn({ category: 'worker', event: 'worker.translation-failed', data: { worker: 'local-translation' }, error: new Error('worker translation failed') });
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
  const baseDir = resolveLocalAsrStorageDir(kind);
  const modelPath = kind === 'whisper' && /\.bin$/i.test(String(modelId || ''))
    ? path.join(baseDir, path.basename(String(modelId)))
    : path.join(baseDir, modelId);
  if (fs.existsSync(modelPath)) fs.rmSync(modelPath, { recursive: true, force: true });
  return { ok: true, id: modelId };
}


// ─── Temp directory ───────────────────────────────────────────────────────────
// Lazy getter — evaluated only after app is ready to ensure correct temp path
function getTempDir() {
  const dir = path.join(app.getPath('userData'), 'temp');
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
    safeLogger.info({ category: 'runtime', event: 'runtime.temp-created', data: { path: dir } });
  }
  return dir;
}

function cleanupTempDir() {
  try {
    const dir = path.join(app.getPath('userData'), 'temp');
    if (fs.existsSync(dir)) {
      fs.rmSync(dir, { recursive: true, force: true });
      safeLogger.info({ category: 'runtime', event: 'runtime.temp-cleaned', data: { path: dir } });
    }
  } catch (e) {
    safeLogger.warn({ category: 'runtime', event: 'runtime.temp-cleanup-failed', error: e });
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


// ─── IPC: File dialog ────────────────────────────────────────────────────────
ipcMain.handle('dialog:openFile', async () => {
  const result = await dialog.showOpenDialog(windowManager.getMainWindow(), {
    properties: ['openFile'],
    filters: [
      { name: 'Audio / Video', extensions: ['mp3', 'wav', 'm4a', 'flac', 'ogg', 'mp4', 'mkv', 'webm', 'aac', 'wma', 'mov'] },
      { name: 'All Files', extensions: ['*'] },
    ],
  });
  return result.canceled ? null : result.filePaths[0];
});

ipcMain.handle('dialog:openGenericFile', async (_, { filters } = {}) => {
  const result = await dialog.showOpenDialog(windowManager.getMainWindow(), {
    properties: ['openFile'],
    filters: filters || [{ name: 'All Files', extensions: ['*'] }],
  });
  return result.canceled ? null : result.filePaths[0];
});

ipcMain.handle('dialog:saveFile', async (_, { defaultName, filters }) => {
  const result = await dialog.showSaveDialog(windowManager.getMainWindow(), {
    defaultPath: defaultName,
    filters: filters || [{ name: 'Text', extensions: ['txt'] }],
  });
  return result.canceled ? null : result.filePath;
});

ipcMain.handle('dialog:openDirectory', async () => {
  const result = await dialog.showOpenDialog(windowManager.getMainWindow(), {
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
    return { success: false, error: safeErrorText(e) };
  }
});

ipcMain.handle('fs:deleteFiles', async (_, { filePaths }) => {
  try {
    for (const filePath of Array.isArray(filePaths) ? filePaths : []) {
      if (!filePath || typeof filePath !== 'string') continue;
      try {
        if (fs.existsSync(filePath)) fs.rmSync(filePath, { recursive: false, force: true });
      } catch (error) {
        safeLogger.warn({ category: 'storage', event: 'storage.delete-failed', data: { operation: 'delete' }, error });
      }
    }
    return { success: true };
  } catch (e) {
    return { success: false, error: safeErrorText(e) };
  }
});

ipcMain.handle('fs:readTextFile', async (_, { filePath }) => {
  try {
    return { success: true, content: fs.readFileSync(filePath, 'utf8') };
  } catch (e) {
    return { success: false, error: safeErrorText(e) };
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
    return { success: false, error: safeErrorText(e) };
  }
});

ipcMain.handle('fs:createTempPath', async (_, { fileName }) => {
  try {
    const tempDir = getTempDir();
    fs.mkdirSync(tempDir, { recursive: true });
    const safeFileName = safeName(path.basename(fileName || `vaniscript_${Date.now()}.tmp`), 'temp.tmp');
    return { success: true, filePath: path.join(tempDir, `${Date.now()}_${safeFileName}`) };
  } catch (e) {
    return { success: false, error: safeErrorText(e) };
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
    let proc;
    let stderr = '';
    try {
      proc = spawn(ffmpegPath, args);
    } catch (e) {
      return resolve({ success: false, error: safeErrorText(e, 'PROVIDER_ERROR'), stderr: '' });
    }
    proc.stderr.on('data', d => { stderr += d.toString(); });
    proc.on('close', code => {
      if (code === 0) {
        resolve({ success: true, stderr });
      } else {
        safeLogger.error({ category: 'ffmpeg', event: 'ffmpeg.failed', data: { statusCode: code }, error: Object.assign(new Error('ffmpeg failed'), { code: 'PROVIDER_ERROR' }) });
        resolve({ success: false, error: safeErrorText({ code: 'PROVIDER_ERROR' }, 'PROVIDER_ERROR'), stderr });
      }
    });
    proc.on('error', e => {
      safeLogger.error({ category: 'ffmpeg', event: 'ffmpeg.spawn-failed', error: e });
      resolve({ success: false, error: safeErrorText(e, 'PROVIDER_ERROR'), stderr });
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
  if (!windowManager.getMainWindow() || windowManager.getMainWindow().isDestroyed()) return;
  windowManager.getMainWindow().webContents.send('link-import:progress', payload);
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
    safeLogger.warn({ category: 'storage', event: 'storage.partial-files-cleanup-failed', error });
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
    let resolvedPath = '';
    let lastProgress = 0;
    let lastOutputAt = Date.now();
    let lastStatus = 'starting';
    const strategyStartedAt = Date.now();
    let stalled = false;
    let proc;
    try {
      safeLogger.info({ category: 'runtime', event: 'runtime.link-import-started', data: { operation: 'link-import', strategy: strategy.key } });
      proc = spawn(ytDlpPath, args, {
        env: {
          ...process.env,
          PYTHONIOENCODING: 'utf-8',
        },
      });
    } catch (error) {
      resolve({ success: false, error: safeErrorText(error, 'PROVIDER_ERROR'), retryable: index < strategies.length - 1 });
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
      // Keep process output in bounded parser buffers only; never retain or emit it.
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
      safeLogger.error({ category: 'runtime', event: 'runtime.link-import-failed', data: { operation: 'spawn', strategy: strategy.key }, error });
      emitLinkImportProgress({ jobId: id, status: 'error', progress: lastProgress, message: safeErrorText(error, 'PROVIDER_ERROR') });
      resolve({ success: false, error: safeErrorText(error, 'PROVIDER_ERROR'), stderr: '', retryable: index < strategies.length - 1 });
    });
    proc.on('close', (code, signal) => {
      clearInterval(heartbeat);
      safeLogger.info({ category: 'runtime', event: 'runtime.link-import-closed', data: { strategy: strategy.key, statusCode: code, progress: lastProgress } });
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
        safeLogger.warn({ category: 'runtime', event: 'runtime.link-import-failed', data: { strategy: strategy.key, statusCode: code } });
        resolve({ success: false, error: safeErrorText({ code: 'PROVIDER_ERROR' }, 'PROVIDER_ERROR'), stderr: '', retryable: index < strategies.length - 1 });
        return;
      }
      const filePath = (resolvedPath && fs.existsSync(resolvedPath)) ? resolvedPath : latestFileInDirectory(outputDir, startedAtMs);
      if (!filePath) {
        resolve({ success: false, retryable: index < strategies.length - 1, error: safeErrorText({ code: 'NOT_FOUND' }, 'NOT_FOUND'), stderr: '', stdout: '' });
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
    if (!result.success) return { success: false, error: result.error, stderr: '' };
    return {
      success: true,
      path: outputPath,
      name: path.basename(outputPath),
      directory: outputDir,
      bytes: fs.existsSync(outputPath) ? fs.statSync(outputPath).size : 0,
    };
  } finally {
    try { if (fs.existsSync(session.tempPath)) fs.rmSync(session.tempPath, { force: true }); } catch (error) {
      safeLogger.warn({ category: 'storage', event: 'storage.recording-cleanup-failed', data: { operation: 'recording' }, error });
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
    safeLogger.error({ category: 'runtime', event: 'runtime.recording-start-failed', error: e });
    return { success: false, error: safeErrorText(e) };
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
    safeLogger.error({ category: 'runtime', event: 'runtime.recording-append-failed', error: e });
    return { success: false, error: safeErrorText(e) };
  }
});

ipcMain.handle('recording:finish', async (_, { sessionId }) => {
  try {
    return await finishRecordingSession(sessionId);
  } catch (e) {
    safeLogger.error({ category: 'runtime', event: 'runtime.recording-finish-failed', error: e });
    return { success: false, error: safeErrorText(e) };
  }
});

ipcMain.handle('recording:preview', async (_, { sessionId }) => {
  try {
    return getRecordingPreview(sessionId);
  } catch (e) {
    safeLogger.error({ category: 'runtime', event: 'runtime.recording-preview-failed', error: e });
    return { success: false, error: safeErrorText(e) };
  }
});

ipcMain.handle('recording:cancel', async (_, { sessionId }) => {
  try {
    return cancelRecordingSession(sessionId);
  } catch (e) {
    safeLogger.error({ category: 'runtime', event: 'runtime.recording-cancel-failed', error: e });
    return { success: false, error: safeErrorText(e) };
  }
});

ipcMain.handle('recording:openFolder', async () => {
  try {
    const directory = recordingsRootDir();
    await shell.openPath(directory);
    return { success: true, directory };
  } catch (e) {
    return { success: false, error: safeErrorText(e) };
  }
});

ipcMain.handle('link-import:start', async (_, { url, mode, jobId } = {}) => {
  try {
    return await importLinkWithYtDlp({ url, mode, jobId });
  } catch (e) {
    safeLogger.error({ category: 'runtime', event: 'runtime.link-import-handler-failed', error: e });
    return { success: false, error: safeErrorText(e, 'PROVIDER_ERROR') };
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
    return { success: false, error: safeErrorText(e) };
  }
});

ipcMain.handle('link-import:openFolder', async () => {
  try {
    const directory = linkImportsRootDir();
    await shell.openPath(directory);
    return { success: true, directory };
  } catch (e) {
    return { success: false, error: safeErrorText(e) };
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
      return { success: false, error: safeErrorText({ code: 'NOT_FOUND' }, 'NOT_FOUND') };
    }

    const args = ['-y', '-i', inputPath, '-vn', '-ar', '16000', '-ac', '1', '-c:a', 'pcm_s16le', outputPath];
    const result = await runFfmpeg(args);

    if (result.success) return { success: true, outputPath };
    return { success: false, error: result.error, stderr: '' };
  } catch (e) {
    safeLogger.error({ category: 'ffmpeg', event: 'ffmpeg.convert-wav-failed', error: e });
    return { success: false, error: safeErrorText(e, 'PROVIDER_ERROR'), stderr: '' };
  }
});

ipcMain.handle('ffmpeg:extractAudioForTranscription', async (_, { inputPath }) => {
  try {
    const tempDir = getTempDir();
    fs.mkdirSync(tempDir, { recursive: true });
    const outputPath = path.join(tempDir, `video_audio_${Date.now()}.wav`);
    if (!fs.existsSync(inputPath)) {
      return { success: false, error: safeErrorText({ code: 'NOT_FOUND' }, 'NOT_FOUND') };
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
    return { success: false, error: result.error, stderr: '' };
  } catch (e) {
    safeLogger.error({ category: 'ffmpeg', event: 'ffmpeg.extract-audio-failed', error: e });
    return { success: false, error: safeErrorText(e, 'PROVIDER_ERROR'), stderr: '' };
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
        safeLogger.warn({ category: 'ffmpeg', event: 'ffmpeg.chunk-failed', data: { index: i } });
        continue;
      }
      chunkPaths.push(outPath);
    }

    return { success: chunkPaths.length > 0, chunkPaths };
  } catch (e) {
    safeLogger.error({ category: 'ffmpeg', event: 'ffmpeg.slice-chunks-failed', error: e });
    return { success: false, chunkPaths: [], error: safeErrorText(e, 'PROVIDER_ERROR') };
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
    safeLogger.info({ category: 'ffmpeg', event: 'ffmpeg.probe-started', data: { operation: 'video-info' } });
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
      return { success: false, error: safeErrorText({ code: 'NOT_FOUND' }, 'NOT_FOUND') };
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

    safeLogger.info({ category: 'ffmpeg', event: 'ffmpeg.waveform-started', data: { operation: 'waveform' } });
    const result = await new Promise(resolve => {
      let stderr = '';
      const chunks = [];
      let proc;
      try {
        proc = spawn(ffmpegPath, args, { stdio: ['ignore', 'pipe', 'pipe'] });
      } catch (e) {
        resolve({ success: false, error: safeErrorText(e, 'PROVIDER_ERROR'), stderr: '' });
        return;
      }
      proc.stdout.on('data', d => chunks.push(Buffer.from(d)));
      proc.stderr.on('data', d => { stderr += d.toString(); });
      proc.on('error', e => resolve({ success: false, error: safeErrorText(e, 'PROVIDER_ERROR'), stderr: '' }));
      proc.on('close', code => {
        if (code !== 0) {
          resolve({ success: false, error: safeErrorText({ code: 'PROVIDER_ERROR' }, 'PROVIDER_ERROR'), stderr: '' });
          return;
        }
        resolve({ success: true, buffer: Buffer.concat(chunks), stderr: '' });
      });
    });

    if (!result.success) return { ...result, error: safeErrorText({ code: 'PROVIDER_ERROR' }, 'PROVIDER_ERROR'), stderr: '' };
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
    safeLogger.error({ category: 'ffmpeg', event: 'ffmpeg.waveform-failed', error: e });
    return { success: false, error: safeErrorText(e, 'PROVIDER_ERROR') };
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
    safeLogger.error({ category: 'ffmpeg', event: 'ffmpeg.preview-frame-failed', error: e });
    return { success: false, error: safeErrorText(e, 'PROVIDER_ERROR') };
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
    safeLogger.error({ category: 'ffmpeg', event: 'ffmpeg.export-clip-failed', error: e });
    return { success: false, error: safeErrorText(e, 'PROVIDER_ERROR') };
  }
});


ipcMain.handle('hyperframes:exportShorts', async (_, snapshot) => (
  hyperframesExportSession.start(snapshot)
));

ipcMain.handle('hyperframes:cancelExport', async (_, payload) => (
  hyperframesExportSession.cancel(payload)
));

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
    safeLogger.error({ category: 'runtime', event: 'runtime.media-info-failed', error: err });
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
    return { success: false, error: safeErrorText(e) };
  }
});

ipcMain.handle('fs:pathToFileUrl', async (_, { filePath }) => {
  try {
    if (!filePath || !fs.existsSync(filePath)) {
      return { success: false, error: safeErrorText({ code: 'NOT_FOUND' }, 'NOT_FOUND') };
    }
    return { success: true, url: pathToFileURL(filePath).href };
  } catch (e) {
    return { success: false, error: safeErrorText(e) };
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
    return { ok: false, error: safeErrorText(error) };
  }
});

ipcMain.handle('project:save', async (_event, project) => {
  try {
    const saved = saveProjectRecord(project);
    return { ok: true, project: saved };
  } catch (error) {
    return { ok: false, error: safeErrorText(error) };
  }
});

ipcMain.handle('project:load', async (_event, { id }) => {
  try {
    const project = readProject(id);
    if (project && project.session) {
      project.session = normalizeShortsSessionState(
        normalizeImportedProjectSession(project.session, { projectId: project.id })
      );
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
          safeLogger.warn({ category: 'runtime', event: 'runtime.media-probe-failed', error: err });
        }
      }
    }
    return { ok: true, project };
  } catch (error) {
    return { ok: false, error: safeErrorText(error) };
  }
});

ipcMain.handle('project:delete', async (_event, { id }) => {
  try {
    fs.rmSync(projectDir(id), { recursive: true, force: true });
    return { ok: true };
  } catch (error) {
    return { ok: false, error: safeErrorText(error) };
  }
});

ipcMain.handle('project:clearAll', async () => {
  try {
    fs.rmSync(projectsRootDir(), { recursive: true, force: true });
    fs.mkdirSync(projectsRootDir(), { recursive: true });
    return { ok: true };
  } catch (error) {
    return { ok: false, error: safeErrorText(error) };
  }
});

ipcMain.handle('project:export', async (_event, { id }) => {
  try {
    const project = readProject(id);
    if (project?.session) project.session = normalizeShortsSessionState(project.session);
    const result = await dialog.showSaveDialog(windowManager.getMainWindow(), {
      defaultPath: `${safeName(project.name || project.session?.sourceFileName || 'VaniScript Project')}.vaniscript`,
      filters: [{ name: 'VaniScript Project', extensions: ['vaniscript'] }],
    });
    if (result.canceled || !result.filePath) return { ok: false, error: 'Export cancelled' };
    await streamingBundleService.writeProjectBundle(project, result.filePath);
    return { ok: true, filePath: result.filePath };
  } catch (error) {
    return { ok: false, error: error.message || String(error) };
  }
});

ipcMain.handle('project:exportAll', async () => {
  try {
    const projects = listProjects().map((summary) => readProject(summary.id));
    for (const project of projects) {
      if (project?.session) project.session = normalizeShortsSessionState(project.session);
    }
    const result = await dialog.showSaveDialog(windowManager.getMainWindow(), {
      defaultPath: 'VaniScript Library.vaniscript-library',
      filters: [{ name: 'VaniScript Library', extensions: ['vaniscript-library'] }],
    });
    if (result.canceled || !result.filePath) return { ok: false, error: 'Export cancelled' };
    await streamingBundleService.writeLibraryBundle(projects, result.filePath);
    return { ok: true, filePath: result.filePath };
  } catch (error) {
    return { ok: false, error: error.message || String(error) };
  }
});

ipcMain.handle('project:import', async () => {
  try {
    const result = await dialog.showOpenDialog(windowManager.getMainWindow(), {
      properties: ['openFile'],
      filters: [
        { name: 'VaniScript Projects', extensions: ['vaniscript', 'vaniscript-library'] },
        { name: 'All Files', extensions: ['*'] },
      ],
    });
    if (result.canceled || !result.filePaths[0]) return { ok: false, error: 'Import cancelled' };
    const filePath = result.filePaths[0];

    // One hardened service call routes all four supported formats by content.
    const importedProjects = await streamingBundleService.importBundle(filePath);
    if (importedProjects[0]?.session) {
      importedProjects[0].session = normalizeShortsSessionState(importedProjects[0].session);
    }
    return { ok: true, project: importedProjects[0] || null };
  } catch (error) {
    return { ok: false, error: error.message || String(error) };
  }
});

// ─── IPC: Legacy localStorage → Main disk store migration (one-shot) ─────────
ipcMain.handle('settings:migrateLegacy', async (_event, payload) => {
  try {
    // No explicit paths: handler writes to the canonical settings/vault defaults.
    return await handleMigrateLegacy(payload || {}, {});
  } catch (error) {
    return {
      ok: false,
      errorCode: 'INTERNAL',
      error: safeErrorText(error),
    };
  }
});

// ─── IPC: Main-owned usage ledger ────────────────────────────────────────────
const usagePurposes = new Set(['text', 'chat', 'translation', 'transcription', 'vision', 'review', 'polish', 'shorts']);
function normalizeUsageRange(input) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) return undefined;
  const range = {};
  if (typeof input.from === 'string') range.from = input.from.slice(0, 10);
  if (typeof input.to === 'string') range.to = input.to.slice(0, 10);
  return Object.keys(range).length > 0 ? range : undefined;
}
function normalizeUsageRecordInput(input) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) return null;
  if (typeof input.operationId !== 'string' || !input.operationId.trim()) return null;
  if (typeof input.providerId !== 'string' || !input.providerId.trim()) return null;
  if (!usagePurposes.has(input.purpose)) return null;
  if (input.outcome !== 'success' && input.outcome !== 'error') return null;
  return {
    operationId: input.operationId,
    providerId: input.providerId,
    ...(typeof input.modelId === 'string' ? { modelId: input.modelId } : {}),
    purpose: input.purpose,
    outcome: input.outcome,
    ...(Number.isFinite(Number(input.inputTokens)) ? { inputTokens: Number(input.inputTokens) } : {}),
    ...(Number.isFinite(Number(input.outputTokens)) ? { outputTokens: Number(input.outputTokens) } : {}),
    ...(Number.isFinite(Number(input.audioMinutes)) ? { audioMinutes: Number(input.audioMinutes) } : {}),
    ...(typeof input.errorCode === 'string' ? { errorCode: input.errorCode } : {}),
  };
}
ipcMain.handle('usage:get', async (_event, range) => ({
  ok: true,
  usage: observability.usage.get(normalizeUsageRange(range)),
}));
ipcMain.handle('usage:record', async (_event, input) => {
  const normalized = normalizeUsageRecordInput(input);
  return {
    ok: true,
    usage: normalized ? observability.usage.record(normalized) : observability.usage.get(),
  };
});
ipcMain.handle('usage:reset', async () => ({
  ok: true,
  usage: observability.usage.reset(),
}));
ipcMain.handle('usage:export', async (_event, range) => {
  try {
    const result = await dialog.showSaveDialog(windowManager.getMainWindow(), {
      defaultPath: 'VaniScript-usage.json',
      filters: [{ name: 'JSON', extensions: ['json'] }],
    });
    if (result.canceled || !result.filePath) return { ok: false, cancelled: true };
    fs.writeFileSync(result.filePath, JSON.stringify(observability.usage.export(normalizeUsageRange(range)), null, 2), {
      encoding: 'utf8',
      mode: 0o600,
    });
    return { ok: true };
  } catch (error) {
    safeLogger.error({ category: 'usage', event: 'usage.export-failed', error });
    return { ok: false, error: safeIpcError(error) };
  }
});

// ─── IPC: Safe diagnostics ──────────────────────────────────────────────────
ipcMain.handle('diagnostics:get', async () => ({
  ok: true,
  snapshot: observability.diagnostics.snapshot(),
}));
ipcMain.handle('diagnostics:export', async () => {
  try {
    const result = await dialog.showSaveDialog(windowManager.getMainWindow(), {
      defaultPath: 'VaniScript-diagnostics.json',
      filters: [{ name: 'JSON', extensions: ['json'] }],
    });
    if (result.canceled || !result.filePath) return { ok: false, cancelled: true };
    const snapshot = observability.diagnostics.snapshot();
    fs.writeFileSync(result.filePath, JSON.stringify(snapshot, null, 2), {
      encoding: 'utf8',
      mode: 0o600,
    });
    return { ok: true };
  } catch (error) {
    safeLogger.error({ category: 'diagnostics', event: 'diagnostics.export-failed', error });
    return { ok: false, error: safeIpcError(error) };
  }
});
ipcMain.handle('diagnostics:openLogs', async () => {
  try {
    if (!configuredLogPath) return { ok: false, error: safeIpcError({ code: 'NOT_FOUND' }) };
    const errorText = await shell.openPath(configuredLogPath);
    if (errorText) return { ok: false, error: safeIpcError({ code: 'NOT_FOUND' }) };
    return { ok: true };
  } catch (error) {
    safeLogger.error({ category: 'diagnostics', event: 'diagnostics.open-logs-failed', error });
    return { ok: false, error: safeIpcError(error) };
  }
});

ipcMain.handle('renderer:report', async (_event, payload = {}) => {
  const level = payload?.level === 'warn' ? 'warn' : payload?.level === 'debug' ? 'debug' : 'error';
  const event = typeof payload?.event === 'string' ? payload.event : 'renderer.error';
  const code = typeof payload?.code === 'string' ? payload.code : 'INTERNAL';
  safeLogger[level]({ category: 'renderer', event, data: { code } });
  return { ok: true };
});

// ─── IPC: Cloud provider routing (secure proxy) ───────────────────────────────
// The renderer never receives API keys. Main resolves the key from the vault,
// injects it into the outgoing request, and returns only the normalized result.
// App-level errors cross IPC as a resolved envelope carrying the AppError marker
// (Electron drops the thrown error's prototype/flag during serialization).
ipcMain.handle('provider:invoke', async (_event, request) => {
  const operationId = typeof request?.operationId === 'string' && request.operationId.length > 0
    ? request.operationId
    : crypto.randomUUID();
  const purpose = usagePurposes.has(request?.purpose) ? request.purpose : 'text';
  try {
    const result = await invokeProvider(request);
    observability.usage.record({
      operationId,
      providerId: result.providerId,
      modelId: result.model,
      purpose,
      outcome: 'success',
      inputTokens: result.usage?.promptTokens,
      outputTokens: result.usage?.completionTokens,
    });
    return result;
  } catch (err) {
    observability.usage.record({
      operationId,
      providerId: request?.providerId || 'unknown',
      modelId: request?.modelId,
      purpose,
      outcome: 'error',
      errorCode: safeIpcError(err).code,
    });
    const safe = safeIpcError(err);
    observability.recordError(err, { category: 'provider', event: 'provider.invoke-failed', correlation: { operationId } });
    return safe;
  }
});

// ─── IPC: Local model manager (MOD-01) ───────────────────────────────────────
// Scan / verify / relocate local models entirely in the Main process. The
// renderer only passes intent; the manager enforces path-traversal guards and
// checksum verification, and never exposes model bytes or secret material.
ipcMain.handle(MODELS_MANAGE_CHANNEL, async (_event, request) => {
  try {
    return { ok: true, result: await manageModels(request) };
  } catch (err) {
    if (err && err.isAppError) {
      return { ok: false, error: safeIpcError(err) };
    }
    return { ok: false, error: safeIpcError(err) };
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
    return { ok: false, asr: {}, translation: {}, error: safeErrorText(error, 'MODEL_UNAVAILABLE') };
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
    return { ok: false, id: modelId, error: safeErrorText(e, 'MODEL_UNAVAILABLE') };
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
    return { ok: false, id: modelId, error: safeErrorText(e, 'MODEL_UNAVAILABLE') };
  }
});

ipcMain.handle('local-translation:installModel', async (_event, { modelId }) => {
  try {
    const result = await callLocalTranslationWorker({ type: 'install_model', modelId });
    broadcastSharedLocalModels();
    return { ok: true, id: modelId, path: result.path ?? null };
  } catch (error) {
    return { ok: false, id: modelId, error: safeErrorText(error, 'MODEL_UNAVAILABLE') };
  }
});

ipcMain.handle('local-translation:removeModel', async (_event, { modelId }) => {
  try {
    removeTranslationModel(resolveLocalTranslationStorageDir(), modelId);
    broadcastSharedLocalModels();
    return { ok: true, id: modelId };
  } catch (error) {
    return { ok: false, id: modelId, error: safeErrorText(error, 'MODEL_UNAVAILABLE') };
  }
});

ipcMain.handle('local-translation:resolveModelPath', async (_event, { modelId }) => {
  try {
    const modelPath = resolveInstalledModelPath(resolveLocalTranslationStorageDir(), modelId);
    return { ok: true, id: modelId, path: modelPath ?? null };
  } catch (error) {
    return { ok: false, id: modelId, error: safeErrorText(error, 'MODEL_UNAVAILABLE') };
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
    return { ok: false, kind, modelId, error: safeErrorText(error, 'MODEL_UNAVAILABLE') };
  }
});

ipcMain.handle('local-translation:translateText', async (_event, payload) => {
  try {
    const modelPath = resolveInstalledModelPath(resolveLocalTranslationStorageDir(), payload?.modelId);
    if (!modelPath) {
      throw new Error('Local translation model is not installed.');
    }
    return await callLocalTranslationWorker({ type: 'translate_text', ...payload });
  } catch (error) {
    observability.recordError(error, { category: 'worker', event: 'worker.translation-failed' });
    throw new Error(safeErrorText(error, 'MODEL_UNAVAILABLE'));
  }
});

ipcMain.handle('local-asr:transcribeChunk', async (_event, { modelId, chunkPath, options = {} }) => {
  try {
    if (!chunkPath || !fs.existsSync(chunkPath)) throw new Error('Chunk file is not available.');
    if (isParakeetModel(modelId)) {
      const parakeetStatus = summarizeParakeetModel(modelId);
      if (parakeetStatus.status !== 'downloaded') throw new Error('Local ASR model is not installed.');
      const wavBuffer = fs.readFileSync(chunkPath);
      const pcm = decodeWavToFloat32(wavBuffer);
      return await callLocalParakeetWorker({
        type: 'transcribe',
        modelId: PARAKEET_MODEL_MAP[modelId],
        audioData: Buffer.from(pcm.buffer, pcm.byteOffset, pcm.byteLength),
      });
    }
    const whisperStatus = summarizeWhisperModel(modelId);
    if (whisperStatus.status !== 'downloaded') throw new Error('Local ASR model is not installed.');
    return await callLocalWhisperWorker({ type: 'transcribe_chunk', modelId, chunkPath, options });
  } catch (error) {
    observability.recordError(error, { category: 'worker', event: 'worker.transcription-failed' });
    throw new Error(safeErrorText(error, 'MODEL_UNAVAILABLE'));
  }
});

safeLogger.info({ category: 'runtime', event: 'runtime.ready', data: { status: 'ready' } });

// ─── MCP Server & Renderer IPC Bridge ───────────────────────────────────────
let mcpHttpServer = null;
const activeSseConnections = new Map(); // sessionId -> response object
const pendingMcpRequests = new Map(); // requestId -> { resolve, reject }

// Per-session access token for the Electron MCP server (:19789). Generated at
// server start and required on every /sse and /message request (parity with the
// Apple Silicon McpServerConfiguration.isAuthorized() logic in McpContracts.swift).
let mcpAccessToken = '';

// Validate an incoming MCP request against the session token.
// Mirrors AS isAuthorized(): Bearer or x-vaniscript-mcp-token header must equal
// mcpAccessToken; an empty token denies everything (fail-closed).
function isMcpAuthorized(req) {
  if (!mcpAccessToken) return false;
  const auth = (req.headers['authorization'] || '').trim();
  if (auth.toLowerCase().startsWith('bearer ') &&
      auth.slice(7).trim() === mcpAccessToken) {
    return true;
  }
  const customHeader = (req.headers['x-vaniscript-mcp-token'] || '').trim();
  if (customHeader === mcpAccessToken) return true;
  return false;
}

// True only for loopback origins (127.0.0.1, ::1, localhost). Mirrors AS isLoopbackHost.
function isLoopbackOrigin(origin) {
  try {
    const u = new URL(origin);
    const h = u.hostname.replace(/^\[|\]$/g, '').toLowerCase();
    return h === '127.0.0.1' || h === '::1' || h === 'localhost';
  } catch { return false; }
}

function startMcpServer() {
  const http = require('http');
  const { parse: parseUrl } = require('url');
  const mcpLogger = typeof safeLogger !== 'undefined'
    ? safeLogger
    : {
      info: () => {},
      warn: () => {},
      error: () => {},
    };
  const mcpAudit = typeof observability !== 'undefined' && observability?.audit?.record
    ? observability.audit
    : null;
  const recordLegacyAudit = mcpAudit && typeof createLegacyAuditRecorder === 'function'
    ? createLegacyAuditRecorder(mcpAudit, () => new Date())
    : () => {};
  const mcpSafeError = typeof safeMcpError === 'function'
    ? safeMcpError
    : () => ({ code: 'MCP_INTERNAL', message: 'MCP request failed.' });

  // Generate a fresh session token so only holders of it can use the MCP server.
  mcpAccessToken = crypto.randomBytes(32).toString('hex');
  mcpLogger.info({ category: 'mcp', event: 'mcp.token-generated', data: { state: 'ready' } });

  mcpHttpServer = http.createServer((req, res) => {
    const parsed = parseUrl(req.url, true);
    const pathname = parsed.pathname;
    const peer = req.socket?.remoteAddress || 'loopback';

    // CORS: allow only loopback origins (parity with AS isAllowedOrigin).
    // Native MCP clients send no Origin header, so fall back to '*'.
    const origin = (req.headers['origin'] || '').trim();
    if (!origin || isLoopbackOrigin(origin)) {
      res.setHeader('Access-Control-Allow-Origin', origin || '*');
    } else {
      res.setHeader('Access-Control-Allow-Origin', 'http://127.0.0.1');
    }
    res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers',
      'Content-Type, Authorization, x-vaniscript-mcp-token');

    if (req.method === 'OPTIONS') {
      res.writeHead(204);
      res.end();
      return;
    }

    if (pathname === '/sse' && req.method === 'GET') {
      if (!isMcpAuthorized(req)) {
        res.writeHead(401, { 'Content-Type': 'text/plain' });
        res.end('Unauthorized');
        mcpLogger.warn({ category: 'mcp', event: 'mcp.request-denied', data: { route: '/sse', method: req.method, outcome: 'denied' } });
        recordLegacyAudit({ peer, route: '/sse', method: req.method, outcome: 'denied', mcpCode: 'MCP_UNAUTHORIZED', reason: 'unauthorized', requestId: req.headers['x-request-id'] });
        return;
      }
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
        recordLegacyAudit({ peer, route: '/sse', method: 'GET', outcome: 'success', reason: null, requestId: req.headers['x-request-id'] });
        mcpLogger.info({ category: 'mcp', event: 'mcp.sse-disconnected', data: { route: '/sse', outcome: 'success' } });
      });
      
      mcpLogger.info({ category: 'mcp', event: 'mcp.sse-connected', data: { route: '/sse', outcome: 'success' } });
      return;
    }

    if (pathname === '/message' && req.method === 'POST') {
      if (!isMcpAuthorized(req)) {
        res.writeHead(401, { 'Content-Type': 'text/plain' });
        res.end('Unauthorized');
        mcpLogger.warn({ category: 'mcp', event: 'mcp.request-denied', data: { route: '/message', method: req.method, outcome: 'denied' } });
        recordLegacyAudit({ peer, route: '/message', method: req.method, outcome: 'denied', mcpCode: 'MCP_UNAUTHORIZED', reason: 'unauthorized', requestId: req.headers['x-request-id'] });
        return;
      }
      const sessionId = parsed.query.sessionId;
      let body = '';
      req.on('data', chunk => { body += chunk; });
      req.on('end', async () => {
        try {
          const rpc = JSON.parse(body);
          mcpLogger.info({ category: 'mcp', event: 'mcp.request-received', data: { route: '/message', method: req.method, state: 'parsed' } });

          // Standard SSE protocol: POST receives immediate 202, actual response goes via SSE
          res.writeHead(202);
          res.end();

          const sseResponse = activeSseConnections.get(sessionId);
          if (!sseResponse) {
            mcpLogger.warn({ category: 'mcp', event: 'mcp.session-missing', data: { route: '/message', outcome: 'rejected' } });
            recordLegacyAudit({ peer, route: '/message', method: req.method, outcome: 'rejected', mcpCode: 'MCP_NOT_FOUND', reason: 'missing_window', tool: rpc.method, requestId: req.headers['x-request-id'] });
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
            recordLegacyAudit({ peer, route: '/message', method: req.method, outcome: 'success', reason: null, tool: 'initialize', requestId: req.headers['x-request-id'] });
            return;
          }

          if (rpc.method === 'notifications/initialized') {
            recordLegacyAudit({ peer, route: '/message', method: req.method, outcome: 'success', reason: null, tool: 'notifications/initialized', requestId: req.headers['x-request-id'] });
            return;
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
                ].concat(MCP_MAIN_TOOL_DEFINITIONS)
              }
            };
            sseResponse.write(`event: message\ndata: ${JSON.stringify(response)}\n\n`);
            recordLegacyAudit({ peer, route: '/message', method: req.method, outcome: 'success', reason: null, tool: 'tools/list', requestId: req.headers['x-request-id'] });
            return;
          }

          if (rpc.method === 'tools/call') {
            const { name, arguments: args } = rpc.params || {};

            // S4-C/S5: file-export, preflight, and Shorts reads execute in
            // Main, ahead of the window-active guard and the legacy renderer
            // forwarding path (which stays untouched for its eight tools).
            const mainToolCatalog = typeof name === 'string' ? dispatchedMcpToolCatalog(name) : null;
            if (mainToolCatalog) {
              let response;
              try {
                const result = await mainToolCatalog.execute(
                  name,
                  args && typeof args === 'object' && !Array.isArray(args) ? args : {},
                );
                response = {
                  jsonrpc: '2.0',
                  id: rpc.id,
                  result: {
                    content: [
                      { type: 'text', text: JSON.stringify(result, null, 2) },
                    ],
                  },
                };
              } catch (error) {
                const safe = mcpSafeError(error, 'MCP_INTERNAL');
                mcpLogger.error({ category: 'mcp', event: 'mcp.tool-failed', data: { tool: name, outcome: 'rejected' }, error });
                recordLegacyAudit({ peer, route: '/message', method: req.method, outcome: 'rejected', mcpCode: safe.code, reason: 'server_error', tool: name, requestId: req.headers['x-request-id'] });
                response = {
                  jsonrpc: '2.0',
                  id: rpc.id,
                  error: { ...mcpToolRpcError({ ...error, code: safe.code, message: safe.message }), message: safe.message },
                };
                sseResponse.write(`event: message\ndata: ${JSON.stringify(response)}\n\n`);
                return;
              }
              sseResponse.write(`event: message\ndata: ${JSON.stringify(response)}\n\n`);
              recordLegacyAudit({ peer, route: '/message', method: req.method, outcome: 'success', reason: null, tool: name, requestId: req.headers['x-request-id'] });
              return;
            }
            if (!windowManager.getMainWindow()) {
              const errResponse = {
                jsonrpc: '2.0',
                id: rpc.id,
                error: { code: -32603, message: 'VaniScript main window is not active.' }
              };
              sseResponse.write(`event: message\ndata: ${JSON.stringify(errResponse)}\n\n`);
              mcpLogger.warn({ category: 'mcp', event: 'mcp.window-missing', data: { route: '/message', outcome: 'rejected' } });
              recordLegacyAudit({ peer, route: '/message', method: req.method, outcome: 'rejected', mcpCode: 'MCP_CAPABILITY_UNAVAILABLE', reason: 'missing_window', tool: name, requestId: req.headers['x-request-id'] });
              return;
            }

            const requestId = crypto.randomUUID();
            pendingMcpRequests.set(requestId, {
              resolve: (result) => {
                const pending = pendingMcpRequests.get(requestId);
                if (pending?.timeout) clearTimeout(pending.timeout);
                const response = {
                  jsonrpc: '2.0',
                  id: rpc.id,
                  result: {
                    content: [
                      { type: 'text', text: typeof result === 'string' ? result : JSON.stringify(result, null, 2) }
                    ]
                  }
                };
                recordLegacyAudit({ peer, route: '/message', method: req.method, outcome: 'success', reason: null, tool: name, requestId: req.headers['x-request-id'] || requestId });
                sseResponse.write(`event: message\ndata: ${JSON.stringify(response)}\n\n`);
              },
              reject: (error) => {
                const safe = mcpSafeError(error, 'MCP_INTERNAL');
                const pending = pendingMcpRequests.get(requestId);
                if (pending?.timeout) clearTimeout(pending.timeout);
                const response = {
                  jsonrpc: '2.0',
                  id: rpc.id,
                  error: { code: -32603, message: safe.message },
                };
                mcpLogger.error({ category: 'mcp', event: 'mcp.renderer-tool-failed', data: { tool: name, outcome: 'rejected' }, error });
                recordLegacyAudit({ peer, route: '/message', method: req.method, outcome: 'rejected', mcpCode: safe.code, reason: 'renderer_rejected', tool: name, requestId: req.headers['x-request-id'] || requestId });
                sseResponse.write(`event: message\ndata: ${JSON.stringify(response)}\n\n`);
              },
              timeout: setTimeout(() => {
                if (!pendingMcpRequests.has(requestId)) return;
                pendingMcpRequests.delete(requestId);
                const response = {
                  jsonrpc: '2.0',
                  id: rpc.id,
                  error: { code: -32603, message: 'MCP request timed out.' },
                };
                mcpLogger.warn({ category: 'mcp', event: 'mcp.request-timeout', data: { tool: name, outcome: 'timeout' } });
                recordLegacyAudit({ peer, route: '/message', method: req.method, outcome: 'timeout', mcpCode: 'MCP_REQUEST_TIMEOUT', reason: 'timeout', tool: name, requestId: req.headers['x-request-id'] || requestId });
                try { sseResponse.write(`event: message\ndata: ${JSON.stringify(response)}\n\n`); } catch { /* disconnected client */ }
              }, 15_000),
            });
            // Forward tool call to React renderer
            windowManager.getMainWindow().webContents.send('mcp:call-tool', { name, arguments: args, requestId });
            return;
          }

          // Unhandled
          const unhandled = {
            jsonrpc: '2.0',
            id: rpc.id,
            error: { code: -32601, message: 'Method not found.' }
          };
          recordLegacyAudit({ peer, route: '/message', method: req.method, outcome: 'rejected', mcpCode: 'MCP_METHOD_NOT_FOUND', reason: 'server_error', tool: rpc.method, requestId: req.headers['x-request-id'] });
          sseResponse.write(`event: message\ndata: ${JSON.stringify(unhandled)}\n\n`);
        } catch (err) {
          mcpLogger.error({ category: 'mcp', event: 'mcp.request-parse-failed', data: { route: '/message', outcome: 'rejected' }, error: err });
          if (!res.headersSent) {
            res.writeHead(400, { 'Content-Type': 'text/plain' });
            res.end('Invalid request');
          }
          recordLegacyAudit({ peer, route: '/message', method: req.method, outcome: 'rejected', mcpCode: 'MCP_INVALID_REQUEST', reason: 'parse_failed', requestId: req.headers['x-request-id'] });
        }
      });
      return;
    }

    res.writeHead(404);
    res.end();
    mcpLogger.warn({ category: 'mcp', event: 'mcp.route-not-found', data: { route: pathname, method: req.method, outcome: 'rejected' } });
    recordLegacyAudit({ peer, route: pathname, method: req.method, outcome: 'rejected', mcpCode: 'MCP_NOT_FOUND', reason: 'server_error', requestId: req.headers['x-request-id'] });
  });

  mcpHttpServer.listen(19789, '127.0.0.1', () => {
    mcpLogger.info({ category: 'mcp', event: 'mcp.server-listening', data: { route: '/sse', status: 'ready' } });
  });

  mcpHttpServer.on('error', (err) => {
    mcpLogger.error({ category: 'mcp', event: 'mcp.server-error', data: { route: '/sse' }, error: err });
    recordLegacyAudit({ peer: 'loopback', route: '/sse', method: 'SERVER', outcome: 'rejected', mcpCode: 'MCP_INTERNAL', reason: 'server_error' });
  });
}

function stopMcpServer() {
  if (mcpHttpServer) {
    try {
      mcpHttpServer.close();
      mcpLogger.info({ category: 'mcp', event: 'mcp.server-closed', data: { route: '/sse', status: 'closed' } });
    } catch (e) {
      mcpLogger.error({ category: 'mcp', event: 'mcp.server-close-failed', data: { route: '/sse' }, error: e });
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

/** Project-scoped Grok config: prefer vaniscript_embedded MCP (no secrets inlined). */
function writeGrokProjectConfig(workspace) {
  const grokDir = path.join(workspace, '.grok');
  fs.mkdirSync(grokDir, { recursive: true });
  const endpoint = `http://127.0.0.1:${GROK_MCP_PORT}/sse`;
  const config = `# Generated by VaniScript Electron embedded Grok chat.
[plugins]
enabled = []

[mcp_servers.${GROK_EMBEDDED_SERVER_ID}]
url = "${endpoint}"
enabled = true
headers = { "x-vaniscript-mcp-token" = "${mcpAccessToken}" }
`;
  const configPath = path.join(grokDir, 'config.toml');
  fs.writeFileSync(configPath, config, { encoding: 'utf8', mode: 0o600 });
  return configPath;
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

// Live Grok Build streaming-json: {"type":"text","data":"..."} plus legacy dialects.
function extractGrokStreamingText(obj) {
  if (!obj || typeof obj !== 'object') return '';
  if (obj.type === 'thought') return '';
  if (obj.type === 'text' && typeof obj.data === 'string') return obj.data;
  if (typeof obj.data === 'string' && obj.type === 'content') return obj.data;
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
  writeGrokProjectConfig(workspace);
  const prompt = buildGrokPrompt(messages, systemPrompt);
  const resolvedModel = model || 'grok-4.5';

  // Grok CLI requires the prompt as a value for -p/--single or --prompt-file.
  // Codex-style stdin + -p without a value fails with:
  //   "a value is required for '--single <PROMPT>' but none was supplied"
  const promptFile = path.join(workspace, 'embedded-prompt.txt');
  fs.writeFileSync(promptFile, prompt, { encoding: 'utf8' });

  // --trust: project-scoped MCP in GrokAgentWorkspace is blocked without it.
  const child = spawn(grokPath, [
    '--trust',
    '--prompt-file', promptFile,
    '--output-format', 'streaming-json',
    '--model', resolvedModel,
    '--cwd', workspace,
    '--always-approve',
    '--max-turns', '64',
    '--no-subagents',
    '--permission-mode', 'bypassPermissions',
  ], {
    cwd: workspace,
    env: {
      ...process.env,
      NO_PROXY: '127.0.0.1,localhost',
      no_proxy: '127.0.0.1,localhost',
      // Hand the session MCP token to the Grok subprocess so it can reach :19789.
      VANISCRIPT_MCP_TOKEN: mcpAccessToken,
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

  child.stderr.on('data', () => safeLogger.warn({ category: 'agent', event: 'agent.stderr', data: { agent: 'grok', stream: 'stderr' } }));

  child.on('error', (err) => {
    try { fs.unlinkSync(promptFile); } catch { /* ignore */ }
    safeLogger.error({ category: 'agent', event: 'agent.launch-failed', data: { agent: 'grok' }, error: err });
    sender.send('grok:error', { error: 'launchFailed', message: 'Could not start Grok.' });
  });

  child.on('close', (code) => {
    try { fs.unlinkSync(promptFile); } catch { /* ignore */ }
    const tail = buffer.trim();
    if (tail) flushLine(tail);
    if (code === 0) {
      sender.send('grok:done', {});
    } else {
      sender.send('grok:error', { error: 'unavailable', message: `Grok finished with exit code ${code}.` });
    }
  });

  return { ok: true };
});

// ─── Embedded Qwen chat (headless CLI) ───────────────────────────────────────
// Mirrors the Apple Silicon QwenAgentService: spawn the locally installed `qwen`
// CLI headless against the in-app MCP SSE server (port 19789). MCP config is
// written as .qwen/settings.json with env-var token substitution (no raw secret).
// There is NO silent fallback to any other provider.
const QWEN_MCP_PORT = 19789;
const QWEN_EMBEDDED_SERVER_ID = 'vaniscript_embedded';

function resolveQwenExecutable() {
  const candidates = [
    path.join(os.homedir(), '.local', 'bin', 'qwen'),
    '/usr/local/bin/qwen',
    '/opt/homebrew/bin/qwen',
  ];
  for (const candidate of candidates) {
    try {
      if (fs.existsSync(candidate) && fs.statSync(candidate).isFile()) return candidate;
    } catch { /* ignore */ }
  }
  try {
    const resolved = execSync('command -v qwen', { encoding: 'utf8' }).trim();
    if (resolved) return resolved;
  } catch { /* ignore */ }
  return null;
}

function ensureQwenWorkspace() {
  const dir = path.join(app.getPath('userData'), 'QwenAgentWorkspace');
  fs.mkdirSync(dir, { recursive: true });
  try { fs.chmodSync(dir, 0o700); } catch { /* ignore */ }
  return dir;
}

/** Project-scoped Qwen MCP config: vaniscript_embedded via env-var token (no raw secret). */
function writeQwenProjectConfig(workspace) {
  const qwenDir = path.join(workspace, '.qwen');
  fs.mkdirSync(qwenDir, { recursive: true });
  const endpoint = `http://127.0.0.1:${QWEN_MCP_PORT}/sse`;
  // Token via ${VANISCRIPT_MCP_TOKEN} env substitution — never inlined as raw secret.
  const config = JSON.stringify({
    mcpServers: {
      [QWEN_EMBEDDED_SERVER_ID]: {
        url: endpoint,
        transport: 'sse',
        headers: { Authorization: 'Bearer ${VANISCRIPT_MCP_TOKEN}' },
        trust: true,
      },
    },
  }, null, 2);
  const configPath = path.join(qwenDir, 'settings.json');
  fs.writeFileSync(configPath, config, { encoding: 'utf8', mode: 0o600 });
  return configPath;
}

function buildQwenPrompt(messages, systemPrompt) {
  const conversation = (messages || [])
    .filter((m) => m.role === 'user' || m.role === 'assistant')
    .map((m) => `${m.role === 'user' ? 'User' : 'Assistant'}: ${m.text}`)
    .join('\n\n');
  const base = systemPrompt || `You are the embedded VaniScript text assistant. Reply directly in this VaniScript chat panel.

Use only the MCP server named ${QWEN_EMBEDDED_SERVER_ID} for VaniScript project information and actions. Do not use shell commands, files, browser, computer-use, web, skills, plugins, or any other MCP server.

For requests about the current project, prefer the narrowest authoritative read tool (get_project_state, get_subtitle_style, get_shorts_plans) and the edit tools available on the ${QWEN_EMBEDDED_SERVER_ID} server. Never claim an edit occurred unless the MCP tool confirms it.

Reply in the same language as the user's latest message. Keep replies concise and describe completed actions clearly.`;
  return `${base}\n\nConversation:\n${conversation}`;
}

// Qwen NDJSON: {"type":"assistant","message":{"content":[{"type":"text","text":"..."}]}}
// and {"type":"result","subtype":"success","result":"..."}
function extractQwenStreamingText(obj) {
  if (!obj || typeof obj !== 'object') return '';
  if (obj.type === 'assistant' && obj.message && Array.isArray(obj.message.content)) {
    return obj.message.content
      .filter((c) => c.type === 'text' && typeof c.text === 'string')
      .map((c) => c.text)
      .join('');
  }
  if (obj.type === 'result' && typeof obj.result === 'string') return obj.result;
  return '';
}

ipcMain.handle('qwen:chat', async (event, { messages, systemPrompt, model } = {}) => {
  const sender = event.sender;
  const qwenPath = resolveQwenExecutable();
  if (!qwenPath) {
    sender.send('qwen:error', {
      error: 'qwenNotInstalled',
      message: 'Qwen CLI was not found. Install Qwen Code (for example via `npm install -g @qwen-code/qwen-code`) and sign in before using the embedded Qwen chat.',
    });
    return { ok: false, error: 'qwenNotInstalled' };
  }

  const workspace = ensureQwenWorkspace();
  writeQwenProjectConfig(workspace);
  const prompt = buildQwenPrompt(messages, systemPrompt);
  const resolvedModel = model || 'qwen3.8-max-preview';

  // Qwen CLI: -p <prompt> -o stream-json -m <model>
  // No --safe-mode (Q3+), no --trust/--cwd (Qwen uses project-scoped isolation via cwd).
  const child = spawn(qwenPath, [
    '-p', prompt,
    '-o', 'stream-json',
    '-m', resolvedModel,
  ], {
    cwd: workspace,
    env: {
      ...process.env,
      NO_PROXY: '127.0.0.1,localhost',
      no_proxy: '127.0.0.1,localhost',
      // Token for MCP SSE auth — referenced as ${VANISCRIPT_MCP_TOKEN} in .qwen/settings.json.
      VANISCRIPT_MCP_TOKEN: mcpAccessToken,
    },
  });

  let buffer = '';

  const flushLine = (line) => {
    if (!line) return;
    try {
      const obj = JSON.parse(line);
      const text = extractQwenStreamingText(obj);
      if (text) sender.send('qwen:chunk', { text });
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

  child.stderr.on('data', () => safeLogger.warn({ category: 'agent', event: 'agent.stderr', data: { agent: 'qwen', stream: 'stderr' } }));

  child.on('error', (err) => {
    safeLogger.error({ category: 'agent', event: 'agent.launch-failed', data: { agent: 'qwen' }, error: err });
    sender.send('qwen:error', { error: 'launchFailed', message: 'Could not start Qwen.' });
  });

  child.on('close', (code) => {
    const tail = buffer.trim();
    if (tail) flushLine(tail);
    if (code === 0) {
      sender.send('qwen:done', {});
    } else {
      sender.send('qwen:error', { error: 'unavailable', message: `Qwen finished with exit code ${code}.` });
    }
  });

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
      pending.reject(new Error(safeErrorText({ code: 'PROVIDER_ERROR' }, 'PROVIDER_ERROR')));
    }
  }
});

// ─── App bootstrap ───────────────────────────────────────────────────────────
registerAppLifecycle({
  getTempDir,
  cleanupTempDir,
  startMcpServer,
  stopMcpServer,
  broadcastSharedLocalModels,
  windowManager,
});
