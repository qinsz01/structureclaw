import { test, expect } from '@playwright/test';
import { CapabilitiesPage } from '../pages/capabilities.page';

test.describe('Capabilities settings page', () => {
  let capsPage: CapabilitiesPage;

  test.beforeEach(async ({ page }) => {
    capsPage = new CapabilitiesPage(page);
  });

  test('loads capability settings page', async ({ page }) => {
    await capsPage.goto();
    await expect(page).toHaveURL(/\/capabilities/);
  });

  test('displays skill domains from real backend', async ({ request }) => {
    await capsPage.goto();
    const response = await request.get('/api/v1/agent/skills');
    expect(response.ok()).toBeTruthy();
    const { skills } = await response.json();
    const beam = skills.find((skill: { id: string }) => skill.id === 'beam');
    expect(beam).toBeTruthy();
    await expect(capsPage.page.getByRole('button', { name: beam.name.en, exact: true })).toBeVisible();
    await expect(capsPage.page.getByText('Structure-Type Skills', { exact: false }).last()).toBeVisible();
  });

  test('skill selection changes and survives reload', async ({ page, request }) => {
    await capsPage.goto();
    const { skills } = await (await request.get('/api/v1/agent/skills')).json();
    const beam = skills.find((skill: { id: string }) => skill.id === 'beam');
    const selected = () => page.evaluate(() => JSON.parse(localStorage.getItem('structureclaw.console.capabilities') ?? '{}').skillIds ?? []);
    const wasSelected = (await selected()).includes('beam');
    await page.getByRole('button', { name: beam.name.en, exact: true }).click();
    await expect.poll(async () => (await selected()).includes('beam')).toBe(!wasSelected);
    await page.reload();
    await expect.poll(async () => (await selected()).includes('beam')).toBe(!wasSelected);
  });

  test('reset buttons are visible', async ({ page }) => {
    await capsPage.goto();
    await expect(capsPage.resetSkillsButton).toBeVisible();
    await expect(capsPage.resetToolsButton).toBeVisible();
  });
});
