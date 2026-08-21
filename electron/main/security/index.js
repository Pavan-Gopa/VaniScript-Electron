'use strict';

// Browser hardening for VaniScript's Electron renderer.
//
// This module deliberately does NOT `require('electron')` at the top level.
// The Electron `app`/`session` objects are injected by the caller
// (`bootstrap/app-lifecycle.js`, which runs inside the Electron runtime) so the
// security logic can be unit-tested under plain `node --test` with stub
// objects — no display or packaged build required.
//
// Responsibilities:
//   1. Block every new window/popup spawned from renderer JS (setWindowOpenHandler).
//   2. Block any unauthorized top-level navigation (will-navigate).
//   3. Inject a strict Content-Security-Policy on every renderer response
//      (session.defaultSession.webRequest.onHeadersReceived).

// Strict CSP. The app is a local SPA: packaged builds load from `file://`, the
// dev workflow loads from a loopback dev server. The only network egress the
// renderer legitimately needs is the bundled MCP server on 127.0.0.1:19789
// (SSE/HTTP/WS). Local media (blob:/data:) is required for playback/preview.
const SECURITY_CSP = [
  "default-src 'self'",
  "script-src 'self'",
  "style-src 'self' 'unsafe-inline'",
  "img-src 'self' data: blob:",
  "font-src 'self' data:",
  "media-src 'self' data: blob: mediastream:",
  "connect-src 'self' http://127.0.0.1:* https://127.0.0.1:* ws://127.0.0.1:* wss://127.0.0.1:* http://localhost:* https://localhost:* ws://localhost:* wss://localhost:*",
  "child-src 'none'",
  "frame-src 'none'",
  "object-src 'none'",
  "base-uri 'self'",
  "form-action 'self'",
].join('; ');

// Schemes that are inherently local/safe and always permitted for navigation.
const ALLOWED_NAVIGATION_SCHEMES = new Set(['file:', 'app:', 'devtools:']);
const LOOPBACK_HOSTS = new Set(['127.0.0.1', 'localhost', '[::1]', '::1']);

function isLoopbackHost(hostname) {
  if (!hostname) return false;
  return LOOPBACK_HOSTS.has(hostname.toLowerCase());
}

// Pure predicate: should a top-level navigation to `url` be permitted?
// `will-navigate` fires only for in-page navigations (link clicks,
// window.location changes) — never for the initial loadURL/loadFile — so
// denying external http(s) here cannot interfere with the app's own load.
function isNavigationAllowed(url) {
  let parsed;
  try {
    parsed = new URL(url);
  } catch {
    return false;
  }
  if (ALLOWED_NAVIGATION_SCHEMES.has(parsed.protocol)) return true;
  if (
    (parsed.protocol === 'http:' || parsed.protocol === 'https:') &&
    isLoopbackHost(parsed.hostname)
  ) {
    return true;
  }
  return false;
}

// Renderer JS is never allowed to open new windows/popups.
function createWindowOpenHandler() {
  return () => ({ action: 'deny' });
}

// Block unauthorized top-level navigations before they commit.
function createWillNavigateHandler() {
  return (event, url) => {
    if (!isNavigationAllowed(url)) {
      event.preventDefault();
    }
  };
}

// Apply the window-level restrictions to a single WebContents instance.
// Safe to call with partial/duck-typed objects (used in tests).
function attachWebContentsSecurity(contents) {
  if (contents && typeof contents.setWindowOpenHandler === 'function') {
    contents.setWindowOpenHandler(createWindowOpenHandler());
  }
  if (contents && typeof contents.on === 'function') {
    contents.on('will-navigate', createWillNavigateHandler());
  }
  return contents;
}

// Builds the onHeadersReceived callback that injects the strict CSP and
// strips any weaker policy already present on the response.
function createCspInterceptor(csp) {
  return (details, callback) => {
    const responseHeaders = { ...(details.responseHeaders || {}) };
    delete responseHeaders['content-security-policy'];
    delete responseHeaders['Content-Security-Policy'];
    responseHeaders['Content-Security-Policy'] = [csp];
    callback({ cancel: false, responseHeaders });
  };
}

// Track which sessions already had the CSP hook installed so repeated calls
// (e.g. across hot reloads of the test suite) are idempotent.
const enforcedSessions = new WeakSet();

// Install the strict CSP on the given Electron session (idempotent per session).
function enforceContentSecurityPolicy(session, csp = SECURITY_CSP) {
  if (!session || !session.defaultSession || !session.defaultSession.webRequest) {
    throw new Error('enforceContentSecurityPolicy requires a session with defaultSession.webRequest');
  }
  if (enforcedSessions.has(session)) return;
  session.defaultSession.webRequest.onHeadersReceived(createCspInterceptor(csp));
  enforcedSessions.add(session);
}

// Wire every security control into the app lifecycle.
//   - `app.on('web-contents-created')` applies per-WebContents restrictions.
//   - the session gets the strict CSP header on all renderer responses.
function registerSecurityHandlers({ app, session }) {
  if (!app || typeof app.on !== 'function') {
    throw new Error('registerSecurityHandlers requires an Electron app instance');
  }
  app.on('web-contents-created', (_event, contents) => {
    attachWebContentsSecurity(contents);
  });
  enforceContentSecurityPolicy(session);
}

module.exports = {
  SECURITY_CSP,
  ALLOWED_NAVIGATION_SCHEMES,
  isNavigationAllowed,
  createWindowOpenHandler,
  createWillNavigateHandler,
  attachWebContentsSecurity,
  createCspInterceptor,
  enforceContentSecurityPolicy,
  registerSecurityHandlers,
};
