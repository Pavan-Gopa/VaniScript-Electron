const RETRYABLE_PATTERNS = [
  /\b503\b/i,
  /\bUNAVAILABLE\b/i,
  /high demand/i,
  /overloaded/i,
  /try again later/i,
  /temporarily unavailable/i,
  /service unavailable/i,
];

export function isRetryableGeminiError(error: unknown): boolean {
  const message = typeof error === 'string' ? error : (error as any)?.message ?? String(error);
  return RETRYABLE_PATTERNS.some((pattern) => pattern.test(message));
}

export function formatGeminiError(error: unknown): string {
  const message = typeof error === 'string' ? error : (error as any)?.message ?? String(error);

  if (isRetryableGeminiError(message)) {
    return 'Gemini is temporarily unavailable due to high demand. Please retry in a minute, switch Gemini model, or use the OpenAI provider.';
  }

  return `Gemini transcription failed: ${message}`;
}
