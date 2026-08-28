'use strict';

/**
 * P4.D4 Slice 2 — semantic comparators for the cross-edition parity fixtures.
 *
 * Implements binding §3 (AI_Workflow_Kit/docs/bindings/p4d4-binding.md) with
 * the Errata applied: fixture field names are ground truth; §3 field lists
 * are intent, not literal schemas (no `speakerLabel`; manifest entries use
 * `originalFileName`/`size` per the real wire models).
 *
 * Universal comparator rules (§3):
 *   1. Both sides are plain parsed objects (this module never touches bytes).
 *   2. Only the fields listed in each family's comparison spec are compared.
 *   3. Key ordering, whitespace, nil-vs-absent, and transient fields
 *      (`selectedShortsPlanIndexes`, UI state) are ignored — transients never
 *      appear in a spec, so they are excluded by construction.
 *   4. Language keys are compared case-insensitively (lowercased first).
 *   5. ISO-8601 timestamps are normalized to UTC millisecond precision.
 *   6. stableIDs are opaque; TimelineCut cuts are matched by their
 *      (startSec, endSec) tuple and stableID uniqueness within a plan is
 *      validated as a separate structural invariant (absent IDs allowed).
 *
 * Every comparator returns `{ ok, failures }` where `failures` holds one
 * human-readable line per divergence, so parity tests can point at the exact
 * field that drifted. Zero npm dependencies.
 */

/** §3 settings-current: environment-specific keys excluded from comparison. */
const ENVIRONMENT_SETTINGS_KEYS = Object.freeze([
  'lastOpenedAt',
  'windowBounds',
  'recentProjects',
]);

/** Fixture envelope marker (binding §1) — not part of any edition's model. */
const FIXTURE_ENVELOPE_KEY = 'fixtureVersion';

const ISO_TIMESTAMP_PATTERN = /^\d{4}-\d{2}-\d{2}[Tt ]/;

const MANIFEST_ENTRY_FIELDS = Object.freeze([
  'role',
  'format',
  'originalFileName',
  'sha256',
  'size',
]);
const DOCUMENT_MANIFEST_ENTRY_FIELDS = Object.freeze([
  'role',
  'originalFileName',
  'sha256',
  'size',
]);


const PROJECTION_FIELDS = Object.freeze([
  'available',
  'languageKey',
  'title',
  'summary',
  'hook',
  'category',
  'captionText',
]);

const CLIP_RANGE_FIELDS = Object.freeze([
  'startSec',
  'endSec',
]);

const CHUNK_FIELDS = Object.freeze([
  'index',
  'filePath',
  'durationSec',
  'startSec',
  'endSec',
  'original',
  'translated',
  'status',
  'approved',
]);

function isPlainObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function languageKey(value) {
  return typeof value === 'string' ? value.toLowerCase() : value;
}

/** §3 rule 5: ISO-8601 strings compare at UTC millisecond precision. */
function normalizeTimestamp(value) {
  if (typeof value !== 'string' || !ISO_TIMESTAMP_PATTERN.test(value)) return value;
  const ms = Date.parse(value);
  return Number.isNaN(ms) ? value : new Date(ms).toISOString();
}

/**
 * Universal leaf comparison: nil-vs-absent tolerated (§3 rule 3), ISO-8601
 * strings normalized (rule 5), arrays compared order-sensitively, everything
 * else by strict equality.
 */
function leafValuesEqual(a, b) {
  const nilA = a === undefined || a === null;
  const nilB = b === undefined || b === null;
  if (nilA || nilB) return nilA && nilB;
  if (Array.isArray(a) || Array.isArray(b)) {
    return Array.isArray(a) && Array.isArray(b)
      && JSON.stringify(a) === JSON.stringify(b);
  }
  if (typeof a === 'string' && typeof b === 'string') {
    return normalizeTimestamp(a) === normalizeTimestamp(b);
  }
  return a === b;
}

function createReport() {
  const failures = [];
  return {
    failures,
    fail(message) {
      failures.push(message);
    },
    ok() {
      return failures.length === 0;
    },
  };
}

// ─── settings-current ────────────────────────────────────────────────────────

/**
 * §3 settings-current: deep-equal on all fixture keys (schemaVersion included)
 * except the §3-named environment fields. The walk is fixture-directed, so
 * decoder-added defaults never fail the comparison while any dropped or
 * mutated fixture value does. `fixtureVersion` is the fixture envelope marker
 * (binding §1), validated by the harness, not a settings field.
 */
export function compareSettings(fixtureSettings, decodedSettings) {
  const report = createReport();
  if (!isPlainObject(fixtureSettings) || !isPlainObject(decodedSettings)) {
    report.fail('settings: both sides must be plain objects');
    return { ok: false, failures: report.failures };
  }
  walkSettings(fixtureSettings, decodedSettings, '', report);
  return { ok: report.ok(), failures: report.failures };
}

function walkSettings(expected, actual, path, report) {
  for (const key of Object.keys(expected)) {
    if (path === ''
      && (key === FIXTURE_ENVELOPE_KEY || ENVIRONMENT_SETTINGS_KEYS.includes(key))) {
      continue;
    }
    const expectedValue = expected[key];
    const actualValue = actual?.[key];
    const childPath = path ? `${path}.${key}` : key;
    if (isPlainObject(expectedValue) && isPlainObject(actualValue)) {
      walkSettings(expectedValue, actualValue, childPath, report);
    } else if (!leafValuesEqual(expectedValue, actualValue)) {
      report.fail(
        `settings: ${childPath}: expected ${JSON.stringify(expectedValue)},`
        + ` decoded ${JSON.stringify(actualValue)}`,
      );
    }
  }
}

// ─── document-project-v3-multilang ───────────────────────────────────────────

/**
 * §3 document-project (Errata wire names). `decodedDoc` is the Electron decode
 * of the project envelope: `{ project: { id, name }, session }` where
 * `session` is the output of the real `normalizeImportedProjectSession`.
 * Chunks match by ordinal; translationsByLanguage matches by lowercased
 * language key with per-variant text + approved (nil-tolerant) + updatedAt
 * (timestamp-normalized) comparison, per the actual fixture variant shape.
 */
export function compareDocumentProject(fixtureDoc, decodedDoc) {
  const report = createReport();
  if (!isPlainObject(fixtureDoc) || !isPlainObject(decodedDoc)) {
    report.fail('document-project: both sides must be plain objects');
    return { ok: false, failures: report.failures };
  }
  if (fixtureDoc.schemaVersion !== 3) {
    report.fail(`document-project: fixture schemaVersion must be 3, got ${JSON.stringify(fixtureDoc.schemaVersion)}`);
  }
  if (fixtureDoc.format !== 'vaniscript-project-v2') {
    report.fail(`document-project: fixture format must be "vaniscript-project-v2", got ${JSON.stringify(fixtureDoc.format)}`);
  }
  const expectedProject = isPlainObject(fixtureDoc.project) ? fixtureDoc.project : {};
  const actualProject = isPlainObject(decodedDoc.project) ? decodedDoc.project : {};
  if (expectedProject.id !== actualProject.id) {
    report.fail(`document-project: project.id: expected ${JSON.stringify(expectedProject.id)}, decoded ${JSON.stringify(actualProject.id)}`);
  }
  if (expectedProject.name !== actualProject.name) {
    report.fail(`document-project: project.name: expected ${JSON.stringify(expectedProject.name)}, decoded ${JSON.stringify(actualProject.name)}`);
  }
  const expectedSession = isPlainObject(expectedProject.session) ? expectedProject.session : {};
  const actualSession = isPlainObject(decodedDoc.session) ? decodedDoc.session : {};
  if (!leafValuesEqual(expectedSession.sourceKind, actualSession.sourceKind)) {
    report.fail(
      `document-project: session.sourceKind: expected ${JSON.stringify(expectedSession.sourceKind)},`
      + ` decoded ${JSON.stringify(actualSession.sourceKind)}`,
    );
  }
  const expectedManifest = indexManifestEntries(
    fixtureDoc.assetManifest,
    'fixture',
    report,
    'document-project',
  );
  const actualManifest = indexManifestEntries(
    decodedDoc.assetManifest,
    'decoded',
    report,
    'document-project',
  );
  for (const [key, expected] of expectedManifest) {
    const actual = actualManifest.get(key);
    if (!actual) {
      report.fail(`document-project: missing decoded entry for key "${key}"`);
      continue;
    }
    for (const field of DOCUMENT_MANIFEST_ENTRY_FIELDS) {
      if (!leafValuesEqual(expected[field], actual[field])) {
        report.fail(
          `document-project: entry "${key}".${field}: expected`
          + ` ${JSON.stringify(expected[field])}, decoded ${JSON.stringify(actual[field])}`,
        );
      }
    }
  }
  for (const key of actualManifest.keys()) {
    if (!expectedManifest.has(key)) {
      report.fail(`document-project: unexpected decoded entry for key "${key}"`);
    }
  }
  const expectedChunks = Array.isArray(expectedSession.chunks) ? expectedSession.chunks : [];
  const actualChunks = Array.isArray(actualSession.chunks) ? actualSession.chunks : [];
  if (expectedChunks.length !== actualChunks.length) {
    report.fail(`document-project: chunk count: expected ${expectedChunks.length}, decoded ${actualChunks.length}`);
  }
  const ordinalCount = Math.min(expectedChunks.length, actualChunks.length);
  for (let i = 0; i < ordinalCount; i++) {
    compareDocumentChunk(expectedChunks[i], actualChunks[i], i, report);
  }
  return { ok: report.ok(), failures: report.failures };
}

function compareDocumentChunk(expected, actual, ordinal, report) {
  for (const field of CHUNK_FIELDS) {
    if (!leafValuesEqual(expected?.[field], actual?.[field])) {
      report.fail(
        `document-project: chunks[${ordinal}].${field}: expected`
        + ` ${JSON.stringify(expected?.[field])}, decoded ${JSON.stringify(actual?.[field])}`,
      );
    }
  }
  const expectedCues = Array.isArray(expected?.originalCues) ? expected.originalCues : [];
  const actualCues = Array.isArray(actual?.originalCues) ? actual.originalCues : [];
  if (expectedCues.length !== actualCues.length) {
    report.fail(
      `document-project: chunks[${ordinal}].originalCues length: expected`
      + ` ${expectedCues.length}, decoded ${actualCues.length}`,
    );
  }
  compareTranslationArchives(
    expected?.translationsByLanguage,
    actual?.translationsByLanguage,
    `document-project: chunks[${ordinal}].translationsByLanguage`,
    report,
  );
}

/** §3 rule 4: language archive keys match case-insensitively (lowercased). */
function compareTranslationArchives(expectedArchive, actualArchive, where, report) {
  const expected = isPlainObject(expectedArchive) ? expectedArchive : {};
  const actual = isPlainObject(actualArchive) ? actualArchive : {};
  const expectedKeys = new Map();
  for (const key of Object.keys(expected)) expectedKeys.set(languageKey(key), key);
  const actualKeys = new Set(Object.keys(actual).map(languageKey));
  for (const [key, original] of expectedKeys) {
    if (!actualKeys.has(key)) {
      report.fail(`${where}: missing decoded variant for language "${original}"`);
      continue;
    }
    const expectedVariant = expected[original];
    const actualVariant = actual[Object.keys(actual).find((k) => languageKey(k) === key)];
    for (const field of ['text', 'approved', 'updatedAt']) {
      if (!leafValuesEqual(expectedVariant?.[field], actualVariant?.[field])) {
        report.fail(
          `${where}.${key}.${field}: expected`
          + ` ${JSON.stringify(expectedVariant?.[field])}, decoded ${JSON.stringify(actualVariant?.[field])}`,
        );
      }
    }
  }
  for (const key of Object.keys(actual)) {
    if (!expectedKeys.has(languageKey(key))) {
      report.fail(`${where}: unexpected decoded variant for language "${key}"`);
    }
  }
}

// ─── archive-manifest-v3 ─────────────────────────────────────────────────────

/**
 * §3 archive-manifest-v3 (Errata wire names: originalFileName/size, no
 * relativePath/sizeBytes). Entries match by key; role/format/
 * originalFileName/sha256/size compare exactly, `language` nil-tolerantly,
 * and `aliases` order-sensitively so the sha-dedupe aliases entry
 * (chunk:0 with aliases ['chunk:1']) round-trips through the comparator.
 */
export function compareArchiveManifest(fixtureDoc, decodedDoc) {
  const report = createReport();
  if (!isPlainObject(fixtureDoc) || !isPlainObject(decodedDoc)) {
    report.fail('archive-manifest: both sides must be plain objects');
    return { ok: false, failures: report.failures };
  }
  if (fixtureDoc.format !== decodedDoc.format) {
    report.fail(`archive-manifest: format: expected ${JSON.stringify(fixtureDoc.format)}, decoded ${JSON.stringify(decodedDoc.format)}`);
  }
  if (fixtureDoc.schemaVersion !== 3) {
    report.fail(`archive-manifest: fixture schemaVersion must be 3, got ${JSON.stringify(fixtureDoc.schemaVersion)}`);
  }
  if (decodedDoc.schemaVersion !== 3) {
    report.fail(`archive-manifest: decoded schemaVersion must be 3, got ${JSON.stringify(decodedDoc.schemaVersion)}`);
  }
  const expectedEntries = indexManifestEntries(fixtureDoc.assetManifest, 'expected', report);
  const actualEntries = indexManifestEntries(decodedDoc.assetManifest, 'decoded', report);
  for (const [key, expected] of expectedEntries) {
    const actual = actualEntries.get(key);
    if (!actual) {
      report.fail(`archive-manifest: missing decoded entry for key "${key}"`);
      continue;
    }
    for (const field of MANIFEST_ENTRY_FIELDS) {
      if (!leafValuesEqual(expected[field], actual[field])) {
        report.fail(
          `archive-manifest: entry "${key}".${field}: expected`
          + ` ${JSON.stringify(expected[field])}, decoded ${JSON.stringify(actual[field])}`,
        );
      }
    }
    if (!leafValuesEqual(expected.aliases, actual.aliases)) {
      report.fail(
        `archive-manifest: entry "${key}".aliases: expected`
        + ` ${JSON.stringify(expected.aliases)}, decoded ${JSON.stringify(actual.aliases)}`,
      );
    }
  }
  return { ok: report.ok(), failures: report.failures };
}

function indexManifestEntries(container, side, report, family = 'archive-manifest') {
  const byKey = new Map();
  const entries = isPlainObject(container) && Array.isArray(container.entries)
    ? container.entries
    : null;
  if (!entries) {
    report.fail(`${family}: ${side} assetManifest.entries must be an array`);
    return byKey;
  }
  for (const [i, entry] of entries.entries()) {
    if (!isPlainObject(entry) || typeof entry.key !== 'string' || entry.key === '') {
      report.fail(`${family}: ${side} entries[${i}] must be an object with a non-empty key`);
      continue;
    }
    if (byKey.has(entry.key)) {
      report.fail(`${family}: ${side} duplicate entry key "${entry.key}"`);
      continue;
    }
    byKey.set(entry.key, entry);
  }
  return byKey;
}

// ─── shorts-render-contract ──────────────────────────────────────────────────

/**
 * §3 shorts-render-contract. `decoded` carries the Electron projection output:
 * `{ projections, normalizedPlans }` where `projections[i]` is the real
 * `activeShortsPlanProjection` result for `fixture.plans[i]` and
 * `normalizedPlans[i]` is the same plan after the real session normalizer.
 * Plans match by ordinal; canonicalProjection spec fields compare exactly
 * (languageKey lowercased). TimelineCuts follow the §3 timing-match rule with
 * the stableID-uniqueness invariant validated separately on both sides.
 * `fallbackProjection` is native-only (Slice 3) and intentionally not decoded
 * here.
 */
export function compareShortsRenderContract(fixture, decoded) {
  const report = createReport();
  if (!isPlainObject(fixture) || !isPlainObject(decoded)) {
    report.fail('shorts-render: both sides must be plain objects');
    return { ok: false, failures: report.failures };
  }
  const canonical = isPlainObject(fixture.canonicalProjection)
    && Array.isArray(fixture.canonicalProjection.plans)
    ? fixture.canonicalProjection.plans
    : null;
  if (!canonical) {
    report.fail('shorts-render: fixture canonicalProjection.plans must be an array');
    return { ok: false, failures: report.failures };
  }
  const fixturePlans = Array.isArray(fixture.plans) ? fixture.plans : [];
  const projections = Array.isArray(decoded.projections) ? decoded.projections : [];
  const normalizedPlans = Array.isArray(decoded.normalizedPlans) ? decoded.normalizedPlans : [];
  if (fixturePlans.length !== canonical.length) {
    report.fail(`shorts-render: plan count: fixture has ${fixturePlans.length}, canonicalProjection has ${canonical.length}`);
  }
  if (projections.length !== fixturePlans.length) {
    report.fail(`shorts-render: projection count: expected ${fixturePlans.length}, decoded ${projections.length}`);
  }
  if (normalizedPlans.length !== fixturePlans.length) {
    report.fail(`shorts-render: normalized plan count: expected ${fixturePlans.length}, decoded ${normalizedPlans.length}`);
  }
  const ordinalCount = Math.min(fixturePlans.length, canonical.length, projections.length);
  for (let i = 0; i < ordinalCount; i++) {
    for (const field of PROJECTION_FIELDS) {
      const expected = field === 'languageKey'
        ? languageKey(canonical[i]?.[field])
        : canonical[i]?.[field];
      const actual = field === 'languageKey'
        ? languageKey(projections[i]?.[field])
        : projections[i]?.[field];
      if (!leafValuesEqual(expected, actual)) {
        report.fail(
          `shorts-render: canonicalProjection.plans[${i}].${field}: expected`
          + ` ${JSON.stringify(canonical[i]?.[field])}, decoded ${JSON.stringify(projections[i]?.[field])}`,
        );
      }
    }
  }
  const cutCount = Math.min(fixturePlans.length, normalizedPlans.length);
  for (let i = 0; i < cutCount; i++) {
    for (const field of CLIP_RANGE_FIELDS) {
      const expected = fixturePlans[i]?.clipRange?.[field];
      const actual = normalizedPlans[i]?.clipRange?.[field];
      if (!leafValuesEqual(expected, actual)) {
        report.fail(
          `shorts-render: plans[${i}].clipRange.${field}: expected`
          + ` ${JSON.stringify(expected)}, decoded ${JSON.stringify(actual)}`,
        );
      }
    }
    compareTimelineCuts(
      fixturePlans[i]?.timelineCuts,
      normalizedPlans[i]?.timelineCuts,
      `shorts-render: plans[${i}]`,
      report,
    );
    for (const issue of timelineCutStableIDIssues(fixturePlans[i]?.timelineCuts)) {
      report.fail(`shorts-render: plans[${i}] fixture invariant: ${issue}`);
    }
    for (const issue of timelineCutStableIDIssues(normalizedPlans[i]?.timelineCuts)) {
      report.fail(`shorts-render: plans[${i}] decoded invariant: ${issue}`);
    }
  }
  return { ok: report.ok(), failures: report.failures };
}

/**
 * §3 TimelineCut rule: cuts match by (startSec, endSec) tuple; stableID is
 * never compared between editions (native TimelineCut.Equatable ignores it).
 */
export function compareTimelineCuts(expectedCuts, actualCuts, where = 'cuts', report = createReport()) {
  const expected = Array.isArray(expectedCuts) ? expectedCuts : [];
  const actual = Array.isArray(actualCuts) ? actualCuts : [];
  if (expected.length !== actual.length) {
    report.fail(`${where}: timeline cut count: expected ${expected.length}, decoded ${actual.length}`);
    return report;
  }
  const remaining = [...actual];
  for (const [i, cut] of expected.entries()) {
    const tuple = cutTimingTuple(cut);
    const matchIndex = remaining.findIndex((candidate) => {
      const candidateTuple = cutTimingTuple(candidate);
      return candidateTuple[0] === tuple[0] && candidateTuple[1] === tuple[1];
    });
    if (matchIndex === -1) {
      report.fail(`${where}: timelineCuts[${i}]: no decoded cut matches timing (${tuple[0]}, ${tuple[1]})`);
      continue;
    }
    remaining.splice(matchIndex, 1);
  }
  return report;
}

function cutTimingTuple(cut) {
  return isPlainObject(cut) ? [cut.startSec, cut.endSec] : [undefined, undefined];
}

/**
 * Structural invariant (§3): stableIDs must be unique within a plan; absent
 * IDs are allowed (one fixture cut intentionally carries none).
 */
export function timelineCutStableIDIssues(cuts) {
  const issues = [];
  if (!Array.isArray(cuts)) return issues;
  const seen = new Set();
  for (const [i, cut] of cuts.entries()) {
    if (!isPlainObject(cut)) continue;
    const id = cut.stableID;
    if (id === undefined || id === null || id === '') continue;
    const identity = String(id).toLowerCase();
    if (seen.has(identity)) {
      issues.push(`timelineCuts[${i}]: duplicate stableID "${id}" within plan`);
    }
    seen.add(identity);
  }
  return issues;
}

// ─── shorts-export-selection ─────────────────────────────────────────────────

/**
 * §3 shorts-export-selection (§4 divergence #2 resolution): selections match
 * by normalized selection identity (exact stableID, lowercased languageKey)
 * and isSelected compares as a boolean. `selectionIdentityMap` must be a
 * 1:1 index↔stableID bijection on both sides, and every selection's
 * planIndex must map to the stableID it carries.
 */
export function compareShortsExportSelection(fixture, decoded) {
  const report = createReport();
  if (!isPlainObject(fixture) || !isPlainObject(decoded)) {
    report.fail('shorts-export: both sides must be plain objects');
    return { ok: false, failures: report.failures };
  }
  const expectedMap = validateSelectionIdentityMap(fixture.selectionIdentityMap, 'fixture', report);
  const actualMap = validateSelectionIdentityMap(decoded.selectionIdentityMap, 'decoded', report);
  const expected = indexSelections(fixture.selections, expectedMap, 'fixture', report);
  const actual = indexSelections(decoded.selections, actualMap, 'decoded', report);
  for (const [identity, expectedSelected] of expected) {
    if (!actual.has(identity)) {
      report.fail(`shorts-export: missing decoded selection for identity ${formatSelectionIdentity(identity)}`);
      continue;
    }
    if (actual.get(identity) !== expectedSelected) {
      report.fail(
        `shorts-export: isSelected for identity ${formatSelectionIdentity(identity)}:`
        + ` expected ${JSON.stringify(expectedSelected)}, decoded ${JSON.stringify(actual.get(identity))}`,
      );
    }
  }
  for (const identity of actual.keys()) {
    if (!expected.has(identity)) {
      report.fail(`shorts-export: unexpected decoded selection for identity ${formatSelectionIdentity(identity)}`);
    }
  }
  return { ok: report.ok(), failures: report.failures };
}

function formatSelectionIdentity(identity) {
  const [stableID, language] = identity.split('\u0000');
  return `(${stableID}, ${language})`;
}

function validateSelectionIdentityMap(map, side, report) {
  const byIndex = new Map();
  if (!Array.isArray(map) || map.length === 0) {
    report.fail(`shorts-export: ${side} selectionIdentityMap must be a non-empty array`);
    return byIndex;
  }
  const byStableID = new Set();
  for (const [i, row] of map.entries()) {
    if (!isPlainObject(row) || !Number.isInteger(row.index)
      || typeof row.stableID !== 'string' || row.stableID === '') {
      report.fail(`shorts-export: ${side} selectionIdentityMap[${i}] must map an integer index to a non-empty stableID`);
      continue;
    }
    if (byIndex.has(row.index)) {
      report.fail(`shorts-export: ${side} selectionIdentityMap duplicate index ${row.index} (bijection broken)`);
      continue;
    }
    if (byStableID.has(row.stableID)) {
      report.fail(`shorts-export: ${side} selectionIdentityMap duplicate stableID "${row.stableID}" (bijection broken)`);
      continue;
    }
    byIndex.set(row.index, row.stableID);
    byStableID.add(row.stableID);
  }
  return byIndex;
}

function indexSelections(selections, identityMap, side, report) {
  const indexed = new Map();
  if (!Array.isArray(selections)) {
    report.fail(`shorts-export: ${side} selections must be an array`);
    return indexed;
  }
  for (const [i, selection] of selections.entries()) {
    if (!isPlainObject(selection)
      || typeof selection.stableID !== 'string' || selection.stableID === ''
      || typeof selection.languageKey !== 'string' || selection.languageKey === '') {
      report.fail(`shorts-export: ${side} selections[${i}] must carry a non-empty stableID and languageKey`);
      continue;
    }
    if (identityMap && Number.isInteger(selection.planIndex)) {
      const mapped = identityMap.get(selection.planIndex);
      if (mapped !== undefined && mapped !== selection.stableID) {
        report.fail(
          `shorts-export: ${side} selections[${i}] planIndex ${selection.planIndex}`
          + ` maps to stableID "${mapped}" but carries "${selection.stableID}"`,
        );
      }
    }
    const identity = `${selection.stableID}\u0000${languageKey(selection.languageKey)}`;
    const previous = indexed.get(identity);
    if (previous === undefined) {
      indexed.set(identity, selection.isSelected);
    } else if (previous !== selection.isSelected) {
      report.fail(
        `shorts-export: ${side} selections[${i}] conflicts with an earlier selection`
        + ` for identity ${formatSelectionIdentity(identity)}`,
      );
    }
  }
  return indexed;
}
