#!/usr/bin/env node

import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync, lstatSync, statSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const defaultReleaseDir = path.join(projectRoot, 'release');
const defaultArtifactsDir = path.join(projectRoot, 'artifacts');
const SUPPORTED_PLATFORMS = new Set(['darwin', 'win32', 'linux']);
const SUPPORTED_ARCHES = new Set(['arm64', 'x64']);
const READY_MARKERS = [
  'runtime.window-ready',
  'renderer.loaded',
];

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

function isFile(filePath) {
  try { return statSync(filePath).isFile(); } catch { return false; }
}

function isDirectory(directoryPath) {
  try { return statSync(directoryPath).isDirectory(); } catch { return false; }
}

function listDirectory(directoryPath) {
  try { return readdirSync(directoryPath, { withFileTypes: true }); } catch { return []; }
}

function walkFiles(rootPath, maxDepth = Infinity) {
  const files = [];
  const visit = (currentPath, depth) => {
    if (depth > maxDepth) return;
    for (const entry of listDirectory(currentPath)) {
      const entryPath = path.join(currentPath, entry.name);
      let entryStats;
      try { entryStats = lstatSync(entryPath); } catch { continue; }
      if (entryStats.isSymbolicLink()) {
        try { if (statSync(entryPath).isFile()) files.push(entryPath); } catch {}
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

function findAppBundles(rootPath, maxDepth = 5) {
  const bundles = [];
  const visit = (currentPath, depth) => {
    if (depth > maxDepth) return;
    for (const entry of listDirectory(currentPath)) {
      if (!entry.isDirectory() || entry.name.startsWith('.')) continue;
      const entryPath = path.join(currentPath, entry.name);
      if (entry.name.endsWith('.app')) bundles.push(entryPath);
      else visit(entryPath, depth + 1);
    }
  };
  if (isDirectory(rootPath)) visit(rootPath, 0);
  return bundles;
}

function firstFile(directoryPath, predicate) {
  return walkFiles(directoryPath, 3)
    .filter((filePath) => predicate(filePath))
    .sort((left, right) => left.localeCompare(right))[0] || null;
}

function executableForPackage(packagePath, platform) {
  if (isFile(packagePath)) return packagePath;

  if (platform === 'darwin') {
    const macOsPath = path.join(packagePath, 'Contents', 'MacOS');
    return firstFile(macOsPath, (filePath) => !path.basename(filePath).startsWith('.'));
  }

  const productNames = platform === 'win32'
    ? ['VaniScript-Electron.exe', 'vaniscript.exe']
    : ['VaniScript-Electron', 'vaniscript'];
  for (const name of productNames) {
    const directPath = path.join(packagePath, name);
    if (isFile(directPath)) return directPath;
  }

  if (platform === 'win32') {
    return firstFile(packagePath, (filePath) => path.extname(filePath).toLowerCase() === '.exe'
      && !/unins|uninstall/i.test(path.basename(filePath)));
  }
  return firstFile(packagePath, (filePath) => !path.extname(filePath)
    && !/chrome-sandbox|crashpad|ffmpeg|llama/i.test(path.basename(filePath)));
}

function locateExecutable(releaseDir, platform, explicitPackagePath) {
  if (explicitPackagePath) {
    const packagePath = resolvePath(explicitPackagePath);
    const executable = executableForPackage(packagePath, platform);
    if (!executable) throw new Error(`No packaged executable found under ${packagePath}`);
    return { executable, packagePath };
  }

  if (isFile(releaseDir)) return { executable: releaseDir, packagePath: releaseDir };
  if (!isDirectory(releaseDir)) return null;

  if (platform === 'darwin') {
    const appBundle = releaseDir.endsWith('.app') ? releaseDir : findAppBundles(releaseDir)[0];
    if (appBundle) {
      const executable = executableForPackage(appBundle, platform);
      if (executable) return { executable, packagePath: appBundle };
    }
  }

  const unpackedName = platform === 'win32' ? 'win-unpacked' : 'linux-unpacked';
  const unpackedPath = path.basename(releaseDir) === unpackedName
    ? releaseDir
    : path.join(releaseDir, unpackedName);
  if (isDirectory(unpackedPath)) {
    const executable = executableForPackage(unpackedPath, platform);
    if (executable) return { executable, packagePath: unpackedPath };
  }

  const directExecutable = executableForPackage(releaseDir, platform);
  if (directExecutable) return { executable: directExecutable, packagePath: releaseDir };

  if (platform === 'linux') {
    const appImage = walkFiles(releaseDir, 3)
      .filter((filePath) => /\.appimage$/iu.test(filePath) && !/\.blockmap$/iu.test(filePath))
      .sort((left, right) => left.localeCompare(right))[0];
    if (appImage) return { executable: appImage, packagePath: appImage };
  }
  return null;
}

function gitSha() {
  return process.env.GITHUB_SHA || process.env.GIT_SHA || 'unknown';
}

function buildTargetFor(platform) {
  if (platform === 'darwin') return 'dmg+zip';
  if (platform === 'win32') return 'nsis';
  return 'appimage';
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
    installerArtifact: { exists: false, sizeBytes: 0, sha256: '0'.repeat(64) },
    contentChecks: [],
    bootSmoke: { passed: false, durationMs: 0, detail: 'Not run.' },
    e2eScenarios: [],
    findings: [],
    overallStatus: 'fail',
  };
}

function loadReport(outputPath, platform, arch) {
  try {
    const existing = JSON.parse(readFileSync(outputPath, 'utf8'));
    if (existing && existing.schemaVersion === 1) return { ...baseReport(platform, arch), ...existing, os: platform, arch };
  } catch {}
  return baseReport(platform, arch);
}

function createSandbox() {
  const root = mkdtempSync(path.join(tmpdir(), 'vaniscript-boot-smoke-'));
  const home = path.join(root, 'home');
  const userData = path.join(root, 'userData');
  const documents = path.join(home, 'Documents');
  const config = path.join(root, 'config');
  const data = path.join(root, 'data');
  const cache = path.join(root, 'cache');
  for (const directoryPath of [home, userData, documents, config, data, cache]) mkdirSync(directoryPath, { recursive: true, mode: 0o700 });
  return { root, home, userData, documents, config, data, cache };
}

function terminateProcess(child, signal, detached) {
  if (!child.pid) return;
  try {
    process.kill(detached ? -child.pid : child.pid, signal);
  } catch {
    try { process.kill(child.pid, signal); } catch {}
  }
}

function launchBoot(executable, platform, timeoutMs, sandbox) {
  const env = {
    ...process.env,
    HOME: sandbox.home,
    USERPROFILE: sandbox.home,
    TMPDIR: sandbox.root,
    XDG_CONFIG_HOME: sandbox.config,
    XDG_DATA_HOME: sandbox.data,
    XDG_CACHE_HOME: sandbox.cache,
  };
  const appArgs = [`--user-data-dir=${sandbox.userData}`];
  if (platform === 'linux') appArgs.push('--disable-gpu', '--no-sandbox', '--disable-dev-shm-usage');

  let command = executable;
  let commandArgs = appArgs;
  let wrappedByXvfb = false;
  if (platform === 'linux' && !env.DISPLAY) {
    command = optionValue('--xvfb-bin', process.env.P4D5_XVFB_BIN || 'xvfb-run');
    commandArgs = ['--auto-servernum', '--server-args=-screen 0 1280x720x24', executable, ...appArgs];
    wrappedByXvfb = true;
  }

  const detached = process.platform !== 'win32';
  const startedAt = Date.now();
  const child = spawn(command, commandArgs, {
    cwd: projectRoot,
    env,
    stdio: ['ignore', 'pipe', 'pipe'],
    detached,
    windowsHide: true,
  });

  return new Promise((resolve) => {
    let output = '';
    let readyMarker = null;
    let readyAt = 0;
    let exited = false;
    let terminationStarted = false;
    let timedOut = false;
    let settled = false;
    let forceTimer = null;
    let timeoutTimer = null;
    let finalTimer = null;

    const appendOutput = (stream, chunk) => {
      const text = chunk.toString();
      output = `${output}${text}`.slice(-16 * 1024);
      if (!readyMarker) {
        readyMarker = READY_MARKERS.find((marker) => output.includes(marker));
        if (readyMarker) {
          readyAt = Date.now();
          terminationStarted = true;
          terminateProcess(child, 'SIGTERM', detached);
          forceTimer = setTimeout(() => {
            if (!exited) terminateProcess(child, 'SIGKILL', detached);
          }, 5000);
        }
      }
      if (stream === 'stderr' && /(?:fatal|uncaught|failed|error)/iu.test(text)) {
        // Keep stderr in the bounded diagnostic buffer; readiness still comes from an existing app marker.
      }
    };

    const finish = (passed, detail) => {
      if (settled) return;
      settled = true;
      clearTimeout(timeoutTimer);
      clearTimeout(forceTimer);
      clearTimeout(finalTimer);
      resolve({
        passed,
        durationMs: Math.max(0, (readyAt || Date.now()) - startedAt),
        detail,
        outputTail: output.slice(-4096),
        wrappedByXvfb,
        exited,
      });
    };

    child.stdout?.on('data', (chunk) => appendOutput('stdout', chunk));
    child.stderr?.on('data', (chunk) => appendOutput('stderr', chunk));
    child.once('error', (error) => {
      if (!terminationStarted) finish(false, `Packaged app failed to launch: ${error.message}`);
    });
    child.once('exit', (code, signal) => {
      exited = true;
      if (readyMarker && !timedOut) {
        finish(true, `Observed existing ${readyMarker} readiness marker after ${readyAt - startedAt}ms; process exited after SIGTERM${signal ? ` (${signal})` : ` (code ${code ?? 'unknown'})`}.`);
      } else if (timedOut) {
        finish(false, `Timed out after ${timeoutMs}ms waiting for an existing readiness marker; terminated with SIGTERM${signal ? ` then ${signal}` : ' then SIGKILL fallback if needed'}.`);
      } else {
        finish(false, `Packaged app exited before readiness (code ${code ?? 'unknown'}, signal ${signal || 'none'}).`);
      }
    });

    timeoutTimer = setTimeout(() => {
      if (readyMarker || exited) return;
      timedOut = true;
      terminationStarted = true;
      terminateProcess(child, 'SIGTERM', detached);
      forceTimer = setTimeout(() => {
        if (!exited) terminateProcess(child, 'SIGKILL', detached);
      }, 1000);
      finalTimer = setTimeout(() => {
        if (!exited) finish(false, `Timed out after ${timeoutMs}ms waiting for an existing readiness marker; SIGTERM and SIGKILL fallback were issued.`);
      }, 2500);
    }, timeoutMs);
  });
}

async function main() {
  if (process.argv.includes('--help')) {
    console.log('Usage: node scripts/boot-smoke.mjs [--release-dir PATH] [--package-dir PATH] [--output PATH] [--os darwin|win32|linux] [--arch arm64|x64] [--timeout-ms 30000]');
    return;
  }

  const platform = normalizePlatform(optionValue('--os', process.env.P4D5_OS || process.env.P4D5_TARGET_OS || process.platform));
  const arch = normalizeArch(optionValue('--arch', process.env.P4D5_ARCH || process.env.P4D5_TARGET_ARCH || process.arch));
  const timeoutMs = Number(optionValue('--timeout-ms', process.env.P4D5_BOOT_TIMEOUT_MS || 30000));
  if (!Number.isInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 300000) throw new Error(`Invalid --timeout-ms value: ${timeoutMs}`);
  const releaseDir = resolvePath(
    optionValue('--release-dir', process.env.P4D5_RELEASE_DIR || process.env.P4D5_RELEASE_PATH),
    defaultReleaseDir,
  );
  const outputPath = reportPathFor(platform);
  const report = loadReport(outputPath, platform, arch);
  const sandbox = createSandbox();
  let result;

  try {
    const located = locateExecutable(
      releaseDir,
      platform,
      optionValue('--package-dir', process.env.P4D5_PACKAGE_DIR || process.env.P4D5_APP_PATH),
    );
    if (!located) throw new Error(`No packaged ${platform} executable found under ${releaseDir}`);
    console.log(`Launching ${located.executable}${platform === 'linux' && !process.env.DISPLAY ? ' under xvfb-run' : ''} with isolated HOME/userData/Documents.`);
    result = await launchBoot(located.executable, platform, timeoutMs, sandbox);
    if (!result.passed && result.outputTail) console.error(result.outputTail);
  } catch (error) {
    result = {
      passed: false,
      durationMs: 0,
      detail: error.stack || error.message || String(error),
      outputTail: '',
      wrappedByXvfb: false,
      exited: false,
    };
  } finally {
    try { rmSync(sandbox.root, { recursive: true, force: true }); } catch {}
  }

  report.bootSmoke = {
    passed: result.passed,
    durationMs: result.durationMs,
    detail: result.detail,
  };
  const contentFailed = report.contentChecks.some((check) => check && check.passed === false);
  const e2eFailed = report.e2eScenarios.some((scenario) => scenario && scenario.passed === false);
  report.overallStatus = result.passed && !contentFailed && !e2eFailed ? 'partial' : 'fail';
  report.timestamp = report.timestamp || new Date().toISOString();
  mkdirSync(path.dirname(outputPath), { recursive: true });
  writeFileSync(outputPath, `${JSON.stringify(report, null, 2)}\n`, 'utf8');
  console.log(`Wrote ${outputPath}`);
  if (!result.passed) process.exitCode = 1;
}

main().catch((error) => {
  console.error(error.stack || error.message || String(error));
  process.exitCode = 1;
});
