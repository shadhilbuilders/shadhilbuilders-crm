'use client';

// SSE connection-status pill.
//
// Eng review Section 1 P1 / T-D3: shows the user the realtime channel's
// connection state in one glance. The pill auto-connects to the
// heartbeat endpoint (`/api/sse/ping` via the BFF) and updates as the
// browser's EventSource state changes:
//
//   connecting  →  open            →  closed
//     ↓              ↓                 ↓
//   Connecting   Connected         Reconnecting (after retry)
//   (amber)      (green)           (red) → auto-reconnect
//
// Why a dedicated component (not just a useEffect in app-header):
//   - Self-contained retry/backoff logic - one place to tune.
//   - Testable in isolation (no app-header boilerplate).
//   - When real chat/notifications SSE streams ship, this pill stays
//     authoritative for "is realtime working" - consumers swap the
//     URL, the connection state machine is identical.
//
// The `SseStatusPill` deliberately does NOT consume library SSE
// primitives - there isn't one in @paalstack/react-ui v1.4.1, and a
// thin wrapper around EventSource is the honest primitive here.
// Connectivity is the source of truth; a library abstraction would add
// churn for no functional gain.

import { useEffect, useState } from 'react';
import { LuCircleAlert, LuCircleCheckBig, LuCircleDot } from '@paalstack/react-icons/lu';

export type SseConnectionState =
  | 'connecting'
  | 'open'
  | 'reconnecting'
  | 'offline';

type PillProps = {
  /** API path for the SSE heartbeat. Default: `/api/sse/ping`. */
  endpoint?: string;
  /** Disabled state - pill renders greyed-out, no connection. */
  disabled?: boolean;
  /** Class for the outer wrapper (size/positioning). */
  className?: string;
};

const STATE_LABELS: Record<SseConnectionState, string> = {
  connecting: 'Realtime connecting',
  open: 'Realtime connected',
  reconnecting: 'Realtime reconnecting',
  offline: 'Realtime offline',
};

const STATE_ARIA: Record<SseConnectionState, string> = {
  connecting: 'Connecting to realtime channel',
  open: 'Connected to realtime channel',
  reconnecting: 'Reconnecting to realtime channel',
  offline: 'Realtime channel offline',
};

export function SseStatusPill({
  endpoint = '/api/sse/ping',
  disabled = false,
  className,
}: PillProps) {
  const [state, setState] = useState<SseConnectionState>('connecting');

  useEffect(() => {
    if (disabled) {
      setState('offline');
      return;
    }
    if (typeof window === 'undefined') return;

    let source: EventSource | null = null;
    let reconnectTimer: ReturnType<typeof setTimeout> | null = null;
    let attempt = 0;
    let cancelled = false;

    const connect = (): void => {
      if (cancelled) return;
      setState(attempt === 0 ? 'connecting' : 'reconnecting');

      source = new EventSource(endpoint, { withCredentials: true });

      source.onopen = () => {
        attempt = 0;
        setState('open');
      };

      source.onerror = () => {
        // EventSource auto-reconnects internally after a network blip,
        // but if the endpoint returns 5xx or auth fails the source
        // emits error and stops. We close + reconnect ourselves with
        // exponential backoff so a transient outage recovers.
        source?.close();
        source = null;
        attempt += 1;
        if (attempt > 5) {
          setState('offline');
          return;
        }
        setState('reconnecting');
        const delay = Math.min(1000 * 2 ** (attempt - 1), 30_000);
        reconnectTimer = setTimeout(connect, delay);
      };
    };

    connect();

    return () => {
      cancelled = true;
      if (reconnectTimer !== null) clearTimeout(reconnectTimer);
      source?.close();
    };
  }, [endpoint, disabled]);

  return (
    <span
      role="status"
      aria-live="polite"
      aria-label={STATE_ARIA[state]}
      data-state={state}
      className={className ?? 'inline-flex items-center gap-1.5 text-sm'}
    >
      <SseStateIcon state={state} />
      <span className="sr-only sm:not-sr-only">{STATE_LABELS[state]}</span>
    </span>
  );
}

function SseStateIcon({ state }: { state: SseConnectionState }) {
  const className = 'size-4 shrink-0';
  switch (state) {
    case 'open':
      return <LuCircleCheckBig className={`${className} text-emerald-500`} aria-hidden />;
    case 'connecting':
    case 'reconnecting':
      return <LuCircleDot className={`${className} animate-pulse text-amber-500`} aria-hidden />;
    case 'offline':
      return <LuCircleAlert className={`${className} text-red-500`} aria-hidden />;
  }
}

// ── Test-only exports ────────────────────────────────────────────────────
// expose the pure connection-state machine so unit tests can exercise
// the backoff + transition logic without spinning up a real EventSource.
export const __test__ = {
  nextDelayMs(attempt: number): number {
    return Math.min(1000 * 2 ** Math.max(0, attempt - 1), 30_000);
  },
  shouldGiveUp(attempt: number): boolean {
    return attempt > 5;
  },
};