#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(__dirname, '..');
const sourceApp = path.join(root, 'node_modules', 'electron', 'dist', 'Electron.app');
const targetResources = path.join(sourceApp, 'Contents', 'Resources');
const infoPlist = path.join(sourceApp, 'Contents', 'Info.plist');
const iconSource = path.join(root, 'assets', 'icon.icns');
const iconTarget = path.join(targetResources, 'VaniScript.icns');

function run(cmd, args) {
  const result = spawnSync(cmd, args, { stdio: 'pipe', encoding: 'utf8' });
  if (result.status !== 0) {
    throw new Error(`${cmd} ${args.join(' ')} failed\n${result.stderr || result.stdout}`);
  }
  return result.stdout.trim();
}

function plistSet(key, value) {
  const set = spawnSync('/usr/libexec/PlistBuddy', ['-c', `Set :${key} ${value}`, infoPlist], { encoding: 'utf8' });
  if (set.status === 0) return;
  run('/usr/libexec/PlistBuddy', ['-c', `Add :${key} string ${value}`, infoPlist]);
}

if (!fs.existsSync(sourceApp)) {
  throw new Error(`Electron.app not found at ${sourceApp}. Run npm install first.`);
}
if (!fs.existsSync(iconSource)) {
  throw new Error(`VaniScript icon not found at ${iconSource}.`);
}

fs.copyFileSync(iconSource, iconTarget);

// Patch the local Electron runtime in place. Keeping the original bundle path
// avoids breaking Chromium helper discovery, while CFBundleName controls the
// first macOS menu item in development.
plistSet('CFBundleName', 'VaniScript-Electron');
plistSet('CFBundleDisplayName', 'VaniScript-Electron');
plistSet('CFBundleExecutable', 'Electron');
plistSet('CFBundleIconFile', 'VaniScript');
plistSet('CFBundleShortVersionString', '1.0.0');
plistSet('CFBundleVersion', '1.0.0');

console.log(sourceApp);
