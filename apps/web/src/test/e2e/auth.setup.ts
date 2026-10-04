import { test as setup } from '@playwright/test';

import { login } from './helpers';

setup('authenticate as demo user', async ({ page }) => {
  await login(page);
  await page.context().storageState({ path: 'src/test/e2e/.auth/demo.json' });
});
