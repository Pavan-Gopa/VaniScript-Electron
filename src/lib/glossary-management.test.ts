import test from 'node:test';
import assert from 'node:assert/strict';
import { GlossaryEntry } from '../types';
import { filterGlossaryEntries, joinGlossaryEntries, listGlossaryCategories, sortGlossaryEntries } from './glossary-management';

const entries: GlossaryEntry[] = [
  {
    id: '2',
    variants: ['Japataki Maharaja'],
    source: 'Jayapataka Maharaja',
    translation: 'Джаяпатака Махарадж',
    category: 'Acharyas / Teachers',
    translations: { Russian: 'Джаяпатака Махарадж' },
    remember: true,
    createdAt: '2026-01-02T00:00:00.000Z',
    updatedAt: '2026-01-02T00:00:00.000Z',
  },
  {
    id: '1',
    variants: ['Maypur'],
    source: 'Mayapur',
    translation: 'Майяпур',
    category: 'Sacred places',
    translations: { Russian: 'Майяпур' },
    remember: true,
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z',
  },
];

test('joinGlossaryEntries merges selected variants and language translations', () => {
  const joined = joinGlossaryEntries(entries, ['1', '2']);

  assert.equal(joined.length, 1);
  assert.equal(joined[0].source, 'Mayapur');
  assert.deepEqual(joined[0].variants, ['Maypur', 'Japataki Maharaja']);
  assert.deepEqual(joined[0].translations, { Russian: 'Майяпур' });
});

test('joinGlossaryEntries keeps correct source and translation out of wrong variants', () => {
  const joined = joinGlossaryEntries([
    {
      id: '1',
      variants: ['Шичиттани'],
      source: 'Shri Chaitanya',
      translation: 'Шри Чайтанья',
      translations: { Russian: 'Шри Чайтанья' },
      remember: true,
      createdAt: '2026-01-01T00:00:00.000Z',
      updatedAt: '2026-01-01T00:00:00.000Z',
    },
    {
      id: '2',
      variants: ['Sri Chaitanya'],
      source: 'Shri Chaitanya',
      translation: 'Шри Чайтанья',
      translations: { Russian: 'Шри Чайтанья' },
      remember: true,
      createdAt: '2026-01-02T00:00:00.000Z',
      updatedAt: '2026-01-02T00:00:00.000Z',
    },
  ], ['1', '2']);

  assert.deepEqual(joined[0].variants, ['Шичиттани', 'Sri Chaitanya']);
  assert.equal(joined[0].source, 'Shri Chaitanya');
  assert.equal(joined[0].translation, 'Шри Чайтанья');
});

test('filterGlossaryEntries searches source, variants, and translations', () => {
  assert.deepEqual(filterGlossaryEntries(entries, 'japataki').map((entry) => entry.id), ['2']);
  assert.deepEqual(filterGlossaryEntries(entries, 'Майя').map((entry) => entry.id), ['1']);
});

test('filterGlossaryEntries can filter by category after searching variants', () => {
  assert.deepEqual(filterGlossaryEntries(entries, '', 'Sacred places').map((entry) => entry.id), ['1']);
  assert.deepEqual(filterGlossaryEntries(entries, 'maharaja', 'Sacred places').map((entry) => entry.id), []);
  assert.deepEqual(filterGlossaryEntries(entries, 'maharaja', 'Acharyas / Teachers').map((entry) => entry.id), ['2']);
});

test('listGlossaryCategories returns sorted category labels', () => {
  assert.deepEqual(listGlossaryCategories(entries), ['Acharyas / Teachers', 'Sacred places']);
});

test('sortGlossaryEntries sorts by alphabet and dates', () => {
  assert.deepEqual(sortGlossaryEntries(entries, 'alphabetical').map((entry) => entry.id), ['2', '1']);
  assert.deepEqual(sortGlossaryEntries(entries, 'oldest').map((entry) => entry.id), ['1', '2']);
  assert.deepEqual(sortGlossaryEntries(entries, 'newest').map((entry) => entry.id), ['2', '1']);
});
