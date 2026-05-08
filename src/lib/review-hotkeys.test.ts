import test from 'node:test';
import assert from 'node:assert/strict';
import { acceleratedSeekStep, bestTimedNavigationContent, shouldIgnoreReviewHotkeyTarget, nextTimedLineStart } from './review-hotkeys';

test('acceleratedSeekStep increases seek size when an arrow key is held', () => {
  assert.equal(acceleratedSeekStep(false, 0), 1);
  assert.equal(acceleratedSeekStep(true, 3), 1);
  assert.equal(acceleratedSeekStep(true, 6), 3);
  assert.equal(acceleratedSeekStep(true, 14), 5);
});

test('nextTimedLineStart moves through timed fragments by current playback time', () => {
  const lines = [
    { kind: 'timed' as const, startSec: 10, endSec: 20, timestamp: '00:10', text: 'A', words: ['A'] },
    { kind: 'timed' as const, startSec: 20, endSec: 30, timestamp: '00:20', text: 'B', words: ['B'] },
    { kind: 'timed' as const, startSec: 30, endSec: 40, timestamp: '00:30', text: 'C', words: ['C'] },
  ];

  assert.equal(nextTimedLineStart(lines, 19, 1), 20);
  assert.equal(nextTimedLineStart(lines, 20, 1), 30);
  assert.equal(nextTimedLineStart(lines, 20, -1), 10);
  assert.equal(nextTimedLineStart(lines, 3, -1), 10);
  assert.equal(nextTimedLineStart(lines, 99, 1), 30);
});

test('nextTimedLineStart can step from an exact line start without jumping to the top', () => {
  const lines = [
    { kind: 'timed' as const, startSec: 595, endSec: 604, timestamp: '09:55', text: 'A', words: ['A'] },
    { kind: 'timed' as const, startSec: 604, endSec: 608, timestamp: '10:04', text: 'B', words: ['B'] },
    { kind: 'timed' as const, startSec: 608, endSec: 615, timestamp: '10:08', text: 'C', words: ['C'] },
  ];

  assert.equal(nextTimedLineStart(lines, 595, 1), 604);
  assert.equal(nextTimedLineStart(lines, 604, 1), 608);
  assert.equal(nextTimedLineStart(lines, 604, -1), 595);
});

test('nextTimedLineStart snaps near a marker boundary so up and down do not stall or skip', () => {
  const lines = [
    { kind: 'timed' as const, startSec: 595, endSec: 604, timestamp: '09:55', text: 'A', words: ['A'] },
    { kind: 'timed' as const, startSec: 604, endSec: 608, timestamp: '10:04', text: 'B', words: ['B'] },
    { kind: 'timed' as const, startSec: 608, endSec: 615, timestamp: '10:08', text: 'C', words: ['C'] },
  ];

  assert.equal(nextTimedLineStart(lines, 603.96, 1), 608);
  assert.equal(nextTimedLineStart(lines, 607.96, -1), 604);
});

test('bestTimedNavigationContent falls back to translated text only when source has no timings', () => {
  assert.equal(bestTimedNavigationContent('[00:01] Source', '[00:01] Translation'), '[00:01] Source');
  assert.equal(bestTimedNavigationContent('Source without markers', '[00:01] Translation'), '[00:01] Translation');
});

test('shouldIgnoreReviewHotkeyTarget ignores text entry controls but not the audio range input', () => {
  assert.equal(shouldIgnoreReviewHotkeyTarget({ tagName: 'INPUT', type: 'text' }), true);
  assert.equal(shouldIgnoreReviewHotkeyTarget({ tagName: 'INPUT', type: 'range' }), false);
  assert.equal(shouldIgnoreReviewHotkeyTarget({ tagName: 'TEXTAREA' }), true);
  assert.equal(shouldIgnoreReviewHotkeyTarget({ tagName: 'BUTTON' }), false);
});
