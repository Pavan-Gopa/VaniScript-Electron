import { renderPrompt, type PromptSettingsMap } from '../lib/prompt-presets';

export type StructuredTextSegment = {
  id: string;
  text: string;
};

export type StructuredTranslation = {
  id: string;
  text: string;
};

export type StructuredTranslationRequest = {
  segments: StructuredTextSegment[];
  requestBatch: (segments: StructuredTextSegment[]) => Promise<string>;
};

function stripJsonFence(raw: string): string {
  const trimmed = raw.trim();
  const unfenced = trimmed
    .replace(/^```(?:json)?\s*/i, '')
    .replace(/\s*```$/i, '')
    .trim();
  const start = unfenced.indexOf('[');
  const end = unfenced.lastIndexOf(']');
  return start >= 0 && end >= start ? unfenced.slice(start, end + 1) : unfenced;
}

export function parseStructuredTranslationResponse(raw: string, expectedIds: string[]): StructuredTranslation[] {
  let parsed: unknown;
  try {
    parsed = JSON.parse(stripJsonFence(raw));
  } catch (error) {
    throw new Error(`Structured translation response was not valid JSON: ${error instanceof Error ? error.message : String(error)}`);
  }
  if (!Array.isArray(parsed)) {
    throw new Error('Structured translation response must be a JSON array.');
  }
  if (parsed.length !== expectedIds.length) {
    throw new Error(`Expected ${expectedIds.length} translated segments, got ${parsed.length}.`);
  }

  return parsed.map((item, index) => {
    const candidate = item as Partial<StructuredTranslation>;
    const id = String(candidate.id || '');
    if (id !== expectedIds[index]) {
      throw new Error(`Translated segment ${index + 1} id "${id}" does not match requested segment order "${expectedIds[index]}".`);
    }
    const text = String(candidate.text || '').trim();
    if (!text) {
      throw new Error(`Translated segment "${id}" was empty.`);
    }
    return { id, text };
  });
}

async function translateBatchOrSplit(
  segments: StructuredTextSegment[],
  requestBatch: (segments: StructuredTextSegment[]) => Promise<string>,
): Promise<StructuredTranslation[]> {
  try {
    const response = await requestBatch(segments);
    return parseStructuredTranslationResponse(response, segments.map((segment) => segment.id));
  } catch (error) {
    if (segments.length <= 1) throw error;
    const midpoint = Math.ceil(segments.length / 2);
    const left = await translateBatchOrSplit(segments.slice(0, midpoint), requestBatch);
    const right = await translateBatchOrSplit(segments.slice(midpoint), requestBatch);
    return [...left, ...right];
  }
}

export async function translateSegmentsWithStructuredFallback(
  opts: StructuredTranslationRequest,
): Promise<StructuredTranslation[]> {
  const segments = opts.segments.filter((segment) => segment.text.trim());
  if (segments.length === 0) return [];
  return translateBatchOrSplit(segments, opts.requestBatch);
}

export function splitTextForStructuredTranslation(text: string): StructuredTextSegment[] {
  return text
    .replace(/\r\n/g, '\n')
    .split(/\n{2,}/)
    .flatMap((part) => part.split(/\n(?=\[\d{2}:\d{2}(?::\d{2})?\]\s*)/))
    .map((part) => part.trim())
    .filter(Boolean)
    .map((part, index) => ({ id: `seg_${index + 1}`, text: part }));
}

export function buildStructuredTranslationPrompt(opts: {
  targetLang: string;
  speakerHint?: string;
  glossaryBlock?: string;
  segments: StructuredTextSegment[];
  promptPresets?: PromptSettingsMap;
}): string {
  return renderPrompt(opts.promptPresets, 'structuredTranslationUser', {
    targetLang: opts.targetLang,
    speakerHintLine: opts.speakerHint ? `Primary speaker hint: ${opts.speakerHint}.` : '',
    glossaryBlock: opts.glossaryBlock || '',
    segmentsJson: JSON.stringify(opts.segments, null, 2),
  });
}
