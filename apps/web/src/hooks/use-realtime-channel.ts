'use client';

// useRealtimeChannel — React hook wrapping the sse.ts helper.
//
// T-E2 (Week 6, 2026-09-04). Subscribes to a ticket-authenticated SSE
// channel for the lifetime of the component. On every non-ping event,
// invokes `onMessage` (typically a queryClient.invalidateQueries call
// so the TanStack Query cache refreshes and the page re-renders).
//
// Usage (inside a hook or component):
//   useRealtimeChannel(`chat:${leadId}`, () => {
//     void queryClient.invalidateQueries({ queryKey: ['chat', leadId] });
//   });
//
// The connection is opened once per (channel) value; changing the
// channel (e.g. navigating to a different lead) closes the old stream
// and opens a new one. Cleanup on unmount is automatic.
import { useEffect, useRef } from 'react';

import { openStream } from '@/lib/sse';

export function useRealtimeChannel(
  channel: string | null,
  onMessage: () => void,
): void {
  // Keep the latest callback in a ref so the effect doesn't re-run
  // (and re-open the stream) when the caller passes a new closure
  // every render.
  const onMessageRef = useRef(onMessage);
  useEffect(() => {
    onMessageRef.current = onMessage;
  }, [onMessage]);

  useEffect(() => {
    if (channel === null || channel.length === 0) return;
    // Guard: EventSource is a browser runtime global. jsdom (the vitest
    // environment) doesn't provide it, so unit tests that mount pages
    // with realtime subscriptions would crash on `new EventSource()`.
    // Skipping the subscription in non-browser runtimes is the honest
    // behavior — tests still exercise the query/mutation paths, and the
    // browser gets the live stream.
    if (typeof EventSource === 'undefined') return;
    const cleanup = openStream<unknown>({
      path: channel.startsWith('chat:')
        ? `/chat/${channel.slice('chat:'.length)}`
        : `/${channel}`,
      channel,
      onMessage: () => {
        onMessageRef.current();
      },
    });
    return cleanup;
  }, [channel]);
}