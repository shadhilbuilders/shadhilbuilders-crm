-- Phase manager-write (2026-09-11): widen the Phase INSERT/UPDATE/DELETE
-- RLS policies to also allow MANAGER.
--
-- The inventory grid (DESIGN.md module 4) is shared operational data, but
-- phase management (create/rename/delete) is a project-structure edit. The
-- client confirmed MANAGER/ADMIN/OWNER may manage phases (the same gate as
-- project staff membership - canManageProjectMembers). The original
-- 20260910000000_inventory_rls migration gated Phase writes to ADMIN only;
-- without this widening a MANAGER's phase write would silently 0-row
-- (DEFAULT DENY) and surface as a confusing 500.
--
-- OWNER already travels as ADMIN at the RLS layer (locked Round-21
-- downcast in packages/database/src/rls.ts), so the ADMIN policy covers
-- OWNER. We add MANAGER to the same three policies.
--
-- Table-level GRANTs to shadhil_app already exist (policies.sql DO-block
-- GRANT loop covers 'Phase'); re-stated here is harmless (idempotent) and
-- keeps this migration self-contained like 20260910000000_inventory_rls.

GRANT SELECT, INSERT, UPDATE, DELETE ON "Phase" TO shadhil_app;

DROP POLICY IF EXISTS phase_insert_admin ON "Phase";
CREATE POLICY phase_insert_admin ON "Phase"
  FOR INSERT
  WITH CHECK (
    current_setting('app.user_role', true) IN ('ADMIN', 'MANAGER')
  );

DROP POLICY IF EXISTS phase_update_admin ON "Phase";
CREATE POLICY phase_update_admin ON "Phase"
  FOR UPDATE
  USING (current_setting('app.user_role', true) IN ('ADMIN', 'MANAGER'))
  WITH CHECK (current_setting('app.user_role', true) IN ('ADMIN', 'MANAGER'));

DROP POLICY IF EXISTS phase_delete_admin ON "Phase";
CREATE POLICY phase_delete_admin ON "Phase"
  FOR DELETE
  USING (current_setting('app.user_role', true) IN ('ADMIN', 'MANAGER'));
