// ResendDeliveryButton (2026-11-26).
//
// protects= the staff row offers a retry ONLY for outcomes that did not reach
//           the buyer, the press posts to the row's own delivery id, the button
//           cannot be pressed twice while the request is in flight, and the
//           server's sentence is what the staff member reads - including a
//           refusal, which says which gate refused;
// fails_when= the control renders for SENT/DELIVERED/READ/PENDING or with no
//           delivery id, a double press queues two sends to one buyer, or the
//           API's reason is replaced by a generic "something went wrong";
// no_claim= does NOT exercise the gates. Whether a resend actually sends is the
//           server's decision, proven in
//           apps/backend/src/customer-progress/site-update-delivery.service.test.ts.
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const mocks = vi.hoisted(() => ({
  mutate: vi.fn(),
  toast: { success: vi.fn(), error: vi.fn() },
  pending: false,
}));

vi.mock('@/hooks/queries/customer-progress', () => ({
  useResendSiteUpdate: () => ({ mutate: mocks.mutate, isPending: mocks.pending }),
}));

vi.mock('@paalstack/react-ui', async (importOriginal) => {
  const actual = await importOriginal<Record<string, unknown>>();
  return { ...actual, toast: mocks.toast };
});

import { ResendDeliveryButton, isRetryableDelivery } from './ResendDeliveryButton';

let container: HTMLDivElement | null = null;
let root: Root | null = null;

function mount(): HTMLDivElement {
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
  act(() => {
    root?.render(
      <QueryClientProvider client={new QueryClient()}>
        <ResendDeliveryButton unitId="unit-1" deliveryId="sud-1" />
      </QueryClientProvider>,
    );
  });
  return container;
}

function unmount(): void {
  act(() => root?.unmount());
  container?.remove();
  container = null;
  root = null;
}

const button = (): HTMLElement | null =>
  document.querySelector<HTMLElement>('[data-qa="progress-resend"]');

beforeEach(() => {
  mocks.pending = false;
  mocks.mutate.mockReset();
  mocks.toast.success.mockReset();
  mocks.toast.error.mockReset();
});
afterEach(unmount);

describe('isRetryableDelivery', () => {
  it('offers a retry for every outcome that did not reach the buyer', () => {
    for (const status of [
      'SKIPPED_WINDOW',
      'SKIPPED_NO_TEMPLATE',
      'SKIPPED_NO_BUYER',
      'SKIPPED_NO_CONSENT',
      'SKIPPED_DISABLED',
      'FAILED',
    ]) {
      expect(isRetryableDelivery(status)).toBe(true);
    }
  });

  it('never offers one where a second send would be a duplicate', () => {
    // The buyer already has it, or the worker still owns it.
    for (const status of ['SENT', 'DELIVERED', 'READ', 'PENDING', null, undefined]) {
      expect(isRetryableDelivery(status)).toBe(false);
    }
  });
});

describe('ResendDeliveryButton', () => {
  it('posts the row it belongs to, not a batch or a photo', () => {
    mount();
    act(() => button()?.click());
    expect(mocks.mutate).toHaveBeenCalledTimes(1);
    expect(mocks.mutate.mock.calls[0]?.[0]).toBe('sud-1');
  });

  it("shows the server's sentence, refusal included", () => {
    mount();
    mocks.mutate.mockImplementation(
      (_id: string, opts?: { onSuccess?: (r: { status: string; message: string }) => void }) => {
        opts?.onSuccess?.({
          status: 'SKIPPED_NO_CONSENT',
          message: 'Not sent: the buyer has not opted in to marketing messages.',
        });
      },
    );
    act(() => button()?.click());
    // Refusal is the answer, not a failure: the words come from the server so
    // the row and the API cannot disagree about why nothing went out.
    expect(mocks.toast.success).toHaveBeenCalledWith(
      'Not sent: the buyer has not opted in to marketing messages.',
    );
    expect(mocks.toast.error).not.toHaveBeenCalled();
  });

  it('surfaces a transport or auth error as an error', () => {
    mount();
    mocks.mutate.mockImplementation((_id: string, opts?: { onError?: (e: unknown) => void }) => {
      opts?.onError?.(new Error('Network unreachable'));
    });
    act(() => button()?.click());
    expect(mocks.toast.error).toHaveBeenCalledWith('Network unreachable');
  });

  it('cannot be pressed twice while the request is in flight', () => {
    mocks.pending = true;
    mount();
    expect(button()?.hasAttribute('disabled')).toBe(true);
    expect(button()?.textContent).toContain('Sending');
  });
});
