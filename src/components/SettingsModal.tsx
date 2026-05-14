import React, { useState, useCallback, useEffect, useRef } from 'react';
import { AppSettings, UsageStats } from '../types';
import { DEFAULT_SETTINGS, saveUsage } from '../services/storage';
import { X, Eye, EyeOff, Download, Trash2, RefreshCw, Upload, Plus, CheckCircle2, ExternalLink } from 'lucide-react';
import { getAvailableTranscriptionProviders, getAvailableTranslationProviders, ProviderOption } from '../lib/provider-registry';
import { createGlossaryEntry } from '../lib/glossary';
import { filterGlossaryEntries, GlossarySortMode, joinGlossaryEntries, listGlossaryCategories, sortGlossaryEntries } from '../lib/glossary-management';
import { PROMPT_DEFINITIONS, PROMPT_SLOTS, type PromptPresetId, type PromptSlot } from '../lib/prompt-presets';

const TABS = ['API Keys', 'Models', 'Appearance', 'Glossary', 'Chunking', 'Transcription', 'Prompts', 'Statistics'];

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="s-field">
      <span className="s-label">{label}</span>
      {children}
    </div>
  );
}

function ApiKey({ label, value, onChange, placeholder }: { label: string; value: string; onChange: (v: string) => void; placeholder?: string }) {
  const [show, setShow] = useState(false);
  return (
    <Field label={label}>
      <div className="s-input-wrap">
        <input
          type={show ? 'text' : 'password'}
          className="s-input"
          value={value}
          onChange={e => onChange(e.target.value)}
          placeholder={placeholder}
        />
        <button className="s-eye" onClick={() => setShow(p => !p)}>
          {show ? <EyeOff size={14} /> : <Eye size={14} />}
        </button>
      </div>
    </Field>
  );
}

interface Props { settings: AppSettings; usage: UsageStats; onSave: (s: AppSettings) => void; onClose: () => void; }

const CLOUD_API_PROVIDERS = [
  {
    id: 'gemini-cloud',
    name: 'Google Gemini',
    description: 'Gemini API key for cloud transcription, translation, and editing.',
    model: 'gemini-2.5-flash',
    keyField: 'geminiKey',
    budgetField: 'geminiBudgetUsd',
    keyUrl: 'https://aistudio.google.com/apikey',
  },
  {
    id: 'gpt-cloud',
    name: 'OpenAI',
    description: 'OpenAI API key for cloud transcription, translation, and editing.',
    model: 'gpt-4o-mini / whisper-1',
    keyField: 'openaiKey',
    budgetField: 'openaiBudgetUsd',
    keyUrl: 'https://platform.openai.com/api-keys',
  },
] as const;

const CLOUD_USAGE_ESTIMATES: Record<string, { inputPerMillion: number; outputPerMillion: number }> = {
  'gemini-cloud': { inputPerMillion: 0.3, outputPerMillion: 2.5 },
  'gpt-cloud': { inputPerMillion: 2.5, outputPerMillion: 10 },
};

function providerDisplayName(providerId: string): string {
  if (providerId === 'gemini-cloud') return 'Google Gemini 2.5 Flash';
  if (providerId === 'gpt-cloud') return 'OpenAI GPT Cloud';
  return providerId;
}

function estimateUsageCost(providerId: string, stats: UsageStats[string]): number {
  const estimate = CLOUD_USAGE_ESTIMATES[providerId];
  if (!estimate) return 0;
  return ((stats.inputTokens * estimate.inputPerMillion) + (stats.outputTokens * estimate.outputPerMillion)) / 1_000_000;
}

function renderTranslationRows(translations: Record<string, string>): string {
  return Object.entries(translations)
    .map(([lang, value]) => `${lang === 'Default' ? 'Current target' : lang}: ${value}`)
    .join('\n');
}

function parseTranslationRows(value: string): Record<string, string> {
  return Object.fromEntries(
    value
      .split(/\n/)
      .map((line) => line.trim())
      .filter(Boolean)
      .map((line) => {
        const separator = line.indexOf(':');
        if (separator < 0) return ['Default', line];
        const label = line.slice(0, separator).trim();
        return [label.toLowerCase() === 'current target' ? 'Default' : label, line.slice(separator + 1).trim()];
      })
      .filter(([lang, text]) => lang && text)
  );
}

function renderProviderOptions(options: ProviderOption[]) {
  const cloud = options.filter((option) => option.group === 'cloud');
  const local = options.filter((option) => option.group === 'local');

  return (
    <>
      {cloud.length > 0 && (
        <optgroup label="Cloud">
          {cloud.map((option) => (
            <option key={option.id} value={option.id}>{option.label}</option>
          ))}
        </optgroup>
      )}
      {local.length > 0 && (
        <optgroup label="Local">
          {local.map((option) => (
            <option key={option.id} value={option.id}>{option.label}</option>
          ))}
        </optgroup>
      )}
    </>
  );
}

export function SettingsModal({ settings, usage, onSave, onClose }: Props) {
  const [s, setS] = useState<AppSettings>({ ...settings });
  const [tab, setTab] = useState(0);
  const [glossarySearch, setGlossarySearch] = useState('');
  const [glossaryCategory, setGlossaryCategory] = useState('all');
  const [glossarySort, setGlossarySort] = useState<GlossarySortMode>('newest');
  const [selectedGlossaryIds, setSelectedGlossaryIds] = useState<string[]>([]);
  const [selectedPromptId, setSelectedPromptId] = useState<PromptPresetId>('transcriptionSystem');
  const downloadSnapshotsRef = useRef<Record<string, { bytes: number; unchangedTicks: number }>>({});
  const upd = (p: Partial<AppSettings>) => setS(prev => ({ ...prev, ...p }));
  const transcriptionProviders = getAvailableTranscriptionProviders(s);
  const translationTargetForModelSelection = s.defaultTargetLang === 'same' ? 'Russian' : s.defaultTargetLang;
  const translationAvailability = getAvailableTranslationProviders(s, translationTargetForModelSelection);
  const latestUsage = Object.entries(usage).sort(([, a], [, b]) => {
    return new Date(b.lastUsed || 0).getTime() - new Date(a.lastUsed || 0).getTime();
  })[0];
  const glossaryCategories = listGlossaryCategories(s.glossary);
  const visibleGlossary = sortGlossaryEntries(filterGlossaryEntries(s.glossary, glossarySearch, glossaryCategory), glossarySort);
  const promptStages = Array.from(new Set(PROMPT_DEFINITIONS.map((definition) => definition.stage)));
  const selectedPrompt = PROMPT_DEFINITIONS.find((definition) => definition.id === selectedPromptId) ?? PROMPT_DEFINITIONS[0];
  const selectedPromptSettings = s.promptPresets[selectedPrompt.id];
  const activePromptSlot = selectedPromptSettings?.active ?? 'default';

  const updatePromptPreset = useCallback((id: PromptPresetId, patch: Partial<AppSettings['promptPresets'][PromptPresetId]>) => {
    setS((prev) => ({
      ...prev,
      promptPresets: {
        ...prev.promptPresets,
        [id]: {
          ...prev.promptPresets[id],
          ...patch,
          custom: {
            ...prev.promptPresets[id].custom,
            ...(patch.custom ?? {}),
          },
        },
      },
    }));
  }, []);

  const persistSettings = useCallback((next: AppSettings) => {
    setS(next);
    onSave(next);
  }, [onSave]);

  const selectProvider = useCallback((kind: 'asr' | 'translation', providerId: string) => {
    const next = {
      ...s,
      [kind === 'asr' ? 'transcriptionProvider' : 'translationProvider']: providerId,
    } as AppSettings;
    persistSettings(next);
  }, [persistSettings, s]);

  const openExternal = useCallback((url: string) => {
    if (window.electronAPI?.openExternal) {
      void window.electronAPI.openExternal(url);
    } else {
      window.open(url, '_blank', 'noopener,noreferrer');
    }
  }, []);

  const updateApiKey = useCallback((field: 'geminiKey' | 'openaiKey', value: string) => {
    upd({ [field]: value } as Partial<AppSettings>);
  }, []);

  const updateApiBudget = useCallback((field: 'geminiBudgetUsd' | 'openaiBudgetUsd', value: string) => {
    const amount = Math.max(0, Number(value) || 0);
    upd({ [field]: amount } as Partial<AppSettings>);
  }, []);

  const updateLocalModelState = useCallback((
    kind: 'asr' | 'translation',
    modelId: string,
    patch: Record<string, any>
  ) => {
    setS((prev) => {
      const key = kind === 'asr' ? 'localAsrModels' : 'localTranslationModels';
      return {
        ...prev,
        [key]: {
          ...prev[key],
          [modelId]: {
            ...prev[key][modelId],
            ...patch,
          },
        },
      };
    });
  }, []);

  useEffect(() => {
    if (!window.electronAPI?.onLocalModelDownloadProgress) return;

    return window.electronAPI.onLocalModelDownloadProgress((payload) => {
      const progressLabel = payload.runtime === 'parakeet'
        ? payload.total
          ? `${payload.percent}% · file ${payload.currentFile ?? 0}/${payload.totalFiles ?? 0} · ${Math.max(0, Math.round((payload.received ?? 0) / 1024 / 1024))} / ${Math.max(0, Math.round((payload.total ?? 0) / 1024 / 1024))} MB`
          : payload.totalFiles
          ? `${payload.percent}% · file ${payload.currentFile ?? 0}/${payload.totalFiles}`
          : `${payload.percent}%`
        : payload.total
          ? `${payload.percent}% · ${Math.max(0, Math.round((payload.received ?? 0) / 1024 / 1024))} / ${Math.max(0, Math.round((payload.total ?? 0) / 1024 / 1024))} MB`
          : `${payload.percent}%`;

      updateLocalModelState(payload.kind, payload.modelId, {
        status: 'downloading',
        progress: Math.max(0, Math.min(1, payload.percent / 100)),
        progressLabel,
      });
    });
  }, [updateLocalModelState]);

  useEffect(() => {
    if (!window.electronAPI?.localGetModelDownloadStatus) return;

    const activeDownloads = [
      ...Object.entries(s.localAsrModels).map(([modelId, state]) => ({ kind: 'asr' as const, modelId, state })),
      ...Object.entries(s.localTranslationModels).map(([modelId, state]) => ({ kind: 'translation' as const, modelId, state })),
    ].filter(({ state }) => state.status === 'downloading');

    if (activeDownloads.length === 0) {
      downloadSnapshotsRef.current = {};
      return;
    }

    const formatDownloadedLabel = (snapshot: {
      kind: 'asr' | 'translation';
      modelId: string;
      bytesDownloaded?: number;
      completedFiles?: number;
      totalFiles?: number;
      currentFileName?: string | null;
    }, stalled: boolean) => {
      const downloadedMb = Math.max(0, Math.round((snapshot.bytesDownloaded ?? 0) / 1024 / 1024));
      const parts = [`Downloaded ${downloadedMb} MB`];
      if (typeof snapshot.completedFiles === 'number' && typeof snapshot.totalFiles === 'number') {
        parts.push(`files ${snapshot.completedFiles}/${snapshot.totalFiles}`);
      }
      if (stalled) {
        parts.push('waiting for network...');
      }
      return parts.join(' · ');
    };

    let cancelled = false;
    const poll = async () => {
      const results = await Promise.all(activeDownloads.map(async ({ kind, modelId, state }) => {
        const snapshot = await window.electronAPI?.localGetModelDownloadStatus({ kind, modelId });
        return { kind, modelId, state, snapshot };
      }));

      if (cancelled) return;

      for (const { kind, modelId, state, snapshot } of results) {
        if (!snapshot?.ok) continue;

        if (snapshot.status === 'downloaded') {
          updateLocalModelState(kind, modelId, {
            status: 'downloaded',
            progress: 1,
            progressLabel: 'Download complete',
            error: undefined,
          });
          delete downloadSnapshotsRef.current[`${kind}:${modelId}`];
          continue;
        }

        if (snapshot.status !== 'downloading') continue;

        const key = `${kind}:${modelId}`;
        const previous = downloadSnapshotsRef.current[key];
        const bytesDownloaded = snapshot.bytesDownloaded ?? 0;
        const unchangedTicks = previous && previous.bytes === bytesDownloaded ? previous.unchangedTicks + 1 : 0;
        downloadSnapshotsRef.current[key] = { bytes: bytesDownloaded, unchangedTicks };

        const stalled = unchangedTicks >= 5;
        updateLocalModelState(kind, modelId, {
          status: 'downloading',
          progress: state.progress,
          progressLabel: formatDownloadedLabel(snapshot, stalled),
        });
      }
    };

    void poll();
    const timer = window.setInterval(() => { void poll(); }, 1000);
    return () => {
      cancelled = true;
      window.clearInterval(timer);
    };
  }, [s.localAsrModels, s.localTranslationModels, updateLocalModelState]);

  const installLocalModel = useCallback(async (kind: 'asr' | 'translation', modelId: string) => {
    updateLocalModelState(kind, modelId, { status: 'downloading', error: undefined, progress: 0, progressLabel: 'Starting download...' });

    try {
      const result = kind === 'asr'
        ? await window.electronAPI?.localInstallAsrModel({ modelId })
        : await window.electronAPI?.localInstallTranslationModel({ modelId });

      if (!result?.ok) {
        throw new Error(result?.error || 'Model install failed.');
      }

      const next = {
        ...s,
        [kind === 'asr' ? 'localAsrModels' : 'localTranslationModels']: {
          ...s[kind === 'asr' ? 'localAsrModels' : 'localTranslationModels'],
          [modelId]: {
            ...s[kind === 'asr' ? 'localAsrModels' : 'localTranslationModels'][modelId],
            status: 'downloaded',
            path: result.path ?? null,
            error: undefined,
            progress: 1,
            progressLabel: undefined,
          },
        },
      } as AppSettings;

      persistSettings(next);
    } catch (error: any) {
      updateLocalModelState(kind, modelId, {
        status: 'failed',
        error: error?.message ?? String(error),
        progress: undefined,
        progressLabel: undefined,
      });
    }
  }, [persistSettings, s, updateLocalModelState]);

  const removeLocalModel = useCallback(async (kind: 'asr' | 'translation', modelId: string) => {
    try {
      const result = kind === 'asr'
        ? await window.electronAPI?.localRemoveAsrModel({ modelId })
        : await window.electronAPI?.localRemoveTranslationModel({ modelId });

      if (!result?.ok) {
        throw new Error(result?.error || 'Model removal failed.');
      }

      const current = s[kind === 'asr' ? 'localAsrModels' : 'localTranslationModels'][modelId];
      let next = {
        ...s,
        [kind === 'asr' ? 'localAsrModels' : 'localTranslationModels']: {
          ...s[kind === 'asr' ? 'localAsrModels' : 'localTranslationModels'],
          [modelId]: {
            ...current,
            status: 'not_downloaded',
            path: null,
            error: undefined,
            progress: undefined,
            progressLabel: undefined,
          },
        },
      } as AppSettings;

      if (kind === 'asr' && next.transcriptionProvider === modelId) {
        next = {
          ...next,
          transcriptionProvider: getAvailableTranscriptionProviders(next)[0]?.id ?? '',
        };
      }

      if (kind === 'translation' && next.translationProvider === modelId) {
        next = {
          ...next,
          translationProvider: getAvailableTranslationProviders(next, next.defaultTargetLang).providers[0]?.id ?? '',
        };
      }

      persistSettings(next);
    } catch (error: any) {
      updateLocalModelState(kind, modelId, {
        status: 'failed',
        error: error?.message ?? String(error),
      });
    }
  }, [persistSettings, s, updateLocalModelState]);

  const updateGlossaryEntry = useCallback((id: string, patch: Record<string, any>) => {
    setS((prev) => ({
      ...prev,
      glossary: prev.glossary.map((entry) => entry.id === id ? { ...entry, ...patch, updatedAt: new Date().toISOString() } : entry),
    }));
  }, []);

  const addGlossaryEntry = useCallback(() => {
    setS((prev) => ({
      ...prev,
      glossary: [
        createGlossaryEntry({ variants: [], source: '', translation: '', remember: true }),
        ...prev.glossary,
      ],
    }));
  }, []);

  const deleteGlossaryEntry = useCallback((id: string) => {
    setS((prev) => ({
      ...prev,
      glossary: prev.glossary.filter((entry) => entry.id !== id),
    }));
    setSelectedGlossaryIds((ids) => ids.filter((selectedId) => selectedId !== id));
  }, []);

  const joinSelectedGlossary = useCallback(() => {
    if (selectedGlossaryIds.length < 2) return;
    setS((prev) => ({
      ...prev,
      glossary: joinGlossaryEntries(prev.glossary, selectedGlossaryIds),
    }));
    setSelectedGlossaryIds([]);
  }, [selectedGlossaryIds]);

  const updateGlossaryTranslations = useCallback((id: string, value: string) => {
    const translations = parseTranslationRows(value);
    updateGlossaryEntry(id, { translations, translation: translations.Russian || translations.Default || Object.values(translations)[0] || '' });
  }, [updateGlossaryEntry]);

  const exportGlossary = useCallback(async () => {
    const filePath = await window.electronAPI?.saveFile({
      defaultName: 'vaniscript-glossary.json',
      filters: [{ name: 'JSON', extensions: ['json'] }],
    });
    if (!filePath) return;
    await window.electronAPI?.writeFile({
      filePath,
      content: JSON.stringify({ format: 'vaniscript-glossary-v1', exportedAt: new Date().toISOString(), entries: s.glossary }, null, 2),
    });
  }, [s.glossary]);

  const importGlossary = useCallback(async () => {
    const filePath = await window.electronAPI?.openGenericFile({
      filters: [{ name: 'JSON', extensions: ['json'] }, { name: 'All Files', extensions: ['*'] }],
    });
    if (!filePath) return;
    const result = await window.electronAPI?.readTextFile({ filePath });
    if (!result?.success || !result.content) {
      alert(result?.error || 'Could not read glossary file.');
      return;
    }
    try {
      const parsed = JSON.parse(result.content);
      const entries = Array.isArray(parsed) ? parsed : parsed.entries;
      if (!Array.isArray(entries)) throw new Error('No glossary entries found.');
      setS((prev) => ({
        ...prev,
        glossary: entries.map((entry: any) => ({
          id: entry.id || `glossary-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
          variants: Array.isArray(entry.variants) ? entry.variants : [],
          source: String(entry.source || ''),
          translation: String(entry.translation || ''),
          category: String(entry.category || ''),
          translations: entry.translations && typeof entry.translations === 'object'
            ? entry.translations
            : entry.translation ? { Default: String(entry.translation) } : {},
          remember: entry.remember !== false,
          createdAt: entry.createdAt || new Date().toISOString(),
          updatedAt: entry.updatedAt || new Date().toISOString(),
        })),
      }));
    } catch (error: any) {
      alert(error?.message || 'Invalid glossary JSON.');
    }
  }, []);

  const renderLocalModels = (
    kind: 'asr' | 'translation',
    models: AppSettings['localAsrModels'] | AppSettings['localTranslationModels']
  ) => (
    <div className="s-card" style={{ gap: 10 }}>
      {Object.entries(models).filter(([, state]) => Boolean(state?.label)).map(([modelId, state]) => {
        const progressPercent = Math.max(0, Math.min(100, Math.round((state.progress ?? 0) * 100)));
        const activeProvider = kind === 'asr' ? s.transcriptionProvider : s.translationProvider;
        const isActive = activeProvider === modelId;
        const statusText = state.status === 'downloaded'
          ? isActive ? 'Downloaded · Active' : 'Downloaded'
          : state.status === 'downloading'
            ? (state.progressLabel || 'Downloading...')
            : state.status === 'failed'
              ? `Failed: ${state.error || 'Unknown error'}`
              : 'Not downloaded';

        return (
          <div key={modelId} className="s-stats-item" style={{ marginBottom: 0 }}>
            <div className="s-stats-header" style={{ alignItems: 'flex-start', gap: 12 }}>
              <div style={{ flex: 1 }}>
                <div className="s-stats-name">{state.label}</div>
                <div style={{ fontSize: 11, color: 'rgba(255,255,255,0.35)', marginTop: 4, minHeight: 16, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>
                  {statusText}
                </div>
              </div>
              {state.status === 'downloaded' ? (
                <div className="model-card-actions">
                  {isActive ? (
                    <button className="btn-selected-sm" disabled>
                      <CheckCircle2 size={14} /> Selected
                    </button>
                  ) : (
                    <button className="btn-ghost-sm" onClick={() => selectProvider(kind, modelId)}>
                      <CheckCircle2 size={14} /> Use
                    </button>
                  )}
                  <button className="btn-ghost-sm" onClick={() => removeLocalModel(kind, modelId)}>
                    <Trash2 size={14} /> Remove
                  </button>
                </div>
              ) : state.status === 'downloading' ? (
                <button
                  className="btn-save"
                  disabled
                  style={{
                    position: 'relative',
                    overflow: 'hidden',
                    width: 168,
                    minWidth: 168,
                    maxWidth: 168,
                    height: 34,
                    justifyContent: 'center',
                    borderColor: 'rgba(255,176,32,0.28)',
                    background: 'rgba(255,255,255,0.04)',
                  }}
                >
                  <div
                    style={{
                      position: 'absolute',
                      inset: 0,
                      width: `${Math.max(4, progressPercent)}%`,
                      background: 'linear-gradient(90deg, rgba(255,176,32,0.95) 0%, rgba(255,217,120,0.95) 100%)',
                      transition: 'none',
                    }}
                  />
                  <span style={{ position: 'relative', zIndex: 1, color: '#121212', fontWeight: 700, fontVariantNumeric: 'tabular-nums' }}>
                    Downloading... {progressPercent}%
                  </span>
                </button>
              ) : (
                <button
                  className="btn-save"
                  onClick={() => installLocalModel(kind, modelId)}
                >
                  {state.status === 'failed' ? <RefreshCw size={14} /> : <Download size={14} />}
                  {state.status === 'failed' ? 'Retry' : 'Download'}
                </button>
              )}
            </div>
          </div>
        );
      })}
    </div>
  );

  return (
    <div className="modal-overlay" onClick={e => e.target === e.currentTarget && onClose()}>
      <div className="modal">
        <div className="modal-header">
          <h2>⚙️ Settings</h2>
          <button className="modal-close" onClick={onClose}><X size={16} /></button>
        </div>

        <div className="modal-tabs">
          {TABS.map((t, i) => (
            <button key={t} className={`modal-tab ${tab === i ? 'active' : ''}`} onClick={() => setTab(i)}>{t}</button>
          ))}
        </div>

        <div className="modal-body">

          {/* API Keys */}
          {tab === 0 && (
            <div className="s-section">
              <div className="api-provider-list">
                {CLOUD_API_PROVIDERS.map((provider) => {
                  const keyValue = String(s[provider.keyField] ?? '');
                  const hasKey = keyValue.trim().length > 0;
                  const usedForTranscription = s.transcriptionProvider === provider.id;
                  const usedForTranslation = s.translationProvider === provider.id;
                  const stats = usage[provider.id];
                  const spent = stats ? estimateUsageCost(provider.id, stats) : 0;
                  const budget = Number(s[provider.budgetField] ?? 0);
                  const remaining = Math.max(0, budget - spent);

                  return (
                    <div key={provider.id} className="api-provider-card">
                      <div className="api-provider-head">
                        <div>
                          <div className="api-provider-title">
                            {provider.name}
                            {(usedForTranscription || usedForTranslation) && (
                              <span className="s-badge">
                                {[
                                  usedForTranscription ? 'Transcribing' : '',
                                  usedForTranslation ? 'Translation' : '',
                                ].filter(Boolean).join(' + ')}
                              </span>
                            )}
                          </div>
                          <p className="api-provider-desc">{provider.description}</p>
                        </div>
                        <button className="btn-ghost-sm" onClick={() => openExternal(provider.keyUrl)}>
                          <ExternalLink size={14} /> Get API Key
                        </button>
                      </div>

                      <div className="api-provider-grid">
                        <ApiKey
                          label="API key"
                          value={keyValue}
                          onChange={(value) => updateApiKey(provider.keyField, value)}
                          placeholder={provider.id === 'gemini-cloud' ? 'AIza...' : 'sk-...'}
                        />
                        <Field label="Text model">
                          <input className="s-input api-readonly-input" value={provider.model} readOnly />
                        </Field>
                        <Field label="API budget, USD">
                          <input
                            className="s-input"
                            type="number"
                            min={0}
                            step={1}
                            value={budget || ''}
                            onChange={(event) => updateApiBudget(provider.budgetField, event.target.value)}
                            placeholder="0"
                          />
                        </Field>
                      </div>

                      <div className="api-provider-actions">
                        <button
                          className={usedForTranscription ? 'btn-selected-sm' : 'btn-ghost-sm'}
                          disabled={!hasKey}
                          onClick={() => selectProvider('asr', provider.id)}
                        >
                          <CheckCircle2 size={14} /> {usedForTranscription ? 'Used for Transcribing' : 'Use for Transcribing'}
                        </button>
                        <button
                          className={usedForTranslation ? 'btn-selected-sm' : 'btn-ghost-sm'}
                          disabled={!hasKey}
                          onClick={() => selectProvider('translation', provider.id)}
                        >
                          <CheckCircle2 size={14} /> {usedForTranslation ? 'Used for Translation' : 'Use for Translation'}
                        </button>
                        <div className="api-budget-mini">
                          <span>Spent est. ${spent.toFixed(4)}</span>
                          {budget > 0 && <span>Remaining est. ${remaining.toFixed(2)}</span>}
                        </div>
                      </div>
                    </div>
                  );
                })}
              </div>
              <p style={{ fontSize: 11, color: 'rgba(255,255,255,0.25)', marginTop: 10, lineHeight: 1.6 }}>
                Keys are stored locally and never sent anywhere except the respective API provider.
              </p>
            </div>
          )}

          {/* Models */}
          {tab === 1 && (
            <div>
              <div className="s-section">
                <p className="s-section-title">Transcription</p>
                <div className="s-card">
                  <Field label="Active Provider">
                    <select className="s-input s-select" value={s.transcriptionProvider} onChange={e => selectProvider('asr', e.target.value)}>
                      {transcriptionProviders.length > 0 ? renderProviderOptions(transcriptionProviders) : <option value="">No models available</option>}
                    </select>
                  </Field>
                </div>
                <p className="s-section-title" style={{ marginTop: 14 }}>Local ASR Models</p>
                {renderLocalModels('asr', s.localAsrModels)}
              </div>
              <div className="s-section">
                <p className="s-section-title">Translation</p>
                <div className="s-card">
                  <Field label="Active Provider">
                    <select
	                      className="s-input s-select"
	                      value={s.translationProvider}
	                      onChange={e => selectProvider('translation', e.target.value)}
	                    >
	                      {translationAvailability.providers.length > 0 ? (
	                        renderProviderOptions(translationAvailability.providers)
	                      ) : (
                        <option value="">No models available</option>
                      )}
                    </select>
                  </Field>
                </div>
                <p className="s-section-title" style={{ marginTop: 14 }}>Local Translation Models</p>
                {renderLocalModels('translation', s.localTranslationModels)}
              </div>
            </div>
          )}

          {/* Appearance */}
          {tab === 2 && (
            <div>
              <div className="s-section">
                <p className="s-section-title">Color Theme</p>
                <div className="s-theme-grid">
                  {(['dark', 'light'] as const).map(t => (
                    <button key={t} className={`s-theme-btn ${s.theme === t ? 'active' : ''}`} onClick={() => upd({ theme: t })}>
                      <span className="emoji">{t === 'dark' ? '🌙' : '☀️'}</span>
                      <span className="name">{t === 'dark' ? 'Dark' : 'Light'}</span>
                    </button>
                  ))}
                </div>
              </div>
              <div className="s-section">
                <p className="s-section-title">Reading Font</p>
                <div className="s-card">
                  <Field label="Font Family">
                    <select className="s-input s-select" value={s.fontFamily} onChange={e => upd({ fontFamily: e.target.value as any })}>
                      <option value="mono">JetBrains Mono - technical</option>
                      <option value="sans">Inter - neutral</option>
                      <option value="serif">Georgia - editorial</option>
                    </select>
                  </Field>
                  <div>
                    <div className="s-slider-row">
                      <span className="s-label">Interface Font Scale</span>
                      <span className="s-badge">{Math.round((s.fontScale ?? 1) * 100)}%</span>
                    </div>
                    <input type="range" min={0.85} max={1.35} step={0.05} value={s.fontScale ?? 1} onChange={e => upd({ fontScale: Number(e.target.value) })} />
                    <div className="s-range-labels"><span>85%</span><span>135%</span></div>
                  </div>
                </div>
              </div>
            </div>
          )}

          {/* Glossary */}
          {tab === 3 && (
            <div>
              <div className="s-section">
                <div className="s-stats-header" style={{ marginBottom: 12 }}>
                  <p className="s-section-title" style={{ margin: 0 }}>Glossary</p>
                  <div style={{ display: 'flex', gap: 8 }}>
                    <button className="btn-ghost-sm" onClick={importGlossary}><Upload size={14} /> Import JSON</button>
                    <button className="btn-ghost-sm" onClick={exportGlossary}><Download size={14} /> Export JSON</button>
                    <button className="btn-save" onClick={addGlossaryEntry}><Plus size={14} /> Add</button>
                  </div>
                </div>
                <div className="glossary-toolbar">
                  <input
                    className="s-input"
                    value={glossarySearch}
                    onChange={(event) => setGlossarySearch(event.target.value)}
                    placeholder="Search glossary..."
                  />
                  <select className="s-input s-select" value={glossarySort} onChange={(event) => setGlossarySort(event.target.value as GlossarySortMode)}>
                    <option value="newest">Newest first</option>
                    <option value="oldest">Oldest first</option>
                    <option value="alphabetical">Alphabetical</option>
                  </select>
                  <select className="s-input s-select" value={glossaryCategory} onChange={(event) => setGlossaryCategory(event.target.value)}>
                    <option value="all">All categories</option>
                    {glossaryCategories.map((category) => (
                      <option key={category} value={category}>{category}</option>
                    ))}
                  </select>
                  <button className="btn-ghost-sm" disabled={selectedGlossaryIds.length < 2} onClick={joinSelectedGlossary}>
                    Join selected
                  </button>
                </div>
                <div className="glossary-settings-list">
                  {visibleGlossary.length === 0 ? (
                    <p style={{ fontSize: 12, color: 'rgba(255,255,255,0.35)' }}>No glossary terms yet.</p>
                  ) : visibleGlossary.map((entry) => (
                    <div key={entry.id} className="glossary-settings-item">
                      <label className="glossary-select-row">
                        <input
                          type="checkbox"
                          checked={selectedGlossaryIds.includes(entry.id)}
                          onChange={(event) => setSelectedGlossaryIds((ids) => event.target.checked
                            ? [...ids, entry.id]
                            : ids.filter((id) => id !== entry.id))}
                        />
                        Select
                      </label>
                      <Field label="Wrong variants">
                        <textarea
                          className="s-input glossary-settings-textarea"
                          value={entry.variants.join('\n')}
                          onChange={(event) => updateGlossaryEntry(entry.id, { variants: event.target.value.split(/\n|,/).map((v) => v.trim()).filter(Boolean) })}
                        />
                      </Field>
                      <div className="glossary-settings-row">
                        <Field label="Correct source">
                          <input className="s-input" value={entry.source} onChange={(event) => updateGlossaryEntry(entry.id, { source: event.target.value })} />
                        </Field>
                        <Field label="Correct translation">
                          <input
                            className="s-input"
                            value={entry.translation}
                            onChange={(event) => updateGlossaryEntry(entry.id, {
                              translation: event.target.value,
                              translations: {
                                ...(entry.translations ?? {}),
                                Default: event.target.value,
                              },
                            })}
                          />
                        </Field>
                      </div>
                      <Field label="Category">
                        <input
                          className="s-input"
                          value={entry.category ?? ''}
                          onChange={(event) => updateGlossaryEntry(entry.id, { category: event.target.value })}
                          placeholder="Names of God, Sacred places..."
                        />
                      </Field>
                      <Field label="Translations by language">
                        <textarea
                          className="s-input glossary-settings-textarea"
                          value={renderTranslationRows(entry.translations ?? (entry.translation ? { Default: entry.translation } : {}))}
                          onChange={(event) => updateGlossaryTranslations(entry.id, event.target.value)}
                          placeholder="Russian: Джаяпатака Махарадж&#10;German: ..."
                        />
                      </Field>
                      <div className="glossary-settings-actions">
                        <span style={{ fontSize: 11, color: 'var(--text-2)' }}>Saved for future sessions</span>
                        <button className="btn-danger-sm" onClick={() => deleteGlossaryEntry(entry.id)}><Trash2 size={13} /> Delete</button>
                      </div>
                    </div>
                  ))}
                </div>
              </div>
            </div>
          )}

          {/* Chunking — LARGEST TAB, sets modal height */}
          {tab === 4 && (
            <div>
              <div className="s-section">
                <p className="s-section-title">Chunk Duration</p>
                <div className="s-card">
                  <div>
                    <div className="s-slider-row">
                      <span className="s-label">Target Duration</span>
                      <span className="s-badge">{s.chunkDurationMin} min</span>
                    </div>
                    <input type="range" min={2} max={20} step={1} value={s.chunkDurationMin} onChange={e => upd({ chunkDurationMin: +e.target.value })} />
                    <div className="s-range-labels"><span>2 min</span><span>20 min</span></div>
                  </div>
                </div>
              </div>
              <div className="s-section">
                <p className="s-section-title">Slice Mode</p>
                <div className="s-card">
                  <div className="s-pills">
                    <button className={`s-pill ${s.sliceMode === 'silence' ? 'active' : ''}`} onClick={() => upd({ sliceMode: 'silence' })}>🔇 By Silence (Smart)</button>
                    <button className={`s-pill ${s.sliceMode === 'fixed' ? 'active' : ''}`} onClick={() => upd({ sliceMode: 'fixed' })}>⏱ Fixed Intervals</button>
                  </div>
                  <p style={{ fontSize: 11, color: 'rgba(255,255,255,0.3)', lineHeight: 1.5 }}>
                    {s.sliceMode === 'silence'
                      ? 'Cuts placed at natural speech pauses. Recommended.'
                      : 'Cuts every N minutes regardless of speech content.'}
                  </p>
                </div>
              </div>
              {s.sliceMode === 'silence' && (
                <div className="s-section">
                  <p className="s-section-title">Silence Detection</p>
                  <div className="s-card">
                    <div>
                      <div className="s-slider-row">
                        <span className="s-label">Silence Threshold</span>
                        <span className="s-badge">{s.silenceThreshDb} dB</span>
                      </div>
                      <input type="range" min={-40} max={-6} step={1} value={s.silenceThreshDb} onChange={e => upd({ silenceThreshDb: +e.target.value })} />
                      <div className="s-range-labels"><span>-40 dB</span><span>-6 dB</span></div>
                    </div>
                    <div>
                      <div className="s-slider-row">
                        <span className="s-label">Minimum Pause</span>
                        <span className="s-badge">{s.minSilenceMs} ms</span>
                      </div>
                      <input type="range" min={100} max={2000} step={100} value={s.minSilenceMs} onChange={e => upd({ minSilenceMs: +e.target.value })} />
                      <div className="s-range-labels"><span>100ms</span><span>2000ms</span></div>
                    </div>
                  </div>
                </div>
              )}
            </div>
          )}

          {/* Transcription */}
          {tab === 5 && (
            <div>
              <div className="s-section">
                <p className="s-section-title">Language Defaults</p>
                <div className="s-card">
                  <Field label="Default Source Language">
                    <select className="s-input s-select" value={s.defaultSourceLang} onChange={e => upd({ defaultSourceLang: e.target.value })}>
                      <option value="auto">Auto-Detect</option>
                      <option value="bn">Bengali</option>
                      <option value="en">English</option>
                      <option value="ru">Russian</option>
                      <option value="hi">Hindi</option>
                    </select>
                  </Field>
                  <Field label="Default Translation Target">
                    <select className="s-input s-select" value={s.defaultTargetLang} onChange={e => upd({ defaultTargetLang: e.target.value })}>
                      <option value="same">Same (No Translation)</option>
                      <option value="Russian">Russian</option>
                      <option value="English">English</option>
                      <option value="Hindi">Hindi</option>
                    </select>
                  </Field>
                </div>
              </div>
              <div style={{ background: 'rgba(245,166,35,0.07)', border: '1px solid rgba(245,166,35,0.2)', borderRadius: 10, padding: '12px 14px' }}>
                <p style={{ fontSize: 12, color: 'rgba(245,166,35,0.9)', lineHeight: 1.7 }}>
                  🕉 Pre-optimized for Gaudiya Vaishnava terminology — Sanskrit transliteration, Acharya names, Scripture references.
                </p>
              </div>
            </div>
          )}

          {/* Statistics */}
          {tab === 6 && (
            <div>
              <div className="s-section">
                <p className="s-section-title">Prompt Presets</p>
                <p style={{ fontSize: 12, color: 'var(--text-2)', lineHeight: 1.6, marginBottom: 12 }}>
                  Each workflow stage has a protected Default prompt plus three editable custom variants. Select 1, 2, or 3 to make that custom prompt active for real API and local model calls.
                </p>
                <div className="prompt-settings-layout">
                  <div className="prompt-settings-nav">
                    {promptStages.map((stage) => (
                      <div key={stage} className="prompt-stage-group">
                        <div className="prompt-stage-title">{stage}</div>
                        {PROMPT_DEFINITIONS.filter((definition) => definition.stage === stage).map((definition) => (
                          <button
                            key={definition.id}
                            className={`prompt-nav-button ${selectedPrompt.id === definition.id ? 'active' : ''}`}
                            onClick={() => setSelectedPromptId(definition.id)}
                          >
                            <span>{definition.label}</span>
                            <small>{s.promptPresets[definition.id]?.active === 'default' ? 'Default' : s.promptPresets[definition.id]?.active.replace('custom', '')}</small>
                          </button>
                        ))}
                      </div>
                    ))}
                  </div>
                  <div className="prompt-settings-editor">
                    <div className="prompt-editor-head">
                      <div>
                        <h3>{selectedPrompt.label}</h3>
                        <p>{selectedPrompt.description}</p>
                      </div>
                      <div className="prompt-slot-switcher" role="tablist" aria-label={`${selectedPrompt.label} prompt variant`}>
                        {PROMPT_SLOTS.map((slot) => (
                          <button
                            key={slot}
                            className={activePromptSlot === slot ? 'active' : ''}
                            onClick={() => updatePromptPreset(selectedPrompt.id, { active: slot })}
                          >
                            {slot === 'default' ? 'Default' : slot.replace('custom', '')}
                          </button>
                        ))}
                      </div>
                    </div>
                    {selectedPrompt.variables.length > 0 && (
                      <div className="prompt-variable-list">
                        {selectedPrompt.variables.map((variable) => <code key={variable}>{`{{${variable}}}`}</code>)}
                      </div>
                    )}
                    <textarea
                      className="s-input prompt-template-textarea"
                      readOnly={activePromptSlot === 'default'}
                      value={activePromptSlot === 'default'
                        ? selectedPrompt.defaultText
                        : selectedPromptSettings.custom[activePromptSlot as Exclude<PromptSlot, 'default'>] ?? ''}
                      onChange={(event) => {
                        if (activePromptSlot === 'default') return;
                        updatePromptPreset(selectedPrompt.id, {
                          custom: { [activePromptSlot]: event.currentTarget.value } as AppSettings['promptPresets'][PromptPresetId]['custom'],
                        });
                      }}
                      placeholder="Write a custom prompt for this workflow stage..."
                    />
                    <div className="prompt-editor-actions">
                      <span>{activePromptSlot === 'default' ? 'Default prompt is read-only.' : `Custom variant ${activePromptSlot.replace('custom', '')} is active when selected.`}</span>
                      {activePromptSlot !== 'default' && (
                        <button
                          className="btn-ghost-sm"
                          onClick={() => updatePromptPreset(selectedPrompt.id, {
                            custom: { [activePromptSlot]: selectedPrompt.defaultText } as AppSettings['promptPresets'][PromptPresetId]['custom'],
                          })}
                        >
                          Copy Default Here
                        </button>
                      )}
                    </div>
                  </div>
                </div>
              </div>
            </div>
          )}

          {/* Statistics */}
          {tab === 7 && (
            <div>
              <p className="s-section-title">Cloud API Usage</p>
              {latestUsage && (
                <div className="s-stats-item">
                  <div className="s-stats-header">
                    <span className="s-stats-name">Last Transaction Details</span>
                    <span className="s-badge">{providerDisplayName(latestUsage[0])}</span>
                  </div>
                  <div className="s-stats-grid">
                    <div className="s-stats-cell"><div className="val">{(latestUsage[1].lastInputTokens ?? 0).toLocaleString()}</div><div className="lbl">Prompt tokens</div></div>
                    <div className="s-stats-cell"><div className="val">{(latestUsage[1].lastOutputTokens ?? 0).toLocaleString()}</div><div className="lbl">Completion tokens</div></div>
                    <div className="s-stats-cell"><div className="val">{((latestUsage[1].lastInputTokens ?? 0) + (latestUsage[1].lastOutputTokens ?? 0)).toLocaleString()}</div><div className="lbl">Total tokens</div></div>
                  </div>
                </div>
              )}
              <div className="s-card" style={{ marginBottom: 12 }}>
                <div className="api-active-summary">
                  <div>
                    <span className="s-label">Transcribing</span>
                    <strong>{providerDisplayName(s.transcriptionProvider)}</strong>
                  </div>
                  <div>
                    <span className="s-label">Translation / Editing</span>
                    <strong>{providerDisplayName(s.translationProvider)}</strong>
                  </div>
                </div>
              </div>
              {Object.keys(usage).length === 0 ? (
                <p style={{ fontSize: 13, color: 'rgba(255,255,255,0.3)', textAlign: 'center', paddingTop: 40 }}>No usage recorded yet.</p>
              ) : Object.entries(usage).map(([provider, stats]) => {
                const spent = estimateUsageCost(provider, stats);
                const budget = provider === 'gemini-cloud' ? s.geminiBudgetUsd : provider === 'gpt-cloud' ? s.openaiBudgetUsd : 0;
                const remaining = Math.max(0, budget - spent);
                return (
                  <div key={provider} className="s-stats-item">
                    <div className="s-stats-header">
                      <span className="s-stats-name">{providerDisplayName(provider)}</span>
                      <span className="s-badge">{stats.sessions} transactions</span>
                    </div>
                    <div className="s-stats-grid usage-grid">
                      <div className="s-stats-cell"><div className="val">{stats.inputTokens.toLocaleString()}</div><div className="lbl">Prompt / input tokens</div></div>
                      <div className="s-stats-cell"><div className="val">{stats.outputTokens.toLocaleString()}</div><div className="lbl">Completion tokens</div></div>
                      <div className="s-stats-cell"><div className="val">{(stats.inputTokens + stats.outputTokens).toLocaleString()}</div><div className="lbl">Total tokens</div></div>
                      <div className="s-stats-cell"><div className="val">{stats.audioMinutes.toFixed(1)}</div><div className="lbl">Audio min</div></div>
                      <div className="s-stats-cell"><div className="val">${spent.toFixed(4)}</div><div className="lbl">Estimated spent</div></div>
                      <div className="s-stats-cell"><div className="val">{budget > 0 ? `$${remaining.toFixed(2)}` : '—'}</div><div className="lbl">Estimated remaining</div></div>
                    </div>
                    <p className="usage-estimate-note">Cost is an estimate based on locally counted text tokens; provider billing can differ.</p>
                  </div>
                );
              })}
              <button className="btn-danger-sm" style={{ marginTop: 12 }} onClick={() => { saveUsage({}); window.location.reload(); }}>Reset Statistics</button>
            </div>
          )}

        </div>

        <div className="modal-footer">
          <button className="btn-ghost-sm" onClick={() => setS({ ...DEFAULT_SETTINGS })}>Reset Defaults</button>
          <div style={{ display: 'flex', gap: 8 }}>
            {tab === 3 && (
              <button className="btn-ghost-sm" disabled={selectedGlossaryIds.length < 2} onClick={joinSelectedGlossary}>
                Join
              </button>
            )}
            <button className="btn-ghost-sm" onClick={onClose}>Cancel</button>
            <button className="btn-save" onClick={() => { onSave(s); onClose(); }}>Save Settings</button>
          </div>
        </div>
      </div>
    </div>
  );
}
