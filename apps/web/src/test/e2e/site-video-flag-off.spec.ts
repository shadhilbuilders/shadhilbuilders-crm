import { expect, test } from '@playwright/test';

import { ENGINEER_EMAIL, ENGINEER_PASSWORD, NAV, loginAs } from './helpers';

/**
 * Flag OFF: the capture screen must be exactly today's photo-only screen.
 *
 * Runs only when the server under test was started with SITE_VIDEO_CAPTURE unset
 * or 'false', because that is the variable this proves. On a flag-on server the
 * Video target is correctly present and this file has nothing to say, so it
 * skips rather than failing for the wrong reason.
 *
 * The site-video.spec.ts run NEEDS the flag on. Run the two with different
 * servers (or restart the web server between them); the skip message says so.
 */
const UNIT_URL = '/shadhil-builders/projects/shadhil-metro-heights/site/cmu55o059000fyju8wvcaj7ch';

test.use({
  viewport: { width: 393, height: 851 },
  isMobile: true,
  hasTouch: true,
});

test.describe('site video flag off', () => {
  test.setTimeout(240_000);

  test('the capture screen is the photo-only screen', async ({ page }) => {
    await loginAs(page, ENGINEER_EMAIL, ENGINEER_PASSWORD);
    await page.goto(UNIT_URL, { ...NAV, timeout: 120_000 });
    await expect(page.locator('[data-qa="site-take-photo"]')).toBeVisible({ timeout: 60_000 });

    // Ask the PAGE which flag it was rendered with: the server wrapper passes
    // `videoEnabled` into the client payload. A spec cannot see the server's env,
    // so guessing from the shell produced a false skip that then failed.
    const html = await page.content();
    const rendered = /videoEnabled\\?":(true|false)/.exec(html)?.[1];
    test.skip(
      rendered === 'true',
      'server started with SITE_VIDEO_CAPTURE=true: site-video.spec.ts covers that build',
    );
    expect(rendered, 'the server wrapper must pass videoEnabled explicitly').toBe('false');

    // Today's actions, unchanged.
    await expect(page.locator('[data-qa="site-gallery-trigger"]')).toBeVisible();

    // No Video target, no recorder, no hidden video input: a flag-off deploy
    // ships no dead control and no "coming soon".
    await expect(page.locator('[data-qa="capture-video"]')).toHaveCount(0);
    await expect(page.locator('[data-qa="capture-video-input"]')).toHaveCount(0);
    await expect(page.locator('[data-qa="recorder-sheet"]')).toHaveCount(0);
  });
});
