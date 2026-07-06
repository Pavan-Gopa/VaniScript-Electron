#!/usr/bin/env node

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import https from 'node:https';
import { spawn } from 'node:child_process';

const projectRoot = path.resolve(path.dirname(new URL(import.meta.url).pathname), '..');
const vendorRoot = path.join(projectRoot, 'vendor', 'llamacpp');

function runtimeKeyFor(platform = process.platform, arch = process.arch) {
  return `${platform}-${arch}`;
}

function assetPatternFor(platform = process.platform, arch = process.arch) {
  if (platform === 'darwin' && arch === 'arm64') return /^llama-b\d+-bin-macos-arm64\.tar\.gz$/;
  if (platform === 'darwin' && arch === 'x64') return /^llama-b\d+-bin-macos-x64\.tar\.gz$/;
  if (platform === 'linux' && arch === 'x64') return /^llama-b\d+-bin-ubuntu-x64\.tar\.gz$/;
  if (platform === 'linux' && arch === 'arm64') return /^llama-b\d+-bin-ubuntu-arm64\.tar\.gz$/;
  if (platform === 'win32' && arch === 'x64') return /^llama-b\d+-bin-win-cpu-x64\.zip$/;
  if (platform === 'win32' && arch === 'arm64') return /^llama-b\d+-bin-win-cpu-arm64\.zip$/;
  throw new Error(`Unsupported platform/arch for llama.cpp runtime installer: ${platform}/${arch}`);
}

function requestJson(url) {
  return new Promise((resolve, reject) => {
    const req = https.get(url, {
      headers: {
        'User-Agent': 'VaniScript-llamacpp-installer',
        'Accept': 'application/vnd.github+json',
      },
    }, (res) => {
      if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
        res.destroy();
        return resolve(requestJson(res.headers.location));
      }
      if (res.statusCode !== 200) {
        res.resume();
        return reject(new Error(`HTTP ${res.statusCode} for ${url}`));
      }
      let body = '';
      res.setEncoding('utf8');
      res.on('data', (chunk) => { body += chunk; });
      res.on('end', () => {
        try {
          resolve(JSON.parse(body));
        } catch (error) {
          reject(error);
        }
      });
    });
    req.on('error', reject);
  });
}

function downloadFile(url, destinationPath) {
  return new Promise((resolve, reject) => {
    fs.mkdirSync(path.dirname(destinationPath), { recursive: true });
    const out = fs.createWriteStream(destinationPath);

    const handle = (targetUrl) => {
      const req = https.get(targetUrl, {
        headers: { 'User-Agent': 'VaniScript-llamacpp-installer' },
      }, (res) => {
        if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
          res.destroy();
          return handle(res.headers.location);
        }
        if (res.statusCode !== 200) {
          res.resume();
          return reject(new Error(`HTTP ${res.statusCode} for ${targetUrl}`));
        }
        res.pipe(out);
        out.on('finish', () => out.close(() => resolve(destinationPath)));
      });
      req.on('error', (error) => {
        try { out.close(); } catch {}
        reject(error);
      });
    };

    handle(url);
  });
}

function run(command, args, options = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { stdio: 'inherit', ...options });
    child.on('error', reject);
    child.on('close', (code) => {
      if (code !== 0) {
        reject(new Error(`${command} exited with code ${code}`));
        return;
      }
      resolve();
    });
  });
}

async function extractArchive(archivePath, extractionDir) {
  fs.mkdirSync(extractionDir, { recursive: true });
  if (archivePath.endsWith('.tar.gz')) {
    await run('tar', ['-xzf', archivePath, '-C', extractionDir]);
    return;
  }
  if (archivePath.endsWith('.zip')) {
    if (process.platform === 'win32') {
      await run('powershell', ['-NoProfile', '-Command', `Expand-Archive -Path "${archivePath}" -DestinationPath "${extractionDir}" -Force`]);
      return;
    }
    await run('unzip', ['-oq', archivePath, '-d', extractionDir]);
    return;
  }
  throw new Error(`Unsupported archive format: ${archivePath}`);
}

function findSinglePayloadDirectory(extractionDir) {
  const entries = fs.readdirSync(extractionDir, { withFileTypes: true })
    .filter((entry) => !entry.name.startsWith('.'));
  if (entries.length === 1 && entries[0].isDirectory()) {
    return path.join(extractionDir, entries[0].name);
  }
  return extractionDir;
}

function copyMaterialized(sourcePath, destinationPath) {
  const stats = fs.lstatSync(sourcePath);
  if (stats.isSymbolicLink()) {
    const linkTarget = fs.readlinkSync(sourcePath);
    const resolvedSource = path.isAbsolute(linkTarget)
      ? linkTarget
      : path.resolve(path.dirname(sourcePath), linkTarget);
    copyMaterialized(resolvedSource, destinationPath);
    return;
  }

  if (stats.isDirectory()) {
    fs.mkdirSync(destinationPath, { recursive: true });
    for (const entry of fs.readdirSync(sourcePath)) {
      copyMaterialized(path.join(sourcePath, entry), path.join(destinationPath, entry));
    }
    return;
  }

  fs.mkdirSync(path.dirname(destinationPath), { recursive: true });
  fs.copyFileSync(sourcePath, destinationPath);
}

async function main() {
  const platform = process.argv.includes('--platform')
    ? process.argv[process.argv.indexOf('--platform') + 1]
    : process.platform;
  const arch = process.argv.includes('--arch')
    ? process.argv[process.argv.indexOf('--arch') + 1]
    : process.arch;

  const release = await requestJson('https://api.github.com/repos/ggml-org/llama.cpp/releases/latest');
  const assetPattern = assetPatternFor(platform, arch);
  const asset = release.assets.find((candidate) => assetPattern.test(candidate.name));
  if (!asset) {
    throw new Error(`No matching llama.cpp asset found for ${platform}/${arch} in release ${release.tag_name}`);
  }

  const runtimeKey = runtimeKeyFor(platform, arch);
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), `vaniscript-llamacpp-${runtimeKey}-`));
  const archivePath = path.join(tempRoot, asset.name);
  const extractionDir = path.join(tempRoot, 'extract');
  const destinationDir = path.join(vendorRoot, runtimeKey);

  console.log(`Downloading ${asset.name} from ${release.tag_name}...`);
  await downloadFile(asset.browser_download_url, archivePath);
  await extractArchive(archivePath, extractionDir);

  const payloadDir = findSinglePayloadDirectory(extractionDir);
  fs.rmSync(destinationDir, { recursive: true, force: true });
  fs.mkdirSync(path.dirname(destinationDir), { recursive: true });
  copyMaterialized(payloadDir, destinationDir);

  console.log(`Installed llama.cpp runtime to ${destinationDir}`);
}

main().catch((error) => {
  console.error(error.stack || error.message || String(error));
  process.exit(1);
});
