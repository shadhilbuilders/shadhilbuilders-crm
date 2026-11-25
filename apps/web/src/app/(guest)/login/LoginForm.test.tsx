// LoginForm - the phone path, the picker, and the one failure string.
//
// WHY THIS FILE EXISTS: the login rewrite (2026-11-21) shipped with backend and
// api-types coverage and NO web-side test, so the three things a person actually
// meets were unpinned: the resolver call, the account picker, and the wording of
// a refusal. Each case below is a behaviour the plan promises.
//
// The rules these guard:
//   1. ONE failure string for every outcome ("Invalid email, phone or
//      password."). A regression that starts naming which half was wrong turns
//      the form into an account-existence oracle.
//   2. The password never survives into the picker. It is held in a ref and the
//      field is cleared, because the picker is a second screen the person may
//      walk away from.
//   3. Back keeps the identifier and drops the password: the number was not the
//      problem, and retyping it is friction with no value.
//   4. A `?next=` redirect is honoured only when it is a same-origin path.
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { LoginIdentifierResult } from '@shadhil/api-types';

import { LoginForm } from './LoginForm';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const mocks = vi.hoisted(() => ({
  signIn: vi.fn(),
  assign: vi.fn(),
  toastError: vi.fn(),
  searchParams: new URLSearchParams(),
}));

vi.mock('@/lib/auth-client', () => ({
  authClient: { signIn: { email: mocks.signIn } },
}));

vi.mock('next/navigation', () => ({
  useSearchParams: () => mocks.searchParams,
}));

vi.mock('@/lib/env', () => ({
  env: { NEXT_PUBLIC_ORG_SIGNUP_ENABLED: false },
}));

// Partial mock: the form needs the real Card/Form/RadioGroup to render, and only
// `toast.error` is interesting (the failure string is part of the contract).
vi.mock('@paalstack/react-ui', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@paalstack/react-ui')>();
  return { ...actual, toast: { ...actual.toast, error: mocks.toastError } };
});

let root: Root | null = null;
let container: HTMLDivElement | null = null;

function mount(): HTMLDivElement {
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
  act(() => {
    root!.render(<LoginForm />);
  });
  return container;
}

/** React-controlled input, set the way a paste does: one native write + events. */
function setValue(input: HTMLInputElement, value: string): void {
  const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set;
  act(() => {
    setter?.call(input, value);
    input.dispatchEvent(new Event('input', { bubbles: true }));
    input.dispatchEvent(new Event('change', { bubbles: true }));
  });
}

function identifier(el: HTMLElement): HTMLInputElement {
  return el.querySelector<HTMLInputElement>('[data-qa="login-identifier"]')!;
}

function password(el: HTMLElement): HTMLInputElement {
  return el.querySelector<HTMLInputElement>('[data-qa="login-password"]')!;
}

async function submit(el: HTMLElement): Promise<void> {
  const button = el.querySelector<HTMLButtonElement>('button[type="submit"]')!;
  await act(async () => {
    button.click();
  });
  // Flush the resolver promise, the sign-in promise and the re-render after it.
  await act(async () => {
    await Promise.resolve();
  });
}

async function click(el: HTMLElement | null): Promise<void> {
  await act(async () => {
    el?.dispatchEvent(new MouseEvent('click', { bubbles: true }));
  });
  await act(async () => {
    await Promise.resolve();
  });
}

/** Answer the resolver with a JSON body, the way the BFF route does. */
function resolverReturns(result: LoginIdentifierResult | null): void {
  vi.stubGlobal(
    'fetch',
    vi.fn(async () =>
      result === null
        ? new Response(null, { status: 503 })
        : new Response(JSON.stringify(result), {
            status: 200,
            headers: { 'content-type': 'application/json' },
          }),
    ),
  );
}

beforeEach(() => {
  mocks.signIn.mockReset();
  mocks.signIn.mockResolvedValue({ error: null });
  mocks.assign.mockReset();
  mocks.toastError.mockReset();
  mocks.searchParams = new URLSearchParams();
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

describe('LoginForm - a single match signs in', () => {
  it('signs in with the email the resolver returns for a phone number', async () => {
    resolverReturns({ kind: 'ok', email: 'ramesh@example.in' });
    const el = mount();
    setValue(identifier(el), '9876543210');
    setValue(password(el), 'Passw0rd!x');

    await submit(el);

    expect(fetch).toHaveBeenCalledWith(
      '/api/public/auth/login-identifier',
      expect.objectContaining({
        method: 'POST',
        body: JSON.stringify({ identifier: '9876543210', password: 'Passw0rd!x' }),
      }),
    );
    expect(mocks.signIn).toHaveBeenCalledWith({
      email: 'ramesh@example.in',
      password: 'Passw0rd!x',
    });
    expect(mocks.assign).toHaveBeenCalledWith('/');
  });

  it('sends an email identifier to the same resolver, not straight to better-auth', async () => {
    resolverReturns({ kind: 'ok', email: 'asha@example.in' });
    const el = mount();
    setValue(identifier(el), 'asha@example.in');
    setValue(password(el), 'Passw0rd!x');

    await submit(el);

    expect(mocks.signIn).toHaveBeenCalledWith({ email: 'asha@example.in', password: 'Passw0rd!x' });
  });
});

describe('LoginForm - one failure string', () => {
  it('says the same thing for an invalid identifier as for a wrong password', async () => {
    resolverReturns({ kind: 'invalid' });
    const el = mount();
    setValue(identifier(el), '9876543210');
    setValue(password(el), 'wrong-password');

    await submit(el);

    expect(mocks.toastError).toHaveBeenCalledWith('Invalid email, phone or password.');
    expect(mocks.signIn).not.toHaveBeenCalled();
    // The password is spent; leaving it in the field invites a retry with it.
    expect(password(el).value).toBe('');
  });

  it('says the same thing when better-auth itself refuses the sign-in', async () => {
    resolverReturns({ kind: 'ok', email: 'ramesh@example.in' });
    mocks.signIn.mockResolvedValue({ error: { message: 'nope' } });
    const el = mount();
    setValue(identifier(el), 'ramesh@example.in');
    setValue(password(el), 'Passw0rd!x');

    await submit(el);

    expect(mocks.toastError).toHaveBeenCalledWith('Invalid email, phone or password.');
    expect(mocks.assign).not.toHaveBeenCalled();
  });

  it('separates a transport failure from a credential failure', async () => {
    resolverReturns(null);
    const el = mount();
    setValue(identifier(el), '9876543210');
    setValue(password(el), 'Passw0rd!x');

    await submit(el);

    // "Try again" is honest: the credentials were never judged.
    expect(mocks.toastError).toHaveBeenCalledWith('Could not sign in right now. Please try again.');
  });

  it('refuses a shape it cannot send, without calling the resolver', async () => {
    resolverReturns({ kind: 'invalid' });
    const el = mount();
    setValue(identifier(el), 'abc');
    setValue(password(el), 'Passw0rd!x');

    await submit(el);

    expect(fetch).not.toHaveBeenCalled();
    expect(mocks.toastError).not.toHaveBeenCalled();
  });
});

describe('LoginForm - the account picker', () => {
  const ACCOUNTS = [
    {
      userId: 'u1',
      name: 'Ramesh',
      email: 'ramesh@a.in',
      role: 'TELECALLER',
      organizationName: 'Org A',
      organizationSlug: 'org-a',
    },
    {
      userId: 'u2',
      name: 'Ramesh',
      email: 'ramesh@b.in',
      role: 'TELECALLER',
      organizationName: 'Org B',
      organizationSlug: 'org-b',
    },
  ];

  it('shows the picker and drops the password from the screen', async () => {
    resolverReturns({ kind: 'pick', accounts: ACCOUNTS });
    const el = mount();
    setValue(identifier(el), '9876543210');
    setValue(password(el), 'Passw0rd!x');

    await submit(el);

    expect(el.querySelector('[data-qa="login-account-list"]')).not.toBeNull();
    // Both organisations are on screen: that is how the person tells the rows apart.
    expect(el.textContent).toContain('Org A');
    expect(el.textContent).toContain('Org B');
    // The identifier field is gone and the password went with it.
    expect(el.querySelector('[data-qa="login-identifier"]')).toBeNull();
    expect(el.querySelector('[data-qa="login-password"]')).toBeNull();
    expect(mocks.signIn).not.toHaveBeenCalled();
  });

  it('signs in with the chosen account, reusing the password it never re-asks for', async () => {
    resolverReturns({ kind: 'pick', accounts: ACCOUNTS });
    const el = mount();
    setValue(identifier(el), '9876543210');
    setValue(password(el), 'Passw0rd!x');
    await submit(el);

    resolverReturns({ kind: 'ok', email: 'ramesh@b.in' });
    const radio = el.querySelector<HTMLInputElement>('input[type="radio"][value="u2"]');
    await click(radio);
    await click(el.querySelector('[data-qa="login-account-continue"]'));

    expect(fetch).toHaveBeenLastCalledWith(
      '/api/public/auth/login-identifier',
      expect.objectContaining({
        body: JSON.stringify({
          identifier: '9876543210',
          password: 'Passw0rd!x',
          accountUserId: 'u2',
        }),
      }),
    );
    expect(mocks.signIn).toHaveBeenCalledWith({ email: 'ramesh@b.in', password: 'Passw0rd!x' });
    expect(mocks.assign).toHaveBeenCalledWith('/');
  });

  it('Back keeps the number and drops the password', async () => {
    resolverReturns({ kind: 'pick', accounts: ACCOUNTS });
    const el = mount();
    setValue(identifier(el), '9876543210');
    setValue(password(el), 'Passw0rd!x');
    await submit(el);

    await click(el.querySelector('[data-qa="login-account-back"]'));

    expect(el.querySelector('[data-qa="login-account-list"]')).toBeNull();
    expect(identifier(el).value).toBe('9876543210');
    expect(password(el).value).toBe('');
  });

  it('a refused choice returns to the form rather than the picker', async () => {
    resolverReturns({ kind: 'pick', accounts: ACCOUNTS });
    const el = mount();
    setValue(identifier(el), '9876543210');
    setValue(password(el), 'Passw0rd!x');
    await submit(el);

    resolverReturns({ kind: 'invalid' });
    await click(el.querySelector<HTMLInputElement>('input[type="radio"][value="u1"]'));
    await click(el.querySelector('[data-qa="login-account-continue"]'));

    expect(mocks.toastError).toHaveBeenCalledWith('Invalid email, phone or password.');
    expect(el.querySelector('[data-qa="login-account-list"]')).toBeNull();
    expect(mocks.signIn).not.toHaveBeenCalled();
  });
});

describe('LoginForm - the redirect', () => {
  it('honours a same-origin next path', async () => {
    mocks.searchParams = new URLSearchParams('next=%2Fportal%3Funit%3Du1');
    resolverReturns({ kind: 'ok', email: 'ramesh@example.in' });
    const el = mount();
    setValue(identifier(el), '9876543210');
    setValue(password(el), 'Passw0rd!x');

    await submit(el);

    expect(mocks.assign).toHaveBeenCalledWith('/portal?unit=u1');
  });

  it('refuses an off-origin next path', async () => {
    mocks.searchParams = new URLSearchParams('next=%2F%2Fevil.example');
    resolverReturns({ kind: 'ok', email: 'ramesh@example.in' });
    const el = mount();
    setValue(identifier(el), '9876543210');
    setValue(password(el), 'Passw0rd!x');

    await submit(el);

    expect(mocks.assign).toHaveBeenCalledWith('/');
  });
});
