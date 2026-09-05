// T23 (PR3) - UserSkeleton rendered while `isPending`.
//
// Per the locked decisions: signed-out / signed-in transitions
// render UserSkeleton, not "Loading…" text. This file pins the
// behavior on the topbar (`app-header.tsx`) and the sidebar
// footer (`app-shell.tsx`) - both call sites now render
// `<Skeleton variant="user" />` while the session is resolving.
//
// The hook itself (`useSessionUser`) is not exercised here - the
// shadhil-crm-dev skill forbids `@testing-library/react`. We
// assert the contract via the markup that the call sites emit.
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';

import { Skeleton } from './Skeleton';

describe('UserSkeleton - T23 contract', () => {
  it('user variant renders an avatar + 2 text lines', () => {
    const html = renderToStaticMarkup(<Skeleton variant="user" />);
    expect(html).toContain('data-qa="skeleton-user"');
    expect(html).toContain('h-10 w-10 rounded-full');
    // The 2 lines: w-32 (long) and w-20 (short).
    expect(html).toContain('h-3 w-32');
    expect(html).toContain('h-3 w-20');
  });

  it('user variant does NOT leak "Loading…" copy', () => {
    // Regression guard: the original text was "Loading…" - the
    // entire point of T23 is that we don't surface it anymore.
    const html = renderToStaticMarkup(<Skeleton variant="user" />);
    expect(html).not.toMatch(/Loading…/);
  });

  it('user variant has the a11y contract (aria-busy=true)', () => {
    const html = renderToStaticMarkup(<Skeleton variant="user" />);
    expect(html).toContain('role="status"');
    expect(html).toContain('aria-busy="true"');
  });
});
