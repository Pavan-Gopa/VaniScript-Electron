import test from 'node:test';
import assert from 'node:assert/strict';
import { loadSettings } from './storage';

test('loadSettings drops unknown persisted local model entries', () => {
  const values = new Map<string, string>();
  const localStorageMock = {
    getItem: (key: string) => values.get(key) ?? null,
    setItem: (key: string, value: string) => { values.set(key, value); },
    removeItem: (key: string) => { values.delete(key); },
    clear: () => { values.clear(); },
  };

  Object.defineProperty(globalThis, 'localStorage', {
    value: localStorageMock,
    configurable: true,
  });

  values.set('vs_settings_v1', JSON.stringify({
    localAsrModels: {
      'parakeet-english': { status: 'failed', label: 'Parakeet English' },
      'stale-parakeet-download': { status: 'failed', error: 'legacy row without label' },
    },
    localTranslationModels: {
      'qwen35-2b-instruct-q4_k_m': { status: 'not_downloaded' },
      'unknown-translation-model': { status: 'failed' },
    },
  }));

  const settings = loadSettings();

  assert.deepEqual(Object.keys(settings.localAsrModels), [
    'parakeet-english',
    'whisper-medium-en',
    'whisper-large-v3',
  ]);
  assert.equal(settings.localAsrModels['stale-parakeet-download'], undefined);
  assert.equal(settings.localTranslationModels['unknown-translation-model'], undefined);
  assert.ok(settings.glossary.some((entry) => entry.source === 'Śrīla Prabhupāda' && entry.category === 'Acharyas / Teachers'));
});

test('loadSettings merges starter glossary with existing user glossary', () => {
  const values = new Map<string, string>();
  Object.defineProperty(globalThis, 'localStorage', {
    value: {
      getItem: (key: string) => values.get(key) ?? null,
      setItem: (key: string, value: string) => { values.set(key, value); },
      removeItem: (key: string) => { values.delete(key); },
      clear: () => { values.clear(); },
    },
    configurable: true,
  });

  values.set('vs_settings_v1', JSON.stringify({
    glossary: [{
      id: 'user-term',
      variants: ['Maypur'],
      source: 'Mayapur Temple',
      translation: 'Храм Майяпура',
      category: 'Пользовательское',
      remember: true,
      createdAt: '2026-01-01T00:00:00.000Z',
      updatedAt: '2026-01-01T00:00:00.000Z',
    }],
  }));

  const settings = loadSettings();
  assert.ok(settings.glossary.some((entry) => entry.id === 'user-term'));
  assert.ok(settings.glossary.some((entry) => entry.id === 'user-term' && entry.category === 'Custom'));
  assert.ok(settings.glossary.some((entry) => entry.source === 'Māyāpur' && entry.category === 'Sacred places'));
});
