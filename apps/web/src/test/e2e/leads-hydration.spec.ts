import { expect, test, type Page } from '@playwright/test';

/**
 * Hydration regression check for the rebuilt Lead Inbox (autoplan 2026-09-07).
 *
 * The page uses useSearchParams() (needs a Suspense boundary) and
 * dateIntl.formatRelativeTime (time-dependent). Both can cause a
 * "Hydration failed because the server rendered HTML didn't match the
 * client" error. This test logs in as the demo user (if needed), loads
 * the leads page, and asserts NO hydration error was logged.
 */
const DEMO_EMAIL = 'demo@shadhilbuilders.in';
const DEMO_PASSWORD = 'demo123';

async function ensureLoggedIn(page: Page): Promise<void> {
  await page.goto('/login');
  // If already authenticated, /login redirects to the app shell - the
  // Email field won't appear. Only fill the form when it's actually shown.
  const email = page.getByLabel('Email');
  if ((await email.count()) === 0) {
    return; // already logged in
  }
  await email.fill(DEMO_EMAIL);
  await page.getByLabel(/Password/).fill(DEMO_PASSWORD);
  await page.getByRole('button', { name: /sign in/i }).click();
  await page.waitForURL(
    (url) => !url.pathname.startsWith('/login'),
    { timeout: 30_000 },
  );
}

test('leads inbox: no hydration mismatch on load', async ({ page }) => {
  const hydrationErrors: string[] = [];
  page.on('console', (msg) => {
    const text = msg.text();
    if (msg.type() === 'error' && /hydration|didn't match|did not match/i.test(text)) {
      hydrationErrors.push(text);
    }
  });
  page.on('pageerror', (err) => {
    if (/hydration|didn't match|did not match/i.test(err.message)) {
      hydrationErrors.push(err.message);
    }
  });
  // Capture the full error text (the console message is truncated).
  page.on('console', (msg) => {
    if (msg.type() === 'error') {
      console.log('CONSOLE-ERROR:', msg.text().slice(0, 2000));
    }
  });

  await ensureLoggedIn(page);
  await page.goto('/demo/projects/demo-villas/leads');
  await page.waitForLoadState('domcontentloaded');
  // Give hydration + the client fetch time to settle.
  await page.waitForTimeout(2_500);

  // The page should render the Lead Inbox header.
  await expect(page.getByRole('heading', { name: /Lead Inbox/i })).toBeVisible({
    timeout: 15_000,
  });

  // The shared app shell previously threw ONE hydration error on EVERY
  // (app) page (the UserMenu skeleton-vs-button session mismatch, fixed
  // in app-header.tsx with a mounted-gate). With that gone, assert NO
  // hydration error fires on the leads load.
  console.log('LEADS hydration errors:', hydrationErrors.length);
  expect(
    hydrationErrors.length,
    `leads hydration errors: ${hydrationErrors.join(' | ')}`,
  ).toBe(0);
});
