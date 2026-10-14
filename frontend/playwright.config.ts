import { defineConfig, devices } from '@playwright/test';

const port = Number(process.env.SCLAW_E2E_PORT ?? 31515);
if (!Number.isInteger(port) || port < 1024 || port > 65535 || [31415, 31416].includes(port)) {
  throw new Error('E2E requires a dedicated port (default 31515); production ports are forbidden.');
}
const baseURL = `http://127.0.0.1:${port}`;

export default defineConfig({
  testDir: './tests/e2e/specs',
  // A live-provider run must never execute fixtures that replace its LLM settings.
  ...(process.env.SCLAW_E2E_LIVE === '1' ? { testMatch: '**/structural-analysis.spec.ts' } : {}),
  timeout: 60_000,
  expect: { timeout: 15_000 },
  fullyParallel: false,
  retries: process.env.CI ? 2 : 0,
  workers: 1,
  globalSetup: './tests/e2e/verify-isolation.ts',
  reporter: [['list'], ['html', { open: 'never' }]],
  use: {
    baseURL,
    locale: 'en',
    timezoneId: 'UTC',
    trace: 'retain-on-failure',
    screenshot: 'only-on-failure',
    video: 'retain-on-failure',
  },
  projects: [
    {
      name: 'chromium',
      use: { ...devices['Desktop Chrome'] },
    },
  ],
  webServer: process.env.SCLAW_E2E_ATTACH === '1' ? undefined : {
    command: 'node tests/e2e/start-server.mjs',
    url: `${baseURL}/health`,
    reuseExistingServer: false,
    timeout: 120_000,
    env: {
      SCLAW_E2E_PORT: String(port),
    },
  },
});
