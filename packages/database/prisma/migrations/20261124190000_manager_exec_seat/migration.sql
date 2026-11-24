-- T-MANAGER-SEAT: a MANAGER named on a visit gets the exec's per-lead seat.
--
-- Why: a manager's read arm is structural (Team.managerId). Name a manager as the
-- person conducting a visit on a lead from a team they do not manage, and the lead
-- lookup came back empty, so recording the outcome was impossible - even though
-- `visits.service.ts` accepts a MANAGER as the assignee and `canRoleTransition`
-- lets a manager drive VISIT_SCHEDULED -> VISITED.
--
-- What: every arm that matches "you are on this lead" - ownerId, coOwnerId, or the
-- visit's assignee - now accepts MANAGER alongside TELECALLER and SALES_EXEC. The
-- structural manager arm is untouched, so this adds a per-lead seat; it does not
-- widen a manager's team scope by one row.
--
-- Not changed on purpose: lead_insert_telecaller (who may create a lead) and
-- lead_select_mentioned (who may read a lead they were mentioned on). Neither is
-- about conducting a visit.
--
-- Canonical source: packages/database/prisma/rls/policies.sql (same text).

DROP POLICY IF EXISTS "lead_select_telecaller" ON "Lead";
CREATE POLICY lead_select_telecaller ON "Lead"
  FOR SELECT
  USING (
    current_setting('app.user_role', true) IN ('TELECALLER', 'SALES_EXEC', 'MANAGER')
    AND (
      "ownerId" = current_setting('app.user_id', true)
      OR "coOwnerId" = current_setting('app.user_id', true)
    )
    AND "organizationId" = current_setting('app.user_org_id', true)
  );

DROP POLICY IF EXISTS "lead_update_telecaller" ON "Lead";
CREATE POLICY lead_update_telecaller ON "Lead"
  FOR UPDATE
  USING (
    current_setting('app.user_role', true) IN ('TELECALLER', 'SALES_EXEC', 'MANAGER')
    AND (
      "ownerId" = current_setting('app.user_id', true)
      OR "coOwnerId" = current_setting('app.user_id', true)
    )
    AND "organizationId" = current_setting('app.user_org_id', true)
  )
  WITH CHECK (
    current_setting('app.user_role', true) IN ('TELECALLER', 'SALES_EXEC', 'MANAGER')
    AND (
      "ownerId" = current_setting('app.user_id', true)
      OR "coOwnerId" = current_setting('app.user_id', true)
    )
    AND "organizationId" = current_setting('app.user_org_id', true)
  );

DROP POLICY IF EXISTS "activity_select_team" ON "Activity";
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
          OR (current_setting('app.user_role', true) IN ('TELECALLER', 'SALES_EXEC', 'MANAGER')
              AND (
                l."ownerId" = current_setting('app.user_id', true)
                OR l."coOwnerId" = current_setting('app.user_id', true)
              ))
        )
    )
  );

DROP POLICY IF EXISTS "activity_insert_team" ON "Activity";
CREATE POLICY activity_insert_team ON "Activity"
  FOR INSERT
  WITH CHECK (
    "Activity"."organizationId" = current_setting('app.user_org_id', true)
    AND EXISTS (
      SELECT 1 FROM "Lead" l
      WHERE l.id = "Activity"."leadId"
        AND l."organizationId" = current_setting('app.user_org_id', true)
        AND (
          (current_setting('app.user_role', true) = 'MANAGER'
              AND EXISTS (
                SELECT 1 FROM "Team" t
                WHERE t."id" = l."teamId"
                  AND t."managerId" = current_setting('app.user_id', true)
              ))
          OR (current_setting('app.user_role', true) IN ('TELECALLER', 'SALES_EXEC', 'MANAGER')
              AND (
                l."ownerId" = current_setting('app.user_id', true)
                OR l."coOwnerId" = current_setting('app.user_id', true)
              ))
        )
    )
  );

DROP POLICY IF EXISTS "site_visit_select_team" ON "SiteVisit";
CREATE POLICY site_visit_select_team ON "SiteVisit"
  FOR SELECT
  USING (
    "SiteVisit"."organizationId" = current_setting('app.user_org_id', true)
    AND (
      (current_setting('app.user_role', true) = 'ADMIN')
      OR (current_setting('app.user_role', true) = 'MANAGER'
          AND EXISTS (
            SELECT 1 FROM "Lead" l
            WHERE l.id = "SiteVisit"."leadId"
              AND l."organizationId" = current_setting('app.user_org_id', true)
              AND EXISTS (
                SELECT 1 FROM "Team" t
                WHERE t."id" = l."teamId"
                  AND t."managerId" = current_setting('app.user_id', true)
              )
          ))
      OR (current_setting('app.user_role', true) IN ('TELECALLER', 'SALES_EXEC', 'MANAGER')
          AND (
            "SiteVisit"."userId" = current_setting('app.user_id', true)
            OR EXISTS (
              SELECT 1 FROM "Lead" l
              WHERE l.id = "SiteVisit"."leadId"
                AND l."organizationId" = current_setting('app.user_org_id', true)
                AND (
                  l."ownerId" = current_setting('app.user_id', true)
                  OR l."coOwnerId" = current_setting('app.user_id', true)
                )
            )
          ))
    )
  );

DROP POLICY IF EXISTS "site_visit_write_team" ON "SiteVisit";
CREATE POLICY site_visit_write_team ON "SiteVisit"
  FOR ALL
  USING (
    "SiteVisit"."organizationId" = current_setting('app.user_org_id', true)
    AND EXISTS (
      SELECT 1 FROM "Lead" l
      WHERE l.id = "SiteVisit"."leadId"
        AND l."organizationId" = current_setting('app.user_org_id', true)
        AND (
          (current_setting('app.user_role', true) = 'MANAGER'
              AND EXISTS (
                SELECT 1 FROM "Team" t
                WHERE t."id" = l."teamId"
                  AND t."managerId" = current_setting('app.user_id', true)
              ))
          OR (current_setting('app.user_role', true) IN ('TELECALLER', 'SALES_EXEC', 'MANAGER')
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
          (current_setting('app.user_role', true) = 'MANAGER'
              AND EXISTS (
                SELECT 1 FROM "Team" t
                WHERE t."id" = l."teamId"
                  AND t."managerId" = current_setting('app.user_id', true)
              ))
          OR (current_setting('app.user_role', true) IN ('TELECALLER', 'SALES_EXEC', 'MANAGER')
              AND (
                l."ownerId" = current_setting('app.user_id', true)
                OR l."coOwnerId" = current_setting('app.user_id', true)
              ))
        )
    )
  );

DROP POLICY IF EXISTS "site_visit_update_assignee" ON "SiteVisit";
CREATE POLICY site_visit_update_assignee ON "SiteVisit"
  FOR UPDATE
  USING (
    "SiteVisit"."organizationId" = current_setting('app.user_org_id', true)
    AND current_setting('app.user_role', true) IN ('TELECALLER', 'SALES_EXEC', 'MANAGER')
    AND (
      "SiteVisit"."userId" = current_setting('app.user_id', true)
      OR EXISTS (
        SELECT 1 FROM "Lead" l
        WHERE l.id = "SiteVisit"."leadId"
          AND l."organizationId" = current_setting('app.user_org_id', true)
          AND (
            l."ownerId" = current_setting('app.user_id', true)
            OR l."coOwnerId" = current_setting('app.user_id', true)
          )
      )
    )
  )
  WITH CHECK (
    "SiteVisit"."organizationId" = current_setting('app.user_org_id', true)
    AND current_setting('app.user_role', true) IN ('TELECALLER', 'SALES_EXEC', 'MANAGER')
    AND (
      "SiteVisit"."userId" = current_setting('app.user_id', true)
      OR EXISTS (
        SELECT 1 FROM "Lead" l
        WHERE l.id = "SiteVisit"."leadId"
          AND l."organizationId" = current_setting('app.user_org_id', true)
          AND (
            l."ownerId" = current_setting('app.user_id', true)
            OR l."coOwnerId" = current_setting('app.user_id', true)
          )
      )
    )
  );

DROP POLICY IF EXISTS "message_select_team" ON "Message";
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
          OR (current_setting('app.user_role', true) IN ('TELECALLER', 'SALES_EXEC', 'MANAGER')
              AND (
                l."ownerId" = current_setting('app.user_id', true)
                OR l."coOwnerId" = current_setting('app.user_id', true)
              ))
        )
    )
  );

DROP POLICY IF EXISTS "message_insert_team" ON "Message";
CREATE POLICY message_insert_team ON "Message"
  FOR INSERT
  WITH CHECK (
    "Message"."organizationId" = current_setting('app.user_org_id', true)
    AND EXISTS (
      SELECT 1 FROM "Lead" l
      WHERE l.id = "Message"."leadId"
        AND l."organizationId" = current_setting('app.user_org_id', true)
        AND (
          (current_setting('app.user_role', true) = 'MANAGER'
              AND EXISTS (
                SELECT 1 FROM "Team" t
                WHERE t."id" = l."teamId"
                  AND t."managerId" = current_setting('app.user_id', true)
              ))
          OR (current_setting('app.user_role', true) IN ('TELECALLER', 'SALES_EXEC', 'MANAGER')
              AND (
                l."ownerId" = current_setting('app.user_id', true)
                OR l."coOwnerId" = current_setting('app.user_id', true)
              ))
        )
    )
  );

DROP POLICY IF EXISTS "booking_select_team" ON "Booking";
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
          OR (current_setting('app.user_role', true) IN ('TELECALLER', 'SALES_EXEC', 'MANAGER')
              AND (
                l."ownerId" = current_setting('app.user_id', true)
                OR l."coOwnerId" = current_setting('app.user_id', true)
              ))
        )
    )
  );

DROP POLICY IF EXISTS "booking_write_team" ON "Booking";
CREATE POLICY booking_write_team ON "Booking"
  FOR ALL
  USING (
    "Booking"."organizationId" = current_setting('app.user_org_id', true)
    AND EXISTS (
      SELECT 1 FROM "Lead" l
      WHERE l.id = "Booking"."leadId"
        AND l."organizationId" = current_setting('app.user_org_id', true)
        AND (
          (current_setting('app.user_role', true) = 'MANAGER'
              AND EXISTS (
                SELECT 1 FROM "Team" t
                WHERE t."id" = l."teamId"
                  AND t."managerId" = current_setting('app.user_id', true)
              ))
          OR (current_setting('app.user_role', true) IN ('TELECALLER', 'SALES_EXEC', 'MANAGER')
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
          (current_setting('app.user_role', true) = 'MANAGER'
              AND EXISTS (
                SELECT 1 FROM "Team" t
                WHERE t."id" = l."teamId"
                  AND t."managerId" = current_setting('app.user_id', true)
              ))
          OR (current_setting('app.user_role', true) IN ('TELECALLER', 'SALES_EXEC', 'MANAGER')
              AND (
                l."ownerId" = current_setting('app.user_id', true)
                OR l."coOwnerId" = current_setting('app.user_id', true)
              ))
        )
    )
  );

DROP POLICY IF EXISTS "consent_select_admin_or_owner" ON "Consent";
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
            -- T-TEAM-AUTHORITATIVE (2026-09-13 clean cutover): EXISTS-based
            -- Team.managerId check; the app.user_team_id GUC equality
            -- fallback has been removed.
            (current_setting('app.user_role', true) = 'MANAGER'
             AND EXISTS (
                SELECT 1 FROM "Team" t
                WHERE t."id" = l."teamId"
                  AND t."managerId" = current_setting('app.user_id', true)
              ))
            OR (current_setting('app.user_role', true) IN ('TELECALLER', 'SALES_EXEC', 'MANAGER')
                AND (
                  l."ownerId" = current_setting('app.user_id', true)
                  OR l."coOwnerId" = current_setting('app.user_id', true)
                ))
          )
      )
    )
  );

DROP POLICY IF EXISTS "consent_insert_owner" ON "Consent";
CREATE POLICY consent_insert_owner ON "Consent"
  FOR INSERT
  WITH CHECK (
    "Consent"."organizationId" = current_setting('app.user_org_id', true)
    AND EXISTS (
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
          OR (current_setting('app.user_role', true) IN ('TELECALLER', 'SALES_EXEC', 'MANAGER')
              AND (
                l."ownerId" = current_setting('app.user_id', true)
                OR l."coOwnerId" = current_setting('app.user_id', true)
              ))
        )
    )
  );

DROP POLICY IF EXISTS "lead_fact_select_team" ON "LeadFact";
CREATE POLICY lead_fact_select_team ON "LeadFact"
  FOR SELECT
  USING (
    "LeadFact"."organizationId" = current_setting('app.user_org_id', true)
    AND EXISTS (
      SELECT 1 FROM "Lead" l
      WHERE l.id = "LeadFact"."leadId"
        AND l."organizationId" = current_setting('app.user_org_id', true)
        AND (
          (current_setting('app.user_role', true) = 'ADMIN')
          OR (current_setting('app.user_role', true) = 'MANAGER'
              AND EXISTS (
                SELECT 1 FROM "Team" t
                WHERE t."id" = l."teamId"
                  AND t."managerId" = current_setting('app.user_id', true)
              ))
          OR (current_setting('app.user_role', true) IN ('TELECALLER', 'SALES_EXEC', 'MANAGER')
              AND (
                l."ownerId" = current_setting('app.user_id', true)
                OR l."coOwnerId" = current_setting('app.user_id', true)
              ))
        )
    )
  );

DROP POLICY IF EXISTS "lead_fact_insert_team" ON "LeadFact";
CREATE POLICY lead_fact_insert_team ON "LeadFact"
  FOR INSERT
  WITH CHECK (
    "LeadFact"."organizationId" = current_setting('app.user_org_id', true)
    AND EXISTS (
      SELECT 1 FROM "Lead" l
      WHERE l.id = "LeadFact"."leadId"
        AND l."organizationId" = current_setting('app.user_org_id', true)
        AND (
          (current_setting('app.user_role', true) = 'MANAGER'
              AND EXISTS (
                SELECT 1 FROM "Team" t
                WHERE t."id" = l."teamId"
                  AND t."managerId" = current_setting('app.user_id', true)
              ))
          OR (current_setting('app.user_role', true) IN ('TELECALLER', 'SALES_EXEC', 'MANAGER')
              AND (
                l."ownerId" = current_setting('app.user_id', true)
                OR l."coOwnerId" = current_setting('app.user_id', true)
              ))
        )
    )
  );

DROP POLICY IF EXISTS "lead_fact_update_team" ON "LeadFact";
CREATE POLICY lead_fact_update_team ON "LeadFact"
  FOR UPDATE
  USING (
    "LeadFact"."organizationId" = current_setting('app.user_org_id', true)
    AND EXISTS (
      SELECT 1 FROM "Lead" l
      WHERE l.id = "LeadFact"."leadId"
        AND l."organizationId" = current_setting('app.user_org_id', true)
        AND (
          (current_setting('app.user_role', true) = 'MANAGER'
              AND EXISTS (
                SELECT 1 FROM "Team" t
                WHERE t."id" = l."teamId"
                  AND t."managerId" = current_setting('app.user_id', true)
              ))
          OR (current_setting('app.user_role', true) IN ('TELECALLER', 'SALES_EXEC', 'MANAGER')
              AND (
                l."ownerId" = current_setting('app.user_id', true)
                OR l."coOwnerId" = current_setting('app.user_id', true)
              ))
        )
    )
  )
  WITH CHECK (
    "LeadFact"."organizationId" = current_setting('app.user_org_id', true)
  );
