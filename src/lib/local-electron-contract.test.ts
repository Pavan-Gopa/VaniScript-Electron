import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';

test('electron contract exposes local transcription and model lifecycle methods', () => {
  const preload = fs.readFileSync('/Users/pavan/Documents/smartscribe/VaniScript/electron/preload.js', 'utf8');
  assert.match(preload, /localInstallAsrModel/);
  assert.match(preload, /localRemoveAsrModel/);
  assert.match(preload, /localTranscribeChunk/);
});
