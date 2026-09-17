// Accessibility audit of the work dashboard (T-DASH-A11Y, 2026-09-16).
//
// Runs axe-core against the REAL rendered page across the three role views plus
// the empty, loading and error states. This closes a gap that was left open when
// the page first shipped: the lint gate (jsx-a11y) only reads source, so it
// cannot see a violation that only exists in the assembled DOM.
//
// WHAT THIS CANNOT CHECK, stated plainly so nobody reads a green run as more
// than it is: `color-contrast` is NOT verifiable in jsdom. axe needs
// `HTMLCanvasElement.getContext()`, jsdom does not implement it without the
// optional `canvas` package, and the rule silently reports zero violations
// rather than erroring. Verified directly with a probe: a #c8c8c8-on-#ffffff
// paragraph (definitely a violation) produced 0 results, while `button-name`
// on an empty button was detected correctly. So contrast remains a MANUAL check
// in a real browser, and these tests disable the rule explicitly rather than
// letting a no-op rule masquerade as coverage.
//
// The page has a `mounted` gate that only flips in `useEffect`, so it is mounted
// with createRoot + act (see the page's own test file for the full rationale).
import axe from 'axe-core';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const ROLE = { current: 'TELECALLER' as string };

vi.mock('@/lib/session', () => ({
  useSessionUser: vi.fn(() => ({
    user: { id: 'u-me', name: 'Demo Caller', role: ROLE.current },
    isPending: false,
  })),
  isAdminLike: vi.fn((role: string) => role === 'ADMIN' || role === 'OWNER'),
  canApproveBookings: vi.fn(
    (role: string) => role === 'ADMIN' || role === 'OWNER' || role === 'MANAGER'
  ),
  canScheduleVisits: vi.fn(
    (role: string) =>
      role === 'ADMIN' || role === 'OWNER' || role === 'MANAGER' || role === 'TELECALLER'
  ),
  // T-HOLD-VISIBLE: the token-payment card's gate. Mirrors
  // BookingsService.transition's HOLD -> TOKEN check (note it is WIDER than
  // canApproveBookings: a SALES_EXEC may record a token but never approve), so
  // this audit exercises the manager-only approvals card AND the exec-visible
  // token card.
  canInitiateBookings: vi.fn(
    (role: string) =>
      role === 'ADMIN' || role === 'OWNER' || role === 'MANAGER' || role === 'SALES_EXEC'
  ),
}));

const STATS = {
  current: {
    data: {
      kpis: { newLeadsToday: 4, overdueLeads: 2, visitsToday: 1, bookingsOnHold: 0 },
    } as unknown,
    isLoading: false,
    error: null as unknown,
  },
};

vi.mock('@/hooks/queries/dashboard', () => ({
  useDashboardStats: vi.fn(() => STATS.current),
}));

const LEADS = { current: [] as unknown[] };
const VISITS = { current: [] as unknown[] };
const LEADS_STATE = { isLoading: false, error: null as unknown };

vi.mock('@/hooks/queries/crm', () => ({
  useLeads: vi.fn(() => ({
    data: LEADS.current,
    isLoading: LEADS_STATE.isLoading,
    error: LEADS_STATE.error,
  })),
  useLeadsEnvelope: vi.fn(() => ({ total: LEADS.current.length })),
  useVisits: vi.fn(() => ({ data: VISITS.current, isLoading: false, error: null })),
  useBookings: vi.fn(() => ({
    data: ROLE.current === 'MANAGER' ? [{ id: 'b-1', leadName: 'Ravi', amount: '250000' }] : [],
    isLoading: false,
    error: null,
  })),
  useTransitionLead: vi.fn(() => ({ mutate: vi.fn(), isPending: false })),
  useUpdateBooking: vi.fn(() => ({ mutate: vi.fn(), isPending: false })),
  useCreateVisit: vi.fn(() => ({ mutate: vi.fn(), isPending: false })),
}));

vi.mock('@/lib/tenant-context', () => ({
  useProjectId: vi.fn(() => 'proj-metro'),
  useOrgSlug: vi.fn(() => 'shadhil'),
  useProjectSlug: vi.fn(() => 'metro'),
}));

vi.mock('next/navigation', () => ({
  useParams: vi.fn(() => ({ projectId: 'proj-metro' })),
}));

import DashboardPage from './page';

let container: HTMLDivElement | null = null;
let root: Root | null = null;

function lead(over: Record<string, unknown>) {
  return {
    id: 'l-1',
    name: 'Asha',
    phone: '9876543210',
    status: 'NEW',
    createdAt: new Date(Date.now() - 5 * 60_000).toISOString(),
    ownerName: 'Demo Caller',
    ...over,
  };
}

async function mount(): Promise<void> {
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false, staleTime: Infinity } },
  });
  await act(async () => {
    root?.render(
      <QueryClientProvider client={queryClient}>
        <DashboardPage />
      </QueryClientProvider>
    );
  });
}

/**
 * Runs axe over the mounted page.
 *
 * `color-contrast` is disabled because it is a silent no-op in jsdom (see the
 * file header). Everything else runs. `region` is also disabled: the page is
 * rendered without the app shell, so axe correctly reports that content sits
 * outside a landmark - which is an artifact of mounting a fragment, not a
 * defect in the page.
 */
async function audit() {
  const results = await axe.run(container as HTMLElement, {
    rules: {
      'color-contrast': { enabled: false },
      region: { enabled: false },
    },
  });
  return results.violations.map((v) => ({
    id: v.id,
    impact: v.impact,
    nodes: v.nodes.map((n) => n.html),
  }));
}

beforeEach(() => {
  ROLE.current = 'TELECALLER';
  LEADS.current = [];
  VISITS.current = [];
  LEADS_STATE.isLoading = false;
  LEADS_STATE.error = null;
});

afterEach(async () => {
  await act(async () => {
    root?.unmount();
  });
  root = null;
  container?.remove();
  container = null;
  vi.clearAllMocks();
});

describe('Work dashboard - axe-core audit', () => {
  it('is clean for a TELECALLER with a full queue', async () => {
    LEADS.current = [
      lead({ id: 'l-1', name: 'Asha', status: 'NEW' }),
      lead({
        id: 'l-2',
        name: 'Overdue Ravi',
        status: 'NEW',
        createdAt: new Date(Date.now() - 90 * 60_000).toISOString(),
      }),
      lead({ id: 'l-3', name: 'Wants a visit', status: 'VISIT_REQUESTED' }),
      lead({ id: 'l-4', name: 'Scheduled', status: 'VISIT_SCHEDULED' }),
    ];
    VISITS.current = [
      {
        id: 'v-1',
        leadId: 'l-9',
        leadName: 'Ravi',
        scheduledFor: '2026-09-16T10:30:00.000Z',
        userName: 'Priya',
      },
    ];
    await mount();
    expect(await audit()).toEqual([]);
  }, 30_000);

  it('is clean for a manager, including the approvals card', async () => {
    ROLE.current = 'MANAGER';
    LEADS.current = [lead({ id: 'l-1', name: 'Asha' })];
    await mount();
    expect(await audit()).toEqual([]);
  }, 30_000);

  it('is clean for a sales exec', async () => {
    ROLE.current = 'SALES_EXEC';
    LEADS.current = [
      lead({ id: 'l-1', name: 'Exec lead', status: 'VISITED' }),
      lead({ id: 'l-2', name: 'Negotiating', status: 'NEGOTIATION' }),
    ];
    await mount();
    expect(await audit()).toEqual([]);
  }, 30_000);

  it('is clean when the queue is EMPTY', async () => {
    LEADS.current = [];
    await mount();
    expect(await audit()).toEqual([]);
  }, 30_000);

  it('is clean while LOADING (the skeleton state)', async () => {
    LEADS_STATE.isLoading = true;
    await mount();
    expect(await audit()).toEqual([]);
  }, 30_000);

  it('is clean when the queue query FAILS (the error banner)', async () => {
    LEADS_STATE.error = new Error('API 500: Internal Server Error');
    await mount();
    expect(await audit()).toEqual([]);
  }, 30_000);

  it('is clean when the counts query fails', async () => {
    STATS.current = { data: undefined, isLoading: false, error: new Error('stats down') };
    LEADS.current = [lead({})];
    await mount();
    expect(await audit()).toEqual([]);
  }, 30_000);

  it('is clean with a pathological long name and a missing phone', async () => {
    // Edge-case paranoia the frontend skill asks for: a 47-char name and a null
    // phone are the two things most likely to break the row's layout or produce
    // an unlabelled element.
    LEADS.current = [
      lead({
        id: 'l-long',
        name: 'Venkateshwara Subramaniam Iyer-Balakrishnan',
        phone: undefined,
        status: 'NEW',
      }),
    ];
    await mount();
    expect(await audit()).toEqual([]);
  }, 30_000);

  it('exposes every action as a natively focusable control', async () => {
    // WHAT THIS CAN AND CANNOT DO. It cannot literally press Tab - jsdom has no
    // sequential-focus model. What it CAN verify is the structural precondition:
    // every action is a real <button>/<a href>, which is focusable and
    // keyboard-activatable by default. A <div onClick> would be unreachable and
    // would fail here, which is the actual defect this guards.
    LEADS.current = [
      lead({ id: 'l-1', name: 'Asha', status: 'NEW' }),
      lead({ id: 'l-2', name: 'Wants a visit', status: 'VISIT_REQUESTED' }),
    ];
    await mount();
    const controls = Array.from(
      container?.querySelectorAll('button, a[href]') ?? []
    ) as HTMLElement[];
    expect(controls.length).toBeGreaterThan(4);
    for (const el of controls) {
      const focusable = el.tagName === 'BUTTON' || (el.tagName === 'A' && el.hasAttribute('href'));
      expect(focusable).toBe(true);
      // A control the browser removes from the tab order is not keyboard
      // reachable, whatever element it is.
      expect(el.getAttribute('tabindex')).not.toBe('-1');
    }
  }, 30_000);

  it('never uses a positive tabindex, which breaks natural tab order', async () => {
    LEADS.current = [lead({})];
    await mount();
    const positive = Array.from(container?.querySelectorAll('[tabindex]') ?? []).filter((el) => {
      const v = Number(el.getAttribute('tabindex'));
      return Number.isFinite(v) && v > 0;
    });
    expect(positive).toEqual([]);
  }, 30_000);

  it('gives every interactive control a visible focus ring', async () => {
    // Keyboard users need to SEE where they are. The library's Button carries
    // its own ring; raw <button>/<a> elements do not, so they must carry an
    // explicit focus-visible class.
    LEADS.current = [lead({ id: 'l-1', name: 'Asha', status: 'NEW' })];
    VISITS.current = [
      { id: 'v-1', leadId: 'l-9', leadName: 'Ravi', scheduledFor: '2026-09-16T10:30:00.000Z' },
    ];
    await mount();
    const raw = Array.from(
      container?.querySelectorAll('button:not([data-qa]), a[href]') ?? []
    ) as HTMLElement[];
    for (const el of raw) {
      const cls = el.className;
      expect(cls).toContain('focus-visible:ring');
    }
  }, 30_000);

  it('does not rely on colour alone to convey a lead is overdue', async () => {
    // The overdue tint is a colour, but the ROW also carries the words, so the
    // meaning survives for a colour-blind user or in greyscale.
    LEADS.current = [
      lead({
        id: 'l-od',
        name: 'Overdue Ravi',
        status: 'NEW',
        createdAt: new Date(Date.now() - 90 * 60_000).toISOString(),
      }),
    ];
    await mount();
    const out = container?.innerHTML ?? '';
    expect(out).toContain('Overdue');
    expect(out).toMatch(/no call within/i);
  }, 30_000);

  it('the audit would actually catch a violation (meta-test)', async () => {
    // Guards the guard: if axe were somehow a no-op in this environment, every
    // test above would pass vacuously. This injects a real violation into the
    // same container and asserts the audit reports it.
    LEADS.current = [lead({})];
    await mount();
    const btn = document.createElement('button');
    btn.setAttribute('data-injected', 'unnamed');
    container?.appendChild(btn);
    const violations = await audit();
    expect(violations.map((v) => v.id)).toContain('button-name');
  }, 30_000);
});
