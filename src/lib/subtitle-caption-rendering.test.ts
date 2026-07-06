import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

test('visual editor and HyperFrames captions use antialiased text stroke instead of shadow-ring outlines', () => {
  const previewSource = readFileSync('src/components/subtitle-alignment/SubtitleAlignmentEditor.tsx', 'utf8');
  const rendererSource = readFileSync('electron/hyperframes-renderer.js', 'utf8');

  assert.doesNotMatch(previewSource, /const steps = 16[\s\S]*shadows\.push/);
  assert.doesNotMatch(rendererSource, /const steps = 16[\s\S]*shadows\.push/);

  assert.match(previewSource, /WebkitTextStroke:\s*textStroke > 0/);
  assert.match(rendererSource, /style\.webkitTextStroke = textStroke > 0/);
});
