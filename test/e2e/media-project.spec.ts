import {
  expect,
  makeReviewSession,
  saveSeedProject,
  skipOnboarding,
  test,
  waitForApp,
  writeSilentWav,
} from './fixtures';

test('media project uploads, handles offline provider gating, reopens, edits, and exports', async ({ page, profile }) => {
  await waitForApp(page);
  await skipOnboarding(page);

  const mediaPath = await writeSilentWav(profile);
  await page.locator('input[type="file"]').setInputFiles(mediaPath);
  await expect(page.getByText('Engine Configuration')).toBeVisible();

  // A fresh isolated profile has no cloud keys or downloaded local models.
  const comboboxes = page.getByRole('combobox');
  await expect(comboboxes.nth(1)).toHaveValue('');
  await expect(comboboxes.nth(1).locator('option:checked')).toHaveText('No models available');
  await comboboxes.nth(0).selectOption('Spanish');
  await expect(comboboxes.nth(2).locator('option:checked')).toHaveText('No translation models available');
  await expect(page.getByRole('button', { name: 'Initialize Engine' })).toBeDisabled();
  await page.getByRole('button', { name: 'Cancel' }).click();
  await expect(page.getByText('Upload Audio Source')).toBeVisible();

  // Seed only a completed transcript through the existing project bridge so
  // this offline test can cover real review/reopen/export surfaces without credentials.
  const projectId = `e2e-media-${Date.now()}`;
  await saveSeedProject(page, makeReviewSession(mediaPath, 'e2e-silent.wav', projectId));
  await page.reload();
  await skipOnboarding(page);
  await page.getByRole('button', { name: 'Projects' }).click();
  const projectRow = page.getByRole('listitem').filter({ hasText: 'e2e-silent' }).first();
  await expect(projectRow).toBeVisible();
  await projectRow.getByRole('button', { name: /^e2e-silent 1\/1 chunks/ }).click();
  await projectRow.getByRole('button', { name: /Chunk 1/ }).click();

  await expect(page.getByText('Original Transcription')).toBeVisible();
  const original = page.getByText('A synthetic review sentence.', { exact: true });
  await original.selectText();
  await page.keyboard.press('Tab');
  const editor = page.getByRole('textbox');
  await expect(editor).toBeVisible();
  await editor.fill('Edited synthetic review sentence.');
  await page.getByRole('button', { name: 'Save Revision' }).click();
  await expect(page.getByText('Edited synthetic review sentence.', { exact: true })).toBeVisible();

  await page.getByRole('button', { name: /Complete & Export/ }).click();
  await expect(page.getByText('Document export')).toBeVisible();
  // Electron's packaged download surface does not emit Playwright's browser
  // Download event for blob URLs. Capture the real anchor artifact instead.
  await page.evaluate(() => {
    const state = window as Window & {
      __e2eDownload?: { filename: string; href: string } | null;
    };
    state.__e2eDownload = null;
    const originalClick = HTMLAnchorElement.prototype.click;
    HTMLAnchorElement.prototype.click = function () {
      if (this.download) {
        state.__e2eDownload = { filename: this.download, href: this.href };
      }
      return originalClick.call(this);
    };
    URL.revokeObjectURL = () => {};
  });
  await page.getByRole('button', { name: /Original TXT/ }).click();
  await page.waitForFunction(() => Boolean((window as Window & {
    __e2eDownload?: { filename: string; href: string } | null;
  }).__e2eDownload));
  const artifact = await page.evaluate(() => (window as Window & {
    __e2eDownload?: { filename: string; href: string } | null;
  }).__e2eDownload);
  expect(artifact?.filename).toMatch(/e2e[_-]silent.*\.txt$/i);
  expect(artifact?.href).toMatch(/^blob:/);
});
