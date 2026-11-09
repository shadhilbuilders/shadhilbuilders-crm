// Design-review evidence collector (2026-11-08).
//
// Drives the real app in Chromium and writes everything /design-review needs:
// first-impression screenshots, an inferred design system, per-page responsive
// captures, console errors, touch-target sizes, interaction-state probes, and
// the rendered DOM dumps the impeccable engine scans.
//
// Aside is unavailable on this machine and gstack's own browse daemon will not
// start under WSL, so this is the driver. Same evidence, different tool.
//
// EVERY navigation waits for `commit`, never `domcontentloaded`: authenticated
// pages hold an SSE stream (`/api/sse/notifications`) open, so the document
// never finishes loading. `domcontentloaded` times out at 60s on /notifications
// and reads as a broken page. Same trap the e2e helpers document.
//
//   node src/test/e2e/design-review.collect.mjs
//
// Writes to $REPORT_DIR (exported by the caller) and prints a summary.
import { chromium } from '@playwright/test';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const WEB = 'http://localhost:3000';
const OUT = process.env.REPORT_DIR ?? '/tmp/design-review';
const RUN_ID = process.env.RUN_ID ?? String(Date.now());

// NO credentials in source (security rule: never hardcode secrets). Passwords
// come from the environment; the emails are not secrets but the passwords are.
//   AUDIT_ENGINEER_PASSWORD / AUDIT_MANAGER_PASSWORD / AUDIT_DEMO_PASSWORD
const who = (key, email) => {
  const password = process.env[`AUDIT_${key}_PASSWORD`];
  if (!password) {
    throw new Error(
      `Set AUDIT_${key}_PASSWORD. The seeded accounts use the documented seed ` +
        'placeholders (packages/database/src/seed.ts FALLBACK_PASSWORD); they are ' +
        'rotated on first login in any real deployment, so they are not defaults here.',
    );
  }
  return { email, password };
};

const ENGINEER = who('ENGINEER', 'engineer@shadhilbuilders.in');
const MANAGER = who('MANAGER', 'manager@shadhilbuilders.in');
const DEMO = who('DEMO', 'demo@shadhilbuilders.in');

const ORG = 'shadhil-builders';
const PROJ = 'shadhil-metro-heights';
const UNIT_WITH_PHOTOS = 'cmu55o06l000syju87ajx0usz';
const UNIT_EMPTY = 'cmu55o059000fyju8wvcaj7ch';

const PAGES = [
  {
    slug: 'site-home',
    path: `/${ORG}/projects/${PROJ}/site`,
    who: ENGINEER,
    ready: '[data-qa="site-unit-row"]',
    note: 'NEW: engineer home',
  },
  {
    slug: 'site-capture',
    path: `/${ORG}/projects/${PROJ}/site/${UNIT_WITH_PHOTOS}`,
    who: ENGINEER,
    ready: '[data-qa="site-take-photo"]',
    note: 'NEW: capture screen',
  },
  {
    slug: 'site-capture-empty',
    path: `/${ORG}/projects/${PROJ}/site/${UNIT_EMPTY}`,
    who: ENGINEER,
    ready: '[data-qa="progress-empty"]',
    note: 'NEW: first-photo state',
  },
  {
    // The demo OWNER lives in the `demo` org (project: demo-villas). Pointing it
    // at shadhil-builders 404s, which is correct - a tenant cannot read another
    // tenant's project.
    slug: 'inventory',
    path: '/demo/projects/demo-villas/inventory',
    who: DEMO,
    ready: '[data-qa="data-table-row"]',
    note: 'existing sales grid (unchanged by this branch)',
  },
  {
    slug: 'notifications',
    path: `/${ORG}/projects/${PROJ}/notifications`,
    who: MANAGER,
    ready: '[data-qa="notifications-filter-site"]',
    note: 'CHANGED: Site filter + type labels',
  },
];

const result = { system: null, pages: [], shots: [], notes: [] };

const HOOK = `(() => {
  window.__gstackErrs = [];
  const oe = console.error;
  console.error = (...a) => { window.__gstackErrs.push(a.map(String).join(' ')); oe.apply(console, a); };
  window.addEventListener('error', (e) => window.__gstackErrs.push('uncaught: ' + e.message));
  window.addEventListener('unhandledrejection', (e) => window.__gstackErrs.push('unhandledrejection: ' + ((e.reason && e.reason.message) || e.reason)));
})()`;

/**
 * One session per role, saved to disk and reused.
 *
 * Signing in per CONTEXT looked fine and then timed out: `next dev` compiles a
 * route on first hit, and a dozen simultaneous better-auth POSTs against a busy
 * Turbopack server trip the 30s request timeout. One sign-in per role, then
 * `storageState` for every context that role needs.
 */
const AUTH_DIR = join(OUT, '.auth');

async function storageStateFor(browser, who) {
  mkdirSync(AUTH_DIR, { recursive: true });
  const file = join(AUTH_DIR, `${who.email.split('@')[0]}.json`);
  if (existsSync(file)) return file;

  const context = await browser.newContext({ navigationTimeout: 180_000 });
  const res = await context.request.post(`${WEB}/api/auth/sign-in/email`, {
    data: { email: who.email, password: who.password },
    headers: { 'content-type': 'application/json' },
    timeout: 120_000,
  });
  if (!res.ok()) throw new Error(`sign-in failed ${who.email}: ${res.status()}`);
  const cookies = await context.cookies();
  if (!cookies.some((c) => c.name.endsWith('better-auth.session_token'))) {
    throw new Error(`no session cookie after sign-in for ${who.email}`);
  }
  await context.storageState({ path: file });
  await context.close();
  return file;
}

async function newContext(
  browser,
  { viewport, colorScheme = 'light', reducedMotion = 'no-preference', who, authFile },
) {
  const context = await browser.newContext({
    viewport,
    colorScheme,
    reducedMotion,
    storageState: authFile ?? (await storageStateFor(browser, who)),
    navigationTimeout: 180_000,
  });
  await context.addInitScript(() => {
    // A returning user has already dismissed the push prompt and picked a theme.
    localStorage.setItem('shadhil:push-prompt-dismissed', 'v1');
    localStorage.setItem(
      'theme',
      window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light',
    );
  });
  const page = await context.newPage();
  page.setDefaultTimeout(90_000);
  return { context, page };
}

/** Prime Turbopack so the first audited load is not a compile. */
async function warmRoutes(browser) {
  const WARM = [
    [ENGINEER, `${ORG}/projects/${PROJ}`, ['/site', `/site/${UNIT_WITH_PHOTOS}`, `/site/${UNIT_EMPTY}`]],
    [DEMO, 'demo/projects/demo-villas', ['/inventory']],
    [MANAGER, `${ORG}/projects/${PROJ}`, ['/notifications']],
  ];
  for (const [who, prefix, routes] of WARM) {
    const { context, page } = await newContext(browser, {
      viewport: { width: 1440, height: 900 },
      who,
    });
    for (const route of routes) {
      const url = `${WEB}/${prefix}${route}`;
      const t = Date.now();
      try {
        await page.goto(url, { waitUntil: 'commit', timeout: 240_000 });
        await page.waitForTimeout(800);
        console.log(`WARM ${route} ${Date.now() - t}ms`);
      } catch (err) {
        console.log(`WARM_FAIL ${route} ${String(err).slice(0, 90)}`);
      }
    }
    await context.close();
  }
}

/** Everything the audit needs from one loaded page, in one evaluate. */
async function probe(page) {
  return page.evaluate(() => {
    const css = (el, prop) => (el === null ? null : getComputedStyle(el).getPropertyValue(prop));
    const all = [...document.querySelectorAll('*')].slice(0, 600);
    const fonts = [...new Set(all.map((e) => css(e, 'font-family')))];
    const colors = [
      ...new Set(
        all
          .flatMap((e) => [css(e, 'color'), css(e, 'background-color')])
          .filter((c) => c && c !== 'rgba(0, 0, 0, 0)'),
      ),
    ];
    const headings = [...document.querySelectorAll('h1,h2,h3,h4,h5,h6')].map((h) => ({
      tag: h.tagName,
      text: (h.textContent || '').trim().slice(0, 60),
      size: css(h, 'font-size'),
      weight: css(h, 'font-weight'),
      lineHeight: css(h, 'line-height'),
      textWrap: css(h, 'text-wrap'),
    }));
    const targets = [...document.querySelectorAll('a,button,input[type=file],textarea,[role=button]')]
      .map((e) => {
        const r = e.getBoundingClientRect();
        if (r.width === 0 && r.height === 0) return null;
        return {
          tag: e.tagName,
          qa: e.getAttribute('data-qa') ?? null,
          label: (e.getAttribute('aria-label') || (e.textContent || '').trim()).slice(0, 40),
          w: Math.round(r.width),
          h: Math.round(r.height),
          hiddenInput: e.tagName === 'INPUT' && r.width < 2,
        };
      })
      .filter(Boolean);
    const small = targets.filter((t) => !t.hiddenInput && (t.w < 44 || t.h < 44));
    const noFocusRing = [...document.querySelectorAll('button,a,input,textarea,[role=button]')]
      .filter((e) => {
        const s = getComputedStyle(e);
        return s.outlineStyle === 'none' && s.boxShadow === 'none' && !e.className.includes('focus-visible');
      })
      .map((e) => e.getAttribute('data-qa') || (e.textContent || '').trim().slice(0, 30))
      .slice(0, 12);
    const numeric = [...document.querySelectorAll('[class*="tabular-nums"]')].length;
    const bodyFont = css(document.body, 'font-family');
    const bodySize = css(document.body, 'font-size');
    // Longest paragraph, to check measure (45-75 chars ideal).
    const paras = [...document.querySelectorAll('p')]
      .map((p) => (p.textContent || '').trim())
      .filter((t) => t.length > 40);
    return {
      url: location.href,
      htmlClass: document.documentElement.className,
      colorScheme: css(document.documentElement, 'color-scheme'),
      scrollWidth: document.documentElement.scrollWidth,
      clientWidth: document.documentElement.clientWidth,
      horizontalScroll: document.documentElement.scrollWidth > document.documentElement.clientWidth + 1,
      fonts,
      fontCount: fonts.length,
      colors,
      colorCount: colors.length,
      headings,
      bodyFont,
      bodySize,
      smallTargets: small,
      smallTargetCount: small.length,
      targetCount: targets.filter((t) => !t.hiddenInput).length,
      noFocusRing,
      numeric,
      longestParagraph: paras.sort((a, b) => b.length - a.length)[0]?.length ?? 0,
      selection: css(document.documentElement, '--selection') || null,
      transitionAll: [...document.querySelectorAll('*')]
        .filter((e) => (getComputedStyle(e).transitionProperty || '').includes('all'))
        .length,
      // Visible text, for happy-talk / instruction scanning.
      text: document.body.innerText.replace(/\n{3,}/g, '\n\n').slice(0, 6000),
    };
  });
}

/** The rendered-DOM capture the impeccable engine scans. */
const DOM_DUMP = `(() => {
  const clone = document.documentElement.cloneNode(true);
  for (const el of clone.querySelectorAll('script,template,noscript,iframe,svg defs')) el.remove();
  for (const el of clone.querySelectorAll('input,textarea')) {
    el.removeAttribute('value'); el.removeAttribute('placeholder');
    if (el.tagName === 'TEXTAREA') el.textContent = '';
  }
  for (const el of clone.querySelectorAll('*')) {
    for (const a of [...el.attributes]) {
      if (a.name.startsWith('on')) el.removeAttribute(a.name);
      if (a.value.length > 400) el.setAttribute(a.name, a.value.slice(0, 400));
    }
  }
  // Inline the computed stylesheets so the engine sees the real CSS.
  const css = [...document.styleSheets]
    .map((s) => { try { return [...s.cssRules].map((r) => r.cssText).join('\\n'); } catch { return ''; } })
    .join('\\n');
  const style = document.createElement('style');
  style.setAttribute('data-gstack-dom-css', '');
  style.textContent = css;
  clone.querySelector('head')?.appendChild(style);
  return '<!doctype html>\\n' + clone.outerHTML;
})()`;

async function main() {
  mkdirSync(join(OUT, 'screenshots'), { recursive: true });
  mkdirSync(join(OUT, 'dom', RUN_ID), { recursive: true });
  const browser = await chromium.launch();

  try {
    await warmRoutes(browser);

    // ── First impression (desktop, engineer home) ────────────────────────
    {
      const { context, page } = await newContext(browser, {
        viewport: { width: 1440, height: 900 },
        who: ENGINEER,
      });
      await page.addInitScript(HOOK);
      await page.goto(`${WEB}/${ORG}/projects/${PROJ}/site`, { waitUntil: 'commit' });
      await page.waitForSelector('[data-qa="site-unit-row"]', { timeout: 90_000 });
      await page.waitForTimeout(600);
      await page.screenshot({ path: join(OUT, 'screenshots', 'first-impression.png'), fullPage: true });
      result.shots.push('first-impression.png');
      console.log('FIRST_IMPRESSION_OK URL=' + page.url());
      await context.close();
    }

    // ── Design system extraction + per-page responsive audit ─────────────
    for (const spec of PAGES) {
      const entry = { slug: spec.slug, note: spec.note, views: {} };
      for (const [name, viewport] of [
        ['mobile', { width: 375, height: 812 }],
        ['tablet', { width: 768, height: 1024 }],
        ['desktop', { width: 1440, height: 900 }],
      ]) {
        const { context, page } = await newContext(browser, { viewport, who: spec.who });
        await page.addInitScript(HOOK);
        const t0 = Date.now();
        await page.goto(`${WEB}${spec.path}`, { waitUntil: 'commit' });
        // Wait for THIS page's own content, not just the document: the SSE
        // stream keeps loading forever, and the shell paints before the data.
        await page.waitForSelector(spec.ready, { timeout: 90_000 });
        await page.waitForTimeout(700); // let fonts + images settle
        entry.loadMs = Date.now() - t0;
        const facts = await probe(page);
        entry.views[name] = facts;
        await page.screenshot({
          path: join(OUT, 'screenshots', `${spec.slug}-${name}.png`),
          fullPage: true,
        });
        result.shots.push(`${spec.slug}-${name}.png`);
        if (name === 'desktop') {
          const html = await page.evaluate(DOM_DUMP);
          writeFileSync(join(OUT, 'dom', RUN_ID, `${spec.slug}.dom.html`), html);
          console.log(`DOM_DUMP_OK ${spec.slug} bytes=${html.length}`);
        }
        await context.close();
      }
      const desk = entry.views.desktop;
      result.pages.push(entry);
      console.log(
        `PAGE ${spec.slug} fonts=${desk.fontCount} colors=${desk.colorCount} smallTargets=${desk.smallTargetCount}/${desk.targetCount} hScroll=${desk.horizontalScroll} errors=${JSON.stringify(desk.errors ?? [])}`,
      );
      if (result.system === null) {
        result.system = {
          fonts: desk.fonts,
          colors: desk.colors,
          headings: desk.headings,
          bodyFont: desk.bodyFont,
          bodySize: desk.bodySize,
        };
      }
    }

    // ── Dark mode + reduced motion ───────────────────────────────────────
    for (const [name, opts] of [
      ['dark', { colorScheme: 'dark' }],
      ['reduced-motion', { reducedMotion: 'reduce' }],
    ]) {
      const { context, page } = await newContext(browser, {
        viewport: { width: 390, height: 844 },
        who: ENGINEER,
        ...opts,
      });
      await page.goto(`${WEB}/${ORG}/projects/${PROJ}/site`, { waitUntil: 'commit' });
      await page.waitForSelector('[data-qa="site-unit-row"]', { timeout: 90_000 });
      await page.waitForTimeout(600);
      await page.screenshot({ path: join(OUT, 'screenshots', `site-home-${name}.png`), fullPage: true });
      result.shots.push(`site-home-${name}.png`);
      const facts = await probe(page);
      result.notes.push({
        variant: name,
        htmlClass: facts.htmlClass,
        colorScheme: facts.colorScheme,
        colors: facts.colorCount,
      });
      // Reduced motion: no transform/opacity transitions should linger.
      const motion = await page.evaluate(() => {
        const el = document.querySelector('[data-qa="progress-empty"], [data-qa="site-unit-row"]');
        return el === null ? null : getComputedStyle(el).transitionDuration;
      });
      result.notes.push({ variant: name, motionDuration: motion });
      await context.close();
    }

    // ── Interaction states: hover / focus-visible / active ───────────────
    {
      const { context, page } = await newContext(browser, {
        viewport: { width: 1440, height: 900 },
        who: ENGINEER,
      });
      await page.goto(`${WEB}/${ORG}/projects/${PROJ}/site/${UNIT_WITH_PHOTOS}`, {
        waitUntil: 'commit',
      });
      await page.waitForSelector('[data-qa="site-take-photo"]', { timeout: 90_000 });
      const take = page.locator('[data-qa="site-take-photo"]');
      const rest = await take.evaluate((e) => getComputedStyle(e).backgroundColor);
      await take.hover();
      await page.waitForTimeout(250);
      const hover = await take.evaluate((e) => getComputedStyle(e).backgroundColor);
      // Keyboard focus ring on the back button (the first focusable control).
      await page.keyboard.press('Tab');
      const focused = await page.evaluate(() => {
        const el = document.activeElement;
        if (el === null) return null;
        const s = getComputedStyle(el);
        return {
          qa: el.getAttribute('data-qa'),
          outline: s.outlineStyle + ' ' + s.outlineWidth,
          boxShadow: s.boxShadow,
        };
      });
      await page.screenshot({ path: join(OUT, 'screenshots', 'capture-focus-ring.png') });
      result.shots.push('capture-focus-ring.png');
      result.notes.push({ interaction: 'primary-hover', rest, hover, changed: rest !== hover });
      result.notes.push({ interaction: 'keyboard-focus', focused });

      // Empty state: is the whole panel a real drop target?
      await page.goto(`${WEB}/${ORG}/projects/${PROJ}/site/${UNIT_EMPTY}`, {
        waitUntil: 'commit',
      });
      await page.waitForSelector('[data-qa="progress-empty"]', { timeout: 90_000 });
      const dropzone = await page.evaluate(() => {
        const dz = document.querySelector('[data-qa="site-file-dropzone"]');
        return dz === null
          ? null
          : {
              role: dz.getAttribute('role'),
              tabindex: dz.getAttribute('tabindex'),
              borderStyle: getComputedStyle(dz).borderStyle,
              borderWidth: getComputedStyle(dz).borderWidth,
            };
      });
      result.notes.push({ emptyStateDropzone: dropzone });
      await page.screenshot({ path: join(OUT, 'screenshots', 'capture-empty.png'), fullPage: true });
      result.shots.push('capture-empty.png');
      await context.close();
    }

    // ── Console errors per page (the probe above did not capture them) ────
    for (const spec of PAGES) {
      const { context, page } = await newContext(browser, {
        viewport: { width: 1440, height: 900 },
        who: spec.who,
      });
      const errs = [];
      page.on('console', (m) => {
        if (m.type() === 'error') errs.push(m.text().slice(0, 300));
      });
      page.on('pageerror', (e) => errs.push('pageerror: ' + e.message.slice(0, 300)));
      await page.goto(`${WEB}${spec.path}`, { waitUntil: 'commit' });
      await page.waitForTimeout(4000);
      const found = result.pages.find((p) => p.slug === spec.slug);
      if (found !== undefined) found.consoleErrors = errs;
      console.log(`CONSOLE ${spec.slug} errors=${errs.length}`);
      await context.close();
    }
  } finally {
    await browser.close();
    writeFileSync(join(OUT, 'evidence.json'), JSON.stringify(result, null, 2));
    console.log('\nEVIDENCE=' + join(OUT, 'evidence.json'));
    console.log('SHOTS=' + result.shots.length);
  }
}

main().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});
