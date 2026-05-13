import React, { useEffect, useRef, useState } from 'react';
import { Edit3 } from 'lucide-react';
import { formatPlaybackClock } from '../lib/karaoke';
import type { ProviderOption } from '../lib/provider-registry';
import {
  ExtraAudioTrack,
  LogoOverlaySettings,
  parseTimestampToSeconds,
  ShortsClipPlan,
  ShortsPlanLanguageMode,
  TextOverlayTrack,
} from '../lib/shorts-reels';
import { defaultBackgroundSettings, ShortsFrameRatePreset, ShortsResolutionPreset, ShortsTextTransform, ShortsVideoFormat, ShortsVideoQuality } from '../lib/shorts-render';
import { SubtitleAlignmentEditor } from './subtitle-alignment/SubtitleAlignmentEditor';
import { ReplaceClipModal } from './ReplaceClipModal';

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
  videoFormat: ShortsVideoFormat;
  resolutionPreset: ShortsResolutionPreset;
  videoQuality: ShortsVideoQuality;
  frameRate: ShortsFrameRatePreset;
};

type Props = {
  hasVideo: boolean;
  hasTranslation: boolean;
  targetLang: string;
  settings: ShortsSettings;
  plans: ShortsClipPlan[];
  isBusy: boolean;
  busyLabel?: string;
  selectedPlanIndex: number | null;
  selectedPlanIndexes: number[];
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
  onFocusPlan: (index: number) => void;
  onTogglePlan: (index: number) => void;
  onUpdatePlan: (index: number, patch: Partial<ShortsClipPlan>) => void;
  onRemovePlan: (index: number) => void;
  onSavePlanAlignment: (index: number, language: ShortsDisplayLanguage, segments: ShortsClipPlan['sourceAlignment']) => void;
  onSavePlanFrameKeyframes: (index: number, language: ShortsDisplayLanguage, keyframes: ShortsClipPlan['sourceFrameKeyframes']) => void;
  onSavePlanLogo?: (index: number, language: ShortsDisplayLanguage, logo?: LogoOverlaySettings) => void;
  onSavePlanTextTracks?: (index: number, language: ShortsDisplayLanguage, tracks: TextOverlayTrack[]) => void;
  onSavePlanAudioTracks?: (index: number, language: ShortsDisplayLanguage, tracks: ExtraAudioTrack[]) => void;
  getPlanCues: (plan: ShortsClipPlan, language?: ShortsDisplayLanguage) => { startSec: number; endSec: number; text: string }[];
  getPlanDetailText: (plan: ShortsClipPlan) => { source: string; target: string };
  onExportIdeas: () => void;
  onExportSelected: () => void;
  onSaveDefaults: () => void;
  onReplacePlan?: (index: number, startTimestamp: string, endTimestamp: string) => void;
  onToggleClipSync?: (index: number) => void;
  onImportMotion?: (index: number) => void;
};

function clipDurationLabel(plan: ShortsClipPlan): string {
  const duration = Math.max(0, Math.round(parseTimestampToSeconds(plan.end) - parseTimestampToSeconds(plan.start)));
  return duration > 0 ? `${duration}s` : '';
}

type ShortsDisplayLanguage = 'source' | 'target';

function displayedPlanText(plan: ShortsClipPlan, language: ShortsDisplayLanguage) {
  if (language === 'source') {
    return {
      title: plan.sourceTitle || (plan.languageMode === 'source' ? plan.title : plan.title),
      summary: plan.sourceSummary || (plan.languageMode === 'source' ? plan.summary : plan.summary),
      hook: plan.sourceHook || (plan.languageMode === 'source' ? plan.hook : plan.hook),
      category: plan.sourceCategory || plan.category || 'clip',
    };
  }
  return {
    title: plan.targetTitle || plan.title,
    summary: plan.targetSummary || plan.summary,
    hook: plan.targetHook || plan.hook,
    category: plan.targetCategory || plan.category || 'clip',
  };
}

function bilingualPatch(language: ShortsDisplayLanguage, field: 'title' | 'summary' | 'hook' | 'category', value: string): Partial<ShortsClipPlan> {
  if (language === 'source') {
    if (field === 'title') return { sourceTitle: value };
    if (field === 'summary') return { sourceSummary: value };
    if (field === 'hook') return { sourceHook: value };
    return { sourceCategory: value };
  }
  if (field === 'title') return { title: value, targetTitle: value };
  if (field === 'summary') return { summary: value, targetSummary: value };
  if (field === 'hook') return { hook: value, targetHook: value };
  return { category: value, targetCategory: value };
}

function captionPatch(language: ShortsDisplayLanguage, value: string): Partial<ShortsClipPlan> {
  if (language === 'source') return { sourceCaptionText: value };
  return { captionText: value, targetCaptionText: value };
}

function captionTextForLanguage(plan: ShortsClipPlan, language: ShortsDisplayLanguage): string | undefined {
  if (language === 'source') return plan.sourceCaptionText;
  return plan.targetCaptionText || plan.captionText;
}

function exportUnitsForPlan(plan: ShortsClipPlan): number {
  return plan.languageMode === 'bilingual' ? 2 : 1;
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
  settings,
  plans,
  isBusy,
  busyLabel,
  selectedPlanIndexes,
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
  onSavePlanAlignment,
  onSavePlanFrameKeyframes,
  onSavePlanLogo,
  onSavePlanTextTracks,
  onSavePlanAudioTracks,
  getPlanCues,
  getPlanDetailText,
  onExportIdeas,
  onExportSelected,
  onSaveDefaults,
  onReplacePlan,
  onToggleClipSync,
  onImportMotion,
}: Props) {
  const [detailsIndex, setDetailsIndex] = useState<number | null>(null);
  const [editorIndex, setEditorIndex] = useState<number | null>(null);
  const [editorSnapshot, setEditorSnapshot] = useState<ShortsClipPlan | null>(null);
  const [replaceIndex, setReplaceIndex] = useState<number | null>(null);
  const [displayLanguage, setDisplayLanguage] = useState<ShortsDisplayLanguage>('target');
  const [copiedKey, setCopiedKey] = useState<string>('');
  const patch = (partial: Partial<ShortsSettings>) => onChange({ ...settings, ...partial });
  const selectedCount = selectedPlanIndexes.length;
  const selectedExportCount = selectedPlanIndexes.reduce((sum, index) => sum + (plans[index] ? exportUnitsForPlan(plans[index]) : 0), 0);
  const detailsPlan = detailsIndex === null ? null : plans[detailsIndex] || null;
  const detailsDisplay = detailsPlan ? displayedPlanText(detailsPlan, displayLanguage) : null;
  const detailsText = detailsPlan ? getPlanDetailText(detailsPlan) : null;
  const detailsCues = detailsPlan ? getPlanCues(detailsPlan, displayLanguage) : [];
  const canUseTarget = hasTranslation;
  const canSwitchLanguage = plans.some((plan) => plan.languageMode === 'bilingual');
  const editorPlan = editorIndex === null ? null : plans[editorIndex] || editorSnapshot;
  const detailsCaptionText = detailsPlan
    ? captionTextForLanguage(detailsPlan, displayLanguage) ?? detailsCues.map((cue) => `[${formatPlaybackClock(parseTimestampToSeconds(detailsPlan.start) + cue.startSec)}] ${cue.text}`).join('\n\n')
    : '';

  const openEditor = (index: number) => {
    setEditorIndex(index);
    setEditorSnapshot(plans[index] || null);
  };

  const closeEditor = () => {
    setEditorIndex(null);
    setEditorSnapshot(null);
  };

  useEffect(() => {
    const mode = plans[0]?.languageMode;
    setDisplayLanguage(mode === 'source' || mode === 'bilingual' ? 'source' : 'target');
  }, [plans.length, plans[0]?.languageMode]);

  useEffect(() => {
    if (editorIndex === null) return;
    const latest = plans[editorIndex];
    if (latest) setEditorSnapshot(latest);
  }, [editorIndex, plans]);

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
        <div className="shorts-card-section">
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

        <div className="shorts-card-section">
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
              const checked = selectedPlanIndexes.includes(index);
              const display = displayedPlanText(plan, displayLanguage);
              return (
                <article key={`${plan.start}-${plan.end}-${index}`} className={`shorts-clip-card ${checked ? 'selected' : 'muted'}`}>
                  <button type="button" className={`shorts-check ${checked ? 'on' : ''}`} onClick={() => onTogglePlan(index)} aria-label={checked ? 'Deselect clip' : 'Select clip'}>
                    {checked ? '✓' : ''}
                  </button>
                  <button type="button" className="shorts-clip-body" onClick={() => { onFocusPlan(index); setDetailsIndex(index); }}>
                    <strong>{display.title}</strong>
                    <span>{plan.start}{' -> '}{plan.end}{clipDurationLabel(plan) ? ` · ${clipDurationLabel(plan)}` : ''}</span>
                    <p>{display.summary}</p>
                    <div className="shorts-chip-row">
                      <small>{display.category || 'clip'}</small>
                      <small>{plan.languageMode || 'target'}</small>
                    </div>
                  </button>
                  <div className="shorts-card-actions">
                    <button type="button" onClick={() => { onFocusPlan(index); setDetailsIndex(index); }}>Details</button>
                    <button type="button" onClick={() => setReplaceIndex(index)}>Replace</button>
                    <button type="button" onClick={() => onRemovePlan(index)}>Delete</button>
                    <button
                      type="button"
                      className="shorts-edit-clip-button"
                      onClick={() => {
                        if (!checked) onTogglePlan(index);
                        onFocusPlan(index);
                        openEditor(index);
                      }}
                      disabled={!hasVideo || !previewVideoSrc}
                    >
                      <Edit3 size={12} /> Edit Clip
                    </button>
                  </div>
                </article>
              );
            })}
          </div>
        </div>

        <div className="shorts-card-section">
          <div className="shorts-step-head"><span>3</span><strong>Export</strong></div>
          <div className="shorts-export-row">
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
          <div className="shorts-export-actions">
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
        <div className="shorts-modal-backdrop" onMouseDown={() => setDetailsIndex(null)}>
          <div className="shorts-modal" onMouseDown={(event) => event.stopPropagation()}>
            <div className="shorts-modal-head">
              <div>
                <h3>Clip details</h3>
                <p>{detailsPlan.start} {' -> '} {detailsPlan.end} · {clipDurationLabel(detailsPlan)} · {detailsPlan.languageMode || 'target'}</p>
              </div>
              <button type="button" onClick={() => setDetailsIndex(null)}>×</button>
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
                <input value={detailsDisplay.title} onChange={(event) => onUpdatePlan(detailsIndex!, bilingualPatch(displayLanguage, 'title', event.currentTarget.value))} />
              </div>
              <div className="shorts-field">
                <div className="shorts-field-head">
                  <span>Category</span>
                </div>
                <input value={detailsDisplay.category || ''} onChange={(event) => onUpdatePlan(detailsIndex!, bilingualPatch(displayLanguage, 'category', event.currentTarget.value))} />
              </div>
              <div className="shorts-field wide">
                <div className="shorts-field-head">
                  <span>Description</span>
                  <button type="button" onClick={() => copyText('summary', detailsDisplay.summary)}>{copiedKey === 'summary' ? '✓' : 'Copy'}</button>
                </div>
                <textarea value={detailsDisplay.summary} onChange={(event) => onUpdatePlan(detailsIndex!, bilingualPatch(displayLanguage, 'summary', event.currentTarget.value))} />
              </div>
              <div className="shorts-field wide">
                <div className="shorts-field-head">
                  <span>Hook</span>
                  <button type="button" onClick={() => copyText('hook', detailsDisplay.hook)}>{copiedKey === 'hook' ? '✓' : 'Copy'}</button>
                </div>
                <textarea value={detailsDisplay.hook} onChange={(event) => onUpdatePlan(detailsIndex!, bilingualPatch(displayLanguage, 'hook', event.currentTarget.value))} />
              </div>
            </div>
            <div className="shorts-modal-texts">
              <div className="shorts-modal-captions">
                <h4>Rendered caption lines</h4>
                <textarea
                  className="shorts-caption-edit"
                  value={detailsCaptionText}
                  onChange={(event) => onUpdatePlan(detailsIndex!, captionPatch(displayLanguage, event.currentTarget.value))}
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
              <button type="button" className="btn-dl btn-dl-secondary" onClick={() => { onRemovePlan(detailsIndex!); setDetailsIndex(null); }}>Delete clip</button>
              <button
                type="button"
                className="btn-dl btn-dl-secondary"
                disabled={!hasVideo || !previewVideoSrc}
                onClick={() => {
                  if (detailsIndex !== null) {
                    if (!selectedPlanIndexes.includes(detailsIndex)) onTogglePlan(detailsIndex);
                    onFocusPlan(detailsIndex);
                    openEditor(detailsIndex);
                  }
                }}
              >
                Edit Clip
              </button>
              <button type="button" className="btn-dl btn-dl-primary" onClick={() => setDetailsIndex(null)}>Done</button>
            </div>
          </div>
        </div>
      )}

      {editorPlan && (
        <SubtitleAlignmentEditor
          key={`editor-${editorIndex}-${displayLanguage}`}
          isOpen={editorIndex !== null}
          title={displayedPlanText(editorPlan, displayLanguage).title || 'Clip editor'}
          languageLabel={displayLanguage === 'source' ? 'Source captions' : 'Target captions'}
          videoSrc={previewVideoSrc}
          audioSrc={previewAudioSrc}
          audioPath={previewAudioPath}
          clipStartSec={parseTimestampToSeconds(editorPlan.start)}
          clipEndSec={parseTimestampToSeconds(editorPlan.end)}
          initialCues={getPlanCues(editorPlan, displayLanguage)}
          initialSegments={displayLanguage === 'source' ? editorPlan.sourceAlignment : editorPlan.targetAlignment}
          initialFrameKeyframes={displayLanguage === 'source' ? editorPlan.sourceFrameKeyframes : editorPlan.targetFrameKeyframes}
          initialCuts={editorPlan.timelineCuts}
          initialTrim={editorPlan.timelineTrim}
          initialBackgroundSettings={editorPlan.backgroundSettings}
          initialLogo={displayLanguage === 'source' ? editorPlan.sourceLogo || editorPlan.logo : editorPlan.targetLogo || editorPlan.logo}
          initialTextTracks={displayLanguage === 'source' ? editorPlan.sourceTextTracks || editorPlan.textTracks : editorPlan.targetTextTracks || editorPlan.textTracks}
          initialAudioTracks={displayLanguage === 'source' ? editorPlan.sourceAudioTracks || editorPlan.audioTracks : editorPlan.targetAudioTracks || editorPlan.audioTracks}
          settings={settings}
          subtitleMaxCharsPerLine={subtitleMaxCharsPerLine}
          subtitleMaxLines={subtitleMaxLines}
          onClose={closeEditor}
          onSave={(segments) => {
            if (editorIndex !== null) {
              onSavePlanAlignment(editorIndex, displayLanguage, segments);
              if (!selectedPlanIndexes.includes(editorIndex)) onTogglePlan(editorIndex);
            }
          }}
          onDraftChange={(segments) => {
            if (editorIndex !== null) {
              onSavePlanAlignment(editorIndex, displayLanguage, segments);
            }
          }}
          onSaveFrameKeyframes={(keyframes) => {
            if (editorIndex !== null) {
              onSavePlanFrameKeyframes(editorIndex, displayLanguage, keyframes);
            }
          }}
          onDraftFrameKeyframes={(keyframes) => {
            if (editorIndex !== null) {
              onSavePlanFrameKeyframes(editorIndex, displayLanguage, keyframes);
            }
          }}
          onSaveCuts={(cuts) => {
            if (editorIndex !== null) onUpdatePlan(editorIndex, { timelineCuts: cuts });
          }}
          onSaveTrim={(trim) => {
            if (editorIndex !== null) onUpdatePlan(editorIndex, { timelineTrim: trim });
          }}
          onSaveBackgroundSettings={(bg) => {
            if (editorIndex !== null) onUpdatePlan(editorIndex, { backgroundSettings: bg });
          }}
          onSaveLogo={(logo) => {
            if (editorIndex !== null) onSavePlanLogo?.(editorIndex, displayLanguage, logo);
          }}
          onSaveTextTracks={(tracks) => {
            if (editorIndex !== null) onSavePlanTextTracks?.(editorIndex, displayLanguage, tracks);
          }}
          onSaveAudioTracks={(tracks) => {
            if (editorIndex !== null) onSavePlanAudioTracks?.(editorIndex, displayLanguage, tracks);
          }}
          onSettingsChange={onChange}
          onResetAll={() => {
            if (editorIndex !== null) {
              onUpdatePlan(editorIndex, {
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
              });
            }
          }}
          syncEnabled={editorIndex !== null ? plans[editorIndex]?.syncEnabled : false}
          hasLinkedPartner={editorIndex !== null ? !!plans[editorIndex]?.linkedClipGroupId : false}
          onToggleSync={() => { if (editorIndex !== null) onToggleClipSync?.(editorIndex); }}
          onImportMotion={() => { if (editorIndex !== null) onImportMotion?.(editorIndex); }}
          currentLanguage={displayLanguage}
          onSwitchLanguage={(lang) => {
            setDisplayLanguage(lang);
          }}
        />
      )}

      <ReplaceClipModal
        isOpen={replaceIndex !== null}
        plan={replaceIndex !== null ? plans[replaceIndex] || null : null}
        isBusy={isBusy}
        onClose={() => setReplaceIndex(null)}
        onRegenerate={(start, end) => {
          if (replaceIndex !== null && onReplacePlan) {
            onReplacePlan(replaceIndex, start, end);
            setReplaceIndex(null);
          }
        }}
      />
    </section>
  );
}
