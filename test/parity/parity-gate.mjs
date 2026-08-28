#!/usr/bin/env node
'use strict';

/**
 * P4.D4 Slice 2 — structural parity gate (npm `pretest`).
 *
 * Wiring (binding §5 + Main clarification): npm `pretest` =
 * `node test/parity/parity-gate.mjs`. If this gate exits non-zero, `npm test`
 * aborts before any test executes.
 *
 * 1. ALWAYS: verify the committed in-repo fixture copy
 *    (`Electron/test/fixtures/parity/`) against its committed
 *    `.manifest.json` — every manifest entry must exist and hash-match
 *    (SHA-256), every listed file must be present, and every `*.json` file in
 *    the directory must be listed (the manifest is the single source of
 *    truth; unlisted files fail structurally).
 * 2. When the outer authoring master (`<workspace>/shared/test-fixtures/parity/`)
 *    exists on this workstation, additionally drift-check the in-repo copy
 *    against the master manifest and fail on any divergence. When the master
 *    is absent (CI / fresh clone), print a short SKIP note and continue.
 *
 * Read-only and idempotent: no writes, no side effects. Zero npm
 * dependencies (node:crypto, node:fs, node:path, node:url only).
 */

import { createHash } from 'node:crypto';
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url)); // Electron/test/parity
const fixturesDir = resolve(here, '../fixtures/parity'); // Electron/test/fixtures/parity
const workspaceRoot = resolve(here, '../../..'); // workflow root (Electron/..)
const masterDir = resolve(workspaceRoot, 'shared/test-fixtures/parity');

const MANIFEST_NAME = '.manifest.json';
const SHA256_PATTERN = /^[0-9a-f]{64}$/;

function sha256File(filePath) {
  return createHash('sha256').update(readFileSync(filePath)).digest('hex');
}

/**
 * Verify a fixture directory against one manifest: listed files exist with
 * matching hashes; no unlisted `*.json` files exist (`.manifest.json` itself
 * is exempt — it IS the manifest).
 */
function verifyCopyAgainstManifest(copyDir, manifestPath, label, problems) {
  let manifest;
  try {
    manifest = JSON.parse(readFileSync(manifestPath, 'utf8'));
  } catch (err) {
    problems.push(`${label}: cannot read manifest ${manifestPath}: ${err.message}`);
    return;
  }
  if (manifest === null || typeof manifest !== 'object' || Array.isArray(manifest)) {
    problems.push(`${label}: manifest must be a JSON object mapping file name to SHA-256`);
    return;
  }
  for (const [name, expected] of Object.entries(manifest)) {
    if (typeof expected !== 'string' || !SHA256_PATTERN.test(expected)) {
      problems.push(`${label}: manifest entry "${name}" does not carry a lowercase SHA-256 hash`);
      continue;
    }
    const filePath = join(copyDir, name);
    if (!existsSync(filePath)) {
      problems.push(`${label}: missing fixture file: ${name} (expected sha256 ${expected})`);
      continue;
    }
    const actual = sha256File(filePath);
    if (actual !== expected) {
      problems.push(`${label}: hash mismatch for ${name}: expected ${expected}, got ${actual}`);
    }
  }
  try {
    for (const entry of readdirSync(copyDir)) {
      if (entry === MANIFEST_NAME || !entry.endsWith('.json')) continue;
      if (!Object.hasOwn(manifest, entry)) {
        problems.push(`${label}: unlisted fixture file (regenerate the manifest): ${entry}`);
      }
    }
  } catch (err) {
    problems.push(`${label}: cannot list fixture directory ${copyDir}: ${err.message}`);
  }
}

function runGate() {
  const problems = [];

  // 1. Always: the committed in-repo copy against its committed manifest.
  if (!existsSync(fixturesDir)) {
    problems.push(`in-repo: parity fixture directory missing: ${fixturesDir}`);
  } else {
    const manifestPath = join(fixturesDir, MANIFEST_NAME);
    if (!existsSync(manifestPath)) {
      problems.push(`in-repo: manifest missing: ${manifestPath}`);
    } else {
      verifyCopyAgainstManifest(fixturesDir, manifestPath, 'in-repo', problems);
    }
  }

  // 2. Drift check against the outer authoring master (workstation only).
  if (existsSync(masterDir)) {
    const masterManifestPath = join(masterDir, MANIFEST_NAME);
    if (!existsSync(masterManifestPath)) {
      problems.push(`drift: master manifest missing: ${masterManifestPath} (run QA/scripts/generate_parity_manifest.sh)`);
    } else {
      verifyCopyAgainstManifest(fixturesDir, masterManifestPath, 'drift', problems);
      const copyManifestPath = join(fixturesDir, MANIFEST_NAME);
      if (existsSync(copyManifestPath)) {
        const masterManifest = readFileSync(masterManifestPath);
        const copyManifest = readFileSync(copyManifestPath);
        if (!masterManifest.equals(copyManifest)) {
          problems.push('drift: .manifest.json in the Electron copy differs from the master manifest (re-run QA/scripts/sync_parity_fixtures.sh)');
        }
      }
    }
  } else {
    console.log(`SKIP: parity drift check — outer master parity directory absent (CI/fresh clone): ${masterDir}`);
  }

  return problems;
}

try {
  const problems = runGate();
  if (problems.length > 0) {
    console.error(`FAIL: parity gate — ${problems.length} problem(s):`);
    for (const problem of problems) console.error(`  - ${problem}`);
    process.exit(1);
  }
  console.log(`PASS: parity gate — committed parity fixtures verified against ${MANIFEST_NAME}`);
} catch (err) {
  console.error(`FAIL: parity gate — unexpected error: ${err && err.stack ? err.stack : err}`);
  process.exit(1);
}
