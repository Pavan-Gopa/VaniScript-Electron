'use strict';

/**
 * P3E.D3-S3 wiring contract for the live project/library bundle IPC surface.
 *
 * main.js cannot be required under plain node (it loads Electron and starts
 * process-level services at require time), so these tests assert the
 * observable handler contract against the real source using a small
 * brace-aware handler extractor: exactly one hardened streaming-bundle
 * service singleton, awaited service calls from the export/exportAll/import
 * handlers, exact dialog defaults/filters/cancellation strings, renderer-
 * visible success/error projections, and zero leftover private streaming
 * implementation.
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const MAIN_SOURCE = fs.readFileSync(
  path.join(__dirname, '..', 'electron', 'main.js'),
  'utf8',
);

/** Extracts the balanced-brace body of one `ipcMain.handle(channel, ...)`
 * handler, or returns null when the channel is not registered. */
function extractHandlerBody(source, channel) {
  const marker = `ipcMain.handle('${channel}',`;
  const start = source.indexOf(marker);
  if (start === -1) return null;
  const arrow = source.indexOf('=>', start);
  assert.ok(arrow !== -1, `${channel} handler uses an arrow function`);
  const open = source.indexOf('{', arrow);
  assert.ok(open !== -1, `${channel} handler has a block body`);
  let depth = 0;
  for (let i = open; i < source.length; i++) {
    if (source[i] === '{') depth += 1;
    else if (source[i] === '}') {
      depth -= 1;
      if (depth === 0) return source.slice(open + 1, i);
    }
  }
  throw new Error(`Unbalanced handler body for ${channel}`);
}

function occurrences(haystack, needle) {
  let count = 0;
  let at = haystack.indexOf(needle);
  while (at !== -1) {
    count += 1;
    at = haystack.indexOf(needle, at + needle.length);
  }
  return count;
}

// ─── Singleton wiring ─────────────────────────────────────────────────────────

test('main wires exactly one streaming bundle service singleton', () => {
  assert.equal(
    occurrences(MAIN_SOURCE, "require('./main/projects/streamingBundle')"),
    1,
    'exactly one factory module import',
  );
  assert.equal(
    occurrences(MAIN_SOURCE, 'createStreamingBundleService'),
    2,
    'exactly one import binding plus one construction',
  );

  const construction = MAIN_SOURCE.match(
    /createStreamingBundleService\(\{\s*projectsRootDir,\s*newProjectId,\s*\}\)/,
  );
  assert.ok(
    construction,
    'singleton constructed once with only { projectsRootDir, newProjectId }',
  );
  assert.ok(
    construction.index < MAIN_SOURCE.indexOf('streamingBundleService.'),
    'singleton is constructed before its first use',
  );
  assert.ok(
    /\bconst\s+streamingBundleService\s*=\s*createStreamingBundleService\(/.test(
      MAIN_SOURCE,
    ),
    'singleton lives at module scope',
  );

  for (const channel of ['project:export', 'project:exportAll', 'project:import']) {
    const body = extractHandlerBody(MAIN_SOURCE, channel);
    assert.ok(body, `${channel} is registered`);
    assert.equal(
      occurrences(body, 'createStreamingBundleService'),
      0,
      `${channel} never constructs the factory per call`,
    );
  }
});

// ─── project:export ───────────────────────────────────────────────────────────

test('project:export awaits the singleton writer with unchanged dialog contract', () => {
  const body = extractHandlerBody(MAIN_SOURCE, 'project:export');

  assert.ok(body.includes('const project = readProject(id);'));
  assert.ok(
    body.indexOf('readProject(id)') < body.indexOf('dialog.showSaveDialog'),
    'readProject timing preserved: project is read before the save dialog',
  );
  assert.ok(
    body.includes(
      "defaultPath: `${safeName(project.name || project.session?.sourceFileName || 'VaniScript Project')}.vaniscript`,",
    ),
    'default filename preserved',
  );
  assert.ok(
    body.includes("filters: [{ name: 'VaniScript Project', extensions: ['vaniscript'] }],"),
    'save filter preserved',
  );
  assert.ok(
    body.includes(
      "if (result.canceled || !result.filePath) return { ok: false, error: 'Export cancelled' };",
    ),
    'cancellation projection preserved',
  );
  assert.ok(
    body.includes('await streamingBundleService.writeProjectBundle(project, result.filePath);'),
    'write is an awaited singleton service call',
  );
  assert.ok(
    body.indexOf("'Export cancelled'") <
      body.indexOf('streamingBundleService.writeProjectBundle('),
    'cancellation short-circuits before the bundle write',
  );
  assert.ok(
    body.includes('return { ok: true, filePath: result.filePath };'),
    'success projection preserved',
  );
  assert.ok(
    body.includes('return { ok: false, error: error.message || String(error) };'),
    'caught-error projection preserved',
  );
});

// ─── project:exportAll ────────────────────────────────────────────────────────

test('project:exportAll awaits the singleton library writer with unchanged dialog contract', () => {
  const body = extractHandlerBody(MAIN_SOURCE, 'project:exportAll');

  assert.ok(
    body.includes('const projects = listProjects().map((summary) => readProject(summary.id));'),
  );
  assert.ok(
    body.indexOf('listProjects()') < body.indexOf('dialog.showSaveDialog'),
    'library is collected before the save dialog',
  );
  assert.ok(
    body.includes("defaultPath: 'VaniScript Library.vaniscript-library',"),
    'library default filename preserved',
  );
  assert.ok(
    body.includes("filters: [{ name: 'VaniScript Library', extensions: ['vaniscript-library'] }],"),
    'library save filter preserved',
  );
  assert.ok(
    body.includes(
      "if (result.canceled || !result.filePath) return { ok: false, error: 'Export cancelled' };",
    ),
    'cancellation projection preserved',
  );
  assert.ok(
    body.includes('await streamingBundleService.writeLibraryBundle(projects, result.filePath);'),
    'library write is an awaited singleton service call',
  );
  assert.ok(
    body.includes('return { ok: true, filePath: result.filePath };'),
    'success projection preserved',
  );
  assert.ok(
    body.includes('return { ok: false, error: error.message || String(error) };'),
    'caught-error projection preserved',
  );
});

// ─── project:import ───────────────────────────────────────────────────────────

test('project:import delegates entirely to one awaited unified service call', () => {
  const body = extractHandlerBody(MAIN_SOURCE, 'project:import');

  assert.ok(body.includes("properties: ['openFile'],"));
  assert.ok(
    body.includes(
      "{ name: 'VaniScript Projects', extensions: ['vaniscript', 'vaniscript-library'] },",
    ),
    'open filters preserved',
  );
  assert.ok(body.includes("{ name: 'All Files', extensions: ['*'] },"));
  assert.ok(
    body.includes(
      "if (result.canceled || !result.filePaths[0]) return { ok: false, error: 'Import cancelled' };",
    ),
    'cancellation projection preserved',
  );
  assert.ok(
    body.indexOf('dialog.showOpenDialog') < body.indexOf("'Import cancelled'") &&
      body.indexOf("'Import cancelled'") < body.indexOf('streamingBundleService.importBundle('),
    'dialog then cancellation gate then service call',
  );

  assert.equal(
    occurrences(body, 'streamingBundleService.'),
    1,
    'exactly one service interaction',
  );
  assert.ok(
    body.includes(
      'const importedProjects = await streamingBundleService.importBundle(filePath);',
    ),
    'unified import is one awaited service call',
  );
  assert.ok(
    body.includes('return { ok: true, project: importedProjects[0] || null };'),
    'first project is projected; empty library imports stay null',
  );
  assert.ok(
    body.includes('return { ok: false, error: error.message || String(error) };'),
    'caught-error projection preserved',
  );

  // No header probing, JSON sniffing, or temp-file round-trips remain in the
  // live import handler.
  for (const banned of [
    'openSync',
    'readSync',
    'statSync',
    'magicBuf',
    'headerStr',
    'JSON.parse',
    'writeFileSync',
    'unlinkSync',
    "getPath('temp')",
  ]) {
    assert.ok(!body.includes(banned), `import handler has no ${banned}`);
  }
});

// ─── Obsolete implementation removal ─────────────────────────────────────────

test('obsolete private streaming implementations are fully removed from main', () => {
  for (const gone of [
    'function isDuplicateMedia(',
    'function collectProjectAssets(',
    'function writeProjectBundle(',
    'function importProjectBundle(',
    'function writeLibraryBundle(',
    'function importLibraryBundle(',
  ]) {
    assert.ok(!MAIN_SOURCE.includes(gone), `no declaration left: ${gone}`);
  }

  // Every surviving bundle call token is singleton-qualified; no unqualified
  // callers remain anywhere in the file.
  const withoutSingletonCalls = MAIN_SOURCE.replace(
    /streamingBundleService\.(?:writeProjectBundle|writeLibraryBundle|importProjectBundle|importLibraryBundle|importBundle)\(/g,
    '',
  );
  for (const gone of [
    'writeProjectBundle(',
    'writeLibraryBundle(',
    'importProjectBundle(',
    'importLibraryBundle(',
    'importBundle(',
  ]) {
    assert.ok(!withoutSingletonCalls.includes(gone), `no unqualified ${gone} caller`);
  }
  assert.ok(!MAIN_SOURCE.includes('collectProjectAssets('));
  assert.ok(!MAIN_SOURCE.includes('isDuplicateMedia('));

  // The canonical session normalizer stays wired for project:load.
  assert.ok(
    MAIN_SOURCE.includes('normalizeImportedProjectSession'),
    'canonical normalizer import retained',
  );
});
