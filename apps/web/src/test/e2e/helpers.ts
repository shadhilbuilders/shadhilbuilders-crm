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

export const NAV = {
  timeout: 30_000,
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
  const email = page.locator('input#email, input[name="email"]');
  if ((await email.count()) === 0) return;
  await email.waitFor({ state: 'visible', timeout: 15_000 });
  const password = page.locator('[data-qa="login-password"]');
  const submit = page.getByRole('button', { name: /sign in/i });

  await page.waitForFunction(
    () => {
      const form = document.querySelector('form');
      if (!(form instanceof HTMLFormElement)) return false;
      return Object.keys(form).some((k) => k.startsWith('__react'));
    },
    { timeout: 15_000 },
  );

  for (let attempt = 0; attempt < 3; attempt += 1) {
    await email.fill(DEMO_EMAIL);
    await password.fill(DEMO_PASSWORD);
    await submit.click();
    try {
      await page.waitForURL((u) => !stillOnLogin(u), {
        timeout: 15_000,
        waitUntil: 'commit',
      });
      return;
    } catch {
      await page.waitForLoadState('domcontentloaded');
    }
  }
  throw new Error(`login did not leave /login (still at ${page.url()})`);
}

export async function gotoApp(page: Page, path: string): Promise<void> {
  await page.goto(path, NAV);
}
