import { LanguageResult } from '../types';

export interface TaggedTranscriptionResult {
  original: LanguageResult;
  translated?: LanguageResult;
  unrecognizedFragments: string[];
}

export function parseTaggedTranscriptionResult(raw: string): TaggedTranscriptionResult {
  const original: LanguageResult = {};
  const translated: LanguageResult = {};
  const formats: Array<keyof LanguageResult> = ['TXT', 'SRT', 'VTT', 'Markdown'];

  formats.forEach((format) => {
    const originalRegex = new RegExp(`\\[ORIGINAL_${format.toUpperCase()}\\]([\\s\\S]*?)\\[\\/ORIGINAL_${format.toUpperCase()}\\]`, 'i');
    const translatedRegex = new RegExp(`\\[TRANSLATED_${format.toUpperCase()}\\]([\\s\\S]*?)\\[\\/TRANSLATED_${format.toUpperCase()}\\]`, 'i');

    const originalMatch = raw.match(originalRegex);
    const translatedMatch = raw.match(translatedRegex);

    if (originalMatch) original[format] = originalMatch[1].trim();
    if (translatedMatch) translated[format] = translatedMatch[1].trim();
  });

  if (Object.keys(original).length === 0) {
    original.TXT = raw.split('UNRECOGNIZED FRAGMENTS LIST')[0].trim();
  }

  const fragmentsMatch = raw.match(/UNRECOGNIZED FRAGMENTS LIST\s*([\s\S]*)$/i);
  const unrecognizedFragments = fragmentsMatch
    ? fragmentsMatch[1].trim().split('\n').map((line) => line.trim()).filter(Boolean)
    : [];

  return {
    original,
    translated: Object.keys(translated).length > 0 ? translated : undefined,
    unrecognizedFragments,
  };
}
