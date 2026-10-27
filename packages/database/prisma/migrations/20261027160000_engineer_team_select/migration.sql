-- Issue #7 slice 1 fix, take 2: engineer Team SELECT without policy recursion.
--
-- The first revision added team_select_engineer with an EXISTS subquery on
-- "TeamMember". That recurses: TeamMember's own SELECT policy
-- (teammember_select_own_or_managed_or_admin) subqueries Team.managerId,
-- so Team -> TeamMember -> Team hits Postgres 42P17 (infinite recursion
-- detected in policy for relation "Team") and EVERY policy evaluation on
-- both tables fails under an ENGINEER context.
--
-- Fix: a SECURITY DEFINER membership helper (same pattern as
-- progress_photo_creator_label from the slice-1 migration). It runs as the
-- table owner, outside RLS, and reads only the two columns it needs, so
-- the Team policy can ask "is this user a member of this team" without
-- re-entering TeamMember's policy. Revise project_team_select_engineer
-- (applied in 20261026160800) the same way - it has the identical EXISTS
-- shape and would recurse the moment Team became readable to engineers.

CREATE OR REPLACE FUNCTION team_member_exists(p_team_id TEXT, p_user_id TEXT)
RETURNS BOOLEAN
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT EXISTS (
    SELECT 1 FROM "TeamMember" tm
    WHERE tm."teamId" = p_team_id
      AND tm."userId" = p_user_id
  );
$$;

-- Owner-only execution: revoke PUBLIC, grant to the app role.
REVOKE ALL ON FUNCTION team_member_exists(TEXT, TEXT) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION team_member_exists(TEXT, TEXT) TO shadhil_app;

DROP POLICY IF EXISTS team_select_engineer ON "Team";
CREATE POLICY team_select_engineer ON "Team"
  FOR SELECT
  USING (
    "organizationId" = current_setting('app.user_org_id', true)
    AND current_setting('app.user_role', true) = 'ENGINEER'
    AND team_member_exists("Team"."id", current_setting('app.user_id', true))
  );

DROP POLICY IF EXISTS project_team_select_engineer ON "ProjectTeam";
CREATE POLICY project_team_select_engineer ON "ProjectTeam"
  FOR SELECT
  USING (
    "organizationId" = current_setting('app.user_org_id', true)
    AND current_setting('app.user_role', true) = 'ENGINEER'
    AND team_member_exists("ProjectTeam"."teamId", current_setting('app.user_id', true))
  );