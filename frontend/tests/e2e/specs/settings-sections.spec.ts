import { test, expect } from '@playwright/test';
import fs from 'node:fs';
import path from 'node:path';

const labels = {
  en: ['Model', 'Engines & codes', 'Skills', 'Run policy defaults', 'Appearance', 'Data'],
  zh: ['模型', '引擎与规范', '技能', '运行策略默认值', '外观', '数据'],
};

for (const locale of ['en', 'zh'] as const) for (const theme of ['light', 'dark'] as const) {
  test(`all settings sections: ${locale}, ${theme}`, async ({ page }, info) => {
    await page.setViewportSize({ width: 1440, height: 1000 });
    await page.goto('/');
    await page.getByRole('button', { name: 'Open settings', exact: true }).click();
    const dialog = page.getByRole('dialog');
    await dialog.getByRole('tab', { name: 'Appearance', exact: true }).click();
    await dialog.getByLabel('Theme', { exact: true }).selectOption(theme);
    await dialog.getByLabel('Language', { exact: true }).selectOption(locale);
    await expect(page.locator('html')).toHaveClass(new RegExp(theme));
    await expect(dialog.getByRole('tab')).toHaveCount(6);
    for (const [index, label] of labels[locale].entries()) {
      // The tab row lives in the scrollable dialog body; return to it before each section.
      const body = dialog.locator(':scope > div').last();
      await body.evaluate(element => { element.scrollTop = 0; });
      await dialog.getByRole('tab', { name: label, exact: true }).click();
      await page.waitForLoadState('networkidle');
      if (index === 1) await expect(dialog.getByText(locale === 'en' ? 'OpenSees Static Analysis' : 'OpenSees 静力分析', { exact: true })).toBeVisible();
      if (index === 2) await expect(dialog.getByLabel(locale === 'en' ? 'Structure skills' : '结构技能')).toBeEnabled();
      const name = `${locale}-${theme}-${index}`;
      const screenshot = async (suffix: string) => {
        const directory = process.env.SCLAW_SETTINGS_SCREENSHOT_OUT;
        if (directory) fs.mkdirSync(directory, { recursive: true });
        const body = await dialog.screenshot(directory ? { path: path.join(directory, `${suffix}.png`) } : {});
        await info.attach(suffix, { body, contentType: 'image/png' });
      };
      await screenshot(name);
      const overflow = await body.evaluate(element => element.scrollHeight > element.clientHeight + 5);
      if (overflow) {
        await body.evaluate(element => { element.scrollTop = element.scrollHeight; });
        await screenshot(`${name}-bottom`);
      }
    }
  });
}
