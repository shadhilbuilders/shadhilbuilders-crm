// Project work dashboard page tests - one-page work queue (T-DASH-QUEUE,
// 2026-09-16).
//
// Replaces the previous "real-data wiring" test file, which asserted the OLD
// read-only page (KPI placeholder copy and six chart titles). Those assertions
// are gone on purpose: the charts were removed by owner instruction, so pinning
// their absence-from-the-old-shape would be pinning a page that no longer
// exists. What this file pins instead is the thing the redesign is FOR:
// that a telecaller can act from the queue without leaving the page, that they
// are NOT offered an action the server refuses, and that the queue is ordered
// by urgency rather than by whatever the server returned.
//
// The page has a `mounted` gate (`if (!mounted || sessionPending) return
// <Skeleton/>`) where `mounted` flips true only in `useEffect`. Under
// `renderToStaticMarkup` effects never run, so `mounted` stays false and the
// page renders Skeleton for every test. Fix: MOUNT the page with `createRoot` +
// `act` (which runs effects) - the same pattern as `use-nav-sync.test.tsx`.
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// `globalThis.IS_REACT_ACT_ENVIRONMENT` tells React this is a test env so
// `act` works with a raw createRoot (no @testing-library/react in this app).
(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const ROLE = { current: 'TELECALLER' as string };

// Bookings keyed by the status the page asks for, so the TOKEN card and the HOLD
// card can be given different rows in the same render.
const BOOKINGS: { current: Record<string, unknown[]> } = { current: {} };

vi.mock('@/lib/session', () => ({
  useSessionUser: vi.fn(() => ({
    user: { id: 'u-me', name: 'Demo Caller', role: ROLE.current },
    isPending: false,
  })),
  // Real mirror of the server gates - these are the rules the page relies on to
  // decide what to offer, so they must not be stubbed to `true`.
  isAdminLike: vi.fn((role: string) => role === 'ADMIN' || role === 'OWNER'),
  canApproveBookings: vi.fn(
    (role: string) => role === 'ADMIN' || role === 'OWNER' || role === 'MANAGER'
  ),
  canScheduleVisits: vi.fn(
    (role: string) =>
      role === 'ADMIN' || role === 'OWNER' || role === 'MANAGER' || role === 'TELECALLER'
  ),
  // Mirrors BookingsService.transition's HOLD -> TOKEN gate. This is the gate
  // that makes the token card DIFFERENT from the approvals card: a SALES_EXEC may
  // record a token but can never approve.
  canInitiateBookings: vi.fn(
    (role: string) =>
      role === 'ADMIN' || role === 'OWNER' || role === 'MANAGER' || role === 'SALES_EXEC'
  ),
}));

// Query state is CONTROLLABLE, not hardcoded. An earlier version pinned
// `isLoading: false, error: null` for every hook, which meant the loading and
// error branches the page implements were never actually executed by a test.
const STATS = {
  current: {
    data: {
      kpis: {
        newLeadsToday: 4,
        overdueLeads: 2,
        visitsToday: 1,
        bookingsOnHold: 0,
      },
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
const VISITS_STATE = { isLoading: false };

vi.mock('@/hooks/queries/crm', () => ({
  useLeads: vi.fn(() => ({
    data: LEADS.current,
    isLoading: LEADS_STATE.isLoading,
    error: LEADS_STATE.error,
  })),
  // The page reads the SERVER total from the envelope (same react-query key as
  // useLeads, so in production this is one shared request) to avoid reporting the
  // loaded page as a queue size.
  useLeadsEnvelope: vi.fn(() => ({ total: LEADS.current.length })),
  useVisits: vi.fn(() => ({
    data: VISITS.current,
    isLoading: VISITS_STATE.isLoading,
    error: null,
  })),
  // Answers per STATUS: the page now makes two bookings calls (TOKEN for
  // approvals, HOLD for token payments) and each card must be fed its own rows.
  useBookings: vi.fn((args?: { status?: string[] }) => ({
    data: BOOKINGS.current[args?.status?.[0] ?? ''] ?? [],
    isLoading: false,
    error: null,
  })),
  useTransitionLead: vi.fn(() => ({ mutate: vi.fn(), isPending: false })),
  // Required by the REAL BookingApprovalDialog rendered further down the page.
  // Stubbed rather than re-implemented: this suite tests the queue, and the
  // dialog has its own coverage.
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

// The real LeadVisitPanel pulls its own visit queries and session; this test is
// about the QUEUE, so the expansion slot is stubbed. LeadVisitPanel has its own
// suite (including the telecaller outcome gate).
vi.mock('@/components/shared/LeadVisitPanel', () => ({
  LeadVisitPanel: () => <div data-qa="stub-visit-panel" />,
}));

import DashboardPage from './page';
import { useBookings, useTransitionLead } from '@/hooks/queries/crm';

const mockedUseBookings = vi.mocked(useBookings);

const mockedUseTransitionLead = vi.mocked(useTransitionLead);

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
  // retry: false + queries never settling keeps the render deterministic: the
  // real dialogs in the tree mount but do not fetch.
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

function html(): string {
  return container?.innerHTML ?? '';
}

async function clickByQa(qa: string): Promise<void> {
  const el = container?.querySelector(`[data-qa="${qa}"]`);
  if (el === null || el === undefined) throw new Error(`no element with data-qa="${qa}"`);
  await act(async () => {
    (el as HTMLElement).click();
  });
}

beforeEach(() => {
  ROLE.current = 'TELECALLER';
  LEADS.current = [];
  VISITS.current = [];
  BOOKINGS.current = {};
  LEADS_STATE.isLoading = false;
  LEADS_STATE.error = null;
  VISITS_STATE.isLoading = false;
  STATS.current = {
    data: {
      kpis: {
        newLeadsToday: 4,
        overdueLeads: 2,
        visitsToday: 1,
        bookingsOnHold: 0,
      },
    },
    isLoading: false,
    error: null,
  };
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

describe('Work dashboard - one page, every action in place', () => {
  it('renders the queue for a telecaller', async () => {
    LEADS.current = [lead({})];
    await mount();
    const out = html();
    expect(out).toContain('data-qa="work-queue"');
    expect(out).toContain('Asha');
  });

  it('offers the next action as a real button on the collapsed row', async () => {
    // The whole point: "Called" is clickable WITHOUT expanding the row. If this
    // ever requires a click first, the redesign has regressed to page-hopping.
    LEADS.current = [lead({})];
    await mount();
    expect(container?.querySelector('[data-qa="queue-move-contacted"]')).not.toBeNull();
    expect(container?.querySelector('[data-qa="queue-move-visit_requested"]')).not.toBeNull();
    // Not hidden behind the expansion.
    expect(container?.querySelector('[data-qa="queue-row-toggle"]')).not.toBeNull();
  });

  it('does NOT offer a telecaller the "visited" action the server refuses', async () => {
    // Only the assigned SALES_EXEC (or manager/admin) records a visit. The page
    // must not OFFER what the API will 403.
    LEADS.current = [lead({ status: 'VISIT_SCHEDULED' })];
    await mount();
    const out = html();
    expect(out).not.toContain('data-qa="queue-move-visited"');
    expect(out).not.toContain('Mark completed');
    // Their outcome from a scheduled visit is No-show.
    expect(out).toContain('data-qa="queue-move-no_show"');
  });

  it('gives a telecaller Schedule visit on a lead that wants one', async () => {
    LEADS.current = [lead({ status: 'VISIT_REQUESTED' })];
    await mount();
    expect(container?.querySelector('[data-qa="queue-schedule-visit"]')).not.toBeNull();
  });

  it('orders the queue by urgency, not by input order', async () => {
    // Server returns newest-first; the page must re-order so the breached SLA
    // lead is the top row. Read the rendered order, not the input order.
    LEADS.current = [
      lead({ id: 'l-fresh', name: 'Fresh', status: 'NEW' }),
      lead({
        id: 'l-overdue',
        name: 'Overdue',
        status: 'NEW',
        createdAt: new Date(Date.now() - 90 * 60_000).toISOString(),
      }),
    ];
    await mount();
    const out = html();
    expect(out.indexOf('Overdue')).toBeGreaterThanOrEqual(0);
    expect(out.indexOf('Overdue')).toBeLessThan(out.indexOf('Fresh'));
  });

  it('expands a row in place rather than navigating', async () => {
    LEADS.current = [lead({})];
    await mount();
    expect(container?.querySelector('[data-qa="queue-row-expanded"]')).toBeNull();
    await clickByQa('queue-row-toggle');
    expect(container?.querySelector('[data-qa="queue-row-expanded"]')).not.toBeNull();
    expect(container?.querySelector('[data-qa="stub-visit-panel"]')).not.toBeNull();
  });

  it('fires the transition with the right target state when an action is clicked', async () => {
    const mutate = vi.fn();
    mockedUseTransitionLead.mockReturnValue({ mutate, isPending: false } as never);
    LEADS.current = [lead({ id: 'l-42' })];
    await mount();
    await clickByQa('queue-move-contacted');
    expect(mutate).toHaveBeenCalledTimes(1);
    const firstCall = mutate.mock.calls.at(0) as [Record<string, unknown>] | undefined;
    expect(firstCall?.[0]).toMatchObject({ leadId: 'l-42', toState: 'CONTACTED' });
  });

  it('OPENS the schedule-visit dialog when a row offers it', async () => {
    // REGRESSION GUARD. The Schedule visit button looked dead: the row's handler
    // set the lead id but nothing ever opened the dialog, because the open flag
    // was separate state that the handler never touched. Verified fixed in a real
    // browser; pinned here so it cannot silently break again.
    LEADS.current = [lead({ id: 'l-req', name: 'Wants a visit', status: 'VISIT_REQUESTED' })];
    await mount();
    expect(container?.querySelector('[data-qa="queue-schedule-visit"]')).not.toBeNull();

    // Closed to begin with.
    expect(container?.querySelector('[role="dialog"]')).toBeNull();

    await clickByQa('queue-schedule-visit');
    // The dialog is portalled, so assert on the document rather than the container.
    const dialog = await vi.waitFor(() => {
      const el = document.querySelector('[role="dialog"]');
      if (el === null) throw new Error('dialog not open yet');
      return el;
    });
    expect(dialog.textContent).toContain('Schedule a site visit');
    // The date field proves the real form mounted, not just a shell.
    expect(document.querySelector('[data-qa="schedule-visit-date"]')).not.toBeNull();
  });

  it('shows an empty state instead of a blank panel when the queue is empty', async () => {
    LEADS.current = [];
    await mount();
    expect(html()).toContain('Nothing needs a call right now');
  });

  it('numbers the rows so "work top-down" is literal', async () => {
    // For someone using a CRM for the first time, "start at 1, then 2" needs no
    // teaching, and it makes the urgency order visible without reading statuses.
    LEADS.current = [lead({ id: 'l-1', name: 'First' }), lead({ id: 'l-2', name: 'Second' })];
    await mount();
    const out = html();
    expect(out).toContain('>1.<');
    expect(out).toContain('>2.<');
  });

  it('uses foreground, not a muted token, for secondary text on a TINTED row', async () => {
    // T-DASH-CONTRAST. Verified in a real browser with axe-core (contrast
    // ENABLED): `text-muted-foreground` measures 3.27:1 on the overdue tint and
    // `text-destructive` 3.21:1, both below the 4.5:1 AA floor for 12px text. A
    // muted token is only readable against the plain card, not against a tint.
    //
    // This test exists because the jsdom axe audit CANNOT catch it - axe's
    // color-contrast rule is a silent no-op there (no canvas). So the rule is
    // pinned structurally instead, where CI runs.
    LEADS.current = [
      lead({
        id: 'l-od',
        name: 'Overdue Ravi',
        status: 'NEW',
        createdAt: new Date(Date.now() - 90 * 60_000).toISOString(),
      }),
    ];
    await mount();
    const row = container?.querySelector('[data-qa="queue-row"]');
    expect(row).not.toBeNull();
    // The row really is tinted (otherwise this test proves nothing).
    expect(row?.className).toMatch(/\bbg-red-/);
    const inner = row?.innerHTML ?? '';
    expect(inner).toContain('text-foreground');
    expect(inner).not.toContain('text-muted-foreground');
  });

  it('keeps the muted hierarchy on an UNTINTED row', async () => {
    // The counterpart: a fresh lead has no tint, so secondary text stays muted.
    // Dropping the hierarchy everywhere would be a needless visual regression.
    LEADS.current = [
      lead({
        id: 'l-fresh',
        status: 'NEW',
        createdAt: new Date().toISOString(),
      }),
    ];
    await mount();
    const row = container?.querySelector('[data-qa="queue-row"]');
    expect(row?.className).not.toMatch(/\bbg-(red|yellow)-/);
    expect(row?.innerHTML).toContain('text-muted-foreground');
  });

  it('never renders charts', async () => {
    // Owner instruction, stated twice. Pin it so a later "add a chart back"
    // cannot land silently.
    LEADS.current = [lead({})];
    await mount();
    const out = html();
    for (const gone of ['Leads over time', 'Lead sources', 'Team performance', 'Pipeline funnel']) {
      expect(out).not.toContain(gone);
    }
  });

  it('hides approvals from a telecaller', async () => {
    LEADS.current = [];
    await mount();
    expect(html()).not.toContain('Awaiting approval');
  });

  it('shows approvals to a manager', async () => {
    ROLE.current = 'MANAGER';
    LEADS.current = [];
    await mount();
    expect(html()).toContain('Awaiting approval');
  });

  it('marks the queue as a list, so screen readers announce it as one', async () => {
    // Tailwind preflight sets `list-style: none`, and Safari/VoiceOver then
    // drops list semantics for a <ul> unless the role is explicit. Without this
    // the queue loses "list, N items" entirely.
    LEADS.current = [lead({})];
    await mount();
    const ul = container?.querySelector('[data-qa="work-queue"]');
    expect(ul?.getAttribute('role')).toBe('list');
  });

  it('exposes the count strip as a labelled group', async () => {
    await mount();
    const strip = container?.querySelector('[aria-label="Work counts"]');
    expect(strip?.getAttribute('role')).toBe('group');
  });

  it('keeps all four counts on one row at 320px, with the value scale reduced', async () => {
    // The strip alone used to push the most urgent lead below the fold at
    // 320px. Pinned so a future "make it 2-up on mobile" cannot silently
    // reintroduce that.
    await mount();
    const strip = container?.querySelector('[aria-label="Work counts"]');
    const cls = strip?.className ?? '';
    expect(cls).toContain('grid-cols-4');
    expect(cls).not.toContain('grid-cols-2');
    // The value scales with the viewport but is never hidden or shrunk to
    // unreadable: text-2xl on a phone, text-3xl from `sm`.
    expect(strip?.innerHTML).toContain('sm:text-3xl');
    expect(strip?.innerHTML).toContain('text-2xl');
    // T-DASH-KPI-COLUMN: the label keeps ONE treatment at every width. The caps
    // were only ever dropped because a 66px-wide 4-up card could not fit
    // "NEEDS A CALL NOW"; the stacked card is full width, so they fit again.
    expect(strip?.innerHTML).toContain('tracking-wide uppercase');
  });

  it('renders all four counts as cards, and only the clickable ones say so', async () => {
    // The two filterable counts must be identifiable BEFORE hover - hover does
    // not exist on a touch screen, so an at-rest affordance is required.
    await mount();
    const cards = Array.from(container?.querySelectorAll('[data-qa^="kpi-"]') ?? []);
    expect(cards).toHaveLength(4);
    for (const card of cards) {
      expect(card.className).toContain('rounded-lg');
      expect(card.className).toContain('border');
    }
    // Exactly two are buttons, and each carries the visible affordance text.
    const clickable = cards.filter((c) => c.tagName === 'BUTTON');
    expect(clickable).toHaveLength(2);
    for (const card of clickable) {
      expect(card.className).toContain('cursor-pointer');
      expect(card.textContent).toMatch(/Tap to filter|Showing only this/);
    }
    // The static ones must NOT claim to be interactive.
    const staticCards = cards.filter((c) => c.getAttribute('data-qa') === 'kpi-card-static');
    expect(staticCards).toHaveLength(2);
    for (const card of staticCards) {
      expect(card.textContent).not.toMatch(/Tap to filter|Showing only this/);
    }
  });

  it('hides NOTHING on a phone - every part of the card is rendered at every width', async () => {
    // T-DASH-KPI-COLUMN (owner direction): "don't hide anything for kpi card in
    // mobile, just make it responsive". This test is the guard for that. It
    // replaces an earlier one that asserted the sub-line WAS hidden below `sm` -
    // the card is full-width on a phone, so all of it fits.
    await mount();
    const strip = container?.querySelector('[aria-label="Work counts"]');
    const html = strip?.innerHTML ?? '';

    // No element in the strip may be display-hidden at any width. The
    // lookbehind excludes `aria-hidden`, which IS present: every KPI card's
    // icon is decorative (see dashboard-shared.test.tsx), and that is an
    // assistive-tech concern, not a display one. Matching it here would force
    // the icons to be announced, which is the opposite of the intent.
    expect(html).not.toMatch(/(?<!aria-)\bhidden\b/);
    // The three parts that used to be width-gated are all unconditional now.
    expect(html).toContain('mt-1 text-2xl'); // the value, sized for a phone
    expect(html).toContain('block text-xs'); // the sub-line
    expect(html).toContain('Tap to filter'); // the filter affordance

    // And every label + value really is in the DOM for all four counts.
    const visible = Array.from(strip?.querySelectorAll('span') ?? []).filter(
      (s) => !s.className.includes('hidden'),
    );
    expect(visible.length).toBeGreaterThanOrEqual(12); // 4 labels + 4 values + 4 subs
  });

  it('hides the decorative phone icon from assistive tech', async () => {
    // Otherwise a screen reader announces "phone phone 9876543210".
    LEADS.current = [lead({})];
    await mount();
    const tel = container?.querySelector('a[href^="tel:"]');
    const icon = tel?.querySelector('svg');
    expect(icon?.getAttribute('aria-hidden')).toBe('true');
  });

  it('shows a skeleton while the queue is loading', async () => {
    // These branches were previously untested because the mocks pinned
    // isLoading:false for every hook.
    LEADS_STATE.isLoading = true;
    await mount();
    const out = html();
    expect(out).toContain('data-skeleton-variant');
    expect(out).not.toContain('Nothing needs a call right now');
  });

  it('shows an error banner, not a blank panel, when the queue query fails', async () => {
    LEADS_STATE.error = new Error('API 500: Internal Server Error');
    await mount();
    const out = html();
    expect(out).toContain('Could not load your queue');
    expect(out).toContain('API 500: Internal Server Error');
    // role=alert, so assistive tech announces the failure rather than silently
    // showing an empty queue.
    expect(container?.querySelector('[role="alert"]')).not.toBeNull();
  });

  it('still renders the queue when only the COUNTS fail', async () => {
    // The queue is the work surface; a stats outage must not take it down.
    STATS.current = { data: undefined, isLoading: false, error: new Error('stats down') };
    LEADS.current = [lead({ name: 'Still here' })];
    await mount();
    const out = html();
    expect(out).toContain('Some counts unavailable');
    expect(out).toContain('Still here');
  });

  it('surfaces today\u2019s visits with a time column', async () => {
    VISITS.current = [
      {
        id: 'v-1',
        leadId: 'l-9',
        leadName: 'Ravi',
        scheduledFor: '2026-09-16T10:30:00.000Z',
        userName: 'Priya',
        status: 'SCHEDULED',
        leadState: 'VISIT_SCHEDULED',
      },
    ];
    await mount();
    const out = html();
    expect(out).toContain('Ravi');
    expect(out).toContain("Today's visits");
  });

  it('explains WHY "needs a call now" is zero instead of just showing 0', async () => {
    // Reported as "it always returns 0". The count was CORRECT for a
    // project-scoped view, and a bare "0" reads as a broken counter - so a zero
    // now says why. The "N leads have no project" branch that briefly lived here is
    // GONE: `Lead.projectId` is NOT NULL now (T-LEAD-PROJECT-REQUIRED), so that
    // cause cannot occur. Pinned explicitly so it is not reintroduced.
    const withStats = (kpis: Record<string, number>) => {
      STATS.current = {
        data: { kpis: { newLeadsToday: 1, visitsToday: 0, bookingsOnHold: 0, ...kpis } },
        isLoading: false,
        error: null,
      };
    };

    // (a) overdue > 0 -> the normal explanation.
    withStats({ overdueLeads: 3 });
    await mount();
    expect(html()).toContain('overdue first touch');

    // (b) overdue == 0 -> a clean bill of health, and no orphan wording.
    withStats({ overdueLeads: 0 });
    await mount();
    const clean = html();
    expect(clean).toContain('none overdue');
    expect(clean).not.toMatch(/have no project/);
  });
});

// ── T-HOLD-VISIBLE ───────────────────────────────────────────────────────────
// Fixing the approvals card (it had queried HOLD while the dialog only acts on
// TOKEN) removed the last dashboard surface for a HOLD booking, so a booking
// sitting on HOLD with money outstanding appeared NOWHERE. It is real work - the
// unit is held - so it needs its own card.
//
// The two cards are deliberately separate because the ACTIONS and their GATES
// differ: recording a token is MANAGER/SALES_EXEC/ADMIN/OWNER, a manager
// decision is MANAGER/ADMIN/OWNER. A SALES_EXEC can record a token but can never
// approve, so a single merged card would either hide HOLD from the exec who must
// chase the payment, or show rows to a manager carrying an action they need not
// take.
describe('Token-payment card - HOLD bookings have somewhere to go', () => {
  const holdRow = {
    id: 'bkg-hold',
    unitNumber: 'D-102',
    leadName: 'Demo Rahul',
    amount: '₹59,50,000.00',
  };

  it('queries HOLD (the state a token payment acts on), not TOKEN', async () => {
    ROLE.current = 'MANAGER';
    mockedUseBookings.mockClear();
    await mount();

    const statuses = mockedUseBookings.mock.calls.flatMap(
      (c) => (c[0] as { status?: string[] })?.status ?? []
    );
    // TOKEN feeds approvals, HOLD feeds token payments. Both must be asked for:
    // they are different queues with different actions.
    expect(statuses).toContain('TOKEN');
    expect(statuses).toContain('HOLD');
  });

  it('renders the HOLD booking for a manager, naming its unit', async () => {
    ROLE.current = 'MANAGER';
    BOOKINGS.current = { HOLD: [holdRow] };
    await mount();

    const markup = html();
    expect(markup).toContain('Needs token payment');
    expect(markup).toContain('Unit D-102');
    expect(markup).toContain('Demo Rahul');
    expect(markup).toContain('Record token');
  });

  it('renders it for a SALES_EXEC, who can record a token but cannot approve', async () => {
    ROLE.current = 'SALES_EXEC';
    BOOKINGS.current = { HOLD: [holdRow] };
    await mount();

    const markup = html();
    expect(markup).toContain('Needs token payment');
    expect(markup).toContain('Record token');
    // The approvals card is NOT theirs - the server would 403 the decision.
    expect(markup).not.toContain('Awaiting approval');
  });

  it('hides it from a TELECALLER, whom the server would 403', async () => {
    ROLE.current = 'TELECALLER';
    BOOKINGS.current = { HOLD: [holdRow] };
    await mount();

    const markup = html();
    expect(markup).not.toContain('Needs token payment');
    expect(markup).not.toContain('Record token');
  });

  it('keeps the two queues separate - the token card shows only HOLD rows', async () => {
    ROLE.current = 'MANAGER';
    BOOKINGS.current = {
      HOLD: [{ id: 'b-hold', unitNumber: 'D-102', leadName: 'Demo Rahul' }],
      TOKEN: [{ id: 'b-token', unitNumber: 'D-101', leadName: 'Demo Vikram' }],
    };
    await mount();

    const markup = html();

    // Count by ACTION button, not by unit text: each row legitimately names its
    // unit twice (visible label plus accessible name), so a text count is 2 per
    // row and would be a misleading assertion.
    expect(markup.match(/data-qa="booking-record-token"/g)?.length).toBe(1);
    expect(markup.match(/data-qa="booking-approve-open"/g)?.length).toBe(1);
    // And each action is bound to ITS OWN booking's unit - never the other's.
    expect(markup).toMatch(/aria-label="Record token for Unit D-102/);
    expect(markup).not.toMatch(/aria-label="Record token for Unit D-101/);
    expect(markup).toMatch(/aria-label="Review booking for Unit D-101/);
    expect(markup).not.toMatch(/aria-label="Review booking for Unit D-102/);
  });
});

// ── T-APPROVE-WRONG-STATE ────────────────────────────────────────────────────
// The "Awaiting approval" card listed bookings it could not act on. It asked the
// API for HOLD, but the dialog it opens submits APPROVED/REJECTED, and
// `legalNextStates('HOLD')` is ['TOKEN','CANCELLED'] - so the server refused
// every attempt with 400 and the manager hit a dead end. Verified live before
// the fix:
//   PATCH /bookings/:id {toStatus:'APPROVED'} -> 400 on HOLD, 200 on TOKEN.
//
// This test is the structural guard: the card's queried state must be one the
// approval action is actually legal from. It asserts the STATE, not the count,
// so it keeps holding if the wording or the data changes.
describe('Awaiting approval card - only lists bookings it can actually decide', () => {
  // NOTE ON WHY THIS IS RENDER-BASED. An earlier version asserted that NO
  // useBookings call asked for HOLD. That held while the page had one bookings
  // card; once the token-payment card legitimately queried HOLD (T-HOLD-VISIBLE)
  // it became a false failure. The invariant was never about which statuses the
  // PAGE requests - it is about which rows land in THIS CARD. So assert on the
  // rendered card, scoped so a unit shown in another section cannot satisfy it.
  it('lists the TOKEN booking, never the HOLD one it could not decide', async () => {
    ROLE.current = 'MANAGER';
    BOOKINGS.current = {
      // D-101 is approvable (TOKEN); D-102 is not (HOLD needs a token first).
      TOKEN: [{ id: 'b-token', unitNumber: 'D-101', leadName: 'Demo Vikram' }],
      HOLD: [{ id: 'b-hold', unitNumber: 'D-102', leadName: 'Demo Rahul' }],
    };
    await mount();

    const markup = html();
    const start = markup.indexOf('Awaiting approval');
    const end = markup.indexOf('Needs token payment');
    expect(start).toBeGreaterThanOrEqual(0);
    // Slice from this card's title to the next section, so the D-102 row sitting
    // in the token card below cannot make this pass.
    expect(end).toBeGreaterThan(start);
    const approvals = markup.slice(start, end);

    expect(approvals).toContain('Unit D-101');
    expect(approvals).not.toContain('Unit D-102');
  });
});
