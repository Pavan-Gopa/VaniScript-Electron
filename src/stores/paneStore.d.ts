import * as React from 'react';

export type ViewMode = 'source' | 'translated' | 'dual';

export interface PaneState {
  showChatSidebar: boolean;
  projectSidebarOpen: boolean;
  projectSidebarClosing: boolean;
  viewMode: ViewMode;
}

export interface PaneStore {
  getState(): PaneState;
  setChatSidebar(open: boolean): boolean;
  toggleChatSidebar(): boolean;
  setViewMode(mode: ViewMode): boolean;
  setProjectSidebarOpen(open: boolean): boolean;
  setProjectSidebarClosing(closing: boolean): boolean;
  openProjectSidebar(): boolean;
  closeProjectSidebar(delay?: number): boolean;
  subscribe(listener: () => void): () => void;
}

export const VIEW_MODES: {
  SOURCE: 'source';
  TRANSLATED: 'translated';
  DUAL: 'dual';
};

export const VALID_VIEW_MODES: ReadonlyArray<ViewMode>;

export function createPaneStore(initial?: Partial<PaneState>): PaneStore;

export const paneStore: PaneStore;

export function usePaneStore(store?: PaneStore): PaneState;
