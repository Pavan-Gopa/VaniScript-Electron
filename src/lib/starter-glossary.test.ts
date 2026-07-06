import test from 'node:test';
import assert from 'node:assert/strict';
import { mergeStarterGlossary, STARTER_GLOSSARY } from './starter-glossary';

test('starter glossary ships with categorized Vaishnava terminology', () => {
  assert.ok(STARTER_GLOSSARY.length >= 90);
  const mayapur = STARTER_GLOSSARY.find((entry) => entry.source === 'Māyāpur');
  assert.equal(mayapur?.translation, 'Майяпур');
  assert.equal(mayapur?.category, 'Sacred places');
  assert.ok(mayapur?.variants.includes('Mayapur'));
});

test('starter glossary includes avatara terms with common merged spellings', () => {
  const matsya = STARTER_GLOSSARY.find((entry) => entry.source === 'Matsya Avatāra');
  assert.equal(matsya?.translation, 'Матсья-аватара');
  assert.equal(matsya?.category, 'Avataras / Lord');
  assert.ok(matsya?.variants.includes('Matsyavatar'));
});

test('starter glossary expands common transcription misspellings', () => {
  const prabhupada = STARTER_GLOSSARY.find((entry) => entry.source === 'Śrīla Prabhupāda');
  assert.ok(prabhupada?.variants.includes('Srila Prabhupada'));
  assert.ok(prabhupada?.variants.includes('Shri La Prabhupada'));
  assert.ok(prabhupada?.variants.includes('Srila-Prabhupada'));
});

test('mergeStarterGlossary preserves user entries and avoids duplicating starter entries', () => {
  const userEntry = {
    id: 'custom',
    variants: ['Maypur'],
    source: 'Custom Mayapur',
    translation: 'Пользовательский Майяпур',
    category: 'Custom',
    remember: true,
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z',
  };
  const merged = mergeStarterGlossary([userEntry, STARTER_GLOSSARY[0]]);
  assert.equal(merged.filter((entry) => entry.id === STARTER_GLOSSARY[0].id).length, 1);
  assert.equal(merged[0], userEntry);
});
