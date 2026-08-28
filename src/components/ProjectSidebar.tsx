import React, { memo, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Archive, ChevronDown, ChevronRight, Download, FileAudio, Film, FolderOpen, Info, Play, Share2, Trash2, Upload } from 'lucide-react';
import type { ProjectSummary, SourceMediaInfo } from '../types';
import { canOpenSidebarChunk, clampChunkIndex, isProjectExportReady } from '../lib/project-navigation';
import { getChunkRowWindow, getVariableVirtualWindow, includeIndexInVirtualWindow } from '../lib/virtual-window';

const OUTER_COLLAPSED_HEIGHT = 96;
const OUTER_EXPANDED_HEIGHT = 430;
const OUTER_GAP = 10;
const CHUNK_VIEWPORT_HEIGHT = 224;
const CHUNK_ROW_HEIGHT = 36;
const CHUNK_OVERSCAN = 4;

export interface ProjectSidebarProps {
  projects: readonly ProjectSummary[];
  expandedProjectId: string | null;
  activeProjectId?: string;
  loading?: boolean;
  hasMore?: boolean;
  total?: number;
  onClose: () => void;
  onImport: () => void;
  onExportAll: () => void;
  onToggleProject: (projectId: string) => void;
  onDeleteProject: (projectId: string) => void;
  onExportProject: (projectId: string) => void;
  onOpenProjectChunk: (project: ProjectSummary, chunkIndex: number) => void;
  onOpenProjectExport: (project: ProjectSummary) => void;
  onClearArchive: () => void;
  onOpenMediaInfo: (mediaInfo: SourceMediaInfo) => void;
  onOpenPath?: (filePath: string) => void;
  onRevealPath?: (filePath: string) => void;
  onLoadMore?: () => void;
}

function formatFileSize(bytes?: number): string {
  if (bytes === undefined || bytes === null) return '';
  if (bytes < 1024) return `${bytes} B`;
  const sizes = ['B', 'KB', 'MB', 'GB', 'TB'];
  const index = Math.min(sizes.length - 1, Math.floor(Math.log(bytes) / Math.log(1024)));
  return `${parseFloat((bytes / Math.pow(1024, index)).toFixed(1))} ${sizes[index]}`;
}

function mediaSummary(mediaInfo: SourceMediaInfo): string {
  const parts: string[] = [mediaInfo.kind === 'video' ? 'Video' : 'Audio'];
  if (mediaInfo.width && mediaInfo.height) parts.push(`${mediaInfo.width}x${mediaInfo.height}`);
  if (mediaInfo.frameRate) parts.push(`${Math.round(mediaInfo.frameRate)} fps`);
  if (mediaInfo.container) parts.push(mediaInfo.container.toUpperCase());
  if (mediaInfo.fileSizeBytes) parts.push(formatFileSize(mediaInfo.fileSizeBytes));
  return parts.join(' · ');
}

function nextFrame(callback: () => void): void {
  if (typeof window !== 'undefined' && typeof window.requestAnimationFrame === 'function') {
    window.requestAnimationFrame(callback);
    return;
  }
  setTimeout(callback, 0);
}

function ProjectSidebarView({
  projects,
  expandedProjectId,
  activeProjectId,
  loading = false,
  hasMore = false,
  total,
  onClose,
  onImport,
  onExportAll,
  onToggleProject,
  onDeleteProject,
  onExportProject,
  onOpenProjectChunk,
  onOpenProjectExport,
  onClearArchive,
  onOpenMediaInfo,
  onOpenPath,
  onRevealPath,
  onLoadMore,
}: ProjectSidebarProps): React.ReactElement {
  const outerViewportRef = useRef<HTMLDivElement | null>(null);
  const chunkViewportRefs = useRef(new Map<string, HTMLDivElement>());
  const chunkButtonRefs = useRef(new Map<string, HTMLButtonElement>());
  const [outerScrollTop, setOuterScrollTop] = useState(0);
  const [outerViewportHeight, setOuterViewportHeight] = useState(600);
  const [chunkScrollTops, setChunkScrollTops] = useState<Record<string, number>>({});
  const [focusedChunks, setFocusedChunks] = useState<Record<string, number>>({});

  useEffect(() => {
    const node = outerViewportRef.current;
    if (!node || typeof ResizeObserver === 'undefined') return;
    const observer = new ResizeObserver(() => setOuterViewportHeight(Math.max(1, node.clientHeight || 600)));
    observer.observe(node);
    return () => observer.disconnect();
  }, []);

  const expandedIndex = projects.findIndex((project) => project.id === expandedProjectId);
  const itemCount = projects.length + (hasMore ? 1 : 0);
  const outerWindow = useMemo(() => getVariableVirtualWindow(
    itemCount,
    expandedIndex,
    outerScrollTop,
    outerViewportHeight,
    OUTER_COLLAPSED_HEIGHT,
    OUTER_EXPANDED_HEIGHT,
    OUTER_GAP,
    2,
  ), [expandedIndex, itemCount, outerScrollTop, outerViewportHeight]);
  const activeIndex = projects.findIndex((project) => project.id === activeProjectId);
  const materializedOuterWindow = includeIndexInVirtualWindow(outerWindow, activeIndex);
  const visibleStart = materializedOuterWindow.start;
  const visibleEnd = materializedOuterWindow.end;
  const focusChunk = useCallback((project: ProjectSummary, chunkIndex: number) => {
    const bounded = Math.min(
      clampChunkIndex(project.currentIndex, project.totalChunks),
      Math.max(0, Math.floor(chunkIndex)),
    );
    setFocusedChunks((previous) => ({ ...previous, [project.id]: bounded }));
    const row = Math.floor(bounded / 2);
    const viewport = chunkViewportRefs.current.get(project.id);
    if (viewport) {
      const top = row * CHUNK_ROW_HEIGHT;
      if (top < viewport.scrollTop) viewport.scrollTop = top;
      else if (top + CHUNK_ROW_HEIGHT > viewport.scrollTop + viewport.clientHeight) viewport.scrollTop = Math.max(0, top - viewport.clientHeight + CHUNK_ROW_HEIGHT);
      setChunkScrollTops((previous) => ({ ...previous, [project.id]: viewport.scrollTop }));
    }
    nextFrame(() => chunkButtonRefs.current.get(`${project.id}:${bounded}`)?.focus());
  }, []);

  const handleChunkKeyDown = useCallback((event: React.KeyboardEvent<HTMLButtonElement>, project: ProjectSummary, chunkIndex: number) => {
    const lastOpenableChunk = clampChunkIndex(project.currentIndex, project.totalChunks);
    let next = chunkIndex;
    if (event.key === 'ArrowRight') next = Math.min(lastOpenableChunk, chunkIndex + 1);
    else if (event.key === 'ArrowLeft') next = Math.max(0, chunkIndex - 1);
    else if (event.key === 'ArrowDown') next = Math.min(lastOpenableChunk, chunkIndex + 2);
    else if (event.key === 'ArrowUp') next = Math.max(0, chunkIndex - 2);
    else if (event.key === 'Home') next = 0;
    else if (event.key === 'End') next = lastOpenableChunk;
    else return;
    event.preventDefault();
    focusChunk(project, next);
  }, [focusChunk]);

  const handleOuterScroll = (event: React.UIEvent<HTMLDivElement>) => {
    const node = event.currentTarget;
    setOuterScrollTop(node.scrollTop);
    if (hasMore && onLoadMore && node.scrollTop + node.clientHeight >= node.scrollHeight - 240) onLoadMore();
  };

  return (
    <div className="project-sidebar-backdrop" onMouseDown={onClose}>
      <aside className="project-sidebar" onMouseDown={(event) => event.stopPropagation()} aria-busy={loading || undefined}>
        <div className="project-sidebar-header">
          <div>
            <div className="project-sidebar-title">Sessions</div>
            <div className="project-sidebar-subtitle">Autosaved in Documents/VaniScript Projects</div>
          </div>
          <button type="button" className="review-icon-btn" onMouseDown={(event) => event.stopPropagation()} onClick={onClose} aria-label="Close sessions">×</button>
        </div>
        <div className="project-sidebar-actions">
          <button className="btn-save" type="button" onClick={onImport}><Upload size={14} /> Import</button>
          <button className="btn-ghost-sm" type="button" onClick={onExportAll}><Archive size={14} /> Export All</button>
        </div>
        <div
          ref={outerViewportRef}
          className="project-list"
          role="list"
          aria-busy={loading || undefined}
          onScroll={handleOuterScroll}
        >
          {projects.length === 0 && !loading ? <div className="project-empty">No saved sessions yet.</div> : (
            <div className="project-list-inner" style={{ position: 'relative', height: outerWindow.totalHeight, minHeight: 56 }}>
              {Array.from({ length: Math.max(0, visibleEnd - visibleStart) }, (_, offset) => {
                const index = visibleStart + offset;
                const project = projects[index];
                if (!project) {
                  return <div key={`loading-${index}`} className="project-item-slot project-loading-slot" style={{ position: 'absolute', top: outerWindow.offsetAt(index), left: 0, right: 0, height: OUTER_COLLAPSED_HEIGHT }} aria-hidden="true">Loading…</div>;
                }
                const isExpanded = expandedProjectId === project.id;
                const isActiveProject = activeProjectId === project.id;
                const exportReady = isProjectExportReady(project.totalChunks, project.approvedChunks);
                const chunkScrollTop = chunkScrollTops[project.id] ?? 0;
                const lastOpenableChunk = clampChunkIndex(project.currentIndex, project.totalChunks);
                const focusIndex = Math.min(lastOpenableChunk, Math.max(0, focusedChunks[project.id] ?? lastOpenableChunk));
                const rawChunkWindow = getChunkRowWindow(project.totalChunks, chunkScrollTop, CHUNK_VIEWPORT_HEIGHT, CHUNK_ROW_HEIGHT, CHUNK_OVERSCAN);
                const focusRow = Math.floor(focusIndex / 2);
                const chunkWindow = project.totalChunks > 0
                  ? includeIndexInVirtualWindow(rawChunkWindow, focusRow)
                  : rawChunkWindow;
                const firstChunk = chunkWindow.start * 2;
                const lastChunk = Math.min(project.totalChunks, chunkWindow.end * 2);
                return (
                  <div
                    key={project.id}
                    className="project-item-slot"
                    role="listitem"
                    aria-setsize={total ?? projects.length}
                    aria-posinset={index + 1}
                    style={{ position: 'absolute', top: outerWindow.offsetAt(index), left: 0, right: 0, height: isExpanded ? OUTER_EXPANDED_HEIGHT : OUTER_COLLAPSED_HEIGHT }}
                  >
                    <div className={`project-item ${isActiveProject ? 'active' : ''} ${isExpanded ? 'expanded' : ''}`}>
                      <button className="project-open" type="button" onClick={() => onToggleProject(project.id)} aria-expanded={isExpanded}>
                        <span className="project-title-row">
                          {isExpanded ? <ChevronDown size={14} /> : <ChevronRight size={14} />}
                          <span className="project-name">{project.name}</span>
                        </span>
                        <span className="project-meta">{project.currentIndex + 1}/{Math.max(1, project.totalChunks)} chunks · {project.approvedChunks} approved · {project.targetLang || 'Same'}</span>
                        {project.sourceMediaInfo && <span className="project-media-meta">{project.sourceMediaInfo.kind === 'video' ? <Film size={12} /> : <FileAudio size={12} />}{mediaSummary(project.sourceMediaInfo)}</span>}
                        <span className="project-date">{new Date(project.updatedAt).toLocaleString()}</span>
                      </button>
                      <div className="project-item-actions">
                        <button type="button" title="Share project" aria-label={`Share ${project.name}`} onClick={() => onExportProject(project.id)}><Share2 size={13} /></button>
                        <button type="button" title="Delete project" aria-label={`Delete ${project.name}`} onClick={() => onDeleteProject(project.id)}><Trash2 size={13} /></button>
                      </div>
                      {isExpanded && (
                        <div className="project-expanded-body">
                          {project.sourceMediaInfo && (
                            <div className="project-media-card">
                              <div className="project-media-main">
                                <div className="project-media-icon" aria-hidden="true">{project.sourceMediaInfo.kind === 'video' ? <Film size={16} /> : <FileAudio size={16} />}</div>
                                <div className="project-media-copy">
                                  <span className="project-media-name" title={project.sourceMediaInfo.fileName}>{project.sourceMediaInfo.fileName}</span>
                                  <span className="project-media-summary">{mediaSummary(project.sourceMediaInfo)}</span>
                                </div>
                              </div>
                              <div className="project-media-path" title={project.sourceMediaInfo.filePath}>{project.sourceMediaInfo.filePath}</div>
                              <div className="project-media-actions">
                                <button type="button" className="project-media-action" onClick={(event) => { event.stopPropagation(); onOpenMediaInfo(project.sourceMediaInfo!); }}><Info size={11} /> Info</button>
                                <button type="button" className="project-media-action" onClick={(event) => { event.stopPropagation(); if (project.sourceMediaInfo?.filePath) onOpenPath?.(project.sourceMediaInfo.filePath); }}><Play size={11} /> Open</button>
                                <button type="button" className="project-media-action" onClick={(event) => { event.stopPropagation(); if (project.sourceMediaInfo?.filePath) onRevealPath?.(project.sourceMediaInfo.filePath); }}><FolderOpen size={11} /> Reveal</button>
                              </div>
                            </div>
                          )}
                          <div
                            ref={(node) => { if (node) chunkViewportRefs.current.set(project.id, node); else chunkViewportRefs.current.delete(project.id); }}
                            className="project-chunk-viewport"
                            aria-busy={loading || undefined}
                            onScroll={(event) => {
                              const top = event.currentTarget.scrollTop;
                              setChunkScrollTops((previous) => previous[project.id] === top
                                ? previous
                                : { ...previous, [project.id]: top });
                              if (project.totalChunks > 0) {
                                const nextFocus = Math.min(lastOpenableChunk, Math.max(0, Math.floor(top / CHUNK_ROW_HEIGHT) * 2));
                                setFocusedChunks((previous) => previous[project.id] === nextFocus
                                  ? previous
                                  : { ...previous, [project.id]: nextFocus });
                              }
                            }}
                          >
                            <div className="project-chunk-grid" style={{ position: 'relative', height: chunkWindow.totalHeight + (exportReady ? 40 : 0), minHeight: 40 }}>
                              {Array.from({ length: Math.max(0, lastChunk - firstChunk) }, (_, localIndex) => {
                                const chunkIndex = firstChunk + localIndex;
                                const isCurrentChunk = isActiveProject && project.currentIndex === chunkIndex;
                                const canOpenChunk = canOpenSidebarChunk(chunkIndex, project.currentIndex, project.totalChunks);
                                const isLastChunk = chunkIndex === project.currentIndex;
                                return (
                                  <button
                                    key={chunkIndex + 1}
                                    ref={(node) => { if (node) chunkButtonRefs.current.set(`${project.id}:${chunkIndex}`, node); else chunkButtonRefs.current.delete(`${project.id}:${chunkIndex}`); }}
                                    type="button"
                                    className={`project-chunk-btn ${isCurrentChunk ? 'active' : ''} ${canOpenChunk ? '' : 'locked'}`}
                                    disabled={!canOpenChunk}
                                    tabIndex={chunkIndex === focusIndex ? 0 : -1}
                                    aria-setsize={project.totalChunks}
                                    aria-posinset={chunkIndex + 1}
                                    aria-current={isCurrentChunk ? 'step' : undefined}
                                    aria-label={`Chunk ${chunkIndex + 1}${isCurrentChunk ? ', current' : ''}${isLastChunk ? ', last reached' : ''}${canOpenChunk ? '' : ', locked'}`}
                                    onKeyDown={(event) => handleChunkKeyDown(event, project, chunkIndex)}
                                    onFocus={() => setFocusedChunks((previous) => ({ ...previous, [project.id]: chunkIndex }))}
                                    onClick={() => { setFocusedChunks((previous) => ({ ...previous, [project.id]: chunkIndex })); onOpenProjectChunk(project, chunkIndex); }}
                                    style={{ position: 'absolute', top: Math.floor(chunkIndex / 2) * CHUNK_ROW_HEIGHT, left: `${(chunkIndex % 2) * 50}%`, width: 'calc(50% - 3px)', height: CHUNK_ROW_HEIGHT - 6 }}
                                  >
                                    <span>Chunk {chunkIndex + 1}</span>
                                    {isLastChunk && <span className="project-chunk-pill">last</span>}
                                  </button>
                                );
                              })}
                              {exportReady && <button type="button" className="project-export-btn" onClick={() => onOpenProjectExport(project)} style={{ position: 'absolute', top: chunkWindow.totalHeight, left: 0, right: 0 }}><Download size={13} /> Export</button>}
                            </div>
                          </div>
                        </div>
                      )}
                    </div>
                  </div>
                );
              })}
            </div>
          )}
        </div>
        <div className="project-sidebar-footer">
          <button className="btn-danger-sm" type="button" onClick={onClearArchive}>Clear Archive</button>
          {total !== undefined && <span className="project-sidebar-count" aria-live="polite">{projects.length.toLocaleString()} of {total.toLocaleString()} sessions loaded</span>}
        </div>
      </aside>
    </div>
  );
}

export const ProjectSidebar = memo(ProjectSidebarView);
ProjectSidebar.displayName = 'ProjectSidebar';
