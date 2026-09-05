-- ────────────────────────────────────────────────────────────────────────────
-- T-E2 (Week 6, 2026-09-04): StreamTicket table for SSE auth.
-- ────────────────────────────────────────────────────────────────────────────
-- Replaces the Phase-1 SSE stub (apps/backend/src/realtime/realtime.module.ts)
-- with a real ticket-mint + Last-Event-ID resume flow. Each connection
-- mints a 5-minute single-use StreamTicket row via the JWT-authed
-- POST /api/realtime/ticket endpoint, then passes the ticket's cuid as a
-- query-string param to GET /api/sse/<channel>?ticket=... .
--
-- Single-use is enforced at the controller level (DELETE on consume), not
-- via RLS - the ticket IS the auth for the SSE path. RLS on StreamTicket
-- would add a join with no security gain because:
--   - the cuid is unguessable (Prisma's cuid() is collision-resistant)
--   - the row's userId is what gates the subsequent data queries
--   - the row expires in 5 minutes by design
--
-- Schema-level USAGE was already granted to shadhil_app in
-- 20260903021150_schema_grants_for_app_role; we add the per-table GRANT
-- here as a defense-in-depth so a future psql -f policies.sql replay
-- still works.

CREATE TABLE "StreamTicket" (
  "id"        TEXT NOT NULL,
  "userId"    TEXT NOT NULL,
  "channel"   TEXT NOT NULL,
  "expiresAt" TIMESTAMP(3) NOT NULL,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "StreamTicket_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "StreamTicket_userId_idx" ON "StreamTicket"("userId");
CREATE INDEX "StreamTicket_expiresAt_idx" ON "StreamTicket"("expiresAt");

-- Foreign key to User (CASCADE so account deletion cleans up tickets).
ALTER TABLE "StreamTicket"
  ADD CONSTRAINT "StreamTicket_userId_fkey"
  FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE
  ON UPDATE CASCADE;

-- Per-table CRUD grant for shadhil_app (pooled path). Idempotent.
GRANT SELECT, INSERT, UPDATE, DELETE ON "StreamTicket" TO shadhil_app;