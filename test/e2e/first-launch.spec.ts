import { test, expect, waitForApp } from './fixtures';

test('first launch presents onboarding and skip returns to the upload workspace', async ({ page }) => {
  await page.waitForLoadState('domcontentloaded');

  await expect(page.getByRole('heading', { name: 'Connect an MCP agent', level: 4 })).toBeVisible();
  await expect(page.getByText('Open Settings > Agents.')).toBeVisible();

  // Seed the documented Apple-Silicon-era keys, then reload so the real
  // renderer-to-main migration hook runs against this isolated profile.
  await page.evaluate(() => {
    localStorage.setItem('vs_settings_v1', JSON.stringify({ defaultTargetLang: 'Spanish' }));
    localStorage.setItem('vs_usage_v1', JSON.stringify({}));
  });
  await page.reload();
  await page.waitForLoadState('domcontentloaded');
  await expect.poll(() => page.evaluate(() => localStorage.getItem('vs_usage_v1'))).toBeNull();
  await expect.poll(() => page.evaluate(() => {
    const raw = localStorage.getItem('vs_settings_v1');
    return raw ? JSON.parse(raw).defaultTargetLang : undefined;
  })).toBe('Spanish');
  await waitForApp(page);
  await page.getByRole('button', { name: 'Skip Walkthrough' }).click();
  await waitForApp(page);
  await expect(page.getByText('Upload Audio Source')).toBeVisible();
  await expect(page.getByRole('button', { name: 'Skip Walkthrough' })).toHaveCount(0);
});
