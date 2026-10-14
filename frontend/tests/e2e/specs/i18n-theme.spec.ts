import { test, expect } from '@playwright/test';

test.describe('i18n and theme', () => {
  test.beforeEach(async ({ page }) => {
    // Clear locale preference before each test
    await page.goto('/');
    await page.evaluate(() => {
      localStorage.removeItem('structureclaw.locale');
      document.cookie = 'structureclaw.locale=;expires=Thu, 01 Jan 1970 00:00:00 GMT';
    });
  });

  test('switches language from EN to ZH', async ({ page }) => {
    await page.goto('/');
    await page.waitForLoadState('networkidle');

    await page.getByRole('button', { name: 'Switch language to Chinese', exact: true }).click();
    await expect(page.locator('html')).toHaveAttribute('lang', 'zh-CN');
    await expect(page.getByRole('button', { name: '发送', exact: true })).toBeVisible();
    await page.reload();
    await expect(page.locator('html')).toHaveAttribute('lang', 'zh-CN');
    await page.getByRole('button', { name: '切换语言为英文', exact: true }).click();
    await expect(page.locator('html')).toHaveAttribute('lang', 'en');
  });

  test('restores the saved locale into the rendered interface', async ({ page }) => {
    await page.goto('/');
    await page.waitForLoadState('networkidle');

    // Set locale via localStorage
    await page.evaluate(() => {
      localStorage.setItem('structureclaw.locale', 'zh');
    });

    await page.evaluate(() => { document.cookie = 'structureclaw.locale=;max-age=0;path=/'; });
    await page.reload();
    await expect(page.locator('html')).toHaveAttribute('lang', 'zh-CN');
    await expect(page.getByRole('button', { name: '发送', exact: true })).toBeVisible();
  });

  test('changes the theme and persists it after reload', async ({ page }) => {
    await page.goto('/');
    await page.waitForLoadState('networkidle');

    const before = await page.evaluate(() => localStorage.getItem('theme'));
    await page.getByRole('button', { name: /^Toggle theme/ }).click();
    await expect.poll(() => page.evaluate(() => localStorage.getItem('theme'))).not.toBe(before);
    const selected = await page.evaluate(() => localStorage.getItem('theme'));
    await page.reload();
    await expect.poll(() => page.evaluate(() => localStorage.getItem('theme'))).toBe(selected);
    await expect(page.locator('html')).toHaveClass(/(?:dark|light)/);
  });

  test('renders the console in English by default', async ({ page }) => {
    await page.goto('/');
    await page.waitForLoadState('networkidle');

    await expect(page.locator('html')).toHaveAttribute('lang', 'en');
    await expect(page.getByRole('button', { name: 'Send', exact: true })).toBeVisible();
  });

  test('html has lang attribute', async ({ page }) => {
    await page.goto('/');
    await page.waitForLoadState('networkidle');

    const htmlLang = await page.locator('html').getAttribute('lang');
    expect(htmlLang).toBeTruthy();
    expect(['en', 'zh-CN']).toContain(htmlLang);
  });
});
