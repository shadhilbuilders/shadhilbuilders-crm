// Inline "Reason is required" error on the lead transition form.
//
// Previously an empty reason fired a toast; it now renders an ErrorMessage under
// the Reason textarea. Needs a MOUNTED tree (createRoot + act) because the
// behaviour is click -> state -> re-render; renderToStaticMarkup cannot click.
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const { mutate, toastError, sessionRole } = vi.hoisted(() => ({
  mutate: vi.fn(),
  toastError: vi.fn(),
  sessionRole: { value: 'ADMIN' },
}));

vi.mock('@/hooks/queries/crm', () => ({
  useTransitionLead: () => ({ mutate, isPending: false }),
  useUpdateLead: () => ({ mutate: vi.fn(), isPending: false }),
}));

vi.mock('@/lib/session', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/session')>();
  return {
    ...actual,
    useSessionUser: () => ({
      user: { id: 'u1', role: sessionRole.value },
      isPending: false,
    }),
  };
});

vi.mock('@/components/leads/LeadReassignDialog', () => ({ LeadReassignDialog: () => null }));
vi.mock('@/components/leads/LeadCoOwnerDialog', () => ({ LeadCoOwnerDialog: () => null }));

vi.mock('@paalstack/react-ui', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@paalstack/react-ui')>();
  return {
    ...actual,
    toast: Object.assign(actual.toast, { error: toastError, success: vi.fn() }),
  };
});

import { LeadActionPanel } from './LeadActionPanel';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let container: HTMLDivElement;
let root: Root;

async function mount(status: string): Promise<void> {
  await act(async () => {
    root.render(<LeadActionPanel lead={{ id: 'lead-1', name: 'Priya', status }} />);
  });
}

const q = (qa: string) => container.querySelector<HTMLElement>(`[data-qa="${qa}"]`);

async function click(el: HTMLElement | null): Promise<void> {
  if (el === null) throw new Error('element not found');
  await act(async () => {
    el.dispatchEvent(new MouseEvent('click', { bubbles: true }));
  });
}

async function typeReason(value: string): Promise<void> {
  const el = q('transition-reason') as HTMLTextAreaElement;
  const setter = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')!.set!;
  await act(async () => {
    setter.call(el, value);
    el.dispatchEvent(new Event('input', { bubbles: true }));
  });
}

beforeEach(() => {
  sessionRole.value = 'ADMIN';
  mutate.mockReset();
  toastError.mockReset();
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
});

afterEach(async () => {
  await act(async () => root.unmount());
  container.remove();
});

describe('transition reason - inline error', () => {
  it('shows the error inline (not a toast) when confirming LOST with no reason', async () => {
    await mount('CONTACTED');
    await click(q('transition-to-LOST'));
    expect(q('transition-reason-error')).toBeNull();

    await click(q('transition-confirm'));

    const err = q('transition-reason-error');
    expect(err).not.toBeNull();
    expect(err?.textContent).toContain('Reason is required when transitioning to');
    expect(q('transition-reason')?.getAttribute('aria-invalid')).toBe('true');
    const describedBy = q('transition-reason')?.getAttribute('aria-describedby');
    expect(describedBy).toBeTruthy();
    expect(container.querySelector(`#${describedBy}`)?.contains(err)).toBe(true);
    expect(document.activeElement).toBe(q('transition-reason'));
    expect(toastError).not.toHaveBeenCalled();
    expect(mutate).not.toHaveBeenCalled();
  });

  it('treats a whitespace-only reason as empty', async () => {
    await mount('CONTACTED');
    await click(q('transition-to-LOST'));
    await typeReason('   ');
    await click(q('transition-confirm'));

    expect(q('transition-reason-error')).not.toBeNull();
    expect(mutate).not.toHaveBeenCalled();
  });

  it('clears the error as soon as the user types', async () => {
    await mount('CONTACTED');
    await click(q('transition-to-LOST'));
    await click(q('transition-confirm'));
    expect(q('transition-reason-error')).not.toBeNull();

    await typeReason('price too high');

    expect(q('transition-reason-error')).toBeNull();
    expect(q('transition-reason')?.getAttribute('aria-invalid')).toBe('false');
  });

  it('submits with the trimmed reason once provided', async () => {
    await mount('CONTACTED');
    await click(q('transition-to-LOST'));
    await typeReason('  price too high ');
    await click(q('transition-confirm'));

    expect(mutate).toHaveBeenCalledTimes(1);
    expect(mutate.mock.calls[0]?.[0]).toMatchObject({
      leadId: 'lead-1',
      toState: 'LOST',
      reason: 'price too high',
    });
    expect(q('transition-reason-error')).toBeNull();
  });

  it('does not carry the error over after cancelling and re-picking a state', async () => {
    await mount('CONTACTED');
    await click(q('transition-to-LOST'));
    await click(q('transition-confirm'));
    expect(q('transition-reason-error')).not.toBeNull();

    const cancel = [...container.querySelectorAll('button')].find(
      (b) => b.textContent?.trim() === 'Cancel',
    );
    await click(cancel ?? null);
    await click(q('transition-to-LOST'));

    expect(q('transition-reason-error')).toBeNull();
  });

  it('uses the reopen wording when an admin reopens a closed lead', async () => {
    await mount('LOST');
    const reopenButton = container.querySelector<HTMLElement>('[data-qa^="transition-to-"]');
    await click(reopenButton);
    await click(q('transition-confirm'));

    expect(q('transition-reason-error')?.textContent).toContain(
      'Reason is required to reopen a closed lead',
    );
    expect(mutate).not.toHaveBeenCalled();
  });

  it('shows no reason field or error for a transition that needs no reason', async () => {
    await mount('NEW');
    await click(q('transition-to-CONTACTED'));

    expect(q('transition-reason')).toBeNull();
    expect(q('transition-reason-error')).toBeNull();
  });
});
