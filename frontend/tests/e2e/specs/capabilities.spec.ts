import { test, expect } from '@playwright/test';

test.describe('Unified skill defaults', () => {
  test('legacy capability URL opens the skills section of the single settings dialog', async ({ page }) => {
    await page.goto('/capabilities');
    const dialog = page.getByRole('dialog', { name: 'Workspace Settings' });
    await expect(dialog).toBeVisible();
    await expect(dialog.getByRole('tab', { name: 'Skills', exact: true })).toHaveAttribute('aria-selected', 'true');
    await expect(page).toHaveURL(/\/$/);
    await expect(dialog.getByLabel('Structure skills')).toBeVisible();
  });

  test('restricts only structure skills and restores saved defaults after reload', async ({ page, request }) => {
    const original = await (await request.get('/api/v1/admin/settings')).json();
    try {
      await page.goto('/capabilities');
      const dialog = page.getByRole('dialog');
      await dialog.getByLabel('Structure skills').selectOption('restricted');
      const { skills } = await (await request.get('/api/v1/agent/skills')).json();
      expect(skills).toHaveLength(8);
      for (const skill of skills) await expect(dialog.getByRole('checkbox', { name: skill.name.en, exact: true })).toBeVisible();
      const beamName = skills.find((s: { id: string }) => s.id === 'beam').name.en;
      await dialog.getByRole('checkbox', { name: beamName, exact: true }).uncheck();
      await dialog.getByRole('button', { name: 'Save', exact: true }).click();
      await expect(dialog.getByRole('status')).toHaveText('Global defaults saved.');
      await page.reload();
      await page.goto('/capabilities');
      await expect(dialog.getByRole('checkbox', { name: beamName, exact: true })).not.toBeChecked();
      expect(await page.evaluate(() => localStorage.getItem('structureclaw.console.capabilities'))).toBeNull();
    } finally {
      await request.put('/api/v1/admin/settings', { data: { agent: { runPolicy: original.agent.runPolicy.value } } });
    }
  });
});
