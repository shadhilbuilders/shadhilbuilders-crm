// Stream pipeline - the working SSE pattern.
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
//
// The live loop itself lives in server.ts (handleStream). An older duplicate
// of it (`startLiveLoop`) was deleted 2026-11-21: it carried the same
// wall-clock anchor bug, so leaving a second, tempting copy around was just a
// way to reintroduce it. Ordering/fetch logic is in fetchers.ts + cursor.ts.

import type { PrismaClient } from '@shadhil/database';
import type { IncomingMessage, ServerResponse } from 'node:http';

/** A single SSE frame ready to be serialized onto the socket. */
export interface SseFrame {
  /** Last-Event-ID value (omit for heartbeats). */
  id?: string;
  /** JSON-serializable payload. */
  data: unknown;
  /** SSE event name (default 'message'). */
  event?: string;
}

/** SSE response framing helpers - kept tiny and pure. */
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

/** Ticket consume - port of apps/backend's RealtimeService.consumeTicket.
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
  constructor(
    public readonly status: number,
    message: string,
  ) {
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
