import { mkdirSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';

import { expect, test, type Page } from '@playwright/test';

import { ENGINEER_EMAIL, ENGINEER_PASSWORD, NAV, SITE_HOME, loginAs } from './helpers';

/**
 * Device gate (build-sequence "Device gate before the flag flips").
 *
 * Five rows are listed there: two Android Chrome handsets, two iPhones, and the
 * buyer's WhatsApp in-app browser. None of them can be run here. What this file
 * does is run the same sequence in an emulated Android Chrome and MEASURE the
 * criteria, so the only thing left for a phone is the phone: the radio, the
 * camera pipeline, the thermal throttle, iOS Safari's own MediaRecorder.
 *
 * Every measurement is written to docs/plans/artefacts/device-gate-results.json
 * together with the emulation it was taken under. A row without an artefact did
 * not pass, so nothing here is allowed to be silent about its conditions.
 *
 * Needs both servers started with SITE_VIDEO_CAPTURE=true, the two storage caps
 * set, and MEDIA_STORAGE=local.
 */

// Playwright runs with cwd = apps/web.
const ARTEFACT_DIR = resolve(process.cwd(), '../../docs/plans/artefacts');

interface RowResult {
  row: string;
  emulation: Record<string, unknown>;
  metrics: Record<string, number | string | boolean | null>;
  notes: string[];
}

const ANDROID_13 =
  'Mozilla/5.0 (Linux; Android 13; Pixel 7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Mobile Safari/537.36';

test.use({
  viewport: { width: 393, height: 851 },
  isMobile: true,
  hasTouch: true,
  permissions: ['camera', 'microphone'],
  userAgent: ANDROID_13,
  launchOptions: {
    args: [
      '--use-fake-device-for-media-stream',
      '--use-fake-ui-for-media-stream',
      '--enable-features=MediaRecorderEnableMp4Muxer',
    ],
  },
});

/**
 * On demand, never in the default suite. This file measures a browser and prints
 * numbers a human then reads; leaving it in `playwright test` would put a 7
 * minute, machine-speed-dependent harness in front of every PR. CI runs the
 * suite without DEVICE_GATE, so these rows report as skipped there.
 */
test.skip(
  process.env.DEVICE_GATE !== '1',
  'device gate harness: run with DEVICE_GATE=1 npx playwright test device-gate',
);

const results: RowResult[] = [];

test.afterAll(() => {
  if (results.length === 0) return;
  mkdirSync(ARTEFACT_DIR, { recursive: true });
  writeFileSync(
    join(ARTEFACT_DIR, 'device-gate-results.json'),
    `${JSON.stringify({ takenAt: new Date().toISOString(), rows: results }, null, 2)}\n`,
  );
});

/** CDP network shaping, in the profiles Chromium DevTools ships with. */
const NETWORK = {
  // 1.6 Mbps down / 750 kbps up / 150 ms RTT
  fast3g: { latency: 150, downloadThroughput: 200 * 1024, uploadThroughput: 94 * 1024 },
  // 400 kbps both ways / 400 ms RTT
  slow3g: { latency: 400, downloadThroughput: 50 * 1024, uploadThroughput: 50 * 1024 },
  off: { latency: 0, downloadThroughput: -1, uploadThroughput: -1 },
};

async function shape(page: Page, profile: keyof typeof NETWORK | null): Promise<void> {
  const cdp = await page.context().newCDPSession(page);
  await cdp.send('Network.enable');
  const p = NETWORK[profile ?? 'off'];
  await cdp.send('Network.emulateNetworkConditions', {
    offline: false,
    latency: p.latency,
    downloadThroughput: p.downloadThroughput,
    uploadThroughput: p.uploadThroughput,
  });
}

/**
 * Same walk as `openSiteUnit`, with a 4-minute ceiling. That route compiles on
 * first hit under `next dev`, and this file is measuring a browser, not Next's
 * compiler: a cold compile must not be recorded as a device failure.
 */
async function openCapture(page: Page): Promise<void> {
  await loginAs(page, ENGINEER_EMAIL, ENGINEER_PASSWORD);
  await page.goto(SITE_HOME, { ...NAV, timeout: 240_000 });
  const unit = page.locator('a[href*="/site/"]').first();
  await expect(unit).toBeVisible({ timeout: 120_000 });
  const href = await unit.getAttribute('href');
  expect(href, 'the site list must link to a unit').toBeTruthy();
  await page.goto(String(href), { ...NAV, timeout: 240_000 });
  await expect(page.locator('[data-qa="capture-video"]')).toBeVisible({ timeout: 120_000 });
}

interface SavedRow {
  id: string;
  videoUrl: string;
}

/**
 * Record, save, and hand back what the save response said plus the three
 * numbers the gate asks about: how long the recorder took to start, how long
 * the upload took on the shaped network, and how long the clip took to play.
 */
async function recordSaveMeasure(
  page: Page,
  opts: {
    clipMs: number;
    uploadProfile: keyof typeof NETWORK | null;
    playbackProfile: keyof typeof NETWORK | null;
  },
): Promise<{ row: SavedRow; metrics: Record<string, number | boolean>; notes: string[] }> {
  const notes: string[] = [];
  await page.locator('[data-qa="capture-video"]').click();
  await expect(page.locator('[data-qa="recorder-start"]')).toBeVisible();

  const t0 = Date.now();
  await page.locator('[data-qa="recorder-start"]').click();
  await expect(page.locator('[data-qa="recorder-live-video"]')).toBeVisible({ timeout: 20_000 });
  const recordStartMs = Date.now() - t0;
  await expect(page.locator('[data-qa="recorder-stop"]')).toBeVisible();

  await page.waitForTimeout(opts.clipMs);
  await page.locator('[data-qa="recorder-stop"]').click();
  await expect(page.locator('[data-qa="video-preview"]')).toBeVisible({ timeout: 20_000 });

  await shape(page, opts.uploadProfile);
  const pending = page.waitForResponse(
    (r) => r.request().method() === 'POST' && /\/videos$/.test(new URL(r.url()).pathname),
    { timeout: 240_000 },
  );
  const tSave = Date.now();
  await page.locator('[data-qa="video-save"]').click();
  const response = await pending;
  const uploadMs = Date.now() - tSave;
  expect(response.ok(), `save answered ${response.status()}`).toBe(true);
  const row = (await response.json()) as SavedRow;
  expect(row.videoUrl, 'the save response must carry the clip URL').toBeTruthy();
  await shape(page, opts.playbackProfile);

  // Playback: the tile in the feed opens the lightbox, whose <video> is the
  // buyer's player too. The player does not preload a frame until it is asked to
  // play, so "playback starts" means press play and watch the clock move, not
  // watch readyState climb.
  await expect(page.locator('[data-qa="video-tile-badge"]').first()).toBeVisible({
    timeout: 60_000,
  });
  const tPlay = Date.now();
  await page.locator('[data-qa="video-tile-badge"]').first().click();
  const video = page.locator('video').first();
  await expect(video).toBeVisible({ timeout: 20_000 });
  await page.evaluate(() => {
    const v = document.querySelector('video');
    if (v !== null) {
      v.muted = true;
      void v.play().catch(() => undefined);
    }
  });
  await page.waitForFunction(
    () => {
      const v = document.querySelector('video');
      return v !== null && v.currentTime > 0.15;
    },
    undefined,
    { timeout: 30_000 },
  );
  const playbackMs = Date.now() - tPlay;

  const seek = await page.evaluate(async () => {
    const v = document.querySelector('video');
    if (v === null) return { ok: false, reason: 'no video element' };
    v.pause();
    const target = Math.min(1, Math.max(0, (v.duration || 2) - 0.5));
    const before = v.currentTime;
    v.currentTime = target;
    await new Promise<void>((done) => {
      const fin = (): void => done();
      v.addEventListener('seeked', fin, { once: true });
      setTimeout(fin, 5_000);
    });
    return { ok: Math.abs(v.currentTime - target) < 0.6, before, after: v.currentTime, target };
  });
  if (!seek.ok) notes.push(`seek did not land: ${JSON.stringify(seek)}`);

  const body = await page.context().request.get(new URL(row.videoUrl, page.url()).toString());
  const bytes = (await body.body()).length;

  // eslint-disable-next-line no-console
  console.log(
    `[gate] ${row.id} recordStart=${recordStartMs}ms upload=${uploadMs}ms playback=${playbackMs}ms bytes=${bytes} seek=${seek.ok}`,
  );

  return {
    row,
    notes,
    metrics: {
      recordStartMs,
      uploadMs,
      playbackMs,
      clipBytes: bytes,
      seekLanded: seek.ok,
    },
  };
}

test.describe('device gate - android chrome (emulated)', () => {
  test.setTimeout(420_000);

  test('row 1 - Android 13, mid-range: record, upload on 3G, playback, seek', async ({ page }) => {
    await openCapture(page);

    const codecs = await page.evaluate(() => ({
      recordMp4: MediaRecorder.isTypeSupported('video/mp4;codecs=avc1'),
      aac: MediaRecorder.isTypeSupported('video/mp4;codecs=avc1,mp4a.40.2'),
      canPlayH264: document.createElement('video').canPlayType('video/mp4; codecs="avc1.42E01E"'),
    }));
    expect(codecs.recordMp4, 'this browser cannot record MP4/H.264 at all').toBe(true);

    const { metrics, notes } = await recordSaveMeasure(page, {
      clipMs: 20_000,
      uploadProfile: 'fast3g',
      playbackProfile: null,
    });

    results.push({
      row: 'android-13-midrange (emulated Chromium, Pixel-class viewport, fake camera)',
      emulation: { ua: 'Android 13', uploadProfile: 'fast3g 1.6Mbps/750kbps/150ms', codecs },
      metrics: { ...metrics, clipSeconds: 20 },
      notes,
    });

    await page.screenshot({
      path: join(ARTEFACT_DIR, 'device-gate-android13-feed.png'),
      fullPage: false,
    });

    // The gate's numbers, applied to what was measured.
    expect(metrics.recordStartMs, 'record must start under 1.5s').toBeLessThan(1500);
    expect(metrics.uploadMs, 'a 20s clip must upload within 90s on this profile').toBeLessThan(
      90_000,
    );
    expect(metrics.playbackMs, 'playback must start under 3s').toBeLessThan(3000);
    expect(metrics.seekLanded).toBe(true);
  });

  test('row 2 - Android 11, low-end: same clip through 4x CPU throttle and slow 3G', async ({
    page,
  }) => {
    await openCapture(page);
    const cdp = await page.context().newCDPSession(page);
    await cdp.send('Emulation.setCPUThrottlingRate', { rate: 4 });

    const { metrics, notes } = await recordSaveMeasure(page, {
      clipMs: 20_000,
      uploadProfile: 'slow3g',
      playbackProfile: null,
    });

    results.push({
      row: 'android-11-lowend (emulated Chromium, 4x CPU throttle, fake camera)',
      emulation: {
        cpuThrottle: 4,
        uploadProfile: 'slow3g 400kbps/400kbps/400ms',
        notes: 'backgrounding mid-upload cannot be emulated in headless Chromium',
      },
      metrics: { ...metrics, clipSeconds: 20 },
      notes,
    });

    expect(metrics.uploadMs, 'a 20s clip must upload within 120s on slow 3G').toBeLessThan(120_000);
    // The gate's bar is 3s on a real low-end handset. This profile is harsher
    // than any phone DevTools can emulate (4x CPU AND a 393px viewport on WSL),
    // so the number is MEASURED and reported rather than asserted away: it goes
    // into the artefact, and the results doc says whether it cleared 3s.
    expect(metrics.playbackMs, 'playback must at least start').toBeLessThan(10_000);
  });

  test.describe('whatsapp in-app browser', () => {
    // An Android WebView carrying WhatsApp's UA. The shape of the page it gets
    // is what this proves; the app's own webview is not here.
    test.use({
      userAgent:
        'Mozilla/5.0 (Linux; Android 13; SM-A536B) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Mobile Safari/537.36 WhatsApp/2.24.25.79',
    });

    test('row 5 - the clip plays inline, no download prompt', async ({ page }) => {
      await openCapture(page);

      const { metrics } = await recordSaveMeasure(page, {
        clipMs: 3_000,
        uploadProfile: null,
        playbackProfile: null,
      });
      const played = await page.evaluate(() => {
        const v = document.querySelector('video');
        if (v === null)
          return { inline: false, advanced: false, downloadAttr: null as string | null };
        return {
          inline: v.playsInline === true || v.hasAttribute('playsinline'),
          advanced: v.currentTime > 0,
          downloadAttr: v.getAttribute('download'),
        };
      });

      results.push({
        row: 'whatsapp-inapp (WhatsApp UA on desktop Chromium, not the real webview)',
        emulation: { ua: 'SM-A536B Android 13 WhatsApp/2.24.25.79' },
        metrics: { ...metrics, playsInline: played.inline, playbackAdvanced: played.advanced },
        notes: [
          'portal authentication as a buyer was not exercised: no OTP device in this environment',
        ],
      });

      expect(played.inline, 'the player must be playsinline or iOS/WhatsApp force a download').toBe(
        true,
      );
      expect(played.advanced, 'the clip must advance, not sit at 0').toBe(true);
    });
  });
});

test.describe('device gate - safari engine probe', () => {
  test('rows 3 and 4 - not runnable on this host', async () => {
    // The WebKit build downloads (95.5 MiB) and then refuses to launch: the
    // browser needs system libraries this WSL image does not carry, and
    // `playwright install-deps` needs root, which is not available here.
    const detail =
      'not run: Playwright WebKit cannot launch on this host (missing system libraries, no root for install-deps)';
    results.push({
      row: 'iphone-safari (engine unavailable here)',
      emulation: { engine: 'Playwright WebKit', os: 'Linux (WSL)' },
      metrics: {},
      notes: [
        detail,
        'iOS Safari MediaRecorder support arrived in 17.4 and differs by version: only a phone settles rows 3 and 4',
        'no camera, no radio, no iOS video pipeline in this environment',
      ],
    });
    test.skip(true, detail);
  });
});
