import test from 'node:test';
import assert from 'node:assert/strict';
import { buildExportFileName, exportExtension } from './export-filename';

test('exportExtension uses md for Markdown files', () => {
  assert.equal(exportExtension('Markdown'), 'md');
  assert.equal(exportExtension('SRT'), 'srt');
});

test('buildExportFileName uses metadata and target language for translated exports', () => {
  assert.equal(
    buildExportFileName({
      sourceFileName: 'KKS_Samadhi_Mayapur_P2.mp3',
      lecturer: 'His Holiness Kadamba Kanana Swami',
      location: 'Mayapur',
      date: '2020',
      which: 'translated',
      targetLang: 'Russian',
      format: 'Markdown',
    }),
    'His_Holiness_Kadamba_Kanana_Swami_Mayapur_2020_Russian.md',
  );
});

test('buildExportFileName falls back to source stem when metadata is empty', () => {
  assert.equal(
    buildExportFileName({
      sourceFileName: 'KKS_Samadhi_Mayapur_P2.mp3',
      which: 'original',
      format: 'TXT',
    }),
    'KKS_Samadhi_Mayapur_P2_original.txt',
  );
});
