import React from 'react';

// Framework-agnostic overlay store for modals and popups. Published as an ES
// module so it can be unit-tested directly with `node --test` and bundled by
// Vite/esbuild for the React renderer.

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

function createOverlayStore() {
  const overlays = new Map();
  let zCounter = 10;
  const observer = createObserver();
  let cached = null;

  function buildSnapshot() {
    const entries = [];
    overlays.forEach(function (entry) {
      entries.push({ id: entry.id, props: entry.props });
    });
    entries.sort(function (a, b) {
      return overlays.get(a.id).zIndex - overlays.get(b.id).zIndex;
    });
    return Object.freeze({
      active: Object.freeze(entries),
      openCount: overlays.size,
    });
  }

  function refresh() {
    cached = buildSnapshot();
    observer.emit();
  }

  refresh();

  function isOpen(id) {
    return overlays.has(id);
  }

  function getProps(id) {
    const entry = overlays.get(id);
    return entry ? entry.props : undefined;
  }

  function getActive() {
    return cached.active.map(function (o) {
      return o.id;
    });
  }

  function getState() {
    return cached;
  }

  function open(id, props) {
    if (typeof id !== 'string' || id.length === 0) {
      throw new TypeError('overlay id must be a non-empty string');
    }
    if (props === undefined) props = {};
    if (typeof props !== 'object' || props === null || Array.isArray(props)) {
      throw new TypeError('overlay props must be a plain object');
    }
    const isNew = !overlays.has(id);
    const zIndex = isNew ? (zCounter += 1) : overlays.get(id).zIndex;
    overlays.set(id, {
      id: id,
      props: Object.freeze(Object.assign({}, props)),
      zIndex: zIndex,
    });
    if (isNew) {
      refresh();
    } else {
      cached = buildSnapshot();
      observer.emit();
    }
    return true;
  }

  function close(id) {
    if (!overlays.has(id)) {
      return false;
    }
    overlays.delete(id);
    refresh();
    return true;
  }

  function closeAll() {
    if (overlays.size === 0) {
      return false;
    }
    overlays.clear();
    refresh();
    return true;
  }

  function toggle(id, props) {
    if (overlays.has(id)) {
      close(id);
      return false;
    }
    open(id, props);
    return true;
  }

  function subscribe(listener) {
    return observer.subscribe(listener);
  }

  return {
    isOpen: isOpen,
    getProps: getProps,
    getActive: getActive,
    getState: getState,
    open: open,
    close: close,
    closeAll: closeAll,
    toggle: toggle,
    subscribe: subscribe,
  };
}

const overlayStore = createOverlayStore();

function useOverlayStore(store) {
  if (store === undefined) store = overlayStore;
  const subscribe = React.useCallback(function (cb) {
    return store.subscribe(cb);
  }, [store]);
  const getSnapshot = React.useCallback(function () {
    return store.getState();
  }, [store]);
  return React.useSyncExternalStore(subscribe, getSnapshot, getSnapshot);
}

function useOverlay(id, store) {
  if (store === undefined) store = overlayStore;
  const subscribe = React.useCallback(function (cb) {
    return store.subscribe(cb);
  }, [store, id]);
  const getSnapshot = React.useCallback(function () {
    return store.isOpen(id);
  }, [store, id]);
  return React.useSyncExternalStore(subscribe, getSnapshot, getSnapshot);
}

export {
  createOverlayStore,
  overlayStore,
  useOverlayStore,
  useOverlay,
};
