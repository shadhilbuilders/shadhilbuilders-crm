-- Lead co-owner RLS (2026-09-11): let a co-owner VIEW and WORK the lead.
--
-- Feature: "add co-owner to a lead" (PATCH /api/leads/:id/co-owner). A
-- co-owner is a second staff member (TELECALLER/SALES_EXEC) who can see the
-- lead, edit it, transition it, and work its child records - WITHOUT being
-- the owner. The owner keeps a lead exclusively assigned to them; the
-- co-owner collaborates alongside (full view + work, option B).
--
-- WHY this policy: previously the TELECALLER/SALES_EXEC SELECT + UPDATE
-- policies scoped strictly to `Lead.ownerId = current user`, so a co-owner
-- who wasn't the owner could never see (let alone work) the lead - making
-- co-ownership read-only-dead. We widen the staff branch of each
-- via-lead policy to also match `Lead.coOwnerId = current user`.
--
-- Scope of the widening (mirrors option B = full view + work):
--   Lead           SELECT + UPDATE (read + edit/transition)
--   Activity       SELECT + INSERT (timeline read + entries)
--   SiteVisit      SELECT + FOR ALL (write)
--   Message        SELECT + INSERT (thread read + send)
--   Booking        SELECT + FOR ALL (write)
--
-- ADMIN/OWNER/MANAGER behavior is unchanged. OWNER travels as ADMIN at the
-- RLS layer (downcast in packages/database/src/rls.ts), so no OWNER branch.
-- MANAGER keeps team-scoping.
--
-- Table-level GRANTs to shadhil_app already exist (policies.sql DO-block
-- loop); restating the GRANT here is harmless (idempotent) and keeps this
-- migration self-contained.

-- ── Lead ────────────────────────────────────────────────────────────────────
DROP POLICY IF EXISTS lead_select_telecaller ON "Lead";
CREATE POLICY lead_select_telecaller ON "Lead"
  FOR SELECT
  USING (
    current_setting('app.user_role', true) IN ('TELECALLER', 'SALES_EXEC')
    AND (
      "ownerId" = current_setting('app.user_id', true)
      OR "coOwnerId" = current_setting('app.user_id', true)
    )
  );

DROP POLICY IF EXISTS lead_update_telecaller ON "Lead";
CREATE POLICY lead_update_telecaller ON "Lead"
  FOR UPDATE
  USING (
    current_setting('app.user_role', true) IN ('TELECALLER', 'SALES_EXEC')
    AND (
      "ownerId" = current_setting('app.user_id', true)
      OR "coOwnerId" = current_setting('app.user_id', true)
    )
  )
  WITH CHECK (
    current_setting('app.user_role', true) IN ('TELECALLER', 'SALES_EXEC')
    AND (
      "ownerId" = current_setting('app.user_id', true)
      OR "coOwnerId" = current_setting('app.user_id', true)
    )
  );

-- ── Activity (timeline) ─────────────────────────────────────────────────────
DROP POLICY IF EXISTS activity_select_team ON "Activity";
CREATE POLICY activity_select_team ON "Activity"
  FOR SELECT
  USING (
    EXISTS (
      SELECT 1 FROM "Lead" l
      WHERE l.id = "Activity"."leadId"
        AND (
          (current_setting('app.user_role', true) = 'ADMIN')
          OR (current_setting('app.user_role', true) = 'MANAGER'
              AND l."teamId" = current_setting('app.user_team_id', true))
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
    EXISTS (
      SELECT 1 FROM "Lead" l
      WHERE l.id = "Activity"."leadId"
        AND (
          (current_setting('app.user_role', true) IN ('ADMIN', 'MANAGER')
           AND l."teamId" = current_setting('app.user_team_id', true))
          OR (current_setting('app.user_role', true) IN ('TELECALLER', 'SALES_EXEC')
              AND (
                l."ownerId" = current_setting('app.user_id', true)
                OR l."coOwnerId" = current_setting('app.user_id', true)
              ))
        )
    )
  );

-- ── SiteVisit ───────────────────────────────────────────────────────────────
DROP POLICY IF EXISTS site_visit_select_team ON "SiteVisit";
CREATE POLICY site_visit_select_team ON "SiteVisit"
  FOR SELECT
  USING (
    EXISTS (
      SELECT 1 FROM "Lead" l
      WHERE l.id = "SiteVisit"."leadId"
        AND (
          (current_setting('app.user_role', true) = 'ADMIN')
          OR (current_setting('app.user_role', true) = 'MANAGER'
              AND l."teamId" = current_setting('app.user_team_id', true))
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
    EXISTS (
      SELECT 1 FROM "Lead" l
      WHERE l.id = "SiteVisit"."leadId"
        AND (
          (current_setting('app.user_role', true) IN ('ADMIN', 'MANAGER')
           AND l."teamId" = current_setting('app.user_team_id', true))
          OR (current_setting('app.user_role', true) IN ('TELECALLER', 'SALES_EXEC')
              AND (
                l."ownerId" = current_setting('app.user_id', true)
                OR l."coOwnerId" = current_setting('app.user_id', true)
              ))
        )
    )
  )
  WITH CHECK (
    EXISTS (
      SELECT 1 FROM "Lead" l
      WHERE l.id = "SiteVisit"."leadId"
        AND (
          (current_setting('app.user_role', true) IN ('ADMIN', 'MANAGER')
           AND l."teamId" = current_setting('app.user_team_id', true))
          OR (current_setting('app.user_role', true) IN ('TELECALLER', 'SALES_EXEC')
              AND (
                l."ownerId" = current_setting('app.user_id', true)
                OR l."coOwnerId" = current_setting('app.user_id', true)
              ))
        )
    )
  );

-- ── Message ─────────────────────────────────────────────────────────────────
DROP POLICY IF EXISTS message_select_team ON "Message";
CREATE POLICY message_select_team ON "Message"
  FOR SELECT
  USING (
    EXISTS (
      SELECT 1 FROM "Lead" l
      WHERE l.id = "Message"."leadId"
        AND (
          (current_setting('app.user_role', true) = 'ADMIN')
          OR (current_setting('app.user_role', true) = 'MANAGER'
              AND l."teamId" = current_setting('app.user_team_id', true))
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
    EXISTS (
      SELECT 1 FROM "Lead" l
      WHERE l.id = "Message"."leadId"
        AND (
          (current_setting('app.user_role', true) IN ('ADMIN', 'MANAGER')
           AND l."teamId" = current_setting('app.user_team_id', true))
          OR (current_setting('app.user_role', true) IN ('TELECALLER', 'SALES_EXEC')
              AND (
                l."ownerId" = current_setting('app.user_id', true)
                OR l."coOwnerId" = current_setting('app.user_id', true)
              ))
        )
    )
  );

-- ── Booking ─────────────────────────────────────────────────────────────────
DROP POLICY IF EXISTS booking_select_team ON "Booking";
CREATE POLICY booking_select_team ON "Booking"
  FOR SELECT
  USING (
    EXISTS (
      SELECT 1 FROM "Lead" l
      WHERE l.id = "Booking"."leadId"
        AND (
          (current_setting('app.user_role', true) = 'ADMIN')
          OR (current_setting('app.user_role', true) = 'MANAGER'
              AND l."teamId" = current_setting('app.user_team_id', true))
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
    EXISTS (
      SELECT 1 FROM "Lead" l
      WHERE l.id = "Booking"."leadId"
        AND (
          (current_setting('app.user_role', true) IN ('ADMIN', 'MANAGER')
           AND l."teamId" = current_setting('app.user_team_id', true))
          OR (current_setting('app.user_role', true) IN ('TELECALLER', 'SALES_EXEC')
              AND (
                l."ownerId" = current_setting('app.user_id', true)
                OR l."coOwnerId" = current_setting('app.user_id', true)
              ))
        )
    )
  )
  WITH CHECK (
    EXISTS (
      SELECT 1 FROM "Lead" l
      WHERE l.id = "Booking"."leadId"
        AND (
          (current_setting('app.user_role', true) IN ('ADMIN', 'MANAGER')
           AND l."teamId" = current_setting('app.user_team_id', true))
          OR (current_setting('app.user_role', true) IN ('TELECALLER', 'SALES_EXEC')
              AND (
                l."ownerId" = current_setting('app.user_id', true)
                OR l."coOwnerId" = current_setting('app.user_id', true)
              ))
        )
    )
  );
