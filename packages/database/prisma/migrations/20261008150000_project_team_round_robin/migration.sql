-- T-TEAM-ROUND-ROBIN (2026-10-08): team-level round-robin cursor for auto-assign.
--
-- Auto-assign now rotates strictly between the teams linked to a project (one
-- lead per team in turn). "Whose turn" must be stored: the team routed to
-- longest ago (NULL = never) goes next. Additive + nullable, so existing rows
-- keep working (they all start at NULL and rotate by teamId).
ALTER TABLE "ProjectTeam" ADD COLUMN "lastAssignedAt" TIMESTAMP(3);

-- ProjectTeam writes are ADMIN-only under RLS (projectteam_write_admin), but the
-- user creating a lead is usually a manager / telecaller, so a plain UPDATE would
-- silently match zero rows and the rotation would never advance. Same pattern as
-- unit_recompute_status (20260915060000_unit_status_sync): a SECURITY DEFINER
-- function that is the ONLY write path for this derived column.
--
-- Tenant safety: the function is scoped to the caller's org via the
-- app.user_org_id GUC, so it cannot advance another organization's cursor.
-- search_path is pinned so the definer's privileges cannot be hijacked.
CREATE OR REPLACE FUNCTION advance_project_team_cursor(p_project_id text, p_team_id text)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  UPDATE "ProjectTeam"
     SET "lastAssignedAt" = clock_timestamp()
   WHERE "projectId" = p_project_id
     AND "teamId" = p_team_id
     AND "organizationId" = current_setting('app.user_org_id', true);
END $$;

COMMENT ON FUNCTION advance_project_team_cursor(text, text) IS
  'T-TEAM-ROUND-ROBIN: stamps ProjectTeam.lastAssignedAt for the caller''s org. SECURITY DEFINER because ProjectTeam writes are ADMIN-only under RLS.';

REVOKE ALL ON FUNCTION advance_project_team_cursor(text, text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION advance_project_team_cursor(text, text) TO shadhil_app;
