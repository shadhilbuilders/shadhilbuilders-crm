-- T-BOOK-LEADSYNC repair (2026-09-15): reconcile existing Lead.state with the
-- lead's bookings.
--
-- WHY: `Booking.status` and `Lead.state` were two independent fields and
-- NOTHING reconciled them - `bookings.service.ts` never wrote `Lead.state`.
-- The service now syncs on every booking write (create / transition / delete),
-- but rows written BEFORE that change are still stale. Live drift at the time
-- of writing:
--
--   booking_status | lead_state | count
--   HOLD           | NEW        | 4   <- villa on hold, lead still "New"
--   HOLD           | NEGOTIATION| 1   <- correct
--   APPROVED       | NEGOTIATION| 1   <- approved, lead not WON
--   APPROVED       | WON        | 1   <- correct
--
-- RULE (user-confirmed): most advanced ACTIVE booking wins -
--   APPROVED -> WON, TOKEN -> BOOKING_INITIATED, HOLD -> NEGOTIATION,
--   none active -> NEGOTIATION.
--
-- SAFETY: only touches leads that have at least one booking, and only moves
-- them FORWARD on the main pipeline (or onto NEGOTIATION when their bookings
-- are all terminal). A lead with no bookings is left alone - its state is the
-- sales team's, not the booking module's business. COLD/LOST leads are skipped
-- entirely (reviving a dead lead is a deliberate act, never a repair side
-- effect): the pipeline rank array below therefore excludes them by simply not
-- matching.


-- ── Audit the repair ──────────────────────────────────────────────────────
-- The pre-state is gone once the UPDATE runs, so carry the before/after pair
-- out of the same statement via a temp table (a `updatedAt` window is NOT a
-- reliable "rows I just touched" filter - same lesson as the inventory repair).
-- NOTE: no ON COMMIT DROP - Prisma runs the migration inside a transaction and
-- the drop fires before the UPDATE below could read it (42P01).
CREATE TEMP TABLE t_leadsync_repair AS
WITH ranked AS (
  SELECT
    l.id,
    l."organizationId",
    l.state AS old_state,
    (CASE
       WHEN bool_or(b.status = 'APPROVED') THEN 'WON'
       WHEN bool_or(b.status = 'TOKEN')    THEN 'BOOKING_INITIATED'
       ELSE 'NEGOTIATION'
     END)::"LeadState" AS new_state
  FROM "Lead" l
  JOIN "Booking" b ON b."leadId" = l.id
  GROUP BY l.id, l."organizationId", l.state
),
ranked2 AS (
  SELECT r.*,
         CASE r.old_state
           WHEN 'NEW' THEN 0 WHEN 'CONTACTED' THEN 1 WHEN 'VISIT_REQUESTED' THEN 2
           WHEN 'VISIT_SCHEDULED' THEN 3 WHEN 'VISITED' THEN 4
           WHEN 'NEGOTIATION' THEN 5 WHEN 'BOOKING_INITIATED' THEN 6
           WHEN 'WON' THEN 7
         END AS old_rank,
         CASE r.new_state
           WHEN 'NEGOTIATION' THEN 5 WHEN 'BOOKING_INITIATED' THEN 6
           WHEN 'WON' THEN 7
         END AS new_rank
  FROM ranked r
)
SELECT id, "organizationId", old_state, new_state
  FROM ranked2
 WHERE old_rank IS NOT NULL
   AND new_rank IS NOT NULL
   AND new_rank <> old_rank
   AND (new_rank > old_rank OR new_state = 'NEGOTIATION');

UPDATE "Lead" l
   SET state = f.new_state,
       "updatedAt" = now()
  FROM t_leadsync_repair f
 WHERE l.id = f.id;

INSERT INTO "AuditLog" (id, "userId", "organizationId", action, "entityType",
                        "entityId", before, after, reason)
SELECT 'leadsync-' || md5(random()::text || f.id),
       NULL,
       f."organizationId",
       'lead.state_sync_repair',
       'Lead',
       f.id,
       jsonb_build_object('state', f.old_state::text),
       jsonb_build_object('state', f.new_state::text),
       'T-BOOK-LEADSYNC migration: lead state reconciled with its bookings '
         || '(APPROVED->WON, TOKEN->BOOKING_INITIATED, HOLD->NEGOTIATION, none->NEGOTIATION)'
  FROM t_leadsync_repair f;

-- Session-scoped: drop it explicitly (no ON COMMIT DROP above).
DROP TABLE IF EXISTS t_leadsync_repair;
