import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';

test('electron contract exposes local transcription and model lifecycle methods', () => {
  const preload = fs.readFileSync('/Users/pavan/Documents/smartscribe/VaniScript/electron/preload.js', 'utf8');
  const main = fs.readFileSync('/Users/pavan/Documents/smartscribe/VaniScript/electron/main.js', 'utf8');
  assert.match(preload, /localInstallAsrModel/);
  assert.match(preload, /localRemoveAsrModel/);
  assert.match(preload, /localTranscribeChunk/);
  assert.match(preload, /pathToFileUrl/);
  assert.match(preload, /localInstallTranslationModel/);
  assert.match(preload, /localRemoveTranslationModel/);
  assert.match(preload, /localTranslateText/);
  assert.match(preload, /localGetModelDownloadStatus/);
  assert.match(preload, /onLocalModelDownloadProgress/);
  assert.match(preload, /getSystemMemoryInfo/);
  assert.match(main, /const os = require\('os'\)/);
  assert.match(main, /system:getMemoryInfo/);
});
