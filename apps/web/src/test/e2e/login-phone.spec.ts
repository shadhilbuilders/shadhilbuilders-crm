// Sign-in with a phone number (2026-11-25).
//
// `LoginForm.test.tsx` covers the form against a STUBBED resolver: the picker, the
// one failure string, the password handling. This file exists for the half a
// component test structurally cannot see, and it is the case the plan's Tests
// section promised:
//
//   1. the public BFF route answers without a session (it is on the proxy's
//      allowlist, and a route that only works when signed in is useless here);
//   2. the resolver matches a REAL seeded account by its phone, which is the one
//      path where `User.phone`'s stored form and the normalised input have to
//      agree (`auth_account_identities` compares them as strings);
//   3. better-auth issues a session from the email the resolver returned, so the
//      session belongs to the phone's owner and not to whatever the form typed;
//   4. a refusal comes back as the SAME generic message whether the number is
//      unknown or the password is wrong, and leaves NO session behind.
//
// The fixture is the demo OWNER: the only seeded account with both a password and
// a number (`packages/database/scripts/setup-demo-user.ts`).
import { expect, test } from '@playwright/test';

import { DEMO_EMAIL, DEMO_PASSWORD, DEMO_PHONE, fillLoginForm, loginAs, NAV } from './helpers';

const GENERIC_FAILURE = 'Invalid email, phone or password.';

/** Submit a sign-in that is expected to be REFUSED, from a clean context. */
async function submitRefusedSignIn(
  page: import('@playwright/test').Page,
  identifier: string,
  password: string,
): Promise<void> {
  await page.context().clearCookies();
  await page.goto('/login', NAV);
  await fillLoginForm(page, identifier, password);
}

test.describe('sign-in with a phone number', () => {
  test('signs the phone owner in and lands them in the app', async ({ page }) => {
    // `loginAs` clears the inherited demo session first, so this really is a
    // phone sign-in rather than the stored cookie walking through the door.
    await loginAs(page, DEMO_PHONE, DEMO_PASSWORD);

    await expect(page).not.toHaveURL(/\/login(\?|$)/, { timeout: 60_000 });

    // The session must belong to the account the NUMBER identifies. A form that
    // signed in as whatever it typed would still have left /login.
    const session = await page.request.get('/api/auth/get-session');
    expect(session.ok()).toBe(true);
    const body = (await session.json().catch(() => null)) as {
      user?: { email?: string; role?: string };
    } | null;
    expect(body?.user?.email).toBe(DEMO_EMAIL);
    expect(body?.user?.role).toBe('OWNER');
  });

  test('a wrong password is refused with the generic message and no session', async ({ page }) => {
    await submitRefusedSignIn(page, DEMO_PHONE, 'not-the-demo-password');

    // ONE string for every refusal: naming the wrong half would tell an attacker
    // whether the number exists.
    await expect(page.getByText(GENERIC_FAILURE)).toBeVisible({ timeout: 30_000 });
    await expect(page).toHaveURL(/\/login/);

    const session = await page.request.get('/api/auth/get-session');
    const body = (await session.json().catch(() => null)) as { session?: unknown } | null;
    expect(body?.session ?? null).toBeNull();
  });

  test('an unknown number answers with the same message as a wrong password', async ({ page }) => {
    await submitRefusedSignIn(page, '9000000009', 'whatever-they-guessed');

    await expect(page.getByText(GENERIC_FAILURE)).toBeVisible({ timeout: 30_000 });
    await expect(page).toHaveURL(/\/login/);
  });
});
