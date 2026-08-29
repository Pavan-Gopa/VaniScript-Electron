import { expect, skipOnboarding, test, waitForApp, writeDocumentFixture } from './fixtures';

test('document project uses the available text-upload surface and reports offline translation gating', async ({ page, profile }) => {
  await waitForApp(page);
  await skipOnboarding(page);

  const document = await writeDocumentFixture(profile, 'txt');
  await page.locator('input[type="file"]').setInputFiles(document.path);
  await expect(page.getByText('Engine Configuration')).toBeVisible();

  // The Electron edition currently exposes document ingestion through the
  // shared upload/config surface. Its document engine is main-side only, so
  // this qualification lane records the real UI boundary rather than inventing
  // an editor route. Translation remains provider-independent and offline.
  const comboboxes = page.getByRole('combobox');
  await comboboxes.nth(0).selectOption('Spanish');
  await expect(comboboxes.nth(2).locator('option:checked')).toHaveText('No translation models available');
  await expect(page.getByRole('button', { name: 'Initialize Engine' })).toBeDisabled();
  await page.getByRole('button', { name: 'Cancel' }).click();
  await expect(page.getByText('Upload Audio Source')).toBeVisible();
});
