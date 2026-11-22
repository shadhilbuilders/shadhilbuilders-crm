import type { Page } from '@playwright/test';

/**
 * Shared e2e navigation. Never wait for `load` or `networkidle` on
 * authenticated pages: they keep an SSE stream (`/api/sse/notifications`)
 * open, so those events never fire and Playwright reports a timeout that
 * looks like a product bug. `domcontentloaded` is enough for the DOM
 * under test.
 */
export const DEMO_EMAIL = 'demo@shadhilbuilders.in';
export const DEMO_PASSWORD = 'demo123';

/**
 * The seeded site engineer (bootstrap org, `shadhil-builders`).
 *
 * Same convention as DEMO_EMAIL: the repo seeds a known placeholder password
 * (`FALLBACK_PASSWORD.ENGINEER` in packages/database/src/seed.ts), and
 * ENGINEER is NOT held behind the forced-rotation gate (only OWNER/CUSTOMER
 * are), so this account signs straight in.
 *
 * Used by `inventory-role-gate.spec.ts` to prove the villa-money projection in
 * a real browser. If SEED_ENGINEER_PASSWORD is overridden in an environment,
 * the spec's sign-in fails loudly rather than silently testing the wrong role.
 */
export const ENGINEER_EMAIL = 'engineer@shadhilbuilders.in';
export const ENGINEER_PASSWORD = 'engineer_placeholder_pw';

/**
 * Shared navigation options for `page.goto` and `waitForURL`.
 *
 * `waitUntil: 'domcontentloaded'` is the load-bearing part: authenticated pages
 * hold an SSE stream open, so the browser's `load` event may never fire and a
 * default wait dies on a navigation that actually worked.
 *
 * `timeout` is deliberately ABOVE Playwright's 30s default, matching
 * `navigationTimeout` in playwright.config.ts. It used to be 30s, which was
 * actively harmful on `next dev`: a route compiles on first hit, and this repo's
 * own config comment says that "routinely exceeds Playwright's 30s default".
 * So the helper was TIGHTENING the ceiling the config had already relaxed, and
 * specs timed out on cold routes while the navigation was still succeeding -
 * `dashboard-mobile-audit` and the inventory role specs both failed that way
 * (2026-11-08), and it looked like a product bug each time.
 */
export const NAV = {
  timeout: 45_000,
  waitUntil: 'domcontentloaded' as const,
};

function stillOnLogin(url: URL): boolean {
  return url.pathname === '/login' || url.pathname.startsWith('/login/');
}

export async function login(page: Page): Promise<void> {
  // Always navigate: specs rely on login() leaving the page on the app origin
  // (relative fetch() in page.evaluate fails on about:blank). With a session
  // from auth.setup the proxy redirects off /login below, so no sign-in call.
  await page.goto('/login', NAV);
  // Session cookie from auth.setup already signed us in: proxy redirects
  // off /login and we are done. Avoid another sign-in hit (better-auth
  // rate-limits a full suite that logs in per spec).
  if (!stillOnLogin(new URL(page.url()))) return;
  await signInOnLoginForm(page, DEMO_EMAIL, DEMO_PASSWORD);
}

/**
 * Sign in as a SPECIFIC account, discarding any existing session first.
 *
 * `login()` is hardwired to the demo OWNER because that is what the shared
 * storageState holds. A spec that needs a different ROLE (the engineer, to
 * exercise what a site-only account may and may not see) must sign in as that
 * user in its own context - there is one session per browser context, and the
 * suite runs with `workers: 1`, so no other spec is disturbed.
 *
 * CLEARS THE COOKIES FIRST, and that is load-bearing: the `page` fixture starts
 * with the demo OWNER's session already in it, so `/login` redirects away and a
 * naive "already signed in" fast path would return having changed nothing - the
 * spec would then assert role behaviour against the WRONG user and pass for the
 * wrong reason. `loginAs` means "be this user", so any previous session goes.
 */
export async function loginAs(page: Page, email: string, password: string): Promise<void> {
  await page.context().clearCookies();
  await page.goto('/login', NAV);
  await signInOnLoginForm(page, email, password);
}

/**
 * Fill and submit the login form, assuming the page is ALREADY on /login with
 * no session. Shared by `login` (which reuses an existing session when it can)
 * and `loginAs` (which always starts clean).
 *
 * TWO RACES ARE HANDLED HERE, both observed in this repo:
 *
 *  1. HYDRATION. `domcontentloaded` can fire before the login form is in the
 *     DOM on a production build; `count() === 0` used to be read as "already
 *     signed in", so login() returned WITHOUT signing in and auth.setup saved an
 *     empty storageState - then every spec started anonymous.
 *
 *  2. A SUCCESSFUL SIGN-IN THAT LOOKS LIKE A TIMEOUT. Submitting runs
 *     `window.location.assign(next)` (a full document navigation, see the
 *     rationale in LoginForm.tsx). Navigating to `/` on a cold dev server
 *     compiles the route, so the URL confirmation can exceed its window while
 *     the sign-in has in fact SUCCEEDED. The naive retry loop then re-filled the
 *     form on a page that was already navigating away: `fill` hung waiting for
 *     that navigation, blew the test's whole budget, and reported a sign-in
 *     failure that never happened. So every step re-checks whether we have
 *     already left /login before deciding anything went wrong.
 */
async function signInOnLoginForm(page: Page, email: string, password: string): Promise<void> {
  // The field accepts an email OR a phone number since 2026-11-21, so it is
  // named `identifier`. `input[name="email"]` no longer exists.
  const emailInput = page.locator('input#identifier, input[name="identifier"]');
  const passwordInput = page.locator('[data-qa="login-password"]');
  const submit = page.getByRole('button', { name: /sign in/i });

  for (let attempt = 0; attempt < 3; attempt += 1) {
    // A previous attempt may have won the navigation race already.
    if (!stillOnLogin(new URL(page.url()))) return;

    try {
      // WAIT for the form; never `count()` it (see race 1 above).
      await emailInput.waitFor({ state: 'visible', timeout: 30_000 });
      await page.waitForFunction(
        () => {
          const form = document.querySelector('form');
          if (!(form instanceof HTMLFormElement)) return false;
          return Object.keys(form).some((k) => k.startsWith('__react'));
        },
        { timeout: 15_000 },
      );
      await emailInput.fill(email);
      await passwordInput.fill(password);
      await submit.click();
    } catch (err) {
      // Race 2: the page may have navigated out from under the form. Leaving
      // /login IS the success condition, so check that before rethrowing.
      if (!stillOnLogin(new URL(page.url()))) return;
      if (attempt === 2) throw err;
      continue;
    }

    try {
      // `waitUntil: 'commit'` - the app shell holds an SSE stream open, so
      // waiting for `load` (the default) can never resolve.
      await page.waitForURL((u) => !stillOnLogin(u), {
        timeout: 45_000,
        waitUntil: 'commit',
      });
      return;
    } catch {
      // The navigation may still be in flight and about to land.
      if (!stillOnLogin(new URL(page.url()))) return;
    }
  }
  throw new Error(`login did not leave /login as ${email} (still at ${page.url()})`);
}

export async function gotoApp(page: Page, path: string): Promise<void> {
  await page.goto(path, NAV);
}
