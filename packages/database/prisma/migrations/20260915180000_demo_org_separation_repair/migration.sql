-- Move the demo user into its own organization and repair the real org (2026-09-15).
--
-- Context: `setup-demo-user.ts` used to create demo@shadhilbuilders.in as a
-- MANAGER INSIDE the bootstrap org and then run
--   lead.updateMany({ where: { id: { not: { startsWith: 'test-' } } }, ... })
-- reassigning ~120 real leads to that user + a "Demo Team". The script is now
-- re-scoped so the demo user is an OWNER of a SEPARATE demo org with its own
-- data, and the destructive reassignment is gone.
--
-- This migration repairs the state the old script left behind:
--   1. Leads in the real org whose owner is the demo user are reassigned to
--      that org's OWNER - a real member of the org. Leaving them owned by a
--      user in another tenant is incoherent: RLS scopes Lead visibility by
--      organizationId, so the row stays in the real org while its ownerId
--      points into the demo org.
--   2. The orphaned "Demo Team" in the real org is removed once nothing points
--      at it (the team the demo script created; its manager is leaving the org).
--
-- The demo user's own org/team/leads/bookings are NOT touched here - the
-- (rewritten) setup-demo-user.ts creates those under its own org id.
--
-- Idempotent and safe on a fresh DB: every statement is a no-op when the demo
-- user, its leads or its team do not exist. No hardcoded user/team ids - the
-- targets are resolved by the demo email + role so a fresh DB with different
-- fixtures behaves identically.

-- 1. Reassign real-org leads owned by the demo user to the org's seeded ADMIN.
--
-- Target role is ADMIN, not OWNER, for two reasons:
--   - `LeadOwnerType` has no OWNER variant (enum: TELECALLER | SALES_EXEC |
--     MANAGER | ADMIN), so `ownerType = 'OWNER'` is rejected by the DB - caught
--     by running this migration inside a rolled-back transaction first.
--   - The seeded admin@ account is a real, active member of the org and is the
--     most privileged role `LeadOwnerType` can express.
--
-- Shape note: the new owner is resolved with a correlated scalar subquery, NOT
-- a `JOIN` in the FROM clause. Postgres rejects referencing the UPDATE target's
-- alias (`l`) from a joined table's ON clause - "invalid reference to
-- FROM-clause entry for table l" - so the org match has to be expressed inside
-- the subquery. Verified in a rolled-back transaction.
--
-- Scoped to leads whose organizationId is NOT the demo org (i.e. the real
-- tenant), so it can never touch the new demo org's own leads.
UPDATE "Lead" l
   SET "ownerId" = (
         SELECT a."id"
           FROM "User" a
          WHERE a."organizationId" = l."organizationId"
            AND a.role = 'ADMIN'
            AND a."deletedAt" IS NULL
            -- Seeded, human-owned accounts only: skip the `...@test.local` /
            -- `...@x` fixtures so a transient test user never becomes the owner
            -- of real leads.
            AND a.email NOT LIKE '%@test.local'
            AND a.email NOT LIKE '%@x'
          ORDER BY a."createdAt" ASC
          LIMIT 1
       ),
       "ownerType" = 'ADMIN',
       -- teamId is intentionally LEFT ALONE: `Lead.teamId` is NOT NULL, so
       -- clearing it aborts the whole UPDATE ("null value in column teamId
       -- violates not-null constraint" - caught in a rolled-back transaction).
       -- The lead's team is an org-scoped real team, so it stays valid.
       "updatedAt" = now()
 WHERE l."ownerId" = (
         SELECT d."id" FROM "User" d WHERE d.email = 'demo@shadhilbuilders.in'
       )
   AND l."organizationId" <> 'j6lic67mwuop8ur7epjylexz'
   -- Only move rows we actually resolved a new owner for.
   AND EXISTS (
         SELECT 1 FROM "User" a
          WHERE a."organizationId" = l."organizationId"
            AND a.role = 'ADMIN'
            AND a."deletedAt" IS NULL
            AND a.email NOT LIKE '%@test.local'
            AND a.email NOT LIKE '%@x'
       );

-- 2. Drop the demo user's leftover team membership rows in the real org.
DELETE FROM "TeamMember"
 WHERE "userId" IN (SELECT id FROM "User" WHERE email = 'demo@shadhilbuilders.in')
   AND "organizationId" <> 'j6lic67mwuop8ur7epjylexz';

-- 3. Repoint the demo user's leftover real-org team(s) to a real org member.
--
-- `Team.managerId` is an ACTIVE relationship, unlike the historical actor
-- references (AuditLog.userId etc.) which must be preserved. Leaving it
-- pointing at a user who now lives in another org is incoherent: the team would
-- be led by a non-member.
--
-- The team itself is NOT deleted: the reassigned leads still reference it via
-- `Lead.teamId` (which is NOT NULL), so removing it would either fail or orphan
-- them. Repointing keeps the leads, their team and the org consistent.
UPDATE "Team" t
   SET "managerId" = (
         SELECT a."id"
           FROM "User" a
          WHERE a."organizationId" = t."organizationId"
            AND a.role = 'ADMIN'
            AND a."deletedAt" IS NULL
            AND a.email NOT LIKE '%@test.local'
            AND a.email NOT LIKE '%@x'
          ORDER BY a."createdAt" ASC
          LIMIT 1
       )
 WHERE t."managerId" IN (
         SELECT d."id" FROM "User" d WHERE d.email = 'demo@shadhilbuilders.in'
       )
   AND t."organizationId" <> 'j6lic67mwuop8ur7epjylexz'
   AND EXISTS (
         SELECT 1 FROM "User" a
          WHERE a."organizationId" = t."organizationId"
            AND a.role = 'ADMIN'
            AND a."deletedAt" IS NULL
            AND a.email NOT LIKE '%@test.local'
            AND a.email NOT LIKE '%@x'
       );
