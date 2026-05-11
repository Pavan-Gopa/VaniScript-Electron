import React, { useEffect, useMemo, useState } from 'react';
import { Settings as Gear } from 'lucide-react';
import { Logo } from './Logo';
import { AppSettings, TranscriptionProvider, TranslationProvider } from '../types';
import { getAvailableTranscriptionProviders, getAvailableTranslationProviders, ProviderOption } from '../lib/provider-registry';

interface ConfigPanelProps {
  fileName: string;
  settings: AppSettings;
  onStart: (cfg: SessionConfig) => void;
  onCancel: () => void;
}

export interface SessionConfig {
  date: string;
  location: string;
  lecturer: string;
  participants: string;
  targetLang: string;
  formats: string[];
  transcriptionProvider: TranscriptionProvider;
  translationProvider: TranslationProvider;
}

const LANGS = [
  { value: 'same', label: 'Keep original (Same)' },
  { value: 'Russian', label: 'Russian' },
  { value: 'English', label: 'English' },
  { value: 'Hindi', label: 'Hindi' },
  { value: 'Spanish', label: 'Spanish' },
];

function filenameStem(name: string): string {
  return name
    .replace(/\.[^/.]+$/, '')
    .replace(/[_-]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function extractDate(name: string) {
  const stem = filenameStem(name);
  const full = stem.match(/\b(\d{4}[-. ]\d{1,2}[-. ]\d{1,2}|\d{1,2}[-. ]\d{1,2}[-. ]\d{4}|\d{8})\b/);
  if (full) return full[0].replace(/\s+/g, '-');
  const year = stem.match(/\b(19\d{2}|20\d{2})\b/);
  return year?.[0] ?? '';
}

function extractLecturer(name: string) {
  const stem = filenameStem(name);
  const upper = stem.toUpperCase();
  const abbreviations: Array<[RegExp, string]> = [
    [/\bKKS\b/, 'HH Kadamba Kanana Swami'],
    [/\bKK\b/, 'HH Kadamba Kanana Swami'],
    [/\bIDS\b/, 'HH Indradyumna Swami'],
    [/\bJPS\b/, 'HH Jayapataka Swami'],
    [/\bRNS\b/, 'HH Radhanath Swami'],
    [/\bSNS\b/, 'HH Sacinandana Swami'],
  ];
  const abbreviation = abbreviations.find(([pattern]) => pattern.test(upper));
  if (abbreviation) return abbreviation[1];

  const m = stem.match(/\b((?:HH|His Holiness|HG|H\.H\.)?\s*(?:[A-Z][a-zāīūṛṣṅñṭḍṇĀĪŪṚṢṄÑṬḌṆ]+\s*){1,5}(?:Swami|Maharaja|Mahārāja|Das|Dasa|Goswami|Gosvami|Thakur|Ṭhākura|Prabhu|Mataji|Devi Dasi))\b/i);
  return m?.[0]?.trim() ?? '';
}

function extractLocation(name: string) {
  const stem = filenameStem(name);
  const locations = [
    'Mayapur',
    'Māyāpur',
    'Vrindavan',
    'Vṛndāvana',
    'Govardhan',
    'Radha Kunda',
    'Radhakund',
    'Nabadwip',
    'Navadvipa',
    'Jagannath Puri',
    'Puri',
    'Mumbai',
    'Delhi',
    'Kolkata',
    'London',
    'New York',
    'Los Angeles',
    'Australia',
    'India',
  ];
  const found = locations.find((location) => new RegExp(`\\b${location.replace(/\s+/g, '\\s+')}\\b`, 'i').test(stem));
  return found ?? '';
}

function resolvePreferredProvider(preferredId: string, options: ProviderOption[]): string {
  if (preferredId && options.some((option) => option.id === preferredId)) {
    return preferredId;
  }
  return options[0]?.id ?? '';
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

export function ConfigPanel({ fileName, settings, onStart, onCancel }: ConfigPanelProps) {
  const transcriptionProviders = useMemo(
    () => getAvailableTranscriptionProviders(settings),
    [settings]
  );
  const [cfg, setCfg] = useState<SessionConfig>({
    date: extractDate(fileName),
    location: extractLocation(fileName),
    lecturer: extractLecturer(fileName),
    participants: '',
    targetLang: 'same',
    formats: ['TXT'],
    transcriptionProvider: resolvePreferredProvider(settings.transcriptionProvider, transcriptionProviders),
    translationProvider: '',
  });
  const translationAvailability = useMemo(
    () => getAvailableTranslationProviders(settings, cfg.targetLang),
    [settings, cfg.targetLang]
  );

  const upd = (patch: Partial<SessionConfig>) => setCfg(p => ({ ...p, ...patch }));

  useEffect(() => {
    const nextProvider = resolvePreferredProvider(cfg.transcriptionProvider, transcriptionProviders);
    if (nextProvider !== cfg.transcriptionProvider) {
      upd({ transcriptionProvider: nextProvider });
    }
  }, [cfg.transcriptionProvider, transcriptionProviders]);

  useEffect(() => {
    if (!translationAvailability.enabled) {
      if (cfg.translationProvider !== '') upd({ translationProvider: '' });
      return;
    }

    const nextProvider = resolvePreferredProvider(
      cfg.translationProvider || settings.translationProvider,
      translationAvailability.providers
    );
    if (nextProvider !== cfg.translationProvider) {
      upd({ translationProvider: nextProvider });
    }
  }, [
    cfg.translationProvider,
    settings.translationProvider,
    translationAvailability.enabled,
    translationAvailability.providers,
  ]);

  return (
    <div className="main-screen">
      <div className="logo-header" style={{ marginBottom: 20 }}>
        <div className="logo-wrap">
          <Logo className="logo-img" />
          <span className="logo-name">VaniScript</span>
        </div>
        <p className="logo-tagline">
          Professional Audio Transcription &amp; Translation Engine with<br />extreme verbatim accuracy.
        </p>
      </div>

      <div className="config-panel">
        <div className="config-title">
          <Gear size={18} />
          Engine Configuration
        </div>

        <div className="field-group">
          <p style={{ fontSize: 11, color: 'rgba(255,255,255,0.35)', marginBottom: 4 }}>Audio Metadata</p>
          <div className="field-row">
            <div className="field">
              <label>Date</label>
              <input value={cfg.date} onChange={e => upd({ date: e.target.value })} placeholder="" />
            </div>
            <div className="field">
              <label>Location</label>
              <input value={cfg.location} onChange={e => upd({ location: e.target.value })} placeholder="" />
            </div>
          </div>
          <div className="field-row">
            <div className="field">
              <label>Lecturer</label>
              <input value={cfg.lecturer} onChange={e => upd({ lecturer: e.target.value })} placeholder="His Holiness..." />
            </div>
            <div className="field">
              <label>Interviewer / Participants</label>
              <input value={cfg.participants} onChange={e => upd({ participants: e.target.value })} placeholder="" />
            </div>
          </div>

          <div className="field-row field-row-full" style={{ marginTop: 4 }}>
            <div className="field">
              <label>Target Language</label>
              <select value={cfg.targetLang} onChange={e => upd({ targetLang: e.target.value })}>
                {LANGS.map(l => <option key={l.value} value={l.value}>{l.label}</option>)}
              </select>
            </div>
          </div>

          <div className="field-row" style={{ marginTop: 4 }}>
            <div className="field">
              <label>Transcription Model</label>
              <select
                value={cfg.transcriptionProvider}
                onChange={e => upd({ transcriptionProvider: e.target.value })}
                disabled={transcriptionProviders.length === 0}
              >
                {transcriptionProviders.length > 0 ? renderProviderOptions(transcriptionProviders) : <option value="">No models available</option>}
              </select>
            </div>
            <div className="field">
              <label>Translation Model</label>
              <select
                value={cfg.translationProvider}
                onChange={e => upd({ translationProvider: e.target.value })}
                disabled={!translationAvailability.enabled || translationAvailability.providers.length === 0}
              >
                {!translationAvailability.enabled ? (
                  <option value="">Disabled for Same</option>
                ) : translationAvailability.providers.length > 0 ? (
                  renderProviderOptions(translationAvailability.providers)
                ) : (
                  <option value="">No translation models available</option>
                )}
              </select>
            </div>
          </div>
        </div>

        <div className="config-actions">
          <button className="btn-cancel" onClick={onCancel}>Cancel</button>
          <button
            className="btn-start"
            disabled={!cfg.transcriptionProvider || (translationAvailability.enabled && !cfg.translationProvider)}
            onClick={() => onStart(cfg)}
          >
            Initialize Engine
            <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5"><path d="M5 12h14M12 5l7 7-7 7"/></svg>
          </button>
        </div>
      </div>

      <div className="app-footer" style={{ marginTop: 20 }}>
        © 2026 VaniScript Audio Processor • Version 1.0.0<br />
        Optimized for Gaudiya Vaishnava Philosophical Lexicon &amp; Technical Terminology
      </div>
    </div>
  );
}
