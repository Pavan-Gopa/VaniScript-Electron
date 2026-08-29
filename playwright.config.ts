import fs from 'node:fs';
import path from 'node:path';
import { defineConfig } from '@playwright/test';

const jsonReportPath = process.env.VANISCRIPT_E2E_REPORT_PATH ?? './test-results/e2e/results.json';

function firstEntry(directory: string, predicate: (entry: fs.Dirent) => boolean): string | null {
  if (!fs.existsSync(directory)) return null;
  return fs.readdirSync(directory, { withFileTypes: true })
    .filter(predicate)
    .map((entry) => entry.name)
    .sort()[0] ?? null;
}

/** Resolve the unsigned electron-builder --dir output for the current runner. */
export function resolvePackagedExecutable(platform = process.platform): string {
  const release = path.resolve(__dirname, 'release');

  if (platform === 'darwin') {
    const root = path.join(release, 'mac-arm64');
    const appName = firstEntry(root, (entry) => entry.isDirectory() && entry.name.endsWith('.app'));
    if (!appName) throw new Error(`No macOS packaged app found under ${root}; run npm run pack first.`);
    const macOSDir = path.join(root, appName, 'Contents', 'MacOS');
    const executable = firstEntry(macOSDir, (entry) => entry.isFile());
    if (!executable) throw new Error(`No macOS app executable found under ${macOSDir}.`);
    return path.join(macOSDir, executable);
  }

  if (platform === 'win32') {
    const root = path.join(release, 'win-unpacked');
    const executable = firstEntry(root, (entry) => entry.isFile() && entry.name.toLowerCase().endsWith('.exe'));
    if (!executable) throw new Error(`No Windows packaged executable found under ${root}; run npm run pack first.`);
    return path.join(root, executable);
  }

  if (platform === 'linux') {
    const root = path.join(release, 'linux-unpacked');
    const executable = firstEntry(root, (entry) => (
      entry.isFile()
      && ['vaniscript', 'VaniScript-Electron'].includes(entry.name)
      && (fs.statSync(path.join(root, entry.name)).mode & 0o111) !== 0
    ));
    if (!executable) throw new Error(`No Linux packaged executable found under ${root}; run npm run pack first.`);
    return path.join(root, executable);
  }

  throw new Error(`Unsupported Playwright Electron platform: ${platform}`);
}

export default defineConfig({
  testDir: './test/e2e',
  outputDir: './test-results/e2e',
  retries: 2,
  timeout: 120_000,
  expect: { timeout: 15_000 },
  fullyParallel: false,
  workers: 1,
  reporter: [
    ['list'],
    ['json', { outputFile: jsonReportPath }],
  ],
  // Electron uses the bundled Chromium runtime; no Playwright browser download is needed.
  use: {
    screenshot: 'only-on-failure',
    video: 'retain-on-failure',
    trace: 'retain-on-failure',
  },
});
