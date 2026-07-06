import { GlossaryEntry } from '../types';

export type GlossarySortMode = 'alphabetical' | 'newest' | 'oldest';

function uniqueTrimmed(values: string[]): string[] {
  return Array.from(new Set(values.map((value) => value.trim()).filter(Boolean)));
}

function searchText(entry: GlossaryEntry): string {
  return [
    entry.source,
    entry.translation,
    entry.category ?? '',
    ...entry.variants,
    ...Object.values(entry.translations ?? {}),
  ].join(' ').toLowerCase();
}

export function filterGlossaryEntries(entries: GlossaryEntry[], query: string, category = 'all'): GlossaryEntry[] {
  const q = query.trim().toLowerCase();
  return entries.filter((entry) => {
    const matchesCategory = category === 'all' || !category || entry.category === category;
    const matchesQuery = !q || searchText(entry).includes(q);
    return matchesCategory && matchesQuery;
  });
}

export function listGlossaryCategories(entries: GlossaryEntry[]): string[] {
  return uniqueTrimmed(entries.map((entry) => entry.category ?? ''))
    .sort((a, b) => a.localeCompare(b));
}

export function sortGlossaryEntries(entries: GlossaryEntry[], mode: GlossarySortMode): GlossaryEntry[] {
  const copy = [...entries];
  if (mode === 'alphabetical') {
    return copy.sort((a, b) => (a.source || a.translation || a.variants[0] || '').localeCompare(b.source || b.translation || b.variants[0] || ''));
  }
  return copy.sort((a, b) => {
    const av = new Date(a.createdAt || a.updatedAt || 0).getTime();
    const bv = new Date(b.createdAt || b.updatedAt || 0).getTime();
    return mode === 'newest' ? bv - av : av - bv;
  });
}

export function joinGlossaryEntries(entries: GlossaryEntry[], selectedIds: string[]): GlossaryEntry[] {
  const selected = entries
    .filter((entry) => selectedIds.includes(entry.id))
    .sort((a, b) => new Date(a.createdAt || 0).getTime() - new Date(b.createdAt || 0).getTime());

  if (selected.length < 2) return entries;

  const base = selected[0];
  const selectedIdSet = new Set(selectedIds);
  const translations = { ...(base.translations ?? (base.translation ? { Russian: base.translation } : {})) };
  const category = base.category || selected.find((entry) => entry.category)?.category;

  for (const entry of selected.slice(1)) {
    for (const [lang, value] of Object.entries(entry.translations ?? {})) {
      if (!translations[lang] && value.trim()) translations[lang] = value.trim();
    }
  }

  const merged: GlossaryEntry = {
    ...base,
    category,
    variants: uniqueTrimmed(selected.flatMap((entry) => entry.variants))
      .filter((variant) => ![
        base.source,
        base.translation,
        ...Object.values(translations),
      ].some((correctValue) => correctValue.trim().toLowerCase() === variant.trim().toLowerCase())),
    translations,
    updatedAt: new Date().toISOString(),
  };

  return [merged, ...entries.filter((entry) => !selectedIdSet.has(entry.id))];
}
