-- ────────────────────────────────────────────────────────────────────────────
-- Customer portal redesign (2026-11-09): handover date + project milestones.
--
--   * Unit.expectedHandoverDate - nullable, staff-entered. NULL means "not
--     set" and the portal renders nothing (no default, no backfill, no guess).
--     Customers already read their own Unit row (unit_select_customer), so no
--     new Unit policy is needed; writes ride the existing staff Unit policies.
--   * ProjectMilestone - buyer-visible checkpoints per project.
--       SELECT: every staff role, ENGINEER on their own projects, CUSTOMER on
--               projects where they hold an APPROVED booking (the existing
--               customer_can_read_project() helper - SECURITY DEFINER, so no
--               policy cycle with Unit/Phase).
--       WRITE : ADMIN only (matches Project / ProjectTeam).
--     NO write arm exists for CUSTOMER or ENGINEER.
-- The canonical copy of these policies lives in prisma/rls/policies.sql.
-- ────────────────────────────────────────────────────────────────────────────

ALTER TABLE "Unit" ADD COLUMN "expectedHandoverDate" TIMESTAMP(3);

CREATE TABLE "ProjectMilestone" (
  "id" TEXT NOT NULL,
  "projectId" TEXT NOT NULL,
  "organizationId" TEXT NOT NULL,
  "name" TEXT NOT NULL,
  "targetDate" TIMESTAMP(3),
  "completedAt" TIMESTAMP(3),
  "sortOrder" INTEGER NOT NULL DEFAULT 0,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "ProjectMilestone_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "ProjectMilestone_projectId_sortOrder_idx" ON "ProjectMilestone"("projectId", "sortOrder");
CREATE INDEX "ProjectMilestone_organizationId_idx" ON "ProjectMilestone"("organizationId");

ALTER TABLE "ProjectMilestone"
  ADD CONSTRAINT "ProjectMilestone_projectId_fkey"
  FOREIGN KEY ("projectId") REFERENCES "Project"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "ProjectMilestone"
  ADD CONSTRAINT "ProjectMilestone_organizationId_fkey"
  FOREIGN KEY ("organizationId") REFERENCES "Organization"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "ProjectMilestone" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "ProjectMilestone" FORCE ROW LEVEL SECURITY;
GRANT SELECT, INSERT, UPDATE, DELETE ON "ProjectMilestone" TO shadhil_app;

CREATE POLICY project_milestone_select_staff ON "ProjectMilestone"
  FOR SELECT
  USING (
    current_setting('app.user_role', true) IN
      ('ADMIN', 'MANAGER', 'TELECALLER', 'SALES_EXEC', 'CRON_SERVICE')
    AND "organizationId" = current_setting('app.user_org_id', true)
  );

CREATE POLICY project_milestone_select_engineer ON "ProjectMilestone"
  FOR SELECT
  USING (
    "organizationId" = current_setting('app.user_org_id', true)
    AND current_setting('app.user_role', true) = 'ENGINEER'
    AND EXISTS (
      SELECT 1 FROM "ProjectTeam" pt
      JOIN "TeamMember" tm ON tm."teamId" = pt."teamId"
      WHERE pt."projectId" = "ProjectMilestone"."projectId"
        AND tm."userId" = current_setting('app.user_id', true)
    )
  );

CREATE POLICY project_milestone_select_customer ON "ProjectMilestone"
  FOR SELECT
  USING (
    "organizationId" = current_setting('app.user_org_id', true)
    AND customer_can_read_project("projectId")
  );

CREATE POLICY project_milestone_write_admin ON "ProjectMilestone"
  FOR ALL
  USING (
    current_setting('app.user_role', true) = 'ADMIN'
    AND "organizationId" = current_setting('app.user_org_id', true)
  )
  WITH CHECK (
    current_setting('app.user_role', true) = 'ADMIN'
    AND "organizationId" = current_setting('app.user_org_id', true)
  );
