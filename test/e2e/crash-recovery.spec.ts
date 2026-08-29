import {
  closeElectron,
  expect,
  firstWindow,
  launchForProfile,
  makeReviewSession,
  saveSeedProject,
  skipOnboarding,
  test,
  waitForApp,
  writeSilentWav,
} from './fixtures';

test('abrupt main-process exit leaves the last project checkpoint recoverable', async ({ electronApp, page, profile }) => {
  await waitForApp(page);
  await skipOnboarding(page);

  const mediaPath = await writeSilentWav(profile, 'e2e-crash.wav');
  const projectId = `e2e-crash-${Date.now()}`;
  await saveSeedProject(page, makeReviewSession(mediaPath, 'e2e-crash.wav', projectId));
  await page.reload();
  await skipOnboarding(page);
  await page.getByRole('button', { name: 'Projects' }).click();
  const projectRow = page.getByRole('listitem').filter({ hasText: 'e2e-crash' }).first();
  await expect(projectRow).toBeVisible();
  await projectRow.getByRole('button', { name: /^e2e-crash 1\/1 chunks/ }).click();
  await projectRow.getByRole('button', { name: /Chunk 1/ }).click();
  await expect(page.getByText('Original Transcription')).toBeVisible();
  await expect(page.getByText('A synthetic review sentence.', { exact: true })).toBeVisible();

  // Begin an autosave-producing edit and terminate Electron before its 900 ms
  // debounce can replace the committed checkpoint.
  const original = page.getByText('A synthetic review sentence.', { exact: true });
  await original.selectText();
  await page.keyboard.press('Tab');
  const editor = page.getByRole('textbox');
  await expect(editor).toBeVisible();
  await editor.fill('Revision interrupted by crash.');
  electronApp.process().kill('SIGKILL');

  const recoveredApp = await launchForProfile(profile);
  try {
    const recoveredPage = await firstWindow(recoveredApp);
    await skipOnboarding(recoveredPage);
    await recoveredPage.getByRole('button', { name: 'Projects' }).click();
    const recoveredRow = recoveredPage.getByRole('listitem').filter({ hasText: 'e2e-crash' }).first();
    await expect(recoveredRow).toBeVisible();
    await recoveredRow.getByRole('button', { name: /^e2e-crash 1\/1 chunks/ }).click();
    await recoveredRow.getByRole('button', { name: /Chunk 1/ }).click();

    await expect(recoveredPage.getByText('Original Transcription')).toBeVisible();
    // The committed checkpoint is intact; the interrupted revision is not
    // presented as if it had been durably saved.
    await expect(recoveredPage.getByText('A synthetic review sentence.', { exact: true })).toBeVisible();
    await expect(recoveredPage.getByText('Revision interrupted by crash.', { exact: true })).toHaveCount(0);
  } finally {
    await closeElectron(recoveredApp);
  }
});
