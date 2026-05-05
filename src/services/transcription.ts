import { GoogleGenAI } from '@google/genai';


export interface TranscriptionConfig {
  sourceLang: string;
  targetLang: string;
  speakerHint: string;
  formats: string[];
  geminiModel?: string; // optional: override model
}

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
): Promise<{ original: string; translated: string }> {
  const ai = new GoogleGenAI({ apiKey });
  const isTranslation = config.targetLang && config.targetLang !== 'same' && config.targetLang !== config.sourceLang;

  const prompt = `
TASK:
1. Transcribe the audio verbatim in its original language.
${isTranslation ? `2. Translate the full transcript to ${config.targetLang}.` : ''}
Speaker hint: "${config.speakerHint || 'Unknown'}"

OUTPUT FORMAT — wrap each section exactly like this:
[ORIGINAL]
(transcription here)
[/ORIGINAL]
${isTranslation ? `[TRANSLATED]\n(translation here)\n[/TRANSLATED]` : ''}

At the end, add:
UNRECOGNIZED: (list any unclear words)
`;

  onProgress?.('Uploading to Gemini...');

  // Models to try in order — user-selected first, then fallbacks
  const GEMINI_MODELS = [
    config.geminiModel ?? 'gemini-2.5-flash-preview-04-17',
    'gemini-2.0-flash',
    'gemini-1.5-flash',
  ].filter((v, i, a) => a.indexOf(v) === i); // deduplicate

  let stream: AsyncIterable<any> | null = null;
  let lastError: Error | null = null;

  for (const modelName of GEMINI_MODELS) {
    try {
      onProgress?.(`Trying ${modelName}...`);
      stream = await ai.models.generateContentStream({
        model: modelName,
        contents: { parts: [{ inlineData: { data: audioBase64, mimeType } }, { text: prompt }] },
        config: { systemInstruction: VAISHNAVA_SYSTEM, temperature: 0.05 },
      });
      break; // success
    } catch (err: any) {
      const msg = err?.message ?? String(err);
      if (msg.includes('404') || msg.includes('NOT_FOUND') || msg.includes('not found') || msg.includes('not supported')) {
        lastError = err;
        continue; // try next model
      }
      throw err; // auth errors, quota, etc — re-throw immediately
    }
  }

  if (!stream) throw lastError ?? new Error('No Gemini model available. Check your API key and try again.');

  let full = '';
  for await (const chunk of stream) {
    full += chunk.text ?? '';
    if (!full.includes('[ORIGINAL]')) onProgress?.('Transcribing...');
    else if (isTranslation && !full.includes('[TRANSLATED]')) onProgress?.('Translating...');
    else onProgress?.('Finalizing...');
  }

  const origMatch = full.match(/\[ORIGINAL\]([\s\S]*?)\[\/ORIGINAL\]/i);
  const transMatch = full.match(/\[TRANSLATED\]([\s\S]*?)\[\/TRANSLATED\]/i);

  return {
    original: origMatch?.[1]?.trim() ?? full.trim(),
    translated: transMatch?.[1]?.trim() ?? '',
  };
}

export async function transcribeChunkOpenAI(
  audioBlob: Blob,
  config: TranscriptionConfig,
  apiKey: string,
  onProgress?: (msg: string) => void
): Promise<{ original: string; translated: string }> {
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

  return { original, translated };
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
