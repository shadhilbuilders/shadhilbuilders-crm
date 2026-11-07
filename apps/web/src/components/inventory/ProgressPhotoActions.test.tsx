// ProgressPhotoActions (slice 4, 2026-11-07).
//
// protects= the edit/delete controls appear only where the server's advisory
//           `canMutate` says this session may act, the caption editor saves a
//           trimmed caption, delete goes through a confirm, and a server error
//           surfaces its message instead of failing silently;
// fails_when= the controls render without canMutate, the confirm is skipped,
//           an empty caption is submitted, or an error is swallowed;
// no_claim= does NOT exercise authority. The server answers 404 for an actor
//           who may not touch the row (RLS), proven in
//           customer-progress.photo-mutation.test.ts and the DB suites.
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const mocks = vi.hoisted(() => ({
  updatePhoto: vi.fn(),
  deletePhoto: vi.fn(),
  toast: { success: vi.fn(), error: vi.fn() },
}));

vi.mock('@/hooks/queries/customer-progress', () => ({
  useUpdatePhoto: () => ({ mutate: mocks.updatePhoto, isPending: false }),
  useDeletePhoto: () => ({ mutate: mocks.deletePhoto, isPending: false }),
}));

vi.mock('@paalstack/react-ui', async (importOriginal) => {
  const actual = await importOriginal<Record<string, unknown>>();
  return { ...actual, toast: mocks.toast };
});

import { ProgressPhotoActions } from './ProgressPhotoActions';
import type { TimelinePhoto } from '@/hooks/queries/customer-progress';

const photo = (over: Partial<TimelinePhoto> = {}): TimelinePhoto => ({
  id: 'photo-1',
  unitId: 'unit-1',
  phaseId: 'ph1',
  phaseName: 'Foundation',
  mimeType: 'image/jpeg',
  filename: 'site.jpg',
  caption: 'Foundation October 2026',
  takenAt: '2026-10-01T00:00:00.000Z',
  createdAt: '2026-10-01T00:00:00.000Z',
  creatorName: 'Ravi',
  creatorIsPhotoLead: false,
  mediaUrl: '/api/bff/media/x',
  canMutate: false,
  ...over,
});

let container: HTMLDivElement | null = null;
let root: Root | null = null;

function mount(p: TimelinePhoto): HTMLDivElement {
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
  const qc = new QueryClient();
  act(() => {
    root?.render(
      <QueryClientProvider client={qc}>
        <ProgressPhotoActions photo={p} unitId="unit-1" />
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

const q = (el: HTMLElement, qa: string): HTMLButtonElement | null =>
  el.querySelector<HTMLButtonElement>(`[data-qa="${qa}"]`);

beforeEach(() => {
  vi.clearAllMocks();
  mocks.updatePhoto.mockImplementation((_v: unknown, opts?: { onSuccess?: () => void }) => {
    opts?.onSuccess?.();
  });
  mocks.deletePhoto.mockImplementation((_v: unknown, opts?: { onSuccess?: () => void }) => {
    opts?.onSuccess?.();
  });
});

afterEach(() => unmount());

describe('ProgressPhotoActions visibility', () => {
  it('protects= renders both controls when the server says this session may act', () => {
    const el = mount(photo({ canMutate: true }));
    expect(q(el, 'progress-photo-edit-photo-1')).not.toBeNull();
    expect(q(el, 'progress-photo-delete-photo-1')).not.toBeNull();
  });

  it('fails_when= the controls render without server permission', () => {
    const el = mount(photo({ canMutate: false }));
    expect(el.innerHTML).toBe('');
  });

  it('fails_when= a buyer response renders staff controls', () => {
    const el = mount(photo({ canMutate: false }));
    expect(el.innerHTML).toBe('');
  });
});

describe('ProgressPhotoActions behaviour', () => {
  it('protects= editing saves the trimmed caption and closes the editor', () => {
    const el = mount(photo({ canMutate: true }));
    act(() => q(el, 'progress-photo-edit-photo-1')?.click());

    const input = el.querySelector<HTMLInputElement>('[data-qa="progress-caption-input-photo-1"]');
    expect(input).not.toBeNull();
    act(() => {
      // React tracks the native setter; assign through the property descriptor.
      const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set;
      setter?.call(input, '  Plinth slab poured  ');
      input?.dispatchEvent(new Event('input', { bubbles: true }));
    });
    act(() => q(el, 'progress-caption-save-photo-1')?.click());

    expect(mocks.updatePhoto).toHaveBeenCalledWith(
      { photoId: 'photo-1', caption: 'Plinth slab poured' },
      expect.objectContaining({ onSuccess: expect.any(Function) }),
    );
    expect(mocks.toast.success).toHaveBeenCalled();
  });

  it('fails_when= an empty caption is submitted', () => {
    const el = mount(photo({ canMutate: true }));
    act(() => q(el, 'progress-photo-edit-photo-1')?.click());
    const input = el.querySelector<HTMLInputElement>('[data-qa="progress-caption-input-photo-1"]');
    act(() => {
      const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set;
      setter?.call(input, '   ');
      input?.dispatchEvent(new Event('input', { bubbles: true }));
    });
    // The save control is disabled, so a click cannot dispatch a bad write.
    expect(q(el, 'progress-caption-save-photo-1')?.hasAttribute('disabled')).toBe(true);
  });

  it('protects= Escape abandons the edit without writing', () => {
    const el = mount(photo({ canMutate: true }));
    act(() => q(el, 'progress-photo-edit-photo-1')?.click());
    const input = el.querySelector<HTMLInputElement>('[data-qa="progress-caption-input-photo-1"]');
    act(() => {
      input?.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
    });
    expect(mocks.updatePhoto).not.toHaveBeenCalled();
    expect(q(el, 'progress-photo-edit-photo-1')).not.toBeNull();
  });

  it('fails_when= delete fires without a confirmation step', () => {
    const el = mount(photo({ canMutate: true }));
    act(() => q(el, 'progress-photo-delete-photo-1')?.click());

    // Clicking the icon opens the dialog; nothing is deleted yet.
    expect(mocks.deletePhoto).not.toHaveBeenCalled();
    expect(document.body.textContent).toContain('Delete this photo?');
    // The copy must say the buyer is affected, because a buyer may have seen it.
    expect(document.body.textContent).toContain('customer portal');
  });

  it('fails_when= a server denial is swallowed (the message must surface)', () => {
    mocks.updatePhoto.mockImplementation(
      (_v: unknown, opts?: { onError?: (e: unknown) => void }) => {
        opts?.onError?.(new Error('Photo not found.'));
      },
    );
    const el = mount(photo({ canMutate: true }));
    act(() => q(el, 'progress-photo-edit-photo-1')?.click());
    act(() => q(el, 'progress-caption-save-photo-1')?.click());

    expect(mocks.toast.error).toHaveBeenCalledWith('Photo not found.');
  });
});
