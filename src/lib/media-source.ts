const AUDIO_EXTENSIONS = new Set(['mp3', 'wav', 'm4a', 'flac', 'ogg', 'aac', 'wma']);
const VIDEO_EXTENSIONS = new Set(['mp4', 'mov', 'mkv', 'webm']);

export type SourceMediaKind = 'audio' | 'video' | 'unknown';

function extension(filePath: string): string {
  return filePath.split('.').pop()?.toLowerCase() ?? '';
}

export function isAudioSourcePath(filePath: string): boolean {
  return AUDIO_EXTENSIONS.has(extension(filePath));
}

export function isVideoSourcePath(filePath: string): boolean {
  return VIDEO_EXTENSIONS.has(extension(filePath));
}

export function sourceMediaKind(filePath: string): SourceMediaKind {
  if (isVideoSourcePath(filePath)) return 'video';
  if (isAudioSourcePath(filePath)) return 'audio';
  return 'unknown';
}
