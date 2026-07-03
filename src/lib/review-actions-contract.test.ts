import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

const appSource = () => fs.readFileSync(path.join(process.cwd(), 'src', 'App.tsx'), 'utf8');

test('review toolbar exposes try transcription for the current chunk', () => {
  const source = appSource();

  assert.match(source, /const handleRetranscribeCurrent = \(\) =>/);
  assert.match(source, /handleRetry\(session\.currentIndex\)/);
  assert.match(source, /Try Transcription/);
});

test('retry transcription resets approval before reprocessing', () => {
  const source = appSource();

  assert.match(source, /approved: false,\s*status: 'pending'/);
});

test('review toolbar exposes retry translation for the current chunk', () => {
  const source = appSource();

  assert.match(source, /const handleRetryTranslation = async \(\) =>/);
  assert.match(source, /translateWithProvider\(chunk\.original, activeConfig\)/);
  assert.match(source, /Retry Translation/);
});
