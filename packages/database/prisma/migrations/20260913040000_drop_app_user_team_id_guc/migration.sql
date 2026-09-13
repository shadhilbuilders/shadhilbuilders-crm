-- T-TEAM-AUTHORITATIVE (2026-09-13) clean cutover, Decision Audit Trail #40.
--
-- Removes every RLS policy's dependency on the app.user_team_id session
-- GUC (the actor's single legacy team). Team scoping now resolves purely
-- via TeamMember (ordinary staff) and Team.managerId (managers), both of
-- which support multi-team membership - the GUC never could.
--
-- Also fixes several latent bugs uncovered while removing the GUC: a few
-- ADMIN branches embedded in combined policies checked
-- `l."teamId" = app.user_team_id`, which is ALWAYS FALSE for the seed
-- ADMIN/OWNER (teamId is null -> GUC is '', which never equals a real
-- teamId). For Activity and Consent there was no separate admin-bypass
-- policy at all, meaning ADMIN could never INSERT an Activity or Consent
-- row. For SiteVisit there was only an INSERT-only bypass, meaning ADMIN
-- could never UPDATE/DELETE a SiteVisit. This migration adds the missing
-- bypass policies (activity_insert_admin, consent_insert_admin,
-- site_visit_write_admin replacing the narrower site_visit_insert_admin),
-- mirroring the FOR ALL admin bypass pattern already used for Booking.

-- ── Lead ─────────────────────────────────────────────────────────────────
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
    AND EXISTS (
      SELECT 1 FROM "TeamMember" tm
      WHERE tm."teamId" = "teamId"
        AND tm."userId" = current_setting('app.user_id', true)
    )
    AND "organizationId" = current_setting('app.user_org_id', true)
  );

DROP POLICY IF EXISTS lead_insert_manager ON "Lead";
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

-- ── Activity ─────────────────────────────────────────────────────────────
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
  );

-- NEW: ADMIN could never INSERT an Activity row before this cutover (the
-- embedded branch above was always-false for a teamId-null admin, and no
-- separate bypass existed). Mirrors lead_insert_admin/message_insert_admin.
CREATE POLICY activity_insert_admin ON "Activity"
  FOR INSERT
  WITH CHECK (
    current_setting('app.user_role', true) = 'ADMIN'
    AND "organizationId" = current_setting('app.user_org_id', true)
  );

-- ── SiteVisit ────────────────────────────────────────────────────────────
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
          OR (current_setting('app.user_role', true) IN ('TELECALLER', 'SALES_EXEC')
              AND (
                l."ownerId" = current_setting('app.user_id', true)
                OR l."coOwnerId" = current_setting('app.user_id', true)
              ))
        )
    )
  );

-- NEW: replaces the INSERT-only site_visit_insert_admin with a FOR ALL
-- bypass (mirrors booking_write_admin) - ADMIN could previously INSERT a
-- SiteVisit but never UPDATE/DELETE one (the embedded branch in
-- site_visit_write_team was always-false).
DROP POLICY IF EXISTS site_visit_insert_admin ON "SiteVisit";
CREATE POLICY site_visit_write_admin ON "SiteVisit"
  FOR ALL
  USING (
    current_setting('app.user_role', true) = 'ADMIN'
    AND "organizationId" = current_setting('app.user_org_id', true)
  )
  WITH CHECK (
    current_setting('app.user_role', true) = 'ADMIN'
    AND "organizationId" = current_setting('app.user_org_id', true)
  );

-- ── Message ──────────────────────────────────────────────────────────────
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
  );

-- ── Booking ──────────────────────────────────────────────────────────────
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
          OR (current_setting('app.user_role', true) IN ('TELECALLER', 'SALES_EXEC')
              AND (
                l."ownerId" = current_setting('app.user_id', true)
                OR l."coOwnerId" = current_setting('app.user_id', true)
              ))
        )
    )
  );

-- ── Consent ──────────────────────────────────────────────────────────────
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
  );

-- NEW: ADMIN could never INSERT a Consent row before this cutover.
CREATE POLICY consent_insert_admin ON "Consent"
  FOR INSERT
  WITH CHECK (
    current_setting('app.user_role', true) = 'ADMIN'
    AND "organizationId" = current_setting('app.user_org_id', true)
  );

-- ── ManagerAssignmentRule ────────────────────────────────────────────────
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
