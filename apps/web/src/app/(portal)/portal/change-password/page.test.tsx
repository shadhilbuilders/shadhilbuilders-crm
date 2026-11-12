// /portal/change-password - the forced first-login rotation (spec D3).
//
// protects= the portal-themed skeleton while the session resolves, and that the
//           rendered screen offers exactly two actions: rotate, or sign out.
//           There must be NO Cancel (the guest page's Cancel routes to `/`,
//           which is the bounce loop this screen replaces) and no link out to
//           the guest /change-password.
// fails_when= a Cancel/reset-to-home path reappears, the submit stops being a
//           submit button, or the sign-out affordance disappears - each of
//           which either traps a gated buyer or lets one escape with the
//           temporary password still armed.
// no_claim= static markup only: no live session, no API call, no navigation.
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  useSessionUser: vi.fn(),
  signOut: vi.fn(),
}));

vi.mock('@/lib/session', () => ({ useSessionUser: mocks.useSessionUser }));
vi.mock('@/lib/auth-actions', () => ({ useSignOut: () => mocks.signOut }));
vi.mock('@hookform/resolvers/zod', () => ({
  zodResolver: () => () => Promise.resolve({ values: {}, errors: {} }),
}));

import PortalChangePasswordPage from './page';
import { PortalChangePasswordForm } from '@/components/portal/portal-change-password';

describe('PortalChangePasswordPage - session pending', () => {
  it('renders an accessible skeleton before the session resolves', () => {
    mocks.useSessionUser.mockReturnValue({ user: null, isPending: true });

    const html = renderToStaticMarkup(<PortalChangePasswordPage />);
    expect(html).toContain('data-qa="portal-change-password-skeleton"');
    expect(html).toContain('aria-busy="true"');
    expect(html).toContain('aria-live="polite"');
    // The real form must not flash before we know who is signed in.
    expect(html).not.toContain('data-qa="portal-change-password"');
  });
});

describe('PortalChangePasswordPage - gated buyer', () => {
  // The page renders the skeleton on the FIRST paint by design (hydration
  // safety), so the form is asserted through the exported
  // `PortalChangePasswordForm`, which is what the page swaps in once mounted.
  // Same split as ThemeToggleButton / PhotoLightboxPanel.
  const renderForm = (): string =>
    renderToStaticMarkup(<PortalChangePasswordForm userId="cust-1" />);

  it('offers the three password fields', () => {
    const html = renderForm();
    expect(html).toContain('data-qa="portal-change-password-old"');
    expect(html).toContain('data-qa="portal-change-password-new"');
    expect(html).toContain('data-qa="portal-change-password-confirm"');
  });

  // Owner direction (2026-11-10): no height overrides. Inputs and buttons take
  // the library's own defaults rather than a hand-picked 44px.
  it('keeps the library default control heights', () => {
    const html = renderForm();
    expect(html).not.toContain('min-h-11');
  });

  it('has a submit button - not a link, not an onClick handler', () => {
    const html = renderForm();
    expect(html).toContain('type="submit"');
    expect(html).toContain('data-qa="form-submit-button"');
    expect(html).toContain('Save and continue');
  });

  it('replaces Cancel with Sign out - the only way off the screen', () => {
    const html = renderForm();
    expect(html).toContain('Sign out instead');
    expect(html).toContain('data-qa="form-reset-button"');
    // The escape hatch this screen exists to close.
    expect(html).not.toContain('>Cancel<');
  });

  it('never links a buyer to the guest change-password page', () => {
    const html = renderForm();
    expect(html).not.toContain('href="/change-password"');
  });

  it('clears the iOS home indicator, since no bottom bar absorbs it', () => {
    const html = renderForm();
    expect(html).toContain('env(safe-area-inset-bottom)');
  });

  it('stacks its actions on a phone and un-stacks them at sm', () => {
    const html = renderForm();
    expect(html).toContain('flex-col-reverse');
    expect(html).toContain('sm:flex-row');
  });
});
