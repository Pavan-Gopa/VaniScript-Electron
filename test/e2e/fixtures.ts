import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { _electron as electron, expect, test as base, type ElectronApplication, type Page } from '@playwright/test';
import { resolvePackagedExecutable } from '../../playwright.config';

// The existing golden fixtures are deterministic and avoid another test-only
// document generator (DOC-01 precedent).
// eslint-disable-next-line @typescript-eslint/no-require-imports
const { getFixture } = require('../fixtures/document-fixtures.js') as {
  getFixture: (format: string) => { buffer: Buffer; fileName: string; assetRef: string };
};

export type E2EProfile = {
  root: string;
  home: string;
  userData: string;
  documents: string;
};

type E2EFixtures = {
  profile: E2EProfile;
  electronApp: ElectronApplication;
  page: Page;
};

const launchArgs = (profile: E2EProfile): string[] => [
  `--user-data-dir=${profile.userData}`,
  ...(process.platform === 'linux' ? ['--no-sandbox', '--disable-gpu'] : []),
];

export interface ReviewSession {
  projectId: string;
  sourceFile: string;
  sourceFileName: string;
  sourceMediaKind: 'audio';
  originalVideoPath: string;
  wavPath: string;
  sourceMediaInfo: Record<string, unknown>;
  durationSec: number;
  currentIndex: number;
  currentChunkIndex: number;
  targetLang: string;
  outputFormats: string[];
  transcriptionProvider: string;
  translationProvider: string;
  config: Record<string, unknown>;
  metadata: Record<string, unknown>;
  chunks: Array<Record<string, unknown>>;
  createdAt: string;
  updatedAt: string;
}

export async function launchForProfile(profile: E2EProfile): Promise<ElectronApplication> {
  return electron.launch({
    executablePath: resolvePackagedExecutable(),
    args: launchArgs(profile),
    env: {
      ...process.env,
      HOME: profile.home,
      USERPROFILE: profile.home,
      ELECTRON_DISABLE_SECURITY_WARNINGS: 'true',
      VANI_E2E: '1',
    },
  });
}
export async function closeElectron(app: ElectronApplication): Promise<void> {
  let child: ReturnType<ElectronApplication['process']> | undefined;
  try {
    child = app.process();
  } catch {
    return;
  }
  await Promise.race([
    Promise.resolve().then(() => app.close()).catch(() => undefined),
    new Promise<void>((resolve) => setTimeout(resolve, 2_000)),
  ]);
  if (child.exitCode === null && !child.killed) child.kill('SIGKILL');
}

export async function firstWindow(app: ElectronApplication): Promise<Page> {
  const existing = app.windows()[0];
  if (existing) return existing;
  return app.waitForEvent('window');
}

export async function waitForApp(page: Page): Promise<void> {
  await page.waitForLoadState('domcontentloaded');
  await expect(page.getByRole('button', { name: 'Projects' })).toBeVisible();
}

export async function skipOnboarding(page: Page): Promise<void> {
  const skip = page.getByRole('button', { name: 'Skip Walkthrough' });
  const appears = await skip.waitFor({ state: 'visible', timeout: 3_000 }).then(() => true).catch(() => false);
  if (appears) {
    await skip.click();
    await expect(skip).toHaveCount(0);
  }
  await waitForApp(page);
}

export async function createProfile(): Promise<E2EProfile> {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'vaniscript-e2e-'));
  const home = path.join(root, 'home');
  const userData = path.join(root, 'user-data');
  const documents = path.join(home, 'Documents');
  await fs.mkdir(documents, { recursive: true });
  return { root, home, userData, documents };
}

export async function writeSilentWav(profile: E2EProfile, name = 'e2e-silent.wav'): Promise<string> {
  const sampleRate = 16_000;
  const channels = 1;
  const bitsPerSample = 16;
  const sampleCount = sampleRate;
  const dataSize = sampleCount * channels * (bitsPerSample / 8);
  const wav = Buffer.alloc(44 + dataSize);
  wav.write('RIFF', 0, 'ascii');
  wav.writeUInt32LE(36 + dataSize, 4);
  wav.write('WAVE', 8, 'ascii');
  wav.write('fmt ', 12, 'ascii');
  wav.writeUInt32LE(16, 16);
  wav.writeUInt16LE(1, 20);
  wav.writeUInt16LE(channels, 22);
  wav.writeUInt32LE(sampleRate, 24);
  wav.writeUInt32LE(sampleRate * channels * (bitsPerSample / 8), 28);
  wav.writeUInt16LE(channels * (bitsPerSample / 8), 32);
  wav.writeUInt16LE(bitsPerSample, 34);
  wav.write('data', 36, 'ascii');
  wav.writeUInt32LE(dataSize, 40);
  const filePath = path.join(profile.documents, name);
  await fs.writeFile(filePath, wav);
  return filePath;
}

export async function writeDocumentFixture(profile: E2EProfile, format = 'txt'): Promise<{ path: string; fileName: string; text: string }> {
  const fixture = getFixture(format);
  const fileName = `e2e-document.${format}`;
  const filePath = path.join(profile.documents, fileName);
  await fs.writeFile(filePath, fixture.buffer);
  return { path: filePath, fileName, text: fixture.buffer.toString('utf8') };
}

export function makeReviewSession(sourceFile: string, sourceFileName: string, projectId: string): ReviewSession {
  const now = new Date().toISOString();
  return {
    projectId,
    sourceFile,
    sourceFileName,
    sourceMediaKind: 'audio',
    originalVideoPath: '',
    wavPath: sourceFile,
    sourceMediaInfo: { kind: 'audio', filePath: sourceFile, fileName: sourceFileName, durationSec: 1 },
    durationSec: 1,
    currentIndex: 0,
    currentChunkIndex: 0,
    targetLang: 'same',
    outputFormats: ['TXT', 'Markdown'],
    transcriptionProvider: 'whisper-local',
    translationProvider: 'none',
    config: {
      date: '',
      location: '',
      lecturer: '',
      participants: '',
      targetLang: 'same',
      formats: ['TXT', 'Markdown'],
      transcriptionProvider: 'whisper-local',
      translationProvider: 'none',
    },
    metadata: { date: '', location: '', lecturer: '', participants: '' },
    chunks: [{
      index: 0,
      startSec: 0,
      endSec: 1,
      original: 'A synthetic review sentence.',
      translated: '',
      status: 'done',
      approved: true,
      audioPath: sourceFile,
      originalCues: [],
      translatedCues: [],
    }],
    createdAt: now,
    updatedAt: now,
  };
}

export async function saveSeedProject(page: Page, session: ReviewSession, screen = 'review') {
  const result = await page.evaluate(async ({ session: payload, screen: route }) => {
    const api = (window as Window & { electronAPI?: { projectSave?: (project: unknown) => Promise<unknown> } }).electronAPI;
    if (!api?.projectSave) throw new Error('projectSave bridge is unavailable');
    return api.projectSave({
      id: payload.projectId,
      name: payload.sourceFileName.replace(/\.[^/.]+$/, ''),
      createdAt: payload.createdAt,
      screen: route,
      session: payload,
    });
  }, { session, screen });
  expect(result).toMatchObject({ ok: true });
}

export const test = base.extend<E2EFixtures>({
  profile: async ({}, use) => {
    const profile = await createProfile();
    await use(profile);
    await fs.rm(profile.root, { recursive: true, force: true });
  },
  electronApp: async ({ profile }, use) => {
    const app = await launchForProfile(profile);
    await use(app);
    await closeElectron(app);
  },
  page: async ({ electronApp }, use) => {
    await use(await firstWindow(electronApp));
  },
});

export { expect };
