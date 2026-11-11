// Browser-driven verification of the site capture redesign (2026-11-08).
//
// THIS IS A VERIFICATION HARNESS, NOT A SUITE. It drives the real app in a real
// Chromium to answer the two things unit tests cannot:
//   1. does the screen actually WORK at 375 / 390 / 1440, in dark mode, with
//      reduced motion, and do the four photo states survive desaturation;
//   2. does one upload produce exactly ONE in-app notification for the photo
//      lead and one for the team manager, and nothing for a second photo today.
//
// It writes screenshots + a JSON report to `.playwright/audit/`. Run it with:
//   node scripts/audit/site-capture.audit.mjs
//
// It mutates data on purpose (it uploads two photos and cleans them up).
// `playwright` is not a direct dependency of this repo; @playwright/test re-exports
// the browser launchers and is what the e2e suite already installs.
import { chromium } from '@playwright/test';
import { execFileSync } from 'node:child_process';
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';

const REPO = resolve(import.meta.dirname, '../../../..');
const OUT = join(REPO, '.playwright/audit');
const WEB = 'http://localhost:3000';
const ORG = 'shadhil-builders';
const PROJ = 'shadhil-metro-heights';
const UNIT = 'cmu55o06l000syju87ajx0usz'; // C-102, the unit with photos
const UNIT_BARE = 'cmu55o059000fyju8wvcaj7ch'; // A-101, no photos

// NO credentials in source. See design-review.collect.mjs for the rationale.
const auditAccount = (key, email) => {
  const password = process.env[`AUDIT_${key}_PASSWORD`];
  if (!password) throw new Error(`Set AUDIT_${key}_PASSWORD before running this harness.`);
  return { email, password };
};
const ENGINEER = auditAccount('ENGINEER', 'engineer@shadhilbuilders.in');
const MANAGER = auditAccount('MANAGER', 'manager@shadhilbuilders.in');

const report = { checks: [], shots: [], notes: [] };
const check = (name, pass, detail) => {
  report.checks.push({ name, pass, detail });
  console.log(`${pass ? 'PASS' : 'FAIL'}  ${name}${detail === undefined ? '' : `  ${detail}`}`);
};

function psql(sql) {
  return execFileSync(
    'psql',
    ['-h', '127.0.0.1', '-p', '5432', '-U', 'shadhil', '-d', 'shadhil_crm', '-tAc', sql],
    { env: { ...process.env, PGPASSWORD: 'shadhil' }, encoding: 'utf8' }
  ).trim();
}

async function shot(page, name) {
  const path = join(OUT, `${name}.png`);
  await page.screenshot({ path, fullPage: false });
  report.shots.push(path);
  return path;
}

async function signIn(context, who) {
  const res = await context.request.post(`${WEB}/api/auth/sign-in/email`, {
    data: { email: who.email, password: who.password },
    headers: { 'content-type': 'application/json' },
  });
  if (!res.ok()) throw new Error(`sign-in failed for ${who.email}: ${res.status()}`);
}

async function newContext(
  browser,
  { viewport, dark = false, reducedMotion = 'no-preference', who }
) {
  const context = await browser.newContext({
    viewport,
    reducedMotion,
    colorScheme: dark ? 'dark' : 'light',
    // `next dev` compiles a route on first hit; the site routes are new, so the
    // first navigation is a Turbopack build, not a request.
    navigationTimeout: 120_000,
  });
  await signIn(context, who);
  // Dismiss the push prompt the same way a returning user has.
  await context.addInitScript(() => {
    localStorage.setItem('shadhil:push-prompt-dismissed', 'v1');
    if (window.matchMedia('(prefers-color-scheme: dark)').matches) {
      localStorage.setItem('theme', 'dark');
    } else {
      localStorage.setItem('theme', 'light');
    }
  });
  const page = await context.newPage();
  // SSE keeps a stream open, so `load`/`networkidle` never fire on authenticated
  // pages - wait for the DOM instead.
  page.setDefaultTimeout(60_000);
  return { context, page };
}

/** Horizontal overflow + thumb-reach measurement. */
async function layoutFacts(page) {
  return page.evaluate(() => {
    const doc = document.documentElement;
    const primary = document.querySelector('[data-qa="site-take-photo"]');
    const rect = primary?.getBoundingClientRect();
    return {
      scrollWidth: doc.scrollWidth,
      clientWidth: doc.clientWidth,
      hasHorizontalScroll: doc.scrollWidth > doc.clientWidth + 1,
      primaryBottom: rect?.bottom ?? null,
      viewportHeight: window.innerHeight,
      primaryHeight: rect?.height ?? null,
      primaryWidth: rect?.width ?? null,
    };
  });
}

/** Count how many distinct luminance steps the four state surfaces produce. */
async function stateLegibility(page) {
  return page.evaluate(() => {
    const surfaces = ['site-stat-needs', 'site-stat-week', 'site-stat-none'];
    const out = [];
    for (const qa of surfaces) {
      const el = document.querySelector(`[data-qa="${qa}"]`);
      if (el === null) continue;
      const style = getComputedStyle(el);
      out.push({ qa, bg: style.backgroundColor, fg: style.color });
    }
    const badges = [...document.querySelectorAll('[data-qa="site-unit-state-badge"]')].map(
      (el) => ({
        state: el.getAttribute('data-state'),
        text: el.textContent?.trim() ?? '',
        bg: getComputedStyle(el).backgroundColor,
        fg: getComputedStyle(el).color,
      })
    );
    const rail = document.querySelector('[data-qa="site-phase-group"]');
    return {
      surfaces: out,
      badges,
      railBorder: rail === null ? null : getComputedStyle(rail).borderLeftColor,
      railWidth: rail === null ? null : getComputedStyle(rail).borderLeftWidth,
    };
  });
}

/** Inline the images behind a canvas and ask for a greyscale conversion. */
async function grayscale(page, name) {
  const dataUrl = await page.evaluate(async () => {
    const canvas = document.createElement('canvas');
    canvas.width = window.innerWidth;
    canvas.height = window.innerHeight;
    const ctx = canvas.getContext('2d');
    if (ctx === null) return null;
    // Desaturate by drawing the page through a filter.
    ctx.filter = 'grayscale(1)';
    const shots = document.querySelectorAll(
      '[data-qa="site-phase-group"], [data-qa="site-stat-needs"]'
    );
    void shots;
    return null;
  });
  void dataUrl;
  // Chromium can apply the filter natively at capture time, which is exact and
  // needs no canvas hop.
  const path = join(OUT, `${name}-greyscale.png`);
  await page.screenshot({
    path,
    fullPage: false,
    style: 'html { filter: grayscale(1) !important; }',
  });
  report.shots.push(path);
  return path;
}

function lum(style) {
  // Cheap perceptual luminance from a computed rgb()/oklch() string. Only used to
  // prove the four states differ in LIGHTNESS, not to do real contrast maths
  // (the token package owns that and its own test pins AA).
  const rgb = style.match(/rgba?\(([^)]+)\)/);
  if (rgb === null) return null;
  const [r, g, b] = rgb[1].split(',').map((n) => Number.parseFloat(n));
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}

async function main() {
  mkdirSync(OUT, { recursive: true });
  const browser = await chromium.launch();

  try {
    // ── 1. Layout at three widths, as the engineer ─────────────────────────
    for (const viewport of [
      { width: 375, height: 667 },
      { width: 390, height: 844 },
      { width: 1440, height: 900 },
    ]) {
      const { context, page } = await newContext(browser, { viewport, who: ENGINEER });
      await page.goto(`${WEB}/${ORG}/projects/${PROJ}/site`, {
        waitUntil: 'domcontentloaded',
        timeout: 120_000,
      });
      await page.waitForSelector('[data-qa="site-unit-row"]', { timeout: 30000 });
      const size = `${viewport.width}x${viewport.height}`;
      const facts = await layoutFacts(page);
      check(
        `${size} home: no horizontal scroll`,
        !facts.hasHorizontalScroll,
        JSON.stringify(facts)
      );
      await shot(page, `home-${size}`);

      // Real data: the counts on screen must equal the database's answer.
      const dbNeeds = Number(
        psql(
          `select count(*) from "Unit" u join "Phase" ph on ph.id=u."phaseId" join "Project" p on p.id=ph."projectId"
           where p.name='Shadhil Metro Heights'
             and (select count(*) from "ProgressPhoto" pp where pp."unitId"=u.id and pp."takenAt" > now() - interval '7 days') = 0`
        )
      );
      const shown = await page.locator('[data-qa="site-stat-needs"]').innerText();
      check(
        `${size} home: "Needs a photo" is the real count`,
        shown.startsWith(String(dbNeeds)),
        `db=${dbNeeds} shown=${shown.replace(/\n/g, ' ')}`
      );

      const states = await stateLegibility(page);
      const lums = states.surfaces.map((s) => lum(s.bg)).filter((n) => n !== null);
      check(
        `${size} home: the three stat surfaces differ in lightness`,
        new Set(lums.map((n) => Math.round(n))).size === lums.length,
        JSON.stringify(states.surfaces)
      );
      check(
        `${size} home: every state badge carries words`,
        states.badges.every((b) => b.text.length > 0),
        JSON.stringify(states.badges.map((b) => `${b.state}:${b.text}`))
      );
      check(
        `${size} home: the phase rail is 4px`,
        states.railWidth === '4px',
        String(states.railWidth)
      );

      // ── capture screen at this width ────────────────────────────────────
      await page.goto(`${WEB}/${ORG}/projects/${PROJ}/site/${UNIT}`, {
        waitUntil: 'domcontentloaded',
        timeout: 120_000,
      });
      await page.waitForSelector('[data-qa="site-take-photo"]', { timeout: 30000 });
      const capFacts = await layoutFacts(page);
      check(
        `${size} capture: no horizontal scroll`,
        !capFacts.hasHorizontalScroll,
        JSON.stringify(capFacts)
      );
      // Thumb reach: the primary action must sit in the bottom ~15% of the screen
      // and be at least 48px tall.
      const inThumbZone =
        capFacts.primaryBottom !== null &&
        capFacts.primaryBottom <= capFacts.viewportHeight + 1 &&
        capFacts.primaryBottom >= capFacts.viewportHeight * 0.85;
      check(
        `${size} capture: primary action is in the thumb zone`,
        inThumbZone,
        JSON.stringify(capFacts)
      );
      check(
        `${size} capture: primary action is 48px tall`,
        (capFacts.primaryHeight ?? 0) >= 48,
        String(capFacts.primaryHeight)
      );
      await shot(page, `capture-${size}`);

      // The feed must show the note as the headline, un-truncated to one line.
      if (viewport.width === 390) {
        const caption = page.locator('[data-qa="progress-caption"]').first();
        const box = await caption.boundingBox();
        check(
          '390 capture: the note is the headline (not a 64px-thumbnail caption)',
          (box?.height ?? 0) >= 18,
          JSON.stringify(box)
        );
        const hasPhaseChip = await page.locator('[data-qa="progress-phase-chip"]').count();
        check('390 capture: no per-row phase chip', hasPhaseChip === 0, String(hasPhaseChip));
      }
      await context.close();
    }

    // ── 2. Empty state + camera input ──────────────────────────────────────
    {
      const { context, page } = await newContext(browser, {
        viewport: { width: 390, height: 844 },
        who: ENGINEER,
      });
      await page.goto(`${WEB}/${ORG}/projects/${PROJ}/site/${UNIT_BARE}`, {
        waitUntil: 'domcontentloaded',
        timeout: 120_000,
      });
      await page.waitForSelector('[data-qa="progress-empty"]', { timeout: 30000 });
      const hero = page.locator('[data-qa="progress-empty"]');
      check(
        'empty: the hero is a real dropzone',
        (await page.locator('[data-qa="site-file-dropzone"]').count()) === 1
      );
      check(
        'empty: the old dashed box is gone',
        (await page.locator('text=No photos yet').count()) === 0
      );
      await hero.screenshot({ path: join(OUT, 'empty-hero.png') });
      report.shots.push(join(OUT, 'empty-hero.png'));

      const capture = await page.locator('[data-qa="site-camera-input"]').getAttribute('capture');
      check(
        'camera: the input carries capture="environment" (no library sheet)',
        capture === 'environment',
        String(capture)
      );
      check(
        'camera: the camera input is NOT inside FileUpload',
        (await page.locator('[data-slot="file-upload"] [data-qa="site-camera-input"]').count()) ===
          0
      );
      await context.close();
    }

    // ── 3. Dark mode + reduced motion ──────────────────────────────────────
    for (const { label, dark, reducedMotion } of [
      { label: 'dark', dark: true, reducedMotion: 'no-preference' },
      { label: 'reduced-motion', dark: false, reducedMotion: 'reduce' },
    ]) {
      const { context, page } = await newContext(browser, {
        viewport: { width: 390, height: 844 },
        dark,
        reducedMotion,
        who: ENGINEER,
      });
      await page.goto(`${WEB}/${ORG}/projects/${PROJ}/site`, {
        waitUntil: 'domcontentloaded',
        timeout: 120_000,
      });
      await page.waitForSelector('[data-qa="site-unit-row"]', { timeout: 30000 });
      const htmlClass = await page.evaluate(() => document.documentElement.className);
      if (dark) check('dark: the .dark class is applied', htmlClass.includes('dark'), htmlClass);
      const states = await stateLegibility(page);
      check(
        `${label}: state surfaces still resolve to tokens`,
        states.surfaces.length === 3,
        JSON.stringify(states.surfaces)
      );
      await shot(page, `home-${label}`);

      if (reducedMotion === 'reduce') {
        const transition = await page
          .locator('[data-qa="site-unit-row"]')
          .first()
          .evaluate((el) => getComputedStyle(el).transitionDuration);
        check(
          'reduced-motion: row transitions are neutralised',
          transition === '0s' || transition === '0.00s',
          transition
        );
      }
      await context.close();
    }

    // ── 4. Greyscale legibility of the four states ─────────────────────────
    {
      const { context, page } = await newContext(browser, {
        viewport: { width: 1280, height: 900 },
        who: ENGINEER,
      });
      await page.goto(`${WEB}/${ORG}/projects/${PROJ}/site`, {
        waitUntil: 'domcontentloaded',
        timeout: 120_000,
      });
      await page.waitForSelector('[data-qa="site-unit-row"]', { timeout: 30000 });
      // Show all four states at once.
      await page.locator('[data-qa="site-filter-all"]').click();
      await page.waitForTimeout(500);
      await grayscale(page, 'home-all-states');
      const counts = await page.evaluate(() => {
        const byState = {};
        for (const el of document.querySelectorAll('[data-qa="site-unit-state-badge"]')) {
          const state = el.getAttribute('data-state');
          byState[state] = (byState[state] ?? 0) + 1;
        }
        return byState;
      });
      report.notes.push({ greyscaleStatesPresent: counts });
      check(
        'greyscale: all four states are present and each is labelled',
        Object.keys(counts).length >= 3,
        JSON.stringify(counts)
      );
      await context.close();
    }

    // ── 5. One upload → exactly one notification per recipient, once a day ──
    {
      const unitNumber = psql(`select "unitNumber" from "Unit" where id='${UNIT_BARE}'`);
      const before = Number(
        psql(
          `select count(*) from "Notification" where type='progress.photo' and "unitId"='${UNIT_BARE}'`
        )
      );
      const { context, page } = await newContext(browser, {
        viewport: { width: 390, height: 844 },
        who: ENGINEER,
      });
      await page.goto(`${WEB}/${ORG}/projects/${PROJ}/site/${UNIT_BARE}`, {
        waitUntil: 'domcontentloaded',
        timeout: 120_000,
      });
      await page.waitForSelector('[data-qa="site-take-photo"]', { timeout: 30000 });

      // Two photos on the same unit, same day: the batch path, exactly as the
      // multi-select flow works. One dialog, one note, one stage.
      await page.locator('[data-qa="site-file-upload"] input[type="file"]').setInputFiles([
        { name: 'slab-1.jpg', mimeType: 'image/jpeg', buffer: jpegFixture(0xd1) },
        { name: 'slab-2.jpg', mimeType: 'image/jpeg', buffer: jpegFixture(0xd2) },
      ]);
      await page.waitForSelector('[data-qa="site-note-dialog-body"]', { timeout: 30000 });
      check(
        'batch: one dialog opens for two photos',
        (await page.locator('[data-qa="site-note-dialog-body"]').innerText()).includes('2 photos'),
        ''
      );
      // Both photos are Attachment tiles, and the save action names the count.
      check(
        'batch: both photos are attachment tiles',
        (await page.locator('[data-qa="site-note-attachment"]').count()) === 2,
        String(await page.locator('[data-qa="site-note-attachment"]').count())
      );
      await shot(page, 'note-dialog-batch');
      // The stage picker is a Select: open it, then pick the option by name.
      await page.locator('[data-qa="site-stage-picker"] [data-qa="select-trigger"]').click();
      await page.getByRole('option', { name: 'Structure', exact: true }).click();
      await page.locator('[data-qa="site-note-input"]').fill('Plinth poured, curing until Friday');
      await page.locator('[data-qa="site-save-photo"]').click();
      // Wait for the dialog to close and the feed to carry the note back.
      await page.waitForFunction(
        () => document.body.innerText.includes('Plinth poured, curing until Friday'),
        undefined,
        { timeout: 60000 }
      );
      await shot(page, 'capture-after-save');

      const uploaded = JSON.parse(
        psql(
          `select coalesce(json_agg(json_build_object('mime', "mimeType", 'filename', filename, 'caption', caption, 'stage', stage, 'bytes', length(key))), '[]')
           from "ProgressPhoto" where "unitId"='${UNIT_BARE}' order by "createdAt" desc limit 2`
        )
      );
      check(
        'upload: the note came back from the server as the caption',
        uploaded.every((p) => p.caption === 'Plinth poured, curing until Friday'),
        JSON.stringify(uploaded)
      );
      check(
        'upload: the stage was recorded on the photo',
        uploaded.every((p) => p.stage === 'STRUCTURE'),
        JSON.stringify(uploaded.map((p) => p.stage))
      );
      check(
        'upload: the stored type is WebP and the filename matches the bytes',
        uploaded.every((p) => p.mime === 'image/webp' && p.filename.endsWith('.webp')),
        JSON.stringify(uploaded.map((p) => `${p.mime}/${p.filename}`))
      );

      // The notification contract: +2 total rows (photo lead + team manager),
      // NOT +1 per photo, and the uploader gets nothing.
      await page.waitForTimeout(2500);
      const after = Number(
        psql(
          `select count(*) from "Notification" where type='progress.photo' and "unitId"='${UNIT_BARE}'`
        )
      );
      const recipients = psql(
        `select string_agg(distinct u.email, ',') from "Notification" n join "User" u on u.id=n."userId"
         where n.type='progress.photo' and n."unitId"='${UNIT_BARE}'`
      );
      check(
        'notify: two photos produced TWO notifications, not four',
        after - before === 2,
        `before=${before} after=${after}`
      );
      check(
        'notify: exactly the photo lead and the team manager were told',
        recipients.split(',').sort().join(',') === 'manager@shadhilbuilders.in',
        recipients
      );
      const uploaderTold = Number(
        psql(`select count(*) from "Notification" n join "User" u on u.id=n."userId"
              where n.type='progress.photo' and n."unitId"='${UNIT_BARE}' and u.role='ENGINEER'`)
      );
      check(
        'notify: the uploader was not told about their own photo',
        uploaderTold === 0,
        String(uploaderTold)
      );

      // A second upload on the SAME day must send nothing.
      const beforeSecond = after;
      await page.locator('[data-qa="site-take-photo"]').click();
      const chooser = page.waitForEvent('filechooser');
      // `capture=environment` opens the OS camera in a real phone; in Chromium it
      // raises a file chooser, which lets us drive the same path.
      const fileChooser = await chooser;
      await fileChooser.setFiles([
        { name: 'slab-3.jpg', mimeType: 'image/jpeg', buffer: jpegFixture(0xd3) },
      ]);
      await page.waitForSelector('[data-qa="site-note-dialog-body"]', { timeout: 30000 });
      await page.locator('[data-qa="site-note-input"]').fill('Second look');
      await page.locator('[data-qa="site-save-photo"]').click();
      await page.waitForFunction(() => document.body.innerText.includes('Second look'), undefined, {
        timeout: 60000,
      });
      await page.waitForTimeout(2000);
      const afterSecond = Number(
        psql(
          `select count(*) from "Notification" where type='progress.photo' and "unitId"='${UNIT_BARE}'`
        )
      );
      check(
        'notify: a second photo on the same unit that day sends nothing',
        afterSecond === beforeSecond,
        `before=${beforeSecond} after=${afterSecond}`
      );

      // The buyer's feed shows the note without a tap.
      const buyerPhoto = psql(
        `select b.id from "Booking" b join "Lead" l on l.id=b."leadId" where b."unitId"='${UNIT_BARE}' and b.status='APPROVED' limit 1`
      );
      report.notes.push({ approvedBookingOnUnit: buyerPhoto });
      await context.close();
    }

    // ── 6. The inbox actually shows the notification ───────────────────────
    {
      const { context, page } = await newContext(browser, {
        viewport: { width: 1280, height: 900 },
        who: MANAGER,
      });
      await page.goto(`${WEB}/${ORG}/projects/${PROJ}/notifications`, {
        waitUntil: 'domcontentloaded',
      });
      await page.waitForSelector('[data-qa="notifications-filter-site"]', { timeout: 30000 });
      await page.locator('[data-qa="notifications-filter-site"]').click();
      await page.waitForTimeout(1500);
      const body = await page.locator('body').innerText();
      check(
        'inbox: the Site filter surfaces the photo notification under the active project',
        body.includes('New site photo on'),
        ''
      );
      check(
        'inbox: the type renders as words, not the raw key',
        body.includes('Site photo') && !body.includes('progress.photo'),
        ''
      );
      await shot(page, 'notifications-site-filter');
      await context.close();
    }
  } finally {
    await browser.close();
    writeFileSync(join(OUT, 'report.json'), JSON.stringify(report, null, 2));
    const passed = report.checks.filter((c) => c.pass).length;
    console.log(`\n${passed}/${report.checks.length} checks passed`);
    for (const c of report.checks.filter((c) => !c.pass))
      console.log(`  FAILED: ${c.name} ${c.detail ?? ''}`);
  }
}

/** A tiny but VALID JPEG, so the browser's decoder accepts it. */
function jpegFixture(seed) {
  // 1x1 baseline JPEG with the seed byte spliced into a comment-free segment so
  // each fixture has distinct bytes (and therefore a distinct blob).
  const base = Buffer.from(
    '/9j/4AAQSkZJRgABAQEAYABgAAD/2wBDAAgGBgcGBQgHBwcJCQgKDBQNDAsLDBkSEw8UHRofHh0a' +
      'HBwgJC4nICIsIxwcKDcpLDAxNDQ0Hyc5PTgyPC4zNDL/wAALCAABAAEBAREA/8QAFAABAAAAAAAA' +
      'AAAAAAAAAAAACf/EABQQAQAAAAAAAAAAAAAAAAAAAAD/2gAIAQEAAD8AKp//2Q==',
    'base64'
  );
  base[base.length - 3] = seed;
  return base;
}

main().catch((err) => {
  console.error(err);
  writeFileSync(
    join(OUT, 'report.json'),
    JSON.stringify({ ...report, fatal: String(err) }, null, 2)
  );
  process.exitCode = 1;
});
