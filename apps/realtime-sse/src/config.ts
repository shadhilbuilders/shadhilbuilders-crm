// Config + env loading for the standalone SSE service.
//
// Mirrors the env vars the backend's @nestjs/core main.ts uses, but read
// once at boot (no @nestjs/config dependency). The parent monorepo loads
// .env via tsx --env-file, so process.env is already populated when this
// module is imported.

const REALTIME_SSE_PORT = Number.parseInt(process.env.REALTIME_SSE_PORT ?? '8090', 10);
if (!Number.isInteger(REALTIME_SSE_PORT) || REALTIME_SSE_PORT <= 0 || REALTIME_SSE_PORT > 65535) {
  throw new Error(`REALTIME_SSE_PORT must be a valid port, got: ${process.env.REALTIME_SSE_PORT}`);
}

// DB_TICK_MS: how often the live poll fetches new rows from Postgres.
// HEARTBEAT_MS: how often a `:keep-alive\n\n` comment is flushed to
//   keep idle proxies from closing the connection.
//
// T-SSE-TICK (2026-11-21): raised 1500 -> 5000. This loop is a DATABASE
// POLLER, not an event bus (there is no Redis pub/sub / LISTEN-NOTIFY in
// this service), so the tick cost is paid PER CONNECTED CLIENT and every
// tick is a full RLS transaction (withRlsContext sets three GUCs before
// the query). A manager with a thread open holds two streams (chat +
// notifications via app-header), so 1.5s cost ~80 transactions/minute per
// user while idle.
//
// Why 5s is safe here:
//   - The web layer polls independently (chat-conversations 15s, contact
//     messages 30s, lead messages 30s), so those caches do not depend on
//     this tick for correctness.
//   - The tick loop now anchors on the (createdAt, id) of the newest row it
//     actually emitted (T-SSE-ANCHOR, 2026-11-21 - see cursor.ts), so a row
//     committed inside the tick window is picked up by the NEXT tick instead
//     of being skipped. Delivery no longer depends on the tick being short.
//   - 5s is still ~3x snappier than the fastest client poll for an operator
//     watching a chat.
// Raise it further (10s) if DB load becomes a problem. If you want sub-second
// chat latency, the honest path is a push transport (Redis pub/sub on write,
// or LISTEN/NOTIFY) rather than shrinking this interval - polling faster only
// multiplies per-client transactions.
const DB_TICK_MS = Number.parseInt(process.env.SSE_DB_TICK_MS ?? '5000', 10);
const HEARTBEAT_MS = Number.parseInt(process.env.SSE_HEARTBEAT_MS ?? '15000', 10);

// TICKET_TTL_MS: must match the backend's RealtimeService.TICKET_TTL_MS
// (5 min). The standalone service can be more lenient (tickets already
// consumed are deleted, so a stale check only causes spurious rejections
// near the boundary).
const TICKET_TTL_MS = 5 * 60 * 1000;

const CORS_ORIGINS = (process.env.CORS_ORIGINS ?? 'http://localhost:3000')
  .split(',')
  .map((s) => s.trim())
  .filter((s) => s.length > 0);

export const config = {
  port: REALTIME_SSE_PORT,
  dbTickMs: DB_TICK_MS,
  heartbeatMs: HEARTBEAT_MS,
  ticketTtlMs: TICKET_TTL_MS,
  corsOrigins: CORS_ORIGINS,
} as const;
