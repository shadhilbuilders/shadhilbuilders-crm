// NavUser - the sidebar footer account menu (sidebar-07 pattern).
//
// 2026-11-09 (owner decision): entering the admin namespace moved OUT of the
// sidebar's Work group and INTO the account menus, as a "Switch Admin" row
// ABOVE Settings - in this menu and in the topbar's UserMenu. The rules worth
// pinning are the ones a future edit would silently break:
//   1. the label is literally "Switch Admin" (owner copy, not "Admin");
//   2. it renders ABOVE Settings - it is a mode switch, not one more action;
//   3. `adminHref: null` HIDES it (non-admin role, unresolved org slug, or
//      already inside /admin/*). A disabled "Switch Admin" row for a
//      telecaller would advertise a namespace the API answers 403 for.
//   4. Settings + Sign out are untouched by this change.
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// 2026-11-24: the footer reads the photo from the user-detail query. Both hooks
// are mocked so this suite keeps pinning the MENU, not the network: a real
// useSession would need an auth client and a QueryClientProvider that the shell
// supplies and this harness deliberately does not.
const mocks = vi.hoisted(() => ({
  useSessionUser: vi.fn(),
  useUser: vi.fn(),
}));

vi.mock('@/lib/session', () => ({ useSessionUser: mocks.useSessionUser }));
vi.mock('@/hooks/queries/users', () => ({ useUser: mocks.useUser }));

// Radix's Avatar.Image renders its <img> only after the image LOADS, and jsdom
// never loads one - so a real Avatar would hide the thing under test here. This
// double echoes the props the footer passes it (src + fallback), which is
// exactly the contract this suite can honestly pin.
vi.mock('@paalstack/react-ui', async () => {
  const actual = await vi.importActual<Record<string, unknown>>('@paalstack/react-ui');
  const react = await import('react');
  return {
    ...actual,
    Avatar: (props: { src?: string; fallback?: unknown }) =>
      react.createElement(
        'span',
        { 'data-qa': 'avatar-double', 'data-src': props.src ?? '' },
        props.fallback as never,
      ),
  };
});

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

import { SidebarProvider } from '@paalstack/react-ui';

import { NavUser } from './nav-user';

// jsdom does not implement `window.matchMedia`; `SidebarProvider` calls it via
// useMediaQuery inside an effect. Same stub as lib/use-nav-sync.test.tsx.
Object.defineProperty(window, 'matchMedia', {
  writable: true,
  value: (query: string) => ({
    matches: false,
    media: query,
    onchange: null,
    addListener: () => undefined,
    removeListener: () => undefined,
    addEventListener: () => undefined,
    removeEventListener: () => undefined,
    dispatchEvent: () => false,
  }),
});

let container: HTMLDivElement | null = null;
let root: Root | null = null;

/**
 * Mount + open the menu. The dropdown content is portaled to <body>, so
 * assertions query `document`, not `container`.
 */
async function mountOpen(props: {
  settingsHref?: string | null;
  adminHref?: string | null;
  employeeHref?: string | null;
}): Promise<void> {
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
  await act(async () => {
    root?.render(
      // SidebarMenuButton reads the sidebar context, so the menu needs the
      // provider it always has in the real shell.
      <SidebarProvider>
        <NavUser
          name="Deepak Owner"
          email="owner@x.in"
          role="OWNER"
          settingsHref={
            props.settingsHref === undefined ? '/shadhil-builders/settings' : props.settingsHref
          }
          employeeHref={props.employeeHref ?? null}
          adminHref={props.adminHref === undefined ? '/shadhil-builders/admin' : props.adminHref}
          onSignOut={() => {}}
        />
      </SidebarProvider>,
    );
  });
  const trigger = document.querySelector('[data-qa="sidebar-user-trigger"]');
  expect(trigger).not.toBeNull();
  await act(async () => {
    (trigger as HTMLElement).click();
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

beforeEach(() => {
  mocks.useSessionUser.mockReturnValue({
    user: { id: 'u-1', name: 'Deepak Owner', email: 'owner@x.in', role: 'OWNER' },
    isPending: false,
    refetchSession: async () => undefined,
  });
  mocks.useUser.mockReturnValue({ data: { imageUrl: null } });
});

afterEach(async () => {
  await unmount();
});

const qa = (value: string): HTMLElement | null => document.querySelector(`[data-qa="${value}"]`);

describe('NavUser account menu', () => {
  it('shows "Switch Admin" as a link to the org-scoped admin namespace', async () => {
    await mountOpen({});
    const row = qa('sidebar-user-admin');
    expect(row).not.toBeNull();
    expect(row?.textContent).toContain('Switch Admin');
    expect(row?.closest('a')?.getAttribute('href')).toBe('/shadhil-builders/admin');
  });

  it('renders "Switch Admin" ABOVE Settings', async () => {
    await mountOpen({});
    const admin = qa('sidebar-user-admin');
    const settings = qa('sidebar-user-settings');
    expect(admin).not.toBeNull();
    expect(settings).not.toBeNull();
    // DOCUMENT_POSITION_FOLLOWING = settings comes AFTER admin in the DOM.
    expect(
      admin!.compareDocumentPosition(settings!) & Node.DOCUMENT_POSITION_FOLLOWING,
    ).toBeTruthy();
  });

  it('hides "Switch Admin" when the caller resolves no admin href', async () => {
    // Non-admin role, unresolved org slug, or already on /admin/* - the
    // topbar and footer share ONE gate, so both hide it at the same time.
    await mountOpen({ adminHref: null });
    expect(qa('sidebar-user-admin')).toBeNull();
    // Settings must still be there - the hide is per-row, not a blank menu.
    expect(qa('sidebar-user-settings')).not.toBeNull();
  });

  it('shows "Switch Employee" above Settings when an employee href is resolved', async () => {
    await mountOpen({ adminHref: null, employeeHref: '/shadhil-builders/projects/p/dashboard' });
    const row = qa('sidebar-user-employee');
    expect(row?.textContent).toContain('Switch Employee');
    expect(
      row!.compareDocumentPosition(qa('sidebar-user-settings')!) & Node.DOCUMENT_POSITION_FOLLOWING,
    ).toBeTruthy();
  });

  it('hides "Switch Employee" by default', async () => {
    await mountOpen({});
    expect(qa('sidebar-user-employee')).toBeNull();
  });

  it('keeps Settings and Sign out in place', async () => {
    await mountOpen({});
    expect(qa('sidebar-user-settings')?.textContent).toContain('Settings');
    expect(qa('sidebar-user-signout')?.textContent).toContain('Sign out');
  });

  // ---------------------------------------------------------------------
  // Close-on-select. The popup is portalled to <body>, so it is not inside
  // the page tree: a menu that stays open after a row navigates sits on top
  // of the NEXT page until dismissed. Base UI closes it for us, but that is
  // a library default, not a guarantee this component states - so pin it.
  // ---------------------------------------------------------------------
  it('closes the menu when a link row is chosen', async () => {
    await mountOpen({});
    expect(qa('sidebar-user-settings')).not.toBeNull();
    await act(async () => {
      qa('sidebar-user-settings')!.click();
    });
    expect(qa('sidebar-user-settings')).toBeNull();
  });

  it('closes the menu when "Switch Admin" is chosen', async () => {
    await mountOpen({});
    await act(async () => {
      qa('sidebar-user-admin')!.click();
    });
    expect(qa('sidebar-user-admin')).toBeNull();
  });

  it('fires onSignOut and closes the menu', async () => {
    let signedOut = 0;
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
    await act(async () => {
      root?.render(
        <SidebarProvider>
          <NavUser
            name="Deepak Owner"
            email="owner@x.in"
            role="OWNER"
            settingsHref="/shadhil-builders/settings"
            adminHref={null}
            onSignOut={() => {
              signedOut += 1;
            }}
          />
        </SidebarProvider>,
      );
    });
    await act(async () => {
      (document.querySelector('[data-qa="sidebar-user-trigger"]') as HTMLElement).click();
    });
    await act(async () => {
      qa('sidebar-user-signout')!.click();
    });
    expect(signedOut).toBe(1);
    expect(qa('sidebar-user-signout')).toBeNull();
  });

  // ---------------------------------------------------------------------
  // Trigger open state + accessible name.
  // The open-state variant used to be `data-[state=open]:...`, the Radix
  // spelling. Base UI's Menu.Trigger emits `data-popup-open` (there is no
  // data-state at all), so those classes never applied and the trigger gave
  // no "menu is open" affordance. Assert against the LIVE node so a future
  // library swap that renames the attribute fails here instead of silently
  // going flat again.
  // ---------------------------------------------------------------------
  it('styles the trigger open state from the attribute Base UI actually sets', async () => {
    await mountOpen({});
    const trigger = document.querySelector('[data-qa="sidebar-user-trigger"]') as HTMLElement;
    expect(trigger).not.toBeNull();
    expect(trigger.matches('[data-popup-open]'), 'trigger is not marked open').toBe(true);
    // The class list must key off that same attribute. (Don't assert the
    // ABSENCE of `data-[state=open]`: the library's own sidebarMenuButton
    // base string ships that Radix spelling, so it is present regardless.)
    expect(trigger.className).toContain('data-popup-open:bg-sidebar-accent-normal');
    expect(trigger.className).toContain('data-popup-open:text-sidebar-accent-normal-foreground');
  });

  it('names the trigger after the signed-in user', async () => {
    await mountOpen({});
    const trigger = document.querySelector('[data-qa="sidebar-user-trigger"]');
    expect(trigger?.getAttribute('aria-label')).toBe('Account menu for Deepak Owner');
  });

  it('feeds the uploaded photo to the footer avatar', async () => {
    mocks.useUser.mockReturnValue({ data: { imageUrl: 'https://cdn.test/org/abc/face.webp' } });
    await mountOpen({});

    const avatar = qa('sidebar-user-trigger')?.querySelector('[data-qa="avatar-double"]');
    expect(avatar?.getAttribute('data-src')).toBe('https://cdn.test/org/abc/face.webp');
  });

  it('falls back to initials when the account has no photo', async () => {
    await mountOpen({});

    const trigger = qa('sidebar-user-trigger');
    // No src is handed to the avatar...
    expect(trigger?.querySelector('[data-qa="avatar-double"]')?.getAttribute('data-src')).toBe('');
    // ...and the initials ARE what shows.
    expect(trigger?.textContent).toContain('DO');
  });
});
