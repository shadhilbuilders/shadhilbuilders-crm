-- ────────────────────────────────────────────────────────────────────────────
-- Issue #7 (slice 1): Customer progress — ENGINEER role + ProgressPhoto +
-- ProjectStaffRole + RLS/GRANTs + creator-label helper.
--
-- Spec: docs/specs/SPEC-customer-progress-slice-1-body.md
-- Design: docs/designs/customer-progress-portal.md (APPROVED; site-staff model)
-- Eng review: CLEARED 2026-10-26. Design review: CLEARED 2026-10-26.
--
-- SIX TOUCHPOINTS for the new role value ship in this migration + its sibling
-- code change (same release, never piecemeal — the closed role set throws
-- fail-closed on unknowns at runtime and JWT verification):
--   1. Prisma enum Role += ENGINEER            (schema.prisma, via prisma migrate)
--   2. packages/database/src/rls.ts ROLES      (code, same PR)
--   3. packages/auth-client/src/jwt.ts ROLES   (code, same PR)
--   4. packages/api-types RoleSchema + labels  (code, same PR)
--   5. nav/role-gating maps (client.ts, session.ts, users/roles.ts RANK, AddTeamMembersDialog, nav config) (code, same PR)
--   6. RLS policies below
--
-- NOTE: the Role enum ALTER references the new value in policy predicates
-- below; policy predicates evaluate at DML time (not DDL time), so the single
-- transaction is safe. Verified on PG 16: this file ran clean against a
-- schema-clone of the dev DB with ON_ERROR_STOP (member select/insert/update,
-- photo-lead update, non-member deny, sales-table deny, label helper).

-- ────────────────────────────────────────────────────────────────────────────

-- ── 1. Role enum (statement carries its own guard; idempotent) ──
ALTER TYPE "Role" ADD VALUE IF NOT EXISTS 'ENGINEER' AFTER 'TELECALLER';

-- ── 2. ProgressPhoto ──
CREATE TABLE "ProgressPhoto" (
  "id"             TEXT NOT NULL,
  "unitId"         TEXT NOT NULL,
  "phaseId"        TEXT,
  "organizationId" TEXT NOT NULL,
  "key"            TEXT NOT NULL,
  "mimeType"       TEXT NOT NULL,
  "filename"       TEXT NOT NULL,
  "caption"        TEXT NOT NULL,
  "takenAt"        TIMESTAMP(3) NOT NULL,
  "createdBy"      TEXT,
  "createdAt"      TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "ProgressPhoto_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "ProgressPhoto_unitId_takenAt_idx" ON "ProgressPhoto"("unitId", "takenAt" DESC);
CREATE INDEX "ProgressPhoto_organizationId_idx" ON "ProgressPhoto"("organizationId");

ALTER TABLE "ProgressPhoto"
  ADD CONSTRAINT "ProgressPhoto_unitId_fkey"
  FOREIGN KEY ("unitId") REFERENCES "Unit"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "ProgressPhoto"
  ADD CONSTRAINT "ProgressPhoto_phaseId_fkey"
  FOREIGN KEY ("phaseId") REFERENCES "Phase"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "ProgressPhoto"
  ADD CONSTRAINT "ProgressPhoto_createdBy_fkey"
  FOREIGN KEY ("createdBy") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- ── 3. ProjectStaffRole (per-project authority: PHOTO_LEAD) ──
CREATE TABLE "ProjectStaffRole" (
  "userId"         TEXT NOT NULL,
  "projectId"      TEXT NOT NULL,
  "organizationId" TEXT NOT NULL,
  "kind"           TEXT NOT NULL,
  "assignedById"   TEXT,
  "assignedAt"     TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "ProjectStaffRole_pkey" PRIMARY KEY ("userId", "projectId", "kind")
);

CREATE INDEX "ProjectStaffRole_projectId_idx" ON "ProjectStaffRole"("projectId");
CREATE INDEX "ProjectStaffRole_organizationId_idx" ON "ProjectStaffRole"("organizationId");

ALTER TABLE "ProjectStaffRole"
  ADD CONSTRAINT "ProjectStaffRole_userId_fkey"
  FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "ProjectStaffRole"
  ADD CONSTRAINT "ProjectStaffRole_projectId_fkey"
  FOREIGN KEY ("projectId") REFERENCES "Project"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "ProjectStaffRole"
  ADD CONSTRAINT "ProjectStaffRole_assignedById_fkey"
  FOREIGN KEY ("assignedById") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- ── 4. Table-level GRANTs (rule 7a: model + GRANTs + policies in ONE migration) ──
GRANT SELECT, INSERT, UPDATE, DELETE ON "ProgressPhoto" TO shadhil_app;
GRANT SELECT, INSERT, UPDATE, DELETE ON "ProjectStaffRole" TO shadhil_app;

-- ── 5. RLS enable ──
ALTER TABLE "ProgressPhoto" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "ProjectStaffRole" ENABLE ROW LEVEL SECURITY;

-- ── 6. ProjectStaffRole policies ──
-- Members see their own grants; ADMIN (which covers OWNER via the
-- withRlsContext downcast: there are NO separate OWNER policies) manages
-- org-wide. No INSERT/UPDATE/DELETE path exists for MANAGER or members by
-- design (spec: toggle is OWNER/ADMIN-only).
CREATE POLICY project_staff_role_select_own_or_admin ON "ProjectStaffRole"
  FOR SELECT
  USING (
    "organizationId" = current_setting('app.user_org_id', true)
    AND (
      "userId" = current_setting('app.user_id', true)
      OR current_setting('app.user_role', true) = 'ADMIN'
    )
  );

CREATE POLICY project_staff_role_write_admin ON "ProjectStaffRole"
  FOR INSERT
  WITH CHECK (
    current_setting('app.user_role', true) = 'ADMIN'
    AND "organizationId" = current_setting('app.user_org_id', true)
  );

CREATE POLICY project_staff_role_delete_admin ON "ProjectStaffRole"
  FOR DELETE
  USING (
    current_setting('app.user_role', true) = 'ADMIN'
    AND "organizationId" = current_setting('app.user_org_id', true)
  );

-- ── 7. ProgressPhoto: the member-access join. ──
-- Unit has NO projectId: the unit's project resolves through
-- Phase (Unit.phaseId -> Phase.projectId). Membership = ProjectTeam ->
-- TeamMember on (teamId, userId), OR the linked team's manager (Team.managerId).
-- The predicates below are role-agnostic about WHO the member is: the outer
-- role predicate decides which roles may use the member path; org-gating is
-- always present (fail-closed per header rules in prisma/rls/policies.sql).
CREATE POLICY progress_photo_select_member ON "ProgressPhoto"
  FOR SELECT
  USING (
    "organizationId" = current_setting('app.user_org_id', true)
    AND (
      current_setting('app.user_role', true) = 'ADMIN'
      OR (
        EXISTS (
          SELECT 1 FROM "Unit" u
          JOIN "Phase" ph ON ph."id" = u."phaseId"
          JOIN "ProjectTeam" pt ON pt."projectId" = ph."projectId"
          WHERE u."id" = "ProgressPhoto"."unitId"
            AND pt."organizationId" = current_setting('app.user_org_id', true)
            AND (
              EXISTS (
                SELECT 1 FROM "TeamMember" tm
                WHERE tm."teamId" = pt."teamId"
                  AND tm."userId" = current_setting('app.user_id', true)
              )
              OR EXISTS (
                SELECT 1 FROM "Team" t
                WHERE t."id" = pt."teamId"
                  AND t."managerId" = current_setting('app.user_id', true)
              )
            )
        )
      )
    )
  );

-- INSERT (WITH CHECK mirrors SELECT's member arm, plus creator binding:
-- a member can only create rows they own).
CREATE POLICY progress_photo_insert_member ON "ProgressPhoto"
  FOR INSERT
  WITH CHECK (
    "organizationId" = current_setting('app.user_org_id', true)
    AND (
      current_setting('app.user_role', true) = 'ADMIN'
      OR (
        "createdBy" = current_setting('app.user_id', true)
        AND EXISTS (
          SELECT 1 FROM "Unit" u
          JOIN "Phase" ph ON ph."id" = u."phaseId"
          JOIN "ProjectTeam" pt ON pt."projectId" = ph."projectId"
          WHERE u."id" = "ProgressPhoto"."unitId"
            AND pt."organizationId" = current_setting('app.user_org_id', true)
            AND (
              EXISTS (
                SELECT 1 FROM "TeamMember" tm
                WHERE tm."teamId" = pt."teamId"
                  AND tm."userId" = current_setting('app.user_id', true)
              )
              OR EXISTS (
                SELECT 1 FROM "Team" t
                WHERE t."id" = pt."teamId"
                  AND t."managerId" = current_setting('app.user_id', true)
              )
            )
        )
      )
    )
  );

-- UPDATE / DELETE: creator's own photo (any member role), photo-lead of the
-- photo's project (ProjectStaffRole kind='PHOTO_LEAD'), or ADMIN org-wide.
CREATE POLICY progress_photo_update ON "ProgressPhoto"
  FOR UPDATE
  USING (
    "organizationId" = current_setting('app.user_org_id', true)
    AND (
      current_setting('app.user_role', true) = 'ADMIN'
      OR "createdBy" = current_setting('app.user_id', true)
      OR EXISTS (
        SELECT 1 FROM "Unit" u
        JOIN "Phase" ph ON ph."id" = u."phaseId"
        JOIN "ProjectStaffRole" psr
          ON psr."projectId" = ph."projectId"
         AND psr."userId" = current_setting('app.user_id', true)
         AND psr."kind" = 'PHOTO_LEAD'
        WHERE u."id" = "ProgressPhoto"."unitId"
      )
    )
  )
  WITH CHECK (
    "organizationId" = current_setting('app.user_org_id', true)
    AND (
      current_setting('app.user_role', true) = 'ADMIN'
      OR "createdBy" = current_setting('app.user_id', true)
      OR EXISTS (
        SELECT 1 FROM "Unit" u
        JOIN "Phase" ph ON ph."id" = u."phaseId"
        JOIN "ProjectStaffRole" psr
          ON psr."projectId" = ph."projectId"
         AND psr."userId" = current_setting('app.user_id', true)
         AND psr."kind" = 'PHOTO_LEAD'
        WHERE u."id" = "ProgressPhoto"."unitId"
      )
    )
  );

CREATE POLICY progress_photo_delete ON "ProgressPhoto"
  FOR DELETE
  USING (
    "organizationId" = current_setting('app.user_org_id', true)
    AND (
      current_setting('app.user_role', true) = 'ADMIN'
      OR "createdBy" = current_setting('app.user_id', true)
      OR EXISTS (
        SELECT 1 FROM "Unit" u
        JOIN "Phase" ph ON ph."id" = u."phaseId"
        JOIN "ProjectStaffRole" psr
          ON psr."projectId" = ph."projectId"
         AND psr."userId" = current_setting('app.user_id', true)
         AND psr."kind" = 'PHOTO_LEAD'
        WHERE u."id" = "ProgressPhoto"."unitId"
      )
    )
  );

-- ── 8. Dependency reads for ENGINEER (scoped, never org-wide). ──
-- The existing Unit/Phase/Project/ProjectTeam SELECT policies enumerate
-- roles WITHOUT the new ENGINEER (20260910000000_inventory_rls +
-- 20260905203000 project policies + 20260913 teams), so an ENGINEER would
-- see NOTHING of these tables. We DO NOT widen those policies in place
-- (edit-applied-migrations is forbidden); we add NEW narrower policies.
-- Multiple permissive policies are OR'd, so these grant exactly the
-- member-shaped slice without exposing sibling projects.
CREATE POLICY project_select_team_member ON "Project"
  FOR SELECT
  USING (
    "organizationId" = current_setting('app.user_org_id', true)
    AND current_setting('app.user_role', true) = 'ENGINEER'
    AND EXISTS (
      SELECT 1 FROM "ProjectTeam" pt
      JOIN "TeamMember" tm ON tm."teamId" = pt."teamId"
      WHERE pt."projectId" = "Project"."id"
        AND tm."userId" = current_setting('app.user_id', true)
    )
  );

CREATE POLICY phase_select_team_member ON "Phase"
  FOR SELECT
  USING (
    "organizationId" = current_setting('app.user_org_id', true)
    AND current_setting('app.user_role', true) = 'ENGINEER'
    AND EXISTS (
      SELECT 1 FROM "ProjectTeam" pt
      JOIN "TeamMember" tm ON tm."teamId" = pt."teamId"
      WHERE pt."projectId" = "Phase"."projectId"
        AND tm."userId" = current_setting('app.user_id', true)
    )
  );

-- ProjectTeam SELECT for ENGINEER: the join tables above are THEMSELVES
-- RLS-gated (FORCE), so the membership subqueries in the Phase/Unit
-- policies cannot see their rows until the engineer can read the rows of
-- the teams they belong to. Member-scoped again - never org-wide.
CREATE POLICY project_team_select_engineer ON "ProjectTeam"
  FOR SELECT
  USING (
    "organizationId" = current_setting('app.user_org_id', true)
    AND current_setting('app.user_role', true) = 'ENGINEER'
    AND EXISTS (
      SELECT 1 FROM "TeamMember" tm
      WHERE tm."teamId" = "ProjectTeam"."teamId"
        AND tm."userId" = current_setting('app.user_id', true)
    )
  );

CREATE POLICY unit_select_team_member ON "Unit"
  FOR SELECT
  USING (
    "organizationId" = current_setting('app.user_org_id', true)
    AND current_setting('app.user_role', true) = 'ENGINEER'
    AND EXISTS (
      SELECT 1 FROM "Phase" ph
      JOIN "ProjectTeam" pt ON pt."projectId" = ph."projectId"
      JOIN "TeamMember" tm ON tm."teamId" = pt."teamId"
      WHERE ph."id" = "Unit"."phaseId"
        AND tm."userId" = current_setting('app.user_id', true)
    )
  );
-- NON-ENGINEER roles are NOT re-scoped: their existing org-wide policies on
-- Project/Team/Unit/Phase stand (boundary: never edit sales policies here).
-- ENGINEER on sales tables: NO rows anywhere (permissive-by-absence deny).

-- ── 9. Creator-label helper (SECURITY DEFINER). ──
-- TeamMember RLS hides other members' rows (teammember_select policy), so a
-- timeline viewer cannot resolve ANOTHER uploader's photoLead via ordinary
-- queries. This function labels one photo's creator bypassing TeamMember RLS,
-- gated by: (a) callable only inside a valid RLS context (GUCs set), (b) the
-- caller may read THE PHOTO (same member/ADMIN predicate as the SELECT
-- policy), (c) locked search_path, (d) revoked from PUBLIC.
CREATE OR REPLACE FUNCTION progress_photo_creator_label(p_photo_id TEXT)
RETURNS TABLE (creator_name TEXT, creator_is_photo_lead BOOLEAN)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_user_id   TEXT;
  v_role      TEXT;
  v_org_id    TEXT;
  v_creatorId TEXT;
  v_unitId    TEXT;
  v_orgId     TEXT;
  v_allowed   BOOLEAN;
BEGIN
  v_user_id := current_setting('app.user_id', true);
  v_role    := current_setting('app.user_role', true);
  v_org_id  := current_setting('app.user_org_id', true);

  -- No valid RLS context: fail closed.
  IF v_user_id IS NULL OR v_role IS NULL OR v_org_id IS NULL THEN
    RETURN;
  END IF;

  SELECT "createdBy", "unitId", "organizationId"
    INTO v_creatorId, v_unitId, v_orgId
    FROM "ProgressPhoto" WHERE "id" = p_photo_id;

  IF NOT FOUND OR v_orgId IS DISTINCT FROM v_org_id THEN
    RETURN; -- (NULL, NULL): caller reads "Unknown"
  END IF;

  -- Visibility: same access shape as the SELECT policy (ADMIN, member via
  -- ProjectTeam->TeamMember, or the linked team's manager).
  SELECT EXISTS (
    SELECT 1
      FROM "Unit" u
      JOIN "Phase" ph ON ph."id" = u."phaseId"
      JOIN "ProjectTeam" pt ON pt."projectId" = ph."projectId"
      LEFT JOIN "TeamMember" tm ON tm."teamId" = pt."teamId"
       AND tm."userId" = v_user_id
      LEFT JOIN "Team" t ON t."id" = pt."teamId"
       AND t."managerId" = v_user_id
      LEFT JOIN "ProjectStaffRole" psr
       ON psr."projectId" = ph."projectId"
      AND psr."userId" = v_user_id
      AND psr."kind" = 'PHOTO_LEAD'
      WHERE u."id" = v_unitId
        AND (tm."userId" IS NOT NULL OR t."id" IS NOT NULL)
  ) OR v_role = 'ADMIN'
    INTO v_allowed;

  IF NOT v_allowed THEN
    RETURN; -- (NULL, NULL)
  END IF;

  IF v_creatorId IS NULL THEN
    RETURN; -- creator deleted: (NULL, NULL)
  END IF;

  RETURN QUERY
  SELECT u."name",
           EXISTS (
             SELECT 1 FROM "ProjectStaffRole" psr2
              WHERE psr2."userId" = v_creatorId
                AND psr2."projectId" = (
                  SELECT ph2."projectId"
                    FROM "Unit" u2
                    JOIN "Phase" ph2 ON ph2."id" = u2."phaseId"
                    WHERE u2."id" = v_unitId
                )
                AND psr2."kind" = 'PHOTO_LEAD'
           )
    FROM "User" u
    WHERE u."id" = v_creatorId;
END;
$$;

REVOKE ALL ON FUNCTION progress_photo_creator_label(TEXT) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION progress_photo_creator_label(TEXT) TO shadhil_app;