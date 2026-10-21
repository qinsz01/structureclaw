import type { Page } from '@playwright/test';

/** Compatibility URL for the unified skill defaults section. */
export class CapabilitiesPage {
  constructor(readonly page: Page) {}
  async goto(): Promise<void> {
    await this.page.goto('/capabilities');
    await this.page.getByRole('dialog').waitFor({ state: 'visible' });
  }
}
