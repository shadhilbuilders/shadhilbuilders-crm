// Regression test — useNavSync Rules-of-Hooks crash (T37 follow-up).
//
// The original implementation called `useSidebar()` INSIDE the `useEffect`
// callback in `lib/nav.ts`. Hooks are only valid during render, so React
// threw "Invalid hook call" in dev and the entire (app) layout crashed
// after login (see the KNOWN GAP note in src/test/e2e/demo-flow.spec.ts).
//
// `renderToStaticMarkup` is deliberately NOT used here: it never runs
// effects, so it would PASS against the broken implementation and this
// test would guard nothing. The tree must be MOUNTED with effects enabled
// (createRoot + act) — exactly the environment that exposed the bug.
//
// Mirror the production mount shape: `useNavSync()` mounted exactly once
// inside `SidebarProvider`, as `(app)/layout.tsx` → `AppShell` does.
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, describe, expect, it, vi } from 'vitest';

vi.mock('next/navigation', () => ({
  usePathname: vi.fn(() => '/leads'),
}));

import { SidebarProvider } from '@paalstack/react-ui';
import { useNavSync } from '@/lib/nav';

// `globalThis.IS_REACT_ACT_ENVIRONMENT` tells React this is a test env so
// `act` works with a raw createRoot (no @testing-library/react in this app).
(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT =
  true;

function NavSyncProbe(): null {
  useNavSync();
  return null;
}

let container: HTMLDivElement | null = null;
let root: Root | null = null;

async function mount(pathname: string): Promise<void> {
  const { usePathname } = await import('next/navigation');
  vi.mocked(usePathname).mockReturnValue(pathname);

  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
  await act(async () => {
    root?.render(
      <SidebarProvider>
        <NavSyncProbe />
      </SidebarProvider>,
    );
  });
}

async function unmount(): Promise<void> {
  await act(async () => {
    root?.unmount();
  });
  root = null;
  container?.remove();
  container = null;
}

// jsdom does not implement `window.matchMedia`; `SidebarProvider` calls it
// via useMediaQuery inside an effect. Real browsers all implement it — this
// is a test-env gap only. Stub the minimal API the provider touches.
Object.defineProperty(window, 'matchMedia', {
  writable: true,
  value: (query: string) => ({
    matches: false,
    media: query,
    onchange: null,
    addListener: () => undefined, // deprecated API, kept for safety
    removeListener: () => undefined,
    addEventListener: () => undefined,
    removeEventListener: () => undefined,
    dispatchEvent: () => false,
  }),
});

describe('useNavSync — Rules of Hooks regression guard', () => {
  afterEach(() => {
    vi.clearAllMocks();
  });

  it('mounts inside SidebarProvider without throwing "Invalid hook call"', async () => {
    await mount('/leads');
    expect(container).not.toBeNull();
    await unmount();
  });

  it('re-runs cleanly when the pathname changes (effect deps)', async () => {
    await mount('/leads');
    // Simulate a route change on the SAME root: the mocked usePathname
    // returns a new value, the probe re-renders, and the effect re-runs
    // with fresh deps (`[pathname, setOpenMobile]`).
    const { usePathname } = await import('next/navigation');
    vi.mocked(usePathname).mockReturnValue('/visits');
    await act(async () => {
      root?.render(
        <SidebarProvider>
          <NavSyncProbe />
        </SidebarProvider>,
      );
    });
    await unmount();
  });
});