import { defineConfig, devices } from '@playwright/test';

const env = ((globalThis as { process?: { env?: Record<string, string | undefined> } }).process?.env) ?? {};
const isCI = !!env.CI;
const baseURL = env.BASE_URL || 'http://127.0.0.1:3000';
const useExternalBaseUrl = !!env.BASE_URL;

export default defineConfig({
  testDir: './tests',
  fullyParallel: true,
  forbidOnly: isCI,
  retries: isCI ? 2 : 0,
  workers: isCI ? 1 : undefined,
  reporter: [
    ['html', { open: 'never' }],
  ],
  use: {
    baseURL,
    trace: 'on-first-retry',
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
  ].filter(p => isCI || p.name === 'chromium'),
  webServer: useExternalBaseUrl ? undefined : {
    command: 'npm run local',
    url: 'http://127.0.0.1:3000',
    reuseExistingServer: false,
    stdout: 'ignore',
    stderr: 'pipe',
  },
});
