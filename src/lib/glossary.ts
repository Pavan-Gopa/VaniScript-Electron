import { GlossaryEntry } from '../types';

export type GlossaryApplyTarget = 'source' | 'translation';

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function uniqueTrimmed(values: string[]): string[] {
  return Array.from(new Set(values.map((value) => value.trim()).filter(Boolean)));
}

function sameTerm(a: string, b: string): boolean {
  return a.trim().toLowerCase() === b.trim().toLowerCase();
}

export function createGlossaryEntry(input: {
  variants: string[];
  source: string;
  translation: string;
  category?: string;
  translations?: Record<string, string>;
  remember?: boolean;
}): GlossaryEntry {
  const createdAt = new Date().toISOString();
  const translation = input.translation.trim();
  return {
    id: `glossary-${createdAt}-${Math.random().toString(36).slice(2, 8)}`,
    variants: uniqueTrimmed(input.variants),
    source: input.source.trim(),
    translation,
    category: input.category?.trim() || undefined,
    translations: {
      ...(translation ? { Default: translation } : {}),
      ...(input.translations ?? {}),
    },
    remember: input.remember ?? true,
    createdAt,
    updatedAt: createdAt,
  };
}

export function addVariantsToGlossaryEntry(entry: GlossaryEntry, variants: string[]): GlossaryEntry {
  const correctValues = [
    entry.source,
    entry.translation,
    ...Object.values(entry.translations ?? {}),
  ].filter(Boolean);
  const nextVariants = uniqueTrimmed([...entry.variants, ...variants])
    .filter((variant) => !correctValues.some((correct) => sameTerm(variant, correct)));
  return {
    ...entry,
    variants: nextVariants,
    updatedAt: new Date().toISOString(),
  };
}

function replacementFor(entry: GlossaryEntry, target: GlossaryApplyTarget): string {
  return target === 'source' ? entry.source : entry.translation;
}

export function applyGlossaryToText(
  text: string,
  entries: GlossaryEntry[],
  target: GlossaryApplyTarget
): { text: string; count: number } {
  let nextText = text;
  let count = 0;

  for (const entry of entries) {
    const replacement = replacementFor(entry, target);
    if (!replacement) continue;

    const variants = uniqueTrimmed([
      ...entry.variants,
      target === 'source' ? entry.translation : entry.source,
    ]).filter((variant) => variant !== replacement);

    for (const variant of variants.sort((a, b) => b.length - a.length)) {
      const pattern = new RegExp(`(?<![\\p{L}\\p{N}_])${escapeRegExp(variant)}(?![\\p{L}\\p{N}_])`, 'giu');
      nextText = nextText.replace(pattern, () => {
        count += 1;
        return replacement;
      });
    }
  }

  return { text: nextText, count };
}

export function buildGlossaryPromptBlock(entries: GlossaryEntry[]): string {
  const active = entries
    .filter((entry) => entry.source || entry.translation)
    .slice(0, 80);

  if (active.length === 0) return '';

  return [
    'Glossary terms to preserve:',
    ...active.map((entry) => {
      const variants = entry.variants.length > 0 ? entry.variants.join(', ') : entry.source;
      const category = entry.category ? ` [${entry.category}]` : '';
      const translationEntries = Object.entries(entry.translations ?? {}).filter(([, value]) => value.trim());
      const translations = translationEntries.length === 1 && translationEntries[0][0] === 'Default'
        ? translationEntries[0][1]
        : translationEntries.map(([lang, value]) => `${lang}: ${value}`).join('; ');
      return ['-', `${variants}${category}`, '=>', entry.source, translations ? `=> ${translations}` : entry.translation ? `=> ${entry.translation}` : '']
        .filter(Boolean)
        .join(' ');
    }),
  ].join('\n');
}
