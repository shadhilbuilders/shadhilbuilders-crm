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
const DB_TICK_MS = Number.parseInt(process.env.SSE_DB_TICK_MS ?? '1500', 10);
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
