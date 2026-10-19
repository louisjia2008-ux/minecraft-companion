import { defineConfig } from '@playwright/test';

export default defineConfig({
  testDir: './tests/e2e',
  outputDir: './test-results',
  reporter: [['list'], ['html', { outputFolder: 'playwright-report', open: 'never' }]],
  retries: process.env.CI ? 1 : 0,
  timeout: 45_000,
  workers: 1,
  use: { trace: 'retain-on-failure', screenshot: 'only-on-failure' },
});
