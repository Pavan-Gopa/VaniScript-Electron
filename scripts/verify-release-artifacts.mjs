#!/usr/bin/env node

import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { createReadStream } from 'node:fs';
import { mkdtemp, readFile, readdir, rm, stat, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const DEFAULT_RELEASE_DIR = path.join(ROOT_DIR, 'release');
const MANIFEST_NAME = 'VaniScript-Electron.manifest.json';
const CHECKSUMS_NAME = 'checksums.txt';
const SHA256_PATTERN = /^[0-9a-f]{64}$/;
const ARTIFACT_TYPES = [
  ['dmg', '.dmg'],
  ['zip', '.zip'],
];

const checks = [];

function record(status, name, detail) {
  checks.push({ status, name, detail });
}

function pass(name, detail) {
  record('PASS', name, detail);
}

function fail(name, detail) {
  record('FAIL', name, detail);
}

function skip(name, detail) {
  const warning = `WARNING: SKIP ${name}: ${detail}`;
  console.warn(warning);
  record('SKIP', name, detail);
}

function parseArgs(argv) {
  let releaseDir = DEFAULT_RELEASE_DIR;
  let positionalReleaseDir;

  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === '--release-dir') {
      positionalReleaseDir = argv[index + 1];
      if (!positionalReleaseDir) {
        throw new Error('--release-dir requires a path');
      }
      index += 1;
      continue;
    }
    if (argument.startsWith('--release-dir=')) {
      positionalReleaseDir = argument.slice('--release-dir='.length);
      if (!positionalReleaseDir) {
        throw new Error('--release-dir requires a path');
      }
      continue;
    }
    if (argument === '--help' || argument === '-h') {
      console.log('Usage: node scripts/verify-release-artifacts.mjs [--release-dir <path>]');
      process.exitCode = 0;
      return null;
    }
    throw new Error(`unknown argument: ${argument}`);
  }

  if (positionalReleaseDir) {
    releaseDir = path.resolve(ROOT_DIR, positionalReleaseDir);
  }
  return releaseDir;
}

async function sha256File(filePath) {
  const hash = createHash('sha256');
  for await (const chunk of createReadStream(filePath)) {
    hash.update(chunk);
  }
  return hash.digest('hex');
}

async function findArtifacts(releaseDir) {
  const entries = await readdir(releaseDir, { withFileTypes: true });
  const artifacts = {};

  for (const [type, extension] of ARTIFACT_TYPES) {
    const matches = entries
      .filter((entry) => entry.isFile() && entry.name.endsWith(extension))
      .map((entry) => entry.name)
      .sort();
    if (matches.length === 1) {
      artifacts[type] = { name: matches[0], path: path.join(releaseDir, matches[0]) };
      continue;
    }
    if (matches.length === 0) {
      throw new Error(`no ${extension} release artifact found in ${releaseDir}`);
    }
    throw new Error(`multiple ${extension} release artifacts found: ${matches.join(', ')}`);
  }

  return artifacts;
}

function runCommand(command, args) {
  let result;
  try {
    result = spawnSync(command, args, { encoding: 'utf8' });
  } catch (error) {
    return { status: null, error, output: '' };
  }

  const output = [result.stdout, result.stderr]
    .filter((value) => value)
    .join('\n')
    .trim()
    .replace(/\s+/g, ' ');
  return { status: result.status, error: result.error, output };
}

function verifyCommand(name, command, args) {
  const result = runCommand(command, args);
  if (result.error || result.status !== 0) {
    const reason = result.error?.message || result.output || `exit status ${result.status}`;
    fail(name, `${command} ${args.join(' ')}: ${reason}`);
    return false;
  }
  pass(name, `${command} ${args.join(' ')}`);
  return true;
}

async function findAppBundle(directory) {
  const entries = (await readdir(directory, { withFileTypes: true }))
    .sort((left, right) => left.name.localeCompare(right.name));
  for (const entry of entries) {
    const entryPath = path.join(directory, entry.name);
    if (entry.isDirectory() && entry.name.endsWith('.app')) {
      return entryPath;
    }
    if (entry.isDirectory()) {
      const nestedApp = await findAppBundle(entryPath);
      if (nestedApp) {
        return nestedApp;
      }
    }
  }
  return null;
}

function validateManifest(manifest, packageVersion, buildNumber, artifacts, hashes) {
  if (!manifest || typeof manifest !== 'object' || Array.isArray(manifest)) {
    fail('manifest schema', 'manifest must be a JSON object');
    return;
  }

  const scalarFields = [
    ['schemaVersion', 1],
    ['version', packageVersion],
    ['buildNumber', buildNumber],
    ['platform', 'darwin'],
    ['arch', 'arm64'],
    ['channel', 'alpha'],
  ];
  for (const [field, expected] of scalarFields) {
    if (manifest[field] === expected) {
      pass(`manifest ${field}`, `${JSON.stringify(expected)}`);
    } else {
      fail(`manifest ${field}`, `expected ${JSON.stringify(expected)}, got ${JSON.stringify(manifest[field])}`);
    }
  }

  if (!manifest.artifacts || typeof manifest.artifacts !== 'object' || Array.isArray(manifest.artifacts)) {
    fail('manifest artifacts', 'artifacts must contain dmg and zip objects');
    return;
  }

  for (const [type] of ARTIFACT_TYPES) {
    const entry = manifest.artifacts[type];
    if (!entry || typeof entry !== 'object' || Array.isArray(entry)) {
      fail(`manifest artifacts.${type}`, 'artifact entry is missing');
      continue;
    }
    if (entry.filename === artifacts[type].name) {
      pass(`manifest artifacts.${type}.filename`, entry.filename);
    } else {
      fail(`manifest artifacts.${type}.filename`, `expected ${artifacts[type].name}, got ${JSON.stringify(entry.filename)}`);
    }
    if (SHA256_PATTERN.test(entry.sha256 || '')) {
      pass(`manifest artifacts.${type}.sha256`, entry.sha256);
    } else {
      fail(`manifest artifacts.${type}.sha256`, 'expected a lowercase 64-character SHA-256 digest');
    }
    if (entry.sha256 === hashes[type]) {
      pass(`manifest hash ${type}`, `${artifacts[type].name} matches regenerated SHA-256`);
    } else {
      fail(`manifest hash ${type}`, `expected ${hashes[type]}, got ${JSON.stringify(entry.sha256)}`);
    }
  }
}

async function verifyChecksums(checksumsPath, releaseDir, entries) {
  let content;
  try {
    content = await readFile(checksumsPath, 'utf8');
  } catch (error) {
    fail('checksums file', `unable to read ${checksumsPath}: ${error.message}`);
    return;
  }

  const lines = content.split(/\r?\n/).filter((line) => line.length > 0);
  const parsed = [];
  for (const line of lines) {
    const match = line.match(/^([0-9a-f]{64})  (.+)$/);
    if (!match) {
      fail('checksums format', `invalid sha256sum line: ${line}`);
      continue;
    }
    parsed.push({ hash: match[1], name: match[2] });
  }

  const expectedNames = entries.map((entry) => entry.name);
  const actualNames = parsed.map((entry) => entry.name);
  if (expectedNames.length !== actualNames.length || expectedNames.some((name, index) => name !== actualNames[index])) {
    fail('checksums entries', `expected ${expectedNames.join(', ')}, got ${actualNames.join(', ')}`);
  } else {
    pass('checksums entries', `${parsed.length} sha256sum-compatible entries`);
  }

  for (const entry of parsed) {
    if (!expectedNames.includes(entry.name) || path.basename(entry.name) !== entry.name) {
      fail(`checksums ${entry.name}`, 'unexpected checksum entry');
      continue;
    }
    try {
      const actualHash = await sha256File(path.join(releaseDir, entry.name));
      if (actualHash === entry.hash) {
        pass(`checksums ${entry.name}`, actualHash);
      } else {
        fail(`checksums ${entry.name}`, `expected ${entry.hash}, got ${actualHash}`);
      }
    } catch (error) {
      fail(`checksums ${entry.name}`, `unable to hash file: ${error.message}`);
    }
  }
}

async function verifySignatures(artifacts, unsignedMode) {
  const unsignedReason = 'CSC_IDENTITY_AUTO_DISCOVERY=false; unsigned local artifacts are not applicable to signature verification';
  if (unsignedMode) {
    skip('codesign --verify --deep (DMG)', unsignedReason);
    skip('stapler validate (app)', unsignedReason);
    skip('spctl --assess (app)', unsignedReason);
    return;
  }

  verifyCommand('codesign --verify --deep (DMG)', 'codesign', ['--verify', '--deep', '--strict', artifacts.dmg.path]);

  let tempDir;
  let appPath;
  try {
    tempDir = await mkdtemp(path.join(os.tmpdir(), 'vaniscript-release-'));
    const extracted = runCommand('ditto', ['-x', '-k', artifacts.zip.path, tempDir]);
    if (extracted.error || extracted.status !== 0) {
      const reason = extracted.error?.message || extracted.output || `exit status ${extracted.status}`;
      fail('extract app from ZIP', `ditto -x -k ${artifacts.zip.name}: ${reason}`);
    } else {
      appPath = await findAppBundle(tempDir);
      if (appPath) {
        pass('extract app from ZIP', path.relative(tempDir, appPath));
      } else {
        fail('extract app from ZIP', `no .app bundle found in ${artifacts.zip.name}`);
      }
    }

    if (appPath) {
      verifyCommand('stapler validate (app)', 'xcrun', ['stapler', 'validate', appPath]);
      verifyCommand('spctl --assess (app)', 'spctl', ['--assess', '--type', 'execute', '--verbose=4', appPath]);
    } else {
      fail('stapler validate (app)', 'cannot validate app staple because ZIP extraction failed');
      fail('spctl --assess (app)', 'cannot assess app because ZIP extraction failed');
    }
  } catch (error) {
    fail('ZIP app verification', error.message);
  } finally {
    if (tempDir) {
      await rm(tempDir, { recursive: true, force: true });
    }
  }
}

function printTable() {
  console.log('\nRelease artifact verification');
  console.log('STATUS  CHECK                                      DETAILS');
  console.log('------  ----------------------------------------  ----------------------------------------');
  for (const check of checks) {
    console.log(`${check.status.padEnd(6)}  ${check.name.padEnd(40)}  ${check.detail}`);
  }
}

async function main() {
  let releaseDir;
  try {
    releaseDir = parseArgs(process.argv.slice(2));
  } catch (error) {
    fail('arguments', error.message);
    printTable();
    process.exitCode = 1;
    return;
  }
  if (!releaseDir) {
    return;
  }

  const manifestPath = path.join(releaseDir, MANIFEST_NAME);
  const checksumsPath = path.join(releaseDir, CHECKSUMS_NAME);
  const packagePath = path.join(ROOT_DIR, 'package.json');
  let packageJson;
  let artifacts;
  let hashes;
  let packageVersion;
  let buildNumber;

  try {
    packageJson = JSON.parse(await readFile(packagePath, 'utf8'));
    packageVersion = packageJson.version;
    if (typeof packageVersion !== 'string' || packageVersion.length === 0) {
      throw new Error('package.json version must be a non-empty string');
    }
    pass('package version', packageVersion);
  } catch (error) {
    fail('package version', `unable to read ${packagePath}: ${error.message}`);
  }

  try {
    const releaseStats = await stat(releaseDir);
    if (!releaseStats.isDirectory()) {
      throw new Error(`${releaseDir} is not a directory`);
    }
    artifacts = await findArtifacts(releaseDir);
    pass('release artifacts', `${artifacts.dmg.name}, ${artifacts.zip.name}`);
  } catch (error) {
    fail('release artifacts', error.message);
  }

  buildNumber = process.env.GITHUB_RUN_NUMBER || 'local';
  pass('build number', buildNumber);

  if (packageVersion && artifacts) {
    try {
      hashes = {
        dmg: await sha256File(artifacts.dmg.path),
        zip: await sha256File(artifacts.zip.path),
      };
      pass('artifact SHA-256 generation', `${hashes.dmg}  ${artifacts.dmg.name}; ${hashes.zip}  ${artifacts.zip.name}`);

      const generatedManifest = {
        schemaVersion: 1,
        version: packageVersion,
        buildNumber,
        platform: 'darwin',
        arch: 'arm64',
        artifacts: {
          dmg: { filename: artifacts.dmg.name, sha256: hashes.dmg },
          zip: { filename: artifacts.zip.name, sha256: hashes.zip },
        },
        channel: 'alpha',
      };
      await writeFile(manifestPath, `${JSON.stringify(generatedManifest, null, 2)}\n`);
      pass('manifest generation', manifestPath);

      const manifest = JSON.parse(await readFile(manifestPath, 'utf8'));
      validateManifest(manifest, packageVersion, buildNumber, artifacts, hashes);

      const recomputedHashes = {
        dmg: await sha256File(artifacts.dmg.path),
        zip: await sha256File(artifacts.zip.path),
      };
      for (const [type] of ARTIFACT_TYPES) {
        if (recomputedHashes[type] === manifest.artifacts?.[type]?.sha256) {
          pass(`manifest recomputed hash ${type}`, `${artifacts[type].name} unchanged after manifest write`);
        } else {
          fail(`manifest recomputed hash ${type}`, `artifact changed: expected ${manifest.artifacts?.[type]?.sha256}, got ${recomputedHashes[type]}`);
        }
      }

      const checksumEntries = [
        { name: artifacts.dmg.name, hash: recomputedHashes.dmg },
        { name: artifacts.zip.name, hash: recomputedHashes.zip },
        { name: MANIFEST_NAME, hash: await sha256File(manifestPath) },
      ];
      await writeFile(checksumsPath, `${checksumEntries.map((entry) => `${entry.hash}  ${entry.name}`).join('\n')}\n`);
      pass('checksums generation', checksumsPath);
      await verifyChecksums(checksumsPath, releaseDir, checksumEntries);
    } catch (error) {
      fail('manifest/checksum generation', error.message);
    }
  } else {
    fail('manifest/checksum generation', 'package version and both release artifacts are required');
  }

  await verifySignatures(artifacts || {}, process.env.CSC_IDENTITY_AUTO_DISCOVERY === 'false');
  printTable();
  if (checks.some((check) => check.status === 'FAIL')) {
    process.exitCode = 1;
    console.error('\nRelease artifact verification failed.');
  } else {
    console.log('\nRelease artifact verification passed.');
  }
}

await main();
