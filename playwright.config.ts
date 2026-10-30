import { defineConfig, devices } from '@playwright/test';
import { execSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';

const env = ((globalThis as { process?: { env?: Record<string, string | undefined> } }).process?.env) ?? {};
const isCI = !!env.CI;
const baseURL = env.BASE_URL || 'http://127.0.0.1:3000';
const useExternalBaseUrl = !!env.BASE_URL;

// Integration specs mock the backend through the `window.supabase` seam and
// read app internals through the `e2e` binding — both compiled out of
// production builds. They live in `tests/integration/` and only run against
// the locally built test bundle; the daily production run excludes the whole
// directory. `tests/e2e/` holds the behavior-driven specs that run everywhere.
const INTEGRATION_DIR = '**/integration/**';

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

// NOTE: the subcommand must not be separated from `supabase` by `--`. The CLI
// parses `supabase -- status` as a bare help request and prints usage to stdout
// with exit code 0, so a string-matching guard can't catch it — it just yields
// no credentials. Keep this as `supabase status`.
const readSupabaseStatusEnv = (): Record<string, string> => {
  const attempts = ['supabase status -o env', 'supabase -- status -o env'];
  for (const command of attempts) {
    try {
      const output = execSync(`bunx ${command}`, {
        encoding: 'utf8',
        stdio: ['ignore', 'pipe', 'ignore']
      });
      const values = parseDotEnv(output);
      if (values.SUPABASE_URL || values.API_URL) return values;
    } catch {
      // Try the next form; the CLI can be unavailable in this environment.
    }
  }
  return {};
};

if (!useExternalBaseUrl) {
  const envPath = path.resolve(import.meta.dirname, '.env');
  const dotenv = existsSync(envPath) ? parseDotEnv(readFileSync(envPath, 'utf8')) : {};
  const statusEnv = readSupabaseStatusEnv();

  const url = dotenv.SUPABASE_URL || env.SUPABASE_URL || statusEnv.SUPABASE_URL || statusEnv.API_URL;
  const key = dotenv.SUPABASE_ANON_KEY || env.SUPABASE_ANON_KEY || statusEnv.SUPABASE_ANON_KEY || statusEnv.ANON_KEY;
  if (!url || !key) {
    throw new Error(
      'Missing local Supabase credentials for Playwright. Run "bun run db:start" and ensure ".env" exists or "bunx supabase status -o env" returns SUPABASE_URL and SUPABASE_ANON_KEY.'
    );
  }

  env.PLAYWRIGHT_SUPABASE_CONFIG = JSON.stringify({ url, key });
}

export default defineConfig({
  testDir: './tests',
  testMatch: '**/*.spec.ts',
  testIgnore: useExternalBaseUrl ? INTEGRATION_DIR : undefined,
  fullyParallel: true,
  forbidOnly: isCI,
  retries: isCI ? 2 : 0,
  // WebKit can spend several seconds in PBKDF2/WebCrypto while all three
  // browser projects run concurrently on the CI runner, so CI needs a long
  // window. Local runs are also generous: app boot + PBKDF2 unlock can exceed
  // 5s on a loaded developer machine, which produced unlock/readiness flakes
  // that were environmental rather than real failures.
  expect: {
    timeout: isCI ? 15_000 : 10_000,
  },
  timeout: 60_000,
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
    {
      name: 'webkit',
      use: { ...devices['Desktop Safari'] },
    }
  ].filter(p => isCI || p.name === 'chromium'),
  webServer: useExternalBaseUrl ? undefined : {
    command: env.SERVE_CMD || 'bun run dev:test',
    url: 'http://127.0.0.1:3000',
    reuseExistingServer: false,
    stdout: 'ignore',
    stderr: 'pipe',
  },
});
