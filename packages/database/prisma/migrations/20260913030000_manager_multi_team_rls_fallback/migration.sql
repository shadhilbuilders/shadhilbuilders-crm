-- T-TEAM-AUTHORITATIVE (2026-09-13, Decision Audit Trail #39)
-- Corrects migration 20260913020000_manager_multi_team_rls: adds a
-- backward-compatible OR fallback to the app.user_team_id GUC
-- equality alongside the new Team.managerId EXISTS check, for
-- accounts/fixtures where Team.managerId was never synced to match
-- User.teamId (mirrors the same fallback added in leads.service.ts /
-- users.service.ts in this same cutover). Extracted verbatim from the
-- canonical prisma/rls/policies.sql so the two never drift.

DROP POLICY IF EXISTS lead_select_manager ON "Lead";
CREATE POLICY lead_select_manager ON "Lead"
  FOR SELECT
  USING (
    current_setting('app.user_role', true) = 'MANAGER'
    AND "organizationId" = current_setting('app.user_org_id', true)
    AND (
      "Lead"."teamId" = current_setting('app.user_team_id', true)
      OR EXISTS (
                  SELECT 1 FROM "Team" t
                  WHERE t."id" = "Lead"."teamId"
                    AND t."managerId" = current_setting('app.user_id', true)
                )
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

DROP POLICY IF EXISTS lead_insert_manager ON "Lead";
CREATE POLICY lead_insert_manager ON "Lead"
  FOR INSERT
  WITH CHECK (
    current_setting('app.user_role', true) = 'MANAGER'
    AND "organizationId" = current_setting('app.user_org_id', true)
    AND (
      "Lead"."teamId" = current_setting('app.user_team_id', true)
      OR EXISTS (
                  SELECT 1 FROM "Team" t
                  WHERE t."id" = "Lead"."teamId"
                    AND t."managerId" = current_setting('app.user_id', true)
                )
    )
  );

DROP POLICY IF EXISTS lead_update_manager ON "Lead";
CREATE POLICY lead_update_manager ON "Lead"
  FOR UPDATE
  USING (
    current_setting('app.user_role', true) = 'MANAGER'
    AND "organizationId" = current_setting('app.user_org_id', true)
    AND (
      "Lead"."teamId" = current_setting('app.user_team_id', true)
      OR EXISTS (
                  SELECT 1 FROM "Team" t
                  WHERE t."id" = "Lead"."teamId"
                    AND t."managerId" = current_setting('app.user_id', true)
                )
    )
  )
  WITH CHECK (
    current_setting('app.user_role', true) = 'MANAGER'
    AND "organizationId" = current_setting('app.user_org_id', true)
    AND (
      "Lead"."teamId" = current_setting('app.user_team_id', true)
      OR EXISTS (
                  SELECT 1 FROM "Team" t
                  WHERE t."id" = "Lead"."teamId"
                    AND t."managerId" = current_setting('app.user_id', true)
                )
    )
  );

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
              AND (
                l."teamId" = current_setting('app.user_team_id', true)
                OR EXISTS (
                  SELECT 1 FROM "Team" t
                  WHERE t."id" = l."teamId"
                    AND t."managerId" = current_setting('app.user_id', true)
                )
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
              AND (
                l."teamId" = current_setting('app.user_team_id', true)
                OR EXISTS (
                  SELECT 1 FROM "Team" t
                  WHERE t."id" = l."teamId"
                    AND t."managerId" = current_setting('app.user_id', true)
                )
              ))
          OR (current_setting('app.user_role', true) IN ('TELECALLER', 'SALES_EXEC')
              AND (
                l."ownerId" = current_setting('app.user_id', true)
                OR l."coOwnerId" = current_setting('app.user_id', true)
              ))
        )
    )
  );

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
              AND (
                l."teamId" = current_setting('app.user_team_id', true)
                OR EXISTS (
                  SELECT 1 FROM "Team" t
                  WHERE t."id" = l."teamId"
                    AND t."managerId" = current_setting('app.user_id', true)
                )
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
              AND (
                l."teamId" = current_setting('app.user_team_id', true)
                OR EXISTS (
                  SELECT 1 FROM "Team" t
                  WHERE t."id" = l."teamId"
                    AND t."managerId" = current_setting('app.user_id', true)
                )
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
              AND (
                l."teamId" = current_setting('app.user_team_id', true)
                OR EXISTS (
                  SELECT 1 FROM "Team" t
                  WHERE t."id" = l."teamId"
                    AND t."managerId" = current_setting('app.user_id', true)
                )
              ))
          OR (current_setting('app.user_role', true) IN ('TELECALLER', 'SALES_EXEC')
              AND (
                l."ownerId" = current_setting('app.user_id', true)
                OR l."coOwnerId" = current_setting('app.user_id', true)
              ))
        )
    )
  );

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
              AND (
                l."teamId" = current_setting('app.user_team_id', true)
                OR EXISTS (
                  SELECT 1 FROM "Team" t
                  WHERE t."id" = l."teamId"
                    AND t."managerId" = current_setting('app.user_id', true)
                )
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
              AND (
                l."teamId" = current_setting('app.user_team_id', true)
                OR EXISTS (
                  SELECT 1 FROM "Team" t
                  WHERE t."id" = l."teamId"
                    AND t."managerId" = current_setting('app.user_id', true)
                )
              ))
          OR (current_setting('app.user_role', true) IN ('TELECALLER', 'SALES_EXEC')
              AND (
                l."ownerId" = current_setting('app.user_id', true)
                OR l."coOwnerId" = current_setting('app.user_id', true)
              ))
        )
    )
  );

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
              AND (
                l."teamId" = current_setting('app.user_team_id', true)
                OR EXISTS (
                  SELECT 1 FROM "Team" t
                  WHERE t."id" = l."teamId"
                    AND t."managerId" = current_setting('app.user_id', true)
                )
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
              AND (
                l."teamId" = current_setting('app.user_team_id', true)
                OR EXISTS (
                  SELECT 1 FROM "Team" t
                  WHERE t."id" = l."teamId"
                    AND t."managerId" = current_setting('app.user_id', true)
                )
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
              AND (
                l."teamId" = current_setting('app.user_team_id', true)
                OR EXISTS (
                  SELECT 1 FROM "Team" t
                  WHERE t."id" = l."teamId"
                    AND t."managerId" = current_setting('app.user_id', true)
                )
              ))
          OR (current_setting('app.user_role', true) IN ('TELECALLER', 'SALES_EXEC')
              AND (
                l."ownerId" = current_setting('app.user_id', true)
                OR l."coOwnerId" = current_setting('app.user_id', true)
              ))
        )
    )
  );

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
            -- T-TEAM-AUTHORITATIVE (2026-09-13): EXISTS-based
            -- Team.managerId check (supports a manager leading multiple
            -- teams) instead of the app.user_team_id GUC equality.
            (current_setting('app.user_role', true) = 'MANAGER'
             AND (
                l."teamId" = current_setting('app.user_team_id', true)
                OR EXISTS (
                  SELECT 1 FROM "Team" t
                  WHERE t."id" = l."teamId"
                    AND t."managerId" = current_setting('app.user_id', true)
                )
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
              AND (
                l."teamId" = current_setting('app.user_team_id', true)
                OR EXISTS (
                  SELECT 1 FROM "Team" t
                  WHERE t."id" = l."teamId"
                    AND t."managerId" = current_setting('app.user_id', true)
                )
              ))
          OR (current_setting('app.user_role', true) IN ('TELECALLER', 'SALES_EXEC')
              AND (
                l."ownerId" = current_setting('app.user_id', true)
                OR l."coOwnerId" = current_setting('app.user_id', true)
              ))
        )
    )
  );

DROP POLICY IF EXISTS managerassignmentrule_select_team ON "ManagerAssignmentRule";
CREATE POLICY managerassignmentrule_select_team ON "ManagerAssignmentRule"
  FOR SELECT
  USING (
    "organizationId" = current_setting('app.user_org_id', true)
    AND (
      (
        current_setting('app.user_role', true) = 'MANAGER'
        AND (
                "ManagerAssignmentRule"."teamId" = current_setting('app.user_team_id', true)
                OR EXISTS (
                  SELECT 1 FROM "Team" t
                  WHERE t."id" = "ManagerAssignmentRule"."teamId"
                    AND t."managerId" = current_setting('app.user_id', true)
                )
              )
      )
      OR current_setting('app.user_role', true) IN ('ADMIN', 'OWNER')
    )
  );

