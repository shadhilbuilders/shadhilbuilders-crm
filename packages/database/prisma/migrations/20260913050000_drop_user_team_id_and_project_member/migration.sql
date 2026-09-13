-- T-TEAM-AUTHORITATIVE (2026-09-13) clean cutover, Decision Audit Trail #40.
--
-- Drops the legacy single-team User.teamId column and the per-user
-- ProjectMember join. Membership is TeamMember; project staffing is
-- ProjectTeam. There is no production data to dual-write or reconcile.

-- ── ProjectMember ─────────────────────────────────────────────────────────
DROP POLICY IF EXISTS project_member_select_any_authenticated ON "ProjectMember";
DROP POLICY IF EXISTS project_member_write_admin ON "ProjectMember";
DROP POLICY IF EXISTS project_member_write_manager_admin ON "ProjectMember";
DROP TABLE IF EXISTS "ProjectMember";

-- ── User.teamId ───────────────────────────────────────────────────────────
ALTER TABLE "User" DROP CONSTRAINT IF EXISTS "User_teamId_fkey";
DROP INDEX IF EXISTS "User_teamId_idx";
ALTER TABLE "User" DROP COLUMN IF EXISTS "teamId";
