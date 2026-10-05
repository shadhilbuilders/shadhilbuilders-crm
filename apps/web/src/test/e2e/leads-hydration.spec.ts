import { expect, test } from '@playwright/test';

/**
 * Hydration regression check for the rebuilt Lead Inbox (autoplan 2026-09-07).
 *
 * The page uses useSearchParams() (needs a Suspense boundary) and
 * dateIntl.formatRelativeTime (time-dependent). Both can cause a
 * "Hydration failed because the server rendered HTML didn't match the
 * client" error. This test logs in as the demo user (if needed), loads
 * the leads page, and asserts NO hydration error was logged.
 */
import { gotoApp, login } from './helpers';

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

  await login(page);
  await gotoApp(page, '/demo/projects/demo-villas/leads');
  // Give hydration + the client fetch time to settle.
  await page.waitForTimeout(2_500);

  // The page should render the Lead Inbox header.
  await expect(page.getByRole('heading', { name: /Lead Inbox/i })).toBeVisible({
    timeout: 30_000,
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
