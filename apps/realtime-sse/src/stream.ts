// Stream pipeline — the working SSE pattern.
//
// T-E2 fix (2026-09-04). The exact shape that the diagnostic evidence
// in /tmp/backend-diag*.log (2026-09-04) and the working
// @Sse('sse/ping') canary proved to flush frames: setup all async
// resources BEFORE responding, then once headers are committed, drive
// the writes synchronously from setInterval. No async work after
// res.writeHead().
//
// THREE channels, three slightly different fetchers, but a shared
// write loop. The fetcher is a closure that returns a Promise<Frame[]>;
// the loop calls it on every DB_TICK_MS and writes each frame.

import type { PrismaClient } from '@shadhil/database';
import type { IncomingMessage, ServerResponse } from 'node:http';

import { config } from './config.js';

/** A single SSE frame ready to be serialized onto the socket. */
export interface SseFrame {
  /** Last-Event-ID value (omit for heartbeats). */
  id?: string;
  /** JSON-serializable payload. */
  data: unknown;
  /** SSE event name (default 'message'). */
  event?: string;
}

/** A channel-specific fetcher: given the last seen timestamp, return
 *  all frames newer than that timestamp. Called every DB_TICK_MS. */
export type Fetcher = (lastSeenAt: Date) => Promise<SseFrame[]>;

/** SSE response framing helpers — kept tiny and pure. */
export function writeFrame(res: ServerResponse, frame: SseFrame): void {
  if (frame.id !== undefined) res.write(`id: ${frame.id}\n`);
  if (frame.event !== undefined) res.write(`event: ${frame.event}\n`);
  res.write(`data: ${JSON.stringify(frame.data)}\n\n`);
}

/** Open the SSE response. Writes headers + initial comment + a
 *  `:ok` frame the client can use to confirm the stream is live. */
export function openStream(res: ServerResponse): void {
  res.writeHead(200, {
    'Content-Type': 'text/event-stream; charset=utf-8',
    'Cache-Control': 'no-cache, no-transform',
    Connection: 'keep-alive',
    // Disable Nginx response buffering (default in dev; prod sets it in
    // the reverse proxy block).
    'X-Accel-Buffering': 'no',
  });
  res.write(': stream-open\n\n');
}

/** Run the live poll loop. Returns a teardown function that the caller
 *  MUST invoke when the client disconnects (res.on('close', teardown)). */
export function startLiveLoop(
  res: ServerResponse,
  fetcher: Fetcher,
  state: { lastSeenAt: Date },
): () => void {
  let stopped = false;

  const tick = (): void => {
    if (stopped) return;
    fetcher(state.lastSeenAt)
      .then((frames) => {
        if (stopped) return;
        for (const f of frames) {
          // Advance lastSeenAt to the id of the last frame (frames are
          // ordered ascending by creation time by the fetcher).
          writeFrame(res, f);
        }
        if (frames.length > 0 && frames[frames.length - 1]!.id !== undefined) {
          // Use the frame's id as the new anchor; the id is the row cuid
          // which sorts lexicographically by creation time. We update
          // lastSeenAt separately on the fetcher side using createdAt
          // for correctness, but lastSeenAt is consumed by the fetcher
          // so it has to be a Date — we keep it monotonic per fetch.
          state.lastSeenAt = new Date();
        }
      })
      .catch((err: unknown) => {
        if (stopped) return;
        // eslint-disable-next-line no-console
        console.error('[sse] tick failed:', err instanceof Error ? err.message : err);
      });
  };

  const tickTimer = setInterval(tick, config.dbTickMs);
  const heartbeatTimer = setInterval(() => {
    if (!stopped) res.write(': keep-alive\n\n');
  }, config.heartbeatMs);

  // First tick immediately so the backlog is flushed without waiting
  // DB_TICK_MS.
  tick();

  return () => {
    stopped = true;
    clearInterval(tickTimer);
    clearInterval(heartbeatTimer);
  };
}

/** Ticket consume — port of apps/backend's RealtimeService.consumeTicket.
 *  Single-use, returns the bound userId + channel. Throws on invalid /
 *  expired / channel-mismatch. */
export async function consumeTicket(
  prisma: PrismaClient,
  rawTicket: string,
  expectedChannel: string,
): Promise<{ userId: string; channel: string }> {
  const ticket = await prisma.streamTicket.findUnique({
    where: { id: rawTicket },
    select: { id: true, userId: true, channel: true, expiresAt: true },
  });
  if (ticket === null) throw new HttpError(403, 'invalid ticket');
  if (ticket.expiresAt.getTime() < Date.now()) {
    await prisma.streamTicket.delete({ where: { id: ticket.id } }).catch(() => undefined);
    throw new HttpError(403, 'ticket expired');
  }
  if (ticket.channel !== expectedChannel) {
    throw new HttpError(403, 'ticket channel mismatch');
  }
  // Single-use: delete BEFORE opening the stream.
  await prisma.streamTicket.delete({ where: { id: ticket.id } });
  return { userId: ticket.userId, channel: ticket.channel };
}

export class HttpError extends Error {
  constructor(public readonly status: number, message: string) {
    super(message);
  }
}

/** Extract the ticket from the request query string. */
export function readTicket(req: IncomingMessage): string | null {
  const url = new URL(req.url ?? '/', 'http://localhost');
  const t = url.searchParams.get('ticket');
  if (typeof t !== 'string' || t.length === 0) return null;
  return t;
}

/** Extract an optional lastEventId from the request query string. */
export function readLastEventId(req: IncomingMessage): string | null {
  const url = new URL(req.url ?? '/', 'http://localhost');
  const v = url.searchParams.get('lastEventId');
  if (typeof v !== 'string' || v.length === 0) return null;
  return v;
}

/** Match a request URL against a pattern like '/api/sse/notifications'. */
export function matchPath(req: IncomingMessage, pattern: string): boolean {
  const url = new URL(req.url ?? '/', 'http://localhost');
  return url.pathname === pattern;
}
