-- T-TEAM-AUTHORITATIVE (2026-09-13, Decision Audit Trail #39)
-- Phase 2 of the RLS cutover: every MANAGER-role policy clause switches
-- from the single-valued `app.user_team_id` GUC equality to an EXISTS
-- check against `Team.managerId` - a manager may now lead multiple teams
-- (the "one manager already leads a team" guard was removed from
-- teams.service.ts's assertManagerAssignable in this same cutover).
--
-- TELECALLER/SALES_EXEC and ADMIN clauses are UNCHANGED (split out of
-- combined role-lists where necessary, but not otherwise modified) -
-- this migration touches ONLY the manager-team-membership check.
--
-- See packages/database/prisma/rls/policies.sql for the canonical,
-- fully-commented version of every policy recreated here.

-- ── Lead ────────────────────────────────────────────────────────────────
DROP POLICY IF EXISTS lead_select_manager ON "Lead";
CREATE POLICY lead_select_manager ON "Lead"
  FOR SELECT
  USING (
    current_setting('app.user_role', true) = 'MANAGER'
    AND "organizationId" = current_setting('app.user_org_id', true)
    AND EXISTS (
      SELECT 1 FROM "Team" t
      WHERE t."id" = "Lead"."teamId"
        AND t."managerId" = current_setting('app.user_id', true)
    )
  );

DROP POLICY IF EXISTS lead_insert_telecaller ON "Lead";
CREATE POLICY lead_insert_telecaller ON "Lead"
  FOR INSERT
  WITH CHECK (
    current_setting('app.user_role', true) IN ('TELECALLER', 'SALES_EXEC')
    AND "teamId" = current_setting('app.user_team_id', true)
    AND "organizationId" = current_setting('app.user_org_id', true)
  );

CREATE POLICY lead_insert_manager ON "Lead"
  FOR INSERT
  WITH CHECK (
    current_setting('app.user_role', true) = 'MANAGER'
    AND "organizationId" = current_setting('app.user_org_id', true)
    AND EXISTS (
      SELECT 1 FROM "Team" t
      WHERE t."id" = "Lead"."teamId"
        AND t."managerId" = current_setting('app.user_id', true)
    )
  );

DROP POLICY IF EXISTS lead_update_manager ON "Lead";
CREATE POLICY lead_update_manager ON "Lead"
  FOR UPDATE
  USING (
    current_setting('app.user_role', true) = 'MANAGER'
    AND "organizationId" = current_setting('app.user_org_id', true)
    AND EXISTS (
      SELECT 1 FROM "Team" t
      WHERE t."id" = "Lead"."teamId"
        AND t."managerId" = current_setting('app.user_id', true)
    )
  )
  WITH CHECK (
    current_setting('app.user_role', true) = 'MANAGER'
    AND "organizationId" = current_setting('app.user_org_id', true)
    AND EXISTS (
      SELECT 1 FROM "Team" t
      WHERE t."id" = "Lead"."teamId"
        AND t."managerId" = current_setting('app.user_id', true)
    )
  );

-- ── Activity ────────────────────────────────────────────────────────────
DROP POLICY IF EXISTS activity_select_team ON "Activity";
CREATE POLICY activity_select_team ON "Activity"
  FOR SELECT
  USING (
    "Activity"."organizationId" = current_setting('app.user_org_id', true)
    AND EXISTS (
      SELECT 1 FROM "Lead" l
      WHERE l.id = "Activity"."leadId"
        AND l."organizationId" = current_setting('app.user_org_id', true)
        AND (
          (current_setting('app.user_role', true) = 'ADMIN')
          OR (current_setting('app.user_role', true) = 'MANAGER'
              AND EXISTS (
                SELECT 1 FROM "Team" t
                WHERE t."id" = l."teamId"
                  AND t."managerId" = current_setting('app.user_id', true)
              ))
          OR (current_setting('app.user_role', true) IN ('TELECALLER', 'SALES_EXEC')
              AND (
                l."ownerId" = current_setting('app.user_id', true)
                OR l."coOwnerId" = current_setting('app.user_id', true)
              ))
        )
    )
  );

DROP POLICY IF EXISTS activity_insert_team ON "Activity";
CREATE POLICY activity_insert_team ON "Activity"
  FOR INSERT
  WITH CHECK (
    "Activity"."organizationId" = current_setting('app.user_org_id', true)
    AND EXISTS (
      SELECT 1 FROM "Lead" l
      WHERE l.id = "Activity"."leadId"
        AND l."organizationId" = current_setting('app.user_org_id', true)
        AND (
          (current_setting('app.user_role', true) = 'ADMIN'
           AND l."teamId" = current_setting('app.user_team_id', true))
          OR (current_setting('app.user_role', true) = 'MANAGER'
              AND EXISTS (
                SELECT 1 FROM "Team" t
                WHERE t."id" = l."teamId"
                  AND t."managerId" = current_setting('app.user_id', true)
              ))
          OR (current_setting('app.user_role', true) IN ('TELECALLER', 'SALES_EXEC')
              AND (
                l."ownerId" = current_setting('app.user_id', true)
                OR l."coOwnerId" = current_setting('app.user_id', true)
              ))
        )
    )
  );

-- ── SiteVisit ───────────────────────────────────────────────────────────
DROP POLICY IF EXISTS site_visit_select_team ON "SiteVisit";
CREATE POLICY site_visit_select_team ON "SiteVisit"
  FOR SELECT
  USING (
    "SiteVisit"."organizationId" = current_setting('app.user_org_id', true)
    AND EXISTS (
      SELECT 1 FROM "Lead" l
      WHERE l.id = "SiteVisit"."leadId"
        AND l."organizationId" = current_setting('app.user_org_id', true)
        AND (
          (current_setting('app.user_role', true) = 'ADMIN')
          OR (current_setting('app.user_role', true) = 'MANAGER'
              AND EXISTS (
                SELECT 1 FROM "Team" t
                WHERE t."id" = l."teamId"
                  AND t."managerId" = current_setting('app.user_id', true)
              ))
          OR (current_setting('app.user_role', true) IN ('TELECALLER', 'SALES_EXEC')
              AND (
                l."ownerId" = current_setting('app.user_id', true)
                OR l."coOwnerId" = current_setting('app.user_id', true)
              ))
        )
    )
  );

DROP POLICY IF EXISTS site_visit_write_team ON "SiteVisit";
CREATE POLICY site_visit_write_team ON "SiteVisit"
  FOR ALL
  USING (
    "SiteVisit"."organizationId" = current_setting('app.user_org_id', true)
    AND EXISTS (
      SELECT 1 FROM "Lead" l
      WHERE l.id = "SiteVisit"."leadId"
        AND l."organizationId" = current_setting('app.user_org_id', true)
        AND (
          (current_setting('app.user_role', true) = 'ADMIN'
           AND l."teamId" = current_setting('app.user_team_id', true))
          OR (current_setting('app.user_role', true) = 'MANAGER'
              AND EXISTS (
                SELECT 1 FROM "Team" t
                WHERE t."id" = l."teamId"
                  AND t."managerId" = current_setting('app.user_id', true)
              ))
          OR (current_setting('app.user_role', true) IN ('TELECALLER', 'SALES_EXEC')
              AND (
                l."ownerId" = current_setting('app.user_id', true)
                OR l."coOwnerId" = current_setting('app.user_id', true)
              ))
        )
    )
  )
  WITH CHECK (
    "SiteVisit"."organizationId" = current_setting('app.user_org_id', true)
    AND EXISTS (
      SELECT 1 FROM "Lead" l
      WHERE l.id = "SiteVisit"."leadId"
        AND l."organizationId" = current_setting('app.user_org_id', true)
        AND (
          (current_setting('app.user_role', true) = 'ADMIN'
           AND l."teamId" = current_setting('app.user_team_id', true))
          OR (current_setting('app.user_role', true) = 'MANAGER'
              AND EXISTS (
                SELECT 1 FROM "Team" t
                WHERE t."id" = l."teamId"
                  AND t."managerId" = current_setting('app.user_id', true)
              ))
          OR (current_setting('app.user_role', true) IN ('TELECALLER', 'SALES_EXEC')
              AND (
                l."ownerId" = current_setting('app.user_id', true)
                OR l."coOwnerId" = current_setting('app.user_id', true)
              ))
        )
    )
  );

-- ── Message ─────────────────────────────────────────────────────────────
DROP POLICY IF EXISTS message_select_team ON "Message";
CREATE POLICY message_select_team ON "Message"
  FOR SELECT
  USING (
    "Message"."organizationId" = current_setting('app.user_org_id', true)
    AND EXISTS (
      SELECT 1 FROM "Lead" l
      WHERE l.id = "Message"."leadId"
        AND l."organizationId" = current_setting('app.user_org_id', true)
        AND (
          (current_setting('app.user_role', true) = 'ADMIN')
          OR (current_setting('app.user_role', true) = 'MANAGER'
              AND EXISTS (
                SELECT 1 FROM "Team" t
                WHERE t."id" = l."teamId"
                  AND t."managerId" = current_setting('app.user_id', true)
              ))
          OR (current_setting('app.user_role', true) IN ('TELECALLER', 'SALES_EXEC')
              AND (
                l."ownerId" = current_setting('app.user_id', true)
                OR l."coOwnerId" = current_setting('app.user_id', true)
              ))
        )
    )
  );

DROP POLICY IF EXISTS message_insert_team ON "Message";
CREATE POLICY message_insert_team ON "Message"
  FOR INSERT
  WITH CHECK (
    "Message"."organizationId" = current_setting('app.user_org_id', true)
    AND EXISTS (
      SELECT 1 FROM "Lead" l
      WHERE l.id = "Message"."leadId"
        AND l."organizationId" = current_setting('app.user_org_id', true)
        AND (
          (current_setting('app.user_role', true) = 'ADMIN'
           AND l."teamId" = current_setting('app.user_team_id', true))
          OR (current_setting('app.user_role', true) = 'MANAGER'
              AND EXISTS (
                SELECT 1 FROM "Team" t
                WHERE t."id" = l."teamId"
                  AND t."managerId" = current_setting('app.user_id', true)
              ))
          OR (current_setting('app.user_role', true) IN ('TELECALLER', 'SALES_EXEC')
              AND (
                l."ownerId" = current_setting('app.user_id', true)
                OR l."coOwnerId" = current_setting('app.user_id', true)
              ))
        )
    )
  );

-- ── Booking ─────────────────────────────────────────────────────────────
DROP POLICY IF EXISTS booking_select_team ON "Booking";
CREATE POLICY booking_select_team ON "Booking"
  FOR SELECT
  USING (
    "Booking"."organizationId" = current_setting('app.user_org_id', true)
    AND EXISTS (
      SELECT 1 FROM "Lead" l
      WHERE l.id = "Booking"."leadId"
        AND l."organizationId" = current_setting('app.user_org_id', true)
        AND (
          (current_setting('app.user_role', true) = 'ADMIN')
          OR (current_setting('app.user_role', true) = 'MANAGER'
              AND EXISTS (
                SELECT 1 FROM "Team" t
                WHERE t."id" = l."teamId"
                  AND t."managerId" = current_setting('app.user_id', true)
              ))
          OR (current_setting('app.user_role', true) IN ('TELECALLER', 'SALES_EXEC')
              AND (
                l."ownerId" = current_setting('app.user_id', true)
                OR l."coOwnerId" = current_setting('app.user_id', true)
              ))
        )
    )
  );

DROP POLICY IF EXISTS booking_write_team ON "Booking";
CREATE POLICY booking_write_team ON "Booking"
  FOR ALL
  USING (
    "Booking"."organizationId" = current_setting('app.user_org_id', true)
    AND EXISTS (
      SELECT 1 FROM "Lead" l
      WHERE l.id = "Booking"."leadId"
        AND l."organizationId" = current_setting('app.user_org_id', true)
        AND (
          (current_setting('app.user_role', true) = 'ADMIN'
           AND l."teamId" = current_setting('app.user_team_id', true))
          OR (current_setting('app.user_role', true) = 'MANAGER'
              AND EXISTS (
                SELECT 1 FROM "Team" t
                WHERE t."id" = l."teamId"
                  AND t."managerId" = current_setting('app.user_id', true)
              ))
          OR (current_setting('app.user_role', true) IN ('TELECALLER', 'SALES_EXEC')
              AND (
                l."ownerId" = current_setting('app.user_id', true)
                OR l."coOwnerId" = current_setting('app.user_id', true)
              ))
        )
    )
  )
  WITH CHECK (
    "Booking"."organizationId" = current_setting('app.user_org_id', true)
    AND EXISTS (
      SELECT 1 FROM "Lead" l
      WHERE l.id = "Booking"."leadId"
        AND l."organizationId" = current_setting('app.user_org_id', true)
        AND (
          (current_setting('app.user_role', true) = 'ADMIN'
           AND l."teamId" = current_setting('app.user_team_id', true))
          OR (current_setting('app.user_role', true) = 'MANAGER'
              AND EXISTS (
                SELECT 1 FROM "Team" t
                WHERE t."id" = l."teamId"
                  AND t."managerId" = current_setting('app.user_id', true)
              ))
          OR (current_setting('app.user_role', true) IN ('TELECALLER', 'SALES_EXEC')
              AND (
                l."ownerId" = current_setting('app.user_id', true)
                OR l."coOwnerId" = current_setting('app.user_id', true)
              ))
        )
    )
  );

-- ── Consent ─────────────────────────────────────────────────────────────
DROP POLICY IF EXISTS consent_select_admin_or_owner ON "Consent";
CREATE POLICY consent_select_admin_or_owner ON "Consent"
  FOR SELECT
  USING (
    "Consent"."organizationId" = current_setting('app.user_org_id', true)
    AND (
      current_setting('app.user_role', true) = 'ADMIN'
      OR EXISTS (
        SELECT 1 FROM "Lead" l
        WHERE l.id = "Consent"."leadId"
          AND l."organizationId" = current_setting('app.user_org_id', true)
          AND (
            (current_setting('app.user_role', true) = 'MANAGER'
             AND EXISTS (
               SELECT 1 FROM "Team" t
               WHERE t."id" = l."teamId"
                 AND t."managerId" = current_setting('app.user_id', true)
             ))
            OR (current_setting('app.user_role', true) IN ('TELECALLER', 'SALES_EXEC')
                AND (
                  l."ownerId" = current_setting('app.user_id', true)
                  OR l."coOwnerId" = current_setting('app.user_id', true)
                ))
          )
      )
    )
  );

DROP POLICY IF EXISTS consent_insert_owner ON "Consent";
CREATE POLICY consent_insert_owner ON "Consent"
  FOR INSERT
  WITH CHECK (
    "Consent"."organizationId" = current_setting('app.user_org_id', true)
    AND EXISTS (
      SELECT 1 FROM "Lead" l
      WHERE l.id = "Consent"."leadId"
        AND l."organizationId" = current_setting('app.user_org_id', true)
        AND (
          (current_setting('app.user_role', true) = 'ADMIN'
           AND l."teamId" = current_setting('app.user_team_id', true))
          OR (current_setting('app.user_role', true) = 'MANAGER'
              AND EXISTS (
                SELECT 1 FROM "Team" t
                WHERE t."id" = l."teamId"
                  AND t."managerId" = current_setting('app.user_id', true)
              ))
          OR (current_setting('app.user_role', true) IN ('TELECALLER', 'SALES_EXEC')
              AND (
                l."ownerId" = current_setting('app.user_id', true)
                OR l."coOwnerId" = current_setting('app.user_id', true)
              ))
        )
    )
  );

-- ── ManagerAssignmentRule ───────────────────────────────────────────────
DROP POLICY IF EXISTS managerassignmentrule_select_team ON "ManagerAssignmentRule";
CREATE POLICY managerassignmentrule_select_team ON "ManagerAssignmentRule"
  FOR SELECT
  USING (
    "organizationId" = current_setting('app.user_org_id', true)
    AND (
      (
        current_setting('app.user_role', true) = 'MANAGER'
        AND EXISTS (
          SELECT 1 FROM "Team" t
          WHERE t."id" = "ManagerAssignmentRule"."teamId"
            AND t."managerId" = current_setting('app.user_id', true)
        )
      )
      OR current_setting('app.user_role', true) IN ('ADMIN', 'OWNER')
    )
  );
