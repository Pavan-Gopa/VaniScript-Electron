export function shouldTranslateChunk(targetLang: string): boolean {
  return targetLang.trim().toLowerCase() !== 'same';
}
