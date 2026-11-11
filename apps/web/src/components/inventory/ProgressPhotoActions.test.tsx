// ProgressPhotoActions (slice 4, 2026-11-07; menu 2026-11-08).
//
// protects= the edit/delete controls appear only where the server's advisory
//           `canMutate` says this session may act, both actions are reachable
//           from the row's 44px menu, the caption editor saves a trimmed
//           caption, delete goes through a confirm, and a server error surfaces
//           its message instead of failing silently;
// fails_when= the controls render without canMutate, the menu renders without a
//           menu, the confirm is skipped, an empty caption is submitted, or an
//           error is swallowed;
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

import { NOTE_MAX_LENGTH } from './EditNoteDialog';
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
  stage: null,
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

/** Every element in the document carrying a data-qa, including menu popups
 *  (which render in a portal outside the mounted container). */
const byQa = (qa: string): HTMLElement | null =>
  document.querySelector<HTMLElement>(`[data-qa="${qa}"]`);

/**
 * Activate an element the way jsdom can, inside a synchronous `act`.
 *
 * Base UI's Menu opens on a click it can attribute to the trigger; a synthetic
 * pointer SEQUENCE did not open it here (the popup mounts into a portal and
 * never appeared), while a plain `.click()` does. Kept synchronous so the
 * portal has flushed by the time the next query runs.
 */
function press(el: HTMLElement): void {
  act(() => el.click());
}

/** Open the row's actions menu. Returns false when no trigger exists. */
function openMenu(): boolean {
  const trigger = byQa('progress-photo-menu-photo-1');
  if (trigger === null) return false;
  press(trigger);
  return true;
}

function clickQa(qa: string): void {
  const el = byQa(qa);
  if (el === null) throw new Error(`no element with data-qa="${qa}"`);
  press(el);
}

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
  it('protects= renders one 44px menu trigger when the server says this session may act', () => {
    const el = mount(photo({ canMutate: true }));
    const trigger = byQa('progress-photo-menu-photo-1');
    expect(trigger).not.toBeNull();
    // 44x44 minimum touch target.
    expect(trigger?.className).toContain('size-11');
    // The two always-on icon buttons are gone.
    expect(el.querySelector('[data-qa="progress-photo-edit-photo-1"]')).toBeNull();
  });

  it('fails_when= the controls render without server permission', () => {
    const el = mount(photo({ canMutate: false }));
    expect(el.innerHTML).toBe('');
    expect(byQa('progress-photo-menu-photo-1')).toBeNull();
  });

  it('fails_when= a buyer response renders staff controls', () => {
    const el = mount(photo({ canMutate: false }));
    expect(el.innerHTML).toBe('');
  });
});

describe('ProgressPhotoActions behaviour', () => {
  it('protects= both actions live behind the menu, not on the row', () => {
    mount(photo({ canMutate: true }));
    expect(openMenu()).toBe(true);
    expect(byQa('progress-photo-edit-photo-1')).not.toBeNull();
    expect(byQa('progress-photo-delete-photo-1')).not.toBeNull();
  });

  async function typeNote(value: string): Promise<void> {
    const input = byQa('edit-note-input') as HTMLTextAreaElement | null;
    expect(input).not.toBeNull();
    await act(async () => {
      const setter = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')?.set;
      setter?.call(input, value);
      input?.dispatchEvent(new Event('input', { bubbles: true }));
    });
  }

  async function submit(): Promise<void> {
    await act(async () => {
      byQa('edit-note-save')?.click();
    });
  }

  it('protects= Edit note opens a dialog and saves the trimmed caption', async () => {
    mount(photo({ canMutate: true }));
    openMenu();
    clickQa('progress-photo-edit-photo-1');

    expect(document.body.textContent).toContain('Edit note');
    await typeNote('  Plinth slab poured  ');
    await submit();

    expect(mocks.updatePhoto).toHaveBeenCalledWith(
      { photoId: 'photo-1', caption: 'Plinth slab poured' },
      expect.objectContaining({ onSuccess: expect.any(Function) }),
    );
    expect(mocks.toast.success).toHaveBeenCalled();
  });

  it('fails_when= a blank note reaches the server (zod must block it)', async () => {
    mount(photo({ canMutate: true }));
    openMenu();
    clickQa('progress-photo-edit-photo-1');
    await typeNote('   ');
    await submit();

    expect(mocks.updatePhoto).not.toHaveBeenCalled();
    expect(document.body.textContent).toContain('Write a note for this photo');
  });

  it('fails_when= an over-long note reaches the server', async () => {
    mount(photo({ canMutate: true }));
    openMenu();
    clickQa('progress-photo-edit-photo-1');
    await typeNote('x'.repeat(NOTE_MAX_LENGTH + 1));
    await submit();

    expect(mocks.updatePhoto).not.toHaveBeenCalled();
    expect(document.body.textContent).toContain('Keep the note under');
  });

  it('protects= Cancel closes the dialog without writing', async () => {
    mount(photo({ canMutate: true }));
    openMenu();
    clickQa('progress-photo-edit-photo-1');
    await act(async () => {
      byQa('edit-note-cancel')?.click();
    });
    expect(mocks.updatePhoto).not.toHaveBeenCalled();
    expect(byQa('edit-note-input')).toBeNull();
  });

  it('fails_when= delete fires without a confirmation step', () => {
    mount(photo({ canMutate: true }));
    openMenu();
    clickQa('progress-photo-delete-photo-1');

    // Choosing Delete opens the dialog; nothing is deleted yet.
    expect(mocks.deletePhoto).not.toHaveBeenCalled();
    expect(document.body.textContent).toContain('Delete this photo?');
    // The copy must say the buyer is affected, because a buyer may have seen it.
    expect(document.body.textContent).toContain('customer portal');
  });

  it('fails_when= a server denial is swallowed (the message must surface)', async () => {
    mocks.updatePhoto.mockImplementation(
      (_v: unknown, opts?: { onError?: (e: unknown) => void }) => {
        opts?.onError?.(new Error('Photo not found.'));
      },
    );
    mount(photo({ canMutate: true }));
    openMenu();
    clickQa('progress-photo-edit-photo-1');
    await submit();

    expect(mocks.toast.error).toHaveBeenCalledWith('Photo not found.');
  });
});
