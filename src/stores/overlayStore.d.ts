import * as React from 'react';

export type OverlayProps = Readonly<Record<string, unknown>>;

export interface OverlayEntry {
  id: string;
  props: OverlayProps;
}

export interface OverlayState {
  active: ReadonlyArray<OverlayEntry>;
  openCount: number;
}

export interface OverlayStore {
  isOpen(id: string): boolean;
  getProps(id: string): OverlayProps | undefined;
  getActive(): string[];
  getState(): OverlayState;
  open(id: string, props?: OverlayProps): boolean;
  close(id: string): boolean;
  closeAll(): boolean;
  toggle(id: string, props?: OverlayProps): boolean;
  subscribe(listener: () => void): () => void;
}

export function createOverlayStore(): OverlayStore;

export const overlayStore: OverlayStore;

export function useOverlayStore(store?: OverlayStore): OverlayState;

export function useOverlay(id: string, store?: OverlayStore): boolean;
