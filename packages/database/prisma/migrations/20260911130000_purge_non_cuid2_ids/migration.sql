-- 20260911130000_purge_non_cuid2_ids
-- ---------------------------------------------------------------------------
-- Enforce the cuid2-only id contract (z.cuid2() = /^[0-9a-z]+$/ in zod 4).
-- Prisma runtime ids and fixed seed ids are lowercase-alphanumeric; the only
-- rows that violate the contract are hyphenated/uppercase legacy fixture +
-- test-residue ids (fixture-*, test-*, dummy*, demo-team, seed-team-*, etc.)
-- left in the dev DB by test runs.
--
-- Decision: purge ALL non-cuid2 rows in the entity tables, then re-seed
-- (pnpm --filter @shadhil/database seed) to recreate the demo data with
-- proper cuid2 ids. The old seed team (seed-team-...) + its rules are
-- deleted here; the seed script upserts the new SEED_TEAM_ID / SEED_RULE_IDS
-- fresh.
--
-- Tables deliberately EXCLUDED (their ids are auth tokens / migration
-- version rows, not entity ids the API validates as cuid2): Session, Jwks,
-- Verification, Consent (consent.id is cuid; consent.leadId handled via Lead
-- cascade), Account (account.id is cuid), _prisma_migrations (UUID).
--
-- Delete order matters for RESTRICT FKs:
--   Booking.unitId -> Unit       RESTRICT   (must delete Booking rows first)
--   Booking.leadId -> Lead       CASCADE
--   Lead.teamId    -> Team       RESTRICT   (delete Leaps before non-cuid2 Teams)
--   Lead.ownerId   -> User       RESTRICT
-- ---------------------------------------------------------------------------

-- 1) Bookings referencing non-cuid2 unit/lead/user (frees the Unit RESTRICT FK).
DELETE FROM "Booking"
WHERE  "id" ~ '[A-Z-]'
    OR "unitId" ~ '[A-Z-]'
    OR "leadId" ~ '[A-Z-]'
    OR "userId" ~ '[A-Z-]';

-- 2) Leads referencing non-cuid2 team/owner/id. Deleting a Lead cascades its
--    Activity / SiteVisit / Message / Reminder / Consent / OutboundMessage.
DELETE FROM "Lead"
WHERE  "id" ~ '[A-Z-]'
    OR "teamId" ~ '[A-Z-]'
    OR "ownerId" ~ '[A-Z-]'
    OR "coOwnerId" ~ '[A-Z-]';

-- 3) Leaf tables no longer reachable (their parents were deleted).
DELETE FROM "Activity"      WHERE "id" ~ '[A-Z-]';
DELETE FROM "SiteVisit"     WHERE "id" ~ '[A-Z-]';
DELETE FROM "Message"       WHERE "id" ~ '[A-Z-]';
DELETE FROM "Reminder"      WHERE "id" ~ '[A-Z-]';
DELETE FROM "Notification"  WHERE "id" ~ '[A-Z-]';
DELETE FROM "AuditLog"      WHERE "id" ~ '[A-Z-]';
DELETE FROM "ManagerAssignmentRule" WHERE "id" ~ '[A-Z-]';
DELETE FROM "WhatsappUnknownContact" WHERE "id" ~ '[A-Z-]';

-- 4) Phases/Units under non-cuid2 projects, then the projects themselves.
--    Unit.bookings were freed in (1). Project delete cascades Phase/Unit/
--    ProjectOption/ProjectMember, and SET NULLs Lead.projectId.
DELETE FROM "Unit"    WHERE "id" ~ '[A-Z-]' OR "phaseId" ~ '[A-Z-]';
DELETE FROM "Phase"   WHERE "id" ~ '[A-Z-]' OR "projectId" ~ '[A-Z-]';
DELETE FROM "Project" WHERE "id" ~ '[A-Z-]';

-- 5) Teams (now free: no Lead references them) then Users who had non-cuid2
--    ids. Team delete SET NULLs non-residue User.teamId, cascades rules.
--    User delete cascades Session/Account/Notification/Reminder/Activity/
--    PushSubscription/StreamTicket/ProjectMember + SET NULLs Booking/
--    AuditLog/Message/Lead.coOwnerId.
DELETE FROM "Team" WHERE "id" ~ '[A-Z-]';
DELETE FROM "User" WHERE "id" ~ '[A-Z-]';
