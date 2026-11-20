'use client';

import { useEffect, useState } from 'react';

/**
 * True while the viewport matches `query`, false until the first effect runs.
 *
 * The initial `false` is deliberate: the server has no viewport, so a component
 * that rendered a different tree on its first client paint would be a hydration
 * mismatch rather than a responsive layout. Callers use it to drop optional
 * columns, so the fallback (render the full set) is the safe one.
 *
 * jsdom has no matchMedia. The optional call keeps every test that renders a
 * consumer of this hook working without a stub; tests that need the compact
 * branch define `window.matchMedia` themselves.
 */
export function useMediaQuery(query: string): boolean {
  const [matches, setMatches] = useState(false);

  useEffect(() => {
    const mql = window.matchMedia?.(query);
    if (mql === undefined || mql === null) return;

    const update = (): void => {
      setMatches(mql.matches);
    };
    update();
    mql.addEventListener('change', update);
    return () => {
      mql.removeEventListener('change', update);
    };
  }, [query]);

  return matches;
}
