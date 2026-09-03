// T25 (PR3) — useOnlineStatus + offline-aware skeleton wiring.
//
// Per locked decisions: when `!navigator.onLine && isLoading`, the
// skeleton surfaces a "Will sync when online" hint above the
// placeholder rows. This file pins the wiring via the
// `Skeleton.isOffline` prop contract.
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';

import { Skeleton } from './Skeleton';

describe('Skeleton.isOffline (T25)', () => {
  it('does NOT render the offline hint when isOffline is false', () => {
    const html = renderToStaticMarkup(
      <Skeleton variant="list" isOffline={false} />,
    );
    expect(html).not.toContain('Will sync when online');
    expect(html).not.toContain('data-qa="skeleton-offline-hint"');
  });

  it('does NOT render the offline hint when isOffline is omitted', () => {
    const html = renderToStaticMarkup(<Skeleton variant="list" />);
    expect(html).not.toContain('Will sync when online');
  });

  it('renders the offline hint above the list rows when isOffline is true', () => {
    const html = renderToStaticMarkup(
      <Skeleton variant="list" isOffline />,
    );
    expect(html).toContain('data-qa="skeleton-offline-hint"');
    expect(html).toContain('Will sync when online');
    // The hint must appear before the first <li> so the user reads
    // it first when the surface is offline + loading.
    const hintIdx = html.indexOf('Will sync when online');
    const firstLiIdx = html.indexOf('<li');
    expect(hintIdx).toBeGreaterThan(-1);
    expect(firstLiIdx).toBeGreaterThan(-1);
    expect(hintIdx).toBeLessThan(firstLiIdx);
  });

  it('only the list variant honors isOffline (other variants ignore it)', () => {
    // The "text" variant is a flat list of placeholder lines — the
    // offline hint is intentionally not shown there because the
    // surface is too small. (Documented in the Skeleton prop type.)
    const html = renderToStaticMarkup(
      <Skeleton variant="text" isOffline />,
    );
    expect(html).not.toContain('Will sync when online');
  });
});
