import test from 'node:test';
import assert from 'node:assert/strict';
import { activeWordIndex, formatPlaybackClock, normalizeRelativeTimestamps, parseKaraokeLines } from './karaoke';

test('formatPlaybackClock renders absolute playback time', () => {
  assert.equal(formatPlaybackClock(595), '09:55');
  assert.equal(formatPlaybackClock(3661), '01:01:01');
});

test('parseKaraokeLines reads absolute timestamps and derives line ends', () => {
  const lines = parseKaraokeLines('[09:55] First line\n\n[10:04] Second line', 595, 660);

  assert.equal(lines.length, 2);
  assert.equal(lines[0].kind, 'timed');
  assert.equal(lines[1].kind, 'timed');
  if (lines[0].kind !== 'timed' || lines[1].kind !== 'timed') {
    throw new Error('Expected timed karaoke lines');
  }
  assert.equal(lines[0].startSec, 595);
  assert.equal(lines[0].endSec, 604);
  assert.equal(lines[1].startSec, 604);
  assert.equal(lines[1].endSec, 660);
});

test('parseKaraokeLines splits dense caption scripts without blank lines', () => {
  const lines = parseKaraokeLines(
    '[04:56] The spiritual city,\n[04:59] is the spiritual character\n[05:03] of His residence.',
    296,
    310
  );

  assert.equal(lines.length, 3);
  assert.equal(lines[0].kind, 'timed');
  assert.equal(lines[1].kind, 'timed');
  assert.equal(lines[2].kind, 'timed');
  if (lines[0].kind !== 'timed' || lines[1].kind !== 'timed' || lines[2].kind !== 'timed') {
    throw new Error('Expected timed karaoke lines');
  }
  assert.equal(lines[0].text, 'The spiritual city,');
  assert.equal(lines[0].endSec, 299);
  assert.equal(lines[1].text, 'is the spiritual character');
  assert.equal(lines[1].endSec, 303);
  assert.equal(lines[2].text, 'of His residence.');
});

test('parseKaraokeLines offsets relative API timestamps inside later chunks', () => {
  const lines = parseKaraokeLines('[00:00] First line\n\n[00:08] Second line', 595, 660);

  assert.equal(lines.length, 2);
  assert.equal(lines[0].kind, 'timed');
  assert.equal(lines[1].kind, 'timed');
  if (lines[0].kind !== 'timed' || lines[1].kind !== 'timed') {
    throw new Error('Expected timed karaoke lines');
  }
  assert.equal(lines[0].timestamp, '09:55');
  assert.equal(lines[0].startSec, 595);
  assert.equal(lines[0].endSec, 603);
  assert.equal(lines[1].timestamp, '10:03');
  assert.equal(lines[1].startSec, 603);
  assert.equal(lines[1].endSec, 660);
});

test('normalizeRelativeTimestamps stores absolute markers for later chunks', () => {
  assert.equal(
    normalizeRelativeTimestamps('[00:00] First line\n\n[00:08] Second line', 595, 660),
    '[09:55] First line\n\n[10:03] Second line'
  );
  assert.equal(
    normalizeRelativeTimestamps('[09:55] First line', 595, 660),
    '[09:55] First line'
  );
});

test('activeWordIndex estimates the spoken word inside the active segment', () => {
  assert.equal(activeWordIndex(['one', 'two', 'three', 'four'], 10, 20, 10), 0);
  assert.equal(activeWordIndex(['one', 'two', 'three', 'four'], 10, 20, 15), 2);
  assert.equal(activeWordIndex(['one', 'two', 'three', 'four'], 10, 20, 19.9), 3);
  assert.equal(activeWordIndex(['one', 'two'], 10, 20, 21), -1);
});
