-- Extend ProjectMember write RLS to MANAGER (autoplan 2026-09-09).
--
-- The Teams page lets MANAGER add/edit/unlink project members too (not just
-- ADMIN/OWNER). The service guard was widened already; the DB policy must
-- follow or the manager's tx hits RLS 42501. Drop the admin-only FOR ALL
-- policy and recreate it to include MANAGER.
--
-- `withRlsContext` downcasts OWNER→ADMIN and sets app.user_role. For a
-- MANAGER actor the GUC is 'MANAGER'. This policy governs INSERT/UPDATE/
-- DELETE on ProjectMember.
DROP POLICY IF EXISTS project_member_write_admin ON "ProjectMember";

CREATE POLICY project_member_write_manager_admin ON "ProjectMember"
  FOR ALL
  USING (current_setting('app.user_role', true) IN ('ADMIN', 'MANAGER'))
  WITH CHECK (current_setting('app.user_role', true) IN ('ADMIN', 'MANAGER'));
