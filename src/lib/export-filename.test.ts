import test from 'node:test';
import assert from 'node:assert/strict';
import { buildExportFileName, exportExtension } from './export-filename';

test('exportExtension uses correct extensions for all output formats', () => {
  assert.equal(exportExtension('Markdown'), 'md');
  assert.equal(exportExtension('SRT'), 'srt');
  assert.equal(exportExtension('VTT'), 'vtt');
  assert.equal(exportExtension('TXT'), 'txt');
});

test('buildExportFileName creates name from NFC source stem and target language suffix, excluding metadata', () => {
  assert.equal(
    buildExportFileName({
      sourceFileName: 'KKS_Samadhi_Mayapur_P2.mp3',
      which: 'translated',
      targetLang: 'Russian',
      format: 'Markdown',
    }),
    'KKS_Samadhi_Mayapur_P2_Russian.md',
  );
});

test('buildExportFileName produces _original suffix for original exports', () => {
  assert.equal(
    buildExportFileName({
      sourceFileName: 'KKS_Samadhi_Mayapur_P2.mp3',
      which: 'original',
      format: 'TXT',
    }),
    'KKS_Samadhi_Mayapur_P2_original.txt',
  );
});

test('buildExportFileName handles NFC unicode normalization and strips extension', () => {
  assert.equal(
    buildExportFileName({
      sourceFileName: 'Caf\u0065\u0301_Lecture.mp4',
      which: 'translated',
      targetLang: 'Fran\u00e7ais',
      format: 'SRT',
    }),
    'Caf\u00e9_Lecture_Fran\u00e7ais.srt',
  );
});

test('buildExportFileName falls back to VaniScript stem when source name is empty', () => {
  assert.equal(
    buildExportFileName({
      sourceFileName: '   ',
      which: 'original',
      format: 'VTT',
    }),
    'VaniScript_original.vtt',
  );
});

test('buildExportFileName falls back to translated suffix when target language is empty', () => {
  assert.equal(
    buildExportFileName({
      sourceFileName: 'audio.wav',
      which: 'translated',
      format: 'TXT',
    }),
    'audio_translated.txt',
  );
});
