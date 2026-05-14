export const PROMPT_SLOTS = ['default', 'custom1', 'custom2', 'custom3'] as const;

export type PromptSlot = typeof PROMPT_SLOTS[number];

export type PromptPresetId =
  | 'transcriptionSystem'
  | 'transcriptionUser'
  | 'openaiWhisperPrompt'
  | 'translationSystem'
  | 'translationUser'
  | 'localTranslationUser'
  | 'literaryPolishSystem'
  | 'literaryPolishUser'
  | 'audioReview'
  | 'shortsPlannerSystem'
  | 'shortsPlanner'
  | 'documentMarkdown'
  | 'documentSubtitles'
  | 'localMarkdownPart';

export type PromptPresetSettings = {
  active: PromptSlot;
  custom: Partial<Record<Exclude<PromptSlot, 'default'>, string>>;
};

export type PromptSettingsMap = Record<PromptPresetId, PromptPresetSettings>;

export type PromptDefinition = {
  id: PromptPresetId;
  label: string;
  stage: string;
  description: string;
  variables: string[];
  defaultText: string;
};

const TRANSCRIPTION_SYSTEM = `You are a verbatim transcription engine optimized for Gaudiya Vaishnava philosophical lectures.

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

const TRANSCRIPTION_USER = `TASK:
1. Transcribe the audio in its original language.
{{translationInstruction}}
SPEAKER IDENTIFICATION HINT: Based on metadata, the primary speaker may be "{{speakerHint}}".

{{metadataBlock}}

REQUESTED FORMATS: {{requestedFormats}}

CRITICAL: YOU MUST WRAP EACH SECTION IN CLEAR TAGS.
Example:
[ORIGINAL_TXT]
(content here)
[/ORIGINAL_TXT]
{{translatedTxtExample}}
Do this for ALL formats requested: {{requestedFormats}}.
Use tags like [ORIGINAL_SRT], [ORIGINAL_VTT], [ORIGINAL_MARKDOWN], [TRANSLATED_SRT], etc.

REMAINING REQUIREMENTS:
- TXT: clean reading text with metadata at the top when provided. Preserve paragraph structure.
- SRT/VTT: split into real subtitle cues, not one large block. Keep cue lengths readable.
- Markdown: no timestamps in prose body unless absolutely necessary. Use real headings/subheadings and readable article structure for book/editorial work.
- SPEAKER TAGS: If there is only one speaker, do not repeat their name before every paragraph.
- At the absolute end, provide: "UNRECOGNIZED FRAGMENTS LIST" with a list of all {unrecognized} fragments.`;

const OPENAI_WHISPER_PROMPT = `Verbatim lecture transcription. Preserve first-person direct speech, names, Sanskrit/Bengali terms, and devotional terminology. Use standard spellings from the glossary context when possible.`;

const TRANSLATION_SYSTEM = `You are a precise translation engine for Gaudiya Vaishnava lectures.

RULES:
1. Preserve meaning exactly. Do not summarize.
2. Keep names and Sanskrit/Bengali philosophical terms in standard transliteration when natural.
3. Preserve every [MM:SS] timestamp marker exactly where it appears.
4. Preserve paragraph breaks and do not collapse the text into one paragraph.
5. Translate metadata labels naturally when the target language is not English.
6. Do not add commentary, notes, or explanations.
7. Return only the translated text.`;

const TRANSLATION_USER = `Translate the following transcript to {{targetLang}}.
{{speakerHintLine}}
{{glossaryBlock}}
Keep all [MM:SS] timestamp markers unchanged.
Keep metadata as a separate block at the top if present.
Keep paragraph breaks. Do not return one dense paragraph.
Return only the translated text.

{{text}}`;

const LOCAL_TRANSLATION_USER = `{{speakerHintLine}}
Translate the transcript into {{targetLang}}.
Return only the {{targetLang}} translation.
Do not explain. Do not think step by step. Do not output analysis, notes, markdown, or source-language copies.
{{glossaryBlock}}
Use the glossary spellings and translations exactly when those terms appear.
Preserve every [MM:SS] timestamp exactly.
Preserve paragraph breaks.

Transcript:
{{text}}

{{targetLang}} translation:`;

const LITERARY_POLISH_SYSTEM = `You revise translations into natural target-language prose while preserving exact meaning and timestamps.`;

const LITERARY_POLISH_USER = `Polish the following translated fragment so it sounds natural, fluent, and literary in {{targetLang}}.
{{speakerHintLine}}
{{glossaryBlock}}

Rules:
1. Preserve the meaning exactly. Do not add new meaning, do not summarize, and do not remove details.
2. Make the wording natural for a native reader of the target language, with correct grammar, cases, agreement, and word order.
3. Avoid stiff word-for-word translation. Rewrite only as much as needed so the sentence sounds idiomatic.
4. Preserve every existing [MM:SS] timestamp exactly if present. Do not add a new timestamp.
5. Preserve glossary terms exactly.
6. Return only the revised replacement text. No notes, labels, markdown, quote marks, or headings such as "Revised Russian:".
{{russianPolishRule}}

Fragment:
{{text}}`;

const AUDIO_REVIEW = `You are doing an audio-aware review of a short highlighted transcript fragment.
Mode: {{modeLabel}}.
{{speakerHintLine}}
{{glossaryBlock}}

Task:
1. Listen to the audio and locate the highlighted fragment.
2. Correct only this highlighted fragment.
3. Preserve the spoken meaning exactly. Do not polish, summarize, or expand.
4. Use glossary spellings and translations exactly when applicable.
{{returnLanguageRule}}

Highlighted fragment:
{{selectedText}}

Output only the corrected replacement text.
Do not return analysis, notes, markdown, labels, or quote marks.`;

const SHORTS_PLANNER_SYSTEM = `You select short video clips from prepared transcripts.
Return only the requested JSON.`;

const SHORTS_PLANNER = `You are selecting clips for YouTube Shorts, Instagram Reels, and TikTok.
Context: Vaishnava lecture. Prefer moments with a clear story, paradox, emotional point, practical teaching, or memorable quote.
{{speakerMetadataLine}}
Find exactly {{count}} candidate clips.
Each clip must be between {{minDurationSec}} and {{maxDurationSec}} seconds.
{{modeInstruction}}
{{captionSchema}}
captionText is the exact short-form subtitle script for this clip. It is not a summary.
captionText must contain many dense timestamped subtitle cues, one cue per line, formatted exactly as "[MM:SS] text".
Use absolute timestamps from the transcript, not relative timestamps. The first caption timestamp should be the clip start or the first spoken line inside the clip.
Create a new caption cue roughly every 1.5-4 seconds, or whenever the spoken phrase naturally changes.
Never put a whole 45-180 second clip into one or two caption cues. That makes the reel unusable.
Each caption cue should fit on a phone screen: aim for one line, maximum two short lines, usually 3-10 words or about 18-42 characters.
Preserve meaning and spoken order. Do not add commentary, explanations, markdown, numbering, or speaker labels inside captionText.
For bilingual output, sourceCaptionText and targetCaptionText must use the same timestamp markers and the same number/order of cues so both videos stay aligned.
Example captionText format: "[04:56] The spiritual city is\\n[04:59] the spiritual character of His residence\\n[05:03] In building the city of Mayapur"
Use short category tags such as story, philosophy, quote, teaching, humor, or history.
Do not invent timestamps. Use only timestamps from the transcript.

Transcript:
{{transcript}}`;

const DOCUMENT_MARKDOWN = `You are a formatting editor. Create a polished {{targetLang}} Markdown document from the prepared transcript below.

Hard rules:
1. Do not rewrite, paraphrase, summarize, correct, remove, or add transcript content.
2. Preserve the transcript text exactly, except removing timestamp markers if present.
3. You may add Markdown structure only: title, metadata block, table of contents, section headings, bold emphasis for short labels, horizontal rules, and paragraph breaks.
4. Divide the document by meaning. Section headings must describe the actual topic of the section, not merely copy the first sentence.
5. Preserve all metadata at the top and localize metadata labels to the document language.
6. Return only the Markdown document. No notes or explanations.

For Russian Markdown use Russian labels such as "Дата", "Место", "Лектор", "Интервьюер / Участники", and "Содержание".

<<<TRANSCRIPT>>>
{{text}}
<<<DOCUMENT>>>`;

const DOCUMENT_SUBTITLES = `You are a professional subtitle formatter. Format the prepared transcript as valid {{format}}.

Hard rules:
1. Do not rewrite, paraphrase, translate, correct, remove, or add spoken text.
2. Keep timings accurate and monotonic. Preserve the provided timing boundaries as closely as possible.
3. Prefer no more than {{subtitleMaxCharsPerLine}} characters per line and no more than {{subtitleMaxLines}} lines per subtitle cue.
4. Break subtitles at natural phrase boundaries.
5. Do not split proper names, titles, Sanskrit terms, or devotional names across subtitle cues or lines when avoidable.
6. If a phrase would read badly when split, make the cue slightly shorter or longer rather than splitting the phrase awkwardly.
7. Return only valid {{format}}. No notes, no markdown fences, no explanations.

<<<TRANSCRIPT>>>
{{text}}
<<<{{format}}>>>`;

const LOCAL_MARKDOWN_PART = `You are formatting part {{partNumber}} of {{totalParts}} of a {{targetLang}} Markdown document.

Hard rules:
1. Return only Markdown body sections for this fragment.
2. Do not include document title, metadata, table of contents, "Содержание", "Contents", or horizontal rules.
3. Do not rewrite, paraphrase, summarize, correct, remove, or add transcript content.
4. Remove timestamp markers if present.
5. Add only meaningful section headings and paragraph breaks.
6. If the fragment continues a previous topic, use a continuation heading only when it is genuinely needed.
7. No notes, no explanations, no markdown fences.

<<<TRANSCRIPT_FRAGMENT>>>
{{text}}
<<<DOCUMENT_PART>>>`;

export const PROMPT_DEFINITIONS: PromptDefinition[] = [
  {
    id: 'transcriptionSystem',
    label: 'Transcription · System',
    stage: 'Transcription',
    description: 'System instruction used by Gemini audio transcription.',
    variables: [],
    defaultText: TRANSCRIPTION_SYSTEM,
  },
  {
    id: 'transcriptionUser',
    label: 'Transcription · User',
    stage: 'Transcription',
    description: 'User prompt sent with audio for tagged transcript output.',
    variables: ['translationInstruction', 'speakerHint', 'metadataBlock', 'requestedFormats', 'translatedTxtExample'],
    defaultText: TRANSCRIPTION_USER,
  },
  {
    id: 'openaiWhisperPrompt',
    label: 'OpenAI Whisper Hint',
    stage: 'Transcription',
    description: 'Optional prompt/hint passed to OpenAI audio transcription.',
    variables: [],
    defaultText: OPENAI_WHISPER_PROMPT,
  },
  {
    id: 'translationSystem',
    label: 'Translation · System',
    stage: 'Translation',
    description: 'System instruction for cloud translation providers.',
    variables: ['targetLang'],
    defaultText: TRANSLATION_SYSTEM,
  },
  {
    id: 'translationUser',
    label: 'Translation · User',
    stage: 'Translation',
    description: 'Main transcript translation prompt for cloud providers.',
    variables: ['targetLang', 'speakerHintLine', 'glossaryBlock', 'text'],
    defaultText: TRANSLATION_USER,
  },
  {
    id: 'localTranslationUser',
    label: 'Local Translation',
    stage: 'Translation',
    description: 'Prompt used when local LLMs translate transcript batches.',
    variables: ['targetLang', 'speakerHintLine', 'glossaryBlock', 'text'],
    defaultText: LOCAL_TRANSLATION_USER,
  },
  {
    id: 'literaryPolishSystem',
    label: 'Polish · System',
    stage: 'Editing',
    description: 'System instruction for translation polishing.',
    variables: ['targetLang'],
    defaultText: LITERARY_POLISH_SYSTEM,
  },
  {
    id: 'literaryPolishUser',
    label: 'Polish · User',
    stage: 'Editing',
    description: 'Prompt used by Polish Translation in review/editing.',
    variables: ['targetLang', 'speakerHintLine', 'glossaryBlock', 'russianPolishRule', 'text'],
    defaultText: LITERARY_POLISH_USER,
  },
  {
    id: 'audioReview',
    label: 'Audio-Aware Review',
    stage: 'Editing',
    description: 'Prompt used when reviewing a selected fragment against audio.',
    variables: ['modeLabel', 'speakerHintLine', 'glossaryBlock', 'returnLanguageRule', 'selectedText'],
    defaultText: AUDIO_REVIEW,
  },
  {
    id: 'shortsPlannerSystem',
    label: 'Shorts/Reels · System',
    stage: 'Shorts & Reels',
    description: 'System instruction used by OpenAI for Shorts/Reels planning.',
    variables: [],
    defaultText: SHORTS_PLANNER_SYSTEM,
  },
  {
    id: 'shortsPlanner',
    label: 'Shorts/Reels · User',
    stage: 'Shorts & Reels',
    description: 'Prompt that finds interesting short-form clips and captions.',
    variables: ['speakerMetadataLine', 'count', 'minDurationSec', 'maxDurationSec', 'modeInstruction', 'captionSchema', 'transcript'],
    defaultText: SHORTS_PLANNER,
  },
  {
    id: 'documentMarkdown',
    label: 'Export · Markdown',
    stage: 'Export',
    description: 'Prompt that formats final Markdown documents.',
    variables: ['targetLang', 'text'],
    defaultText: DOCUMENT_MARKDOWN,
  },
  {
    id: 'documentSubtitles',
    label: 'Export · SRT/VTT',
    stage: 'Export',
    description: 'Prompt that formats final subtitle files.',
    variables: ['format', 'subtitleMaxCharsPerLine', 'subtitleMaxLines', 'text'],
    defaultText: DOCUMENT_SUBTITLES,
  },
  {
    id: 'localMarkdownPart',
    label: 'Local Markdown Part',
    stage: 'Export',
    description: 'Prompt for chunked local Markdown formatting.',
    variables: ['partNumber', 'totalParts', 'targetLang', 'text'],
    defaultText: LOCAL_MARKDOWN_PART,
  },
];

const PROMPT_DEFINITION_BY_ID = new Map(PROMPT_DEFINITIONS.map((definition) => [definition.id, definition]));

export const DEFAULT_PROMPT_SETTINGS: PromptSettingsMap = Object.fromEntries(
  PROMPT_DEFINITIONS.map((definition) => [
    definition.id,
    { active: 'default', custom: { custom1: '', custom2: '', custom3: '' } },
  ])
) as PromptSettingsMap;

export function normalizePromptSettings(raw: any): PromptSettingsMap {
  const result: PromptSettingsMap = structuredClone(DEFAULT_PROMPT_SETTINGS);

  for (const definition of PROMPT_DEFINITIONS) {
    const entry = raw?.[definition.id];
    if (!entry || typeof entry !== 'object') continue;
    const active = PROMPT_SLOTS.includes(entry.active) ? entry.active : 'default';
    result[definition.id] = {
      active,
      custom: {
        custom1: typeof entry.custom?.custom1 === 'string' ? entry.custom.custom1 : '',
        custom2: typeof entry.custom?.custom2 === 'string' ? entry.custom.custom2 : '',
        custom3: typeof entry.custom?.custom3 === 'string' ? entry.custom.custom3 : '',
      },
    };
  }

  return result;
}

export function defaultPromptFor(id: PromptPresetId): string {
  const definition = PROMPT_DEFINITION_BY_ID.get(id);
  if (!definition) throw new Error(`Unknown prompt preset: ${id}`);
  return definition.defaultText;
}

export function resolvePromptTemplate(settings: Partial<PromptSettingsMap> | undefined, id: PromptPresetId): string {
  const definition = PROMPT_DEFINITION_BY_ID.get(id);
  if (!definition) throw new Error(`Unknown prompt preset: ${id}`);
  const entry = settings?.[id] ?? DEFAULT_PROMPT_SETTINGS[id];
  if (entry.active !== 'default') {
    const custom = entry.custom?.[entry.active];
    if (custom?.trim()) return custom;
  }
  return definition.defaultText;
}

export function renderPromptTemplate(template: string, variables: Record<string, unknown>): string {
  return template.replace(/\{\{\s*([a-zA-Z0-9_]+)\s*\}\}/g, (_match, key) => {
    const value = variables[key];
    return value === undefined || value === null ? '' : String(value);
  }).replace(/\n{4,}/g, '\n\n\n').trim();
}

export function renderPrompt(
  settings: Partial<PromptSettingsMap> | undefined,
  id: PromptPresetId,
  variables: Record<string, unknown> = {}
): string {
  return renderPromptTemplate(resolvePromptTemplate(settings, id), variables);
}
