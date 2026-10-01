import { defineConfig, devices } from '@playwright/test';

/**
 * Playwright E2E test configuration.
 * Tests live in src/test/e2e/ and run against localhost:3000.
 */
export default defineConfig({
  testDir: './src/test/e2e',

  fullyParallel: true,

  // Fail the build on CI if you accidentally left test.only in the source
  forbidOnly: !!process.env.CI,

  // Retry on CI only
  retries: process.env.CI ? 2 : 0,

  // Opt out of parallel tests on CI
  workers: process.env.CI ? 1 : undefined,

  reporter: [['html', { open: 'never' }]],

  use: {
    baseURL: 'http://localhost:3000',
    trace: 'on-first-retry',
    screenshot: 'only-on-failure',
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
      name: 'mobile-chrome',
      use: { ...devices['Pixel 5'] },
    },
  ],

  // The server under test is NOT started here on CI - the workflow starts it
  // (a production `next start`) and polls /login until it is ready before
  // invoking Playwright. Playwright must therefore REUSE it: with the previous
  // `reuseExistingServer: !process.env.CI`, CI insisted on launching its own
  // `pnpm dev` on a port the workflow already owned and aborted immediately with
  // "http://localhost:3000 is already used, make sure that nothing is running on
  // the port/url or set reuseExistingServer:true in config.webServer" - so the
  // e2e job never ran a single spec. Reusing is also the right local behaviour:
  // attach to a dev server you already have, and start one only when the port is
  // free. Safe on CI even if the server were missing, because the workflow's
  // start step fails hard on its own readiness probe.
  webServer: {
    command: 'pnpm dev',
    url: 'http://localhost:3000',
    reuseExistingServer: true,
    timeout: 120_000,
  },
});
