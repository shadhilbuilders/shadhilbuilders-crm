-- ────────────────────────────────────────────────────────────────────────────
-- Week 5 — T-ARM-SCHEMA + T-S hardening (Plan §18 D2 + T-S hardening §).
-- ────────────────────────────────────────────────────────────────────────────
-- Brings the ManagerAssignmentRule engine from the stub to the FULL
-- Plan §18 D2 spec, and adds the mustChangePassword column on User
-- that gates the placeholder-password sign-in flow.
--
-- Changes:
--   ManagerAssignmentRule
--     + priority         Int          @default(0) — CSS-style ordering
--     + projectId        String?                 — optional criterion
--     + phaseId          String?                 — optional criterion
--     + language         String?                 — ISO 639-1 code (en/hi/ta)
--     + region           String?                 — ISO 3166-1 subdivision
--     ~ @@unique([teamId, source])
--         widened to @@unique([teamId, source, priority, projectId,
--                             phaseId, language, region])
--         so a team can declare multiple rules for the same source
--         differentiated by priority + criteria.
--
--   Team
--     + defaultAssigneeId String?      (relates User @relation("TeamDefaultAssignee"))
--     + @@index([defaultAssigneeId])
--
--   User
--     + mustChangePassword Boolean @default(true)
--     + relation defaultAssigneeOf Team[] @relation("TeamDefaultAssignee")
--
--   Backfill (T-S hardening):
--     UPDATE "User" SET "mustChangePassword" = false WHERE email = 'demo@shadhilbuilders.in';
--     The asymmetry is intentional: the 5 seed users (owner / admin /
--     manager / telecaller / sales_exec) keep the placeholder gate so
--     the post-deploy rotation prompt fires. The demo user is exempt
--     so the Sunday client demo path works without a forced rotation.
--     Seed scripts (packages/database/src/seed.ts and
--     packages/database/scripts/setup-demo-user.ts) are updated in the
--     same commit so a fresh seed reproduces this backfill.

-- 1. ManagerAssignmentRule — new columns + unique-constraint change.
ALTER TABLE "ManagerAssignmentRule"
  ADD COLUMN "priority" INTEGER NOT NULL DEFAULT 0,
  ADD COLUMN "projectId" TEXT,
  ADD COLUMN "phaseId" TEXT,
  ADD COLUMN "language" TEXT,
  ADD COLUMN "region" TEXT;

-- Drop the old tight unique index (one rule per (team, source)) and
-- replace with the wider composite index.
DROP INDEX IF EXISTS "ManagerAssignmentRule_teamId_source_key";
CREATE UNIQUE INDEX "ManagerAssignmentRule_teamId_source_priority_projectId_phaseId_language_region_key"
  ON "ManagerAssignmentRule"("teamId", "source", "priority", "projectId", "phaseId", "language", "region");

CREATE INDEX "ManagerAssignmentRule_priority_idx" ON "ManagerAssignmentRule"("priority");

-- 2. Team — defaultAssigneeId column + FK + index.
ALTER TABLE "Team"
  ADD COLUMN "defaultAssigneeId" TEXT;

CREATE INDEX "Team_defaultAssigneeId_idx" ON "Team"("defaultAssigneeId");

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM information_schema.table_constraints
    WHERE constraint_name = 'Team_defaultAssigneeId_fkey'
      AND table_name = 'Team'
  ) THEN
    ALTER TABLE "Team"
      ADD CONSTRAINT "Team_defaultAssigneeId_fkey"
      FOREIGN KEY ("defaultAssigneeId") REFERENCES "User"("id")
      ON DELETE SET NULL ON UPDATE CASCADE;
  END IF;
END $$;

-- 3. User — mustChangePassword column.
ALTER TABLE "User"
  ADD COLUMN "mustChangePassword" BOOLEAN NOT NULL DEFAULT true;

-- 4. T-S hardening backfill (demo user exempt — see banner above).
UPDATE "User"
  SET "mustChangePassword" = false
  WHERE email = 'demo@shadhilbuilders.in';

-- 5. ManagerAssignmentRule SELECT policy (T-ARM-SCHEMA).
-- Mirrors packages/database/prisma/rls/policies.sql. MANAGER + ADMIN/OWNER
-- can read their team's rules; INSERT/UPDATE/DELETE are DEFAULT DENY
-- (no policy) until the dedicated admin endpoint ships.
ALTER TABLE "ManagerAssignmentRule" ENABLE ROW LEVEL SECURITY;

CREATE POLICY managerassignmentrule_select_team ON "ManagerAssignmentRule"
  FOR SELECT
  USING (
    (
      current_setting('app.user_role', true) = 'MANAGER'
      AND "teamId" = current_setting('app.user_team_id', true)
    )
    OR current_setting('app.user_role', true) IN ('ADMIN', 'OWNER')
  );

-- 6. Per-table GRANTs for the new columns. shadhil_app already has CRUD
-- on the table; the column additions don't change GRANT semantics. Add
-- an explicit GRANT statement for idempotency in case a future policy
-- reset re-applies permissions without the new columns.
GRANT SELECT ("priority", "projectId", "phaseId", "language", "region")
  ON "ManagerAssignmentRule" TO shadhil_app;
GRANT SELECT ("defaultAssigneeId") ON "Team" TO shadhil_app;
GRANT SELECT, UPDATE ("mustChangePassword") ON "User" TO shadhil_app;