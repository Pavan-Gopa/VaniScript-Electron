import * as React from 'react';
import type { OverlayStore } from './overlayStore';

export type NavigationRoute = 'home' | 'project' | 'batch' | 'settings';

export interface NavigationState {
  route: NavigationRoute;
  previousRoute: NavigationRoute | null;
  history: ReadonlyArray<NavigationRoute>;
}

export interface NavigationStore {
  getState(): NavigationState;
  navigate(route: NavigationRoute, options?: { replace?: boolean }): boolean;
  replace(route: NavigationRoute): boolean;
  back(): boolean;
  canNavigate(route: NavigationRoute): boolean;
  reset(route?: NavigationRoute): boolean;
  subscribe(listener: () => void): () => void;
  readonly route: NavigationRoute;
}

export const NAVIGATION_ROUTES: {
  HOME: 'home';
  PROJECT: 'project';
  BATCH: 'batch';
  SETTINGS: 'settings';
};

export const VALID_ROUTES: ReadonlyArray<NavigationRoute>;

export function createNavigationStore(initialRoute?: NavigationRoute): NavigationStore;

export const navigationStore: NavigationStore;

export function useNavigationStore(store?: NavigationStore): NavigationState;

export function useNavigate(store?: NavigationStore): (
  route: NavigationRoute,
  options?: { replace?: boolean }
) => boolean;

export interface StoresContextValue {
  navigationStore: NavigationStore;
  overlayStore: OverlayStore;
  navigation: NavigationStore;
  overlay: OverlayStore;
}

export function NavigationProvider(props: { children?: React.ReactNode }): React.ReactElement;

export function useStores(): StoresContextValue;
