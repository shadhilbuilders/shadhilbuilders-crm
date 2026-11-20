import { chromium } from '@playwright/test';

const BASE = 'http://localhost:3000';
const browser = await chromium.launch();
const ctx = await browser.newContext({ viewport: { width: 1280, height: 900 } });
const page = await ctx.newPage();

await page.goto(`${BASE}/login`, { waitUntil: 'domcontentloaded', timeout: 60000 });
const email = page.locator('input#email, input[name="email"]');
if (await email.count()) {
  await email.fill('demo@shadhilbuilders.in');
  await page.locator('[data-qa="login-password"]').fill('demo123');
  await page.getByRole('button', { name: /sign in/i }).click();
  await page.waitForURL((u) => !u.pathname.startsWith('/login'), {
    timeout: 60000,
    waitUntil: 'commit',
  });
}

const org = new URL(page.url()).pathname.split('/')[1];
const target = `${BASE}/${org}/admin/users`;
await page.goto(target, { waitUntil: 'domcontentloaded', timeout: 60000 });
await page.locator('[data-qa="tabs-list"]').waitFor({ state: 'visible', timeout: 60000 });

const invitesTab = page.locator('[data-qa="tabs-trigger"]', { hasText: 'Invites' });
await invitesTab.click();
await page.waitForTimeout(500);

const info = await page.evaluate(() => {
  const list = document.querySelector('[data-qa="tabs-list"]');
  const cs = getComputedStyle(list);
  const triggers = Array.from(list.querySelectorAll('[data-qa="tabs-trigger"]')).map((t) => {
    const r = t.getBoundingClientRect();
    const after = getComputedStyle(t, '::after');
    return {
      text: t.textContent,
      box: [Math.round(r.left), Math.round(r.top), Math.round(r.width), Math.round(r.height)],
      afterHeight: after.height,
      afterBottom: after.bottom,
      afterInsetX: after.inset,
    };
  });
  const lr = list.getBoundingClientRect();
  return {
    listBox: [Math.round(lr.left), Math.round(lr.top), Math.round(lr.width), Math.round(lr.height)],
    clientW: list.clientWidth,
    scrollW: list.scrollWidth,
    clientH: list.clientHeight,
    scrollH: list.scrollHeight,
    overflowX: cs.overflowX,
    overflowY: cs.overflowY,
    scrollbarGutter: cs.scrollbarGutter,
    triggers,
  };
});

console.log(JSON.stringify(info, null, 2));
await page.screenshot({ path: '/tmp/tabs-before.png', clip: { x: 0, y: 0, width: 700, height: 400 } });
await browser.close();
