-- T-ProjectSwitch (2026-09-05): RLS policies for the Project registry.
--
-- Phase 2 of real project switching: the Project table previously had
-- FORCE ROW LEVEL SECURITY set by policies.sql's DO-block loop but
-- (a) no ENABLE and (b) zero policies - so RLS was a no-op and every
-- shadhil_app query saw all rows. This migration enables RLS and adds
-- the per-verb policies (shadhil-crm-dev rule 7e: all four verbs on
-- the day the table becomes RLS-active).
--
-- Access model:
--   SELECT  - every authenticated role. The project registry is shared
--             operational data (every staff member needs the switcher
--             list; RERA/CMDA numbers are public record fields).
--   INSERT  - ADMIN class (OWNER travels as ADMIN at the RLS layer -
--             locked Round-21 downcast in packages/database/src/rls.ts).
--   UPDATE  - ADMIN class. Owner-only rename is enforced ABOVE this
--             layer in ProjectsService (the GUC cannot distinguish
--             OWNER from ADMIN - rls.ts downcasts before SET LOCAL).
--             The DB policy is the second wall; the service is the
--             precise wall.
--   DELETE  - ADMIN class at the DB layer for the same reason.
--             ProjectsService additionally blocks deletes when
--             Bookings exist under the project's units.
--
-- Table-level GRANTs to shadhil_app already exist (policies.sql
-- DO-block GRANT loop covers 'Project'); re-stated here is harmless
-- (idempotent) and keeps this migration self-contained like
-- 20260905000100_t_e2b_inbound_rls_and_grants.

GRANT SELECT, INSERT, UPDATE, DELETE ON "Project" TO shadhil_app;

ALTER TABLE "Project" ENABLE ROW LEVEL SECURITY;

CREATE POLICY project_select_any_authenticated ON "Project"
  FOR SELECT
  USING (
    current_setting('app.user_role', true) IN
      ('ADMIN', 'MANAGER', 'TELECALLER', 'SALES_EXEC', 'CRON_SERVICE')
  );

CREATE POLICY project_insert_admin ON "Project"
  FOR INSERT
  WITH CHECK (current_setting('app.user_role', true) = 'ADMIN');

CREATE POLICY project_update_admin ON "Project"
  FOR UPDATE
  USING (current_setting('app.user_role', true) = 'ADMIN')
  WITH CHECK (current_setting('app.user_role', true) = 'ADMIN');

CREATE POLICY project_delete_admin ON "Project"
  FOR DELETE
  USING (current_setting('app.user_role', true) = 'ADMIN');