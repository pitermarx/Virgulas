import { defineConfig, devices } from '@playwright/test';
import { execSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';

const env = ((globalThis as { process?: { env?: Record<string, string | undefined> } }).process?.env) ?? {};
const isCI = !!env.CI;
const baseURL = env.BASE_URL || 'http://127.0.0.1:3000';
const useExternalBaseUrl = !!env.BASE_URL;

const parseDotEnv = (raw: string): Record<string, string> => {
  const values: Record<string, string> = {};
  for (const line of raw.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    const eq = trimmed.indexOf('=');
    if (eq <= 0) continue;
    const key = trimmed.slice(0, eq).trim();
    const value = trimmed.slice(eq + 1).trim().replace(/^['"]|['"]$/g, '');
    values[key] = value;
  }
  return values;
};

const readSupabaseStatusEnv = (): Record<string, string> => {
  try {
    const output = execSync('npm exec supabase -- status -o env', {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore']
    });
    return parseDotEnv(output);
  } catch {
    return {};
  }
};

if (!useExternalBaseUrl) {
  const envPath = path.resolve(__dirname, '.env');
  const dotenv = existsSync(envPath) ? parseDotEnv(readFileSync(envPath, 'utf8')) : {};
  const statusEnv = readSupabaseStatusEnv();

  const url = dotenv.SUPABASE_URL || env.SUPABASE_URL || statusEnv.SUPABASE_URL || statusEnv.API_URL;
  const key = dotenv.SUPABASE_ANON_KEY || env.SUPABASE_ANON_KEY || statusEnv.SUPABASE_ANON_KEY || statusEnv.ANON_KEY;
  if (!url || !key) {
    throw new Error('Missing local Supabase credentials. Run `npm run db:start` first so .env (or supabase status) is available.');
  }
  env.PLAYWRIGHT_SUPABASE_CONFIG = JSON.stringify({ url, key });
}

export default defineConfig({
  testDir: './tests',
  fullyParallel: true,
  forbidOnly: isCI,
  retries: isCI ? 2 : 0,
  workers: 5,
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
    command: 'npm run serve',
    url: 'http://127.0.0.1:3000',
    reuseExistingServer: false,
    stdout: 'ignore',
    stderr: 'pipe',
  },
});
