import { readFileSync } from 'node:fs';

const packageJson = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'));
const mainSource = readFileSync(new URL('../electron/main.js', import.meta.url), 'utf8');
const devBrandingSource = readFileSync(new URL('./prepare-dev-electron-branding.mjs', import.meta.url), 'utf8');

function expect(condition, message) {
  if (!condition) {
    throw new Error(message);
  }
}

expect(packageJson.build.productName === 'VaniScript-Electron', 'Electron productName must be VaniScript-Electron.');
expect(
  packageJson.build.mac.artifactName === 'VaniScript-Electron.${ext}',
  'Electron mac artifactName must produce VaniScript-Electron.dmg.'
);
expect(mainSource.includes("const APP_NAME = 'VaniScript-Electron';"), 'Electron runtime app name must be VaniScript-Electron.');
expect(devBrandingSource.includes("plistSet('CFBundleName', 'VaniScript-Electron');"), 'Dev bundle name must be VaniScript-Electron.');
expect(
  devBrandingSource.includes("plistSet('CFBundleDisplayName', 'VaniScript-Electron');"),
  'Dev bundle display name must be VaniScript-Electron.'
);

console.log('Electron release identity is VaniScript-Electron.');
