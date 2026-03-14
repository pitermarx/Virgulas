import { defineConfig, devices } from '@playwright/test';

const baseURL = process.env.BASE_URL || 'http://localhost:3000';

export default defineConfig({
  testDir: './specs',
  globalSetup: './global-setup.mjs',
  globalTeardown: './global-teardown.mjs',
  timeout: 120000, // 120 s per test — allows 600 000-iteration PBKDF2 key derivation even under CI load
  fullyParallel: true,
  workers: process.env.CI ? 4 : 6,
  forbidOnly: !!process.env.CI,
  retries: 0,
  outputDir: '../test-results/artifacts',
  reporter: process.env.CI
    ? [
      ['list'],
      ['json', { outputFile: '../test-results/results.json' }],
      ['html', { outputFolder: '../playwright-report', open: 'never' }],
      ['github'],
    ]
    : [['list'], ['html', { open: 'on-failure' }]],
  use: {
    baseURL,
    trace: 'on-first-retry',
    screenshot: 'only-on-failure',
    video: 'on-first-retry',
  },
  projects: [
    {
      name: 'chromium',
      use: { ...devices['Desktop Chrome'] },
    },
    {
      name: 'firefox',
      use: { ...devices['Desktop Firefox'] },
    },
  ],
  ...(!process.env.BASE_URL && {
    webServer: {
      command: 'npx serve -l 3000 ../source',
      url: 'http://localhost:3000',
      reuseExistingServer: !process.env.CI,
      timeout: 15000,
    },
  }),
});
