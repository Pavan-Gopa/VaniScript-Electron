import test from 'node:test';
import assert from 'node:assert/strict';
import {
  cuesToAlignedSegments,
  mergeSegmentWithNext,
  moveWordToAdjacentSegment,
  splitSegment,
  updateSegmentText,
} from './subtitle-alignment';

test('cuesToAlignedSegments creates editable segments with inferred words', () => {
  const segments = cuesToAlignedSegments([
    { startSec: 1, endSec: 3, text: 'Krishna speaks' },
  ], 10);

  assert.equal(segments.length, 1);
  assert.equal(segments[0].start, 1);
  assert.equal(segments[0].end, 3);
  assert.deepEqual(segments[0].words.map((word) => word.text), ['Krishna', 'speaks']);
});

test('subtitle editing helpers update, split, merge, and move words', () => {
  const segments = cuesToAlignedSegments([
    { startSec: 0, endSec: 2, text: 'Krishna is speaking about' },
    { startSec: 2, endSec: 4, text: 'Bhagavad Gita' },
  ], 6);

  const moved = moveWordToAdjacentSegment(segments, segments[0].id, 3, 'next', 6);
  assert.equal(moved[0].text, 'Krishna is speaking');
  assert.equal(moved[1].text, 'about Bhagavad Gita');

  const updated = updateSegmentText(moved, moved[0].id, 'Krishna speaks', 6);
  assert.equal(updated[0].text, 'Krishna speaks');

  const split = splitSegment(updated, updated[1].id, 6);
  assert.equal(split.length, 3);

  const merged = mergeSegmentWithNext(split, split[1].id, 6);
  assert.equal(merged.length, 2);
  assert.equal(merged[1].text, 'about Bhagavad Gita');
});

test('updateSegmentText preserves deliberate line breaks while editing', () => {
  const segments = cuesToAlignedSegments([
    { startSec: 0, endSec: 3, text: 'Take shelter of Krishna' },
  ], 5);

  const updated = updateSegmentText(segments, segments[0].id, 'Take shelter\nof Krishna', 5);

  assert.equal(updated[0].text, 'Take shelter\nof Krishna');
  assert.deepEqual(updated[0].words.map((word) => word.text), ['Take', 'shelter', 'of', 'Krishna']);
});
