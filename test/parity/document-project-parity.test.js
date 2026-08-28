'use strict';

/**
 * P4.D4 Slice 2 — document-project-v3-multilang parity test (binding §3 with
 * Errata wire names, §6 Slice 2).
 *
 * Loads the committed shared fixture, runs the real Electron session
 * normalizer (`normalizeImportedProjectSession`, the same decode the bundle
 * importer uses), and applies the §3 semantic comparator: schemaVersion 3,
 * project id/name exact, session sourceKind, and assetManifest entries keyed
 * by key with role/originalFileName/sha256/size; chunks matched by ordinal
 * (index, filePath, durationSec, startSec, endSec, original, translated,
 * status, approved; originalCues length; translationsByLanguage keyed
 * lowercased with per-language text + approved comparison). A negative case
 * mutates an in-memory fixture copy and requires the comparator to fail.
 */

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const {
  normalizeImportedProjectSession,
} = require('../../electron/project-session.js');
const { compareDocumentProject } = require('../parity/comparators.mjs');

const FIXTURE_PATH = path.join(
  __dirname,
  '..',
  'fixtures',
  'parity',
  'document-project-v3-multilang.json',
);

function loadFixture() {
  return JSON.parse(fs.readFileSync(FIXTURE_PATH, 'utf8'));
}

/**
 * Decode the metadata-only document manifest into the binding wire shape.
 * The real manifest record decoder is exercised by the streamingBundle Part B
 * test in archive-manifest-parity.test.js; this family only receives the
 * document metadata and runs it through the real session normalizer above.
 */
function decodeAssetManifest(document) {
  const entries = Array.isArray(document?.assetManifest?.entries)
    ? document.assetManifest.entries
    : [];
  return {
    entries: entries.map((entry) => ({
      format: entry.format,
      key: entry.key,
      originalFileName: entry.originalFileName,
      role: entry.role,
      sha256: entry.sha256,
      size: entry.size,
    })),
  };
}

/** Decode a project document through the real Electron ingress normalizer. */
function decodeProjectDocument(document) {
  const session = normalizeImportedProjectSession(document.project.session);
  return {
    project: { id: session.projectId, name: document.project.name },
    session,
    assetManifest: decodeAssetManifest(document),
  };
}

test('document-project fixture declares the shared parity harness version', () => {
  assert.equal(loadFixture().fixtureVersion, 1);
});

test('document-project fixture normalizes through the real session normalizer to the same semantic content', () => {
  const fixture = loadFixture();
  assert.equal(fixture.schemaVersion, 3);
  assert.equal(fixture.format, 'vaniscript-project-v2');

  const decoded = decodeProjectDocument(fixture);
  const comparison = compareDocumentProject(fixture, decoded);
  assert.deepEqual(
    comparison.failures,
    [],
    `document-project parity comparator reported drift:\n${comparison.failures.join('\n')}`,
  );
  assert.equal(comparison.ok, true);
});

test('normalized session projects the active language exactly without borrowing', () => {
  const fixture = loadFixture();
  const session = normalizeImportedProjectSession(fixture.project.session);

  assert.equal(session.projectId, fixture.project.id);
  assert.equal(session.activeTranslationLanguage, 'Russian');

  // Chunk 0 has a Russian variant: the eager legacy projection mirrors it.
  assert.equal(
    session.chunks[0].translated,
    fixture.project.session.chunks[0].translationsByLanguage.russian.text,
  );
  // Chunk 1 has no Russian variant: blank projection, never borrowed from
  // German or from the legacy `translated` field.
  assert.equal(session.chunks[1].translated, '');
  assert.equal(session.chunks[1].translationsByLanguage.german.text,
    fixture.project.session.chunks[1].translationsByLanguage.german.text);
});

test('comparator fails when fixture chunk content is mutated', () => {
  const fixture = loadFixture();
  const mutated = structuredClone(fixture);
  mutated.project.session.chunks[0].original = 'Mutated source sentence.';
  mutated.project.session.chunks[0].translationsByLanguage.russian.text = 'Mutated russian text.';

  const decoded = decodeProjectDocument(mutated);
  const comparison = compareDocumentProject(fixture, decoded);

  assert.equal(comparison.ok, false);
  assert.ok(
    comparison.failures.some((line) => line.includes('chunks[0].original')),
    `expected a chunks[0].original failure, got:\n${comparison.failures.join('\n')}`,
  );
  assert.ok(
    comparison.failures.some((line) => line.includes('translationsByLanguage.russian.text')),
    `expected a translationsByLanguage.russian.text failure, got:\n${comparison.failures.join('\n')}`,
  );
});
