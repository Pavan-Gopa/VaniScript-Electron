import { GoogleGenAI } from '@google/genai';
import { formatGeminiError, isRetryableGeminiError } from '../lib/gemini-errors';
import { renderPrompt, type PromptSettingsMap } from '../lib/prompt-presets';
import {
  buildReadableCuesFromWords,
  buildSrtFromTimedCues,
  buildTimedTextFromWords,
  buildVttFromTimedCues,
  splitTextIntoReadableCues,
  type TimedCue,
  type TimedWord,
} from '../lib/segment-timing';
import { parseTaggedTranscriptionResult } from '../lib/tagged-result';
import { AudioMetadata, LanguageResult } from '../types';
import { translateTextWithOpenAI } from './cloud-translation';


export interface TranscriptionConfig {
  sourceLang: string;
  targetLang: string;
  speakerHint: string;
  formats: string[];
  geminiModel?: string; // optional: override model
  metadata?: AudioMetadata;
  includeMetadata?: boolean;
  promptPresets?: PromptSettingsMap;
}

export const SUPPORTED_GEMINI_MODELS = [
  'gemini-2.5-flash',
  'gemini-2.5-pro',
  'gemini-2.5-flash-lite',
  'gemini-2.0-flash',
] as const;

export async function transcribeChunkGemini(
  audioBase64: string,
  mimeType: string,
  config: TranscriptionConfig,
  apiKey: string,
  onProgress?: (msg: string) => void
): Promise<{ original: string; translated: string; originalFormats: LanguageResult; translatedFormats?: LanguageResult; unrecognizedFragments: string[] }> {
  const ai = new GoogleGenAI({ apiKey });
  const isTranslation = config.targetLang && config.targetLang !== 'same' && config.targetLang !== config.sourceLang;
  const maxAttemptsPerModel = 3;
  const requestedFormats = config.formats.join(', ');
  const metadataBlock = config.includeMetadata && config.metadata ? `
DOCUMENT METADATA TO INCLUDE AT THE TOP OF TXT AND MARKDOWN FORMATS:
Date: ${config.metadata.date || 'Unknown'}
Location: ${config.metadata.location || 'Unknown'}
Lecturer: ${config.metadata.lecturer || 'Unknown'}
Interviewer / Participants: ${config.metadata.participants || 'None'}
(Output these clearly at the start of your TXT and Markdown blocks)
` : '';

  const prompt = renderPrompt(config.promptPresets, 'transcriptionUser', {
    translationInstruction: isTranslation ? `2. Translate the transcript to ${config.targetLang}.` : '',
    speakerHint: config.speakerHint || 'Unknown',
    metadataBlock,
    requestedFormats,
    translatedTxtExample: isTranslation ? `\n[TRANSLATED_TXT]\n(content here)\n[/TRANSLATED_TXT]\n` : '',
  });
  const systemInstruction = renderPrompt(config.promptPresets, 'transcriptionSystem');

  onProgress?.('Uploading to Gemini...');

  // Models to try in order — user-selected first, then fallbacks
  const GEMINI_MODELS = [
    config.geminiModel ?? SUPPORTED_GEMINI_MODELS[0],
    ...SUPPORTED_GEMINI_MODELS,
  ].filter((v, i, a) => a.indexOf(v) === i); // deduplicate

  let stream: AsyncIterable<any> | null = null;
  let lastError: Error | null = null;

  for (const modelName of GEMINI_MODELS) {
    for (let attempt = 1; attempt <= maxAttemptsPerModel; attempt++) {
      try {
        onProgress?.(attempt === 1 ? `Trying ${modelName}...` : `Retrying ${modelName} (${attempt}/${maxAttemptsPerModel})...`);
        stream = await ai.models.generateContentStream({
          model: modelName,
          contents: [
            {
              role: 'user',
              parts: [
                { inlineData: { data: audioBase64, mimeType } },
                { text: prompt },
              ],
            },
          ],
          config: { systemInstruction, temperature: 0.05 },
        });
        break;
      } catch (err: any) {
        const msg = err?.message ?? String(err);
        lastError = err;

        if (msg.includes('404') || msg.includes('NOT_FOUND') || msg.includes('not found') || msg.includes('not supported')) {
          break;
        }

        if (!isRetryableGeminiError(msg)) {
          throw new Error(formatGeminiError(err));
        }

        if (attempt < maxAttemptsPerModel) {
          const delayMs = 1200 * attempt;
          onProgress?.(`Gemini is busy. Waiting ${Math.ceil(delayMs / 1000)}s before retry...`);
          await new Promise((resolve) => setTimeout(resolve, delayMs));
        }
      }

      if (stream) break;
    }

    if (stream) break;
  }

  if (!stream) {
    throw new Error(formatGeminiError(lastError ?? 'No Gemini model available. Check your API key and try again.'));
  }

  let full = '';
  try {
    for await (const chunk of stream) {
      full += chunk.text ?? '';
      if (!full.includes('[ORIGINAL_')) onProgress?.('Transcribing...');
      else if (isTranslation && !full.includes('[TRANSLATED_')) onProgress?.('Translating...');
      else onProgress?.('Finalizing...');
    }
  } catch (err) {
    throw new Error(formatGeminiError(err));
  }

  const parsed = parseTaggedTranscriptionResult(full);
  const original = parsed.original.TXT ?? Object.values(parsed.original).find(Boolean) ?? full.trim();
  const translated = parsed.translated?.TXT ?? Object.values(parsed.translated ?? {}).find(Boolean) ?? '';

  return {
    original,
    translated,
    originalFormats: parsed.original,
    translatedFormats: parsed.translated,
    unrecognizedFragments: parsed.unrecognizedFragments,
  };
}

export async function transcribeChunkOpenAI(
  audioBlob: Blob,
  config: TranscriptionConfig,
  apiKey: string,
  onProgress?: (msg: string) => void
): Promise<{ original: string; translated: string; originalFormats: LanguageResult; translatedFormats?: LanguageResult; unrecognizedFragments: string[] }> {
  onProgress?.('Uploading to OpenAI Whisper...');
  const form = new FormData();
  form.append('file', audioBlob, 'chunk.wav');
  form.append('model', 'whisper-1');
  if (config.sourceLang !== 'auto') form.append('language', config.sourceLang);
  form.append('response_format', 'verbose_json');
  form.append('timestamp_granularities[]', 'word');
  form.append('timestamp_granularities[]', 'segment');
  const promptHint = renderPrompt(config.promptPresets, 'openaiWhisperPrompt');
  if (promptHint.trim()) form.append('prompt', promptHint);

  const res = await fetch('https://api.openai.com/v1/audio/transcriptions', {
    method: 'POST',
    headers: { Authorization: `Bearer ${apiKey}` },
    body: form,
  });
  if (!res.ok) throw new Error(`OpenAI error: ${res.statusText}`);
  const transcriptionJson = await res.json();
  const rawText = String(transcriptionJson.text || '').trim();
  const words: TimedWord[] = Array.isArray(transcriptionJson.words)
    ? transcriptionJson.words
        .map((word: { word?: unknown; text?: unknown; start?: unknown; end?: unknown }) => ({
          text: String(word.word ?? word.text ?? '').trim(),
          start: Number(word.start),
          end: Number(word.end),
        }))
        .filter((word: TimedWord) => word.text && Number.isFinite(word.start) && Number.isFinite(word.end) && word.end > word.start)
    : [];
  const segmentCues: TimedCue[] = Array.isArray(transcriptionJson.segments)
    ? transcriptionJson.segments
        .map((segment: { text?: unknown; start?: unknown; end?: unknown }) => ({
          text: String(segment.text || '').trim(),
          startSec: Number(segment.start),
          endSec: Number(segment.end),
        }))
        .filter((cue: TimedCue) => cue.text && Number.isFinite(cue.startSec) && Number.isFinite(cue.endSec) && cue.endSec > cue.startSec)
    : [];
  const inferredDuration = Math.max(
    0,
    ...words.map((word) => word.end),
    ...segmentCues.map((cue) => cue.endSec),
  );
  const cues = words.length > 0
    ? buildReadableCuesFromWords(words)
    : segmentCues.length > 0
      ? segmentCues
      : splitTextIntoReadableCues(rawText, inferredDuration || Math.max(1, rawText.length / 12));
  const original = words.length > 0
    ? buildTimedTextFromWords(words)
    : cues.map((cue) => `[${String(Math.floor(cue.startSec / 60)).padStart(2, '0')}:${String(Math.floor(cue.startSec % 60)).padStart(2, '0')}] ${cue.text}`).join('\n');

  let translated = '';
  if (config.targetLang && config.targetLang !== 'same') {
    onProgress?.('Translating with GPT...');
    translated = await translateTextWithOpenAI(original, config.targetLang, apiKey, config.speakerHint, '', config.promptPresets);
  }

  const metadataPrefix = config.includeMetadata && config.metadata
    ? `Date: ${config.metadata.date || 'Unknown'}\nLocation: ${config.metadata.location || 'Unknown'}\nLecturer: ${config.metadata.lecturer || 'Unknown'}\nInterviewer / Participants: ${config.metadata.participants || 'None'}\n\n`
    : '';

  const originalFormats: LanguageResult = {
    TXT: `${metadataPrefix}${original}`.trim(),
    SRT: cues.length > 0 ? buildSrtFromTimedCues(cues) : original,
    VTT: cues.length > 0 ? buildVttFromTimedCues(cues) : original,
    Markdown: original,
  };
  const translatedFormats: LanguageResult | undefined = translated ? {
    TXT: `${metadataPrefix}${translated}`.trim(),
    SRT: translated,
    VTT: translated,
    Markdown: translated,
  } : undefined;

  return { original, translated, originalFormats, translatedFormats, unrecognizedFragments: [] };
}

export function fileToBase64(file: File | Blob): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.readAsDataURL(file);
    reader.onload = () => {
      const b64 = (reader.result as string).split(',')[1];
      b64 ? resolve(b64) : reject('Failed to encode');
    };
    reader.onerror = reject;
  });
}
