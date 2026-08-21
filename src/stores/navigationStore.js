import React from 'react';
import { overlayStore } from './overlayStore.js';

// Framework-agnostic navigation store for top-level app routing.
// Kept dependency-light (no zustand) and published as an ES module so it can be
// unit-tested directly with `node --test` and bundled by Vite/esbuild for the
// React renderer.

const NAVIGATION_ROUTES = Object.freeze({
  HOME: 'home',
  PROJECT: 'project',
  BATCH: 'batch',
  SETTINGS: 'settings',
});

const VALID_ROUTES = Object.freeze([
  NAVIGATION_ROUTES.HOME,
  NAVIGATION_ROUTES.PROJECT,
  NAVIGATION_ROUTES.BATCH,
  NAVIGATION_ROUTES.SETTINGS,
]);

function isValidRoute(route) {
  return VALID_ROUTES.indexOf(route) !== -1;
}

// Minimal synchronous observer shared by the store instances. Defined locally
// to avoid a cross-module dependency cycle with overlayStore.
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

function createNavigationStore(initialRoute) {
  if (initialRoute === undefined) initialRoute = NAVIGATION_ROUTES.HOME;
  if (!isValidRoute(initialRoute)) {
    throw new Error('Invalid initial navigation route: ' + String(initialRoute));
  }

  let currentRoute = initialRoute;
  let previousRoute = null;
  const history = [];
  const observer = createObserver();
  let cached = null;

  function buildSnapshot() {
    return Object.freeze({
      route: currentRoute,
      previousRoute: previousRoute,
      history: Object.freeze(history.slice()),
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

  function navigate(route, options) {
    if (!isValidRoute(route)) {
      throw new Error('Invalid navigation route: ' + String(route));
    }
    if (route === currentRoute) {
      return false;
    }
    const replace = Boolean(options && options.replace);
    previousRoute = currentRoute;
    if (!replace) {
      history.push(currentRoute);
    }
    currentRoute = route;
    refresh();
    return true;
  }

  function replace(route) {
    return navigate(route, { replace: true });
  }

  function back() {
    if (history.length === 0) {
      return false;
    }
    const target = history.pop();
    previousRoute = currentRoute;
    currentRoute = target;
    refresh();
    return true;
  }

  function canNavigate(route) {
    return isValidRoute(route) && route !== currentRoute;
  }

  function reset(route) {
    if (route === undefined) route = NAVIGATION_ROUTES.HOME;
    if (!isValidRoute(route)) {
      throw new Error('Invalid navigation route: ' + String(route));
    }
    previousRoute = currentRoute;
    currentRoute = route;
    history.length = 0;
    refresh();
    return true;
  }

  function subscribe(listener) {
    return observer.subscribe(listener);
  }

  return {
    getState: getState,
    navigate: navigate,
    replace: replace,
    back: back,
    canNavigate: canNavigate,
    reset: reset,
    subscribe: subscribe,
    get route() {
      return currentRoute;
    },
  };
}

const navigationStore = createNavigationStore();

function useNavigationStore(store) {
  if (store === undefined) store = navigationStore;
  const subscribe = React.useCallback(function (cb) {
    return store.subscribe(cb);
  }, [store]);
  const getSnapshot = React.useCallback(function () {
    return store.getState();
  }, [store]);
  return React.useSyncExternalStore(subscribe, getSnapshot, getSnapshot);
}

function useNavigate(store) {
  if (store === undefined) store = navigationStore;
  return React.useCallback(function (route, options) {
    return store.navigate(route, options);
  }, [store]);
}

const StoresContext = React.createContext(null);

function NavigationProvider(props) {
  const value = React.useMemo(function () {
    return {
      navigationStore: navigationStore,
      overlayStore: overlayStore,
      navigation: navigationStore,
      overlay: overlayStore,
    };
  }, []);
  return React.createElement(StoresContext.Provider, { value: value }, props.children);
}

function useStores() {
  const ctx = React.useContext(StoresContext);
  if (ctx === null) {
    throw new Error('useStores must be used within a <NavigationProvider>');
  }
  return ctx;
}

export {
  NAVIGATION_ROUTES,
  VALID_ROUTES,
  createNavigationStore,
  navigationStore,
  useNavigationStore,
  useNavigate,
  NavigationProvider,
  useStores,
};
