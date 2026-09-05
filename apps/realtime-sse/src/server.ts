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

import { config } from './config.js';
import { auditFetcher, chatFetcher, notificationsFetcher } from './fetchers.js';
import { metrics } from './metrics.js';
import { consumeTicket, type SseFrame } from './stream.js';

// ── CORS ────────────────────────────────────────────────────────────
const CORS_HEADERS: Record<string, string> = {
  'Access-Control-Allow-Methods': 'GET, OPTIONS',
  'Access-Control-Allow-Headers': 'content-type, last-event-id',
  'Access-Control-Max-Age': '86400',
};

function applyCors(res: ServerResponse, origin: string | undefined): void {
  if (origin !== undefined && (config.corsOrigins.includes(origin) || config.corsOrigins[0] === '*')) {
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
    fetcher: (prisma: PrismaClient, scope: string) => (lastSeenAt: Date) => Promise<SseFrame[]>;
    scopeFromConsumed: (consumed: { userId: string }) => string;
    anchorModel: 'Notification' | 'AuditLog' | 'Message';
    anchorExtraWhere?: (req: IncomingMessage) => { leadId: string } | undefined;
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
  const scope = opts.scopeFromConsumed(consumed);
  const lastEventId = readQueryString(req, 'lastEventId');
  const extra = opts.anchorExtraWhere?.(req);
  const anchor = await anchorFor(opts.anchorModel, lastEventId, extra);
  const fetcher = opts.fetcher(prisma, scope);

  // T-PERF-2 #4: track active connections via a gauge. Increment on
  // stream open, decrement on close. The gauge value is the live count of
  // open SSE streams at scrape time.
  bumpActive(1);
  // Derive a low-cardinality channel label (notifications, audit, chat)
  // for the metrics - the full channel string includes the leadId for
  // chat, which would explode label cardinality.
  const channelLabel = opts.channel.startsWith('chat:') ? 'chat' : opts.channel;

  // Open the stream first - this commits the SSE headers synchronously.
  openSse(res);

  // Backlog flush.
  try {
    const backlog = await fetcher(anchor);
    metrics.gauge('realtime_sse_backlog_size', { channel: channelLabel }, backlog.length);
    for (const f of backlog) writeFrame(res, f);
  } catch (err) {
    writeFrame(res, { event: 'error', data: { message: errMsg(err) } });
  }

  // Live poll loop. Drives a setInterval that calls the fetcher and
  // writes frames; the heartbeat interval writes keep-alive comments.
  // When the client disconnects, both timers are cleared and the
  // response is ended - this is the same shape that the
  // /api/sse/ping canary proved works.
  let lastSeenAt = anchor;
  let stopped = false;
  const tickTimer = setInterval(() => {
    if (stopped) return;
    const startedAt = Date.now();
    fetcher(lastSeenAt)
      .then((frames) => {
        if (stopped) return;
        // T-PERF-2 #4: observe the tick latency per channel.
        metrics.observe(
          'realtime_sse_tick_duration_seconds',
          { channel: channelLabel },
          (Date.now() - startedAt) / 1000,
        );
        for (const f of frames) writeFrame(res, f);
        if (frames.length > 0) lastSeenAt = new Date();
      })
      .catch((err: unknown) => {
        if (stopped) return;
        writeFrame(res, { event: 'error', data: { message: errMsg(err) } });
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

async function anchorFor(
  model: 'Notification' | 'AuditLog' | 'Message',
  lastEventId: string | null,
  extraWhere?: { leadId: string },
): Promise<Date> {
  if (lastEventId === null) return new Date(0);
  const delegate = (prisma as unknown as Record<string, {
    findUnique: (args: { where: unknown; select: unknown }) => Promise<{ createdAt: Date } | null>;
  }>)[model];
  const where = extraWhere !== undefined
    ? { id: lastEventId, ...extraWhere }
    : { id: lastEventId };
  const row = await delegate.findUnique({ where, select: { createdAt: true } });
  return row?.createdAt ?? new Date(0);
}

function readQueryString(req: IncomingMessage, key: string): string | null {
  const url = new URL(req.url ?? '/', 'http://localhost');
  const v = url.searchParams.get(key);
  return typeof v === 'string' && v.length > 0 ? v : null;
}

const errMsg = (err: unknown): string =>
  err instanceof Error ? err.message : String(err);

function readLeadId(req: IncomingMessage): string | null {
  const url = new URL(req.url ?? '/', 'http://localhost');
  const m = url.pathname.match(/^\/api\/sse\/chat\/([^/]+)$/);
  return m?.[1] ?? null;
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
      fetcher: (p, userId) => notificationsFetcher(p, userId),
      scopeFromConsumed: (c) => c.userId,
      anchorModel: 'Notification',
    });
    return;
  }

  if (req.method === 'GET' && path === '/api/sse/audit') {
    await handleStream(req, res, {
      channel: 'audit',
      fetcher: (p, userId) => auditFetcher(p, userId),
      scopeFromConsumed: (c) => c.userId,
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
      fetcher: (p, l) => chatFetcher(p, l),
      scopeFromConsumed: () => '',
      anchorModel: 'Message',
      anchorExtraWhere: () => ({ leadId }),
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
  console.log(`[realtime-sse] routes: GET /api/sse/{ping,healthz,notifications,audit,chat/:leadId}`);
  // eslint-disable-next-line no-console
  console.log(`[realtime-sse] polls: dbTick=${config.dbTickMs}ms heartbeat=${config.heartbeatMs}ms`);
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
