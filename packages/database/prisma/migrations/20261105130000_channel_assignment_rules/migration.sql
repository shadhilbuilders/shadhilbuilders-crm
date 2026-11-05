-- T-CHANNEL-RULES (2026-11-05)
--
-- The ingestion endpoint now carries a channel for every lead that arrives
-- (T-LEAD-SOURCES): META_AD, HOUSING, MAGICBRICKS, 99ACRES, plus the channels
-- that already existed. The manager-assignment engine only routes a lead when a
-- rule matches `rule.source = lead.source` EXACTLY, so a channel without a rule
-- silently falls through to the team default and then to
-- LEADS_FALLBACK_OWNER_ID: the lead is captured, and lands on whoever the
-- fallback happens to be.
--
-- This adds the missing rules for the four channels, by CLONING the routing
-- decision each team has already made for its other inbound channel. No user
-- id, team id or organization id is written down here on purpose: the same
-- migration has to be correct in dev, in staging and in production, where those
-- ids differ, and a hardcoded target would either fail or, worse, route a real
-- client's enquiries to a user that does not exist in that database.
--
-- Which rule donates:
--   1. the team's META_AD rule, if it has one. A portal enquiry is an inbound
--      digital form, exactly like an ad form, and META_AD is the channel that
--      already routes to whoever takes new leads today.
--   2. otherwise the team's lowest-priority active wildcard rule (the catch-all).
--
-- Which channels are added: the four this change is about. A channel that
-- already has a rule is skipped, so running this twice inserts nothing the
-- second time.
--
-- Deliberately NOT added: WEBSITE and OTHER. OTHER is the bucket every
-- unrecognised channel lands in (T-LEAD-SOURCES), and pointing it at a specific
-- person is a staffing decision, not a consequence of this change.
--
-- Idempotent by construction: the id is derived from (teamId, source), so the
-- same row cannot be inserted twice, and `ON CONFLICT DO NOTHING` covers the
-- unique constraint (teamId, source, priority, projectId, phaseId, language,
-- region).
--
-- No table, no enum, no column and no policy changes here: ManagerAssignmentRule
-- already exists with its grants and RLS policies (Rule 7a does not apply).

WITH donor AS (
  SELECT DISTINCT ON (r."teamId")
    r."teamId",
    r."organizationId",
    r."targetUserId",
    r.priority
  FROM "ManagerAssignmentRule" r
  WHERE r.active = true
    AND r."projectId" IS NULL
    AND r."phaseId" IS NULL
    AND r.language IS NULL
    AND r.region IS NULL
  ORDER BY
    r."teamId",
    (r.source = 'META_AD') DESC, -- prefer the ad channel as the donor
    r.priority ASC,              -- then the team's widest rule
    r."createdAt" ASC
),
wanted(source) AS (
  VALUES ('META_AD'), ('HOUSING'), ('MAGICBRICKS'), ('99ACRES')
),
missing AS (
  SELECT
    d."teamId",
    d."organizationId",
    d."targetUserId",
    d.priority,
    w.source
  FROM donor d
  CROSS JOIN wanted w
  WHERE NOT EXISTS (
    SELECT 1
    FROM "ManagerAssignmentRule" x
    WHERE x."teamId" = d."teamId"
      AND x.source = w.source
  )
)
INSERT INTO "ManagerAssignmentRule" (
  id,
  "teamId",
  "organizationId",
  source,
  "targetUserId",
  priority,
  active,
  "createdAt"
)
SELECT
  'arm_' || substr(md5(m."teamId" || ':' || m.source), 1, 24),
  m."teamId",
  m."organizationId",
  m.source,
  m."targetUserId",
  m.priority,
  true,
  now()
FROM missing m
ON CONFLICT DO NOTHING;
