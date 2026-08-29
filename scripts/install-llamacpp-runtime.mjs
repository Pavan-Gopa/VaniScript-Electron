#!/usr/bin/env node

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import https from 'node:https';
import { createHash } from 'node:crypto';
import { execFileSync, spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
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
async function hashFile(filePath) {
  const hash = createHash('sha256');
  for await (const chunk of fs.createReadStream(filePath)) hash.update(chunk);
  return hash.digest('hex');
}

function expectedDigestFor(asset) {
  if (asset.digest === undefined || asset.digest === null || asset.digest === '') return null;
  if (typeof asset.digest !== 'string' || !/^sha256:[0-9a-f]{64}$/i.test(asset.digest)) {
    throw new Error(`Unsupported or malformed GitHub asset digest for ${asset.name}: ${asset.digest}`);
  }
  return asset.digest.slice('sha256:'.length).toLowerCase();
}

async function verifyArchiveDigest(archivePath, expectedDigest) {
  const actualDigest = await hashFile(archivePath);
  if (!expectedDigest) {
    console.log(`SHA-256 ${archivePath}: ${actualDigest}`);
    return actualDigest;
  }
  if (actualDigest !== expectedDigest) {
    throw new Error(`SHA-256 mismatch for ${archivePath}: expected ${expectedDigest}, got ${actualDigest}`);
  }
  console.log(`Verified SHA-256 ${archivePath}: ${actualDigest}`);
  return actualDigest;
}

function listArchiveMembers(archivePath) {
  const lowerPath = archivePath.toLowerCase();
  try {
    if (lowerPath.endsWith('.tar.gz')) {
      return execFileSync('tar', ['-tzf', archivePath], { encoding: 'utf8' })
        .split(/\r?\n/)
        .filter(Boolean);
    }
    if (lowerPath.endsWith('.zip')) {
      if (process.platform === 'win32') {
        const escapedPath = archivePath.replaceAll("'", "''");
        const command = `Add-Type -AssemblyName System.IO.Compression.FileSystem; $archive = [System.IO.Compression.ZipFile]::OpenRead('${escapedPath}'); try { $archive.Entries | ForEach-Object { $_.FullName } } finally { $archive.Dispose() }`;
        return execFileSync('powershell', ['-NoProfile', '-NonInteractive', '-Command', command], { encoding: 'utf8' })
          .split(/\r?\n/)
          .filter(Boolean);
      }
      return execFileSync('unzip', ['-Z1', archivePath], { encoding: 'utf8' })
        .split(/\r?\n/)
        .filter(Boolean);
    }
  } catch (error) {
    throw new Error(`Unable to list archive members for ${archivePath}: ${error.message}`);
  }
  throw new Error(`Unsupported archive format: ${archivePath}`);
}

function isWithin(rootPath, candidatePath) {
  const relativePath = path.relative(rootPath, candidatePath);
  return relativePath === ''
    || (relativePath !== '..' && !relativePath.startsWith(`..${path.sep}`) && !path.isAbsolute(relativePath));
}

function validateArchiveMembers(archivePath, extractionDir) {
  const extractionRoot = path.resolve(extractionDir);
  for (const rawMember of listArchiveMembers(archivePath)) {
    const member = rawMember.replaceAll('\\', '/');
    if (!member || member.includes('\0') || member.includes('..')
      || path.posix.isAbsolute(member) || path.win32.isAbsolute(member)) {
      throw new Error(`Unsafe archive member path rejected: ${rawMember}`);
    }
    const resolvedMember = path.resolve(extractionRoot, member);
    if (!isWithin(extractionRoot, resolvedMember)) {
      throw new Error(`Archive member escapes extraction root: ${rawMember}`);
    }
  }
}

async function extractArchive(archivePath, extractionDir) {
  validateArchiveMembers(archivePath, extractionDir);
  fs.rmSync(extractionDir, { recursive: true, force: true });
  fs.mkdirSync(extractionDir, { recursive: true });
  const lowerPath = archivePath.toLowerCase();
  if (lowerPath.endsWith('.tar.gz')) {
    await run('tar', ['-xzf', archivePath, '-C', extractionDir]);
    return;
  }
  if (lowerPath.endsWith('.zip')) {
    if (process.platform === 'win32') {
      const archive = archivePath.replaceAll("'", "''");
      const destination = extractionDir.replaceAll("'", "''");
      await run('powershell', ['-NoProfile', '-NonInteractive', '-Command', `Expand-Archive -LiteralPath '${archive}' -DestinationPath '${destination}' -Force`]);
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

function copyMaterialized(sourcePath, destinationPath, sourceRoot, linkStack = new Set()) {
  const extractionRoot = path.resolve(sourceRoot);
  const resolvedSourcePath = path.resolve(sourcePath);
  if (!isWithin(extractionRoot, resolvedSourcePath)) {
    throw new Error(`Archive symlink escapes extraction root: ${sourcePath}`);
  }

  const stats = fs.lstatSync(resolvedSourcePath);
  if (stats.isSymbolicLink()) {
    if (linkStack.has(resolvedSourcePath)) throw new Error(`Archive symlink cycle detected: ${resolvedSourcePath}`);
    const linkTarget = fs.readlinkSync(resolvedSourcePath);
    const normalizedTarget = linkTarget.replaceAll('\\', '/');
    const resolvedSource = path.resolve(path.dirname(resolvedSourcePath), normalizedTarget);
    if (path.posix.isAbsolute(normalizedTarget) || path.win32.isAbsolute(normalizedTarget)
      || !isWithin(extractionRoot, resolvedSource)) {
      throw new Error(`Archive symlink escapes extraction root: ${resolvedSourcePath} -> ${linkTarget}`);
    }
    const nextLinkStack = new Set(linkStack);
    nextLinkStack.add(resolvedSourcePath);
    copyMaterialized(resolvedSource, destinationPath, extractionRoot, nextLinkStack);
    return;
  }

  if (stats.isDirectory()) {
    fs.mkdirSync(destinationPath, { recursive: true });
    for (const entry of fs.readdirSync(resolvedSourcePath)) {
      copyMaterialized(path.join(resolvedSourcePath, entry), path.join(destinationPath, entry), extractionRoot, linkStack);
    }
    return;
  }

  fs.mkdirSync(path.dirname(destinationPath), { recursive: true });
  fs.copyFileSync(resolvedSourcePath, destinationPath);
}

async function main() {
  const platform = process.argv.includes('--platform')
    ? process.argv[process.argv.indexOf('--platform') + 1]
    : process.platform;
  const arch = process.argv.includes('--arch')
    ? process.argv[process.argv.indexOf('--arch') + 1]
    : process.arch;

  let release = await requestJson('https://api.github.com/repos/ggml-org/llama.cpp/releases/latest');
  const assetPattern = assetPatternFor(platform, arch);
  let asset = release.assets?.find((candidate) => assetPattern.test(candidate.name));
  if (!asset) {
    const releases = await requestJson('https://api.github.com/repos/ggml-org/llama.cpp/releases');
    const fallback = releases
      .filter((candidate) => candidate.assets?.some((candidateAsset) => assetPattern.test(candidateAsset.name)))
      .sort((left, right) => new Date(right.published_at) - new Date(left.published_at))[0];
    if (fallback) {
      release = fallback;
      asset = release.assets.find((candidate) => assetPattern.test(candidate.name));
    }
  }
  if (!asset) {
    throw new Error(`No matching llama.cpp asset found for ${platform}/${arch} in release ${release.tag_name} or the first page of releases`);
  }
  const expectedDigest = expectedDigestFor(asset);
  const runtimeKey = runtimeKeyFor(platform, arch);
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), `vaniscript-llamacpp-${runtimeKey}-`));
  const archivePath = path.join(tempRoot, asset.name);
  const extractionDir = path.join(tempRoot, 'extract');
  const destinationDir = path.join(vendorRoot, runtimeKey);

  console.log(`Downloading ${asset.name} from ${release.tag_name}...`);
  await downloadFile(asset.browser_download_url, archivePath);
  await verifyArchiveDigest(archivePath, expectedDigest);
  await extractArchive(archivePath, extractionDir);

  const payloadDir = findSinglePayloadDirectory(extractionDir);
  fs.rmSync(destinationDir, { recursive: true, force: true });
  fs.mkdirSync(path.dirname(destinationDir), { recursive: true });
  copyMaterialized(payloadDir, destinationDir, extractionDir);

  console.log(`Installed llama.cpp runtime to ${destinationDir}`);
}

main().catch((error) => {
  console.error(error.stack || error.message || String(error));
  process.exit(1);
});
