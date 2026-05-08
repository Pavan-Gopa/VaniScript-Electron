function normalizeSpaces(value: string): string {
  return value.replace(/\s+/g, ' ').trim();
}

function leadingTimestamp(value: string): string {
  return value.match(/^\s*(\[\d{2}:\d{2}(?::\d{2})?\])\s*/)?.[1] ?? '';
}

function withoutLeadingTimestamps(value: string): string {
  return value.replace(/^(?:\s*\[\d{2}:\d{2}(?::\d{2})?\]\s*)+/, '');
}

function collapseDuplicateLeadingTimestamps(value: string): string {
  const match = value.match(/^(?:\s*\[\d{2}:\d{2}(?::\d{2})?\]\s*)+/);
  if (!match) return value;
  const firstTimestamp = match[0].match(/\[\d{2}:\d{2}(?::\d{2})?\]/)?.[0];
  if (!firstTimestamp) return value;
  return `${firstTimestamp} ${value.slice(match[0].length).trimStart()}`;
}

function bodyReplacement(replacement: string): string {
  return withoutLeadingTimestamps(collapseDuplicateLeadingTimestamps(replacement)).trimStart();
}

function preserveTimestampIfNeeded(original: string, replacement: string): string {
  if (!replacement.trim()) return '';
  const timestamp = leadingTimestamp(original);
  const cleanReplacement = collapseDuplicateLeadingTimestamps(replacement);
  if (!timestamp) return cleanReplacement;
  return `${timestamp} ${withoutLeadingTimestamps(cleanReplacement).trimStart()}`;
}

function findNormalizedRange(haystack: string, needle: string): { start: number; end: number } | null {
  const normalizedNeedle = normalizeSpaces(needle);
  if (!normalizedNeedle) return null;

  for (let start = 0; start < haystack.length; start += 1) {
    if (/\s/.test(haystack[start] ?? '')) continue;
    let sourceIndex = start;
    let needleIndex = 0;
    let lastSourceIndex = start;

    while (sourceIndex < haystack.length && needleIndex < normalizedNeedle.length) {
      const sourceChar = haystack[sourceIndex];
      const needleChar = normalizedNeedle[needleIndex];

      if (/\s/.test(sourceChar)) {
        while (sourceIndex < haystack.length && /\s/.test(haystack[sourceIndex])) {
          sourceIndex += 1;
        }
        if (needleChar === ' ') needleIndex += 1;
        continue;
      }

      if (sourceChar !== needleChar) break;
      lastSourceIndex = sourceIndex + 1;
      sourceIndex += 1;
      needleIndex += 1;
    }

    if (needleIndex === normalizedNeedle.length) {
      return { start, end: lastSourceIndex };
    }
  }

  return null;
}

export function replaceSelectedText(
  content: string,
  opts: {
    selectedText: string;
    replacementText: string;
    contextText?: string;
  }
): { text: string; changed: boolean } {
  const rawSelected = opts.selectedText;
  const selected = rawSelected.trim();
  if (!selected) return { text: content, changed: false };
  const selectedBody = withoutLeadingTimestamps(selected);

  if (opts.contextText) {
    const contextRange = findNormalizedRange(content, opts.contextText);
    if (contextRange) {
      const before = content.slice(0, contextRange.start);
      const context = content.slice(contextRange.start, contextRange.end);
      const after = content.slice(contextRange.end);
      const selectedRange = findNormalizedRange(context, selectedBody);
      if (selectedRange) {
        const replacementText = bodyReplacement(opts.replacementText);
        return {
          text: `${before}${context.slice(0, selectedRange.start)}${replacementText}${context.slice(selectedRange.end)}${after}`,
          changed: true,
        };
      }
    }
  }

  const exactSelected = content.includes(rawSelected) ? rawSelected : selected;
  const exactIndex = content.indexOf(exactSelected);
  if (exactIndex >= 0) {
    const replacementText = preserveTimestampIfNeeded(selected, opts.replacementText);
    return {
      text: `${content.slice(0, exactIndex)}${replacementText}${content.slice(exactIndex + exactSelected.length)}`,
      changed: true,
    };
  }

  const range = findNormalizedRange(content, selectedBody);
  if (range) {
    const replacementText = bodyReplacement(opts.replacementText);
    return {
      text: `${content.slice(0, range.start)}${replacementText}${content.slice(range.end)}`,
      changed: true,
    };
  }

  return { text: content, changed: false };
}
