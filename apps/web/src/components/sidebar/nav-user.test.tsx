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
import { afterEach, describe, expect, it } from 'vitest';

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
});
