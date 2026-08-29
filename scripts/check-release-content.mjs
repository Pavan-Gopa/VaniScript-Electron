#!/usr/bin/env node

import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const defaultReleaseDir = path.join(projectRoot, 'release');
const defaultArtifactsDir = path.join(projectRoot, 'artifacts');
const REQUIRED_EXTRA_RESOURCES = ['ffmpeg-bin', 'llamacpp', 'yt-dlp-bin'];
const REQUIRED_ASAR_UNPACK_PACKAGES = [
  { name: 'ffmpeg-static', native: false },
  { name: '@kutalia/whisper-node-addon', native: true },
];
const SUPPORTED_PLATFORMS = new Set(['darwin', 'win32', 'linux']);
const SUPPORTED_ARCHES = new Set(['arm64', 'x64']);
const ZERO_SHA256 = '0'.repeat(64);

function optionValue(name, fallback = undefined) {
  const inline = process.argv.find((argument) => argument.startsWith(`${name}=`));
  if (inline) return inline.slice(name.length + 1);
  const index = process.argv.indexOf(name);
  if (index === -1) return fallback;
  const value = process.argv[index + 1];
  if (!value || value.startsWith('--')) throw new Error(`Missing value for ${name}`);
  return value;
}

function normalizePlatform(value) {
  const aliases = { mac: 'darwin', macos: 'darwin', win: 'win32', windows: 'win32' };
  const normalized = aliases[String(value || '').toLowerCase()] || String(value || '').toLowerCase();
  if (!SUPPORTED_PLATFORMS.has(normalized)) {
    throw new Error(`Unsupported target platform: ${value}. Expected darwin, win32, or linux.`);
  }
  return normalized;
}

function normalizeArch(value) {
  const aliases = { aarch64: 'arm64', x86_64: 'x64', amd64: 'x64' };
  const normalized = aliases[String(value || '').toLowerCase()] || String(value || '').toLowerCase();
  if (!SUPPORTED_ARCHES.has(normalized)) {
    throw new Error(`Unsupported target architecture: ${value}. Expected arm64 or x64.`);
  }
  return normalized;
}

function resolvePath(value, fallback) {
  return path.resolve(process.cwd(), value || fallback);
}

function exists(filePath) {
  try {
    fs.lstatSync(filePath);
    return true;
  } catch {
    return false;
  }
}

function stat(filePath) {
  try {
    return fs.statSync(filePath);
  } catch {
    return null;
  }
}

function isDirectory(filePath) {
  return Boolean(stat(filePath)?.isDirectory());
}

function isFile(filePath) {
  return Boolean(stat(filePath)?.isFile());
}

function listDirectory(directoryPath) {
  try {
    return fs.readdirSync(directoryPath, { withFileTypes: true });
  } catch {
    return [];
  }
}

function walkFiles(rootPath, options = {}) {
  const files = [];
  const maxDepth = options.maxDepth ?? Infinity;
  const visit = (currentPath, depth) => {
    if (depth > maxDepth) return;
    for (const entry of listDirectory(currentPath)) {
      if (entry.name === '.' || entry.name === '..') continue;
      const entryPath = path.join(currentPath, entry.name);
      let entryStats;
      try {
        entryStats = fs.lstatSync(entryPath);
      } catch {
        continue;
      }
      if (entryStats.isSymbolicLink()) {
        let linkedStats;
        try { linkedStats = fs.statSync(entryPath); } catch { continue; }
        if (linkedStats.isFile()) files.push(entryPath);
      } else if (entryStats.isDirectory()) {
        visit(entryPath, depth + 1);
      } else if (entryStats.isFile()) {
        files.push(entryPath);
      }
    }
  };
  visit(rootPath, 0);
  return files;
}

function nonEmptyFile(filePath) {
  const fileStats = stat(filePath);
  return Boolean(fileStats?.isFile() && fileStats.size > 0);
}

function readJson(filePath) {
  return JSON.parse(fs.readFileSync(filePath, 'utf8'));
}

function configuredExtraResources(manifest) {
  const resources = manifest?.build?.extraResources;
  if (!Array.isArray(resources)) return new Map();
  return new Map(resources
    .filter((resource) => resource && typeof resource === 'object' && typeof resource.to === 'string')
    .map((resource) => [resource.to, resource]));
}

function configuredAsarUnpack(manifest) {
  const unpack = manifest?.build?.asarUnpack;
  return Array.isArray(unpack) ? unpack.filter((pattern) => typeof pattern === 'string') : [];
}

function resourceRootFor(packagePath, platform) {
  if (platform === 'darwin' && isDirectory(path.join(packagePath, 'Contents', 'Resources'))) {
    return path.join(packagePath, 'Contents', 'Resources');
  }
  for (const name of ['resources', 'Resources']) {
    const resourcePath = path.join(packagePath, name);
    if (isDirectory(resourcePath)) return resourcePath;
  }
  if (isFile(path.join(packagePath, 'app.asar')) || isDirectory(path.join(packagePath, 'app.asar.unpacked'))) {
    return packagePath;
  }
  return null;
}

function packageCandidates(releaseDir, platform) {
  const rootStats = stat(releaseDir);
  if (!rootStats || !rootStats.isDirectory()) return [];
  const candidates = [];
  const addCandidate = (packagePath) => {
    const resourcePath = resourceRootFor(packagePath, platform);
    if (!resourcePath || candidates.some((candidate) => candidate.packagePath === packagePath)) return;
    candidates.push({ packagePath, resourcePath });
  };
  if (resourceRootFor(releaseDir, platform)) addCandidate(releaseDir);

  const visit = (directoryPath, depth) => {
    if (depth > 4) return;
    for (const entry of listDirectory(directoryPath)) {
      if (!entry.isDirectory() || entry.name.startsWith('.')) continue;
      const entryPath = path.join(directoryPath, entry.name);
      if (platform === 'darwin' && entry.name.endsWith('.app')) {
        addCandidate(entryPath);
        continue;
      }
      if (platform !== 'darwin' && (entry.name === 'win-unpacked' || entry.name === 'linux-unpacked')) {
        addCandidate(entryPath);
        continue;
      }
      if (resourceRootFor(entryPath, platform)) addCandidate(entryPath);
      visit(entryPath, depth + 1);
    }
  };
  visit(releaseDir, 0);
  return candidates;
}

function locatePackage(releaseDir, platform, explicitPackagePath, dirBuild) {
  if (explicitPackagePath) {
    const packagePath = resolvePath(explicitPackagePath);
    const resourcePath = resourceRootFor(packagePath, platform);
    if (!resourcePath) throw new Error(`Packaged tree has no resources directory: ${packagePath}`);
    return { packagePath, resourcePath, dirBuild };
  }
  const candidates = packageCandidates(releaseDir, platform);
  if (candidates.length === 0) return null;
  const preferred = candidates.find(({ packagePath }) => packagePath.endsWith('.app'))
    || candidates.find(({ packagePath }) => path.basename(packagePath) === `${platform}-unpacked`)
    || candidates[0];
  return { ...preferred, dirBuild };
}

function readAsarHeader(archivePath) {
  const archiveStats = stat(archivePath);
  if (!archiveStats || archiveStats.size < 16) throw new Error(`ASAR archive is missing or too small: ${archivePath}`);
  const fd = fs.openSync(archivePath, 'r');
  try {
    const sizeBuffer = Buffer.alloc(8);
    fs.readSync(fd, sizeBuffer, 0, sizeBuffer.length, 0);
    const headerSize = sizeBuffer.readUInt32LE(4);
    if (headerSize < 8 || headerSize > 128 * 1024 * 1024 || 8 + headerSize > archiveStats.size) {
      throw new Error(`Invalid ASAR header size ${headerSize}: ${archivePath}`);
    }
    const headerBuffer = Buffer.alloc(headerSize);
    fs.readSync(fd, headerBuffer, 0, headerBuffer.length, 8);
    const stringLength = headerBuffer.readInt32LE(4);
    if (stringLength < 2 || stringLength > headerBuffer.length - 8) {
      throw new Error(`Invalid ASAR header string length ${stringLength}: ${archivePath}`);
    }
    return { header: JSON.parse(headerBuffer.subarray(8, 8 + stringLength).toString('utf8')), headerSize };
  } finally {
    fs.closeSync(fd);
  }
}

function asarFiles(archivePath) {
  const { header, headerSize } = readAsarHeader(archivePath);
  const files = [];
  const visit = (entries, prefix = '') => {
    for (const [name, info] of Object.entries(entries || {})) {
      const relativePath = prefix ? `${prefix}/${name}` : name;
      if (info && info.files) visit(info.files, relativePath);
      else if (info && typeof info === 'object') files.push({ archivePath, relativePath, info, headerSize });
    }
  };
  visit(header.files);
  return files;
}

function readAsarBytes(entry, maxBytes = 8192) {
  if (entry.info.unpacked) {
    const unpackedPath = `${entry.archivePath}.unpacked/${entry.relativePath.split('/').join(path.sep)}`;
    if (!isFile(unpackedPath)) throw new Error(`Unpacked ASAR payload is missing: ${unpackedPath}`);
    return fs.readFileSync(unpackedPath).subarray(0, maxBytes);
  }
  const size = Math.min(Number(entry.info.size), maxBytes);
  const offset = 8 + entry.headerSize + Number(entry.info.offset || 0);
  const fd = fs.openSync(entry.archivePath, 'r');
  try {
    const buffer = Buffer.alloc(Math.max(0, size));
    if (size > 0) fs.readSync(fd, buffer, 0, size, offset);
    return buffer;
  } finally {
    fs.closeSync(fd);
  }
}

function nativeArchitecture(bytes) {
  if (bytes.length >= 4) {
    const magicLE = bytes.readUInt32LE(0);
    const magicBE = bytes.readUInt32BE(0);
    const machOArchitectures = (endian) => {
      const read = endian === 'le' ? (offset) => bytes.readUInt32LE(offset) : (offset) => bytes.readUInt32BE(offset);
      const cpuType = read(4);
      if (cpuType === 0x0100000c) return ['arm64'];
      if (cpuType === 0x01000007) return ['x64'];
      return [];
    };
    if ([0xfeedface, 0xfeedfacf, 0xcefaedfe, 0xcffaedfe].includes(magicLE)
      || [0xfeedface, 0xfeedfacf, 0xcefaedfe, 0xcffaedfe].includes(magicBE)) {
      const isLittle = [0xfeedface, 0xfeedfacf].includes(magicLE);
      return machOArchitectures(isLittle ? 'le' : 'be');
    }
    if (magicBE === 0xcafebabe || magicBE === 0xcafebabf || magicLE === 0xbebafeca || magicLE === 0xbfbafeca) {
      const read = magicBE === 0xcafebabe || magicBE === 0xcafebabf
        ? (offset) => bytes.readUInt32BE(offset)
        : (offset) => bytes.readUInt32LE(offset);
      const count = read(4);
      const stride = (magicBE === 0xcafebabf || magicLE === 0xbfbafeca) ? 32 : 20;
      const architectures = [];
      for (let index = 0; index < count && 8 + index * stride + 4 <= bytes.length; index += 1) {
        const cpuType = read(8 + index * stride);
        if (cpuType === 0x0100000c) architectures.push('arm64');
        if (cpuType === 0x01000007) architectures.push('x64');
      }
      return architectures;
    }
  }

  if (bytes.length >= 20 && bytes.subarray(0, 4).toString('ascii') === '\u007fELF') {
    const endian = bytes[5] === 2 ? 'be' : 'le';
    const machine = endian === 'be' ? bytes.readUInt16BE(18) : bytes.readUInt16LE(18);
    if (machine === 183) return ['arm64'];
    if (machine === 62) return ['x64'];
    return [];
  }

  if (bytes.length >= 0x40 && bytes.subarray(0, 2).toString('ascii') === 'MZ') {
    const peOffset = bytes.readUInt32LE(0x3c);
    if (peOffset + 6 <= bytes.length && bytes.subarray(peOffset, peOffset + 4).toString('ascii') === 'PE\u0000\u0000') {
      const machine = bytes.readUInt16LE(peOffset + 4);
      if (machine === 0xaa64) return ['arm64'];
      if (machine === 0x8664) return ['x64'];
    }
  }
  return [];
}

function addCheck(checks, name, passed, detail) {
  checks.push({ name, passed: Boolean(passed), detail: String(detail) });
}

function expectedIconNames(platform) {
  if (platform === 'darwin') return ['icon.icns'];
  if (platform === 'win32') return ['icon.ico'];
  return ['icon.png', 'app.png'];
}

function iconMatches(packageInfo, platform, asarEntries) {
  const names = new Set(expectedIconNames(platform));
  const physical = walkFiles(packageInfo.packagePath, { maxDepth: 6 })
    .filter((filePath) => names.has(path.basename(filePath).toLowerCase()) && nonEmptyFile(filePath));
  if (physical.length > 0) return physical;
  return asarEntries
    .filter((entry) => names.has(path.posix.basename(entry.relativePath).toLowerCase()) && Number(entry.info.size) > 0)
    .map((entry) => entry.relativePath);
}

function vendorBinaryPath(resourcePath, platform, arch, kind) {
  const platformDir = platform === 'darwin' ? 'darwin' : platform === 'win32' ? 'win32' : 'linux';
  const executable = platform === 'win32' ? `${kind}.exe` : kind;
  if (kind === 'ffmpeg') return path.join(resourcePath, 'ffmpeg-bin', executable);
  if (kind === 'llama-cli') return path.join(resourcePath, 'llamacpp', `${platform}-${arch}`, executable);
  return path.join(resourcePath, 'yt-dlp-bin', platformDir, executable);
}

function relativeDetail(rootPath, filePath) {
  return path.relative(rootPath, filePath) || filePath;
}

function nativePathMatchesTarget(filePath, platform, arch) {
  const normalizedPath = filePath.split(path.sep).join('/');
  const matches = [...normalizedPath.matchAll(/(?:^|\/)(darwin|mac|win32|windows|linux)-(arm64|x64)(?:\/|$)/g)];
  const match = matches.at(-1);
  if (!match) return true;
  const platformNames = platform === 'darwin' ? new Set(['darwin', 'mac']) : new Set([platform]);
  return platformNames.has(match[1]) && match[2] === arch;
}

async function hashFile(filePath) {
  const hash = createHash('sha256');
  for await (const chunk of fs.createReadStream(filePath)) hash.update(chunk);
  return hash.digest('hex');
}

async function hashDirectory(directoryPath) {
  const hash = createHash('sha256');
  const files = walkFiles(directoryPath).sort((left, right) => left.localeCompare(right));
  for (const filePath of files) {
    const relativePath = path.relative(directoryPath, filePath).split(path.sep).join('/');
    const fileStats = fs.statSync(filePath);
    hash.update(`${relativePath}\0${fileStats.size}\0`);
    for await (const chunk of fs.createReadStream(filePath)) hash.update(chunk);
  }
  return hash.digest('hex');
}

function installerExtensionsFor(buildTarget) {
  if (buildTarget === 'dmg+zip') return ['.dmg', '.zip'];
  if (buildTarget === 'nsis') return ['.exe'];
  if (buildTarget === 'appimage') return ['.appimage'];
  return [];
}

function artifactFiles(releaseDir, expectedExtensions) {
  const extensions = new Set(expectedExtensions);
  return walkFiles(releaseDir, { maxDepth: 3 })
    .filter((filePath) => extensions.has(path.extname(filePath).toLowerCase()))
    .filter((filePath) => !filePath.includes(`${path.sep}win-unpacked${path.sep}`))
    .filter((filePath) => !filePath.includes(`${path.sep}linux-unpacked${path.sep}`))
    .filter((filePath) => !filePath.includes(`${path.sep}Contents${path.sep}`));
}

function buildTargetFor(platform) {
  if (platform === 'darwin') return 'dmg+zip';
  if (platform === 'win32') return 'nsis';
  return 'appimage';
}

async function inspectInstaller(releaseDir, packageInfo, buildTarget, checks) {
  if (packageInfo.dirBuild) {
    const sizeBytes = walkFiles(packageInfo.packagePath).reduce((total, filePath) => total + fs.statSync(filePath).size, 0);
    addCheck(checks, 'installer-artifact', true, `Unpacked packaged tree present for local qualification (--dir): ${packageInfo.packagePath}`);
    return { exists: true, sizeBytes, sha256: await hashDirectory(packageInfo.packagePath) };
  }

  const expectedExtensions = installerExtensionsFor(buildTarget);
  if (expectedExtensions.length === 0) {
    addCheck(checks, 'installer-artifact', false, `Unsupported release build target for installer qualification: ${buildTarget}`);
    return { exists: false, sizeBytes: 0, sha256: ZERO_SHA256 };
  }

  const artifacts = artifactFiles(releaseDir, expectedExtensions);
  const validArtifacts = artifacts.filter(nonEmptyFile);
  const missing = expectedExtensions.filter((extension) => !validArtifacts.some((filePath) => path.extname(filePath).toLowerCase() === extension));

  let artifactPath = validArtifacts.find((filePath) => path.extname(filePath).toLowerCase() === expectedExtensions[0]);
  if (buildTarget === 'nsis') artifactPath = validArtifacts.find((filePath) => /setup/i.test(path.basename(filePath))) || artifactPath;

  if (missing.length > 0) {
    addCheck(checks, 'installer-artifact', false, `Missing or zero-byte installer artifact(s) for ${buildTarget}: ${missing.join(', ')} under ${releaseDir}`);
    return { exists: false, sizeBytes: 0, sha256: ZERO_SHA256 };
  }

  const details = validArtifacts.map((filePath) => `${relativeDetail(releaseDir, filePath)} (${fs.statSync(filePath).size} bytes)`).join(', ');
  addCheck(checks, 'installer-artifact', true, `Installer artifact(s) present for ${buildTarget}: ${details}`);
  const selected = artifactPath || validArtifacts[0];
  return { exists: true, sizeBytes: fs.statSync(selected).size, sha256: await hashFile(selected) };
}

function gitSha() {
  if (process.env.GITHUB_SHA || process.env.GIT_SHA) return process.env.GITHUB_SHA || process.env.GIT_SHA;
  try {
    return execFileSync('git', ['rev-parse', 'HEAD'], {
      cwd: projectRoot,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
    }).trim() || 'unknown';
  } catch {
    return 'unknown';
  }
}

function reportPathFor(platform) {
  return resolvePath(
    optionValue('--output', process.env.P4D5_QUALIFICATION_PATH || process.env.P4D5_REPORT_PATH),
    path.join(defaultArtifactsDir, `p4d5-qualification-${platform}.json`),
  );
}

function baseReport(platform, arch) {
  return {
    schemaVersion: 1,
    os: platform,
    arch,
    timestamp: new Date().toISOString(),
    gitSha: gitSha(),
    buildTarget: optionValue('--build-target', process.env.P4D5_BUILD_TARGET || buildTargetFor(platform)),
    installerArtifact: { exists: false, sizeBytes: 0, sha256: ZERO_SHA256 },
    contentChecks: [],
    bootSmoke: { passed: false, durationMs: 0, detail: 'Not run by check-release-content.mjs.' },
    e2eScenarios: [],
    findings: [],
    overallStatus: 'fail',
  };
}

async function main() {
  if (process.argv.includes('--help')) {
    console.log('Usage: node scripts/check-release-content.mjs [--release-dir PATH] [--output PATH] [--os darwin|win32|linux] [--arch arm64|x64] [--build-target dmg+zip|nsis|appimage] [--dir]');
    return;
  }

  const platform = normalizePlatform(optionValue('--os', process.env.P4D5_OS || process.env.P4D5_TARGET_OS || process.platform));
  const arch = normalizeArch(optionValue('--arch', process.env.P4D5_ARCH || process.env.P4D5_TARGET_ARCH || process.arch));
  const dirBuild = process.argv.includes('--dir');
  const outputPath = reportPathFor(platform);
  const report = baseReport(platform, arch);
  const releaseDir = resolvePath(
    optionValue('--release-dir', process.env.P4D5_RELEASE_DIR || process.env.P4D5_RELEASE_PATH),
    defaultReleaseDir,
  );

  try {
    const manifest = readJson(path.join(projectRoot, 'package.json'));
    const extraResources = configuredExtraResources(manifest);
    const asarUnpack = configuredAsarUnpack(manifest);
    const packageInfo = locatePackage(
      releaseDir,
      platform,
      optionValue('--package-dir', process.env.P4D5_PACKAGE_DIR || process.env.P4D5_APP_PATH),
      dirBuild,
    );
    if (!packageInfo) {
      addCheck(report.contentChecks, 'packaged-tree', false, `No packaged ${platform} tree found under ${releaseDir}`);
      throw new Error(`No packaged ${platform} tree found under ${releaseDir}`);
    }

    const asarPath = path.join(packageInfo.resourcePath, 'app.asar');
    let asarEntries = [];
    if (isFile(asarPath)) {
      try {
        asarEntries = asarFiles(asarPath);
        addCheck(report.contentChecks, 'asar-archive', true, `Parsed ${relativeDetail(packageInfo.resourcePath, asarPath)} with ${asarEntries.length} file entries.`);
      } catch (error) {
        addCheck(report.contentChecks, 'asar-archive', false, error.message);
      }
    } else {
      addCheck(report.contentChecks, 'asar-archive', false, `Missing packaged app.asar: ${asarPath}`);
    }

    const missingResourceConfig = REQUIRED_EXTRA_RESOURCES.filter((name) => !extraResources.has(name));
    addCheck(
      report.contentChecks,
      'extraResources-configuration',
      missingResourceConfig.length === 0,
      missingResourceConfig.length === 0
        ? `package.json declares ${REQUIRED_EXTRA_RESOURCES.join(', ')}.`
        : `package.json is missing extraResources entries: ${missingResourceConfig.join(', ')}`,
    );

    for (const resourceName of REQUIRED_EXTRA_RESOURCES) {
      const resourcePath = path.join(packageInfo.resourcePath, resourceName);
      const passed = isDirectory(resourcePath);
      addCheck(
        report.contentChecks,
        `extraResources/${resourceName}`,
        passed,
        passed ? `${relativeDetail(packageInfo.resourcePath, resourcePath)} is present.` : `Missing packaged extraResource directory: ${resourcePath}`,
      );
    }

    const ffmpegPath = vendorBinaryPath(packageInfo.resourcePath, platform, arch, 'ffmpeg');
    const llamaPath = vendorBinaryPath(packageInfo.resourcePath, platform, arch, 'llama-cli');
    const ytDlpPath = vendorBinaryPath(packageInfo.resourcePath, platform, arch, 'yt-dlp');
    for (const [name, filePath] of [['ffmpeg', ffmpegPath], ['llama.cpp', llamaPath], ['yt-dlp', ytDlpPath]]) {
      const passed = nonEmptyFile(filePath);
      addCheck(
        report.contentChecks,
        `vendor-binary/${name}`,
        passed,
        passed
          ? `${relativeDetail(packageInfo.resourcePath, filePath)} is non-empty (${fs.statSync(filePath).size} bytes).`
          : `Missing or zero-byte vendor binary: ${filePath}`,
      );
    }

    for (const packageConfig of REQUIRED_ASAR_UNPACK_PACKAGES) {
      const packageName = packageConfig.name;
      const unpackedPath = path.join(packageInfo.resourcePath, 'app.asar.unpacked', 'node_modules', ...packageName.split('/'));
      const unpackedFiles = isDirectory(unpackedPath) ? walkFiles(unpackedPath) : [];
      const payloadFiles = packageConfig.native
        ? unpackedFiles.filter((filePath) => path.extname(filePath).toLowerCase() === '.node' && nativePathMatchesTarget(filePath, platform, arch))
        : unpackedFiles.filter((filePath) => ['ffmpeg', 'ffmpeg.exe'].includes(path.basename(filePath).toLowerCase()));
      const configured = asarUnpack.some((pattern) => pattern.includes(packageName));
      const passed = configured && payloadFiles.length > 0 && payloadFiles.every(nonEmptyFile);
      addCheck(
        report.contentChecks,
        `asarUnpack/${packageName}`,
        passed,
        passed
          ? `${relativeDetail(packageInfo.resourcePath, unpackedPath)} contains ${payloadFiles.length} non-empty target payload file(s).`
          : `Expected ${packageName} in package.json asarUnpack and a non-empty target payload under ${unpackedPath}; configured=${configured}, files=${payloadFiles.length}.`,
      );
    }

    const nativeFiles = [];
    for (const filePath of walkFiles(packageInfo.resourcePath)) {
      if (path.extname(filePath).toLowerCase() === '.node' && nativePathMatchesTarget(filePath, platform, arch)) {
        nativeFiles.push({ filePath, read: () => fs.readFileSync(filePath).subarray(0, 8192) });
      }
    }
    for (const entry of asarEntries.filter((candidate) => path.posix.extname(candidate.relativePath).toLowerCase() === '.node' && nativePathMatchesTarget(candidate.relativePath, platform, arch))) {
      nativeFiles.push({ filePath: `${path.basename(asarPath)}:${entry.relativePath}`, read: () => readAsarBytes(entry) });
    }

    const nativeFailures = [];
    const nativeDetails = [];
    for (const nativeFile of nativeFiles) {
      let architectures;
      try {
        architectures = nativeArchitecture(nativeFile.read());
      } catch {
        architectures = [];
      }
      if (!architectures.includes(arch)) nativeFailures.push(`${nativeFile.filePath} (${architectures.join('|') || 'unknown'}; expected ${arch})`);
      else nativeDetails.push(`${nativeFile.filePath}=${architectures.join('|')}`);
    }
    addCheck(
      report.contentChecks,
      'native-node-architecture',
      nativeFiles.length > 0 && nativeFailures.length === 0,
      nativeFiles.length === 0
        ? 'No packaged target .node native addon files found.'
        : nativeFailures.length === 0
          ? `${nativeFiles.length} target native addon file(s) match ${arch}: ${nativeDetails.join(', ')}`
          : `Native addon architecture mismatch: ${nativeFailures.join('; ')}`,
    );

    const icons = iconMatches(packageInfo, platform, asarEntries);
    addCheck(
      report.contentChecks,
      'icon-embedded',
      icons.length > 0,
      icons.length > 0
        ? `Embedded ${platform} icon payload: ${icons.slice(0, 4).map((icon) => typeof icon === 'string' ? relativeDetail(packageInfo.packagePath, icon) : icon).join(', ')}`
        : `No non-empty ${expectedIconNames(platform).join(' or ')} icon found in packaged tree or app.asar.`,
    );

    report.installerArtifact = await inspectInstaller(releaseDir, packageInfo, report.buildTarget, report.contentChecks);
    report.overallStatus = report.contentChecks.every((check) => check.passed) ? 'partial' : 'fail';
  } catch (error) {
    if (!report.contentChecks.some((check) => check.name === 'qualification-run')) {
      addCheck(report.contentChecks, 'qualification-run', false, error.stack || error.message || String(error));
    }
    report.overallStatus = 'fail';
    console.error(error.stack || error.message || String(error));
  }

  fs.mkdirSync(path.dirname(outputPath), { recursive: true });
  fs.writeFileSync(outputPath, `${JSON.stringify(report, null, 2)}\n`, 'utf8');
  console.log(`Wrote ${outputPath}`);
  if (report.overallStatus === 'fail') process.exitCode = 1;
}

main().catch((error) => {
  console.error(error.stack || error.message || String(error));
  process.exitCode = 1;
});
