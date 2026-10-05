import { defineConfig, devices } from '@playwright/test';

/**
 * Playwright E2E test configuration.
 * Tests live in src/test/e2e/ and run against localhost:3000.
 */
export default defineConfig({
  testDir: './src/test/e2e',

  fullyParallel: false,

  // Login + first paint of an authenticated page routinely exceeds Playwright's
  // 30s default when Next is compiling a route. SSE-backed pages never reach
  // `load`/`networkidle`; specs wait on DOM instead, but they still need this
  // ceiling for the round-trip.
  timeout: 60_000,

  // Fail the build on CI if you accidentally left test.only in the source
  forbidOnly: !!process.env.CI,

  // Retry on CI only
  retries: process.env.CI ? 2 : 0,

  // One worker always. Three parallel logins against `next dev` stampede
  // compilation and race form hydration (native GET to /login?email=...).
  // CI already used 1; local default (one worker per core) was the flake.
  workers: 1,

  reporter: [['html', { open: 'never' }]],

  use: {
    baseURL: 'http://localhost:3000',
    trace: 'on-first-retry',
    screenshot: 'only-on-failure',
    navigationTimeout: 45_000,

    // Pre-dismiss the web-push prompt, so it never covers the page under test.
    //
    // PushEnablePrompt (`components/push-enable-prompt.tsx`) opens an
    // AlertDialog as soon as push capability resolves - and capability requires a
    // SERVICE WORKER, which Serwist only registers in a production build. So on
    // CI (a production `next start`) every authenticated page is covered by a
    // `fixed inset-0 z-50` overlay that also marks the rest of the page
    // (`data-base-ui-inert`). Nothing underneath is clickable: Playwright reports
    // "element is visible, enabled and stable" and then aborts with
    // "<div ... data-qa=\"alert-dialog-overlay\" ...> subtree intercepts pointer
    // events" - which reads like a flaky/never-stable button and is not. It cost
    // the whole bookings-approval-audit suite (3 tests) on 2026-10-01. `next dev`
    // has no service worker, so the same specs passed locally - the trap behind
    // "works on my machine".
    //
    // Seeding the dismissal is what a returning user has already done, and it is
    // the component's own documented latch (localStorage, not session): the gate
    // is `safeGetItem('shadhil:push-prompt-dismissed') !== PROMPT_VERSION`, so the
    // value must be the PROMPT_VERSION the component ships ('v1'), not a bare
    // '1' - a mismatched value re-opens the dialog and looks like the fix failed.
    // Bump both together if that constant is ever bumped.
    //
    // Emulating the state beats clicking "Not now" in a helper: it applies to
    // every page of every spec, including the ones that never reach a settled
    // DOM. No spec covers the prompt itself, so no coverage is lost - if one ever
    // does, it must opt out with its own context.
    storageState: 'src/test/e2e/.auth/demo.json',
  },

  projects: [
    {
      name: 'setup',
      testMatch: /auth\.setup\.ts/,
      use: {
        storageState: {
          cookies: [],
          origins: [
            {
              origin: 'http://localhost:3000',
              localStorage: [{ name: 'shadhil:push-prompt-dismissed', value: 'v1' }],
            },
          ],
        },
      },
    },
    {
      name: 'chromium',
      dependencies: ['setup'],
      testIgnore: /auth\.setup\.ts/,
      use: { ...devices['Desktop Chrome'] },
    },
    {
      name: 'firefox',
      dependencies: ['setup'],
      testIgnore: /auth\.setup\.ts/,
      use: { ...devices['Desktop Firefox'] },
    },
    {
      name: 'mobile-chrome',
      dependencies: ['setup'],
      testIgnore: /auth\.setup\.ts/,
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
    command: 'E2E_DISABLE_RATE_LIMIT=true pnpm dev',
    url: 'http://localhost:3000',
    reuseExistingServer: true,
    timeout: 120_000,
  },
});
