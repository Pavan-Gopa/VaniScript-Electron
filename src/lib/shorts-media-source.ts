export type ShortsAudioSession = {
  wavPath?: string | null;
  originalVideoPath?: string | null;
  sourceFile?: string | null;
};

function cleanPath(value?: string | null): string {
  return String(value || '').trim();
}

export function resolveShortsAudioPath(session?: ShortsAudioSession | null): string {
  return cleanPath(session?.wavPath) || cleanPath(session?.originalVideoPath) || cleanPath(session?.sourceFile);
}
