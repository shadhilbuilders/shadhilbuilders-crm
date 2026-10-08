-- Lead timeline backfill: replay historical AuditLog rows into "Activity" so
-- existing leads show their history. Runs as the migration owner (RLS bypassed).
--
-- Idempotent: ids are deterministic ('bf_' || AuditLog.id), plus a NOT EXISTS
-- guard on (leadId, type, body, createdAt), so a re-run inserts 0 rows.
-- Rows whose actor is NULL, or whose lead/user no longer exists, are skipped
-- by the inner joins (Activity.userId is NOT NULL with an FK).

-- Lead state -> friendly label (mirrors @shadhil/api-types LEAD_STATE_LABELS).
CREATE OR REPLACE FUNCTION pg_temp.lead_state_label(s text) RETURNS text AS $$
  SELECT CASE s
    WHEN 'NEW' THEN 'New'
    WHEN 'CONTACTED' THEN 'Talked'
    WHEN 'VISIT_REQUESTED' THEN 'Visit requested'
    WHEN 'VISIT_SCHEDULED' THEN 'Visit booked'
    WHEN 'VISITED' THEN 'Visited'
    WHEN 'NEGOTIATION' THEN 'Negotiating'
    WHEN 'BOOKING_INITIATED' THEN 'Booking in progress'
    WHEN 'WON' THEN 'Won 🎉'
    WHEN 'LOST' THEN 'Lost'
    WHEN 'RNR' THEN 'Unresponsive'
    WHEN 'RESCHEDULED' THEN 'Postponed'
    WHEN 'NO_SHOW' THEN 'Didn''t show up'
    ELSE initcap(replace(lower(coalesce(s, '')), '_', ' '))
  END
$$ LANGUAGE sql IMMUTABLE;

CREATE OR REPLACE FUNCTION pg_temp.visit_when(ts timestamptz) RETURNS text AS $$
  SELECT to_char(ts AT TIME ZONE 'Asia/Kolkata', 'FMDD Mon, FMHH12:MI am')
$$ LANGUAGE sql IMMUTABLE;

DROP TABLE IF EXISTS _activity_backfill;
CREATE TEMP TABLE _activity_backfill AS
-- lead.create
SELECT 'bf_' || a."id" AS id, l."id" AS "leadId", l."organizationId", a."userId",
       'STATUS_CHANGE'::"ActivityType" AS type,
       'Lead created (' || coalesce(a."after"->>'source', 'unknown') || '), assigned to '
         || coalesce(o."name", 'nobody') AS body,
       a."createdAt"
FROM "AuditLog" a
JOIN "Lead" l ON l."id" = a."entityId"
JOIN "User" u ON u."id" = a."userId"
LEFT JOIN "User" o ON o."id" = a."after"->>'ownerId'
WHERE a."action" = 'lead.create' AND a."entityType" = 'Lead'
UNION ALL
-- lead.transition
SELECT 'bf_' || a."id", l."id", l."organizationId", a."userId",
       'STATUS_CHANGE'::"ActivityType",
       pg_temp.lead_state_label(a."before"->>'state') || ' -> '
         || pg_temp.lead_state_label(a."after"->>'state')
         || CASE WHEN a."reason" IS NOT NULL AND a."reason" NOT LIKE 'state change by %'
                 THEN ' - ' || a."reason" ELSE '' END,
       a."createdAt"
FROM "AuditLog" a
JOIN "Lead" l ON l."id" = a."entityId"
JOIN "User" u ON u."id" = a."userId"
WHERE a."action" = 'lead.transition' AND a."entityType" = 'Lead'
  AND a."before"->>'state' IS NOT NULL AND a."after"->>'state' IS NOT NULL
UNION ALL
-- lead.reassign
SELECT 'bf_' || a."id", l."id", l."organizationId", a."userId",
       'ASSIGNMENT'::"ActivityType",
       'Reassigned from ' || coalesce(fo."name", 'nobody') || ' to ' || coalesce(t."name", 'nobody')
         || CASE WHEN a."reason" IS NOT NULL AND a."reason" <> '' THEN ' - ' || a."reason" ELSE '' END,
       a."createdAt"
FROM "AuditLog" a
JOIN "Lead" l ON l."id" = a."entityId"
JOIN "User" u ON u."id" = a."userId"
LEFT JOIN "User" fo ON fo."id" = a."before"->>'ownerId'
LEFT JOIN "User" t ON t."id" = a."after"->>'ownerId'
WHERE a."action" = 'lead.reassign' AND a."entityType" = 'Lead'
  AND a."before"->>'ownerId' IS DISTINCT FROM a."after"->>'ownerId'
UNION ALL
-- lead.co_owner (the .noop variant changed nothing)
SELECT 'bf_' || a."id", l."id", l."organizationId", a."userId",
       'ASSIGNMENT'::"ActivityType",
       CASE WHEN a."after"->>'coOwnerId' IS NOT NULL
            THEN 'Co-owner set: ' || coalesce(n."name", 'unknown')
            ELSE 'Co-owner cleared: ' || coalesce(p."name", 'none') END
         || CASE WHEN a."reason" IS NOT NULL AND a."reason" <> '' THEN ' - ' || a."reason" ELSE '' END,
       a."createdAt"
FROM "AuditLog" a
JOIN "Lead" l ON l."id" = a."entityId"
JOIN "User" u ON u."id" = a."userId"
LEFT JOIN "User" n ON n."id" = a."after"->>'coOwnerId'
LEFT JOIN "User" p ON p."id" = a."before"->>'coOwnerId'
WHERE a."action" = 'lead.co_owner' AND a."entityType" = 'Lead'
UNION ALL
-- visit.create
SELECT 'bf_' || a."id", l."id", l."organizationId", a."userId",
       'VISIT'::"ActivityType",
       'Visit booked for ' || pg_temp.visit_when(v."scheduledFor") || ' with ' || coalesce(vu."name", 'unknown'),
       a."createdAt"
FROM "AuditLog" a
JOIN "SiteVisit" v ON v."id" = a."entityId"
JOIN "Lead" l ON l."id" = v."leadId"
JOIN "User" u ON u."id" = a."userId"
LEFT JOIN "User" vu ON vu."id" = v."userId"
WHERE a."action" = 'visit.create' AND a."entityType" = 'SiteVisit'
UNION ALL
-- visit.reschedule (skip rows that merely mark a superseded no-show)
SELECT 'bf_' || a."id", l."id", l."organizationId", a."userId",
       'VISIT'::"ActivityType",
       'Visit rescheduled to ' || pg_temp.visit_when(v."scheduledFor") || ' with ' || coalesce(vu."name", 'unknown'),
       a."createdAt"
FROM "AuditLog" a
JOIN "SiteVisit" v ON v."id" = a."entityId"
JOIN "Lead" l ON l."id" = v."leadId"
JOIN "User" u ON u."id" = a."userId"
LEFT JOIN "User" vu ON vu."id" = v."userId"
WHERE a."action" = 'visit.reschedule' AND a."entityType" = 'SiteVisit'
  AND a."after"->>'supersededBy' IS NULL
UNION ALL
-- visit.outcome (skip idempotent replays)
SELECT 'bf_' || a."id", l."id", l."organizationId", a."userId",
       'VISIT'::"ActivityType",
       CASE a."after"->>'status'
         WHEN 'COMPLETED' THEN 'Visit completed'
         WHEN 'NO_SHOW' THEN 'Visit marked no-show'
         WHEN 'CANCELLED' THEN 'Visit cancelled'
         WHEN 'RESCHEDULED' THEN 'Visit marked rescheduled'
         ELSE 'Visit ' || lower(coalesce(a."after"->>'status', 'updated'))
       END || ' (visit on ' || pg_temp.visit_when(v."scheduledFor") || ', ' || coalesce(vu."name", 'unknown') || ')',
       a."createdAt"
FROM "AuditLog" a
JOIN "SiteVisit" v ON v."id" = a."entityId"
JOIN "Lead" l ON l."id" = v."leadId"
JOIN "User" u ON u."id" = a."userId"
LEFT JOIN "User" vu ON vu."id" = v."userId"
WHERE a."action" = 'visit.outcome' AND a."entityType" = 'SiteVisit'
  AND coalesce(a."reason", '') NOT LIKE 'Idempotent replay%';

INSERT INTO "Activity" ("id", "leadId", "organizationId", "userId", "type", "body", "createdAt")
SELECT b.id, b."leadId", b."organizationId", b."userId", b.type, b.body, b."createdAt"
FROM _activity_backfill b
WHERE NOT EXISTS (
  SELECT 1 FROM "Activity" x
  WHERE x."leadId" = b."leadId" AND x."type" = b.type
    AND x."body" = b.body AND x."createdAt" = b."createdAt"
)
ON CONFLICT ("id") DO NOTHING;
DROP TABLE IF EXISTS _activity_backfill;
