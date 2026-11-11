import { expect, test as setup } from '@playwright/test';

import { ENGINEER_EMAIL, ENGINEER_PASSWORD, login, loginAs } from './helpers';

/**
 * Save one session per role for the specs to reuse.
 *
 * WHY TWO SESSIONS. Almost every spec runs as the demo OWNER, so that session is
 * the shared default (`demo.json`). `inventory-role-gate.spec.ts` needs the
 * ENGINEER instead, and signing in per test was a mistake: `workers: 1` runs the
 * suite back-to-back against a single `next dev`, and each sign-in is a full
 * `/login` document load on a server that may be mid-compile. Five of them
 * inside one spec, after a heavy mobile-audit spec, produced `page.goto`
 * timeouts on `/login` itself - the sign-in was the flakiest thing in a file
 * about money redaction. Signing in ONCE here against a fresh context costs two
 * navigations per run and removes the whole class.
 *
 * SELF-HEALING (2026-11-08). A saved state file is a CACHE of a server-side
 * session, and it can outlive the thing it caches - a re-seeded database, a
 * cleared `Session` table, an expired token. The saved cookie then names a
 * session the server no longer honours, so `/login` does NOT redirect (it has no
 * way to know the cookie is dead until a request is made), `login()` waits for a
 * form that is already on screen but never submits, and setup dies on a timeout
 * that looks like a broken app. It bit this repo twice in one session, and each
 * time the "fix" was to remember to delete the file by hand.
 *
 * So: every run starts from a CLEAN slate and VERIFIES the session server-side
 * before saving it. A dead cache can no longer be inherited, and a login that
 * did not take fails here - next to the cause - instead of in 20 dependent
 * specs.
 */

/** Save the current context's storage state after proving it resolves. */
async function saveVerifiedSession(
  context: import('@playwright/test').BrowserContext,
  page: import('@playwright/test').Page,
  path: string,
): Promise<void> {
  // A "passing" setup that saved no session poisons every spec that depends on
  // it, so assert the cookie is there...
  const cookies = await context.cookies();
  expect(
    cookies.some((c) => c.name.endsWith('better-auth.session_token')),
    `${path}: finished without a better-auth session cookie`,
  ).toBe(true);

  // ...and that the SERVER honours it. `get-session` resolves the cookie against
  // the Session table and answers `null` when it does not, which a presence
  // check alone cannot see.
  const probe = await page.request.get('/api/auth/get-session').catch(() => null);
  expect(probe, `${path}: could not reach /api/auth/get-session`).not.toBeNull();
  expect(probe?.ok(), `${path}: get-session answered ${probe?.status()}`).toBe(true);
  const body = (await probe?.json().catch(() => null)) as {
    session?: { userId?: string };
    user?: { role?: string };
  } | null;
  expect(
    body?.session?.userId,
    `${path}: the session does not resolve server-side - the login did not take`,
  ).toBeTruthy();

  await context.storageState({ path });
  return;
}

setup('authenticate as demo user', async ({ page, context }) => {
  await context.clearCookies();
  await login(page);
  await saveVerifiedSession(context, page, 'src/test/e2e/.auth/demo.json');
});

setup('authenticate as site engineer', async ({ page, context }) => {
  // `loginAs` clears cookies itself; this context is fresh anyway.
  await loginAs(page, ENGINEER_EMAIL, ENGINEER_PASSWORD);

  // The role is the point of this session file. If the seeded ENGINEER were
  // ever re-roled, the role specs would silently assert the wrong thing, so pin
  // it here rather than trusting the fixture.
  const probe = await page.request.get('/api/auth/get-session');
  const body = (await probe.json().catch(() => null)) as { user?: { role?: string } } | null;
  expect(
    body?.user?.role,
    `${ENGINEER_EMAIL} is not an ENGINEER - inventory-role-gate would test the wrong role`,
  ).toBe('ENGINEER');

  await saveVerifiedSession(context, page, 'src/test/e2e/.auth/engineer.json');
});
