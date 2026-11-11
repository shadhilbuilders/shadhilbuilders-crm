-- Site-engineer unit assignment (2026-11-10).
-- 1. Unit.assignedEngineerId/assignedAt/assignedById (+FKs SetNull, index).
-- 2. project_unit_ids() SECURITY DEFINER helper (created BEFORE narrowing so the
--    inbox can still resolve a project's units for an unassigned engineer).
-- 3. Narrow ENGINEER reads: unit_select_team_member -> unit_select_assigned_engineer,
--    and the ProgressPhoto engineer arms. Canonical copy: prisma/rls/policies.sql.

ALTER TABLE "Unit" ADD COLUMN "assignedEngineerId" TEXT;
ALTER TABLE "Unit" ADD COLUMN "assignedAt" TIMESTAMP(3);
ALTER TABLE "Unit" ADD COLUMN "assignedById" TEXT;
ALTER TABLE "Unit" ADD CONSTRAINT "Unit_assignedEngineerId_fkey" FOREIGN KEY ("assignedEngineerId") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "Unit" ADD CONSTRAINT "Unit_assignedById_fkey" FOREIGN KEY ("assignedById") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;
CREATE INDEX "Unit_assignedEngineerId_idx" ON "Unit"("assignedEngineerId");

-- All unit ids of a project, visibility-independent (SECURITY DEFINER): the
-- notification inbox must still resolve the project's units for an engineer
-- who has just been unassigned (they can no longer read the Unit row).
CREATE OR REPLACE FUNCTION project_unit_ids(p_project_id TEXT)
  RETURNS SETOF TEXT
  LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public AS $$
    SELECT u."id"
    FROM "Unit" u
    JOIN "Phase" ph ON ph."id" = u."phaseId"
    WHERE ph."projectId" = p_project_id
      AND u."organizationId" = current_setting('app.user_org_id', true)
  $$;
REVOKE ALL ON FUNCTION project_unit_ids(TEXT) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION project_unit_ids(TEXT) TO shadhil_app;

DROP POLICY unit_select_team_member ON "Unit";
CREATE POLICY unit_select_assigned_engineer ON "Unit"
  FOR SELECT
  USING (
    "organizationId" = current_setting('app.user_org_id', true)
    AND current_setting('app.user_role', true) = 'ENGINEER'
    AND "assignedEngineerId" = current_setting('app.user_id', true)
  );

DROP POLICY progress_photo_select_member ON "ProgressPhoto";
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
          AND (
            current_setting('app.user_role', true) <> 'ENGINEER'
            OR u."assignedEngineerId" = current_setting('app.user_id', true)
          )
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

DROP POLICY progress_photo_insert_member ON "ProgressPhoto";
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
          AND (
            current_setting('app.user_role', true) <> 'ENGINEER'
            OR u."assignedEngineerId" = current_setting('app.user_id', true)
          )
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

DROP POLICY progress_photo_update ON "ProgressPhoto";
CREATE POLICY progress_photo_update ON "ProgressPhoto"
  FOR UPDATE
  USING (
    "organizationId" = current_setting('app.user_org_id', true)
    AND (
      current_setting('app.user_role', true) = 'ADMIN'
      OR (
        "createdBy" = current_setting('app.user_id', true)
        AND (
          current_setting('app.user_role', true) <> 'ENGINEER'
          OR EXISTS (
            SELECT 1 FROM "Unit" au
            WHERE au."id" = "ProgressPhoto"."unitId"
              AND au."assignedEngineerId" = current_setting('app.user_id', true)
          )
        )
      )
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
      OR (
        "createdBy" = current_setting('app.user_id', true)
        AND (
          current_setting('app.user_role', true) <> 'ENGINEER'
          OR EXISTS (
            SELECT 1 FROM "Unit" au
            WHERE au."id" = "ProgressPhoto"."unitId"
              AND au."assignedEngineerId" = current_setting('app.user_id', true)
          )
        )
      )
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

DROP POLICY progress_photo_delete ON "ProgressPhoto";
CREATE POLICY progress_photo_delete ON "ProgressPhoto"
  FOR DELETE
  USING (
    "organizationId" = current_setting('app.user_org_id', true)
    AND (
      current_setting('app.user_role', true) = 'ADMIN'
      OR (
        "createdBy" = current_setting('app.user_id', true)
        AND (
          current_setting('app.user_role', true) <> 'ENGINEER'
          OR EXISTS (
            SELECT 1 FROM "Unit" au
            WHERE au."id" = "ProgressPhoto"."unitId"
              AND au."assignedEngineerId" = current_setting('app.user_id', true)
          )
        )
      )
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

