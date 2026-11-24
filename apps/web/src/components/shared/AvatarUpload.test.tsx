// AvatarUpload - the settings photo control (2026-11-24).
//
// protects= upload-on-pick then save-the-key, the Remove path sending `null`, and
//           a decode failure that shows a message instead of pretending to work;
// fails_when= a picked file never reaches the profile, Remove stops clearing the
//           photo, or a HEIC quietly does nothing;
// no_claim= the real resize arithmetic and the storage route (mocked here; both
//           covered by image-resize.test.ts, users.service.update-self.test.ts and
//           the manual pass at 568x320).
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const mocks = vi.hoisted(() => ({
  mutate: vi.fn(),
  toastError: vi.fn(),
  toastSuccess: vi.fn(),
  uploadToMedia: vi.fn(),
  resize: vi.fn(),
}));

vi.mock('@/hooks/queries/users', () => ({
  useUpdateProfile: () => ({ mutate: mocks.mutate, isPending: false }),
}));

vi.mock('@/hooks/queries/crm', () => ({ uploadToMedia: mocks.uploadToMedia }));

vi.mock('@/lib/image-resize', async () => {
  const actual = await vi.importActual<typeof import('@/lib/image-resize')>('@/lib/image-resize');
  return { ...actual, resizeToSquareJpeg: mocks.resize };
});

vi.mock('@paalstack/react-ui', async () => {
  const actual = await vi.importActual<Record<string, unknown>>('@paalstack/react-ui');
  const react = await import('react');
  return {
    ...actual,
    toast: { error: mocks.toastError, success: mocks.toastSuccess },
    // Radix renders <img> only after a real load, which jsdom never performs.
    // Echo the props instead: the wiring (which URL, which fallback) is the
    // contract here, and the browser path is covered by the manual pass.
    Avatar: (props: { src?: string; fallback?: unknown }) =>
      react.createElement(
        'span',
        { 'data-qa': 'avatar-double', 'data-src': props.src ?? '' },
        props.fallback as never,
      ),
  };
});

import { AvatarUpload } from './AvatarUpload';

let container: HTMLDivElement | null = null;
let root: Root | null = null;

async function mount(props: { imageUrl?: string | null; name?: string } = {}): Promise<void> {
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
  await act(async () => {
    root?.render(
      <AvatarUpload
        name={props.name ?? 'Deepak Owner'}
        imageUrl={props.imageUrl ?? null}
        onSaved={async () => undefined}
      />,
    );
  });
}

afterEach(async () => {
  await act(async () => {
    root?.unmount();
  });
  root = null;
  container?.remove();
  container = null;
});

beforeEach(() => {
  vi.clearAllMocks();
});

const buttonTexts = (): string[] =>
  Array.from(container?.querySelectorAll('button') ?? []).map((b) => b.textContent ?? '');

describe('AvatarUpload', () => {
  it('offers "Add photo" and no Remove when the account has none', async () => {
    await mount({ imageUrl: null });

    expect(buttonTexts().some((t) => t.includes('Add photo'))).toBe(true);
    expect(buttonTexts().some((t) => t.includes('Remove'))).toBe(false);
    // The fallback initials are what renders in the bubble.
    expect(container?.textContent).toContain('DO');
  });

  it('shows the current photo and offers Remove', async () => {
    await mount({ imageUrl: 'https://cdn.test/org/a.webp' });

    expect(container?.querySelector('[data-qa="avatar-double"]')?.getAttribute('data-src')).toBe(
      'https://cdn.test/org/a.webp',
    );
    expect(buttonTexts().some((t) => t.includes('Change photo'))).toBe(true);
    expect(buttonTexts().some((t) => t.includes('Remove'))).toBe(true);
  });

  it('remove sends avatarKey null and never touches storage', async () => {
    await mount({ imageUrl: 'https://cdn.test/org/a.webp' });

    const remove = Array.from(container?.querySelectorAll('button') ?? []).find((b) =>
      (b.textContent ?? '').includes('Remove'),
    );
    await act(async () => {
      remove?.click();
    });

    expect(mocks.mutate).toHaveBeenCalledTimes(1);
    expect(mocks.mutate.mock.calls[0]?.[0]).toEqual({ avatarKey: null });
    expect(mocks.uploadToMedia).not.toHaveBeenCalled();
  });

  it('a picked file uploads, then saves the returned key', async () => {
    mocks.resize.mockResolvedValue(new Blob([new Uint8Array([1, 2, 3])], { type: 'image/jpeg' }));
    mocks.uploadToMedia.mockResolvedValue({ key: '/org/abc/avatar.jpg', mimeType: 'image/jpeg' });

    await mount({ imageUrl: null });

    const input = container?.querySelector('input[type="file"]') as HTMLInputElement;
    const file = new File([new Uint8Array([9, 9, 9])], 'face.png', { type: 'image/png' });
    Object.defineProperty(input, 'files', { value: [file], configurable: true });
    await act(async () => {
      input.dispatchEvent(new Event('change', { bubbles: true }));
    });

    expect(mocks.resize).toHaveBeenCalledTimes(1);
    expect(mocks.uploadToMedia).toHaveBeenCalledTimes(1);
    // The avatar is uploaded as the re-encoded JPEG, not the raw camera file.
    expect((mocks.uploadToMedia.mock.calls[0]?.[0] as File).type).toBe('image/jpeg');
    expect(mocks.mutate.mock.calls[0]?.[0]).toEqual({ avatarKey: '/org/abc/avatar.jpg' });
  });

  it('a file the browser cannot decode is reported, and nothing is saved', async () => {
    const { AvatarImageError } =
      await vi.importActual<typeof import('@/lib/image-resize')>('@/lib/image-resize');
    mocks.resize.mockRejectedValue(
      new AvatarImageError('decode-failed', 'That image could not be read.'),
    );

    await mount({ imageUrl: null });

    const input = container?.querySelector('input[type="file"]') as HTMLInputElement;
    // A HEIC that the browser cannot read, and which is far too big to send raw.
    const file = new File([new Uint8Array(20 * 1024 * 1024)], 'face.heic', { type: 'image/heic' });
    Object.defineProperty(input, 'files', { value: [file], configurable: true });
    await act(async () => {
      input.dispatchEvent(new Event('change', { bubbles: true }));
    });

    expect(mocks.uploadToMedia).not.toHaveBeenCalled();
    expect(mocks.mutate).not.toHaveBeenCalled();
    expect(mocks.toastError).toHaveBeenCalledWith(expect.stringContaining('could not be read'));
  });
});
