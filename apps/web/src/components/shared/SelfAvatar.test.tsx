// SelfAvatar - the signed-in person's photo, one component for both account menus.
//
// What this pins, and why each one is a real contract:
//
//   1. The photo comes from the user-detail query, keyed by the SESSION id.
//      SessionUser carries no image, so a component that skips the query can
//      only ever show initials - which is exactly the bug the topbar had.
//   2. With no photo (null) or no answer yet (loading), the initials render, so
//      the bubble is never blank and never waits for the network to have a face.
//   3. The render URL is used AS GIVEN. The server resolves the storage key; the
//      browser must never build a media path of its own.
//
// The library Avatar renders its <img> only after the image LOADS and jsdom
// never loads one, so the real component would hide the thing under test. The
// double echoes the props SelfAvatar passes it (src + fallback), which is the
// contract this suite can honestly pin.
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  useSessionUser: vi.fn(),
  useUser: vi.fn(),
}));

vi.mock('@/lib/session', () => ({ useSessionUser: mocks.useSessionUser }));
vi.mock('@/hooks/queries/users', () => ({ useUser: mocks.useUser }));

vi.mock('@paalstack/react-ui', async () => {
  const actual = await vi.importActual<Record<string, unknown>>('@paalstack/react-ui');
  const react = await import('react');
  return {
    ...actual,
    Avatar: (props: { src?: string; fallback?: unknown }) =>
      react.createElement(
        'span',
        { 'data-qa': 'avatar-double', 'data-src': props.src ?? '' },
        props.fallback as never,
      ),
  };
});

import { SelfAvatar } from './SelfAvatar';

let container: HTMLDivElement;
let root: Root;

beforeEach(() => {
  mocks.useSessionUser.mockReturnValue({ user: { id: 'u-1', name: 'Priya Sharma' } });
  mocks.useUser.mockReturnValue({ data: undefined });
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
});

afterEach(async () => {
  await act(async () => {
    root.unmount();
  });
  container.remove();
  vi.clearAllMocks();
});

async function mount(name: string): Promise<void> {
  await act(async () => {
    root.render(<SelfAvatar name={name} />);
  });
}

function avatar(): HTMLElement {
  const node = container.querySelector<HTMLElement>('[data-qa="avatar-double"]');
  if (node === null) throw new Error('the avatar did not render');
  return node;
}

describe('SelfAvatar', () => {
  it('asks for the SELF row, using the id from the session', async () => {
    await mount('Priya Sharma');
    // Without this the photo can only come from a hardcoded or wrong id.
    expect(mocks.useUser).toHaveBeenCalledWith('u-1');
  });

  it('renders the server-resolved photo when the person has one', async () => {
    mocks.useUser.mockReturnValue({ data: { imageUrl: 'https://cdn.example/u-1.jpg' } });
    await mount('Priya Sharma');

    expect(avatar().getAttribute('data-src')).toBe('https://cdn.example/u-1.jpg');
  });

  it('renders initials when the person has no photo', async () => {
    mocks.useUser.mockReturnValue({ data: { imageUrl: null } });
    await mount('Priya Sharma');

    expect(avatar().getAttribute('data-src')).toBe('');
    expect(avatar().textContent).toBe('PS');
  });

  it('renders initials while the query has not answered yet', async () => {
    mocks.useUser.mockReturnValue({ data: undefined });
    await mount('Priya Sharma');

    expect(avatar().textContent).toBe('PS');
  });

  it('never renders a blank bubble for an empty name', async () => {
    await mount('   ');
    expect(avatar().textContent).toBe('?');
  });
});
