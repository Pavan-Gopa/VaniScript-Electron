import { AppSettings } from '../types';

export function getApiKeyForProvider(settings: AppSettings, providerId: string): string {
  switch (providerId) {
    case 'gemini-cloud':
      return settings.geminiKey.trim();
    case 'gpt-cloud':
      return settings.openaiKey.trim();
    case 'claude-cloud':
      return settings.anthropicKey.trim();
    default:
      return '';
  }
}

export function isCloudProvider(providerId: string): boolean {
  return providerId.endsWith('-cloud');
}

export function isLocalAsrProvider(settings: AppSettings, providerId: string): boolean {
  return Object.prototype.hasOwnProperty.call(settings.localAsrModels, providerId);
}

export function isLocalTranslationProvider(settings: AppSettings, providerId: string): boolean {
  return Object.prototype.hasOwnProperty.call(settings.localTranslationModels, providerId);
}
