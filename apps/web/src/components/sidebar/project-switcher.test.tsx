// ProjectSwitcher - the sidebar's project dropdown (T-ProjectSwitch).
//
// WHY THIS SUITE EXISTS. The switcher decides WHERE a project change lands, and
// that URL is the product's source of truth for "which project am I looking at"
// (no localStorage, no context - see the header comment in the component). A
// wrong surface here silently drops the user onto an unrelated screen, so every
// branch of the surface derivation is pinned below:
//
//   1. a project row navigates to the SAME work surface under the new slug;
//   2. the record id is dropped, deliberately (a lead id from project A does
//      not exist in project B - only the surface carries over);
//   3. a pathname without a surface, and any org-level page, fall back to the
//      caller's role-aware `fallbackSurface`;
//   4. an unresolved org slug degrades to the bare surface path rather than
//      inventing an org segment (that is projectHref's documented contract).
//
// Also pinned: the honest-state contract (the menu opens with an empty
// registry), admin-only "Manage projects", the active-row marking, close-on-
// select, and the Base UI open-state attribute that the styling keys off.
//
// Rendered with createRoot + act (not renderToStaticMarkup) because these
// assertions are about clicks and navigation, which static markup cannot show.
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

import { SidebarProvider } from '@paalstack/react-ui';

// vi.hoisted: the mock factory is hoisted above the imports, so the mutable
// navigation state it closes over has to be hoisted with it. `pathname` is
// reassigned per test to drive the surface derivation.
const nav = vi.hoisted(() => ({
  pathname: '/shadhil-builders/projects/metro-heights/leads',
  push: vi.fn(),
}));

vi.mock('next/navigation', () => ({
  useRouter: () => ({ push: nav.push, back: vi.fn(), replace: vi.fn(), prefetch: vi.fn() }),
  usePathname: () => nav.pathname,
}));

import { ProjectSwitcher, type ProjectListItem } from './project-switcher';

// jsdom has no matchMedia; SidebarProvider reads it via useMediaQuery. `matches`
// stays false so the sidebar resolves as desktop (non-mobile) throughout.
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

const ORG = 'shadhil-builders';

const project = (id: string, slug: string, name: string): ProjectListItem => ({
  id,
  slug,
  name,
  address: 'Chennai',
  reraNumber: null,
  cmdaNumber: null,
  createdAt: '2026-01-01T00:00:00.000Z',
});

const METRO = project('p1', 'metro-heights', 'Metro Heights');
const SKYLINE = project('p2', 'skyline-residency', 'Skyline Residency');
const PROJECTS = [METRO, SKYLINE];

let container: HTMLDivElement | null = null;
let root: Root | null = null;

const qa = (value: string): HTMLElement | null => document.querySelector(`[data-qa="${value}"]`);
const qaAll = (value: string): HTMLElement[] =>
  Array.from(document.querySelectorAll(`[data-qa="${value}"]`));

type Props = {
  projects?: ProjectListItem[];
  activeProjectSlug?: string | null;
  activeOrgSlug?: string | null;
  canManageProjects?: boolean;
  fallbackSurface?: string;
};

/** Mount, and open the dropdown (the content is portaled to <body>). */
async function mountOpen(props: Props = {}): Promise<void> {
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
  await act(async () => {
    root?.render(
      // SidebarMenuButton reads the sidebar context, so the switcher needs the
      // provider it always has inside the real shell.
      <SidebarProvider>
        <ProjectSwitcher
          projects={props.projects ?? PROJECTS}
          activeProjectSlug={
            props.activeProjectSlug === undefined ? METRO.slug : props.activeProjectSlug
          }
          activeOrgSlug={props.activeOrgSlug === undefined ? ORG : props.activeOrgSlug}
          canManageProjects={props.canManageProjects ?? false}
          {...(props.fallbackSurface === undefined
            ? {}
            : { fallbackSurface: props.fallbackSurface })}
        />
      </SidebarProvider>,
    );
  });
  await openMenu();
}

async function openMenu(): Promise<void> {
  const trigger = qa('project-switcher-trigger');
  expect(trigger, 'project switcher trigger did not render').not.toBeNull();
  await act(async () => {
    trigger!.click();
  });
}

async function clickQa(value: string): Promise<void> {
  const el = qa(value);
  expect(el, `${value} is not rendered`).not.toBeNull();
  await act(async () => {
    el!.click();
  });
}

beforeEach(() => {
  nav.pathname = `/${ORG}/projects/${METRO.slug}/leads`;
  nav.push.mockClear();
});

afterEach(async () => {
  await act(async () => {
    root?.unmount();
  });
  root = null;
  container?.remove();
  container = null;
  document.body.innerHTML = '';
});

describe('ProjectSwitcher trigger', () => {
  it('shows the active project name and slug', async () => {
    await mountOpen({});
    const trigger = qa('project-switcher-trigger');
    expect(trigger?.textContent).toContain('Metro Heights');
    expect(trigger?.textContent).toContain('metro-heights');
  });

  it('has an accessible name independent of the project text', async () => {
    await mountOpen({});
    expect(qa('project-switcher-trigger')?.getAttribute('aria-label')).toBe('Switch project');
  });

  it('says "No project" / "Select a project" when the registry is empty', async () => {
    // Honest state: an empty registry must not look like a populated one.
    await mountOpen({ projects: [] });
    const trigger = qa('project-switcher-trigger');
    expect(trigger?.textContent).toContain('No project');
    expect(trigger?.textContent).toContain('Select a project');
  });

  it('falls back to the first project when the URL slug matches none', async () => {
    // A stale bookmarked slug must not leave the trigger blank.
    await mountOpen({ activeProjectSlug: 'deleted-project' });
    expect(qa('project-switcher-trigger')?.textContent).toContain('Metro Heights');
  });

  it('marks itself open with the attribute Base UI actually emits', async () => {
    // The class list keys off `data-popup-open` (Base UI), NOT the Radix
    // `data-state="open"`. Assert against the live node so a rename fails here.
    await mountOpen({});
    const trigger = qa('project-switcher-trigger')!;
    expect(trigger.matches('[data-popup-open]'), 'trigger is not marked open').toBe(true);
    expect(trigger.className).toContain('data-popup-open:bg-sidebar-accent');
  });
});

describe('ProjectSwitcher rows', () => {
  it('renders one row per project', async () => {
    await mountOpen({});
    expect(qaAll('project-switcher-item')).toHaveLength(PROJECTS.length);
  });

  it('marks only the active row, and labels it', async () => {
    await mountOpen({});
    const rows = qaAll('project-switcher-item');
    const metro = rows.find((r) => r.textContent?.includes('Metro Heights'))!;
    const skyline = rows.find((r) => r.textContent?.includes('Skyline Residency'))!;
    expect(metro.getAttribute('data-active')).toBe('true');
    expect(metro.textContent).toContain('Active');
    expect(skyline.getAttribute('data-active')).toBe('false');
    expect(skyline.textContent).not.toContain('Active');
  });

  it('opens on an empty registry instead of pretending to be closed', async () => {
    // The dropdown must stay openable even with nothing to switch to; the
    // empty notice is the honest answer, not a spinner or a dead trigger.
    await mountOpen({ projects: [] });
    expect(qa('project-switcher-empty')?.textContent).toContain('No projects available');
    expect(qaAll('project-switcher-item')).toHaveLength(0);
  });
});

describe('ProjectSwitcher navigation', () => {
  it('switches to the SAME surface under the chosen project slug', async () => {
    nav.pathname = `/${ORG}/projects/${METRO.slug}/leads`;
    await mountOpen({});
    const skyline = qaAll('project-switcher-item').find((r) =>
      r.textContent?.includes('Skyline Residency'),
    )!;
    await act(async () => {
      skyline.click();
    });
    expect(nav.push).toHaveBeenCalledWith(`/${ORG}/projects/${SKYLINE.slug}/leads`);
  });

  it('drops the record id - only the surface carries across projects', async () => {
    // A lead id from project A does not exist in project B, so switching must
    // land on the LIST, never on /leads/<foreign-id>.
    nav.pathname = `/${ORG}/projects/${METRO.slug}/leads/lead-abc123`;
    await mountOpen({});
    const skyline = qaAll('project-switcher-item').find((r) =>
      r.textContent?.includes('Skyline Residency'),
    )!;
    await act(async () => {
      skyline.click();
    });
    expect(nav.push).toHaveBeenCalledWith(`/${ORG}/projects/${SKYLINE.slug}/leads`);
  });

  it('keeps a nested surface name (site stays site)', async () => {
    nav.pathname = `/${ORG}/projects/${METRO.slug}/site/unit-9`;
    await mountOpen({});
    const skyline = qaAll('project-switcher-item').find((r) =>
      r.textContent?.includes('Skyline Residency'),
    )!;
    await act(async () => {
      skyline.click();
    });
    expect(nav.push).toHaveBeenCalledWith(`/${ORG}/projects/${SKYLINE.slug}/site`);
  });

  it('falls back to the default surface when the URL names no project', async () => {
    // /org/projects/<slug> with no surface segment: segments[3] is undefined,
    // so the derivation falls through to fallbackSurface.
    nav.pathname = `/${ORG}/projects/${METRO.slug}`;
    await mountOpen({});
    const skyline = qaAll('project-switcher-item').find((r) =>
      r.textContent?.includes('Skyline Residency'),
    )!;
    await act(async () => {
      skyline.click();
    });
    expect(nav.push).toHaveBeenCalledWith(`/${ORG}/projects/${SKYLINE.slug}/dashboard`);
  });

  it('falls back to the default surface on an org-level page', async () => {
    nav.pathname = `/${ORG}/admin/users`;
    await mountOpen({});
    const skyline = qaAll('project-switcher-item').find((r) =>
      r.textContent?.includes('Skyline Residency'),
    )!;
    await act(async () => {
      skyline.click();
    });
    expect(nav.push).toHaveBeenCalledWith(`/${ORG}/projects/${SKYLINE.slug}/dashboard`);
  });

  it('honours the role-aware fallbackSurface', async () => {
    // Site staff land on /site, not /dashboard (see workSurfaceForRole).
    nav.pathname = `/${ORG}`;
    await mountOpen({ fallbackSurface: '/site' });
    const skyline = qaAll('project-switcher-item').find((r) =>
      r.textContent?.includes('Skyline Residency'),
    )!;
    await act(async () => {
      skyline.click();
    });
    expect(nav.push).toHaveBeenCalledWith(`/${ORG}/projects/${SKYLINE.slug}/site`);
  });

  it('degrades to the bare surface path when the org slug is unresolved', async () => {
    // projectHref's documented contract: no org slug -> template unchanged.
    // Asserted so a future "invent an org segment" refactor is caught.
    nav.pathname = '/';
    await mountOpen({ activeOrgSlug: null });
    const skyline = qaAll('project-switcher-item').find((r) =>
      r.textContent?.includes('Skyline Residency'),
    )!;
    await act(async () => {
      skyline.click();
    });
    expect(nav.push).toHaveBeenCalledWith('/dashboard');
  });

  it('closes the menu once a project is chosen', async () => {
    // Portalled content is not unmounted by a route change, so a menu that
    // stays open would sit on top of the project it just opened.
    await mountOpen({});
    expect(qaAll('project-switcher-item')).toHaveLength(PROJECTS.length);
    const skyline = qaAll('project-switcher-item').find((r) =>
      r.textContent?.includes('Skyline Residency'),
    )!;
    await act(async () => {
      skyline.click();
    });
    expect(qaAll('project-switcher-item')).toHaveLength(0);
  });
});

describe('ProjectSwitcher "Manage projects" row', () => {
  it('is hidden for non-admin roles', async () => {
    await mountOpen({ canManageProjects: false });
    expect(qa('project-switcher-manage')).toBeNull();
  });

  it('lands on the org-scoped admin registry for admins', async () => {
    await mountOpen({ canManageProjects: true });
    const manage = qa('project-switcher-manage');
    expect(manage?.textContent).toContain('Manage projects');
    await act(async () => {
      manage!.click();
    });
    expect(nav.push).toHaveBeenCalledWith(`/${ORG}/admin/projects`);
  });

  it('degrades to the bare admin path when the org slug is unresolved', async () => {
    await mountOpen({ canManageProjects: true, activeOrgSlug: null });
    await clickQa('project-switcher-manage');
    expect(nav.push).toHaveBeenCalledWith('/admin/projects');
  });

  it('sits AFTER the project rows', async () => {
    await mountOpen({ canManageProjects: true });
    const rows = qaAll('project-switcher-item');
    const manage = qa('project-switcher-manage')!;
    const lastRow = rows[rows.length - 1]!;
    expect(
      lastRow.compareDocumentPosition(manage) & Node.DOCUMENT_POSITION_FOLLOWING,
      'Manage projects should follow the project list',
    ).toBeTruthy();
  });

  it('is reachable even with an empty registry', async () => {
    // Admins must be able to create the first project - the empty state must
    // not strand them.
    await mountOpen({ projects: [], canManageProjects: true });
    expect(qa('project-switcher-empty')).not.toBeNull();
    expect(qa('project-switcher-manage')).not.toBeNull();
  });
});
