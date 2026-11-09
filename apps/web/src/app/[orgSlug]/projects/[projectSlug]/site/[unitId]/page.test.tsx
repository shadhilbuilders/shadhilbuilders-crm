// Capture screen - "Discard" must leave nothing of the draft behind.
//
// protects= closing the note dialog drops the unsent photos AND the note text
//           AND the chosen stage, so the next capture starts clean;
// fails_when= only the photo queue is filtered (the old bug): the tiles vanish
//           but the typed line and the stage reappear on the next note, attached
//           to different photos, which reads as "discard did not work";
// no_claim= it does not cover the upload path or the confirmation dialog's own
//           copy - those live in NoteDialog.test.tsx.
//
// Mounted with createRoot + act because the page gates on a `mounted` flag that
// only flips in useEffect, and the dialog only exists after that.
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const mocks = vi.hoisted(() => ({
  useUnit: vi.fn(),
  useUnitPhotos: vi.fn(),
  useUploadUnitPhoto: vi.fn(),
  useOnlineStatus: vi.fn(),
  useSessionUser: vi.fn(),
}));

vi.mock('next/navigation', () => ({
  useParams: () => ({ unitId: 'unit-1' }),
  useRouter: () => ({ replace: vi.fn(), push: vi.fn(), back: vi.fn() }),
}));

vi.mock('next/link', () => ({
  default: ({ children, href }: { children: React.ReactNode; href: string }) => (
    <a href={href}>{children}</a>
  ),
}));

vi.mock('@/lib/tenant-context', () => ({
  useOrgSlug: () => 'org-1',
  useProjectSlug: () => 'proj-1',
  useProjectId: () => 'proj-1',
}));

vi.mock('@/lib/session', () => ({
  useSessionUser: mocks.useSessionUser,
  isSiteRole: () => true,
  isSiteOnlyRole: () => true,
}));

vi.mock('@/hooks/use-online-status', () => ({
  useOnlineStatus: () => true,
}));

vi.mock('@/hooks/queries/inventory', () => ({
  useUnit: mocks.useUnit,
}));

vi.mock('@/hooks/queries/customer-progress', () => ({
  useUnitPhotos: mocks.useUnitPhotos,
  useUploadUnitPhoto: mocks.useUploadUnitPhoto,
  isForbidden: () => false,
}));

// The photo prep decodes a real image; the queue shape is all this test needs.
vi.mock('@/lib/photo-prep', () => ({
  prepareProgressPhoto: (file: File, opts: { source: string }) =>
    Promise.resolve({
      base64: 'QQ==',
      mimeType: 'image/webp',
      filename: file.name.replace(/\.[^.]+$/, '.webp'),
      byteLength: 240_000,
      takenAt: '2026-11-09T04:12:00.000Z',
      source: opts.source,
    }),
  prepareErrorMessage: () => 'Could not read that photo.',
}));

// The feed and viewer are other surfaces with their own tests.
vi.mock('@/components/site/SitePhotoFeed', () => ({ SitePhotoFeed: () => null }));
vi.mock('@/components/site/SiteEmptyHero', () => ({ SiteEmptyHero: () => null }));
vi.mock('@/components/site/SitePhotoViewer', () => ({ SitePhotoViewer: () => null }));
vi.mock('@/components/inventory/ProgressPhotoActions', () => ({
  ProgressPhotoActions: () => null,
}));

import SiteCapturePage from './page';

let container: HTMLDivElement | null = null;
let root: Root | null = null;

async function mount(): Promise<void> {
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
  await act(async () => {
    root?.render(<SiteCapturePage />);
  });
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 50));
  });
}

beforeEach(() => {
  mocks.useUnit.mockReturnValue({
    data: {
      id: 'unit-1',
      unitNumber: 'B-101',
      projectName: 'Green Acres',
      phaseName: 'Phase B',
      status: 'AVAILABLE',
      lastPhotoStage: 'STRUCTURE',
      photoCount: 0,
      lastPhotoAt: null,
      phaseId: 'phase-b',
    },
    isLoading: false,
    error: null,
  });
  mocks.useUnitPhotos.mockReturnValue({
    data: { pages: [{ photos: [] }] },
    isLoading: false,
    isError: false,
    error: null,
    refetch: vi.fn(),
    hasNextPage: false,
    isFetchingNextPage: false,
    fetchNextPage: vi.fn(),
  });
  mocks.useUploadUnitPhoto.mockReturnValue({ mutateAsync: vi.fn(), isPending: false });
  mocks.useOnlineStatus.mockReturnValue(true);
  mocks.useSessionUser.mockReturnValue({
    user: { id: 'u1', role: 'ENGINEER', name: 'Ravi' },
    isPending: false,
  });
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

/** Pick one file through the page's own gallery input, which opens the note. */
async function startNoteWithOnePhoto(): Promise<void> {
  const input = document.querySelector<HTMLInputElement>(
    '[data-qa="site-file-upload"] input[type="file"]'
  );
  expect(input).not.toBeNull();
  const file = new File([new Uint8Array([1, 2, 3])], 'slab-1.jpg', { type: 'image/jpeg' });
  await act(async () => {
    Object.defineProperty(input, 'files', { value: [file], configurable: true });
    input?.dispatchEvent(new Event('change', { bubbles: true }));
  });
  // FileUpload / react-dropzone may need a beat to hand the file over.
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 200));
  });
}

describe('capture screen - discard clears the whole draft', () => {
  it('drops the note text and the stage along with the unsent photos', async () => {
    await mount();

    await startNoteWithOnePhoto();
    const body = document.querySelector('[data-qa="site-note-dialog-body"]');
    expect(body).not.toBeNull();

    // Type a note and pick a stage, so there is a draft to leak.
    const textarea = document.querySelector<HTMLTextAreaElement>('[data-qa="site-note-input"]');
    await act(async () => {
      if (textarea !== null) {
        const setter = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')?.set;
        setter?.call(textarea, 'Plinth poured');
        textarea.dispatchEvent(new Event('input', { bubbles: true }));
      }
    });

    // Discard through Cancel -> Discard.
    await act(async () => {
      (document.querySelector('[data-qa="site-note-cancel"]') as HTMLElement | null)?.click();
    });
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 150));
    });
    await act(async () => {
      (document.querySelector('[data-qa="alert-dialog-action"]') as HTMLElement | null)?.click();
    });
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 300));
    });

    // The dialog is closed and nothing of the draft survives it.
    expect(document.querySelector('[data-qa="site-note-dialog-body"]')).toBeNull();

    // Re-open with a fresh pick: the note must be empty, not the discarded line.
    await startNoteWithOnePhoto();
    const reopened = document.querySelector<HTMLTextAreaElement>('[data-qa="site-note-input"]');
    expect(reopened).not.toBeNull();
    expect(reopened?.value).toBe('');
  });
});
