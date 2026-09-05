// Change-password page - skeleton loading branch (T-brand follow-up).
//
// The page has three render branches; this test pins the
// sessionPending one (Skeleton card mirroring the real form) plus the
// loading.tsx-style contract that the skeleton announces itself to
// assistive tech. The authenticated form branch needs a live session -
// covered by the in-browser verification + the users page test pattern.
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  useSessionUser: vi.fn(),
}));

vi.mock('@/lib/session', () => ({
  useSessionUser: mocks.useSessionUser,
}));

vi.mock('next/navigation', () => ({
  useRouter: () => ({ replace: vi.fn(), push: vi.fn(), refresh: vi.fn() }),
}));

// The zod hook imports - safe to import for real (no browser APIs needed
// at module top).
vi.mock('@hookform/resolvers/zod', () => ({
  zodResolver: () => () => Promise.resolve({ values: {}, errors: {} }),
}));

import ChangePasswordPage from './page';

describe('ChangePasswordPage - session-pending skeleton', () => {
  it('renders the AuthTopBar + card-shaped Skeleton while the session query is pending', () => {
    mocks.useSessionUser.mockReturnValue({ user: null, isPending: true });

    const html = renderToStaticMarkup(<ChangePasswordPage />);
    // Bar renders (brand stays visible during load).
    expect(html).toContain('data-qa="auth-topbar"');
    // The skeleton branch renders - with the accessible loading status.
    expect(html).toContain('data-qa="change-password-skeleton"');
    expect(html).toContain('aria-busy="true"');
    expect(html).toContain('Loading change password');
    // It uses the shared Skeleton shapes (multiple shimmer boxes), not
    // a plain "Loading…" paragraph.
    expect(html).toContain('data-skeleton-variant=');
    expect(html).not.toContain('Loading…');
  });

  it('skeleton mirrors the real form geometry (3 field rows + button row)', () => {
    mocks.useSessionUser.mockReturnValue({ user: null, isPending: true });

    const html = renderToStaticMarkup(<ChangePasswordPage />);
    // 3 field inputs → 3 h-11 card skeletons; 2 buttons → 2 h-9 chips.
    const h11 = html.match(/h-11/g)?.length ?? 0;
    expect(h11).toBeGreaterThanOrEqual(3);
    const h9 = html.match(/h-9/g)?.length ?? 0;
    expect(h9).toBeGreaterThanOrEqual(2);
  });
});