-- T-TEAM-AUTHORITATIVE (2026-09-13, Decision Audit Trail #39)
-- Additive expand-phase migration for the team-authoritative staffing
-- cutover. See design doc referenced in that decision row.
--
-- This migration ONLY adds new tables/columns and backfills them from the
-- existing single-team model. It does NOT touch `User.teamId` or
-- `ProjectMember`, and does NOT change any existing RLS policy - every
-- current read/write path keeps working unmodified. The RLS/service cutover
-- to read from these new tables, and the eventual drop of the legacy
-- columns/table, are separate follow-up migrations landed only after a
-- zero-drift backfill reconciliation (plan Dependencies section).

-- ── AuditLog: batch grouping + idempotency columns ─────────────────────────
ALTER TABLE "AuditLog" ADD COLUMN "batchId" TEXT;
ALTER TABLE "AuditLog" ADD COLUMN "requestId" TEXT;

CREATE UNIQUE INDEX "AuditLog_requestId_key" ON "AuditLog"("requestId");
CREATE INDEX "AuditLog_batchId_idx" ON "AuditLog"("batchId");

-- ── TeamMember: additive multi-team staff<->team join ──────────────────────
CREATE TABLE "TeamMember" (
    "userId" TEXT NOT NULL,
    "teamId" TEXT NOT NULL,
    "organizationId" TEXT NOT NULL,
    "assignedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "assignedById" TEXT,

    CONSTRAINT "TeamMember_pkey" PRIMARY KEY ("userId", "teamId")
);

CREATE INDEX "TeamMember_userId_idx" ON "TeamMember"("userId");
CREATE INDEX "TeamMember_teamId_idx" ON "TeamMember"("teamId");
CREATE INDEX "TeamMember_organizationId_idx" ON "TeamMember"("organizationId");

ALTER TABLE "TeamMember" ADD CONSTRAINT "TeamMember_userId_fkey"
  FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "TeamMember" ADD CONSTRAINT "TeamMember_teamId_fkey"
  FOREIGN KEY ("teamId") REFERENCES "Team"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "TeamMember" ADD CONSTRAINT "TeamMember_organizationId_fkey"
  FOREIGN KEY ("organizationId") REFERENCES "Organization"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "TeamMember" ADD CONSTRAINT "TeamMember_assignedById_fkey"
  FOREIGN KEY ("assignedById") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- ── ProjectTeam: additive team<->project join (replaces ProjectMember) ─────
CREATE TABLE "ProjectTeam" (
    "projectId" TEXT NOT NULL,
    "teamId" TEXT NOT NULL,
    "organizationId" TEXT NOT NULL,
    "assignedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "assignedById" TEXT,

    CONSTRAINT "ProjectTeam_pkey" PRIMARY KEY ("projectId", "teamId")
);

CREATE INDEX "ProjectTeam_projectId_idx" ON "ProjectTeam"("projectId");
CREATE INDEX "ProjectTeam_teamId_idx" ON "ProjectTeam"("teamId");
CREATE INDEX "ProjectTeam_organizationId_idx" ON "ProjectTeam"("organizationId");

ALTER TABLE "ProjectTeam" ADD CONSTRAINT "ProjectTeam_projectId_fkey"
  FOREIGN KEY ("projectId") REFERENCES "Project"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "ProjectTeam" ADD CONSTRAINT "ProjectTeam_teamId_fkey"
  FOREIGN KEY ("teamId") REFERENCES "Team"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "ProjectTeam" ADD CONSTRAINT "ProjectTeam_organizationId_fkey"
  FOREIGN KEY ("organizationId") REFERENCES "Organization"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "ProjectTeam" ADD CONSTRAINT "ProjectTeam_assignedById_fkey"
  FOREIGN KEY ("assignedById") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- ── Backfill TeamMember from the legacy single-team model ──────────────────
-- Every active, non-soft-deleted user with a team gets a TeamMember row,
-- EXCEPT a manager whose legacy `teamId` equals a team they already manage
-- (plan Dependencies: "excluding a manager whose legacy teamId equals a team
-- they manage" - they already participate through Team.managerId, and a
-- duplicate row would violate fixture #4's "no duplicate manager TeamMember
-- row" invariant).
INSERT INTO "TeamMember" ("userId", "teamId", "organizationId", "assignedAt")
SELECT u."id", u."teamId", u."organizationId", now()
FROM "User" u
JOIN "Team" t ON t."id" = u."teamId"
WHERE u."teamId" IS NOT NULL
  AND u."deletedAt" IS NULL
  AND NOT (t."managerId" = u."id")
ON CONFLICT ("userId", "teamId") DO NOTHING;

-- ── Backfill ProjectTeam from legacy ProjectMember + Lead(projectId,teamId) ─
-- Source 1: every (project, team) pair implied by an existing ProjectMember
-- row (the member's team gets linked to that project).
INSERT INTO "ProjectTeam" ("projectId", "teamId", "organizationId", "assignedAt")
SELECT DISTINCT pm."projectId", u."teamId", pm."organizationId", now()
FROM "ProjectMember" pm
JOIN "User" u ON u."id" = pm."userId"
WHERE u."teamId" IS NOT NULL
ON CONFLICT ("projectId", "teamId") DO NOTHING;

-- Source 2: every (project, team) pair already implied by an existing Lead
-- row (a lead's team clearly works that project).
INSERT INTO "ProjectTeam" ("projectId", "teamId", "organizationId", "assignedAt")
SELECT DISTINCT l."projectId", l."teamId", l."organizationId", now()
FROM "Lead" l
WHERE l."projectId" IS NOT NULL
ON CONFLICT ("projectId", "teamId") DO NOTHING;

-- ── RLS: additive tables only, membership/org-scoped, non-recursive ────────
-- Mirrors the Team/Project SELECT shape (any authenticated business role,
-- org-gated). Writes are ADMIN-class for now; the Manager-scoped
-- add/remove-membership policy lands with the removal-endpoint migration
-- once TeamAccessService and the controller exist to enforce the
-- managed-teams-only invariant above this layer too (defense in depth).
ALTER TABLE "TeamMember" ENABLE ROW LEVEL SECURITY;

CREATE POLICY teammember_select_own_or_managed_or_admin ON "TeamMember"
  FOR SELECT
  USING (
    "organizationId" = current_setting('app.user_org_id', true)
    AND (
      current_setting('app.user_role', true) = 'ADMIN'
      OR "userId" = current_setting('app.user_id', true)
      OR EXISTS (
        SELECT 1 FROM "Team" t
        WHERE t."id" = "TeamMember"."teamId"
          AND t."managerId" = current_setting('app.user_id', true)
      )
    )
  );

CREATE POLICY teammember_write_admin ON "TeamMember"
  FOR ALL
  USING (
    current_setting('app.user_role', true) = 'ADMIN'
    AND "organizationId" = current_setting('app.user_org_id', true)
  )
  WITH CHECK (
    current_setting('app.user_role', true) = 'ADMIN'
    AND "organizationId" = current_setting('app.user_org_id', true)
  );

ALTER TABLE "ProjectTeam" ENABLE ROW LEVEL SECURITY;

CREATE POLICY projectteam_select_any_authenticated ON "ProjectTeam"
  FOR SELECT
  USING (
    current_setting('app.user_role', true) IN
      ('ADMIN', 'MANAGER', 'TELECALLER', 'SALES_EXEC', 'CRON_SERVICE')
    AND "organizationId" = current_setting('app.user_org_id', true)
  );

CREATE POLICY projectteam_write_admin ON "ProjectTeam"
  FOR ALL
  USING (
    current_setting('app.user_role', true) = 'ADMIN'
    AND "organizationId" = current_setting('app.user_org_id', true)
  )
  WITH CHECK (
    current_setting('app.user_role', true) = 'ADMIN'
    AND "organizationId" = current_setting('app.user_org_id', true)
  );

ALTER TABLE "TeamMember" FORCE ROW LEVEL SECURITY;
ALTER TABLE "ProjectTeam" FORCE ROW LEVEL SECURITY;

GRANT SELECT, INSERT, UPDATE, DELETE ON "TeamMember" TO shadhil_app;
GRANT SELECT, INSERT, UPDATE, DELETE ON "ProjectTeam" TO shadhil_app;
