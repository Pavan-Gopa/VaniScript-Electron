import React, { useEffect, useRef, useState } from 'react';
import { Edit3 } from 'lucide-react';
import { formatPlaybackClock } from '../lib/karaoke';
import type { ProviderOption } from '../lib/provider-registry';
import {
  ExtraAudioTrack,
  IntroOutroOverlaySettings,
  LogoOverlaySettings,
  parseShortsTimestamp,
  selectShortsSourceProjection,
  selectShortsTargetProjection,
  ShortsClipPlan,
  ShortsMutationResult,
  ShortsPlanLanguageMode,
  ShortsSelectionKey,
  TextOverlayTrack,
  shortsPlanExportLanguages,
  shortsSelectionKey,
} from '../lib/shorts-reels';
import { defaultBackgroundSettings, ShortsFrameRatePreset, ShortsResolutionPreset, ShortsTextTransform, ShortsVideoFormat, ShortsVideoQuality } from '../lib/shorts-render';
import { SubtitleAlignmentEditor } from './subtitle-alignment/SubtitleAlignmentEditor';
import { ReplaceClipModal } from './ReplaceClipModal';
import { assistantStore } from '../stores/assistantStore';
import { paneStore } from '../stores/paneStore';

export type ShortsExportMode = 'plan' | 'video';

export type ShortsSettings = {
  count: number;
  minDurationSec: number;
  maxDurationSec: number;
  mode: ShortsExportMode;
  cropX: number;
  cropY: number;
  zoom: number;
  subtitleBottomMargin: number;
  subtitleFontFamily: string;
  subtitleFontSize: number;
  subtitleBold: boolean;
  subtitleTextTransform: ShortsTextTransform;
  subtitleTextColor: string;
  subtitleBoxColor: string;
  subtitleBoxOpacity: number;
  subtitleBoxWidth: number;
  subtitleBoxHeight: number;
  subtitleBoxBlur: number;
  subtitleLetterSpacing: number;
  subtitleLineSpacing: number;
  subtitleEdgeSoftness: number;
  subtitleUseCharsPerLine: boolean;
  subtitleUseLinesPerCue: boolean;
  subtitleOutline?: number;
  subtitleOutlineColor?: string;
  subtitleOutlineOpacity?: number;
  subtitleShadow?: number;
  subtitleShadowColor?: string;
  subtitleShadowOpacity?: number;
  subtitleShadowBlur?: number;
  subtitleShadowDistance?: number;
  subtitleShadowAngle?: number;
  videoFormat: ShortsVideoFormat;
  resolutionPreset: ShortsResolutionPreset;
  videoQuality: ShortsVideoQuality;
  frameRate: ShortsFrameRatePreset;
};

type Props = {
  hasVideo: boolean;
  hasTranslation: boolean;
  targetLang: string;
  activeTranslationLanguage: string;
  settings: ShortsSettings;
  plans: ShortsClipPlan[];
  rejectedPlans: ShortsClipPlan[];
  isBusy: boolean;
  busyLabel?: string;
  focusedPlanID: string | null;
  selectedPlanKeys: Set<ShortsSelectionKey>;
  planningProviders: ProviderOption[];
  planningProvider: string;
  onPlanningProviderChange: (providerId: string) => void;
  previewAudioSrc: string;
  previewAudioPath: string;
  previewAudioStatus: 'idle' | 'loading' | 'ready' | 'error';
  previewAudioError?: string;
  previewVideoSrc: string;
  previewOutputSize: { width: number; height: number };
  subtitleMaxCharsPerLine: number;
  subtitleMaxLines: number;
  onChange: (settings: ShortsSettings) => void;
  onSubtitleLayoutChange: (next: { maxCharsPerLine: number; maxLines: number }) => void;
  onFindMoments: (mode: ShortsPlanLanguageMode) => void;
  onFocusPlan: (stableID: string) => void;
  onTogglePlan: (stableID: string) => void;
  onUpdatePlan: (stableID: string, patch: Partial<ShortsClipPlan>, language?: ShortsDisplayLanguage) => void;
  onRemovePlan: (stableID: string) => void;
  onRestorePlan: (stableID: string) => void;
  onSavePlanAlignment: (stableID: string, language: ShortsDisplayLanguage, segments: ShortsClipPlan['sourceAlignment']) => void;
  onSavePlanFrameKeyframes: (stableID: string, language: ShortsDisplayLanguage, keyframes: ShortsClipPlan['sourceFrameKeyframes']) => void;
  onSavePlanLogo?: (stableID: string, language: ShortsDisplayLanguage, logo?: LogoOverlaySettings) => void;
  onSavePlanTextTracks?: (stableID: string, language: ShortsDisplayLanguage, tracks: TextOverlayTrack[]) => void;
  onSavePlanAudioTracks?: (stableID: string, language: ShortsDisplayLanguage, tracks: ExtraAudioTrack[]) => void;
  onSavePlanIntro?: (stableID: string, language: ShortsDisplayLanguage, intro?: IntroOutroOverlaySettings) => void;
  onSavePlanOutro?: (stableID: string, language: ShortsDisplayLanguage, outro?: IntroOutroOverlaySettings) => void;
  getPlanCues: (plan: ShortsClipPlan, language?: ShortsDisplayLanguage) => { startSec: number; endSec: number; text: string }[];
  getPlanDetailText: (plan: ShortsClipPlan) => { source: string; target: string };
  onExportIdeas: () => void;
  onExportSelected: () => void;
  onTranslateMetadata: () => void;
  isTranslatingMetadata?: boolean;
  onSaveDefaults: () => void;
  onReplacePlan?: (stableID: string, startTimestamp: string, endTimestamp: string) => ShortsMutationResult<ShortsClipPlan> | undefined;
  onToggleClipSync?: (stableID: string) => void;
  onImportMotion?: (stableID: string) => void;
};

function clipDurationLabel(plan: ShortsClipPlan): string {
  const start = parseShortsTimestamp(plan.start);
  const end = parseShortsTimestamp(plan.end);
  if (!start.ok || !end.ok || start.seconds === null || end.seconds === null) return '';
  const duration = end.seconds - start.seconds;
  return duration > 0 ? `${duration}s` : '';
}

type ShortsDisplayLanguage = 'source' | 'target';

function displayedPlanText(
  plan: ShortsClipPlan,
  language: ShortsDisplayLanguage,
  activeLanguage: string,
) {
  const projection = language === 'source'
    ? selectShortsSourceProjection(plan)
    : selectShortsTargetProjection(plan, activeLanguage);
  return {
    title: projection.title,
    summary: projection.summary,
    hook: projection.hook,
    category: projection.category || 'clip',
  };
}

function bilingualPatch(language: ShortsDisplayLanguage, field: 'title' | 'summary' | 'hook' | 'category', value: string): Partial<ShortsClipPlan> {
  if (language === 'source') {
    if (field === 'title') return { sourceTitle: value };
    if (field === 'summary') return { sourceSummary: value };
    if (field === 'hook') return { sourceHook: value };
    return { sourceCategory: value };
  }
  if (field === 'title') return { targetTitle: value };
  if (field === 'summary') return { targetSummary: value };
  if (field === 'hook') return { targetHook: value };
  return { targetCategory: value };
}

function captionPatch(language: ShortsDisplayLanguage, value: string): Partial<ShortsClipPlan> {
  return language === 'source' ? { sourceCaptionText: value } : { targetCaptionText: value };
}

function captionTextForLanguage(
  plan: ShortsClipPlan,
  language: ShortsDisplayLanguage,
  activeLanguage: string,
): string | undefined {
  const projection = language === 'source'
    ? selectShortsSourceProjection(plan)
    : selectShortsTargetProjection(plan, activeLanguage);
  return projection.captionText || undefined;
}

function renderProviderOptions(options: ProviderOption[]) {
  const cloud = options.filter((option) => option.group === 'cloud');
  const local = options.filter((option) => option.group === 'local');
  return (
    <>
      {cloud.length > 0 && (
        <optgroup label="Cloud">
          {cloud.map((option) => <option key={option.id} value={option.id}>{option.label}</option>)}
        </optgroup>
      )}
      {local.length > 0 && (
        <optgroup label="Local">
          {local.map((option) => <option key={option.id} value={option.id}>{option.label}</option>)}
        </optgroup>
      )}
    </>
  );
}

export function ShortsReelsPanel({
  hasVideo,
  hasTranslation,
  targetLang,
  activeTranslationLanguage,
  settings,
  plans,
  rejectedPlans,
  isBusy,
  busyLabel,
  focusedPlanID,
  selectedPlanKeys,
  planningProviders,
  planningProvider,
  onPlanningProviderChange,
  previewAudioSrc,
  previewAudioPath,
  previewVideoSrc,
  subtitleMaxCharsPerLine,
  subtitleMaxLines,
  onChange,
  onFindMoments,
  onFocusPlan,
  onTogglePlan,
  onUpdatePlan,
  onRemovePlan,
  onRestorePlan,
  onSavePlanAlignment,
  onSavePlanFrameKeyframes,
  onSavePlanLogo,
  onSavePlanTextTracks,
  onSavePlanAudioTracks,
  onSavePlanIntro,
  onSavePlanOutro,
  getPlanCues,
  getPlanDetailText,
  onExportIdeas,
  onExportSelected,
  onTranslateMetadata,
  isTranslatingMetadata,
  onSaveDefaults,
  onReplacePlan,
  onToggleClipSync,
  onImportMotion,
}: Props) {
  const [detailsPlanID, setDetailsPlanID] = useState<string | null>(null);
  const [editorPlanID, setEditorPlanID] = useState<string | null>(null);
  const [replacePlanID, setReplacePlanID] = useState<string | null>(null);
  const [displayLanguage, setDisplayLanguage] = useState<ShortsDisplayLanguage>('target');
  const [copiedKey, setCopiedKey] = useState<string>('');
  const patch = (partial: Partial<ShortsSettings>) => onChange({ ...settings, ...partial });
  const selectedPlans = plans.filter((plan) => {
    if (!plan.stableID) return false;
    return shortsPlanExportLanguages(plan).some((language) => selectedPlanKeys.has(shortsSelectionKey(plan.stableID!, language)));
  });
  const selectedCount = selectedPlans.length;
  const selectedExportCount = selectedPlans.reduce((sum, plan) => {
    if (!plan.stableID) return sum;
    return sum + shortsPlanExportLanguages(plan).filter((language) => selectedPlanKeys.has(shortsSelectionKey(plan.stableID!, language))).length;
  }, 0);
  const detailsPlan = detailsPlanID ? plans.find((plan) => plan.stableID === detailsPlanID) || null : null;
  const detailsDisplay = detailsPlan ? displayedPlanText(detailsPlan, displayLanguage, activeTranslationLanguage) : null;
  const detailsText = detailsPlan ? getPlanDetailText(detailsPlan) : null;
  const detailsCues = detailsPlan ? getPlanCues(detailsPlan, displayLanguage) : [];
  const canUseTarget = hasTranslation;
  const canSwitchLanguage = plans.some((plan) => plan.languageMode === 'bilingual');
  const editorPlan = editorPlanID ? plans.find((plan) => plan.stableID === editorPlanID) || null : null;
  const detailsStart = detailsPlan ? parseShortsTimestamp(detailsPlan.start) : null;
  const editorStart = editorPlan ? parseShortsTimestamp(editorPlan.start) : null;
  const editorEnd = editorPlan ? parseShortsTimestamp(editorPlan.end) : null;
  const detailsStartSec = detailsStart && detailsStart.ok && detailsStart.seconds !== null
    ? detailsStart.seconds
    : null;
  const detailsCaptionText = detailsPlan
    ? captionTextForLanguage(detailsPlan, displayLanguage, activeTranslationLanguage) ?? (
        detailsStartSec !== null
          ? detailsCues.map((cue) => `[${formatPlaybackClock(detailsStartSec + cue.startSec)}] ${cue.text}`).join('\n\n')
          : ''
      )
    : '';

  const openEditor = (stableID: string) => {
    setEditorPlanID(stableID);
  };

  const closeEditor = () => {
    setEditorPlanID(null);
  };

  useEffect(() => {
    const mode = plans[0]?.languageMode;
    setDisplayLanguage(mode === 'source' || mode === 'bilingual' ? 'source' : 'target');
  }, [plans.length, plans[0]?.languageMode]);

  useEffect(() => {
    if (detailsPlanID && !plans.some((plan) => plan.stableID === detailsPlanID)) setDetailsPlanID(null);
    if (editorPlanID && !plans.some((plan) => plan.stableID === editorPlanID)) setEditorPlanID(null);
    if (replacePlanID && !plans.some((plan) => plan.stableID === replacePlanID)) setReplacePlanID(null);
  }, [detailsPlanID, editorPlanID, plans, replacePlanID]);

  const copyText = async (key: string, value: string) => {
    try {
      await navigator.clipboard.writeText(value);
      setCopiedKey(key);
      window.setTimeout(() => setCopiedKey((current) => current === key ? '' : current), 1200);
    } catch {
      setCopiedKey('');
    }
  };

  return (
    <section className="shorts-panel">
      <div className="shorts-panel-head">
        <div>
          <h3>Shorts &amp; Reels</h3>
          <p>Four steps in one scroll: find moments, select clips, tune captions, export video or ideas.</p>
        </div>
        <div className="shorts-panel-tools">
          {planningProviders.length > 0 && (
            <label className="shorts-model-select">
              Planning model
              <select value={planningProvider} onChange={(event) => onPlanningProviderChange(event.currentTarget.value)}>
                {renderProviderOptions(planningProviders)}
              </select>
            </label>
          )}
          <button type="button" className="shorts-defaults-button" onClick={onSaveDefaults} disabled={isBusy}>
            Save defaults
          </button>
        </div>
      </div>

      <div className="shorts-flow">
        <div className="shorts-card-section" data-tour="shorts-find-moments">
          <div className="shorts-step-head"><span>1</span><strong>Find short moments</strong></div>
          <div className="shorts-finder-grid">
            <label>
              Number of clips
              <input type="range" min={1} max={8} value={settings.count} onChange={(event) => patch({ count: Number(event.currentTarget.value) })} />
              <b>{settings.count}</b>
            </label>
            <label>
              Min length
              <input type="range" min={15} max={120} step={5} value={settings.minDurationSec} onChange={(event) => patch({ minDurationSec: Number(event.currentTarget.value) })} />
              <b>{settings.minDurationSec}s</b>
            </label>
            <label>
              Max length
              <input type="range" min={30} max={240} step={5} value={settings.maxDurationSec} onChange={(event) => patch({ maxDurationSec: Number(event.currentTarget.value) })} />
              <b>{settings.maxDurationSec}s</b>
            </label>
          </div>
          <div className="shorts-find-actions">
            <button className="shorts-primary-action" onClick={() => onFindMoments('source')} disabled={isBusy}>
              {isBusy ? (busyLabel || 'Working...') : 'Source language'}
            </button>
            <button className="shorts-primary-action" onClick={() => onFindMoments('bilingual')} disabled={isBusy || !canUseTarget}>
              {isBusy ? (busyLabel || 'Working...') : 'Source + Target'}
            </button>
            <button className="shorts-primary-action" onClick={() => onFindMoments('target')} disabled={isBusy || !canUseTarget}>
              {isBusy ? (busyLabel || 'Working...') : `Target language${targetLang && targetLang !== 'same' ? `: ${targetLang}` : ''}`}
            </button>
          </div>
        </div>

        <div className="shorts-card-section" data-tour="shorts-choose-clips">
          <div className="shorts-step-head shorts-step-head-split">
            <div><span>2</span><strong>Choose clips</strong></div>
            {canSwitchLanguage && (
              <div className="shorts-language-toggle" role="tablist" aria-label="Clip card language">
                <button type="button" className={displayLanguage === 'source' ? 'active' : ''} onClick={() => setDisplayLanguage('source')}>Source</button>
                <button type="button" className={displayLanguage === 'target' ? 'active' : ''} onClick={() => setDisplayLanguage('target')}>Target</button>
              </div>
            )}
          </div>
          <div className="shorts-plan-list">
            {plans.length === 0 && <div className="shorts-empty">Click “Find Moments” to create clip cards with title, timing, description, and category.</div>}
            {plans.map((plan, index) => {
              const checked = Boolean(plan.stableID) && shortsPlanExportLanguages(plan).some((language) => selectedPlanKeys.has(shortsSelectionKey(plan.stableID!, language)));
              const display = displayedPlanText(plan, displayLanguage, activeTranslationLanguage);
              return (
                <article key={plan.stableID || `${plan.start}-${plan.end}-${index}`} className={`shorts-clip-card ${checked ? 'selected' : 'muted'} ${focusedPlanID === plan.stableID ? 'focused' : ''}`}>
                  <button type="button" className={`shorts-check ${checked ? 'on' : ''}`} onClick={() => plan.stableID && onTogglePlan(plan.stableID)} aria-label={checked ? 'Deselect clip' : 'Select clip'}>
                    {checked ? '✓' : ''}
                  </button>
                  <button type="button" className="shorts-clip-body" onClick={() => {
                    if (!plan.stableID) return;
                    onFocusPlan(plan.stableID);
                    setDetailsPlanID(plan.stableID);
                  }}>
                    <strong>{display.title}</strong>
                    <span>{plan.start}{' -> '}{plan.end}{clipDurationLabel(plan) ? ` · ${clipDurationLabel(plan)}` : ''}</span>
                    <p>{display.summary}</p>
                    <div className="shorts-chip-row">
                      <small>{display.category || 'clip'}</small>
                      <small>{plan.languageMode || 'target'}</small>
                    </div>
                  </button>
                  <div className="shorts-card-actions">
                    <button type="button" onClick={() => {
                      if (!plan.stableID) return;
                      onFocusPlan(plan.stableID);
                      setDetailsPlanID(plan.stableID);
                    }}>Details</button>
                    <button type="button" onClick={() => plan.stableID && setReplacePlanID(plan.stableID)}>Replace</button>
                    <button type="button" onClick={() => plan.stableID && onRemovePlan(plan.stableID)}>Delete</button>
                    <button
                      type="button"
                      className="shorts-edit-clip-button"
                      data-tour="shorts-edit-clip"
                      onClick={() => {
                        if (!plan.stableID) return;
                        if (!checked) onTogglePlan(plan.stableID);
                        onFocusPlan(plan.stableID);
                        openEditor(plan.stableID);
                      }}
                      disabled={!hasVideo || !previewVideoSrc}
                    >
                      <Edit3 size={12} /> Edit Clip
                    </button>
                  </div>
                </article>
              );
            })}
            {rejectedPlans.length > 0 && (
              <div className="shorts-rejected-list">
                <div className="shorts-step-head"><span>R</span><strong>Rejected clips</strong></div>
                {rejectedPlans.map((plan, index) => (
                  <article key={plan.stableID || `${plan.start}-${plan.end}-${index}`} className="shorts-clip-card muted">
                    <div className="shorts-clip-body">
                      <strong>{displayedPlanText(plan, displayLanguage, activeTranslationLanguage).title}</strong>
                      <span>{plan.start}{' -> '}{plan.end}{clipDurationLabel(plan) ? ` · ${clipDurationLabel(plan)}` : ''}</span>
                    </div>
                    <div className="shorts-card-actions">
                      <button type="button" onClick={() => plan.stableID && onRestorePlan(plan.stableID)}>Restore</button>
                    </div>
                  </article>
                ))}
              </div>
            )}
        </div>
        </div>

        <div className="shorts-card-section">
          <div className="shorts-step-head"><span>3</span><strong>Export</strong></div>
          <div className="shorts-export-row" data-tour="shorts-export-settings">
            <label>
              Format
              <select value={settings.videoFormat} onChange={(event) => patch({ videoFormat: event.currentTarget.value as ShortsVideoFormat })}>
                <option value="mp4">MP4</option>
                <option value="mov">MOV</option>
              </select>
            </label>
            <label>
              Resolution
              <select value={settings.resolutionPreset} onChange={(event) => patch({ resolutionPreset: event.currentTarget.value as ShortsResolutionPreset })}>
                <option value="source">Source-based</option>
                <option value="1080p">Full HD 1080x1920</option>
                <option value="2k">2K 1440x2560</option>
                <option value="4k">4K 2160x3840</option>
              </select>
            </label>
            <label>
              Frame rate
              <select value={settings.frameRate} onChange={(event) => patch({ frameRate: event.currentTarget.value as ShortsFrameRatePreset })}>
                <option value="source">Source-based</option>
                <option value="24">24 FPS</option>
                <option value="25">25 FPS</option>
                <option value="30">30 FPS</option>
                <option value="50">50 FPS</option>
                <option value="60">60 FPS</option>
              </select>
            </label>
          </div>
          {!hasVideo && <p className="shorts-hint">Video export requires a video source. You can still export clip ideas.</p>}
          <div className="shorts-export-actions" data-tour="shorts-export-actions">
            <button
              type="button"
              className="btn-dl btn-dl-secondary"
              onClick={onTranslateMetadata}
              disabled={!hasTranslation || !activeTranslationLanguage || activeTranslationLanguage === 'same' || plans.length === 0 || isBusy || isTranslatingMetadata}
            >
              {isTranslatingMetadata ? 'Translating metadata…' : `Translate metadata to ${activeTranslationLanguage || targetLang}`}
            </button>
            <button type="button" className="btn-dl btn-dl-secondary" onClick={onExportIdeas} disabled={plans.length === 0 || isBusy}>Export ideas JSON/TXT</button>
            <button type="button" className="btn-dl btn-dl-primary" onClick={onExportSelected} disabled={!hasVideo || selectedCount === 0 || isBusy}>
              {isBusy ? (busyLabel || 'Exporting...') : `Export selected videos (${selectedExportCount})`}
            </button>
          </div>
          <p className="shorts-note">
            Clips are trimmed and encoded with FFmpeg. Visual composition is rendered through HyperFrames.
          </p>
        </div>
      </div>

      {detailsPlan && detailsDisplay && detailsText && (
        <div className="shorts-modal-backdrop" onMouseDown={() => setDetailsPlanID(null)}>
          <div className="shorts-modal" onMouseDown={(event) => event.stopPropagation()}>
            <div className="shorts-modal-head">
              <div>
                <h3>Clip details</h3>
                <p>{detailsPlan.start} {' -> '} {detailsPlan.end} · {clipDurationLabel(detailsPlan)} · {detailsPlan.languageMode || 'target'}</p>
              </div>
              <button type="button" onClick={() => setDetailsPlanID(null)}>×</button>
            </div>
            {detailsPlan.languageMode === 'bilingual' && (
              <div className="shorts-modal-language">
                <button type="button" className={displayLanguage === 'source' ? 'active' : ''} onClick={() => setDisplayLanguage('source')}>Source fields</button>
                <button type="button" className={displayLanguage === 'target' ? 'active' : ''} onClick={() => setDisplayLanguage('target')}>Target fields</button>
              </div>
            )}
            <div className="shorts-modal-grid">
              <div className="shorts-field">
                <div className="shorts-field-head">
                  <span>Title</span>
                  <button type="button" onClick={() => copyText('title', detailsDisplay.title)}>{copiedKey === 'title' ? '✓' : 'Copy'}</button>
                </div>
                <input value={detailsDisplay.title} onChange={(event) => onUpdatePlan(detailsPlanID!, bilingualPatch(displayLanguage, 'title', event.currentTarget.value), displayLanguage)} />
              </div>
              <div className="shorts-field">
                <div className="shorts-field-head">
                  <span>Category</span>
                </div>
                <input value={detailsDisplay.category || ''} onChange={(event) => onUpdatePlan(detailsPlanID!, bilingualPatch(displayLanguage, 'category', event.currentTarget.value), displayLanguage)} />
              </div>
              <div className="shorts-field wide">
                <div className="shorts-field-head">
                  <span>Description</span>
                  <button type="button" onClick={() => copyText('summary', detailsDisplay.summary)}>{copiedKey === 'summary' ? '✓' : 'Copy'}</button>
                </div>
                <textarea value={detailsDisplay.summary} onChange={(event) => onUpdatePlan(detailsPlanID!, bilingualPatch(displayLanguage, 'summary', event.currentTarget.value), displayLanguage)} />
              </div>
              <div className="shorts-field wide">
                <div className="shorts-field-head">
                  <span>Hook</span>
                  <button type="button" onClick={() => copyText('hook', detailsDisplay.hook)}>{copiedKey === 'hook' ? '✓' : 'Copy'}</button>
                </div>
                <textarea value={detailsDisplay.hook} onChange={(event) => onUpdatePlan(detailsPlanID!, bilingualPatch(displayLanguage, 'hook', event.currentTarget.value), displayLanguage)} />
              </div>
            </div>
            <div className="shorts-modal-texts">
              <div className="shorts-modal-captions">
                <h4>Rendered caption lines</h4>
                <textarea
                  className="shorts-caption-edit"
                  value={detailsCaptionText}
                  onChange={(event) => onUpdatePlan(detailsPlanID!, captionPatch(displayLanguage, event.currentTarget.value), displayLanguage)}
                />
              </div>
              <div className="shorts-modal-transcripts">
                <div>
                  <h4>Source transcript</h4>
                  <pre>{detailsText.source || 'No source text in this range.'}</pre>
                </div>
                {detailsText.target && (
                  <div>
                    <h4>Target transcript</h4>
                    <pre>{detailsText.target}</pre>
                  </div>
                )}
              </div>
            </div>
            <div className="shorts-modal-actions">
              <button type="button" className="btn-dl btn-dl-secondary" onClick={() => onFindMoments(detailsPlan.languageMode || 'target')}>Find alternatives</button>
              <button type="button" className="btn-dl btn-dl-secondary" onClick={() => { onRemovePlan(detailsPlanID!); setDetailsPlanID(null); }}>Delete clip</button>
              <button
                type="button"
                className="btn-dl btn-dl-secondary"
                disabled={!hasVideo || !previewVideoSrc}
                onClick={() => {
                  if (detailsPlanID) {
                    const selected = detailsPlan && detailsPlan.stableID
                      ? shortsPlanExportLanguages(detailsPlan).some((language) => selectedPlanKeys.has(shortsSelectionKey(detailsPlan.stableID!, language)))
                      : false;
                    if (!selected) onTogglePlan(detailsPlanID);
                    onFocusPlan(detailsPlanID);
                    openEditor(detailsPlanID);
                  }
                }}
              >
                Edit Clip
              </button>
              <button
                type="button"
                className="btn-dl btn-dl-secondary"
                data-testid="send-to-assistant-shorts"
                onClick={() => {
                  assistantStore.queueSelection({
                    source: 'shorts',
                    text: [detailsDisplay.title, detailsDisplay.hook, detailsDisplay.summary].filter(Boolean).join('\n'),
                    label: detailsDisplay.title || 'Shorts clip',
                  });
                  paneStore.setChatSidebar(true);
                }}
              >
                Send to Assistant
              </button>
              <button type="button" className="btn-dl btn-dl-primary" onClick={() => setDetailsPlanID(null)}>Done</button>
            </div>
          </div>
        </div>
      )}

      {editorPlan && (
        <SubtitleAlignmentEditor
          key={`editor-${editorPlanID}`}
          isOpen={editorPlanID !== null}
          title={displayedPlanText(editorPlan, displayLanguage, activeTranslationLanguage).title || 'Clip editor'}
          languageLabel={displayLanguage === 'source' ? 'Source captions' : 'Target captions'}
          videoSrc={previewVideoSrc}
          audioSrc={previewAudioSrc}
          clipStartSec={editorStart?.ok && editorStart.seconds !== null ? editorStart.seconds : Number.NaN}
          clipEndSec={editorEnd?.ok && editorEnd.seconds !== null ? editorEnd.seconds : Number.NaN}
          initialCues={getPlanCues(editorPlan, displayLanguage)}
          initialSegments={displayLanguage === 'source' ? editorPlan.sourceAlignment : editorPlan.targetAlignment}
          initialFrameKeyframes={displayLanguage === 'source' ? editorPlan.sourceFrameKeyframes : editorPlan.targetFrameKeyframes}
          initialCuts={editorPlan.timelineCuts}
          initialTrim={editorPlan.timelineTrim}
          initialBackgroundSettings={editorPlan.backgroundSettings}
          initialLogo={displayLanguage === 'source' ? editorPlan.sourceLogo || editorPlan.logo : editorPlan.targetLogo || editorPlan.logo}
          initialTextTracks={displayLanguage === 'source' ? editorPlan.sourceTextTracks || editorPlan.textTracks : editorPlan.targetTextTracks || editorPlan.textTracks}
          initialAudioTracks={displayLanguage === 'source' ? editorPlan.sourceAudioTracks || editorPlan.audioTracks : editorPlan.targetAudioTracks || editorPlan.audioTracks}
          initialIntro={displayLanguage === 'source' ? editorPlan.sourceIntro || editorPlan.intro : editorPlan.targetIntro || editorPlan.intro}
          initialOutro={displayLanguage === 'source' ? editorPlan.sourceOutro || editorPlan.outro : editorPlan.targetOutro || editorPlan.outro}
          settings={settings}
          subtitleMaxCharsPerLine={subtitleMaxCharsPerLine}
          subtitleMaxLines={subtitleMaxLines}
          onClose={closeEditor}
          onSave={(segments) => {
            if (editorPlanID) {
              onSavePlanAlignment(editorPlanID, displayLanguage, segments);
              const selected = shortsPlanExportLanguages(editorPlan).some((language) => selectedPlanKeys.has(shortsSelectionKey(editorPlanID, language)));
              if (!selected) onTogglePlan(editorPlanID);
            }
          }}
          onDraftChange={(segments) => {
            if (editorPlanID) onSavePlanAlignment(editorPlanID, displayLanguage, segments);
          }}
          onSaveFrameKeyframes={(keyframes) => {
            if (editorPlanID) onSavePlanFrameKeyframes(editorPlanID, displayLanguage, keyframes);
          }}
          onDraftFrameKeyframes={(keyframes) => {
            if (editorPlanID) onSavePlanFrameKeyframes(editorPlanID, displayLanguage, keyframes);
          }}
          onSaveCuts={(cuts) => {
            if (editorPlanID) onUpdatePlan(editorPlanID, { timelineCuts: cuts });
          }}
          onSaveTrim={(trim) => {
            if (editorPlanID) onUpdatePlan(editorPlanID, { timelineTrim: trim });
          }}
          onSaveBackgroundSettings={(bg) => {
            if (editorPlanID) onUpdatePlan(editorPlanID, { backgroundSettings: bg });
          }}
          onSaveLogo={(logo) => {
            if (editorPlanID) onSavePlanLogo?.(editorPlanID, displayLanguage, logo);
          }}
          onSaveTextTracks={(tracks) => {
            if (editorPlanID) onSavePlanTextTracks?.(editorPlanID, displayLanguage, tracks);
          }}
          onSaveAudioTracks={(tracks) => {
            if (editorPlanID) onSavePlanAudioTracks?.(editorPlanID, displayLanguage, tracks);
          }}
          onSaveIntro={(intro) => {
            if (editorPlanID) onSavePlanIntro?.(editorPlanID, displayLanguage, intro);
          }}
          onSaveOutro={(outro) => {
            if (editorPlanID) onSavePlanOutro?.(editorPlanID, displayLanguage, outro);
          }}
          onSettingsChange={onChange}
          onResetAll={() => {
            if (editorPlanID) {
              onUpdatePlan(editorPlanID, {
                sourceAlignment: undefined,
                targetAlignment: undefined,
                sourceFrameKeyframes: [],
                targetFrameKeyframes: [],
                timelineCuts: [],
                timelineTrim: { trimStartSec: 0, trimEndSec: 0 },
                backgroundSettings: defaultBackgroundSettings(),
                sourceLogo: undefined,
                targetLogo: undefined,
                sourceTextTracks: [],
                targetTextTracks: [],
                sourceAudioTracks: [],
                targetAudioTracks: [],
                sourceIntro: undefined,
                targetIntro: undefined,
                sourceOutro: undefined,
                targetOutro: undefined,
              });
            }
          }}
          syncEnabled={Boolean(editorPlan.syncEnabled)}
          hasLinkedPartner={Boolean(editorPlan.linkedClipGroupId)}
          onToggleSync={() => { if (editorPlanID) onToggleClipSync?.(editorPlanID); }}
          onImportMotion={() => { if (editorPlanID) onImportMotion?.(editorPlanID); }}
          currentLanguage={displayLanguage}
          onSwitchLanguage={(lang) => {
            setDisplayLanguage(lang);
          }}
        />
      )}

      <ReplaceClipModal
        isOpen={replacePlanID !== null}
        plan={replacePlanID ? plans.find((item) => item.stableID === replacePlanID) || null : null}
        isBusy={isBusy}
        onClose={() => setReplacePlanID(null)}
        onRegenerate={(start, end) => {
          if (replacePlanID && onReplacePlan) {
            const result = onReplacePlan(replacePlanID, start, end);
            if (result && !result.success) {
              alert(`${result.code}: ${result.message}`);
              return;
            }
            setReplacePlanID(null);
          }
        }}
      />
    </section>
  );
}
