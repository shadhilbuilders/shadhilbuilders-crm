// InventoryRouteGate (2026-11-08): `/inventory` is CLOSED to site-only roles.
//
// protects= an ENGINEER hitting the segment (shared link, bookmark, or the plot
//           map's `/inventory?unit=<id>` villa link) gets a block panel naming
//           their own surface and a link to `/site` - and the page's children
//           NEVER render, so `useInventoryUnits` never fires and no rupee value
//           is requested from the API at all;
// fails_when= the gate redirects instead of blocking (a redirect still mounts
//           the grid for a tick and lets the queries run), the gate swallows
//           TELECALLER (a site role that reads the grid for the lead job),
//           children render for ENGINEER, the block has no way out, or the
//           panel paints before the session resolves (a hydration mismatch, and
//           a flash of "blocked" for a legitimate admin);
// no_claim= not a server-side authorization boundary. The API and RLS remain
//           the wall; this is the client surface refusing to even ask.
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const mocks = vi.hoisted(() => ({
  useSessionUser: vi.fn(),
  // Counts how often a child body is actually rendered. The whole point of the
  // gate is that this stays 0 for a blocked role.
  childRenders: vi.fn(),
}));

vi.mock('@/lib/session', () => ({
  useSessionUser: mocks.useSessionUser,
  isSiteOnlyRole: (role: string | undefined) => role === 'ENGINEER',
}));

vi.mock('@/lib/tenant-context', () => ({
  useOrgSlug: () => 'shadhil-builders',
  useProjectSlug: () => 'metro-heights',
}));

vi.mock('next/link', () => ({
  default: ({ children, href }: { children: React.ReactNode; href: string }) => (
    <a href={href}>{children}</a>
  ),
}));

import { InventoryRouteGate } from './InventoryRouteGate';

/** Stands in for `<InventoryGrid>` - the thing that must never mount. */
function Child() {
  mocks.childRenders();
  return (
    <div data-qa="inventory-child">
      <span>Per sq.ft price</span>
    </div>
  );
}

let container: HTMLDivElement | null = null;
let root: Root | null = null;

async function mount(): Promise<string> {
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
  await act(async () => {
    root?.render(
      <InventoryRouteGate>
        <Child />
      </InventoryRouteGate>,
    );
  });
  return container.innerHTML;
}

function mockSession(role: string | undefined, isPending = false): void {
  mocks.useSessionUser.mockReturnValue({
    user:
      role === undefined ? null : { id: 'u-1', name: 'Actor', email: 'a@x', role, teamId: null },
    isPending,
    error: null,
  });
}

beforeEach(() => {
  mocks.childRenders.mockClear();
});

afterEach(async () => {
  await act(async () => {
    root?.unmount();
  });
  root = null;
  container?.remove();
  container = null;
  mocks.useSessionUser.mockReset();
});

describe('InventoryRouteGate - the grid is closed to ENGINEER', () => {
  it('blocks an ENGINEER and never renders the grid', async () => {
    mockSession('ENGINEER');
    const html = await mount();

    expect(html).toContain('data-qa="inventory-blocked"');
    expect(mocks.childRenders).not.toHaveBeenCalled();
    // The money column proves the child (and therefore its queries) never ran.
    expect(html).not.toContain('Per sq.ft price');
  });

  it('tells the engineer which screen IS theirs, and links to it', async () => {
    mockSession('ENGINEER');
    const html = await mount();

    // "Not available" with no way out is a dead end; the copy names the job and
    // the button opens the surface that role actually works in.
    expect(html).toContain('Inventory is not part of your work');
    expect(html).toContain('href="/shadhil-builders/projects/metro-heights/site"');
    expect(html).toContain('Go to Site updates');
  });

  it.each(['TELECALLER', 'ADMIN', 'OWNER', 'MANAGER', 'SALES_EXEC'])(
    'lets %s through to the grid',
    async (role) => {
      // TELECALLER is the case that matters: a SITE role, but not site-only -
      // they read inventory (money columns hidden) as part of the lead job, so
      // a blanket `isSiteRole` block would break their work.
      mockSession(role);
      const html = await mount();

      expect(html).toContain('data-qa="inventory-child"');
      expect(html).not.toContain('data-qa="inventory-blocked"');
      expect(mocks.childRenders).toHaveBeenCalled();
    },
  );
});

describe('InventoryRouteGate - never blocks on an unresolved session', () => {
  it('renders a skeleton, not the block panel, while the session is pending', async () => {
    // Better-auth reports isPending during SSR. A block painted from an unknown
    // role is both a hydration mismatch and a lie shown to a legitimate admin.
    mockSession(undefined, true);
    const html = await mount();

    expect(html).not.toContain('data-qa="inventory-blocked"');
    expect(mocks.childRenders).not.toHaveBeenCalled();
  });

  it('renders a skeleton, not the block panel, before mount', async () => {
    // The gate's `mounted` flag only flips in useEffect; this asserts the
    // pre-effect frame is inert rather than blocked.
    mockSession(undefined);
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
    // Deliberately NOT wrapped in act: this is the server/first-paint frame.
    root.render(
      <InventoryRouteGate>
        <Child />
      </InventoryRouteGate>,
    );

    expect(container.innerHTML).not.toContain('data-qa="inventory-blocked"');
    await act(async () => {
      root?.unmount();
    });
    root = null;
    container.remove();
    container = null;
  });

  it('renders the grid for a signed-out edge case rather than a false block', async () => {
    // user === null is "no session", not "wrong role". The auth guard owns that
    // case; this gate must not invent a permission decision for it.
    mockSession(undefined);
    const html = await mount();
    expect(html).not.toContain('data-qa="inventory-blocked"');
  });
});
