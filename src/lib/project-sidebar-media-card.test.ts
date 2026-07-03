import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

const projectPath = (...parts: string[]) => path.join(process.cwd(), ...parts);
const appSource = () => fs.readFileSync(projectPath('src', 'App.tsx'), 'utf8');
const cssSource = () => fs.readFileSync(projectPath('src', 'index.css'), 'utf8');

function cssRule(selector: string): string {
  const escaped = selector.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return cssSource().match(new RegExp(`${escaped}\\s*\\{[^}]+\\}`))?.[0] ?? '';
}

test('project source media card renders above the chunk grid in the expanded sidebar item', () => {
  const source = appSource();

  assert.match(source, /className="project-expanded-body"/);
  assert.match(source, /className="project-media-card"/);
  assert.match(source, /className="project-chunk-grid"/);
  assert.ok(
    source.indexOf('className="project-media-card"') < source.indexOf('className="project-chunk-grid"'),
    'source media details must appear before chunk buttons'
  );
  assert.doesNotMatch(source, /className="project-media-card"\s+style=\{\{/);
});

test('project source media card uses clipped path and compact action styles from CSS', () => {
  const expandedBodyRule = cssRule('.project-expanded-body');
  const pathRule = cssRule('.project-media-path');
  const actionsRule = cssRule('.project-media-actions');

  assert.match(expandedBodyRule, /grid-column:\s*1\s*\/\s*-1/);
  assert.match(pathRule, /white-space:\s*nowrap/);
  assert.match(pathRule, /overflow:\s*hidden/);
  assert.match(pathRule, /text-overflow:\s*ellipsis/);
  assert.doesNotMatch(pathRule, /word-break:\s*break-all/);
  assert.match(actionsRule, /display:\s*flex/);
});
