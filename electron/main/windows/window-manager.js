'use strict';

const { app, BrowserWindow, Menu, Tray, nativeImage, session, desktopCapturer } = require('electron');
const path = require('path');
const fs = require('fs');
let logger = {
  info: () => {},
  warn: () => {},
  error: () => {},
  debug: () => {},
};

function setLogger(next) {
  if (!next || typeof next.info !== 'function') return;
  logger = next;
}

const APP_NAME = 'VaniScript-Electron';

let mainWindow = null;
let tray = null;
let isQuitting = false;
const DEV_SERVER_CANDIDATES = [
  process.env.ELECTRON_RENDERER_URL,
  process.env.VITE_DEV_SERVER_URL,
  process.env.RENDERER_URL,
  process.env.DEV_SERVER_URL,
].filter(Boolean);
function getMainWindow() {
  return mainWindow;
}

function getIsQuitting() {
  return isQuitting;
}

function setIsQuitting(value) {
  isQuitting = Boolean(value);
}

function createVaniScriptIcon(template = false, size = 0) {
  const candidates = [
    path.join(__dirname, '..', '..', '..', 'assets', 'VS_Logo x256.png'),
    path.join(__dirname, '..', '..', '..', 'assets', 'icon.png'),
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
  logger.info({
    category: 'runtime',
    event: 'runtime.window-revealed',
    data: { reason, visible: mainWindow.isVisible(), focused: mainWindow.isFocused(), bounds: mainWindow.getBounds() },
  });
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

// Renderer security posture for the main window. Centralized so the boot
// contract is unit-testable without spinning up Electron:
//   - sandbox:true          → renderer runs in Chromium's sandboxed process
//   - contextIsolation:true → preload context is isolated from page JS
//   - nodeIntegration:false → page JS never gets Node/require access
const RENDERER_WEB_PREFERENCES = {
  preload: path.join(__dirname, '..', '..', 'preload.js'),
  contextIsolation: true,
  nodeIntegration: false,
  sandbox: true,
};

function createWindow(onRendererReady) {
  mainWindow = new BrowserWindow({
    width: 1536,
    height: 984,
    minWidth: 900,
    minHeight: 640,
    titleBarStyle: 'hiddenInset',
    backgroundColor: '#0a0a12',
    icon: createVaniScriptIcon(false),
    webPreferences: RENDERER_WEB_PREFERENCES,
    show: false,
    title: APP_NAME,
  });

  const devServerUrl = DEV_SERVER_CANDIDATES.find((candidate) => /^https?:\/\//i.test(candidate));
  const builtIndexPath = path.join(__dirname, '..', '..', '..', 'dist', 'index.html');

  if (devServerUrl) {
    logger.info({ category: 'renderer', event: 'renderer.load-started', data: { source: devServerUrl } });
    mainWindow.loadURL(devServerUrl);
    // mainWindow.webContents.openDevTools();
  } else {
    logger.info({ category: 'renderer', event: 'renderer.load-started', data: { source: builtIndexPath } });
    mainWindow.loadFile(builtIndexPath);
  }

  mainWindow.webContents.on('did-fail-load', (_event, errorCode, errorDescription, validatedURL) => {
    logger.error({ category: 'renderer', event: 'renderer.load-failed', data: { errorCode, sourceId: validatedURL } });
    revealMainWindow('renderer-failed-load');
  });

  mainWindow.webContents.on('did-finish-load', () => {
    logger.info({ category: 'renderer', event: 'renderer.loaded', data: { phase: 'finish' } });
    revealMainWindow('renderer-finished-load');
    if (typeof onRendererReady === 'function') onRendererReady();
  });

  mainWindow.webContents.on('dom-ready', () => {
    logger.info({ category: 'renderer', event: 'renderer.loaded', data: { phase: 'dom' } });
    revealMainWindow('renderer-dom-ready');
  });

  mainWindow.webContents.on('render-process-gone', (_event, details) => {
    logger.error({ category: 'renderer', event: 'renderer.process-gone', data: { phase: 'gone' } });
  });

  mainWindow.webContents.on('console-message', (_event, level, message, line, sourceId) => {
    const payload = { level, line, sourceId: sourceId || '' };
    if (level >= 2) logger.warn({ category: 'renderer', event: 'renderer.console-warning', data: payload });
    else logger.info({ category: 'renderer', event: 'renderer.console', data: payload });
  });

  mainWindow.once('ready-to-show', () => {
    logger.info({ category: 'runtime', event: 'runtime.window-ready', data: { phase: 'ready-to-show' } });
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
      logger.error({ category: 'runtime', event: 'runtime.display-capture-failed', error });
    }
  }, { useSystemPicker: true });
}

module.exports = {
  APP_NAME,
  RENDERER_WEB_PREFERENCES,
  getMainWindow,
  getIsQuitting,
  setLogger,
  setIsQuitting,
  createVaniScriptIcon,
  revealMainWindow,
  showMainWindow,
  openSettingsFromShell,
  installAppMenu,
  installTray,
  createWindow,
  configureDisplayMediaCapture,
};
