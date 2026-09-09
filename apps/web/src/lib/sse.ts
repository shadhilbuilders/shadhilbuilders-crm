// SSE helper - thin wrapper around the browser's EventSource with
// reconnect + ticket lifecycle.
//
// T-E2 (Week 6, 2026-09-04). The backend realtime module exposes
// ticket-authenticated SSE endpoints (POST /api/realtime/ticket to
// mint, GET /api/sse/<channel>?ticket=... to stream). This helper:
//
//   1. Fetches a ticket via POST /api/realtime/ticket (through the BFF)
//   2. Opens an EventSource to the SSE URL with the ticket
//   3. Tracks lastEventId per connection (the id of the last event
//      seen) so a reconnect can replay missed events
//   4. On error/close, reconnects with exponential backoff
//      (1s → 2s → 4s → ... → max 30s), re-minting the ticket when
//      needed (single-use tickets are consumed on connect)
//
// Returns a cleanup function that closes the connection and stops
// the reconnect loop. No external deps - the browser's EventSource
// is stable and spec-complete.
import { api } from '@/apis/client';

interface MintTicketResponse {
  ticket: string;
  channel: string;
  expiresAt: string;
}

const BASE_BACKOFF_MS = 1_000;
const MAX_BACKOFF_MS = 30_000;

/** True when a fetch was cancelled via AbortController (component teardown). */
export function isAbortError(err: unknown): boolean {
  return (
    err instanceof DOMException && err.name === 'AbortError'
  ) || (
    typeof err === 'object' &&
    err !== null &&
    (err as { name?: unknown }).name === 'AbortError'
  );
}

export interface OpenStreamOptions<T> {
  /** SSE path under /api/sse, e.g. "/notifications" or "/chat/<cuid>". */
  path: string;
  /** Channel string to mint ("notifications" | "audit" | "chat:<leadId>"). */
  channel: string;
  /** Called for every non-ping event payload. */
  onMessage: (data: T) => void;
  /** Optional: called on connection errors (after backoff exhaustion). */
  onError?: (err: unknown) => void;
}

/**
 * Open a ticket-authenticated SSE stream. Returns a cleanup function.
 */
export function openStream<T>(opts: OpenStreamOptions<T>): () => void {
  let closed = false;
  let source: EventSource | null = null;
  let backoffMs = BASE_BACKOFF_MS;
  let lastEventId: string | null = null;
  // T-PERF-2 #6: hoisted so the cleanup() return can abort the in-flight
  // ticket mint when a tab closes during the BFF round-trip.
  let connectAbort: AbortController | null = null;

  async function connect(): Promise<void> {
    if (closed) return;
    connectAbort = new AbortController();
    try {
      // 1. Mint a ticket (BFF-authed via the session cookie).
      const minted = await api<MintTicketResponse>('/realtime/ticket', {
        method: 'POST',
        json: { channel: opts.channel },
        signal: connectAbort.signal,
      });

      // If the tab was closed during the await, don't open an EventSource.
      if (closed) return;

      // 2. Open the SSE. EventSource can't set headers, so the ticket
      //    rides the query string. lastEventId rides with it (the
      //    backend replays from there on reconnect).
      const url =
        `/api/sse${opts.path}?ticket=${encodeURIComponent(minted.ticket)}` +
        (lastEventId !== null ? `&lastEventId=${encodeURIComponent(lastEventId)}` : '');
      source = new EventSource(url);

      source.onmessage = (ev: MessageEvent) => {
        // Reset backoff on any successful message (healthy stream).
        backoffMs = BASE_BACKOFF_MS;
        if (typeof ev.data === 'string' && ev.data.length > 0) {
          try {
            const payload = JSON.parse(ev.data) as { type?: string };
            if (payload.type === 'ping') return; // heartbeat - ignore
            opts.onMessage(payload as T);
            if (typeof ev.lastEventId === 'string' && ev.lastEventId.length > 0) {
              lastEventId = ev.lastEventId;
            }
          } catch {
            // Malformed JSON - skip the event, keep the stream open.
          }
        }
      };

      source.onerror = () => {
        // EventSource auto-reconnects natively, but the ticket is
        // single-use - the reconnect will 403. Close + re-mint on our
        // schedule instead.
        source?.close();
        source = null;
        if (closed) return;
        scheduleReconnect();
      };
    } catch (err) {
      // Ticket mint failed (e.g. 403 on channel access, backend down).
      if (closed) return;
      // An aborted mint is a component teardown, not a real failure - the
      // request may have reached the backend (which logs a 400 for the
      // half-sent body), but we must NOT reconnect or surface onError for
      // it. Silent teardown.
      if (isAbortError(err)) return;
      opts.onError?.(err);
      scheduleReconnect();
    }
  }

  function scheduleReconnect(): void {
    if (closed) return;
    setTimeout(() => {
      void connect();
    }, backoffMs);
    backoffMs = Math.min(backoffMs * 2, MAX_BACKOFF_MS);
  }

  void connect();
  return () => {
    closed = true;
    // T-PERF-2 #6: abort any in-flight ticket mint so a tab close
    // during the BFF round-trip doesn't leak an EventSource.
    connectAbort?.abort();
    source?.close();
    source = null;
  };
}