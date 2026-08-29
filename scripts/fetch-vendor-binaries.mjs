#!/usr/bin/env node

import { createHash } from 'node:crypto';
import fs from 'node:fs';
import https from 'node:https';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawn } from 'node:child_process';
import { pipeline } from 'node:stream/promises';

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const llamacppInstaller = path.join(projectRoot, 'scripts', 'install-llamacpp-runtime.mjs');
const llamacppRoot = path.join(projectRoot, 'vendor', 'llamacpp');
const ytDlpRoot = path.join(projectRoot, 'vendor', 'yt-dlp');
const supportedRuntimeKeys = new Set([
  'darwin-arm64',
  'darwin-x64',
  'linux-arm64',
  'linux-x64',
  'win32-arm64',
  'win32-x64',
]);

const ytDlpSpecs = new Map([
  // Current releases call the universal macOS executable yt-dlp_macos. Keep
  // yt-dlp as a fallback for releases using the historical asset name.
  ['darwin-arm64', { directory: 'darwin', executable: 'yt-dlp', assetNames: ['yt-dlp_macos', 'yt-dlp'] }],
  ['darwin-x64', { directory: 'darwin', executable: 'yt-dlp', assetNames: ['yt-dlp_macos', 'yt-dlp'] }],
  ['linux-arm64', { directory: 'linux', executable: 'yt-dlp', assetNames: ['yt-dlp_linux_aarch64'] }],
  ['linux-x64', { directory: 'linux', executable: 'yt-dlp', assetNames: ['yt-dlp_linux'] }],
  ['win32-arm64', { directory: 'win32', executable: 'yt-dlp.exe', assetNames: ['yt-dlp_arm64.exe'] }],
  ['win32-x64', { directory: 'win32', executable: 'yt-dlp.exe', assetNames: ['yt-dlp.exe'] }],
]);

function flagValue(name, fallback) {
  const index = process.argv.indexOf(name);
  if (index === -1) return fallback;
  const value = process.argv[index + 1];
  if (!value || value.startsWith('--')) {
    throw new Error(`Missing value for ${name}`);
  }
  return value;
}

function requestJson(url) {
  return new Promise((resolve, reject) => {
    const request = https.get(url, {
      headers: {
        'User-Agent': 'VaniScript-vendor-installer',
        Accept: 'application/vnd.github+json',
      },
    }, (response) => {
      if (response.statusCode >= 300 && response.statusCode < 400 && response.headers.location) {
        response.resume();
        return resolve(requestJson(response.headers.location));
      }
      if (response.statusCode !== 200) {
        response.resume();
        return reject(new Error(`HTTP ${response.statusCode} while requesting ${url}`));
      }

      let body = '';
      response.setEncoding('utf8');
      response.on('data', (chunk) => { body += chunk; });
      response.on('end', () => {
        try {
          resolve(JSON.parse(body));
        } catch (error) {
          reject(new Error(`Invalid JSON from ${url}: ${error.message}`));
        }
      });
    });
    request.on('error', reject);
  });
}

async function downloadFile(url, destinationPath, expectedSize) {
  const temporaryPath = `${destinationPath}.download-${process.pid}`;
  fs.rmSync(temporaryPath, { force: true });
  fs.mkdirSync(path.dirname(destinationPath), { recursive: true });

  const receive = (targetUrl) => new Promise((resolve, reject) => {
    const request = https.get(targetUrl, {
      headers: { 'User-Agent': 'VaniScript-vendor-installer' },
    }, (response) => {
      if (response.statusCode >= 300 && response.statusCode < 400 && response.headers.location) {
        response.resume();
        return receive(response.headers.location).then(resolve, reject);
      }
      if (response.statusCode !== 200) {
        response.resume();
        return reject(new Error(`HTTP ${response.statusCode} while downloading ${targetUrl}`));
      }

      let bytes = 0;
      response.on('data', (chunk) => { bytes += chunk.length; });
      pipeline(response, fs.createWriteStream(temporaryPath)).then(() => {
        if (Number.isInteger(expectedSize) && bytes !== expectedSize) {
          reject(new Error(`Downloaded ${targetUrl} has ${bytes} bytes; expected ${expectedSize}`));
          return;
        }
        resolve();
      }, reject);
    });
    request.on('error', reject);
  });

  try {
    await receive(url);
    fs.renameSync(temporaryPath, destinationPath);
  } catch (error) {
    fs.rmSync(temporaryPath, { force: true });
    throw error;
  }
}

async function sha256File(filePath) {
  const hash = createHash('sha256');
  for await (const chunk of fs.createReadStream(filePath)) {
    hash.update(chunk);
  }
  return hash.digest('hex');
}

function nonEmptyFile(filePath) {
  try {
    return fs.statSync(filePath).isFile() && fs.statSync(filePath).size > 0;
  } catch {
    return false;
  }
}

function expectedDigestFor(asset) {
  if (asset.digest === undefined || asset.digest === null || asset.digest === '') return null;
  if (typeof asset.digest !== 'string' || !/^sha256:[0-9a-f]{64}$/i.test(asset.digest)) {
    throw new Error(`Unsupported or malformed GitHub asset digest for ${asset.name}: ${asset.digest}`);
  }
  return asset.digest.slice('sha256:'.length).toLowerCase();
}

function assetFor(release, assetNames, platform, arch) {
  const asset = assetNames
    .map((name) => release.assets?.find((candidate) => candidate.name === name))
    .find(Boolean);
  if (!asset) {
    throw new Error(`No yt-dlp asset (${assetNames.join(' or ')}) found for ${platform}/${arch} in release ${release.tag_name ?? 'unknown'}`);
  }
  if (!asset.browser_download_url || !Number.isInteger(asset.size) || asset.size <= 0) {
    throw new Error(`yt-dlp release asset ${asset.name} has incomplete download metadata`);
  }
  return asset;
}

async function ensureLlamacpp(platform, arch, force) {
  const runtimeKey = `${platform}-${arch}`;
  const executable = platform === 'win32' ? 'llama-cli.exe' : 'llama-cli';
  const executablePath = path.join(llamacppRoot, runtimeKey, executable);
  if (!force && nonEmptyFile(executablePath)) {
    console.log(`Skipping llama.cpp ${runtimeKey}; ${executablePath} is already present.`);
    return;
  }

  console.log(`${force ? 'Refreshing' : 'Installing'} llama.cpp runtime for ${runtimeKey}...`);
  await run(process.execPath, [llamacppInstaller, '--platform', platform, '--arch', arch]);
  if (!nonEmptyFile(executablePath)) {
    throw new Error(`llama.cpp installer completed but did not produce ${executablePath}`);
  }
}

async function ensureYtDlp(platform, arch, force) {
  const runtimeKey = `${platform}-${arch}`;
  const spec = ytDlpSpecs.get(runtimeKey);
  if (!spec) {
    throw new Error(`Unsupported platform/arch for yt-dlp downloader: ${platform}/${arch}`);
  }

  const destinationPath = path.join(ytDlpRoot, spec.directory, spec.executable);
  if (!force && nonEmptyFile(destinationPath)) {
    console.log(`Skipping yt-dlp ${runtimeKey}; ${destinationPath} is already present.`);
    return;
  }

  const release = await requestJson('https://api.github.com/repos/yt-dlp/yt-dlp/releases/latest');
  const asset = assetFor(release, spec.assetNames, platform, arch);
  const digest = expectedDigestFor(asset);
  let existingSize = null;
  try {
    const stats = fs.statSync(destinationPath);
    if (stats.isFile()) existingSize = stats.size;
  } catch {}

  if (existingSize !== null) {
    console.log(`Refreshing yt-dlp ${runtimeKey}; --force was requested.`);
  } else {
    console.log(`Downloading yt-dlp ${asset.name} (${asset.size} bytes) for ${runtimeKey}...`);
  }
  await downloadFile(asset.browser_download_url, destinationPath, asset.size);
  const actualDigest = await sha256File(destinationPath);
  if (digest && actualDigest !== digest) {
    fs.rmSync(destinationPath, { force: true });
    throw new Error(`SHA-256 mismatch for ${destinationPath}: got ${actualDigest}, expected ${digest}`);
  }
  if (digest) {
    console.log(`Verified yt-dlp ${asset.name} SHA-256: ${actualDigest}`);
  } else {
    console.log(`SHA-256 ${destinationPath}: ${actualDigest}`);
  }
  if (platform !== 'win32') fs.chmodSync(destinationPath, 0o755);
  console.log(`Installed yt-dlp to ${destinationPath}`);
}


function run(command, args) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { stdio: 'inherit' });
    child.on('error', reject);
    child.on('close', (code, signal) => {
      if (code !== 0) {
        reject(new Error(`${command} exited with ${code === null ? `signal ${signal}` : `code ${code}`}`));
        return;
      }
      resolve();
    });
  });
}

async function main() {
  const platform = flagValue('--platform', process.platform);
  const arch = flagValue('--arch', process.arch);
  const runtimeKey = `${platform}-${arch}`;
  if (!supportedRuntimeKeys.has(runtimeKey)) {
    throw new Error(`Unsupported platform/arch: ${platform}/${arch}. Supported targets: ${[...supportedRuntimeKeys].join(', ')}`);
  }

  const force = process.argv.includes('--force');
  await ensureLlamacpp(platform, arch, force);
  await ensureYtDlp(platform, arch, force);
}

main().catch((error) => {
  console.error(error.stack || error.message || String(error));
  process.exit(1);
});
