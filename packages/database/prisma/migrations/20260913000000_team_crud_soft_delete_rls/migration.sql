-- Team CRUD support (T-TEAM-CRUD, 2026-09-13).
--
-- 1. Team.deletedAt - soft delete, mirrors Project.deletedAt (migration
--    20260909180000_soft_delete). NULL = active, NOT NULL = deleted. No
--    data migration needed (all existing rows are active -> NULL).
-- 2. @@unique([organizationId, name]) - per-org name uniqueness, mirrors
--    Project's @@unique([organizationId, slug]).
-- 3. RLS: Team previously had FORCE ROW LEVEL SECURITY set by policies.sql's
--    DO-block loop but (a) no ENABLE and (b) zero policies - so RLS was a
--    no-op and every shadhil_app query saw all rows. This enables RLS and
--    adds the per-verb policies (mirrors Project's shape exactly, migration
--    20260905203000_project_rls_policies + the later org-scoping pass).
--
-- Table-level GRANTs to shadhil_app already exist (policies.sql DO-block
-- GRANT loop covers 'Team'); re-stated here is harmless (idempotent).

ALTER TABLE "Team" ADD COLUMN "deletedAt" TIMESTAMP(3);

ALTER TABLE "Team" ADD CONSTRAINT "Team_organizationId_name_key" UNIQUE ("organizationId", "name");

GRANT SELECT, INSERT, UPDATE, DELETE ON "Team" TO shadhil_app;

ALTER TABLE "Team" ENABLE ROW LEVEL SECURITY;

CREATE POLICY team_select_any_authenticated ON "Team"
  FOR SELECT
  USING (
    current_setting('app.user_role', true) IN
      ('ADMIN', 'MANAGER', 'TELECALLER', 'SALES_EXEC', 'CRON_SERVICE')
    AND "organizationId" = current_setting('app.user_org_id', true)
  );

CREATE POLICY team_insert_admin ON "Team"
  FOR INSERT
  WITH CHECK (
    current_setting('app.user_role', true) = 'ADMIN'
    AND "organizationId" = current_setting('app.user_org_id', true)
  );

CREATE POLICY team_update_admin ON "Team"
  FOR UPDATE
  USING (
    current_setting('app.user_role', true) = 'ADMIN'
    AND "organizationId" = current_setting('app.user_org_id', true)
  )
  WITH CHECK (
    current_setting('app.user_role', true) = 'ADMIN'
    AND "organizationId" = current_setting('app.user_org_id', true)
  );

CREATE POLICY team_delete_admin ON "Team"
  FOR DELETE
  USING (
    current_setting('app.user_role', true) = 'ADMIN'
    AND "organizationId" = current_setting('app.user_org_id', true)
  );
