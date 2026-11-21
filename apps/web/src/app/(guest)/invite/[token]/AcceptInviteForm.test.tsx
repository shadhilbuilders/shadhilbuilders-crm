// AcceptInviteForm (2026-11-20).
//
// Two properties are load-bearing and are what these tests exist for:
//   1. There is NO email field. The address is pinned on the invite, so a
//      forwarded link cannot be claimed by someone else. A regression here is a
//      security regression, not a layout one.
//   2. A submission failure is PERSISTENT and INLINE, not a toast: on a phone a
//      toast vanishes before it is read and leaves the form looking broken.
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { PublicInvitePreview } from '@shadhil/api-types';

import { AcceptInviteForm } from './AcceptInviteForm';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const mocks = vi.hoisted(() => ({
  signIn: vi.fn().mockResolvedValue({ error: null }),
  assign: vi.fn(),
}));

vi.mock('@/lib/auth-client', () => ({
  authClient: { signIn: { email: mocks.signIn } },
}));

const PREVIEW: PublicInvitePreview = {
  organizationName: 'Shadhil Builders',
  organizationSlug: 'shadhil-builders',
  email: 'ramesh@example.in',
  phone: '919876543210',
  name: 'Ramesh Kumar',
  role: 'TELECALLER',
  teamName: 'Team Alpha',
  invitedByName: 'Admin',
  expiresAt: new Date(Date.now() + 86_400_000).toISOString(),
  status: 'PENDING',
};

let root: Root | null = null;
let container: HTMLDivElement | null = null;

function mount(): HTMLDivElement {
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
  act(() => {
    root!.render(<AcceptInviteForm token="tok123" preview={PREVIEW} />);
  });
  return container;
}

beforeEach(() => {
  mocks.signIn.mockReset();
  mocks.signIn.mockResolvedValue({ error: null });
  mocks.assign.mockReset();
  vi.stubGlobal('location', { ...window.location, assign: mocks.assign });
});

afterEach(() => {
  act(() => root?.unmount());
  container?.remove();
  root = null;
  container = null;
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe('AcceptInviteForm - the pinned email', () => {
  it('renders NO email input (the invite owns it)', () => {
    const el = mount();
    // A text input whose name is email would let a link be re-pointed at
    // another person - the exact thing pinning the address prevents.
    const emailInputs = el.querySelectorAll('input[type="email"], input[name="email"]');
    expect(emailInputs.length).toBe(0);
  });

  it('shows the address as read-only text with an aria-label', () => {
    const el = mount();
    const shown = el.querySelector('[data-qa="accept-email"]');
    expect(shown).not.toBeNull();
    expect(shown?.textContent).toContain('ramesh@example.in');
    // Labelled for a screen reader, and NOT a disabled input (which reads as
    // "something is wrong" rather than "this is what you are signing up with").
    expect(shown?.getAttribute('aria-label')).toBeTruthy();
    expect(shown?.tagName).not.toBe('INPUT');
  });
});

describe('AcceptInviteForm - phone correction', () => {
  it('prefills the phone from the invite in the 10-digit input form', () => {
    const el = mount();
    const phone = el.querySelector<HTMLInputElement>('[data-qa="accept-phone"]');
    // The stored form is 91XXXXXXXXXX; PhoneNumberInput caps at 10 digits, so a
    // 12-char prefill would be truncated by the first keystroke.
    expect(phone?.value).toBe('9876543210');
  });
});

/**
 * Fill the password fields and submit.
 *
 * Client-side validation runs BEFORE any request, so a bare submit never
 * reaches `fetch` - the tests would then assert against a zod message instead of
 * the server's coded failure. Setting values through React's own setter keeps
 * react-hook-form in sync.
 */
async function submitWithPassword(el: HTMLDivElement): Promise<void> {
  const setValue = (input: HTMLInputElement, value: string): void => {
    const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value')?.set;
    setter?.call(input, value);
    input.dispatchEvent(new Event('input', { bubbles: true }));
  };

  const password = el.querySelector<HTMLInputElement>('[data-qa="accept-password"]')!;
  const confirm = el.querySelector<HTMLInputElement>('[data-qa="accept-confirm-password"]')!;
  await act(async () => {
    setValue(password, 'password123');
    setValue(confirm, 'password123');
  });

  const form = el.querySelector<HTMLFormElement>('form')!;
  await act(async () => {
    form.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }));
    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();
  });
}

describe('AcceptInviteForm - submission failures are inline and persistent', () => {
  it('shows an inline alert for an expired invite', async () => {
    vi.stubGlobal(
      'fetch',
      vi
        .fn()
        .mockResolvedValue(
          new Response(JSON.stringify({ code: 'INVITE_EXPIRED' }), { status: 410 }),
        ),
    );

    const el = mount();
    await submitWithPassword(el);

    const alert = el.querySelector('[role="alert"]');
    expect(alert).not.toBeNull();
    expect(alert?.textContent).toContain('expired');
    // The form must still be usable, not replaced.
    expect(el.querySelector('form')).not.toBeNull();
  });

  it('names a phone collision and tells the user what to do', async () => {
    vi.stubGlobal(
      'fetch',
      vi
        .fn()
        .mockResolvedValue(
          new Response(JSON.stringify({ code: 'PHONE_ALREADY_EXISTS' }), { status: 409 }),
        ),
    );

    const el = mount();
    await submitWithPassword(el);

    expect(el.querySelector('[role="alert"]')?.textContent).toContain('phone number');
  });

  it('reports an unreachable server distinctly from a bad invite', async () => {
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new Error('network down')));

    const el = mount();
    await submitWithPassword(el);

    // An outage must not look like "your invite is invalid".
    expect(el.querySelector('[role="alert"]')?.textContent).toContain('reach the server');
  });
});
