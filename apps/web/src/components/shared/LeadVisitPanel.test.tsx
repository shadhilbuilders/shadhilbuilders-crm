// T-D4 - LeadVisitPanel offline fallback.
//
// Two units under test:
//
//   1. isOfflineError() - the transport-failure classifier. Offline
//      queueing is for transport failures ONLY (fetch TypeError, 5xx);
//      a 4xx is a real rejection that must NOT poison the queue.
//
//   2. The offline enqueue path in recordOutcome() - when the online
//      mutation fails with a transport error, the outcome is queued
//      via enqueueUnique with a dedupeKey (`outcome:{visitId}:{outcome}`)
//      so re-taps replace instead of stack. The test mounts the panel
//      with createRoot+act (renderToStaticMarkup never runs effects,
//      so it can't exercise a click handler) and clicks "Mark
//      completed" while fetch rejects with a network TypeError.
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// ---- isOfflineError (pure fn, direct import) ----
import { isOfflineError } from './LeadVisitPanel';

// ApiError shape from @/apis/client (status field on Error).
class FakeApiError extends Error {
  status: number;
  constructor(message: string, status: number) {
    super(message);
    this.status = status;
  }
}

describe('isOfflineError (T-D4 transport classifier)', () => {
  it('TypeError: Failed to fetch → true (offline)', () => {
    expect(isOfflineError(new TypeError('Failed to fetch'))).toBe(true);
  });

  it('TypeError: Load failed (Safari wording) → true', () => {
    expect(isOfflineError(new TypeError('Load failed'))).toBe(true);
  });

  it('5xx ApiError → true (transport - server down)', () => {
    expect(isOfflineError(new FakeApiError('API 503', 503))).toBe(true);
  });

  it('4xx ApiError → false (real rejection - do NOT queue)', () => {
    expect(isOfflineError(new FakeApiError('API 409', 409))).toBe(false);
    expect(isOfflineError(new FakeApiError('API 400', 400))).toBe(false);
  });

  it('plain Error without status → false', () => {
    expect(isOfflineError(new Error('boom'))).toBe(false);
  });

  it('non-error values → false', () => {
    expect(isOfflineError(undefined)).toBe(false);
    expect(isOfflineError('nope')).toBe(false);
  });
});

// ---- offline enqueue path (mounted component) ----

// vi.mock factories are hoisted; build the mocks via vi.hoisted so the
// factory body can reference them.
const mocks = vi.hoisted(() => {
  const mutate = vi.fn();
  return {
    mutate,
    transitionMutate: vi.fn(),
    enqueueUnique: vi.fn(async () => ({ id: 'q-1', createdAt: 1 })),
  };
});

// T-VISIT-OUTCOME-GATE (2026-09-16): the role-gate tests below need to swap the
// acting role and the per-outcome permission mid-suite, so the session helpers
// are held in a hoisted handle the vi.mock factory can reference.
const sessionMock = vi.hoisted(() => ({
  useSessionUser: vi.fn(),
  canLogVisitOutcome: vi.fn(),
}));

vi.mock('@/hooks/queries/crm', () => ({
  useVisits: vi.fn(() => ({
    data: [
      { id: 'visit-1', leadId: 'lead-1', status: 'SCHEDULED' },
    ],
    isLoading: false,
    error: null,
  })),
  useUpdateVisitOutcome: vi.fn(() => ({
    mutate: mocks.mutate,
    isPending: false,
  })),
  // T-LEAD-SYNC-COVERAGE (2026-09-30): LeadVisitPanel now imports this alongside
  // the hook. A partial mock must list EVERY export the component touches, or the
  // import throws at render ("No 'leadSyncNoteOf' export is defined on the mock").
  leadSyncNoteOf: () => null,
  useTransitionLead: vi.fn(() => ({
    mutate: mocks.transitionMutate,
    isPending: false,
  })),
}));

vi.mock('@/lib/session', () => ({
  useSessionUser: sessionMock.useSessionUser,
  canScheduleVisits: () => true,
  canScheduleLeadVisit: () => true,
  // T-VISIT-OUTCOME-GATE (2026-09-16): the panel now gates each outcome button
  // on canLogVisitOutcome(role, outcome) instead of the panel-level
  // canScheduleVisits. This mock must provide it, or every outcome button
  // silently disappears and the offline-fallback tests below lose their target.
  canLogVisitOutcome: sessionMock.canLogVisitOutcome,
}));

vi.mock('@/lib/offline-store/queue-store', () => ({
  queue: { enqueueUnique: mocks.enqueueUnique },
}));

vi.mock('@/components/shared/ScheduleVisitDialog', () => ({
  ScheduleVisitDialog: () => null,
}));

vi.mock('@paalstack/react-ui', async (importOriginal) => {
  const actual = (await importOriginal()) as Record<string, unknown>;
  return {
    ...actual,
    toast: { success: vi.fn(), error: vi.fn() },
  };
});

import { LeadVisitPanel } from './LeadVisitPanel';
import { toast } from '@paalstack/react-ui';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT =
  true;

let container: HTMLDivElement | null = null;
let root: Root | null = null;

async function mount(): Promise<void> {
  await mountLead({ id: 'lead-1', status: 'VISIT_SCHEDULED' });
}

async function mountLead(lead: { id: string; status: string }): Promise<void> {
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
  await act(async () => {
    root?.render(<LeadVisitPanel lead={lead} />);
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

async function clickCompleted(): Promise<void> {
  const btn = container?.querySelector('[data-qa="visit-mark-completed"]');
  if (btn === null || btn === undefined) throw new Error('completed button not found');
  await act(async () => {
    btn.dispatchEvent(new MouseEvent('click', { bubbles: true }));
  });
}

afterEach(async () => {
  await unmount();
  mocks.mutate.mockReset();
  mocks.enqueueUnique.mockClear();
  vi.clearAllMocks();
});

// Default session for the offline-fallback suite below: an ADMIN who may record
// every outcome, mirroring lib/session.ts. The role-gate suite overrides these.
beforeEach(() => {
  sessionMock.useSessionUser.mockReturnValue({
    user: { id: 'u-1', name: 'A', email: 'a@x', role: 'ADMIN', teamId: null },
    isPending: false,
  });
  sessionMock.canLogVisitOutcome.mockReturnValue(true);
});

describe('LeadVisitPanel offline fallback (T-D4)', () => {
  it('transport failure on mutate → enqueues via enqueueUnique with dedupeKey + "Saved locally" toast', async () => {
    // Simulate the online mutation failing with the offline signal.
    mocks.mutate.mockImplementation((_body, handlers) => {
      handlers?.onError?.(new TypeError('Failed to fetch'));
    });

    await mount();
    await clickCompleted();

    // The enqueue happened with the right shape.
    expect(mocks.enqueueUnique).toHaveBeenCalledTimes(1);
    const call = (mocks.enqueueUnique.mock.calls as unknown as Array<
      [{ dedupeKey: string; endpoint: string; method: string; body: { visitId: string; outcome: string } }]
    >)[0];
    expect(call).toBeDefined();
    const arg = call![0];
    expect(arg.dedupeKey).toBe('outcome:visit-1:COMPLETED');
    expect(arg.endpoint).toBe('/visits/visit-1/outcome');
    expect(arg.method).toBe('PATCH');
    expect(arg.body.outcome).toBe('COMPLETED');
    // "Saved locally" toast, NOT the error toast.
    expect(toast.success).toHaveBeenCalledWith('Saved locally - will sync when online');
    expect(toast.error).not.toHaveBeenCalled();
  });

  it('4xx failure on mutate → error toast, NO enqueue (queue not poisoned)', async () => {
    mocks.mutate.mockImplementation((_body, handlers) => {
      handlers?.onError?.(new FakeApiError('API 409', 409));
    });

    await mount();
    await clickCompleted();

    expect(mocks.enqueueUnique).not.toHaveBeenCalled();
    expect(toast.error).toHaveBeenCalled();
    expect(toast.success).not.toHaveBeenCalledWith('Saved locally - will sync when online');
  });

  it('online success → success toast, NO enqueue', async () => {
    mocks.mutate.mockImplementation((_body, handlers) => {
      handlers?.onSuccess?.(undefined);
    });

    await mount();
    await clickCompleted();

    expect(mocks.enqueueUnique).not.toHaveBeenCalled();
    expect(toast.success).toHaveBeenCalledWith('Visit completed');
  });
});

/**
 * T-VISIT-OUTCOME-GATE (2026-09-16 owner ruling): the telecaller must never be
 * offered "Mark completed".
 *
 * Why this test exists: the panel used to gate all three outcome buttons on the
 * panel-level `canScheduleVisits`, which INCLUDES TELECALLER. A telecaller was
 * therefore shown "Mark completed", and clicking it moved the lead to VISITED -
 * a lifecycle action reserved for the exec (or manager/admin), refused by the
 * server. The correct per-outcome helper, `canLogVisitOutcome`, already existed
 * and encoded the ruling; it was simply never called. This pins the corrected
 * gate so the button cannot come back.
 */
describe('LeadVisitPanel - visit outcome role gate (T-VISIT-OUTCOME-GATE)', () => {
  it('a TELECALLER sees No-show but NOT Mark completed', async () => {
    sessionMock.useSessionUser.mockReturnValue({
      user: { id: 'u-1', name: 'A', email: 'a@x', role: 'TELECALLER' },
      isPending: false,
    });
    // Mirror the real helper: NO_SHOW is the telecaller's only outcome here.
    sessionMock.canLogVisitOutcome.mockImplementation(
      (_role: string | undefined, outcome: string) => outcome === 'NO_SHOW',
    );

    await mount();
    const html = container?.innerHTML ?? '';
    expect(html).toContain('No-show');
    expect(html).not.toContain('Mark completed');
  });

  it('a SALES_EXEC sees Mark completed (they conduct the visit)', async () => {
    sessionMock.useSessionUser.mockReturnValue({
      user: { id: 'u-1', name: 'A', email: 'a@x', role: 'SALES_EXEC' },
      isPending: false,
    });
    sessionMock.canLogVisitOutcome.mockImplementation(
      (_role: string | undefined, outcome: string) =>
        outcome === 'COMPLETED' || outcome === 'NO_SHOW' || outcome === 'CANCELLED',
    );

    await mount();
    const html = container?.innerHTML ?? '';
    expect(html).toContain('Mark completed');
  });
});

/**
 * T-VISIT-NO-SHOW-SCHEDULING (2026-09-30): the LEAD page must offer the same
 * re-engagement the queue does.
 *
 * The reported bug had two halves. The API refused a NO_SHOW lead
 * (`VisitsService.create`), AND this panel hid the Schedule button on exactly
 * that state (`status === 'VISIT_REQUESTED' || status === 'RESCHEDULED'`), so the
 * lead page offered nothing while the dashboard queue offered a button that
 * 400'd. Both now read `SCHEDULABLE_LEAD_STATES`.
 */
describe('LeadVisitPanel - Schedule visit is offered on every schedulable state', () => {
  it('offers Schedule visit on a NO_SHOW lead (the re-engagement)', async () => {
    // `useVisits` is mocked to return a SCHEDULED visit for 'lead-1', so this
    // also proves the schedule button is offered even when the mocked list has no
    // open visit for THIS lead id - the state is what decides.
    await mountLead({ id: 'lead-2', status: 'NO_SHOW' });
    const html = container?.innerHTML ?? '';
    expect(html).toContain('Schedule visit');
  });

  it('offers Schedule visit on VISIT_REQUESTED and RESCHEDULED too', async () => {
    await mountLead({ id: 'lead-2', status: 'VISIT_REQUESTED' });
    expect(container?.innerHTML ?? '').toContain('Schedule visit');
    await unmount();
    await mountLead({ id: 'lead-2', status: 'RESCHEDULED' });
    expect(container?.innerHTML ?? '').toContain('Schedule visit');
  });

  it('still offers NOTHING to schedule on a state that cannot accept a visit', async () => {
    // The other direction: widening the gate must not put a Schedule button on
    // a terminal or pre-visit lead.
    await mountLead({ id: 'lead-2', status: 'NEW' });
    expect(container?.innerHTML ?? '').not.toContain('Schedule visit');
  });
});

describe('LeadVisitPanel - repeat visit + back step (2026-10-09)', () => {
  function qa(name: string): Element | null {
    return container?.querySelector(`[data-qa="${name}"]`) ?? null;
  }

  async function click(name: string): Promise<void> {
    const el = qa(name);
    if (el === null) throw new Error(`${name} not found`);
    await act(async () => {
      el.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    });
  }

  it('offers "Request visit again" on a VISITED lead and moves it to VISIT_REQUESTED', async () => {
    await mountLead({ id: 'lead-2', status: 'VISITED' });
    expect(qa('lead-request-visit-again')).not.toBeNull();
    expect(qa('lead-schedule-visit')).toBeNull();
    await click('lead-request-visit-again');
    expect(mocks.transitionMutate).toHaveBeenCalledWith(
      expect.objectContaining({ leadId: 'lead-2', toState: 'VISIT_REQUESTED' }),
      expect.anything(),
    );
  });

  it('a SALES_EXEC can request the visit again', async () => {
    sessionMock.useSessionUser.mockReturnValue({
      user: { id: 'u-2', name: 'E', email: 'e@x', role: 'SALES_EXEC', teamId: null },
      isPending: false,
    });
    await mountLead({ id: 'lead-2', status: 'VISITED' });
    expect(qa('lead-request-visit-again')).not.toBeNull();
  });

  it('a TELECALLER is not offered "Request visit again" (VISITED is the exec lane)', async () => {
    sessionMock.useSessionUser.mockReturnValue({
      user: { id: 'u-3', name: 'T', email: 't@x', role: 'TELECALLER', teamId: null },
      isPending: false,
    });
    await mountLead({ id: 'lead-2', status: 'VISITED' });
    expect(qa('lead-request-visit-again')).toBeNull();
  });

  it('VISIT_REQUESTED shows Schedule visit and never the outcome/back controls', async () => {
    await mountLead({ id: 'lead-1', status: 'VISIT_REQUESTED' });
    expect(qa('lead-schedule-visit')).not.toBeNull();
    expect(qa('visit-mark-completed')).toBeNull();
    expect(qa('lead-back-to-visit-requested')).toBeNull();
    expect(qa('lead-request-visit-again')).toBeNull();
  });

  it('VISIT_SCHEDULED shows outcome + Back to Visit requested, never Schedule visit', async () => {
    await mountLead({ id: 'lead-1', status: 'VISIT_SCHEDULED' });
    expect(qa('lead-schedule-visit')).toBeNull();
    expect(qa('visit-mark-completed')).not.toBeNull();
    await click('lead-back-to-visit-requested');
    expect(mocks.transitionMutate).toHaveBeenCalledWith(
      expect.objectContaining({ leadId: 'lead-1', toState: 'VISIT_REQUESTED' }),
      expect.anything(),
    );
  });
});
