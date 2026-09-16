-- T-MANAGER-MEMBERSHIP-WRITE (2026-09-13): let a MANAGER add/remove
-- TeamMember rows on teams they MANAGE.
--
-- Gap being closed: the service layer (TeamAccessService.canMutateTeam) and
-- the design doc's authorization matrix both grant MANAGER
-- "Add/remove TeamMember | Managed teams only", but the only write policy on
-- the table was teammember_write_admin (ADMIN-only). A MANAGER's
-- teamMember.create therefore failed with
--   42501 new row violates row-level security policy for table "TeamMember"
-- and teamMember.deleteMany matched 0 rows and reported `count: 0`
-- (FOR DELETE is gated by USING only, so an RLS-hidden row is simply not
-- matched - a silent no-op, not an error).
--
-- Scope: deliberately narrower than the phase_manager_write precedent
-- (20260911000000), which widens by ROLE only. The matrix restricts a
-- MANAGER to MANAGED teams, so this mirrors lead_insert_manager's
-- `Team.managerId = app.user_id` EXISTS check. A MANAGER cannot write into
-- another manager's team, and cannot add themselves to a team they don't lead.
--
-- Additive: Postgres OR's overlapping permissive FOR ALL policies, so
-- teammember_write_admin continues to grant ADMIN (and OWNER, downcast to
-- ADMIN in packages/database/src/rls.ts) org-wide write.
--
-- Canonical source: packages/database/prisma/rls/policies.sql
-- (TeamMember section) - keep the two in sync.

DROP POLICY IF EXISTS teammember_write_manager ON "TeamMember";

CREATE POLICY teammember_write_manager ON "TeamMember"
  FOR ALL
  USING (
    current_setting('app.user_role', true) = 'MANAGER'
    AND "organizationId" = current_setting('app.user_org_id', true)
    AND EXISTS (
      SELECT 1 FROM "Team" t
      WHERE t."id" = "TeamMember"."teamId"
        AND t."managerId" = current_setting('app.user_id', true)
    )
  )
  WITH CHECK (
    current_setting('app.user_role', true) = 'MANAGER'
    AND "organizationId" = current_setting('app.user_org_id', true)
    AND EXISTS (
      SELECT 1 FROM "Team" t
      WHERE t."id" = "TeamMember"."teamId"
        AND t."managerId" = current_setting('app.user_id', true)
    )
  );
