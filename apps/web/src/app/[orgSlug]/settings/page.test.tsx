// Settings page (`/[orgSlug]/settings`) - the org-scoped page available to
// every authenticated role (2026-09-18).
//
// What this pins, and why each one is a REAL contract rather than coverage
// theatre:
//
//   1. EVERY role reaches it. The page sits outside /admin on purpose; if
//      someone "helpfully" moves it under the admin namespace, staff lose
//      access. Asserted with a TELECALLER user (the lowest-privilege role).
//   2. The name field posts to the SELF endpoint and then refetches the
//      session. Without the refetch the sidebar keeps the stale name - that
//      was the specific bug this wiring exists to prevent.
//   3. Honest state: the fields the owner RULED read-only (email, org name,
//      org slug) render read-only rather than as editable-looking inputs.
//   4. No fake notification controls. Quiet hours / per-trigger toggles are
//      deferred to v1.1 and have no backend, so the section must explain the
//      real behaviour and must NOT render dead switches.
//   5. Push state is reported truthfully per branch (unsupported / blocked /
//      enabled / available) - the Enable button only appears where it can work.
//
// The page lives outside the provider tree in this harness, so the library's
// theme hook is stubbed (the same reason theme-toggle exports its pure button).
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const mocks = vi.hoisted(() => ({
  useSessionUser: vi.fn(),
  useUpdateProfile: vi.fn(),
  mutate: vi.fn(),
  usePushSubscription: vi.fn(),
  enablePush: vi.fn(),
  useProjects: vi.fn(),
  api: vi.fn(),
  setTheme: vi.fn(),
}));

vi.mock('@/lib/session', () => ({
  useSessionUser: mocks.useSessionUser,
}));

vi.mock('@/hooks/queries/users', () => ({
  useUpdateProfile: mocks.useUpdateProfile,
}));

vi.mock('@/hooks/use-push-subscription', () => ({
  usePushSubscription: mocks.usePushSubscription,
}));

vi.mock('@/hooks/queries', () => ({
  useProjects: mocks.useProjects,
  pickDefaultProject: (projects: Array<{ slug: string; createdAt?: string }>) =>
    projects.length > 0 ? projects[0] : null,
}));

vi.mock('@/apis/client', () => ({
  api: mocks.api,
}));

vi.mock('@/lib/tenant-context', () => ({
  useOrgSlug: () => 'shadhil-builders',
  useOrg: () => ({ id: 'org-1', slug: 'shadhil-builders', name: 'Shadhil Builders' }),
}));

// Partial mock: keep the real component exports (Card, Form, Input, ...) and
// stub ONLY the theme hook, which needs a provider this harness does not mount.
vi.mock('@paalstack/react-ui', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@paalstack/react-ui')>();
  return {
    ...actual,
    useNextTheme: () => ({ resolvedTheme: 'light', setTheme: mocks.setTheme }),
  };
});

import SettingsPage from './page';

let container: HTMLDivElement | null = null;
let root: Root | null = null;

async function mount(): Promise<void> {
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
  await act(async () => {
    root?.render(<SettingsPage />);
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

function setNativeValue(input: HTMLInputElement, value: string): void {
  const setter = Object.getOwnPropertyDescriptor(
    window.HTMLInputElement.prototype,
    'value',
  )?.set;
  setter?.call(input, value);
  input.dispatchEvent(new Event('input', { bubbles: true }));
}

const telecaller = {
  id: 'tc-1',
  name: 'Priya Sharma',
  email: 'priya@shadhilbuilders.in',
  role: 'TELECALLER',
  teamId: 'team-a',
  organizationId: 'org-1',
};

/** The push hook's "not yet enabled, but it could be" state. */
const pushAvailable = {
  checked: true,
  isSupported: true,
  isSubscribed: false,
  permission: 'default',
  enablePush: mocks.enablePush,
};

beforeEach(() => {
  mocks.useSessionUser.mockReturnValue({
    user: telecaller,
    isPending: false,
    error: null,
    refetchSession: vi.fn().mockResolvedValue(undefined),
  });
  mocks.useUpdateProfile.mockReturnValue({
    mutate: mocks.mutate,
    isPending: false,
  });
  mocks.usePushSubscription.mockReturnValue(pushAvailable);
  mocks.useProjects.mockReturnValue({
    data: [{ id: 'proj-1', slug: 'metro-heights' }],
  });
  mocks.api.mockResolvedValue({ ok: true, mustChangePassword: false });
});

afterEach(async () => {
  await unmount();
  vi.clearAllMocks();
});

describe('SettingsPage - access', () => {
  it('renders for a TELECALLER (the page is deliberately outside /admin)', async () => {
    await mount();
    const text = document.body.textContent ?? '';
    expect(text).toContain('Settings');
    expect(text).toContain('Profile');
    expect(text).toContain('Password');
    expect(text).toContain('Notifications');
    expect(text).toContain('Organization');
    expect(text).toContain('Appearance');
    expect(text).not.toContain('Not authorized');
  });

  it('shows a skeleton (not a half-filled page) while the session resolves', async () => {
    mocks.useSessionUser.mockReturnValue({
      user: null,
      isPending: true,
      error: null,
      refetchSession: vi.fn(),
    });
    await mount();
    expect(document.body.textContent ?? '').not.toContain('Organization');
  });

  it('offers a way back to sign-in when the session is gone', async () => {
    mocks.useSessionUser.mockReturnValue({
      user: null,
      isPending: false,
      error: null,
      refetchSession: vi.fn(),
    });
    await mount();
    expect(document.body.textContent ?? '').toContain('Session expired');
  });
});

describe('SettingsPage - profile', () => {
  it('prefills the name and shows the email + user id read-only', async () => {
    await mount();
    const name = document.querySelector<HTMLInputElement>(
      '[data-qa="settings-profile-name"]',
    );
    const email = document.querySelector<HTMLInputElement>(
      '[data-qa="settings-profile-email"]',
    );
    expect(name?.value).toBe('Priya Sharma');
    expect(email?.value).toBe('priya@shadhilbuilders.in');
    // Read-only, not merely styled to look so.
    expect(email?.readOnly).toBe(true);
    expect(email?.hasAttribute('readonly')).toBe(true);
  });

  it('posts the name to the SELF endpoint and refetches the session', async () => {
    const refetchSession = vi.fn().mockResolvedValue(undefined);
    mocks.useSessionUser.mockReturnValue({
      user: telecaller,
      isPending: false,
      error: null,
      refetchSession,
    });
    // Drive the mutation's onSuccess the way react-query does.
    mocks.mutate.mockImplementation(
      (vars: { name: string }, opts: { onSuccess?: (r: unknown) => Promise<void> }) => {
        void opts.onSuccess?.({ id: 'tc-1', name: vars.name, email: telecaller.email, role: 'TELECALLER' });
      },
    );

    await mount();
    const input = document.querySelector<HTMLInputElement>(
      '[data-qa="settings-profile-name"]',
    )!;
    await act(async () => {
      setNativeValue(input, 'Priya S.');
    });
    const save = document.querySelector<HTMLButtonElement>(
      '[data-qa="settings-profile-save"]',
    )!;
    await act(async () => {
      save.click();
    });

    expect(mocks.mutate).toHaveBeenCalledTimes(1);
    const [vars] = mocks.mutate.mock.calls[0] as [{ name: string }];
    expect(vars.name).toBe('Priya S.');
    // No id is ever sent - the backend resolves the target from the JWT.
    expect(vars).not.toHaveProperty('id');
    // Without this the sidebar/topbar keep the old name until a hard reload.
    expect(refetchSession).toHaveBeenCalledTimes(1);
  });

  it('does not submit an empty name (the server would 400)', async () => {
    await mount();
    const input = document.querySelector<HTMLInputElement>(
      '[data-qa="settings-profile-name"]',
    )!;
    await act(async () => {
      setNativeValue(input, '   ');
    });
    const save = document.querySelector<HTMLButtonElement>(
      '[data-qa="settings-profile-save"]',
    )!;
    await act(async () => {
      save.click();
    });
    expect(mocks.mutate).not.toHaveBeenCalled();
  });
});

describe('SettingsPage - organization is read-only by ruling', () => {
  it('renders org name, slug and the FRIENDLY role, all read-only', async () => {
    await mount();
    const name = document.querySelector<HTMLInputElement>('[data-qa="settings-org-name"]');
    const slug = document.querySelector<HTMLInputElement>('[data-qa="settings-org-slug"]');
    const role = document.querySelector<HTMLInputElement>('[data-qa="settings-role"]');

    expect(name?.value).toBe('Shadhil Builders');
    expect(slug?.value).toBe('/shadhil-builders');
    // "Telecaller", never the raw enum.
    expect(role?.value).toBe('Telecaller');
    expect(role?.value).not.toBe('TELECALLER');

    for (const field of [name, slug, role]) {
      expect(field?.readOnly).toBe(true);
    }
  });

  it('states why the org identity cannot be edited (no dead save button)', async () => {
    await mount();
    const text = document.body.textContent ?? '';
    expect(text).toContain('cannot be edited yet');
    // There is no org-save affordance at all.
    expect(document.querySelector('[data-qa="settings-org-save"]')).toBeNull();
  });
});

describe('SettingsPage - notifications tells the truth', () => {
  it('offers Enable only when push is actually available', async () => {
    await mount();
    const badge = document.querySelector('[data-push-state]');
    expect(badge?.getAttribute('data-push-state')).toBe('available');
    expect(document.querySelector('[data-qa="settings-push-enable"]')).not.toBeNull();
  });

  it('reports a browser-level block and withholds Enable (it could not work)', async () => {
    mocks.usePushSubscription.mockReturnValue({
      ...pushAvailable,
      permission: 'denied',
    });
    await mount();
    const badge = document.querySelector('[data-push-state]');
    expect(badge?.getAttribute('data-push-state')).toBe('denied');
    expect(document.body.textContent ?? '').toContain('Blocked in this browser');
    expect(document.querySelector('[data-qa="settings-push-enable"]')).toBeNull();
  });

  it('reports an unsupported browser without offering a broken button', async () => {
    mocks.usePushSubscription.mockReturnValue({
      checked: true,
      isSupported: false,
      isSubscribed: false,
      permission: 'default',
      enablePush: mocks.enablePush,
    });
    await mount();
    const badge = document.querySelector('[data-push-state]');
    expect(badge?.getAttribute('data-push-state')).toBe('unsupported');
    expect(document.querySelector('[data-qa="settings-push-enable"]')).toBeNull();
  });

  it('shows the enabled state once this device is subscribed', async () => {
    mocks.usePushSubscription.mockReturnValue({
      ...pushAvailable,
      isSubscribed: true,
      permission: 'granted',
    });
    await mount();
    const badge = document.querySelector('[data-push-state]');
    expect(badge?.getAttribute('data-push-state')).toBe('subscribed');
    expect(document.body.textContent ?? '').toContain('Enabled on this device');
  });

  it('renders NO quiet-hours / per-trigger switches (v1.1, no backend)', async () => {
    await mount();
    const text = document.body.textContent ?? '';
    // The section names the gap instead of faking a control.
    expect(text).toContain('not available yet');
    // The ONLY switch on the page is dark mode. Base UI's Switch renders a
    // `<span role="switch">` (verified by dumping the real DOM - it is NOT a
    // `<button>`, and `aria-label` passes through to that span).
    const switches = document.querySelectorAll('[role="switch"]');
    expect(switches).toHaveLength(1);
    expect(switches[0]?.getAttribute('data-qa')).toBe('settings-dark-mode');
    expect(switches[0]?.getAttribute('aria-label')).toBe('Dark mode');
  });

  it('links the inbox with a real project slug, not a null segment', async () => {
    await mount();
    const link = document.querySelector<HTMLAnchorElement>(
      '[data-qa="settings-notifications-link"]',
    );
    expect(link?.getAttribute('href')).toBe(
      '/shadhil-builders/projects/metro-heights/notifications',
    );
    expect(link?.getAttribute('href')).not.toContain('null');
  });

  it('withholds the inbox link when there is no project (never a 404 link)', async () => {
    mocks.useProjects.mockReturnValue({ data: [] });
    await mount();
    expect(document.querySelector('[data-qa="settings-notifications-link"]')).toBeNull();
    expect(document.body.textContent ?? '').toContain('Available once a project exists.');
  });
});

describe('SettingsPage - appearance', () => {
  it('reflects the light theme and toggles it through next-themes', async () => {
    await mount();
    // Base UI renders the switch as a `<span role="switch">` with
    // aria-checked + data-qa (verified against the real DOM).
    const toggle = document.querySelector('[data-qa="settings-dark-mode"]');
    expect(toggle?.getAttribute('role')).toBe('switch');
    expect(toggle?.getAttribute('aria-checked')).toBe('false');
    await act(async () => {
      (toggle as HTMLElement).click();
    });
    expect(mocks.setTheme).toHaveBeenCalledWith('dark');
  });

  it('shows the switch as ON when the theme is already dark', async () => {
    // Re-mock the theme hook for this case (the module mock reads live).
    vi.doMock('@paalstack/react-ui', async (importOriginal) => {
      const actual = await importOriginal<typeof import('@paalstack/react-ui')>();
      return {
        ...actual,
        useNextTheme: () => ({ resolvedTheme: 'dark', setTheme: mocks.setTheme }),
      };
    });
    vi.resetModules();
    const { default: DarkPage } = await import('./page');
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
    await act(async () => {
      root?.render(<DarkPage />);
    });
    const toggle = document.querySelector('[data-qa="settings-dark-mode"]');
    expect(toggle?.getAttribute('aria-checked')).toBe('true');
    expect(document.body.textContent ?? '').toContain('On');
  });
});
