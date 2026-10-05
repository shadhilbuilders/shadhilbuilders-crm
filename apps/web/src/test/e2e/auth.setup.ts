import { expect, test as setup } from '@playwright/test';

import { login } from './helpers';

setup('authenticate as demo user', async ({ page }) => {
  await login(page);
  // A "passing" setup that saved no session poisons every spec that depends on it.
  const cookies = await page.context().cookies();
  expect(
    cookies.some((c) => c.name.endsWith('better-auth.session_token')),
    'auth.setup finished without a better-auth session cookie',
  ).toBe(true);
  await page.context().storageState({ path: 'src/test/e2e/.auth/demo.json' });
});
