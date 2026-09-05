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
import { afterEach, describe, expect, it, vi } from 'vitest';

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
    enqueueUnique: vi.fn(async () => ({ id: 'q-1', createdAt: 1 })),
  };
});

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
}));

vi.mock('@/lib/session', () => ({
  useSessionUser: vi.fn(() => ({
    user: { id: 'u-1', name: 'A', email: 'a@x', role: 'ADMIN', teamId: null },
    isPending: false,
  })),
  canScheduleVisits: () => true,
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
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
  await act(async () => {
    root?.render(<LeadVisitPanel lead={{ id: 'lead-1', status: 'VISIT_SCHEDULED' }} />);
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