# Shorts & Reels Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a Shorts & Reels module that can find promising short clips from approved transcripts and optionally export vertical MP4/MOV shorts from the original video.

**Architecture:** Keep the existing transcription pipeline unchanged. Add a separate export-stage module that consumes approved chunks, transcript timing, optional original video, and subtitle settings. FFmpeg stays in Electron main for media operations; React only builds configuration, shows cards, and requests plan/export actions through IPC. The user-facing wording is “Export video,” not “render,” because this creates real `.mp4` or `.mov` files.

**Tech Stack:** Electron IPC, React/TypeScript, existing Gemini/OpenAI/local LLM providers, FFmpeg/ffmpeg-static, Node filesystem/project storage, TypeScript unit tests with `tsx --test`.

**Video Export Rule:** The default `Source-based` preset preserves the source quality class for a vertical 9:16 export: 1080p sources export as 1080×1920, 2K-class sources as 1440×2560, and 4K-class sources as 2160×3840. Explicit presets let the user choose Full HD, 2K, or 4K. MP4 and MOV are both supported.

---

## File Structure

- Create `src/lib/media-source.ts`: identify audio/video extensions and derive source media metadata.
- Modify `src/App.tsx`: preserve original video path in session/project and add Shorts & Reels export UI.
- Modify `src/types.ts`: add Electron APIs and session fields for video source and shorts settings.
- Modify `electron/main.js`: add FFmpeg IPC handlers for audio extraction, preview frame generation, MP4/MOV clip export, and ASS subtitle burn-in.
- Modify `electron/preload.js`: expose new IPC handlers.
- Create `src/lib/shorts-reels.ts`: prompt builder, response parser, timing helpers, defaults.
- Create `src/lib/shorts-reels.test.ts`: tests for prompt, parsing, duration validation.
- Create `src/lib/shorts-render.ts`: pure FFmpeg argument builders, output preset resolution helpers, quality helpers, and ASS subtitle generation, including configurable subtitle style presets.
- Create `src/lib/shorts-render.test.ts`: tests for 9:16 crop/zoom args, output presets, MP4/MOV export options, and subtitle style.
- Create `src/components/ShortsReelsPanel.tsx`: export-screen panel for planning/exporting shorts with mandatory preview before video export.
- Modify `src/services/document-export.ts` only if transcript assembly helpers need reuse; do not mix shorts logic into document export.
- Modify `src/index.css`: panel, cards, sliders, subtitle preview styles.

---

## Task 1: Media Source Detection And Video Preservation

**Files:**
- Create: `src/lib/media-source.ts`
- Test: `src/lib/media-source.test.ts`
- Modify: `src/types.ts`
- Modify: `src/App.tsx`

- [ ] **Step 1: Write failing tests for media type detection**

Create `src/lib/media-source.test.ts`:

```ts
import test from 'node:test';
import assert from 'node:assert/strict';
import { isAudioSourcePath, isVideoSourcePath, sourceMediaKind } from './media-source';

test('sourceMediaKind detects supported video files', () => {
  assert.equal(sourceMediaKind('/tmp/lecture.mp4'), 'video');
  assert.equal(sourceMediaKind('/tmp/lecture.MOV'), 'video');
  assert.equal(sourceMediaKind('/tmp/lecture.webm'), 'video');
});

test('sourceMediaKind detects supported audio files', () => {
  assert.equal(sourceMediaKind('/tmp/lecture.mp3'), 'audio');
  assert.equal(sourceMediaKind('/tmp/lecture.wav'), 'audio');
  assert.equal(sourceMediaKind('/tmp/lecture.flac'), 'audio');
});

test('source helpers reject unknown files', () => {
  assert.equal(isVideoSourcePath('/tmp/notes.txt'), false);
  assert.equal(isAudioSourcePath('/tmp/notes.txt'), false);
  assert.equal(sourceMediaKind('/tmp/notes.txt'), 'unknown');
});
```

- [ ] **Step 2: Run tests and verify failure**

Run:

```bash
npx tsx --test src/lib/media-source.test.ts
```

Expected: FAIL because `src/lib/media-source.ts` does not exist.

- [ ] **Step 3: Implement media detection**

Create `src/lib/media-source.ts`:

```ts
const AUDIO_EXTENSIONS = new Set(['mp3', 'wav', 'm4a', 'flac', 'ogg', 'aac', 'wma']);
const VIDEO_EXTENSIONS = new Set(['mp4', 'mov', 'mkv', 'webm']);

function extension(filePath: string): string {
  return filePath.split('.').pop()?.toLowerCase() ?? '';
}

export type SourceMediaKind = 'audio' | 'video' | 'unknown';

export function isAudioSourcePath(filePath: string): boolean {
  return AUDIO_EXTENSIONS.has(extension(filePath));
}

export function isVideoSourcePath(filePath: string): boolean {
  return VIDEO_EXTENSIONS.has(extension(filePath));
}

export function sourceMediaKind(filePath: string): SourceMediaKind {
  if (isVideoSourcePath(filePath)) return 'video';
  if (isAudioSourcePath(filePath)) return 'audio';
  return 'unknown';
}
```

- [ ] **Step 4: Add session fields**

Modify the local `Session` interface in `src/App.tsx` and related persisted type expectations:

```ts
interface Session {
  projectId?: string;
  createdAt?: string;
  updatedAt?: string;
  sourceFile: string;
  sourceFileName: string;
  sourceMediaKind?: 'audio' | 'video';
  originalVideoPath?: string;
  wavPath: string;
  config: SessionConfig;
  chunks: ChunkData[];
  currentIndex: number;
  targetLang: string;
}
```

- [ ] **Step 5: Preserve original video path during session initialization**

In `src/App.tsx`, import `sourceMediaKind`:

```ts
import { sourceMediaKind } from './lib/media-source';
```

When creating a new session in the processing flow, set:

```ts
const mediaKind = sourceMediaKind(sourceFile);
const originalVideoPath = mediaKind === 'video' ? sourceFile : undefined;
```

and include these fields in the session object:

```ts
sourceMediaKind: mediaKind,
originalVideoPath,
```

- [ ] **Step 6: Run tests**

Run:

```bash
npx tsx --test src/lib/media-source.test.ts
npm run compile
```

Expected: PASS.

---

## Task 2: Extract Audio From Video Without Losing The Video

**Files:**
- Modify: `electron/main.js`
- Modify: `electron/preload.js`
- Modify: `src/types.ts`
- Modify: `src/App.tsx`

- [ ] **Step 1: Add a focused IPC handler**

In `electron/main.js`, add a handler near existing FFmpeg handlers:

```js
ipcMain.handle('ffmpeg:extractAudioForTranscription', async (_, { inputPath }) => {
  try {
    const outputPath = path.join(app.getPath('temp'), `vaniscript_audio_${Date.now()}.wav`);
    const result = await runFfmpeg([
      '-y',
      '-i', inputPath,
      '-vn',
      '-ac', '1',
      '-ar', '16000',
      '-sample_fmt', 's16',
      outputPath,
    ]);
    if (!result.success) return result;
    return { success: true, outputPath };
  } catch (e) {
    log.error('ffmpeg:extractAudioForTranscription failed:', e);
    return { success: false, error: e.message || String(e) };
  }
});
```

- [ ] **Step 2: Expose it in preload**

In `electron/preload.js`:

```js
ffmpegExtractAudioForTranscription: (opts) => ipcRenderer.invoke('ffmpeg:extractAudioForTranscription', opts),
```

- [ ] **Step 3: Add TypeScript API type**

In `src/types.ts`, add:

```ts
ffmpegExtractAudioForTranscription: (opts: { inputPath: string }) => Promise<{ success: boolean; outputPath: string; error?: string; stderr?: string }>;
```

- [ ] **Step 4: Use it for videos in processing**

In `src/App.tsx`, before existing WAV conversion:

```ts
const mediaKind = sourceMediaKind(sourceFile);
let wavPath = sourceFile;

if (mediaKind === 'video') {
  setProcMsg('Extracting audio from video…');
  const extracted = await window.electronAPI.ffmpegExtractAudioForTranscription({ inputPath: sourceFile });
  if (!extracted.success) throw new Error(extracted.error || 'Could not extract audio from video.');
  wavPath = extracted.outputPath;
} else {
  // keep existing audio conversion logic
}
```

Keep `originalVideoPath: sourceFile` in the session.

- [ ] **Step 5: Verify with existing checks**

Run:

```bash
npm run compile
node --check electron/main.js
node --check electron/preload.js
```

Expected: PASS.

---

## Task 3: Shorts/Reels Plan Model And Prompt

**Files:**
- Create: `src/lib/shorts-reels.ts`
- Create: `src/lib/shorts-reels.test.ts`

- [ ] **Step 1: Write failing tests**

Create `src/lib/shorts-reels.test.ts`:

```ts
import test from 'node:test';
import assert from 'node:assert/strict';
import { buildShortsPrompt, parseShortsPlanResponse, validateShortClip } from './shorts-reels';

test('buildShortsPrompt includes duration, count, language, and Vaishnava criteria', () => {
  const prompt = buildShortsPrompt({
    transcript: '[00:12] Take shelter of Krishna.',
    count: 3,
    minDurationSec: 45,
    maxDurationSec: 90,
    outputLanguage: 'Russian',
  });

  assert.match(prompt, /3/);
  assert.match(prompt, /45/);
  assert.match(prompt, /90/);
  assert.match(prompt, /Russian/);
  assert.match(prompt, /Vaishnava/i);
  assert.match(prompt, /JSON/);
});

test('parseShortsPlanResponse extracts JSON array from model text', () => {
  const clips = parseShortsPlanResponse('```json\n[{ "start": "00:01:00", "end": "00:02:00", "title": "Shelter", "summary": "A strong moment.", "hook": "Clear spiritual advice." }]\n```');
  assert.equal(clips.length, 1);
  assert.equal(clips[0].start, '00:01:00');
  assert.equal(clips[0].title, 'Shelter');
});

test('validateShortClip rejects clips outside requested duration', () => {
  assert.equal(validateShortClip({ startSec: 60, endSec: 120 }, 45, 90).ok, true);
  assert.equal(validateShortClip({ startSec: 60, endSec: 200 }, 45, 90).ok, false);
});
```

- [ ] **Step 2: Run tests and verify failure**

Run:

```bash
npx tsx --test src/lib/shorts-reels.test.ts
```

Expected: FAIL because implementation is missing.

- [ ] **Step 3: Implement plan helpers**

Create `src/lib/shorts-reels.ts`:

```ts
export type ShortsClipPlan = {
  start: string;
  end: string;
  title: string;
  summary: string;
  hook: string;
};

export type ShortsPlanOptions = {
  transcript: string;
  count: number;
  minDurationSec: number;
  maxDurationSec: number;
  outputLanguage: string;
};

export function buildShortsPrompt(opts: ShortsPlanOptions): string {
  return [
    'You are selecting clips for YouTube Shorts, Instagram Reels, and TikTok.',
    'Context: Vaishnava lecture. Prefer moments with a clear story, paradox, emotional point, practical teaching, or memorable quote.',
    `Find exactly ${opts.count} candidate clips.`,
    `Each clip must be between ${opts.minDurationSec} and ${opts.maxDurationSec} seconds.`,
    `Write title, summary, and hook in ${opts.outputLanguage}.`,
    'Return only a JSON array. Each item must contain: start, end, title, summary, hook.',
    'Do not invent timestamps. Use only timestamps from the transcript.',
    '',
    'Transcript:',
    opts.transcript,
  ].join('\n');
}

export function parseShortsPlanResponse(text: string): ShortsClipPlan[] {
  const clean = text.replace(/^```(?:json)?/i, '').replace(/```$/i, '').trim();
  const start = clean.indexOf('[');
  const end = clean.lastIndexOf(']');
  if (start < 0 || end < start) throw new Error('Shorts plan response did not contain a JSON array.');
  const parsed = JSON.parse(clean.slice(start, end + 1));
  if (!Array.isArray(parsed)) throw new Error('Shorts plan response was not an array.');
  return parsed.map((item) => ({
    start: String(item.start || ''),
    end: String(item.end || ''),
    title: String(item.title || ''),
    summary: String(item.summary || ''),
    hook: String(item.hook || ''),
  })).filter((item) => item.start && item.end && item.title);
}

export function validateShortClip(
  clip: { startSec: number; endSec: number },
  minDurationSec: number,
  maxDurationSec: number
): { ok: boolean; durationSec: number; reason?: string } {
  const durationSec = clip.endSec - clip.startSec;
  if (durationSec < minDurationSec) return { ok: false, durationSec, reason: 'Clip is shorter than minimum duration.' };
  if (durationSec > maxDurationSec) return { ok: false, durationSec, reason: 'Clip is longer than maximum duration.' };
  return { ok: true, durationSec };
}
```

- [ ] **Step 4: Run tests**

Run:

```bash
npx tsx --test src/lib/shorts-reels.test.ts
```

Expected: PASS.

---

## Task 4: Vertical Export Arguments, Resolution Presets, And Subtitle Style

**Files:**
- Create: `src/lib/shorts-render.ts`
- Create: `src/lib/shorts-render.test.ts`

- [ ] **Step 1: Write failing tests for FFmpeg arguments and subtitle style**

Create `src/lib/shorts-render.test.ts`:

```ts
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  buildVerticalVideoFilter,
  buildShortsAssSubtitle,
  SHORTS_SUBTITLE_PRESETS,
  verticalResolutionForPreset,
  crfForShortsQuality,
  extensionForShortsFormat,
} from './shorts-render';

test('buildVerticalVideoFilter creates 9:16 crop with zoom and pan offsets', () => {
  const filter = buildVerticalVideoFilter({
    outputWidth: 1080,
    outputHeight: 1920,
    zoom: 1.18,
    cropX: 0.5,
    cropY: 0.42,
  });

  assert.match(filter, /scale=/);
  assert.match(filter, /crop=1080:1920/);
  assert.match(filter, /setsar=1/);
});

test('buildShortsAssSubtitle uses bold white text, black shadow, orange box, and lower placement', () => {
  const ass = buildShortsAssSubtitle({
    cues: [{ startSec: 0, endSec: 2.5, text: 'TAKE SHELTER OF' }],
    width: 1080,
    height: 1920,
    bottomMargin: 560,
    style: SHORTS_SUBTITLE_PRESETS.orangeImpact,
  });

  assert.match(ass, /Style: Shorts/);
  assert.match(ass, /TAKE SHELTER OF/);
  assert.match(ass, /MarginV,560/);
  assert.match(ass, /&H00FFFFFF/);
  assert.match(ass, /&H80008CFF/);
});

test('buildShortsAssSubtitle supports configurable font, text color, box color, opacity, and casing', () => {
  const ass = buildShortsAssSubtitle({
    cues: [{ startSec: 0, endSec: 2.5, text: 'take shelter of' }],
    width: 1080,
    height: 1920,
    bottomMargin: 420,
    style: {
      fontFamily: 'Cuprum',
      fontSize: 82,
      bold: true,
      textTransform: 'title',
      textColor: '#FFF7E6',
      boxColor: '#F59E0B',
      boxOpacity: 0.66,
      edgeSoftness: 0.55,
      outline: 2,
      shadow: 5,
    },
  });

  assert.match(ass, /Style: Shorts,Cuprum,82/);
  assert.match(ass, /Take Shelter Of/);
  assert.match(ass, /&H54/);
});

test('verticalResolutionForPreset chooses real shorts export sizes', () => {
  assert.deepEqual(verticalResolutionForPreset('1080p', { width: 1920, height: 1080 }), { width: 1080, height: 1920 });
  assert.deepEqual(verticalResolutionForPreset('2k', { width: 2560, height: 1440 }), { width: 1440, height: 2560 });
  assert.deepEqual(verticalResolutionForPreset('4k', { width: 3840, height: 2160 }), { width: 2160, height: 3840 });
});

test('source-based resolution keeps the source quality class for vertical exports', () => {
  assert.deepEqual(verticalResolutionForPreset('source', { width: 3840, height: 2160 }), { width: 2160, height: 3840 });
  assert.deepEqual(verticalResolutionForPreset('source', { width: 2560, height: 1440 }), { width: 1440, height: 2560 });
  assert.deepEqual(verticalResolutionForPreset('source', { width: 1920, height: 1080 }), { width: 1080, height: 1920 });
  assert.deepEqual(verticalResolutionForPreset('source', { width: 1280, height: 720 }), { width: 1080, height: 1920 });
});

test('export format and quality helpers map to predictable output options', () => {
  assert.equal(extensionForShortsFormat('mp4'), '.mp4');
  assert.equal(extensionForShortsFormat('mov'), '.mov');
  assert.equal(crfForShortsQuality('high'), 18);
  assert.equal(crfForShortsQuality('balanced'), 20);
  assert.equal(crfForShortsQuality('compact'), 24);
});
```

- [ ] **Step 2: Run tests and verify failure**

Run:

```bash
npx tsx --test src/lib/shorts-render.test.ts
```

Expected: FAIL because `shorts-render.ts` does not exist.

- [ ] **Step 3: Implement pure export helpers**

Create `src/lib/shorts-render.ts`:

```ts
export type VerticalVideoFilterOptions = {
  outputWidth: number;
  outputHeight: number;
  zoom: number;
  cropX: number;
  cropY: number;
};

export type ShortsVideoFormat = 'mp4' | 'mov';
export type ShortsResolutionPreset = 'source' | '1080p' | '2k' | '4k';
export type ShortsVideoQuality = 'high' | 'balanced' | 'compact';

export type AssCue = {
  startSec: number;
  endSec: number;
  text: string;
};

export type AssSubtitleOptions = {
  cues: AssCue[];
  width: number;
  height: number;
  bottomMargin: number;
  style: ShortsSubtitleStyle;
};

export type ShortsTextTransform = 'none' | 'uppercase' | 'title';

export type ShortsSubtitleStyle = {
  fontFamily: string;
  fontSize: number;
  bold: boolean;
  textTransform: ShortsTextTransform;
  textColor: string;
  boxColor: string;
  boxOpacity: number;
  edgeSoftness: number;
  outline: number;
  shadow: number;
};

function assTime(seconds: number): string {
  const safe = Math.max(0, seconds);
  const hours = Math.floor(safe / 3600);
  const minutes = Math.floor((safe % 3600) / 60);
  const wholeSeconds = Math.floor(safe % 60);
  const centiseconds = Math.floor((safe - Math.floor(safe)) * 100);
  return `${hours}:${String(minutes).padStart(2, '0')}:${String(wholeSeconds).padStart(2, '0')}.${String(centiseconds).padStart(2, '0')}`;
}

function assEscape(text: string): string {
  return text.replace(/[{}]/g, '').replace(/\n/g, '\\N');
}

function titleCase(text: string): string {
  return text.toLowerCase().replace(/(^|\s)\S/g, (match) => match.toUpperCase());
}

function transformText(text: string, mode: ShortsTextTransform): string {
  if (mode === 'uppercase') return text.toUpperCase();
  if (mode === 'title') return titleCase(text);
  return text;
}

function assColor(hex: string, alpha = 0): string {
  const clean = hex.replace('#', '').padEnd(6, '0').slice(0, 6);
  const rr = clean.slice(0, 2).toUpperCase();
  const gg = clean.slice(2, 4).toUpperCase();
  const bb = clean.slice(4, 6).toUpperCase();
  const aa = Math.round(Math.min(Math.max(alpha, 0), 1) * 255).toString(16).padStart(2, '0').toUpperCase();
  return `&H${aa}${bb}${gg}${rr}`;
}

function boxAlphaFromOpacity(opacity: number): number {
  return 1 - Math.min(Math.max(opacity, 0), 1);
}

export const SHORTS_SUBTITLE_PRESETS: Record<string, ShortsSubtitleStyle> = {
  orangeImpact: {
    fontFamily: 'Cuprum',
    fontSize: 74,
    bold: true,
    textTransform: 'uppercase',
    textColor: '#FFFFFF',
    boxColor: '#FF8C00',
    boxOpacity: 0.50,
    edgeSoftness: 0.25,
    outline: 3,
    shadow: 4,
  },
  cleanWhite: {
    fontFamily: 'Inter',
    fontSize: 68,
    bold: true,
    textTransform: 'none',
    textColor: '#FFFFFF',
    boxColor: '#000000',
    boxOpacity: 0.42,
    edgeSoftness: 0.15,
    outline: 2,
    shadow: 4,
  },
  warmEditorial: {
    fontFamily: 'Cuprum',
    fontSize: 78,
    bold: true,
    textTransform: 'title',
    textColor: '#FFF7E6',
    boxColor: '#D97706',
    boxOpacity: 0.58,
    edgeSoftness: 0.45,
    outline: 2,
    shadow: 5,
  },
};

export function buildVerticalVideoFilter(opts: VerticalVideoFilterOptions): string {
  const zoom = Math.min(Math.max(opts.zoom, 1), 2.5);
  const cropX = Math.min(Math.max(opts.cropX, 0), 1);
  const cropY = Math.min(Math.max(opts.cropY, 0), 1);
  return [
    `scale=${Math.ceil(opts.outputWidth * zoom)}:${Math.ceil(opts.outputHeight * zoom)}:force_original_aspect_ratio=increase`,
    `crop=${opts.outputWidth}:${opts.outputHeight}:(iw-${opts.outputWidth})*${cropX.toFixed(3)}:(ih-${opts.outputHeight})*${cropY.toFixed(3)}`,
    'setsar=1',
  ].join(',');
}

export function verticalResolutionForPreset(
  preset: ShortsResolutionPreset,
  source: { width: number; height: number }
): { width: number; height: number } {
  if (preset === '1080p') return { width: 1080, height: 1920 };
  if (preset === '2k') return { width: 1440, height: 2560 };
  if (preset === '4k') return { width: 2160, height: 3840 };

  const sourceLongEdge = Math.max(source.width, source.height);
  if (sourceLongEdge >= 3840) return { width: 2160, height: 3840 };
  if (sourceLongEdge >= 2560) return { width: 1440, height: 2560 };
  return { width: 1080, height: 1920 };
}

export function crfForShortsQuality(quality: ShortsVideoQuality): number {
  if (quality === 'high') return 18;
  if (quality === 'compact') return 24;
  return 20;
}

export function extensionForShortsFormat(format: ShortsVideoFormat): '.mp4' | '.mov' {
  return format === 'mov' ? '.mov' : '.mp4';
}

export function buildShortsAssSubtitle(opts: AssSubtitleOptions): string {
  const style = opts.style;
  const fontSize = Math.round(style.fontSize);
  const bottomMargin = Math.round(opts.bottomMargin);
  const primaryColor = assColor(style.textColor, 0);
  const backColor = assColor(style.boxColor, boxAlphaFromOpacity(style.boxOpacity));
  const outline = Math.max(0, Math.round(style.outline + (style.edgeSoftness * 2)));
  const shadow = Math.max(0, Math.round(style.shadow + (style.edgeSoftness * 2)));
  const header = [
    '[Script Info]',
    'ScriptType: v4.00+',
    `PlayResX: ${opts.width}`,
    `PlayResY: ${opts.height}`,
    '',
    '[V4+ Styles]',
    'Format: Name, Fontname, Fontsize, PrimaryColour, SecondaryColour, OutlineColour, BackColour, Bold, Italic, Underline, StrikeOut, ScaleX, ScaleY, Spacing, Angle, BorderStyle, Outline, Shadow, Alignment, MarginL, MarginR, MarginV, Encoding',
    `Style: Shorts,${style.fontFamily},${fontSize},${primaryColor},${primaryColor},&H00000000,${backColor},${style.bold ? -1 : 0},0,0,0,100,100,0,0,4,${outline},${shadow},2,60,60,${bottomMargin},1`,
    '',
    '[Events]',
    'Format: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text',
  ];
  const events = opts.cues.map((cue) =>
    `Dialogue: 0,${assTime(cue.startSec)},${assTime(cue.endSec)},Shorts,,0,0,${bottomMargin},,${assEscape(transformText(cue.text, style.textTransform))}`
  );
  return [...header, ...events].join('\n');
}
```

- [ ] **Step 4: Run tests**

Run:

```bash
npx tsx --test src/lib/shorts-render.test.ts
```

Expected: PASS.

---

## Task 5: Shorts & Reels Export UI

**Files:**
- Create: `src/components/ShortsReelsPanel.tsx`
- Modify: `src/App.tsx`
- Modify: `src/index.css`

- [ ] **Step 1: Create the panel component**

Create `src/components/ShortsReelsPanel.tsx`:

```tsx
import React from 'react';

export type ShortsExportMode = 'plan' | 'video';
export type ShortsVideoFormat = 'mp4' | 'mov';
export type ShortsResolutionPreset = 'source' | '1080p' | '2k' | '4k';

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
  subtitleTextTransform: 'none' | 'uppercase' | 'title';
  subtitleTextColor: string;
  subtitleBoxColor: string;
  subtitleBoxOpacity: number;
  subtitleEdgeSoftness: number;
  videoFormat: ShortsVideoFormat;
  resolutionPreset: ShortsResolutionPreset;
  videoQuality: 'high' | 'balanced' | 'compact';
};

type Props = {
  hasVideo: boolean;
  settings: ShortsSettings;
  isBusy: boolean;
  onChange: (settings: ShortsSettings) => void;
  onGenerate: () => void;
};

export function ShortsReelsPanel({ hasVideo, settings, isBusy, onChange, onGenerate }: Props) {
  const patch = (partial: Partial<ShortsSettings>) => onChange({ ...settings, ...partial });
  return (
    <section className="shorts-panel">
      <div className="shorts-panel-head">
        <div>
          <h3>Shorts & Reels</h3>
          <p>Find strong short moments and optionally export vertical MP4 or MOV clips.</p>
        </div>
      </div>
      <div className="shorts-grid">
        <label>
          Clips
          <input type="range" min={1} max={8} value={settings.count} onChange={(e) => patch({ count: Number(e.currentTarget.value) })} />
          <strong>{settings.count}</strong>
        </label>
        <label>
          Min seconds
          <input type="range" min={15} max={120} step={5} value={settings.minDurationSec} onChange={(e) => patch({ minDurationSec: Number(e.currentTarget.value) })} />
          <strong>{settings.minDurationSec}</strong>
        </label>
        <label>
          Max seconds
          <input type="range" min={30} max={240} step={5} value={settings.maxDurationSec} onChange={(e) => patch({ maxDurationSec: Number(e.currentTarget.value) })} />
          <strong>{settings.maxDurationSec}</strong>
        </label>
        <label>
          Zoom
          <input type="range" min={1} max={2} step={0.02} value={settings.zoom} onChange={(e) => patch({ zoom: Number(e.currentTarget.value) })} />
          <strong>{settings.zoom.toFixed(2)}x</strong>
        </label>
        <label>
          Crop X
          <input type="range" min={0} max={1} step={0.01} value={settings.cropX} onChange={(e) => patch({ cropX: Number(e.currentTarget.value) })} />
          <strong>{Math.round(settings.cropX * 100)}%</strong>
        </label>
        <label>
          Crop Y
          <input type="range" min={0} max={1} step={0.01} value={settings.cropY} onChange={(e) => patch({ cropY: Number(e.currentTarget.value) })} />
          <strong>{Math.round(settings.cropY * 100)}%</strong>
        </label>
        <label>
          Subtitle size
          <input type="range" min={42} max={96} step={1} value={settings.subtitleFontSize} onChange={(e) => patch({ subtitleFontSize: Number(e.currentTarget.value) })} />
          <strong>{settings.subtitleFontSize}</strong>
        </label>
        <label>
          Subtitle height
          <input type="range" min={260} max={760} step={10} value={settings.subtitleBottomMargin} onChange={(e) => patch({ subtitleBottomMargin: Number(e.currentTarget.value) })} />
          <strong>{settings.subtitleBottomMargin}</strong>
        </label>
        <label>
          Font
          <select value={settings.subtitleFontFamily} onChange={(e) => patch({ subtitleFontFamily: e.currentTarget.value })}>
            <option value="Cuprum">Cuprum</option>
            <option value="Arial">Arial</option>
            <option value="Inter">Inter</option>
            <option value="Helvetica Neue">Helvetica Neue</option>
            <option value="Georgia">Georgia</option>
          </select>
          <strong>{settings.subtitleFontFamily}</strong>
        </label>
        <label>
          Text color
          <input type="color" value={settings.subtitleTextColor} onChange={(e) => patch({ subtitleTextColor: e.currentTarget.value })} />
          <strong>{settings.subtitleTextColor}</strong>
        </label>
        <label>
          Box color
          <input type="color" value={settings.subtitleBoxColor} onChange={(e) => patch({ subtitleBoxColor: e.currentTarget.value })} />
          <strong>{settings.subtitleBoxColor}</strong>
        </label>
        <label>
          Box opacity
          <input type="range" min={0} max={1} step={0.02} value={settings.subtitleBoxOpacity} onChange={(e) => patch({ subtitleBoxOpacity: Number(e.currentTarget.value) })} />
          <strong>{Math.round(settings.subtitleBoxOpacity * 100)}%</strong>
        </label>
        <label>
          Edge softness
          <input type="range" min={0} max={1} step={0.05} value={settings.subtitleEdgeSoftness} onChange={(e) => patch({ subtitleEdgeSoftness: Number(e.currentTarget.value) })} />
          <strong>{Math.round(settings.subtitleEdgeSoftness * 100)}%</strong>
        </label>
      </div>
      <div className="shorts-toggle-row">
        <label><input type="checkbox" checked={settings.subtitleBold} onChange={(e) => patch({ subtitleBold: e.currentTarget.checked })} /> Bold</label>
        <select value={settings.subtitleTextTransform} onChange={(e) => patch({ subtitleTextTransform: e.currentTarget.value as ShortsSettings['subtitleTextTransform'] })}>
          <option value="uppercase">UPPERCASE</option>
          <option value="title">Title Case</option>
          <option value="none">Original case</option>
        </select>
      </div>
      <div className="shorts-mode-row">
        <button className={settings.mode === 'plan' ? 'active' : ''} onClick={() => patch({ mode: 'plan' })}>Plan only</button>
        <button className={settings.mode === 'video' ? 'active' : ''} disabled={!hasVideo} onClick={() => patch({ mode: 'video' })}>Export videos</button>
      </div>
      {settings.mode === 'video' && (
        <div className="shorts-export-settings">
          <label>
            Format
            <select value={settings.videoFormat} onChange={(e) => patch({ videoFormat: e.currentTarget.value as ShortsVideoFormat })}>
              <option value="mp4">MP4</option>
              <option value="mov">MOV</option>
            </select>
          </label>
          <label>
            Resolution
            <select value={settings.resolutionPreset} onChange={(e) => patch({ resolutionPreset: e.currentTarget.value as ShortsResolutionPreset })}>
              <option value="source">Source-based</option>
              <option value="1080p">Full HD 1080×1920</option>
              <option value="2k">2K 1440×2560</option>
              <option value="4k">4K 2160×3840</option>
            </select>
          </label>
          <label>
            Quality
            <select value={settings.videoQuality} onChange={(e) => patch({ videoQuality: e.currentTarget.value as ShortsSettings['videoQuality'] })}>
              <option value="high">High</option>
              <option value="balanced">Balanced</option>
              <option value="compact">Compact</option>
            </select>
          </label>
        </div>
      )}
      {!hasVideo && <p className="shorts-hint">Video export is available only when the project started from a video file.</p>}
      <button className="btn-start" disabled={isBusy} onClick={onGenerate}>
        {isBusy ? 'Working…' : settings.mode === 'video' ? 'Export Videos' : 'Generate Plan'}
      </button>
    </section>
  );
}
```

- [ ] **Step 2: Mount panel on export screen**

In `src/App.tsx`, import `ShortsReelsPanel` and add state:

```ts
import { ShortsReelsPanel, ShortsSettings } from './components/ShortsReelsPanel';
```

```ts
const [shortsSettings, setShortsSettings] = useState<ShortsSettings>({
  count: 4,
  minDurationSec: 45,
  maxDurationSec: 120,
  mode: 'plan',
  cropX: 0.5,
  cropY: 0.42,
  zoom: 1.12,
  subtitleFontSize: 72,
  subtitleBottomMargin: 560,
  subtitleFontFamily: 'Cuprum',
  subtitleBold: true,
  subtitleTextTransform: 'uppercase',
  subtitleTextColor: '#FFFFFF',
  subtitleBoxColor: '#FF8C00',
  subtitleBoxOpacity: 0.50,
  subtitleEdgeSoftness: 0.25,
  videoFormat: 'mp4',
  resolutionPreset: 'source',
  videoQuality: 'high',
});
const [shortsBusy, setShortsBusy] = useState(false);
```

Render the panel inside the export card after subtitle layout settings:

```tsx
<ShortsReelsPanel
  hasVideo={Boolean(session.originalVideoPath)}
  settings={shortsSettings}
  isBusy={shortsBusy}
  onChange={setShortsSettings}
  onGenerate={handleGenerateShorts}
/>
```

- [ ] **Step 3: Add CSS**

Add to `src/index.css`:

```css
.shorts-panel {
  text-align: left;
  padding: 16px;
  border: 1px solid rgba(255,255,255,0.1);
  border-radius: var(--radius-sm);
  background: rgba(255,255,255,0.035);
}
.shorts-panel-head h3 {
  margin: 0 0 4px;
  font-size: 15px;
}
.shorts-panel-head p,
.shorts-hint {
  color: var(--text-2);
  font-size: 12px;
  line-height: 1.45;
}
.shorts-grid {
  display: grid;
  grid-template-columns: 1fr 1fr;
  gap: 10px 14px;
  margin: 14px 0;
}
.shorts-grid label {
  display: grid;
  grid-template-columns: 92px 1fr 48px;
  align-items: center;
  gap: 8px;
  color: var(--text-2);
  font-size: 12px;
}
.shorts-grid strong {
  color: var(--accent);
  text-align: right;
}
.shorts-mode-row {
  display: grid;
  grid-template-columns: 1fr 1fr;
  gap: 6px;
  margin-bottom: 12px;
}
.shorts-mode-row button {
  padding: 8px;
  border: 1px solid rgba(255,255,255,0.12);
  border-radius: 8px;
  background: transparent;
  color: var(--text-1);
  cursor: pointer;
}
.shorts-mode-row button.active {
  background: var(--accent);
  color: #0a0a12;
  border-color: var(--accent);
}
.shorts-mode-row button:disabled {
  opacity: 0.45;
  cursor: not-allowed;
}
.shorts-toggle-row {
  display: grid;
  grid-template-columns: 1fr 1fr;
  gap: 8px;
  margin-bottom: 12px;
}
.shorts-toggle-row label,
.shorts-toggle-row select {
  border: 1px solid rgba(255,255,255,0.12);
  border-radius: 8px;
  background: rgba(0,0,0,0.16);
  color: var(--text-1);
  padding: 8px;
  font-size: 12px;
}
.shorts-export-settings {
  display: grid;
  grid-template-columns: 0.8fr 1.2fr 1fr;
  gap: 8px;
  margin: 0 0 12px;
}
.shorts-export-settings label {
  display: flex;
  flex-direction: column;
  gap: 5px;
  color: var(--text-2);
  font-size: 11px;
  font-weight: 700;
  text-transform: uppercase;
  letter-spacing: 0.05em;
}
.shorts-export-settings select {
  border: 1px solid rgba(255,255,255,0.12);
  border-radius: 8px;
  background: rgba(0,0,0,0.16);
  color: var(--text-1);
  padding: 8px;
  font-size: 12px;
}
```

- [ ] **Step 4: Compile**

Run:

```bash
npm run compile
npm run vite-build
```

Expected: PASS.

---

## Task 6: Generate Plan Only Cards

**Files:**
- Modify: `src/App.tsx`
- Modify: `src/components/ShortsReelsPanel.tsx`
- Modify: `src/services/document-export.ts` only if transcript assembly needs shared export helpers.

- [ ] **Step 1: Add plan state and transcript assembly**

In `src/App.tsx`, add:

```ts
const [shortsPlans, setShortsPlans] = useState<ShortsClipPlan[]>([]);
```

Build transcript input from approved chunks:

```ts
const buildShortsTranscript = useCallback(() => {
  if (!session) return '';
  return session.chunks
    .filter((chunk) => chunk.status === 'done')
    .map((chunk) => buildChunkPreview(chunk, session.targetLang === 'same' ? 'original' : 'translated', 'TXT'))
    .join('\n\n');
}, [session]);
```

- [ ] **Step 2: Implement cloud/local routing**

Implement `handleGenerateShorts` in `src/App.tsx`:

```ts
const handleGenerateShorts = useCallback(async () => {
  if (!session) return;
  setShortsBusy(true);
  try {
    const transcript = buildShortsTranscript();
    const prompt = buildShortsPrompt({
      transcript,
      count: shortsSettings.count,
      minDurationSec: shortsSettings.minDurationSec,
      maxDurationSec: shortsSettings.maxDurationSec,
      outputLanguage: session.targetLang === 'same' ? 'English' : session.targetLang,
    });
    const text = await runSelectedTextModel(prompt);
    const plans = parseShortsPlanResponse(text);
    setShortsPlans(plans);
  } finally {
    setShortsBusy(false);
  }
}, [buildShortsTranscript, session, shortsSettings]);
```

`runSelectedTextModel` should reuse the currently selected editing/export model path. If this helper does not exist, create it in `src/App.tsx` as a private callback that calls Gemini/OpenAI/local translation worker with a generic prompt.

- [ ] **Step 3: Show cards**

Extend `ShortsReelsPanel` props:

```ts
plans: ShortsClipPlan[];
onDeletePlan: (index: number) => void;
```

Render cards:

```tsx
{plans.map((plan, index) => (
  <article className="shorts-card" key={`${plan.start}-${plan.end}-${index}`}>
    <strong>{plan.title}</strong>
    <span>{plan.start} → {plan.end}</span>
    <p>{plan.summary}</p>
    <small>{plan.hook}</small>
    <button onClick={() => onDeletePlan(index)}>Remove</button>
  </article>
))}
```

- [ ] **Step 4: Verify**

Run:

```bash
npm run compile
npm run vite-build
```

Expected: PASS.

Manual check: Load an approved project, click `Generate Plan` in `Plan only`, see cards with start/end/title.

---

## Task 7: Export MP4/MOV Shorts With FFmpeg

**Files:**
- Modify: `electron/main.js`
- Modify: `electron/preload.js`
- Modify: `src/types.ts`
- Modify: `src/App.tsx`

- [ ] **Step 1: Add video metadata IPC**

In `electron/main.js`, add a focused handler near the existing `ffmpeg:getDuration` handler. It reuses FFmpeg stderr parsing, so no new `ffprobe` dependency is required:

```js
ipcMain.handle('ffmpeg:getVideoInfo', async (_, { inputPath }) => {
  const result = await runFfmpeg(['-i', inputPath, '-f', 'null', '-']);
  const stderr = result.stderr || '';
  const videoMatch = stderr.match(/Video:\s.*?,\s*(\d{2,5})x(\d{2,5})[\s,\[]/);
  const durationMatch = stderr.match(/Duration:\s*(\d+):(\d+):(\d+\.?\d*)/);
  if (!videoMatch) return { success: false, error: 'Could not read video dimensions.' };
  const durationSec = durationMatch
    ? (parseInt(durationMatch[1], 10) * 3600) + (parseInt(durationMatch[2], 10) * 60) + parseFloat(durationMatch[3])
    : 0;
  return {
    success: true,
    width: Number(videoMatch[1]),
    height: Number(videoMatch[2]),
    durationSec,
  };
});
```

In `electron/preload.js`:

```js
ffmpegGetVideoInfo: (opts) => ipcRenderer.invoke('ffmpeg:getVideoInfo', opts),
```

In `src/types.ts`:

```ts
ffmpegGetVideoInfo: (opts: { inputPath: string }) => Promise<{
  success: boolean;
  width?: number;
  height?: number;
  durationSec?: number;
  error?: string;
}>;
```

In `src/App.tsx`, load this once when a video-backed session enters the export screen:

```ts
const [shortsVideoSourceInfo, setShortsVideoSourceInfo] = useState<{ width: number; height: number; durationSec: number } | null>(null);

useEffect(() => {
  if (!session?.originalVideoPath || !window.electronAPI?.ffmpegGetVideoInfo) return;
  let cancelled = false;
  window.electronAPI.ffmpegGetVideoInfo({ inputPath: session.originalVideoPath }).then((info) => {
    if (!cancelled && info.success && info.width && info.height) {
      setShortsVideoSourceInfo({ width: info.width, height: info.height, durationSec: info.durationSec || 0 });
    }
  });
  return () => { cancelled = true; };
}, [session?.originalVideoPath]);
```

- [ ] **Step 2: Add preview frame IPC**

In `electron/main.js`, add handler:

```js
ipcMain.handle('ffmpeg:renderShortPreviewFrame', async (_, {
  inputVideoPath,
  outputPath,
  atSec,
  videoFilter,
  assSubtitlePath,
}) => {
  try {
    const result = await runFfmpeg([
      '-y',
      '-ss', String(atSec),
      '-i', inputVideoPath,
      '-frames:v', '1',
      '-vf', `${videoFilter},ass=${assSubtitlePath.replace(/:/g, '\\:')}`,
      '-update', '1',
      outputPath,
    ]);
    return result.success ? { success: true, outputPath } : result;
  } catch (e) {
    log.error('ffmpeg:renderShortPreviewFrame failed:', e);
    return { success: false, error: e.message || String(e) };
  }
});
```

- [ ] **Step 2: Expose preview IPC**

In `electron/preload.js`:

```js
ffmpegRenderShortPreviewFrame: (opts) => ipcRenderer.invoke('ffmpeg:renderShortPreviewFrame', opts),
```

In `src/types.ts`:

```ts
ffmpegRenderShortPreviewFrame: (opts: {
  inputVideoPath: string;
  outputPath: string;
  atSec: number;
  videoFilter: string;
  assSubtitlePath: string;
}) => Promise<{ success: boolean; outputPath: string; error?: string; stderr?: string }>;
```

- [ ] **Step 3: Add preview state before export**

In `src/App.tsx`, add:

```ts
const [shortsPreviewPath, setShortsPreviewPath] = useState('');
const [shortsPreviewApproved, setShortsPreviewApproved] = useState(false);
```

Whenever any export-affecting setting changes, reset approval:

```ts
const updateShortsSettings = useCallback((next: ShortsSettings) => {
  setShortsSettings(next);
  setShortsPreviewApproved(false);
}, []);
```

Pass `updateShortsSettings` to `ShortsReelsPanel` instead of `setShortsSettings`.

- [ ] **Step 4: Add preview generation callback**

In `src/App.tsx`:

```ts
const handleGenerateShortsPreview = useCallback(async (plan: ShortsClipPlan) => {
  if (!session?.originalVideoPath || !window.electronAPI) return;
  const startSec = parseTimestampToSeconds(plan.start);
  const endSec = parseTimestampToSeconds(plan.end);
  const previewAtSec = startSec + Math.max(0, Math.min(2, (endSec - startSec) / 2));
  const outputSize = verticalResolutionForPreset(shortsSettings.resolutionPreset, shortsVideoSourceInfo ?? { width: 1920, height: 1080 });
  const videoFilter = buildVerticalVideoFilter({
    outputWidth: outputSize.width,
    outputHeight: outputSize.height,
    zoom: shortsSettings.zoom,
    cropX: shortsSettings.cropX,
    cropY: shortsSettings.cropY,
  });
  const assSubtitlePath = await writeShortsPreviewAss(plan, shortsSettings);
  const outputPath = await createShortsPreviewPath(session.projectId);
  const result = await window.electronAPI.ffmpegRenderShortPreviewFrame({
    inputVideoPath: session.originalVideoPath,
    outputPath,
    atSec: previewAtSec,
    videoFilter,
    assSubtitlePath,
  });
  if (!result.success) throw new Error(result.error || 'Could not generate preview frame.');
  setShortsPreviewPath(result.outputPath);
  setShortsPreviewApproved(false);
}, [session, shortsSettings, shortsVideoSourceInfo]);
```

If `parseTimestampToSeconds`, `writeShortsPreviewAss`, or `createShortsPreviewPath` do not exist, create focused helpers in `src/lib/shorts-reels.ts` and Electron IPC for temp text writing.

- [ ] **Step 5: Require preview approval before final export**

In `ShortsReelsPanel`, add props:

```ts
previewPath: string;
previewApproved: boolean;
onGeneratePreview: () => void;
onApprovePreview: () => void;
```

Render preview block:

```tsx
<div className="shorts-preview">
  {previewPath ? <img src={`file://${previewPath}`} alt="Short preview" /> : <div className="shorts-preview-empty">Generate a preview before exporting.</div>}
  <div className="shorts-preview-actions">
    <button onClick={onGeneratePreview}>Preview frame</button>
    <button disabled={!previewPath} onClick={onApprovePreview}>Approve preview</button>
  </div>
</div>
```

Disable final video export unless `previewApproved` is true:

```tsx
<button className="btn-start" disabled={isBusy || (settings.mode === 'video' && !previewApproved)} onClick={onGenerate}>
  {settings.mode === 'video' && !previewApproved ? 'Preview required' : isBusy ? 'Working…' : settings.mode === 'video' ? 'Export Videos' : 'Generate Plan'}
</button>
```

- [ ] **Step 6: Add preview CSS**

Add to `src/index.css`:

```css
.shorts-preview {
  display: grid;
  grid-template-columns: 120px 1fr;
  gap: 12px;
  align-items: center;
  margin: 12px 0;
}
.shorts-preview img,
.shorts-preview-empty {
  width: 120px;
  aspect-ratio: 9 / 16;
  border-radius: 10px;
  border: 1px solid rgba(255,255,255,0.12);
  background: rgba(0,0,0,0.24);
  object-fit: cover;
}
.shorts-preview-empty {
  display: grid;
  place-items: center;
  padding: 10px;
  color: var(--text-2);
  font-size: 11px;
  text-align: center;
}
.shorts-preview-actions {
  display: flex;
  flex-direction: column;
  gap: 8px;
}
```

- [ ] **Step 7: Add video export IPC**

In `electron/main.js`, add handler:

```js
ipcMain.handle('ffmpeg:exportShortClip', async (_, {
  inputVideoPath,
  outputPath,
  startSec,
  durationSec,
  videoFilter,
  assSubtitlePath,
  crf,
  format,
}) => {
  try {
    const result = await runFfmpeg([
      '-y',
      '-ss', String(startSec),
      '-t', String(durationSec),
      '-i', inputVideoPath,
      '-vf', `${videoFilter},ass=${assSubtitlePath.replace(/:/g, '\\:')}`,
      '-c:v', 'libx264',
      '-preset', 'veryfast',
      '-crf', String(crf ?? 18),
      '-c:a', 'aac',
      '-b:a', '160k',
      '-movflags', '+faststart',
      format === 'mov' ? '-f' : null,
      format === 'mov' ? 'mov' : null,
      outputPath,
    ].filter(Boolean));
    return result.success ? { success: true, outputPath } : result;
  } catch (e) {
    log.error('ffmpeg:exportShortClip failed:', e);
    return { success: false, error: e.message || String(e) };
  }
});
```

- [ ] **Step 8: Expose video export IPC**

In `electron/preload.js`:

```js
ffmpegExportShortClip: (opts) => ipcRenderer.invoke('ffmpeg:exportShortClip', opts),
```

In `src/types.ts`:

```ts
ffmpegExportShortClip: (opts: {
  inputVideoPath: string;
  outputPath: string;
  startSec: number;
  durationSec: number;
  videoFilter: string;
  assSubtitlePath: string;
  crf?: number;
  format?: 'mp4' | 'mov';
}) => Promise<{ success: boolean; outputPath: string; error?: string; stderr?: string }>;
```

- [ ] **Step 9: Generate ASS file and output paths**

In `src/App.tsx`, for each accepted plan:

```ts
const outputSize = verticalResolutionForPreset(
  shortsSettings.resolutionPreset,
  shortsVideoSourceInfo ?? { width: 1920, height: 1080 }
);
const ass = buildShortsAssSubtitle({
  cues,
  width: outputSize.width,
  height: outputSize.height,
  bottomMargin: shortsSettings.subtitleBottomMargin,
  style: {
    fontFamily: shortsSettings.subtitleFontFamily,
    fontSize: shortsSettings.subtitleFontSize,
    bold: shortsSettings.subtitleBold,
    textTransform: shortsSettings.subtitleTextTransform,
    textColor: shortsSettings.subtitleTextColor,
    boxColor: shortsSettings.subtitleBoxColor,
    boxOpacity: shortsSettings.subtitleBoxOpacity,
    edgeSoftness: shortsSettings.subtitleEdgeSoftness,
    outline: 3,
    shadow: 4,
  },
});

const outputPath = await createShortsExportPath({
  projectId: session.projectId,
  title: plan.title,
  extension: extensionForShortsFormat(shortsSettings.videoFormat),
});
```

Use existing save/open file IPC patterns to write a temp `.ass` file. If there is no generic temp file writer, add `project:writeTempText` IPC in `electron/main.js`.

- [ ] **Step 10: Export each selected card**

For each card:

```ts
const outputSize = verticalResolutionForPreset(
  shortsSettings.resolutionPreset,
  shortsVideoSourceInfo ?? { width: 1920, height: 1080 }
);
const videoFilter = buildVerticalVideoFilter({
  outputWidth: outputSize.width,
  outputHeight: outputSize.height,
  zoom: shortsSettings.zoom,
  cropX: shortsSettings.cropX,
  cropY: shortsSettings.cropY,
});
const result = await window.electronAPI.ffmpegExportShortClip({
  inputVideoPath: session.originalVideoPath!,
  outputPath,
  startSec,
  durationSec,
  videoFilter,
  assSubtitlePath,
  crf: crfForShortsQuality(shortsSettings.videoQuality),
  format: shortsSettings.videoFormat,
});
if (!result.success) throw new Error(result.error || 'Could not export short clip.');
```

- [ ] **Step 11: Verify**

Run:

```bash
npm run compile
node --check electron/main.js
node --check electron/preload.js
npm run vite-build
```

Manual check:
- Upload MP4.
- Complete transcript.
- Generate plan cards.
- Select one card and generate preview frame.
- Adjust zoom, crop, subtitle position, font, color, opacity, edge softness.
- Generate preview again and approve it.
- Export one MP4 clip and one MOV clip.
- Confirm output is vertical MP4 or MOV according to the selected format/resolution, with large configurable subtitles near the lower third, matching the screenshot direction by default.

---

## Task 8: Manual QA And App Restart

**Files:**
- None unless bugs are found.

- [ ] **Step 1: Run full local checks**

Run:

```bash
npx tsx --test src/lib/media-source.test.ts src/lib/shorts-reels.test.ts src/lib/shorts-render.test.ts src/lib/glossary.test.ts src/lib/review-format.test.ts src/services/document-export.test.ts
npm run compile
npm run vite-build
node --check electron/main.js
node --check electron/preload.js
node --check electron/local-translation.worker.js
```

Expected: all pass.

- [ ] **Step 2: Close existing app processes**

Run:

```bash
pkill -f VaniScript
pkill -f local-translation.worker
pkill -f local-asr.worker
pkill -f llama-server
```

Expected: stale processes are stopped. Exit code 1 is acceptable when no matching worker exists.

- [ ] **Step 3: Launch fresh Electron**

Run:

```bash
open -na /Users/pavan/Documents/smartscribe/VaniScript/node_modules/electron/dist/Electron.app --args /Users/pavan/Documents/smartscribe/VaniScript
```

Expected: VaniScript opens from the fresh build.

---

## Self-Review

- Spec coverage: video input, audio extraction, plan-only export, MP4/MOV video export, source-based/Full HD/2K/4K resolution presets, crop controls, zoom slider, subtitle placement, and screenshot-inspired subtitle style are all covered.
- Placeholder scan: no unfinished placeholder markers remain.
- Type consistency: `ShortsSettings`, `ShortsClipPlan`, FFmpeg IPC names, and helper names are consistent across tasks.
- Scope note: this is large enough to implement in phases. Recommended execution order is Tasks 1-3 first, then Task 5 for UI, then Tasks 4 and 7 for preview/export.
