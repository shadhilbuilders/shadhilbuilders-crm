// useAgingTick - a coarse clock for row tints that age in real time.
//
// The leads table tints a NEW row yellow/red once it crosses 10/20/30 minutes
// since creation. Deriving that from `Date.now()` at render is correct only if
// something re-renders the row when the boundary passes - otherwise a lead that
// goes stale while the operator is looking at the page stays white until the
// next refetch, which is exactly when the tint matters most.
//
// This hook returns a counter that increments on an interval so the caller's
// `useMemo` recomputes. It does NOT return the time: callers read `Date.now()`
// themselves (pure `leadAgeTier(row, now)`), so the tier logic stays testable
// with an injected clock and this hook stays a dumb heartbeat.
//
// 30s because the smallest tier is 10 minutes: polling four times a minute keeps
// the worst-case lag at 30s (0.08% of the tier width) while costing nothing -
// one timer per mounted table, no network, no state beyond an integer.
import { useEffect, useState } from 'react';

export const AGING_TICK_MS = 30_000;

/**
 * @param enabled set false to stop the timer (e.g. when no row is NEW, or during
 *   tests) - an idle table should not hold a timer open.
 */
export function useAgingTick(enabled = true, intervalMs = AGING_TICK_MS): number {
  const [tick, setTick] = useState(0);

  useEffect(() => {
    if (!enabled) return;
    const id = setInterval(() => {
      setTick((t) => t + 1);
    }, intervalMs);
    return () => clearInterval(id);
  }, [enabled, intervalMs]);

  return tick;
}
