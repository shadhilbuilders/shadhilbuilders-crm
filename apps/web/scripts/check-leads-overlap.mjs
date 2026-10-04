import { chromium } from '@playwright/test';

const browser = await chromium.launch({ headless: true });
const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });

await page.goto('http://localhost:3000/login');
await page.locator('input#email, input[name="email"]').fill('admin@shadhilbuilders.in');
await page.locator('[data-qa="login-password"]').fill('admin_placeholder_pw');
await page.getByRole('button', { name: /sign in/i }).click();
try {
  await page.waitForURL((u) => !u.pathname.startsWith('/login'), { timeout: 15000 });
} catch {
  console.log('login failed, url=', page.url());
  console.log(await page.locator('body').innerText().then(t => t.slice(0, 500)));
  await page.screenshot({ path: '/tmp/leads-login-fail.png' });
  await browser.close();
  process.exit(1);
}

console.log('after login', page.url());

// Find a project from admin list
await page.goto('http://localhost:3000/shadhil-builders/admin/projects');
await page.waitForTimeout(1500);
console.log('projects url', page.url());
const first = page.locator('a[data-qa^="project-row-link-"]').first();
if (await first.count() === 0) {
  console.log('no project links, body snippet:');
  console.log(await page.locator('body').innerText().then(t => t.slice(0, 800)));
  await page.screenshot({ path: '/tmp/leads-projects.png' });
  await browser.close();
  process.exit(1);
}
await first.click();
await page.waitForURL(/\/admin\/projects\//, { timeout: 15000 });
await page.waitForTimeout(1500);

const pager = page.locator('[data-qa="admin-project-leads-pagination"]');
const leadsHeading = page.getByRole('heading', { name: /^leads$/i });
await pager.waitFor({ timeout: 10000 }).catch(() => {});
console.log('page', page.url());
console.log('pager count', await pager.count());

if (await pager.count()) {
  const pagerBox = await pager.boundingBox();
  const items = page.locator('h2').filter({ hasText: /^Leads$/i }).locator('xpath=../..').locator('li');
  // broader: list items near pager
  const lis = page.locator('[data-qa="admin-project-leads-pagination"]').locator('xpath=preceding-sibling::div[1]//li');
  const n = await lis.count();
  console.log('lead rows', n);
  const overlaps = [];
  for (let i = 0; i < n; i++) {
    const box = await lis.nth(i).boundingBox();
    if (!box || !pagerBox) continue;
    const hit = !(box.x + box.width <= pagerBox.x || pagerBox.x + pagerBox.width <= box.x || box.y + box.height <= pagerBox.y || pagerBox.y + pagerBox.height <= box.y);
    if (hit) overlaps.push(i);
  }
  console.log('pagerBox', pagerBox);
  console.log('overlapping row indexes', overlaps);
}

await page.locator('h2').filter({ hasText: /^Leads$/i }).scrollIntoViewIfNeeded();
await page.screenshot({ path: '/tmp/leads-section.png', fullPage: false });
const leadsSection = page.locator('h2').filter({ hasText: /^Leads$/i }).locator('xpath=../..');
await leadsSection.screenshot({ path: '/tmp/leads-section-clip.png' });
await browser.close();
