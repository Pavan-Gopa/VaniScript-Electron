import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const exportTargets = [
  'export-documents',
  'shorts-find-moments',
  'shorts-choose-clips',
  'shorts-edit-clip',
  'shorts-export-settings',
  'shorts-export-actions',
  'export-footer-actions',
];

function exportTourBlock(source: string): string {
  const match = source.match(/export:\s*\[([\s\S]*?)\],\n\s*settings:/);
  assert.ok(match, 'export onboarding block should be readable');
  return match[1];
}

test('Electron export onboarding explains Shorts/Reels workflow in detail', () => {
  const tourSource = readFileSync('src/components/OnboardingTour.tsx', 'utf8');
  const panelSource = readFileSync('src/components/ShortsReelsPanel.tsx', 'utf8');
  const appSource = readFileSync('src/App.tsx', 'utf8');
  const block = exportTourBlock(tourSource);

  for (const target of exportTargets) {
    assert.match(block, new RegExp(`\\[data-tour="${target}"\\]`), `missing export tour target ${target}`);
  }

  assert.ok((block.match(/targetSelector:/g) ?? []).length >= 7, 'export tour should have at least seven steps');
  assert.match(block, /HyperFrames/);
  assert.match(block, /Visual Editor|visual editor/);
  assert.match(block, /Edit Clip/);

  for (const target of exportTargets.slice(1, -1)) {
    assert.match(panelSource, new RegExp(`data-tour="${target}"`), `missing Shorts/Reels panel target ${target}`);
  }
  assert.match(appSource, /data-tour="export-footer-actions"/);
});
