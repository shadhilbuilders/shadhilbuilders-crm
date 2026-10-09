-- T-VISIT-LEAD-SYNC (2026-10-09): bring existing SiteVisit rows in line with their
-- lead's state, remove duplicate open visits, then make duplicates impossible.
--
-- Rule source of truth: packages/api-types/src/visit-lead-sync.ts
-- (visitFateForLeadState). This SQL is its one-off mirror; keep them in step.
--
--   VISITED                                  -> COMPLETED
--   NEGOTIATION / BOOKING_INITIATED / WON    -> COMPLETED if slot has passed, else CANCELLED
--   LOST / RNR / VISIT_REQUESTED             -> CANCELLED
--   RESCHEDULED                              -> RESCHEDULED
--   NO_SHOW                                  -> NO_SHOW
--
-- Open visit = status SCHEDULED only (RESCHEDULED is a replaced row).
-- Runs as the owner (superuser), so RLS does not hide rows from it. Every change
-- writes an AuditLog row (userId NULL = system) so the history stays explainable.

-- 1. Lead-state sync -----------------------------------------------------------
CREATE TEMP TABLE _visit_sync ON COMMIT DROP AS
SELECT
  v."id",
  v."organizationId",
  v."leadId",
  v."userId",
  v."scheduledFor",
  l."state"::text AS lead_state,
  CASE
    WHEN l."state" = 'VISITED' THEN 'COMPLETED'
    WHEN l."state" IN ('NEGOTIATION', 'BOOKING_INITIATED', 'WON') THEN
      CASE WHEN v."scheduledFor" <= (now() AT TIME ZONE 'UTC') THEN 'COMPLETED' ELSE 'CANCELLED' END
    WHEN l."state" IN ('LOST', 'RNR', 'VISIT_REQUESTED') THEN 'CANCELLED'
    WHEN l."state" = 'RESCHEDULED' THEN 'RESCHEDULED'
    WHEN l."state" = 'NO_SHOW' THEN 'NO_SHOW'
  END AS new_status,
  CASE
    WHEN l."state" = 'VISITED' THEN 'lead-visited'
    WHEN l."state" IN ('NEGOTIATION', 'BOOKING_INITIATED', 'WON') THEN 'lead-advanced'
    WHEN l."state" IN ('LOST', 'RNR') THEN 'lead-terminal'
    WHEN l."state" = 'VISIT_REQUESTED' THEN 'visit-reverted'
    WHEN l."state" = 'RESCHEDULED' THEN 'lead-rescheduled'
    WHEN l."state" = 'NO_SHOW' THEN 'lead-no-show'
  END AS because
FROM "SiteVisit" v
JOIN "Lead" l ON l."id" = v."leadId"
WHERE v."status" = 'SCHEDULED';

DELETE FROM _visit_sync WHERE new_status IS NULL;

UPDATE "SiteVisit" v
SET "status" = s.new_status::"VisitStatus", "updatedAt" = now()
FROM _visit_sync s
WHERE v."id" = s."id" AND v."status" = 'SCHEDULED';

INSERT INTO "AuditLog" ("id", "userId", "organizationId", "action", "entityType", "entityId", "before", "after", "reason")
SELECT
  gen_random_uuid()::text, NULL, s."organizationId", 'visit.sync', 'SiteVisit', s."id",
  jsonb_build_object('status', 'SCHEDULED'),
  jsonb_build_object(
    'status', s.new_status, 'leadId', s."leadId", 'leadState', s.lead_state,
    'closedBecause', s.because, 'wasScheduledFor', s."scheduledFor", 'wasAssignedTo', s."userId",
    'backfill', 'T-VISIT-LEAD-SYNC'
  ),
  'Backfill: visit status brought in line with its lead state (T-VISIT-LEAD-SYNC)'
FROM _visit_sync s;

-- 2. Dedupe remaining open visits (one per lead) ------------------------------
-- Keep the earliest slot that is still ahead; if none is ahead, keep the latest
-- slot. Every other open row is CANCELLED with an audit row.
CREATE TEMP TABLE _visit_dupes ON COMMIT DROP AS
WITH ranked AS (
  SELECT
    v."id", v."organizationId", v."leadId", v."userId", v."scheduledFor",
    row_number() OVER (
      PARTITION BY v."leadId"
      ORDER BY
        (v."scheduledFor" >= (now() AT TIME ZONE 'UTC')) DESC,
        CASE WHEN v."scheduledFor" >= (now() AT TIME ZONE 'UTC') THEN v."scheduledFor" END ASC,
        v."scheduledFor" DESC,
        v."createdAt" ASC,
        v."id" ASC
    ) AS rn
  FROM "SiteVisit" v
  WHERE v."status" = 'SCHEDULED'
)
SELECT * FROM ranked WHERE rn > 1;

UPDATE "SiteVisit" v
SET "status" = 'CANCELLED', "updatedAt" = now()
FROM _visit_dupes d
WHERE v."id" = d."id" AND v."status" = 'SCHEDULED';

INSERT INTO "AuditLog" ("id", "userId", "organizationId", "action", "entityType", "entityId", "before", "after", "reason")
SELECT
  gen_random_uuid()::text, NULL, d."organizationId", 'visit.cancel', 'SiteVisit', d."id",
  jsonb_build_object('status', 'SCHEDULED'),
  jsonb_build_object(
    'status', 'CANCELLED', 'leadId', d."leadId", 'closedBecause', 'duplicate-open-visit',
    'wasScheduledFor', d."scheduledFor", 'wasAssignedTo', d."userId", 'backfill', 'T-VISIT-LEAD-SYNC'
  ),
  'Backfill: duplicate open visit on the same lead cancelled (T-VISIT-LEAD-SYNC)'
FROM _visit_dupes d;

-- 3. Repair exec access (Lead.coOwnerId) for the surviving open visits -------
-- The conducting SALES_EXEC reads the lead through the co-owner slot. Only fill
-- an EMPTY slot; never clobber an existing co-owner.
UPDATE "Lead" l
SET "coOwnerId" = v."userId", "updatedAt" = now()
FROM "SiteVisit" v
JOIN "User" u ON u."id" = v."userId"
WHERE v."leadId" = l."id"
  AND v."status" = 'SCHEDULED'
  AND u."role" = 'SALES_EXEC'
  AND l."coOwnerId" IS NULL
  AND l."ownerId" <> v."userId";

-- 4. Assertions: fail the migration rather than ship a half-fixed table -------
DO $$
DECLARE
  dupes integer;
  stale integer;
BEGIN
  SELECT count(*) INTO dupes FROM (
    SELECT "leadId" FROM "SiteVisit" WHERE "status" = 'SCHEDULED' GROUP BY "leadId" HAVING count(*) > 1
  ) t;
  IF dupes <> 0 THEN
    RAISE EXCEPTION 'visit backfill: % leads still have more than one open visit', dupes;
  END IF;

  SELECT count(*) INTO stale
  FROM "SiteVisit" v JOIN "Lead" l ON l."id" = v."leadId"
  WHERE v."status" = 'SCHEDULED'
    AND l."state" IN ('VISITED','NEGOTIATION','BOOKING_INITIATED','WON','LOST','RNR','VISIT_REQUESTED','RESCHEDULED','NO_SHOW');
  IF stale <> 0 THEN
    RAISE EXCEPTION 'visit backfill: % open visits still contradict their lead state', stale;
  END IF;
END $$;

-- 5. One open visit per lead, enforced by the database ------------------------
CREATE UNIQUE INDEX "SiteVisit_one_open_per_lead"
  ON "SiteVisit" ("leadId")
  WHERE "status" = 'SCHEDULED';
