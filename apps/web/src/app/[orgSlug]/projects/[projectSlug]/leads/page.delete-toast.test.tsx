// Lead Inbox - delete confirmation must CONFIRM the outcome, not just close.
//
// The delete path reported failures with a toast but said nothing on success:
// the row vanished, the dialog closed, and the operator had no positive signal
// that the lead was actually gone (or which lead). This pins the success
// toast, including its use of the row name captured BEFORE the dialog closes.
//
// Mounted with createRoot + act: the flow is a click sequence (row action →
// confirm), so renderToStaticMarkup cannot reach it. Same harness as
// admin/users/page.test.tsx and inventory/row-actions-role.test.tsx.
import { act } from 'react';
import type { ReactNode } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, describe, expect, it, vi } from 'vitest';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const mocks = vi.hoisted(() => ({
  // (options) → the page's onSuccess/onError callbacks, invoked by the test.
  mutate: vi.fn(),
  toast: { success: vi.fn(), error: vi.fn() },
}));

type DeleteOptions = { onSuccess?: () => void; onError?: (error: unknown) => void };

vi.mock('next/navigation', () => ({
  useRouter: () => ({ replace: vi.fn(), push: vi.fn() }),
  useSearchParams: () => new URLSearchParams(''),
}));

vi.mock('next/link', () => ({
  default: ({ children, href }: { children: ReactNode; href: string }) => (
    <a href={href}>{children}</a>
  ),
}));

vi.mock('@/lib/tenant-context', () => ({
  useOrg: () => ({ id: 'org-1', slug: 'org-1', name: 'Org 1' }),
  useProject: () => ({ id: 'proj-1', slug: 'proj-1', name: 'Proj 1' }),
  useOrgId: () => 'org-1',
  useProjectId: () => 'proj-1',
  useOrgSlug: () => 'org-1',
  useProjectSlug: () => 'proj-1',
}));

vi.mock('@/lib/session', () => ({
  useSessionUser: () => ({
    user: { id: 'u-1', role: 'ADMIN', email: 'a@x', teamId: null },
    isPending: false,
  }),
  canDeleteLeads: () => true,
  canReassign: () => true,
}));

const LEAD_ROW = {
  id: 'lead-1',
  name: 'Priya Sharma',
  phone: '9876543210',
  status: 'CONTACTED',
  source: 'WEBSITE',
  ownerName: 'Admin',
  createdAt: new Date(Date.now() - 60 * 60_000).toISOString(),
  updatedAt: new Date().toISOString(),
};

vi.mock('@/hooks/queries/crm', async (importOriginal) => {
  const actual = await importOriginal<Record<string, unknown>>();
  return {
    ...actual,
    useLeads: () => ({ data: [LEAD_ROW], isLoading: false, error: null, refetch: vi.fn() }),
    useLeadsEnvelope: () => ({ total: 1, overdueCount: 0, newTodayCount: 0 }),
    useDeleteLead: () => ({ mutate: mocks.mutate, isPending: false }),
    useUpdateLead: () => ({ mutate: vi.fn(), isPending: false }),
  };
});

// The reassign dialog calls useReassignLead → useQueryClient, which throws
// without a QueryClientProvider. This suite is about the delete path, so the
// dialog is stubbed out (its own behaviour is covered by its own test).
vi.mock('@/components/leads/LeadReassignDialog', () => ({
  LeadReassignDialog: () => null,
}));

// The library's row menu opens a client-only popover and AlertDialog portals
// out of the tree; both are replaced with plain buttons so the click sequence
// stays assertable. Everything else in the library renders for real.
vi.mock('@paalstack/react-ui', async (importOriginal) => {
  const actual = await importOriginal<Record<string, unknown>>();

  function DataTableRowActions(props: {
    actionItems: { label: string; value: string; onClick: () => void }[];
  }): ReactNode {
    return (
      <div>
        {props.actionItems.map((item) => (
          <button
            key={item.value}
            type="button"
            data-qa={`row-action-${item.value}`}
            onClick={item.onClick}
          >
            {item.label}
          </button>
        ))}
      </div>
    );
  }

  function AlertDialog(props: {
    open?: boolean;
    confirmButtonText?: string;
    onConfirm?: () => void;
    onCancel?: () => void;
  }): ReactNode {
    if (props.open !== true) return null;
    return (
      <div>
        <button type="button" data-qa="alert-confirm" onClick={() => props.onConfirm?.()}>
          {props.confirmButtonText}
        </button>
        <button type="button" data-qa="alert-cancel" onClick={() => props.onCancel?.()}>
          Cancel
        </button>
      </div>
    );
  }

  return {
    ...actual,
    toast: mocks.toast,
    DataTableRowActions,
    AlertDialog,
  };
});

import LeadInboxPage from './page';

let container: HTMLDivElement | null = null;
let root: Root | null = null;

async function mount(): Promise<HTMLDivElement> {
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
  await act(async () => {
    root?.render(<LeadInboxPage />);
  });
  return container;
}

async function unmount(): Promise<void> {
  await act(async () => {
    root?.unmount();
  });
  root = null;
  container?.remove();
  container = null;
}

/** Click the element matching `selector`, failing loudly when it is absent. */
async function click(el: HTMLDivElement, selector: string): Promise<void> {
  const button = el.querySelector<HTMLButtonElement>(selector);
  if (button === null) throw new Error(`missing element: ${selector}`);
  await act(async () => {
    button.click();
  });
}

afterEach(async () => {
  await unmount();
  vi.clearAllMocks();
});

describe('Lead Inbox - delete confirm dialog', () => {
  it('shows a success toast naming the lead after a successful delete', async () => {
    // Success path: the mutation invokes the page's onSuccess immediately.
    mocks.mutate.mockImplementation((_arg: unknown, options?: DeleteOptions) => {
      options?.onSuccess?.();
    });

    const el = await mount();
    await click(el, '[data-qa="row-action-delete"]');
    await click(el, '[data-qa="alert-confirm"]');

    expect(mocks.mutate).toHaveBeenCalledTimes(1);
    expect(mocks.toast.success).toHaveBeenCalledWith('Lead Priya Sharma deleted');
    expect(mocks.toast.error).not.toHaveBeenCalled();
    // Dialog closes on success - the confirm button is gone.
    expect(el.querySelector('[data-qa="alert-confirm"]')).toBeNull();
  });

  it('does not show a success toast when the delete fails', async () => {
    mocks.mutate.mockImplementation((_arg: unknown, options?: DeleteOptions) => {
      options?.onError?.(new Error('Lead has an active booking'));
    });

    const el = await mount();
    await click(el, '[data-qa="row-action-delete"]');
    await click(el, '[data-qa="alert-confirm"]');

    expect(mocks.toast.error).toHaveBeenCalledWith('Lead has an active booking');
    expect(mocks.toast.success).not.toHaveBeenCalled();
  });
});
