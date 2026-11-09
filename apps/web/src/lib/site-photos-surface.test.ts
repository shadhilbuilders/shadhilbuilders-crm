// @vitest-environment node
// Guard: every Tailwind utility the site state surface names must be backed by
// a theme mapping in globals.css, otherwise it silently renders as nothing.
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

import { unitPhotoStateSurface } from './site-photos';

const css = readFileSync(resolve(__dirname, '../styles/globals.css'), 'utf8');
const STATES = ['none', 'today', 'week', 'stale'] as const;

describe('unitPhotoStateSurface theme coverage', () => {
  it('only uses colours that globals.css maps (or the library defines)', () => {
    const mapped = [...css.matchAll(/--color-([\w-]+):/g)].map((m) => m[1]);
    for (const state of STATES) {
      const surface = unitPhotoStateSurface(state);
      expect(surface.length).toBeGreaterThan(0);
      for (const token of surface.split(/\s+/)) {
        const name = token.replace(/^(bg|text)-/, '');
        if (!/^(muted-soft|[a-z]+-soft-fg)$/.test(name)) continue;
        expect(mapped, `${token} has no --color-${name} mapping`).toContain(name);
      }
    }
  });

  it('maps the five tokens the site surface depends on', () => {
    for (const n of ['muted-soft', 'success-soft-fg', 'warning-soft-fg', 'destructive-soft-fg', 'info-soft-fg']) {
      expect(css).toContain(`--color-${n}: var(--${n})`);
    }
  });
});
