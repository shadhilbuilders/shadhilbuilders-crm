import { expect, test, type Page } from '@playwright/test';

/**
 * The phone field's typing rules, in a real browser (2026-11-23).
 *
 * Everything here is invisible to jsdom: `react-phone-number-input` formats
 * through `input-format` against a live DOM input, so the bugs below only exist
 * once a real keystroke hits a real input. All three were found this way and
 * fixed in the same change; this spec is the guard so they do not come back.
 *
 *   1. Typing one digit past the country's mobile length used to DELETE a digit
 *      already typed. 11 keys into the India field left 9 digits in the box.
 *   2. Pasting `+1 650 234 5678` while India was on the trigger stored
 *      91 650 234 5678: the national template dropped the `+`.
 *   3. Switching the country after typing stored bare national digits, which
 *      then parsed as another country's number and lost digits.
 *
 * The field under test is the New lead form (`data-qa="lead-phone"`), chosen
 * because nothing is persisted until submit - the spec types, asserts and
 * leaves without creating a lead.
 */
import { gotoApp, login } from './helpers';

// A cold `next dev` compiles a route on first hit, and this box measured 82s to
// 113s for that (see .hermes/environment.json). The repo's 45s navigation
// ceiling is enough once a route is warm, but not for the first visit in a fresh
// dev process, so this spec carries its own larger budget rather than reporting a
// harness artifact as a phone-field failure.
test.describe.configure({ timeout: 120_000 });

const NEW_LEAD_URL = '/demo/projects/demo-villas/leads/new';

/** Digits the input is showing, separators stripped. */
async function shownDigits(page: Page): Promise<string> {
  const value = await page.locator('[data-qa="lead-phone"]').inputValue();
  return value.replace(/\D/g, '');
}

/** The country the trigger says will be stored. */
function countryTrigger(page: Page) {
  return page.locator('[data-qa="lead-phone-country"]');
}

async function openNewLead(page: Page): Promise<void> {
  await login(page);
  await gotoApp(page, NEW_LEAD_URL);
  await expect(page.getByRole('heading', { name: /New lead/i })).toBeVisible({
    timeout: 30_000,
  });
  await expect(page.locator('[data-qa="lead-phone"]')).toBeVisible({ timeout: 15_000 });
}

async function clearPhone(page: Page): Promise<void> {
  const field = page.locator('[data-qa="lead-phone"]');
  await field.click();
  await page.keyboard.press('Control+A');
  await page.keyboard.press('Backspace');
  await expect.poll(() => shownDigits(page)).toBe('');
}

test('typing stops at the country mobile length and keeps every accepted digit', async ({
  page,
}) => {
  await openNewLead(page);

  // India is the default country, and takes 10 national digits.
  await expect(countryTrigger(page)).toHaveAttribute('aria-label', /India \(\+91\)/);

  const field = page.locator('[data-qa="lead-phone"]');
  await field.click();
  // 11 digits into a 10-digit field. The 11th must be refused, and the ten
  // already typed must survive: the old behaviour dropped the 0 and left 9.
  await field.pressSequentially('98765432109', { delay: 60 });

  await expect.poll(() => shownDigits(page)).toBe('9876543210');
  expect(await field.inputValue()).toBe('98765 43210');
});

test('a pasted number that carries its own country keeps that country', async ({ page }) => {
  await page.context().grantPermissions(['clipboard-read', 'clipboard-write'], {
    origin: 'http://localhost:3000',
  });
  await openNewLead(page);
  await clearPhone(page);

  await page.evaluate(() => navigator.clipboard.writeText('+1 650 234 5678'));
  await page.locator('[data-qa="lead-phone"]').click();
  await page.keyboard.press('Control+V');

  // The trigger follows the number, so the 91 that used to be prefixed onto
  // this US number cannot happen.
  await expect(countryTrigger(page)).toHaveAttribute('aria-label', /United States \(\+1\)/, {
    timeout: 10_000,
  });
  await expect.poll(() => shownDigits(page)).toBe('6502345678');
});

test('switching the country after typing keeps the digits and re-stamps the code', async ({
  page,
}) => {
  await openNewLead(page);

  const field = page.locator('[data-qa="lead-phone"]');
  await field.click();
  await field.pressSequentially('9876543210', { delay: 60 });
  await expect.poll(() => shownDigits(page)).toBe('9876543210');

  await countryTrigger(page).click();
  await page.getByRole('option', { name: /^United Arab Emirates \+971$/ }).click();

  // UAE takes 9 digits, so the tenth is cut, and the trigger is the country
  // that will be stored. The bug this replaces lost two digits from the middle
  // and jumped the trigger to Iran.
  await expect(countryTrigger(page)).toHaveAttribute(
    'aria-label',
    /United Arab Emirates \(\+971\)/,
  );
  await expect.poll(() => shownDigits(page)).toBe('987654321');
});
