'use strict';

// Runtime hardening for VaniScript's Electron renderer.
//
// These tests run under plain `node --test` (no display, no packaged build, no
// `require('electron')` at the top level). The renderer-window contract is
// checked by stubbing the `electron` module through `Module._load`, and the
// security module's logic is exercised with duck-typed fakes.

const { test } = require('node:test');
const assert = require('node:assert');

const MODULE = require('module');
const origLoad = MODULE._load;

function withElectronStub(stub, fn) {
  MODULE._load = function (request, parent, isMain) {
    if (request === 'electron') return stub;
    return origLoad.apply(this, arguments);
  };
  try {
    return fn();
  } finally {
    MODULE._load = origLoad;
  }
}

// --- Renderer window security contract -------------------------------------

test('RENDERER_WEB_PREFERENCES enables sandbox + contextIsolation, disables nodeIntegration', () => {
  let captured = null;
  const FakeBrowserWindow = class {
    constructor(opts) {
      captured = opts;
      this.webContents = {
        on() {},
        once() {},
        send() {},
        isLoadingMainFrame() { return false; },
        openDevTools() {},
      };
    }
    loadURL() {}
    loadFile() {}
    on() {}
    once() {}
    show() {}
    hide() {}
    focus() {}
    moveTop() {}
    restore() {}
    isMinimized() { return false; }
    isDestroyed() { return false; }
    isVisible() { return true; }
    isFocused() { return true; }
    setMenu() {}
  };

  const electronStub = {
    app: { on() {}, whenReady: () => ({ then() {} }) },
    BrowserWindow: FakeBrowserWindow,
    Menu: { setApplicationMenu() {} },
    Tray: class {},
    nativeImage: { createFromPath: () => ({ setTemplateImage() {} }) },
    session: { defaultSession: { setDisplayMediaRequestHandler() {}, webRequest: { onHeadersReceived() {} } } },
    desktopCapturer: { getSources: async () => [] },
  };

  const wm = withElectronStub(electronStub, () =>
    require('../electron/main/windows/window-manager')
  );

  assert.strictEqual(wm.RENDERER_WEB_PREFERENCES.sandbox, true);
  assert.strictEqual(wm.RENDERER_WEB_PREFERENCES.contextIsolation, true);
  assert.strictEqual(wm.RENDERER_WEB_PREFERENCES.nodeIntegration, false);

  // createWindow must apply the hardened preferences to the spawned window.
  const realSetTimeout = global.setTimeout;
  global.setTimeout = () => 0; // skip the revealMainWindow fallback timer
  try {
    wm.createWindow(() => {});
  } finally {
    global.setTimeout = realSetTimeout;
  }
  assert.ok(captured, 'createWindow should construct a BrowserWindow');
  assert.strictEqual(captured.webPreferences.sandbox, true);
  assert.strictEqual(captured.webPreferences.contextIsolation, true);
  assert.strictEqual(captured.webPreferences.nodeIntegration, false);
});

// --- Security module logic --------------------------------------------------

const security = require('../electron/main/security');

test('SECURITY_CSP is strict and permits only local/MCP egress', () => {
  const csp = security.SECURITY_CSP;
  assert.match(csp, /default-src 'self'/);
  assert.match(csp, /script-src 'self'/);
  assert.match(csp, /child-src 'none'/);
  assert.match(csp, /frame-src 'none'/);
  assert.match(csp, /object-src 'none'/);
  assert.match(csp, /base-uri 'self'/);
  // MCP server on loopback is explicitly allowed; arbitrary hosts are not.
  assert.match(csp, /127\.0\.0\.1/);
  assert.match(csp, /localhost/);
  assert.ok(!/https?:\/\/\*/.test(csp), 'CSP must not allow arbitrary hosts in connect-src');
});

test('isNavigationAllowed permits only local/loopback targets', () => {
  assert.strictEqual(security.isNavigationAllowed('file:///Users/x/index.html'), true);
  assert.strictEqual(security.isNavigationAllowed('app://./index'), true);
  assert.strictEqual(security.isNavigationAllowed('devtools://devtools/bundled'), true);
  assert.strictEqual(security.isNavigationAllowed('http://127.0.0.1:19789/sse'), true);
  assert.strictEqual(security.isNavigationAllowed('https://127.0.0.1/x'), true);
  assert.strictEqual(security.isNavigationAllowed('http://localhost:3000'), true);
  assert.strictEqual(security.isNavigationAllowed('https://localhost/y'), true);

  assert.strictEqual(security.isNavigationAllowed('https://example.com'), false);
  assert.strictEqual(security.isNavigationAllowed('http://192.168.0.5'), false);
  assert.strictEqual(security.isNavigationAllowed('javascript:alert(1)'), false);
  assert.strictEqual(security.isNavigationAllowed('not a url'), false);
});

test('createWindowOpenHandler always denies new windows', () => {
  const handler = security.createWindowOpenHandler();
  assert.deepStrictEqual(handler(), { action: 'deny' });
});

test('createWillNavigateHandler blocks external nav, allows local', () => {
  const handler = security.createWillNavigateHandler();

  let prevented = false;
  const blockEvent = { preventDefault() { prevented = true; } };
  handler(blockEvent, 'https://evil.example.com');
  assert.strictEqual(prevented, true);

  let allowed = false;
  const allowEvent = { preventDefault() { allowed = true; } };
  handler(allowEvent, 'http://127.0.0.1:19789/sse');
  assert.strictEqual(allowed, false);
});

test('attachWebContentsSecurity wires deny-popups and nav guard', () => {
  let openHandler = null;
  let navHandler = null;
  const contents = {
    setWindowOpenHandler(h) { openHandler = h; },
    on(evt, h) { if (evt === 'will-navigate') navHandler = h; },
  };

  security.attachWebContentsSecurity(contents);
  assert.ok(openHandler, 'setWindowOpenHandler was registered');
  assert.deepStrictEqual(openHandler(), { action: 'deny' });
  assert.ok(navHandler, 'will-navigate listener was registered');

  let prevented = false;
  navHandler({ preventDefault() { prevented = true; } }, 'https://evil.example.com');
  assert.strictEqual(prevented, true);
  prevented = false;
  navHandler({ preventDefault() { prevented = true; } }, 'file:///ok');
  assert.strictEqual(prevented, false);
});

test('enforceContentSecurityPolicy injects strict CSP and is idempotent', () => {
  let assignCount = 0;
  let stored = null;
  const fakeSession = {
    defaultSession: {
      webRequest: {
        onHeadersReceived(fn) { assignCount += 1; stored = fn; },
      },
    },
  };

  assert.doesNotThrow(() => security.enforceContentSecurityPolicy(fakeSession));
  // Second call must not re-register the hook.
  security.enforceContentSecurityPolicy(fakeSession);
  assert.strictEqual(assignCount, 1);

  let captured = null;
  stored(
    { responseHeaders: { 'content-security-policy': ['old weak policy'] } },
    (out) => { captured = out; }
  );
  assert.strictEqual(captured.cancel, false);
  assert.deepStrictEqual(captured.responseHeaders['Content-Security-Policy'], [security.SECURITY_CSP]);
  assert.ok(!('content-security-policy' in captured.responseHeaders), 'old CSP header must be stripped');
});

test('registerSecurityHandlers wires web-contents-created + CSP', () => {
  let webContentsHandler = null;
  const fakeApp = {
    on(evt, h) { if (evt === 'web-contents-created') webContentsHandler = h; },
  };
  let assignCount = 0;
  let stored = null;
  const fakeSession = {
    defaultSession: {
      webRequest: {
        onHeadersReceived(fn) { assignCount += 1; stored = fn; },
      },
    },
  };

  security.registerSecurityHandlers({ app: fakeApp, session: fakeSession });
  assert.ok(webContentsHandler, 'web-contents-created listener registered');
  assert.strictEqual(assignCount, 1, 'CSP enforced on the session');

  // The registered listener must apply per-WebContents hardening.
  let openHandler = null;
  webContentsHandler({}, {
    setWindowOpenHandler(h) { openHandler = h; },
    on() {},
  });
  assert.deepStrictEqual(openHandler(), { action: 'deny' });
});

test('registerSecurityHandlers throws on invalid deps', () => {
  assert.throws(() => security.registerSecurityHandlers({}),
    /app instance/);
  assert.throws(() => security.registerSecurityHandlers({ app: { on() {} } }),
    /session/);
});
