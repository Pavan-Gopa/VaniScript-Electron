import React, { useEffect, useMemo, useRef, useState } from 'react';
import { ArrowLeft, ChevronRight, HelpCircle, Search as SearchIcon, X } from 'lucide-react';
import {
  HELP_UI_COPY,
  contextualHelp,
  getHelpTopic,
  normalizeHelpLanguage,
  normalizeHelpScreen,
  onboardingChecklist,
  searchHelp,
} from '../../shared/help-catalog';
import type {
  VaniScriptContextualHelp,
  VaniScriptHelpLanguage,
  VaniScriptLocalizedHelpTopic,
  VaniScriptOnboardingChecklist,
} from '../../shared/help-catalog';

export type HelpCenterView = 'search' | 'current' | 'checklist';

export interface HelpCenterContext {
  screen: string;
  hasSource?: boolean;
  hasSession?: boolean;
  processingProgress?: number;
  hasShortsPlans?: boolean;
}

export interface HelpCenterPanelProps {
  isOpen: boolean;
  locale?: string;
  context: HelpCenterContext;
  onClose: () => void;
  onLocaleChange: (locale: VaniScriptHelpLanguage) => void;
  onStartHelpTour: () => void;
  initialView?: HelpCenterView;
}

export const HELP_CENTER_VIEW_OPTIONS = Object.freeze([
  { id: 'search', copyKey: 'search' },
  { id: 'current', copyKey: 'currentScreen' },
  { id: 'checklist', copyKey: 'checklist' },
] as const);

const FOCUSABLE_SELECTOR = [
  'button:not([disabled])',
  'input:not([disabled])',
  'select:not([disabled])',
  'textarea:not([disabled])',
  '[href]',
  '[tabindex]:not([tabindex="-1"])',
].join(',');

function isHelpCenterView(value: unknown): value is HelpCenterView {
  return value === 'search' || value === 'current' || value === 'checklist';
}

export interface HelpCenterState {
  language: VaniScriptHelpLanguage;
  view: HelpCenterView;
  query: string;
  canonicalScreen: string;
  current: VaniScriptContextualHelp;
  checklist: VaniScriptOnboardingChecklist;
  results: VaniScriptLocalizedHelpTopic[];
  selectedTopicId: string | null;
  selectedTopic: VaniScriptLocalizedHelpTopic | null;
}

/**
 * Resolve every catalog-backed Help Center state from one deterministic input.
 * Keeping this pure makes renderer and SSR tests exercise the same decisions as
 * the interactive drawer without duplicating catalog semantics in JSX.
 */
export function deriveHelpCenterState(options: {
  language?: unknown;
  view?: unknown;
  query?: unknown;
  context?: HelpCenterContext;
  selectedTopicId?: string | null;
}): HelpCenterState {
  const language = normalizeHelpLanguage(options.language);
  const view = isHelpCenterView(options.view) ? options.view : 'current';
  const query = String(options.query ?? '');
  const context = options.context ?? { screen: 'upload' };
  const rawProgress = context.processingProgress;
  const processingProgress = typeof rawProgress === 'number' && Number.isFinite(rawProgress) ? rawProgress : 0;
  const canonicalScreen = normalizeHelpScreen(context.screen);
  const current = contextualHelp({
    screen: canonicalScreen,
    hasSource: Boolean(context.hasSource),
    hasSession: Boolean(context.hasSession),
    processingProgress,
    hasShortsPlans: Boolean(context.hasShortsPlans),
    language,
  });
  const checklist = onboardingChecklist({ language });
  const selectedTopicId = typeof options.selectedTopicId === 'string' && options.selectedTopicId.trim().length > 0
    ? options.selectedTopicId
    : null;
  const selectedTopic = selectedTopicId ? getHelpTopic({ id: selectedTopicId, language }) : null;

  return {
    language,
    view,
    query,
    canonicalScreen,
    current,
    checklist,
    results: searchHelp({ query, language, limit: 10 }),
    selectedTopicId,
    selectedTopic,
  };
}

function focusableElements(container: HTMLElement): HTMLElement[] {
  return Array.from(container.querySelectorAll<HTMLElement>(FOCUSABLE_SELECTOR));
}

export function HelpCenterPanel({
  isOpen,
  locale,
  context,
  onClose,
  onLocaleChange,
  onStartHelpTour,
  initialView = 'current',
}: HelpCenterPanelProps): React.ReactElement | null {
  const [view, setView] = useState<HelpCenterView>(initialView);
  const [query, setQuery] = useState('');
  const [selectedTopicId, setSelectedTopicId] = useState<string | null>(null);
  const drawerRef = useRef<HTMLElement>(null);
  const state = useMemo(
    () => deriveHelpCenterState({ language: locale, view, query, context, selectedTopicId }),
    [context, locale, query, selectedTopicId, view],
  );
  const copy = HELP_UI_COPY[state.language];

  useEffect(() => {
    if (!isOpen) return undefined;
    setView(initialView);
    setQuery('');
    setSelectedTopicId(null);
    return undefined;
  }, [initialView, isOpen]);

  useEffect(() => {
    if (!isOpen) return undefined;
    const origin = typeof document !== 'undefined' && document.activeElement instanceof HTMLElement
      ? document.activeElement
      : null;
    const focusFirst = () => {
      const drawer = drawerRef.current;
      const first = drawer ? focusableElements(drawer)[0] : null;
      first?.focus();
    };
    const timer = window.setTimeout(focusFirst, 0);
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        event.preventDefault();
        onClose();
        return;
      }
      if (event.key !== 'Tab') return;
      const drawer = drawerRef.current;
      if (!drawer) return;
      const focusable = focusableElements(drawer);
      if (focusable.length === 0) return;
      const currentIndex = focusable.indexOf(document.activeElement as HTMLElement);
      if (currentIndex < 0) {
        event.preventDefault();
        focusable[0].focus();
        return;
      }
      const nextIndex = event.shiftKey
        ? (currentIndex - 1 + focusable.length) % focusable.length
        : (currentIndex + 1) % focusable.length;
      event.preventDefault();
      focusable[nextIndex].focus();
    };
    document.addEventListener('keydown', handleKeyDown);
    return () => {
      window.clearTimeout(timer);
      document.removeEventListener('keydown', handleKeyDown);
      if (origin?.isConnected) origin.focus();
    };
  }, [isOpen, onClose]);

  if (!isOpen) return null;

  const openTopic = (topicId: string) => setSelectedTopicId(topicId);
  const backToList = () => setSelectedTopicId(null);
  const backToSearch = () => {
    setSelectedTopicId(null);
    setView('search');
  };
  const selectView = (nextView: HelpCenterView) => {
    setSelectedTopicId(null);
    setView(nextView);
  };
  const startTour = () => {
    onStartHelpTour();
    onClose();
  };
  const selectedTopic = state.selectedTopic;

  return (
    <>
      <div
        className="help-center-backdrop"
        aria-hidden="true"
        onMouseDown={onClose}
      />
      <aside
        ref={drawerRef}
        className="help-center-drawer"
        role="dialog"
        aria-modal="false"
        aria-labelledby="help-center-title"
        data-testid="help-center-panel"
      >
        <header className="help-center-header">
          <div className="help-center-heading">
            <HelpCircle size={17} aria-hidden="true" />
            <h2 id="help-center-title">Help Center</h2>
          </div>
          <div className="help-center-header-actions">
            <div className="help-center-locale" role="group" aria-label={`${copy.english} / ${copy.russian}`}>
              <button
                type="button"
                data-testid="help-center-locale-en"
                className={state.language === 'en' ? 'active' : ''}
                aria-pressed={state.language === 'en'}
                onClick={() => onLocaleChange('en')}
              >
                {copy.english}
              </button>
              <button
                type="button"
                data-testid="help-center-locale-ru"
                className={state.language === 'ru' ? 'active' : ''}
                aria-pressed={state.language === 'ru'}
                onClick={() => onLocaleChange('ru')}
              >
                {copy.russian}
              </button>
            </div>
            <button type="button" className="help-center-close" onClick={onClose} aria-label={copy.close} title={copy.close}>
              <X size={16} aria-hidden="true" />
            </button>
          </div>
        </header>

        <nav className="help-center-tabs" role="tablist" aria-label={copy.helpTour}>
          {HELP_CENTER_VIEW_OPTIONS.map((option) => {
            const active = state.view === option.id;
            const label = copy[option.copyKey];
            return (
              <button
                key={option.id}
                type="button"
                role="tab"
                aria-selected={active}
                aria-controls={`help-center-tabpanel-${option.id}`}
                className={active ? 'active' : ''}
                onClick={() => selectView(option.id)}
                data-testid={`help-center-tab-${option.id}`}
              >
                {label}
              </button>
            );
          })}
        </nav>

        <div className="help-center-body">
          {selectedTopicId ? (
            <section className="help-center-panel-content" role="tabpanel" aria-label={selectedTopic?.title ?? copy.topicUnavailable}>
              <button type="button" className="help-center-back" onClick={backToList}>
                <ArrowLeft size={14} aria-hidden="true" /> {copy.back}
              </button>
              {selectedTopic ? (
                <article className="help-center-topic-detail" data-help-topic-id={selectedTopic.id}>
                  <span className="help-center-topic-category">{selectedTopic.category}</span>
                  <h3>{selectedTopic.title}</h3>
                  <p className="help-center-topic-summary">{selectedTopic.summary}</p>
                  {selectedTopic.requirements.length > 0 && (
                    <div className="help-center-detail-group">
                      <h4>Requirements</h4>
                      <ul>
                        {selectedTopic.requirements.map((item, index) => <li key={`${selectedTopic.id}-requirement-${index}`}>{item}</li>)}
                      </ul>
                    </div>
                  )}
                  <div className="help-center-detail-group">
                    <h4>{copy.step}</h4>
                    <ol>
                      {selectedTopic.steps.map((item, index) => <li key={`${selectedTopic.id}-step-${index}`}>{item}</li>)}
                    </ol>
                  </div>
                  {selectedTopic.troubleshooting.length > 0 && (
                    <div className="help-center-detail-group">
                      <h4>Troubleshooting</h4>
                      <ul>
                        {selectedTopic.troubleshooting.map((item, index) => <li key={`${selectedTopic.id}-troubleshooting-${index}`}>{item}</li>)}
                      </ul>
                    </div>
                  )}
                  {selectedTopic.relatedTopicIDs.length > 0 && (
                    <div className="help-center-detail-group">
                      <h4>Related</h4>
                      <div className="help-center-topic-links">
                        {selectedTopic.relatedTopicIDs.map((topicId) => {
                          const related = getHelpTopic({ id: topicId, language: state.language });
                          return related ? (
                            <button key={topicId} type="button" onClick={() => openTopic(topicId)}>
                              {related.title} <ChevronRight size={13} aria-hidden="true" />
                            </button>
                          ) : null;
                        })}
                      </div>
                    </div>
                  )}
                </article>
              ) : (
                <div className="help-center-empty" role="status">
                  <p>{copy.topicUnavailable}</p>
                  <button type="button" className="btn-ghost-sm" onClick={backToSearch}>{copy.search}</button>
                </div>
              )}
            </section>
          ) : state.view === 'search' ? (
            <section id="help-center-tabpanel-search" className="help-center-panel-content" role="tabpanel" aria-label={copy.search}>
              <label className="help-center-search-wrap">
                <SearchIcon size={15} aria-hidden="true" />
                <input
                  type="search"
                  value={query}
                  onChange={(event) => setQuery(event.currentTarget.value)}
                  placeholder={copy.search}
                  aria-label={copy.search}
                  data-testid="help-center-search"
                />
              </label>
              <div className="help-center-announcement" role="status" aria-live="polite">
                {copy.search}: {state.results.length}
              </div>
              {state.results.length > 0 ? (
                <div className="help-center-topic-list" data-testid="help-center-search-results">
                  {state.results.map((topic) => (
                    <button key={topic.id} type="button" className="help-center-topic-card" onClick={() => openTopic(topic.id)}>
                      <span className="help-center-topic-category">{topic.category}</span>
                      <strong>{topic.title}</strong>
                      <span>{topic.summary}</span>
                    </button>
                  ))}
                </div>
              ) : (
                <div className="help-center-empty" role="status" data-testid="help-center-empty">
                  <p>{copy.noResults}</p>
                  <div className="help-center-empty-actions">
                    <button type="button" className="btn-ghost-sm" onClick={() => selectView('current')}>{copy.currentScreen}</button>
                    <button type="button" className="btn-ghost-sm" onClick={() => selectView('checklist')}>{copy.checklist}</button>
                  </div>
                </div>
              )}
            </section>
          ) : state.view === 'current' ? (
            <section id="help-center-tabpanel-current" className="help-center-panel-content" role="tabpanel" aria-label={copy.currentScreen}>
              <div className="help-center-context-card" role="status" data-testid="help-center-current-screen">
                <span className="help-center-topic-category">{state.canonicalScreen}</span>
                <h3>{state.current.title}</h3>
                <p>{state.current.summary}</p>
                <ol className="help-center-action-list">
                  {state.current.nextActions.map((action, index) => <li key={`context-action-${index}`}>{action}</li>)}
                </ol>
              </div>
              <div className="help-center-detail-group">
                <div className="help-center-section-heading">
                  <span>{copy.search}</span>
                  <span className="help-center-count">{state.current.recommendedTopicIDs.length}</span>
                </div>
                <div className="help-center-topic-links">
                  {state.current.recommendedTopicIDs.map((topicId) => {
                    const topic = getHelpTopic({ id: topicId, language: state.language });
                    return topic ? (
                      <button key={topicId} type="button" onClick={() => openTopic(topicId)}>
                        {topic.title} <ChevronRight size={13} aria-hidden="true" />
                      </button>
                    ) : null;
                  })}
                </div>
              </div>
            </section>
          ) : (
            <section id="help-center-tabpanel-checklist" className="help-center-panel-content" role="tabpanel" aria-label={copy.checklist}>
              <div className="help-center-context-card" role="status" data-testid="help-center-checklist">
                <h3>{state.checklist.title}</h3>
                <p>{state.checklist.summary}</p>
              </div>
              <ol className="help-center-checklist">
                {state.checklist.steps.map((step, index) => <li key={`checklist-step-${index}`}>{step}</li>)}
              </ol>
              <div className="help-center-detail-group">
                <div className="help-center-section-heading"><span>{copy.search}</span></div>
                <div className="help-center-topic-links">
                  {state.checklist.topicIDs.map((topicId) => {
                    const topic = getHelpTopic({ id: topicId, language: state.language });
                    return topic ? (
                      <button key={topicId} type="button" onClick={() => openTopic(topicId)}>
                        {topic.title} <ChevronRight size={13} aria-hidden="true" />
                      </button>
                    ) : null;
                  })}
                </div>
              </div>
            </section>
          )}
        </div>

        <footer className="help-center-footer">
          <button type="button" data-testid="help-center-start-tour" className="btn-save help-center-tour-button" onClick={startTour}>
            <HelpCircle size={14} aria-hidden="true" /> {copy.startHelpTour}
          </button>
        </footer>
      </aside>
    </>
  );
}

export { HELP_UI_COPY, normalizeHelpLanguage };
