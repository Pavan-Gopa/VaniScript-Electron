import React from 'react';

// Framework-agnostic store for side panes and layout state (chat sidebar,
// project sidebar, and the review view mode). Kept dependency-light (no
// zustand) and published as an ES module so it can be unit-tested directly
// with `node --test` and bundled by Vite/esbuild for the React renderer.

const VIEW_MODES = Object.freeze({
  SOURCE: 'source',
  TRANSLATED: 'translated',
  DUAL: 'dual',
});

const VALID_VIEW_MODES = Object.freeze([
  VIEW_MODES.SOURCE,
  VIEW_MODES.TRANSLATED,
  VIEW_MODES.DUAL,
]);

function isValidViewMode(mode) {
  return VALID_VIEW_MODES.indexOf(mode) !== -1;
}

// Minimal synchronous observer shared by the store instances. Defined locally
// to avoid a cross-module dependency cycle with the other stores.
function createObserver() {
  const listeners = new Set();
  return {
    subscribe(listener) {
      if (typeof listener !== 'function') {
        throw new TypeError('subscribe expects a function listener');
      }
      listeners.add(listener);
      return function unsubscribe() {
        listeners.delete(listener);
      };
    },
    emit() {
      // Copy first so unsubscribes during emit do not disturb iteration.
      const snapshot = Array.from(listeners);
      for (let i = 0; i < snapshot.length; i += 1) {
        snapshot[i]();
      }
    },
    get size() {
      return listeners.size;
    },
  };
}

const DEFAULT_CLOSE_DELAY_MS = 190;

function createPaneStore(initial) {
  if (initial === undefined) initial = {};

  let showChatSidebar = Boolean(initial.showChatSidebar);
  let projectSidebarOpen = Boolean(initial.projectSidebarOpen);
  let projectSidebarClosing = Boolean(initial.projectSidebarClosing);
  let viewMode = initial.viewMode !== undefined ? initial.viewMode : VIEW_MODES.DUAL;
  if (!isValidViewMode(viewMode)) {
    throw new Error('Invalid initial view mode: ' + String(viewMode));
  }

  // Timer handle for the project sidebar close animation. The store owns the
  // timer so the renderer component no longer needs pane-local refs.
  let closeTimer = null;
  const observer = createObserver();
  let cached = null;

  function buildSnapshot() {
    return Object.freeze({
      showChatSidebar: showChatSidebar,
      projectSidebarOpen: projectSidebarOpen,
      projectSidebarClosing: projectSidebarClosing,
      viewMode: viewMode,
    });
  }

  function refresh() {
    cached = buildSnapshot();
    observer.emit();
  }

  refresh();

  function getState() {
    return cached;
  }

  function setChatSidebar(open) {
    const next = Boolean(open);
    if (next === showChatSidebar) {
      return false;
    }
    showChatSidebar = next;
    refresh();
    return true;
  }

  function toggleChatSidebar() {
    return setChatSidebar(!showChatSidebar);
  }

  function setViewMode(mode) {
    if (!isValidViewMode(mode)) {
      throw new Error('Invalid view mode: ' + String(mode));
    }
    if (mode === viewMode) {
      return false;
    }
    viewMode = mode;
    refresh();
    return true;
  }

  function setProjectSidebarOpen(open) {
    const next = Boolean(open);
    if (next === projectSidebarOpen) {
      return false;
    }
    projectSidebarOpen = next;
    refresh();
    return true;
  }

  function setProjectSidebarClosing(closing) {
    const next = Boolean(closing);
    if (next === projectSidebarClosing) {
      return false;
    }
    projectSidebarClosing = next;
    refresh();
    return true;
  }

  function openProjectSidebar() {
    clearTimeout(closeTimer);
    closeTimer = null;
    const closingChanged = setProjectSidebarClosing(false);
    const openChanged = setProjectSidebarOpen(true);
    return closingChanged || openChanged;
  }

  function closeProjectSidebar(delay) {
    if (delay === undefined) delay = DEFAULT_CLOSE_DELAY_MS;
    if (typeof delay !== 'number' || delay < 0) {
      throw new TypeError('close delay must be a non-negative number');
    }
    setProjectSidebarClosing(true);
    clearTimeout(closeTimer);
    closeTimer = setTimeout(function () {
      closeTimer = null;
      setProjectSidebarOpen(false);
      setProjectSidebarClosing(false);
    }, delay);
    return true;
  }

  function subscribe(listener) {
    return observer.subscribe(listener);
  }

  return {
    getState: getState,
    setChatSidebar: setChatSidebar,
    toggleChatSidebar: toggleChatSidebar,
    setViewMode: setViewMode,
    setProjectSidebarOpen: setProjectSidebarOpen,
    setProjectSidebarClosing: setProjectSidebarClosing,
    openProjectSidebar: openProjectSidebar,
    closeProjectSidebar: closeProjectSidebar,
    subscribe: subscribe,
  };
}

const paneStore = createPaneStore();

function usePaneStore(store) {
  if (store === undefined) store = paneStore;
  const subscribe = React.useCallback(function (cb) {
    return store.subscribe(cb);
  }, [store]);
  const getSnapshot = React.useCallback(function () {
    return store.getState();
  }, [store]);
  return React.useSyncExternalStore(subscribe, getSnapshot, getSnapshot);
}

export {
  VIEW_MODES,
  VALID_VIEW_MODES,
  createPaneStore,
  paneStore,
  usePaneStore,
};
