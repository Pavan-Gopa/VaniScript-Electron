export type VaniScriptHelpLanguage = 'en' | 'ru';

export type VaniScriptHelpScreen =
  | 'upload'
  | 'config'
  | 'processing'
  | 'review'
  | 'export'
  | 'visualEditor';

export interface VaniScriptLocalizedHelpTopic {
  id: string;
  category: string;
  screen: string | null;
  title: string;
  summary: string;
  requirements: string[];
  steps: string[];
  troubleshooting: string[];
  relatedTopicIDs: string[];
}

export interface VaniScriptContextualHelp {
  screen: string;
  title: string;
  summary: string;
  nextActions: string[];
  recommendedTopicIDs: string[];
}

export interface VaniScriptOnboardingChecklist {
  title: string;
  summary: string;
  steps: string[];
  topicIDs: string[];
}

export interface HelpContextState {
  screen: VaniScriptHelpScreen;
  hasSource: boolean;
  hasSession: boolean;
  processingProgress: number;
  hasShortsPlans: boolean;
}

export type HelpLocalePreference = VaniScriptHelpLanguage;

export interface HelpTourStep {
  id: string;
  topicId: string;
  stepIndex: number;
  targetSelector: string;
  arrowCurveOffset: { dx: number; dy: number };
  bubblePlacement: 'top' | 'bottom' | 'left' | 'right' | 'center';
}

export interface HelpTourDefinition {
  screen: 'upload' | 'config' | 'review' | 'export' | 'settings' | 'visualEditor';
  steps: HelpTourStep[];
}

export interface HelpTopicListOptions {
  category?: string;
  language?: string;
}

export interface HelpTopicOptions {
  id?: string;
  language?: string;
}

export interface HelpSearchOptions {
  query?: string;
  language?: string;
  limit?: number;
}

export interface HelpContextOptions extends Partial<HelpContextState> {
  language?: string;
}

export interface HelpChecklistOptions {
  language?: string;
}

export interface HelpTopicSummary {
  id: string;
  category: string;
  screen: string | null;
  title: string;
  summary: string;
}

export interface HelpUICopy {
  search: string;
  currentScreen: string;
  checklist: string;
  back: string;
  close: string;
  startHelpTour: string;
  english: string;
  russian: string;
  noResults: string;
  topicUnavailable: string;
  next: string;
  previous: string;
  finish: string;
  skipWalkthrough: string;
  step: string;
  helpTour: string;
}

export const HELP_LANGUAGE_VALUES: readonly VaniScriptHelpLanguage[];
export const HELP_SCREEN_VALUES: readonly VaniScriptHelpScreen[];
export const HELP_UI_COPY: Readonly<Record<VaniScriptHelpLanguage, HelpUICopy>>;
export const HELP_TOUR_DEFINITIONS: Readonly<Record<HelpTourDefinition['screen'], HelpTourDefinition>>;

/** Missing/blank input uses fallback; every non-empty value is canonical en/ru. */
export function normalizeHelpLanguage(
  value: unknown,
  fallback?: string
): VaniScriptHelpLanguage;

/** Map Electron workflow aliases and unknown values to a canonical context screen. */
export function normalizeHelpScreen(value: unknown): VaniScriptHelpScreen;

export function listHelpTopics(
  options?: HelpTopicListOptions
): VaniScriptLocalizedHelpTopic[];

export function getHelpTopic(
  options?: HelpTopicOptions
): VaniScriptLocalizedHelpTopic | null;

export function getHelpTopicSummary(
  topic: VaniScriptLocalizedHelpTopic | string | null | undefined,
  language?: string
): HelpTopicSummary | null;

export function toHelpTopicDictionary(
  topic: VaniScriptLocalizedHelpTopic | string | null | undefined,
  language?: string
): VaniScriptLocalizedHelpTopic | null;

export function searchHelp(options?: HelpSearchOptions): VaniScriptLocalizedHelpTopic[];

export function contextualHelp(options?: HelpContextOptions): VaniScriptContextualHelp;

export function onboardingChecklist(
  options?: HelpChecklistOptions
): VaniScriptOnboardingChecklist;

export function getHelpTourDefinition(
  screen: string
): HelpTourDefinition | null;
