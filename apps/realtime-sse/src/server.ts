// Bare Node http SSE server - T-E2 fix (Week 6, 2026-09-04).
//
// Why a separate service: @nestjs/core 12.0.1's @Sse() handler is
// broken for any subscription chain that requires an await inside
// its factory, and @fastify/sse 0.6.0 (verified on 2026-09-04) has
// the same shape of bug: its `reply.sse.keepAlive()` is a no-op until
// the first frame is yielded, and the first frame from an async
// generator that does real setup work never reaches the socket. The
// only path that has demonstrated working SSE in this codebase is the
// bare-Node pattern proven by the canary `/api/sse/ping` (plain
// setInterval that writes to res directly). So this service uses
// bare node:http with manual SSE framing - no framework between the
// code and the socket.
//
// The main Nest backend still owns the StreamTicket model + mint flow
// (POST /api/realtime/ticket); this service only owns the GET
// /api/sse/* consumer side.

// Bare Node http SSE server - T-E2 fix (Week 6, 2026-09-04).
//
// Why a separate service: @nestjs/core 12.0.1's @Sse() handler is
// broken for any subscription chain that requires an await inside
// its factory, and @fastify/sse 0.6.0 (verified on 2026-09-04) has
// the same shape of bug: its `reply.sse.keepAlive()` is a no-op until
// the first frame is yielded, and the first frame from an async
// generator that does real setup work never reaches the socket. The
// only path that has demonstrated working SSE in this codebase is the
// bare-Node pattern proven by the canary `/api/sse/ping` (plain
// setInterval that writes to res directly). So this service uses
// bare node:http with manual SSE framing - no framework between the
// code and the socket.
//
// The main Nest backend still owns the StreamTicket model + mint flow
// (POST /api/realtime/ticket); this service only owns the GET
// /api/sse/* consumer side.

import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { prisma, type PrismaClient } from '@shadhil/database';
import { Prisma } from '@shadhil/database';

import { config } from './config.js';
import {
  advanceCursor,
  createSeenIds,
  START_OF_STREAM,
  type CursorFrame,
  type Fetcher,
  type StreamCursor,
} from './cursor.js';
import {
  auditFetcher,
  chatFetcher,
  contactChatFetcher,
  cursorForLastEvent,
  notificationsFetcher,
  resolveUserContext,
  type SseUser,
} from './fetchers.js';
import { metrics } from './metrics.js';
import { consumeTicket, type SseFrame } from './stream.js';

// ── CORS ────────────────────────────────────────────────────────────
const CORS_HEADERS: Record<string, string> = {
  'Access-Control-Allow-Methods': 'GET, OPTIONS',
  'Access-Control-Allow-Headers': 'content-type, last-event-id',
  'Access-Control-Max-Age': '86400',
};

function applyCors(res: ServerResponse, origin: string | undefined): void {
  if (
    origin !== undefined &&
    (config.corsOrigins.includes(origin) || config.corsOrigins[0] === '*')
  ) {
    res.setHeader('Access-Control-Allow-Origin', origin);
    res.setHeader('Access-Control-Allow-Credentials', 'true');
  }
}

// ── SSE framing ─────────────────────────────────────────────────────
const SSE_HEADERS: Record<string, string | number> = {
  'Content-Type': 'text/event-stream; charset=utf-8',
  'Cache-Control': 'no-cache, no-transform',
  Connection: 'keep-alive',
  'X-Accel-Buffering': 'no',
};

/**
 * How many recently emitted row ids to remember per connection, to drop a
 * duplicate frame before it reaches the client. The cursor should make
 * duplicates impossible, so this only covers a fetch that outlives a tick;
 * it needs to exceed the rows a single tick can emit, not the channel's
 * history. 200 = 4x the fetcher batch size, flat memory per connection.
 */
const DEDUPE_WINDOW = 200;

function openSse(res: ServerResponse): void {
  res.writeHead(200, SSE_HEADERS);
  res.write(': stream-open\n\n');
}

function writeFrame(res: ServerResponse, frame: SseFrame): void {
  if (frame.id !== undefined) res.write(`id: ${frame.id}\n`);
  if (frame.event !== undefined) res.write(`event: ${frame.event}\n`);
  res.write(`data: ${JSON.stringify(frame.data)}\n\n`);
}

// ── Per-route handlers ──────────────────────────────────────────────
async function handlePing(_req: IncomingMessage, res: ServerResponse): Promise<void> {
  openSse(res);
  const timer = setInterval(() => {
    res.write(`data: ${JSON.stringify({ type: 'ping', ts: Date.now() })}\n\n`);
  }, 1500);
  res.on('close', () => clearInterval(timer));
}

async function handleStream(
  req: IncomingMessage,
  res: ServerResponse,
  opts: {
    channel: string;
    // Builder: given the resolved RLS user + an optional thread scope,
    // return the fetcher. The user is resolved once per connection (the
    // ticket binds a user); threadId is only set for chat channels and is
    // a leadId or a contactId depending on the route.
    fetcher: (user: SseUser, threadId: string | undefined) => Fetcher;
    anchorModel: 'Notification' | 'AuditLog' | 'Message';
    /**
     * Extra WHERE columns for the anchor lookup, so a reconnect that carries
     * a Last-Event-ID cannot resolve a Message row from a DIFFERENT thread
     * and resume from its timestamp. `{ leadId }` for lead threads,
     * `{ contactId }` for unknown-contact threads, undefined otherwise.
     */
    anchorExtraWhere?: (req: IncomingMessage) => Record<string, string> | undefined;
  },
): Promise<void> {
  const ticket = readQueryString(req, 'ticket');
  if (ticket === null) {
    res.writeHead(400, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ statusCode: 400, message: 'missing ticket' }));
    return;
  }
  let consumed: { userId: string };
  try {
    consumed = await consumeTicket(prisma, ticket, opts.channel);
  } catch (err) {
    res.writeHead(403, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ statusCode: 403, message: errMsg(err) }));
    return;
  }
  // T-E2-REALTIME-RLS (2026-09-17): resolve the ticket subject's RLS context
  // (role + org) NOW. The fetchers run inside withRlsContext so their
  // Message / Notification / AuditLog reads honor the exact policies the
  // REST layer applies - without this, the bare prisma client is RLS-filtered
  // to zero rows and the stream never emits a frame (the live-chat bug).
  const user = await resolveUserContext(prisma, consumed.userId);
  const extra = opts.anchorExtraWhere?.(req);
  // The thread scope is whichever column the extra-where names - a leadId on
  // /chat/:id, a contactId on /chat-contact/:id. Passed through so a fetcher
  // builder that wants it can use it; the shipped builders close over the id
  // directly, which is clearer at the call site.
  const threadId = extra === undefined ? undefined : Object.values(extra)[0];
  const lastEventId = readQueryString(req, 'lastEventId');
  // Resume position = the (createdAt, id) of the row the client last saw.
  const startCursor = await cursorForLastEvent(prisma, opts.anchorModel, lastEventId, extra);
  const fetcher = opts.fetcher(user, threadId);

  // T-PERF-2 #4: track active connections via a gauge. Increment on
  // stream open, decrement on close. The gauge value is the live count of
  // open SSE streams at scrape time.
  bumpActive(1);
  // Derive a low-cardinality channel label (notifications, audit, chat) for
  // the metrics - the full channel string includes the thread id, which
  // would explode label cardinality. Contact threads report under the same
  // 'chat' label: from an operator's view they are the same subsystem.
  const channelLabel =
    opts.channel.startsWith('chat:') || opts.channel.startsWith('chat-contact:')
      ? 'chat'
      : opts.channel;

  // Open the stream first - this commits the SSE headers synchronously.
  openSse(res);

  // T-SSE-ANCHOR (2026-11-21): the cursor is the ONLY thing that decides what
  // gets emitted. It advances exclusively to the tuple of a row actually
  // written to this socket - never to `new Date()`. See cursor.ts for the
  // lost-row bug the wall-clock version caused.
  let cursor: StreamCursor = startCursor;
  // Drops a duplicate frame if a fetch ever outlives the tick interval.
  const seen = createSeenIds(DEDUPE_WINDOW);
  let stopped = false;

  /** Write frames, skipping duplicates, then advance the cursor. */
  const emit = (frames: readonly CursorFrame[]): number => {
    let written = 0;
    for (const frame of frames) {
      // A frame carries its row id; a fetcher that omits it cannot be
      // de-duplicated, so treat that as a programming error rather than
      // silently emitting a possible repeat.
      if (frame.id === undefined) {
        throw new Error(`[sse] frame without an id on channel ${opts.channel}`);
      }
      if (!seen.add(frame.id)) continue;
      writeFrame(res, frame);
      written += 1;
    }
    // Advance from the FETCHED frames, not the written ones: a duplicate was
    // already consumed and is still valid ordering information.
    cursor = advanceCursor(cursor, frames);
    return written;
  };

  // Backlog flush.
  try {
    const backlog = await fetcher(cursor);
    metrics.gauge('realtime_sse_backlog_size', { channel: channelLabel }, backlog.length);
    emit(backlog);
  } catch (err) {
    writeFrame(res, { event: 'error', data: { message: errMsg(err) } });
  }

  // Live poll loop. Drives a setInterval that calls the fetcher and
  // writes frames; the heartbeat interval writes keep-alive comments.
  // When the client disconnects, both timers are cleared and the
  // response is ended - this is the same shape that the
  // /api/sse/ping canary proved works.
  //
  // Non-overlap: if a fetch takes longer than dbTickMs, the next tick is
  // skipped rather than queued. Two concurrent fetches would race on `cursor`
  // and could emit the same rows twice or move the cursor backwards.
  let tickInFlight = false;
  const tickTimer = setInterval(() => {
    if (stopped || tickInFlight) return;
    tickInFlight = true;
    const startedAt = Date.now();
    fetcher(cursor)
      .then((frames) => {
        if (stopped) return;
        // T-PERF-2 #4: observe the tick latency per channel.
        metrics.observe(
          'realtime_sse_tick_duration_seconds',
          { channel: channelLabel },
          (Date.now() - startedAt) / 1000,
        );
        emit(frames);
      })
      .catch((err: unknown) => {
        if (stopped) return;
        writeFrame(res, { event: 'error', data: { message: errMsg(err) } });
      })
      .finally(() => {
        tickInFlight = false;
      });
  }, config.dbTickMs);

  const heartbeatTimer = setInterval(() => {
    if (!stopped) res.write(': keep-alive\n\n');
  }, config.heartbeatMs);

  res.on('close', () => {
    stopped = true;
    clearInterval(tickTimer);
    clearInterval(heartbeatTimer);
    // T-PERF-2 #4: decrement the active-connections gauge.
    bumpActive(-1);
  });
}

// `anchorFor` (wall-clock anchor lookup) was removed 2026-11-21. Resuming is
// now `cursorForLastEvent` in fetchers.ts, which resolves Last-Event-ID to the
// row's (createdAt, id) instead of only its timestamp - the timestamp alone
// cannot express "after this exact row" when rows share a createdAt.

function readQueryString(req: IncomingMessage, key: string): string | null {
  const url = new URL(req.url ?? '/', 'http://localhost');
  const v = url.searchParams.get(key);
  return typeof v === 'string' && v.length > 0 ? v : null;
}

const errMsg = (err: unknown): string => (err instanceof Error ? err.message : String(err));

function readLeadId(req: IncomingMessage): string | null {
  return readPathSegment(req, /^\/api\/sse\/chat\/([^/]+)$/);
}

/** Extract the single dynamic path segment a route pattern captures. */
function readPathSegment(req: IncomingMessage, pattern: RegExp): string | null {
  const url = new URL(req.url ?? '/', 'http://localhost');
  const m = url.pathname.match(pattern);
  const segment = m?.[1];
  return typeof segment === 'string' && segment.length > 0 ? segment : null;
}

// ── Router ──────────────────────────────────────────────────────────
const server = createServer(async (req, res) => {
  applyCors(res, req.headers.origin);

  if (req.method === 'OPTIONS') {
    res.writeHead(204, CORS_HEADERS);
    res.end();
    return;
  }

  const url = new URL(req.url ?? '/', 'http://localhost');
  const path = url.pathname;

  if (req.method === 'GET' && path === '/api/sse/healthz') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ ok: true, service: 'realtime-sse' }));
    return;
  }

  // T-PERF-2 #4: Prometheus metrics endpoint. No auth (intended for
  // an internal scraper; expose only on localhost in prod via the
  // reverse proxy - see plan §10 / references/prod-deployment.md).
  if (req.method === 'GET' && path === '/api/sse/metrics') {
    res.writeHead(200, { 'Content-Type': 'text/plain; version=0.0.4' });
    res.end(metrics.render());
    return;
  }

  if (req.method === 'GET' && path === '/api/sse/ping') {
    await handlePing(req, res);
    return;
  }

  if (req.method === 'GET' && path === '/api/sse/notifications') {
    await handleStream(req, res, {
      channel: 'notifications',
      fetcher: (user) => notificationsFetcher(prisma, user),
      anchorModel: 'Notification',
    });
    return;
  }

  if (req.method === 'GET' && path === '/api/sse/audit') {
    await handleStream(req, res, {
      channel: 'audit',
      fetcher: (user) => auditFetcher(prisma, user),
      anchorModel: 'AuditLog',
    });
    return;
  }

  if (req.method === 'GET' && /^\/api\/sse\/chat\/[^/]+$/.test(path)) {
    const leadId = readLeadId(req);
    if (leadId === null) {
      res.writeHead(400, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ statusCode: 400, message: 'missing leadId' }));
      return;
    }
    await handleStream(req, res, {
      channel: `chat:${leadId}`,
      fetcher: (user) => chatFetcher(prisma, user, leadId),
      anchorModel: 'Message',
      anchorExtraWhere: () => ({ leadId }),
    });
    return;
  }

  // Unknown-contact thread (2026-11-21). Same pipeline, keyed on contactId.
  // Matched BEFORE the generic chat route above would be ambiguous: the two
  // paths differ by the /chat-contact/ segment, so ordering does not actually
  // matter here - keeping them adjacent makes the pair obvious.
  if (req.method === 'GET' && /^\/api\/sse\/chat-contact\/[^/]+$/.test(path)) {
    const contactId = readPathSegment(req, /^\/api\/sse\/chat-contact\/([^/]+)$/);
    if (contactId === null) {
      res.writeHead(400, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ statusCode: 400, message: 'missing contactId' }));
      return;
    }
    await handleStream(req, res, {
      channel: `chat-contact:${contactId}`,
      // The extra-where shape is lead-specific; contact threads scope inside
      // the fetcher instead.
      fetcher: (user) => contactChatFetcher(prisma, user, contactId),
      anchorModel: 'Message',
      anchorExtraWhere: () => ({ contactId }),
    });
    return;
  }

  res.writeHead(404, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify({ statusCode: 404, message: 'not found' }));
});

server.listen(config.port, () => {
  // eslint-disable-next-line no-console
  console.log(`[realtime-sse] listening on http://localhost:${config.port}`);
  // eslint-disable-next-line no-console
  console.log(
    `[realtime-sse] routes: GET /api/sse/{ping,healthz,notifications,audit,chat/:leadId,chat-contact/:contactId}`,
  );
  // eslint-disable-next-line no-console
  console.log(
    `[realtime-sse] polls: dbTick=${config.dbTickMs}ms heartbeat=${config.heartbeatMs}ms`,
  );
});

const shutdown = (): void => {
  // eslint-disable-next-line no-console
  console.log('[realtime-sse] shutting down');
  server.close(() => {
    void prisma.$disconnect().then(() => process.exit(0));
  });
  setTimeout(() => process.exit(1), 5000).unref();
};
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);

// T-PERF-2 #4: in-process counter of currently-open SSE connections.
// Module-level so all handlers share the same count. Incremented on
// stream open, decremented on stream close (via bumpActive()).
let _activeConnections = 0;
const activeConnections = (): number => _activeConnections;
const bumpActive = (delta: number): void => {
  _activeConnections = Math.max(0, _activeConnections + delta);
  metrics.gauge('realtime_sse_active_connections', {}, _activeConnections);
};
