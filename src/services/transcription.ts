import { GoogleGenAI } from '@google/genai';
import { formatGeminiError, isRetryableGeminiError } from '../lib/gemini-errors';
import { parseTaggedTranscriptionResult } from '../lib/tagged-result';
import { AudioMetadata, LanguageResult } from '../types';


export interface TranscriptionConfig {
  sourceLang: string;
  targetLang: string;
  speakerHint: string;
  formats: string[];
  geminiModel?: string; // optional: override model
  metadata?: AudioMetadata;
  includeMetadata?: boolean;
}

export const SUPPORTED_GEMINI_MODELS = [
  'gemini-2.5-flash',
  'gemini-2.5-pro',
  'gemini-2.5-flash-lite',
  'gemini-2.0-flash',
] as const;

const VAISHNAVA_SYSTEM = `You are a verbatim transcription engine optimized for Gaudiya Vaishnava philosophical lectures.

RULES:
1. DICTAPHONE MODE: Transcribe exact words in first person. Zero summarization.
2. Sanskrit/Bengali terms: retain in original transliteration (Krishna, Bhakti, Shastra, etc.)
3. Speaker labels: use [Speaker Name] only when multiple speakers present.
4. Unrecognized words: {unrecognized word} as last resort.
5. Timestamps for TXT: [MM:SS] at speaker changes or logical paragraphs.
6. TAIL-CHECK: Ensure transcription reaches the absolute last spoken word.

CONTEXT: Gaudiya Vaishnava tradition. Acharyas: Srila Prabhupada, Bhaktivinoda Thakur, Bhaktisiddhanta Sarasvati.
Scriptures: Bhagavad-gita, Srimad-Bhagavatam, Caitanya-caritamrita, Nectar of Devotion.
Common terms: sankirtan, kirtan, sadhana, bhakti, nama-japa, puja, guru, diksha, vaishnava, sampradaya.`;

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

  const prompt = `
TASK:
1. Transcribe the audio in its original language.
${isTranslation ? `2. Translate the transcript to ${config.targetLang}.` : ''}
SPEAKER IDENTIFICATION HINT: Based on metadata, the primary speaker may be "${config.speakerHint || 'Unknown'}".

${metadataBlock}

REQUESTED FORMATS: ${requestedFormats}

CRITICAL: YOU MUST WRAP EACH SECTION IN CLEAR TAGS.
Example:
[ORIGINAL_TXT]
(content here)
[/ORIGINAL_TXT]
${isTranslation ? `\n[TRANSLATED_TXT]\n(content here)\n[/TRANSLATED_TXT]\n` : ''}
Do this for ALL formats requested: ${requestedFormats}.
Use tags like [ORIGINAL_SRT], [ORIGINAL_VTT], [ORIGINAL_MARKDOWN], [TRANSLATED_SRT], etc.

REMAINING REQUIREMENTS:
- TXT: clean reading text with metadata at the top when provided. Preserve paragraph structure.
- SRT/VTT: split into real subtitle cues, not one large block. Keep cue lengths readable.
- Markdown: no timestamps in prose body unless absolutely necessary. Use real headings/subheadings and readable article structure for book/editorial work.
- SPEAKER TAGS: If there is only one speaker, do not repeat their name before every paragraph.
- At the absolute end, provide: "UNRECOGNIZED FRAGMENTS LIST" with a list of all {unrecognized} fragments.
`;

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
          config: { systemInstruction: VAISHNAVA_SYSTEM, temperature: 0.05 },
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
  form.append('response_format', 'text');

  const res = await fetch('https://api.openai.com/v1/audio/transcriptions', {
    method: 'POST',
    headers: { Authorization: `Bearer ${apiKey}` },
    body: form,
  });
  if (!res.ok) throw new Error(`OpenAI error: ${res.statusText}`);
  const original = await res.text();

  let translated = '';
  if (config.targetLang && config.targetLang !== 'same') {
    onProgress?.('Translating with GPT...');
    const translateRes = await fetch('https://api.openai.com/v1/chat/completions', {
      method: 'POST',
      headers: { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model: 'gpt-4o-mini',
        messages: [
          { role: 'system', content: VAISHNAVA_SYSTEM },
          { role: 'user', content: `Translate to ${config.targetLang}:\n\n${original}` },
        ],
        temperature: 0.1,
      }),
    });
    const j = await translateRes.json();
    translated = j.choices?.[0]?.message?.content?.trim() ?? '';
  }

  const metadataPrefix = config.includeMetadata && config.metadata
    ? `Date: ${config.metadata.date || 'Unknown'}\nLocation: ${config.metadata.location || 'Unknown'}\nLecturer: ${config.metadata.lecturer || 'Unknown'}\nInterviewer / Participants: ${config.metadata.participants || 'None'}\n\n`
    : '';

  const originalFormats: LanguageResult = {
    TXT: `${metadataPrefix}${original}`.trim(),
    SRT: original,
    VTT: original,
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
