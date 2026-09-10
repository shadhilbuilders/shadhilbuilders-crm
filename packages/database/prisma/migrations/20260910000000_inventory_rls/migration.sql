-- Inventory RLS (2026-09-10): enable Row-Level Security on Unit + Phase.
--
-- The inventory grid (DESIGN.md module 4) is shared operational data -
-- every authenticated role reads it (Manager/Sales Exec/Admin per the
-- permission matrix; TELECALLER also needs the grid to reference units
-- during visits). Writes (create/update units) are ADMIN/OWNER only
-- (DESIGN.md §4 "Edit projects / units / inventory" = ADMIN/OWNER).
--
-- Access model (mirrors the Project registry pattern):
--   SELECT  - every authenticated role (the grid is shared data).
--   INSERT  - ADMIN class (OWNER travels as ADMIN at the RLS layer -
--             locked Round-21 downcast in packages/database/src/rls.ts).
--   UPDATE  - ADMIN class.
--   DELETE  - ADMIN class (no delete endpoint today, but the policy
--             keeps the table fully gated; a future admin delete won't
--             silently 0-row).
--
-- Table-level GRANTs to shadhil_app already exist (policies.sql DO-block
-- GRANT loop covers 'Phase','Unit'); re-stated here is harmless
-- (idempotent) and keeps this migration self-contained like
-- 20260905203000_project_rls_policies.

GRANT SELECT, INSERT, UPDATE, DELETE ON "Unit" TO shadhil_app;
GRANT SELECT, INSERT, UPDATE, DELETE ON "Phase" TO shadhil_app;

ALTER TABLE "Unit" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "Phase" ENABLE ROW LEVEL SECURITY;

CREATE POLICY unit_select_any_authenticated ON "Unit"
  FOR SELECT
  USING (
    current_setting('app.user_role', true) IN
      ('ADMIN', 'MANAGER', 'TELECALLER', 'SALES_EXEC', 'CRON_SERVICE')
  );

CREATE POLICY unit_insert_admin ON "Unit"
  FOR INSERT
  WITH CHECK (current_setting('app.user_role', true) = 'ADMIN');

CREATE POLICY unit_update_admin ON "Unit"
  FOR UPDATE
  USING (current_setting('app.user_role', true) = 'ADMIN')
  WITH CHECK (current_setting('app.user_role', true) = 'ADMIN');

CREATE POLICY unit_delete_admin ON "Unit"
  FOR DELETE
  USING (current_setting('app.user_role', true) = 'ADMIN');

CREATE POLICY phase_select_any_authenticated ON "Phase"
  FOR SELECT
  USING (
    current_setting('app.user_role', true) IN
      ('ADMIN', 'MANAGER', 'TELECALLER', 'SALES_EXEC', 'CRON_SERVICE')
  );

CREATE POLICY phase_insert_admin ON "Phase"
  FOR INSERT
  WITH CHECK (current_setting('app.user_role', true) = 'ADMIN');

CREATE POLICY phase_update_admin ON "Phase"
  FOR UPDATE
  USING (current_setting('app.user_role', true) = 'ADMIN')
  WITH CHECK (current_setting('app.user_role', true) = 'ADMIN');

CREATE POLICY phase_delete_admin ON "Phase"
  FOR DELETE
  USING (current_setting('app.user_role', true) = 'ADMIN');
