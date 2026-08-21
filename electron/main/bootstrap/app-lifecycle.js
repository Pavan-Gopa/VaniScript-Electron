'use strict';

const { app, session } = require('electron');
const { APP_NAME } = require('../windows/window-manager');
const { registerSecurityHandlers } = require('../security');

/**
 * Wires Electron app-level lifecycle events to the supplied dependencies.
 *
 * All runtime callbacks (window creation, menu/tray install, MCP server,
 * model broadcast, temp-dir cleanup) are injected by the caller so this
 * module stays free of cross-module import cycles. The window manager is
 * passed as a single module object (`windowManager`) to keep the public
 * surface small.
 */
function registerAppLifecycle({
  getTempDir,
  cleanupTempDir,
  startMcpServer,
  stopMcpServer,
  broadcastSharedLocalModels,
  windowManager,
}) {
  app.setName(APP_NAME);
  // Enforce browser hardening (strict CSP, blocked popups, blocked
  // unauthorized navigations) as early as possible in the lifecycle.
  registerSecurityHandlers({ app, session });
  if (process.platform === 'darwin') {
    app.setAboutPanelOptions({
      applicationName: APP_NAME,
      applicationVersion: app.getVersion(),
      copyright: '© 2026 VaniScript Audio Processor',
    });
  }

  const gotLock = app.requestSingleInstanceLock();
  if (!gotLock) {
    app.quit();
    process.exit(0);
  }

  app.whenReady().then(() => {
    getTempDir();
    windowManager.configureDisplayMediaCapture();
    windowManager.installAppMenu();
    windowManager.installTray();
    windowManager.createWindow(broadcastSharedLocalModels);
    startMcpServer();
    app.on('activate', () => windowManager.showMainWindow());
  });

  app.on('window-all-closed', () => {
    if (process.platform !== 'darwin') app.quit();
  });

  app.on('before-quit', () => {
    windowManager.setIsQuitting(true);
    cleanupTempDir();
    stopMcpServer();
  });

  app.on('second-instance', () => {
    windowManager.showMainWindow();
  });
}

module.exports = { registerAppLifecycle };
