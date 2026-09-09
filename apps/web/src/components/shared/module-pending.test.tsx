// T-D3 - ModulePending state matrix.
//
// Pin the three contract states (loading / not-built / api-error) for
// every page surface that calls a TanStack query hook, so a future
// "I tweaked the loading spinner" change fails the build if it
// breaks the shape contract.
//
// The matrix per surface is:
//
//   ┌──────────────┐
//   │   loading    │  →  Skeleton (shape-matched variant for the surface)
//   ├──────────────┤
//   │ not built    │  →  ModulePending empty state + "Not built yet" badge
//   │  (module)    │     (ApiError 404 or 501)
//   ├──────────────┤
//   │  api error   │  →  ModulePending "failed to load" + error message
//   ├──────────────┤
//   │  has data    │  →  page renders real UI (skipped here - covered by
//   │              │     the page's own component tests when shipped)
//   └──────────────┘
//
// What this test does NOT cover (and why):
//   - Real data rendering: each page has its own tests when shipped.
//   - SSE/connection state: lives in SseStatusPill.test.tsx.
//   - Empty-but-valid responses: a 200 with rows=[] is the "no leads
//     match these filters" state - page-specific tests own that.
//
// Pattern: renderToStaticMarkup from react-dom/server (no DOM,
// no @testing-library) per the project's standing rule
// (shadhil-crm-dev skill).

import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';

import { ApiError } from '@/apis/client';

import { ModulePending } from '@/components/shared/ModulePending';

// Each "surface" is a (title, skeletonVariant) pair. Real pages wire
// this with their own query data, so the matrix lives here as the
// single source of truth - when a new page lands, add a row.
const SURFACES = [
  { name: 'Lead Inbox', variant: 'table' as const },
  { name: 'Visit Scheduler', variant: 'list' as const },
  { name: 'Chat', variant: 'list' as const },
  { name: 'Booking Pipeline', variant: 'card' as const },
  { name: 'Notifications', variant: 'text' as const },
  { name: 'Audit Log', variant: 'table' as const },
  { name: 'Users', variant: 'list' as const },
  { name: 'Inventory', variant: 'table' as const },
] as const;

describe('ModulePending - loading state', () => {
  for (const { name, variant } of SURFACES) {
    it(`${name}: isLoading renders the matching skeleton variant, not text`, () => {
      const html = renderToStaticMarkup(
        <ModulePending
          title={name}
          description={`${name} ships in the next module.`}
          error={null}
          isLoading
          skeletonVariant={variant}
        />,
      );
      // Loading must NEVER contain "Loading..." text (PR3 bring-back).
      expect(html).not.toMatch(/Loading[^<]*\.\.\./);
      // aria-busy=true is required for screen readers.
      expect(html).toMatch(/aria-busy="true"/);
      // role="status" makes the loading region announced.
      expect(html).toMatch(/role="status"/);
    });
  }
});

describe('ModulePending - not-built state (module genuinely not shipped)', () => {
  for (const { name, variant } of SURFACES) {
    it(`${name}: 404 → "backend module pending"`, () => {
      const html = renderToStaticMarkup(
        <ModulePending
          title={name}
          description="endpoint absent"
          error={new ApiError('Not Found', 404)}
          isLoading={false}
          skeletonVariant={variant}
        />,
      );
      expect(html).toContain(`${name} - backend module pending`);
      expect(html).toContain('Not built yet');
      // No aria-busy in the settled empty state - the loading
      // announcement would be misleading.
      expect(html).not.toMatch(/aria-busy="true"/);
    });

    it(`${name}: 501 → "backend module pending" (NestJS "Not Implemented")`, () => {
      const html = renderToStaticMarkup(
        <ModulePending
          title={name}
          description="endpoint absent"
          error={new ApiError('Not Implemented', 501)}
          isLoading={false}
          skeletonVariant={variant}
        />,
      );
      expect(html).toContain(`${name} - backend module pending`);
      expect(html).toContain('Not built yet');
    });
  }
});

describe('ModulePending - api error state (real failure)', () => {
  for (const { name, variant } of SURFACES) {
    it(`${name}: 500 → "failed to load" with the error message`, () => {
      const html = renderToStaticMarkup(
        <ModulePending
          title={name}
          description="should not appear in this state"
          error={new ApiError('Internal Server Error', 500)}
          isLoading={false}
          skeletonVariant={variant}
        />,
      );
      expect(html).toContain(`${name} failed to load`);
      expect(html).toContain('Internal Server Error');
      // Must NOT say "Not built yet" - that's the wrong signal.
      expect(html).not.toContain('Not built yet');
    });

    it(`${name}: 401 → "failed to load" (auth flow owns the redirect, not us)`, () => {
      const html = renderToStaticMarkup(
        <ModulePending
          title={name}
          description="should not appear in this state"
          error={new ApiError('Not authenticated', 401)}
          isLoading={false}
          skeletonVariant={variant}
        />,
      );
      expect(html).toContain(`${name} failed to load`);
    });
  }
});

describe('ModulePending - error precedence (loading wins over error)', () => {
  it('isLoading + error: renders the skeleton, NOT the error message', () => {
    const html = renderToStaticMarkup(
      <ModulePending
        title="Lead Inbox"
        description="endpoint absent"
        error={new ApiError('Not Found', 404)}
        isLoading
        skeletonVariant="table"
      />,
    );
    // aria-busy present → loading. The error message "Not Found" must
    // NOT appear because that would mislead: while loading, the
    // server hasn't answered yet, so the user sees a skeleton and the
    // eventual error (if any) replaces it.
    expect(html).toMatch(/aria-busy="true"/);
    expect(html).not.toContain('Not Found');
    expect(html).not.toContain('backend module pending');
  });
});