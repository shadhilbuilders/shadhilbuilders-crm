// Guard: the iOS top-bar safe-area contract (T-SafeArea).
//
// WHY A SOURCE-LEVEL TEST. AppHeader is a client component wired to the session,
// the tenant context and four query hooks, so rendering it in jsdom would take
// about eight mocks and would assert more about the mocks than about the bar.
// What actually broke twice on a real iPhone was the CLASS CONTRACT below, which
// is a property of the source. The repo already pins source-level contracts this
// way (guest-top-bar.test.tsx does it for proxy.ts, an edge module jsdom cannot
// import), and `env(safe-area-inset-*)` is 0 in jsdom, desktop Chrome and
// Playwright alike, so no rendering test can observe any of this.
//
// THE CONTRACT, term by term:
//
//   1. both bars are `sticky top-0`, i.e. at the viewport's physical top, which
//      in an installed iOS PWA is behind the Dynamic Island. Each must reserve
//      `env(safe-area-inset-top)` itself; nothing above it can pad for it.
//   2. the reserved inset must ALSO appear in the box height. box-sizing is
//      border-box, so the inset is otherwise taken OUT of the content band.
//   3. the extra `min(1rem, env(safe-area-inset-top))` term is the breathing room
//      requested from a real device. min() clamps it to 0 where there is no
//      inset, which is what keeps desktop, Android and Safari tabs unchanged.
//      Both halves of that are asserted below, because dropping either the clamp
//      or the term is a silent visual regression on one side or the other.
//   4. the root layout opts in: without `viewportFit: 'cover'` and a
//      black-translucent status bar, `env(safe-area-inset-top)` is always 0 and
//      everything above is dead code on every device.
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const read = (path: string): string => readFileSync(path, 'utf8');

describe('iOS top-bar safe area', () => {
  const header = read('src/components/app-header.tsx');
  const guestBar = read('src/components/guest-top-bar.tsx');
  const layout = read('src/app/layout.tsx');

  it('both bars sit at the viewport top and reserve the inset themselves', () => {
    for (const [name, src] of [
      ['AppHeader', header],
      ['GuestTopBar', guestBar],
    ] as const) {
      expect(src, `${name} is not a viewport-top bar`).toContain('sticky top-0');
      expect(src, `${name} does not reserve the top inset`).toContain(
        'pt-[max(0px,env(safe-area-inset-top))]',
      );
    }
  });

  it('the app header keeps a 4rem band below the inset, plus one clamped rem of air', () => {
    expect(header).toContain(
      'min-h-[calc(4rem+env(safe-area-inset-top)+min(1rem,env(safe-area-inset-top)))]',
    );
  });

  it('the guest bar carries the same clamp in its own units', () => {
    expect(guestBar).toContain('h-[calc(4.75rem+min(0.25rem,env(safe-area-inset-top)))]');
  });

  it('the inset is in the HEIGHT of both bars, not only in their padding', () => {
    // The regression this line exists for: a min-height/height that ignores the
    // inset lets it eat the band, which is what put the controls flush against
    // the cutout and the border.
    for (const [name, src] of [
      ['AppHeader', header],
      ['GuestTopBar', guestBar],
    ] as const) {
      expect(src, `${name}: the reserved inset never reaches the height`).toMatch(
        /(min-)?h-\[calc\([^\]]*env\(safe-area-inset-top\)[^\]]*\)\]/,
      );
    }
  });

  it('the root layout opts into the inset, or the classes above do nothing', () => {
    expect(layout).toContain("viewportFit: 'cover'");
    expect(layout).toContain("statusBarStyle: 'black-translucent'");
  });
});
