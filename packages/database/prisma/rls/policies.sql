-- ────────────────────────────────────────────────────────────────────────────
-- Shadhil Builders CRM - Row-Level Security policies
-- ────────────────────────────────────────────────────────────────────────────
-- All policies key off four session variables, set per-request via
-- withRlsContext() in src/rls.ts:
--
--   app.user_id       cuid of the authenticated user
--   app.user_role     ADMIN | MANAGER | SALES_EXEC | TELECALLER
--   app.user_team_id  cuid of the user's team (null for ADMIN with no team)
--   app.user_org_id   cuid of the organization the actor belongs to
--
-- T-ORG (2026-09-11): EVERY policy is now org-scoped. A user can never see
-- or touch another org's rows because every policy ALSO requires
--
--     "<Table>"."organizationId" = current_setting('app.user_org_id', true)
--
-- These are intentionally read with current_setting('app.<x>', true) so a
-- missing setting returns NULL (rather than throwing) - the policies then
-- evaluate NULL comparisons safely (no rows match). In particular a NULL
-- app.user_org_id yields NULL = 'x' which is never true (fail-closed).
-- On WhatsappUnknownContact (organizationId is NULLABLE) the system keeps
-- org-less rows visible via `"organizationId" IS NULL OR ... = app.user_org_id`.
--
-- ENG REVIEW A5: POOL_MODE must be 'session' for SET LOCAL to persist
-- across the transaction. Boot-check.ts fails startup otherwise.
--
-- SECOND-ROUND AUDIT AR-1 (2026-08-31): FORCE ROW LEVEL SECURITY on every
-- business table. Without it, the TABLE OWNER (and any role with the
-- table's ownership chain, e.g. the original `shadhil` superuser-adjacent
-- role) silently bypasses every policy below. The application connects as
-- the non-owner role `shadhil_app` (created in docker/postgres-init/
-- 00-init.sql); the owner role is reserved for migrations/seed via
-- DIRECT_DATABASE_URL.
-- ────────────────────────────────────────────────────────────────────────────

-- ── Lead ───────────────────────────────────────────────────────────────────
ALTER TABLE "Lead" ENABLE ROW LEVEL SECURITY;

-- ── Organization (tenant axis) ──────────────────────────────────────────────
-- T-ORG (2026-09-11): the Organization table must NOT be world-readable.
-- A user sees ONLY the org row they belong to (app.user_org_id == Organization.id).
-- CRON_SERVICE gets an org-scoped bypass for system reads (webhook ingest,
-- seed verification) mirroring the lead/team CRON conventions.
ALTER TABLE "Organization" ENABLE ROW LEVEL SECURITY;

CREATE POLICY org_select_own ON "Organization"
  FOR SELECT
  USING (
    "id" = current_setting('app.user_org_id', true)
  );

CREATE POLICY org_cron_service_all ON "Organization"
  FOR ALL
  USING (
    current_setting('app.user_role', true) = 'CRON_SERVICE'
    AND "id" = current_setting('app.user_org_id', true)
  )
  WITH CHECK (
    current_setting('app.user_role', true) = 'CRON_SERVICE'
    AND "id" = current_setting('app.user_org_id', true)
  );

CREATE POLICY lead_select_telecaller ON "Lead"
  FOR SELECT
  USING (
    current_setting('app.user_role', true) IN ('TELECALLER', 'SALES_EXEC')
    AND (
      "ownerId" = current_setting('app.user_id', true)
      OR "coOwnerId" = current_setting('app.user_id', true)
    )
    AND "organizationId" = current_setting('app.user_org_id', true)
  );

-- T-TEAM-AUTHORITATIVE (2026-09-13, Decision Audit Trail #39): a manager
-- may now lead multiple teams, so this checks Team.managerId via EXISTS
-- rather than the single-valued app.user_team_id GUC. Non-recursive (Team
-- is a simple lookup, not a query back into Lead).
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

CREATE POLICY lead_select_admin ON "Lead"
  FOR SELECT
  USING (
    current_setting('app.user_role', true) = 'ADMIN'
    AND "organizationId" = current_setting('app.user_org_id', true)
  );

-- T-TEAM-AUTHORITATIVE (2026-09-13): MANAGER split into its own INSERT
-- policy below (EXISTS-based, supports multi-team managers) - this policy
-- now covers only TELECALLER/SALES_EXEC, who stay single-team via the GUC.
CREATE POLICY lead_insert_telecaller ON "Lead"
  FOR INSERT
  WITH CHECK (
    current_setting('app.user_role', true) IN ('TELECALLER', 'SALES_EXEC')
    AND "teamId" = current_setting('app.user_team_id', true)
    AND "organizationId" = current_setting('app.user_org_id', true)
  );

-- T-TEAM-AUTHORITATIVE (2026-09-13): a manager may INSERT a Lead into ANY
-- team they manage (Team.managerId), not just their single JWT-carried
-- teamId. Postgres OR's overlapping FOR INSERT policies, so this is
-- additive alongside lead_insert_telecaller/lead_insert_admin.
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

-- T-TEAMLESS-CREATE (2026-09-08): allow ADMIN (and OWNER, downcast to ADMIN
-- by withRlsContext) to INSERT a Lead into ANY team. Seed ADMIN/OWNER have
-- teamId=null, so app.user_team_id is '' (empty) and the team-equality
-- policy above would reject the insert even after the service resolves a
-- default team. DESIGN.md §3: "admin-created leads can be assigned to any
-- team" - consistent with lead_update_admin / lead_delete_admin (role-only).
-- Postgres OR's overlapping FOR INSERT policies, so staff roles still get
-- team-equality enforcement; only ADMIN bypasses it.
CREATE POLICY lead_insert_admin ON "Lead"
  FOR INSERT
  WITH CHECK (
    current_setting('app.user_role', true) = 'ADMIN'
    AND "organizationId" = current_setting('app.user_org_id', true)
  );

CREATE POLICY lead_update_telecaller ON "Lead"
  FOR UPDATE
  USING (
    current_setting('app.user_role', true) IN ('TELECALLER', 'SALES_EXEC')
    AND (
      "ownerId" = current_setting('app.user_id', true)
      OR "coOwnerId" = current_setting('app.user_id', true)
    )
    AND "organizationId" = current_setting('app.user_org_id', true)
  )
  WITH CHECK (
    current_setting('app.user_role', true) IN ('TELECALLER', 'SALES_EXEC')
    AND (
      "ownerId" = current_setting('app.user_id', true)
      OR "coOwnerId" = current_setting('app.user_id', true)
    )
    AND "organizationId" = current_setting('app.user_org_id', true)
  );

-- T-TEAM-AUTHORITATIVE (2026-09-13): EXISTS-based Team.managerId check
-- (supports a manager leading multiple teams) instead of the single-
-- valued app.user_team_id GUC equality.
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

CREATE POLICY lead_update_admin ON "Lead"
  FOR UPDATE
  USING (
    current_setting('app.user_role', true) = 'ADMIN'
    AND "organizationId" = current_setting('app.user_org_id', true)
  )
  WITH CHECK (
    current_setting('app.user_role', true) = 'ADMIN'
    AND "organizationId" = current_setting('app.user_org_id', true)
  );

CREATE POLICY lead_delete_admin ON "Lead"
  FOR DELETE
  USING (
    current_setting('app.user_role', true) = 'ADMIN'
    AND "organizationId" = current_setting('app.user_org_id', true)
  );

-- ── Activity (scoped via its parent Lead + denormalized org) ───────────────
ALTER TABLE "Activity" ENABLE ROW LEVEL SECURITY;

-- T-TEAM-AUTHORITATIVE (2026-09-13): MANAGER's team check is now EXISTS-
-- based against Team.managerId (supports a manager leading multiple
-- teams) instead of the single-valued app.user_team_id GUC equality.
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

-- ── SiteVisit (team-scoped via lead + denormalized org) ────────────────────
ALTER TABLE "SiteVisit" ENABLE ROW LEVEL SECURITY;

-- T-TEAM-AUTHORITATIVE (2026-09-13): MANAGER's team check is now EXISTS-
-- based against Team.managerId (supports a manager leading multiple
-- teams) instead of the single-valued app.user_team_id GUC equality.
-- ADMIN's clause is left exactly as-is (split out, not otherwise changed).
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

-- T-VISIT-ADMIN-INSERT (2026-09-09): allow ADMIN (and OWNER, which downcasts
-- to ADMIN at the RLS layer) to INSERT a SiteVisit for ANY lead. Mirrors
-- lead_insert_admin (2026-09-08) and message_insert_admin (2026-09-09).
-- Seed ADMIN/OWNER carry teamId=null -> app.user_team_id='' -> the
-- site_visit_write_team WITH CHECK (l.teamId = '') rejects admin inserts.
-- Postgres OR's overlapping FOR INSERT policies: MANAGER still gets
-- team-equality enforcement, TELECALLER/SALES_EXEC still gate on ownerId.
CREATE POLICY site_visit_insert_admin ON "SiteVisit"
  FOR INSERT
  WITH CHECK (
    current_setting('app.user_role', true) = 'ADMIN'
    AND "organizationId" = current_setting('app.user_org_id', true)
  );

-- ── Message (team-scoped via lead + denormalized org) ───────────────────────
ALTER TABLE "Message" ENABLE ROW LEVEL SECURITY;

-- T-TEAM-AUTHORITATIVE (2026-09-13): MANAGER's team check is now EXISTS-
-- based against Team.managerId (supports a manager leading multiple
-- teams) instead of the single-valued app.user_team_id GUC equality.
-- ADMIN's clause is left exactly as-is (split out, not otherwise changed).
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

-- T-CHAT-ADMIN-INSERT (2026-09-09): allow ADMIN (and OWNER, downcast to
-- ADMIN by withRlsContext) to INSERT a Message into ANY lead's thread.
-- Seed ADMIN/OWNER have teamId=null, so app.user_team_id is '' (empty)
-- and the team-equality policy above would reject the insert. Mirrors
-- lead_insert_admin (2026-09-08). Postgres OR's overlapping FOR INSERT
-- policies, so MANAGER still gets team-equality enforcement; only ADMIN
-- bypasses it.
CREATE POLICY message_insert_admin ON "Message"
  FOR INSERT
  WITH CHECK (
    current_setting('app.user_role', true) = 'ADMIN'
    AND "organizationId" = current_setting('app.user_org_id', true)
  );

-- ── Booking (team-scoped via lead + denormalized org) ───────────────────────
ALTER TABLE "Booking" ENABLE ROW LEVEL SECURITY;

-- T-TEAM-AUTHORITATIVE (2026-09-13): MANAGER's team check is now EXISTS-
-- based against Team.managerId (supports a manager leading multiple
-- teams) instead of the single-valued app.user_team_id GUC equality.
-- ADMIN's clause is left exactly as-is (split out, not otherwise changed).
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

-- T-BOOKING-ADMIN-WRITE (2026-09-11): allow ADMIN (and OWNER, which
-- downcasts to ADMIN at the RLS layer) to create/update/delete a Booking
-- for ANY lead. Mirrors the site_visit_insert_admin / message_insert_admin /
-- lead_insert_admin bypasses already shipped for the other via-lead tables.
-- The seed ADMIN/OWNER carry teamId=null -> app.user_team_id='' -> the
-- booking_write_team USING/WITH CHECK (l.teamId = '') rejects admin writes.
-- Postgres OR's overlapping FOR ALL policies: MANAGER still gets
-- team-equality enforcement, TELECALLER/SALES_EXEC still gate on ownerId.
CREATE POLICY booking_write_admin ON "Booking"
  FOR ALL
  USING (
    current_setting('app.user_role', true) = 'ADMIN'
    AND "organizationId" = current_setting('app.user_org_id', true)
  )
  WITH CHECK (
    current_setting('app.user_role', true) = 'ADMIN'
    AND "organizationId" = current_setting('app.user_org_id', true)
  );

-- ── Reminder (ownerId-scoped; team visibility for managers) ─────────────────
ALTER TABLE "Reminder" ENABLE ROW LEVEL SECURITY;

CREATE POLICY reminder_select_owner ON "Reminder"
  FOR SELECT
  USING (
    "organizationId" = current_setting('app.user_org_id', true)
    AND (
      "userId" = current_setting('app.user_id', true)
      OR current_setting('app.user_role', true) = 'ADMIN'
      OR current_setting('app.user_role', true) = 'MANAGER'
    )
  );

CREATE POLICY reminder_write_owner ON "Reminder"
  FOR ALL
  USING (
    "organizationId" = current_setting('app.user_org_id', true)
    AND "userId" = current_setting('app.user_id', true)
  )
  WITH CHECK (
    "organizationId" = current_setting('app.user_org_id', true)
    AND "userId" = current_setting('app.user_id', true)
  );

-- T-CRONS (2026-09-07): explicit service-account policy so the reminder
-- cron (role=CRON_SERVICE) can claim any row regardless of owner. The
-- cron's updateMany(SCHEDULED → PROCESSING) was returning 0 rows because
-- reminder_write_owner is FOR ALL with userId=app.user_id and the cron
-- actor's userId='cron-service' doesn't match any real reminder's userId.
-- PostgreSQL OR's overlapping FOR ALL policies, so this policy is the
-- bypass for service-account jobs without removing the owner check for
-- real users.
--
-- Impersonation guard: the CRON_SERVICE branch requires BOTH
-- app.user_role='CRON_SERVICE' AND app.user_id='cron-service'. A user
-- who somehow sets app.user_role='CRON_SERVICE' but uses their own
-- userId cannot satisfy this AND clause, so they fall through to the
-- OR'd owner check and the bypass is denied. The cron is the only
-- legitimate caller of withRlsContext with role='CRON_SERVICE' (see
-- reminders.service.ts:tick), so userId='cron-service' is the
-- canonical service-account sentinel.
CREATE POLICY reminder_cron_service ON "Reminder"
  FOR ALL
  TO shadhil_app
  USING (
    "organizationId" = current_setting('app.user_org_id', true)
    AND (
      (
        current_setting('app.user_role', true) = 'CRON_SERVICE'
        AND current_setting('app.user_id', true) = 'cron-service'
      )
      OR "userId" = current_setting('app.user_id', true)
    )
  )
  WITH CHECK (
    "organizationId" = current_setting('app.user_org_id', true)
    AND (
      (
        current_setting('app.user_role', true) = 'CRON_SERVICE'
        AND current_setting('app.user_id', true) = 'cron-service'
      )
      OR "userId" = current_setting('app.user_id', true)
    )
  );

-- ── Notification (only owner) ──────────────────────────────────────────────
ALTER TABLE "Notification" ENABLE ROW LEVEL SECURITY;

CREATE POLICY notification_select_owner ON "Notification"
  FOR SELECT
  USING (
    "organizationId" = current_setting('app.user_org_id', true)
    AND "userId" = current_setting('app.user_id', true)
  );

CREATE POLICY notification_update_owner ON "Notification"
  FOR UPDATE
  USING (
    "organizationId" = current_setting('app.user_org_id', true)
    AND "userId" = current_setting('app.user_id', true)
  )
  WITH CHECK (
    "organizationId" = current_setting('app.user_org_id', true)
    AND "userId" = current_setting('app.user_id', true)
  );

CREATE POLICY notification_delete_owner ON "Notification"
  FOR DELETE
  USING (
    "organizationId" = current_setting('app.user_org_id', true)
    AND "userId" = current_setting('app.user_id', true)
  );

CREATE POLICY notification_insert_owner ON "Notification"
  FOR INSERT
  WITH CHECK (
    "organizationId" = current_setting('app.user_org_id', true)
    AND "userId" = current_setting('app.user_id', true)
  );

-- ── PushSubscription (only owner) ─────────────────────────────────────────
ALTER TABLE "PushSubscription" ENABLE ROW LEVEL SECURITY;

CREATE POLICY push_subscription_select_owner ON "PushSubscription"
  FOR SELECT
  USING (
    "organizationId" = current_setting('app.user_org_id', true)
    AND "userId" = current_setting('app.user_id', true)
  );

CREATE POLICY push_subscription_insert_owner ON "PushSubscription"
  FOR INSERT
  WITH CHECK (
    "organizationId" = current_setting('app.user_org_id', true)
    AND "userId" = current_setting('app.user_id', true)
  );

CREATE POLICY push_subscription_update_owner ON "PushSubscription"
  FOR UPDATE
  USING (
    "organizationId" = current_setting('app.user_org_id', true)
    AND "userId" = current_setting('app.user_id', true)
  )
  WITH CHECK (
    "organizationId" = current_setting('app.user_org_id', true)
    AND "userId" = current_setting('app.user_id', true)
  );

CREATE POLICY push_subscription_delete_owner ON "PushSubscription"
  FOR DELETE
  USING (
    "organizationId" = current_setting('app.user_org_id', true)
    AND "userId" = current_setting('app.user_id', true)
  );

-- ── PushNotification (only owner) ──────────────────────────────────────────
ALTER TABLE "PushNotification" ENABLE ROW LEVEL SECURITY;

CREATE POLICY push_notification_select_owner ON "PushNotification"
  FOR SELECT
  USING (
    "organizationId" = current_setting('app.user_org_id', true)
    AND "userId" = current_setting('app.user_id', true)
  );

CREATE POLICY push_notification_insert_owner ON "PushNotification"
  FOR INSERT
  WITH CHECK (
    "organizationId" = current_setting('app.user_org_id', true)
    AND "userId" = current_setting('app.user_id', true)
  );

-- ── AuditLog (admin sees all in org; others see their own) ─────────────────
ALTER TABLE "AuditLog" ENABLE ROW LEVEL SECURITY;

CREATE POLICY auditlog_select_admin_or_owner ON "AuditLog"
  FOR SELECT
  USING (
    "organizationId" = current_setting('app.user_org_id', true)
    AND (
      current_setting('app.user_role', true) = 'ADMIN'
      OR "userId" = current_setting('app.user_id', true)
    )
  );

CREATE POLICY auditlog_insert_any_authenticated ON "AuditLog"
  FOR INSERT
  WITH CHECK (
    current_setting('app.user_id', true) IS NOT NULL
    AND "organizationId" = current_setting('app.user_org_id', true)
  );

-- ── Consent (admin sees all in org; others see leads they own) ─────────────
ALTER TABLE "Consent" ENABLE ROW LEVEL SECURITY;

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

-- ────────────────────────────────────────────────────────────────────────────
-- Week 5 - ManagerAssignmentRule RLS (Plan §18 D2 + T-ARM-SCHEMA).
-- ────────────────────────────────────────────────────────────────────────────
-- The rules table is server-side state consulted by the engine at lead-
-- creation time (apps/backend/src/leads/leads.service.ts::create). Every
-- MANAGER needs to SELECT their team's rules so the engine can evaluate
-- them; ADMIN/OWNER see everything in the org. No INSERT/UPDATE/DELETE
-- policies - rule management is an admin-class concern, exercised today via
-- the seed/bootstrap path (DIRECT_DATABASE_URL bypasses RLS) and tomorrow
-- via a dedicated admin endpoint with its own RLS-friendly write path.
-- Until that endpoint ships, INSERT/UPDATE/DELETE return zero rows
-- (DEFAULT DENY) on the pooled role.
ALTER TABLE "ManagerAssignmentRule" ENABLE ROW LEVEL SECURITY;

-- T-TEAM-AUTHORITATIVE (2026-09-13): EXISTS-based Team.managerId check
-- (supports a manager leading multiple teams) instead of the app.user_
-- team_id GUC equality.
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
-- ────────────────────────────────────────────────────────────────────────────
-- AR-1 (2026-08-31): FORCE ROW LEVEL SECURITY.
-- ENABLE alone does NOT constrain the table owner - FORCE does. These run
-- after all policies; ALTER TABLE on an existing table is idempotent-safe
-- when wrapped in a guard via DO blocks (no-op if already forced).
-- Also grants the non-owner app role access (00-init.sql creates the role).
-- ────────────────────────────────────────────────────────────────────────────

DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY[
    'Lead','Activity','SiteVisit','Message','Booking','Reminder',
    'Notification','PushSubscription','PushNotification','AuditLog',
    'Consent','WebhookEvent','ManagerAssignmentRule','Team','Project',
    'Phase','Unit','StreamTicket','OutboundMessage',
    'ProjectOption','WhatsappUnknownContact','Organization',
    'TeamMember','ProjectTeam'
  ]
  LOOP
    EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY;', t);
  END LOOP;
END
$$;

-- App role permissions: it owns nothing, so it needs SELECT/INSERT/UPDATE/
-- DELETE grants on every business table + sequences + Session/Account/
-- Verification (auth tables written by better-auth through the pooled path).
-- The migration (not this file) is the canonical application point when run
-- via prisma migrate; this block ALSO lives in the migration wrapper so a
-- plain `psql -f policies.sql` works identically.

-- Schema-level USAGE + CREATE grants for shadhil_app. Without USAGE on
-- `public`, the table-level GRANTs below are invisible to the role and
-- every app query fails with `42501 permission denied for schema public`
-- (or `42P01 relation does not exist`). Round 25 fix: explicit grants
-- added. CREATE is needed for Prisma's $executeRawUnsafe during bootstrap
-- migrations. Idempotent at the role level.
GRANT USAGE, CREATE ON SCHEMA public TO shadhil_app;

DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY[
    'Lead','Activity','SiteVisit','Message','Booking','Reminder',
    'Notification','PushSubscription','PushNotification','AuditLog',
    'Consent','WebhookEvent','ManagerAssignmentRule','Team','Project',
    'Phase','Unit','StreamTicket','OutboundMessage',
    'ProjectOption','WhatsappUnknownContact','Organization',
    'TeamMember','ProjectTeam'
  ]
  LOOP
    EXECUTE format('GRANT SELECT, INSERT, UPDATE, DELETE ON %I TO shadhil_app;', t);
  END LOOP;
END
$$;

-- Sequences (cuid is app-side; serial/backing sequences for safety)
GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA public TO shadhil_app;

-- Auth tables (better-auth writes these on the pooled URL too)
GRANT SELECT, INSERT, UPDATE, DELETE ON "User", "Session", "Account", "Verification" TO shadhil_app;

-- Jwks - better-auth's jwt() plugin key store. Added in migration
-- 20260831140000_add_jwks; original migration omitted the GRANTs
-- (Round 25 fix). Listed here for future psql -f policies.sql runs.
GRANT SELECT, INSERT, UPDATE, DELETE ON "Jwks" TO shadhil_app;

-- ────────────────────────────────────────────────────────────────────
-- T-E2b (2026-09-04): WebhookEvent + WhatsappUnknownContact RLS
-- ────────────────────────────────────────────────────────────────────
-- The RLS policies for these tables live in migration
-- 20260905000100_t_e2b_inbound_rls_and_grants/migration.sql.
-- This block adds the table-level GRANTs to shadhil_app (the role
-- migration runner / psql -f policies.sql may not have applied
-- them in a fresh deploy) and a mirror of the RLS policies so the
-- canonical policies.sql stays the source of truth for greenfield
-- deploys.
GRANT SELECT, INSERT, UPDATE, DELETE ON "WebhookEvent" TO shadhil_app;
GRANT SELECT, INSERT, UPDATE, DELETE ON "WhatsappUnknownContact" TO shadhil_app;

ALTER TABLE "WebhookEvent" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "WhatsappUnknownContact" ENABLE ROW LEVEL SECURITY;

-- CRON_SERVICE is a system role with no real user/org; withRlsContext sets
-- app.user_org_id to the target org ('ceid01lpfe1esm8jwsxid41k28' in the single-org
-- deploy) so these bypasses stay org-scoped.
CREATE POLICY webhook_cron_service_all ON "WebhookEvent"
  FOR ALL
  USING (
    current_setting('app.user_role', true) = 'CRON_SERVICE'
    AND "organizationId" = current_setting('app.user_org_id', true)
  )
  WITH CHECK (
    current_setting('app.user_role', true) = 'CRON_SERVICE'
    AND "organizationId" = current_setting('app.user_org_id', true)
  );

CREATE POLICY webhook_select_admin ON "WebhookEvent"
  FOR SELECT
  USING (
    (
      current_setting('app.user_role', true) = 'ADMIN'
      OR current_setting('app.user_role', true) = 'OWNER'
    )
    AND "organizationId" = current_setting('app.user_org_id', true)
  );

-- Outbound delivery feed: ADMIN/OWNER SELECT for the integrations
-- whatsapp-delivery page (2026-09-11). Without this, only CRON_SERVICE
-- (outbound_cron_service_select) can read OutboundMessage, so the ops feed
-- would return zero rows for staff. Org-scoped like the cron policy.
CREATE POLICY outbound_select_admin ON "OutboundMessage"
  FOR SELECT
  USING (
    (
      current_setting('app.user_role', true) = 'ADMIN'
      OR current_setting('app.user_role', true) = 'OWNER'
    )
    AND "organizationId" = current_setting('app.user_org_id', true)
  );

CREATE POLICY webhook_update_admin ON "WebhookEvent"
  FOR UPDATE
  USING (
    current_setting('app.user_role', true) = 'ADMIN'
    AND "organizationId" = current_setting('app.user_org_id', true)
  )
  WITH CHECK (
    current_setting('app.user_role', true) = 'ADMIN'
    AND "organizationId" = current_setting('app.user_org_id', true)
  );

-- WhatsappUnknownContact.organizationId is NULLABLE (eng review Finding 3) -
-- org-less rows (legacy / pre-org) are kept visible to the system with
-- `"organizationId" IS NULL OR "organizationId" = app.user_org_id`, while
-- rows owned by a DIFFERENT org are never visible. This is the multi-org-safe
-- form: NULL rows belong to no org, so they cannot leak across tenants.
CREATE POLICY wa_unknown_cron_service_all ON "WhatsappUnknownContact"
  FOR ALL
  USING (
    current_setting('app.user_role', true) = 'CRON_SERVICE'
    AND ("organizationId" IS NULL OR "organizationId" = current_setting('app.user_org_id', true))
  )
  WITH CHECK (
    current_setting('app.user_role', true) = 'CRON_SERVICE'
    AND ("organizationId" IS NULL OR "organizationId" = current_setting('app.user_org_id', true))
  );

-- Admin-class (ADMIN/OWNER/MANAGER) can see and update the follow-up
-- queue. The WhatsappUnknownContact table has no teamId column -
-- the queue is company-wide, not per-team - so the policy is just
-- role-based. T-E2b follow-up: telecallers see the result via the
-- converted Lead on the existing Leads page, not here.
CREATE POLICY wa_unknown_select_admin_class ON "WhatsappUnknownContact"
  FOR SELECT
  USING (
    current_setting('app.user_role', true) IN ('ADMIN', 'OWNER', 'MANAGER')
    AND ("organizationId" IS NULL OR "organizationId" = current_setting('app.user_org_id', true))
  );

CREATE POLICY wa_unknown_update_admin_class ON "WhatsappUnknownContact"
  FOR UPDATE
  USING (
    current_setting('app.user_role', true) IN ('ADMIN', 'OWNER', 'MANAGER')
    AND ("organizationId" IS NULL OR "organizationId" = current_setting('app.user_org_id', true))
  )
  WITH CHECK (
    current_setting('app.user_role', true) IN ('ADMIN', 'OWNER', 'MANAGER')
    AND ("organizationId" IS NULL OR "organizationId" = current_setting('app.user_org_id', true))
  );

-- T-E2b follow-up (2026-09-05): INSERT bypass for admin-class so
-- test fixtures and operator tools can seed PENDING rows. The
-- webhook (CRON_SERVICE) already has its own FOR-ALL policy.
-- DELETE is intentionally NOT added here - see migration
-- 20260905000300 for the rationale.
CREATE POLICY wa_unknown_insert_admin_class ON "WhatsappUnknownContact"
  FOR INSERT
  WITH CHECK (
    current_setting('app.user_role', true) IN ('ADMIN', 'OWNER', 'MANAGER')
    AND ("organizationId" IS NULL OR "organizationId" = current_setting('app.user_org_id', true))
  );

-- ────────────────────────────────────────────────────────────────────
-- T-E2b (2026-09-04): Message INSERT bypass for CRON_SERVICE
-- ────────────────────────────────────────────────────────────────────
-- The WhatsApp inbound webhook handler creates Message rows
-- (channel=WHATSAPP, direction=INBOUND) when a lead replies. The
-- handler runs as CRON_SERVICE - no app.user_id is set, because
-- the sender is the lead (a customer), not an internal user. The
-- existing message_insert_team policy gates on app.user_id being
-- set to a staff member, which doesn't apply for inbound leads.
--
-- Adding this CRON_SERVICE bypass lets the handler insert messages
-- without needing to fake an internal user_id. The row's
-- visibility is still gated by the lead's existing select_team
-- policy (the Message row is visible to the lead's team only).
-- ────────────────────────────────────────────────────────────────────
-- T-E2b (2026-09-04): OutboundMessage CRON_SERVICE bypass (for the
-- outbound cron processor, apps/backend/src/whatsapp/outbound.cron.ts)
-- ────────────────────────────────────────────────────────────────────
-- The cron processor (OutboundCronService) runs as CRON_SERVICE and
-- needs full read+update on OutboundMessage rows to:
--   1. SELECT PENDING rows (claimPending → findMany)
--   2. UPDATE rows from PENDING → SENDING (the claim lease)
--   3. UPDATE rows from SENDING → SENT/FAILED/PENDING (after sendOne)
-- The existing outbound_update_cron_service policy only covers
-- UPDATE - not SELECT. Without a SELECT bypass, the cron's
-- findMany returns zero rows and no messages ever get sent.
-- The INSERT policy (outbound_insert_authenticated) already covers
-- the chat-service enqueue path; we don't change that. The DELETE
-- policy (outbound_delete_admin) is for operator cleanup.
CREATE POLICY outbound_cron_service_select ON "OutboundMessage"
  FOR SELECT
  USING (
    current_setting('app.user_role', true) = 'CRON_SERVICE'
    AND "organizationId" = current_setting('app.user_org_id', true)
  );

CREATE POLICY outbound_cron_service_insert ON "OutboundMessage"
  FOR INSERT
  WITH CHECK (
    current_setting('app.user_role', true) = 'CRON_SERVICE'
    AND "organizationId" = current_setting('app.user_org_id', true)
  );

-- ────────────────────────────────────────────────────────────────────
-- Message INSERT bypass for CRON_SERVICE
-- ────────────────────────────────────────────────────────────────────
-- The WhatsApp inbound webhook handler creates Message rows
-- (channel=WHATSAPP, direction=INBOUND) when a lead replies. The
-- handler runs as CRON_SERVICE - no app.user_id is set, because
-- the sender is the lead (a customer), not an internal user. The
-- existing message_insert_team policy gates on app.user_id being
-- set to a staff member, which doesn't apply for inbound leads.
--
-- Adding this CRON_SERVICE bypass lets the handler insert messages
-- without needing to fake an internal user_id. The row's
-- visibility is still gated by the lead's existing select_team
-- policy (the Message row is visible to the lead's team only).
CREATE POLICY message_insert_cron_service ON "Message"
  FOR INSERT
  WITH CHECK (
    current_setting('app.user_role', true) = 'CRON_SERVICE'
    AND "organizationId" = current_setting('app.user_org_id', true)
  );

-- Message DELETE bypass for ADMIN/CRON_SERVICE (cleanup paths,
-- e.g. test fixtures, manual purges). Without this, the bare
-- shadhil_app role cannot delete Message rows at all - only
-- inheritance via Lead/OutboundMessage cascade works in
-- production. The chat test cleanup and the cron test cleanup
-- both rely on this policy.
CREATE POLICY message_delete_admin_or_cron ON "Message"
  FOR DELETE
  USING (
    (
      current_setting('app.user_role', true) = 'ADMIN'
      OR current_setting('app.user_role', true) = 'CRON_SERVICE'
    )
    AND "organizationId" = current_setting('app.user_org_id', true)
  );

-- OutboundMessage status updates from the WhatsApp status webhook
-- (delivered/read/failed) also run as CRON_SERVICE. The existing
-- outbound_update_team policy requires the actor to be a staff
-- member with lead visibility, which doesn't apply - the actor IS
-- the system. Add a CRON_SERVICE bypass.
CREATE POLICY outbound_update_cron_service ON "OutboundMessage"
  FOR UPDATE
  USING (
    current_setting('app.user_role', true) = 'CRON_SERVICE'
    AND "organizationId" = current_setting('app.user_org_id', true)
  )
  WITH CHECK (
    current_setting('app.user_role', true) = 'CRON_SERVICE'
    AND "organizationId" = current_setting('app.user_org_id', true)
  );

-- The inbound handler also needs to SELECT the Lead (to look it
-- up by phoneE164) and SELECT the existing WhatsappUnknownContact
-- row (for the upsert path). The existing lead_select_* policies
-- require staff-role context; add a CRON_SERVICE bypass so the
-- system can resolve "is this phone a known lead?" without
-- faking a staff user. The CRON_SERVICE role then writes
-- Message (via the CRON_SERVICE bypass above) - the Message row
-- inherits the lead's visibility through the message_select_team
-- policy, so staff still only see messages for leads they own.
CREATE POLICY lead_select_cron_service ON "Lead"
  FOR SELECT
  USING (
    current_setting('app.user_role', true) = 'CRON_SERVICE'
    AND "organizationId" = current_setting('app.user_org_id', true)
  );

-- WhatsappUnknownContact SELECT for the upsert: the existing
-- cron_service_all policy already covers this (FOR ALL = all
-- commands), so no extra policy needed.

-- ── Project (registry - T-ProjectSwitch, 2026-09-05) ────────────────────────
-- ENABLE + policies landed in migration 20260905203000 (previously the
-- table had FORCE without ENABLE and zero policies - RLS was a no-op).
-- SELECT is open to every authenticated role (the sidebar switcher needs
-- the registry; RERA/CMDA are public-record fields) - but STILL org-gated
-- so an actor only sees their own org's projects. Writes are
-- ADMIN-class; OWNER-only delete is enforced ABOVE this layer in
-- ProjectsService (withRlsContext downcasts OWNER→ADMIN, so the GUC
-- cannot distinguish them - the service's JWT role check is the precise
-- wall, this policy is the second wall).
ALTER TABLE "Project" ENABLE ROW LEVEL SECURITY;

CREATE POLICY project_select_any_authenticated ON "Project"
  FOR SELECT
  USING (
    current_setting('app.user_role', true) IN
      ('ADMIN', 'MANAGER', 'TELECALLER', 'SALES_EXEC', 'CRON_SERVICE')
    AND "organizationId" = current_setting('app.user_org_id', true)
  );

CREATE POLICY project_insert_admin ON "Project"
  FOR INSERT
  WITH CHECK (
    current_setting('app.user_role', true) = 'ADMIN'
    AND "organizationId" = current_setting('app.user_org_id', true)
  );

CREATE POLICY project_update_admin ON "Project"
  FOR UPDATE
  USING (
    current_setting('app.user_role', true) = 'ADMIN'
    AND "organizationId" = current_setting('app.user_org_id', true)
  )
  WITH CHECK (
    current_setting('app.user_role', true) = 'ADMIN'
    AND "organizationId" = current_setting('app.user_org_id', true)
  );

CREATE POLICY project_delete_admin ON "Project"
  FOR DELETE
  USING (
    current_setting('app.user_role', true) = 'ADMIN'
    AND "organizationId" = current_setting('app.user_org_id', true)
  );

-- ── Team (T-TEAM-CRUD, 2026-09-13) ──────────────────────────────────────────
-- ENABLE + policies land in migration 20260913000000 - previously the
-- table had FORCE without ENABLE and zero policies, so RLS was a no-op
-- (Team access was only gated by app code). Mirrors Project's policy shape
-- exactly. SELECT is open to every authenticated role (the sidebar
-- TeamSwitcher + create-user dialog need the list) but still org-gated.
-- Writes are ADMIN-class; OWNER travels as ADMIN at this layer (rls.ts
-- downcast) - the service is the precise wall (ADMIN/OWNER check +
-- members/manager delete-guard).
ALTER TABLE "Team" ENABLE ROW LEVEL SECURITY;

CREATE POLICY team_select_any_authenticated ON "Team"
  FOR SELECT
  USING (
    current_setting('app.user_role', true) IN
      ('ADMIN', 'MANAGER', 'TELECALLER', 'SALES_EXEC', 'CRON_SERVICE')
    AND "organizationId" = current_setting('app.user_org_id', true)
  );

CREATE POLICY team_insert_admin ON "Team"
  FOR INSERT
  WITH CHECK (
    current_setting('app.user_role', true) = 'ADMIN'
    AND "organizationId" = current_setting('app.user_org_id', true)
  );

CREATE POLICY team_update_admin ON "Team"
  FOR UPDATE
  USING (
    current_setting('app.user_role', true) = 'ADMIN'
    AND "organizationId" = current_setting('app.user_org_id', true)
  )
  WITH CHECK (
    current_setting('app.user_role', true) = 'ADMIN'
    AND "organizationId" = current_setting('app.user_org_id', true)
  );

CREATE POLICY team_delete_admin ON "Team"
  FOR DELETE
  USING (
    current_setting('app.user_role', true) = 'ADMIN'
    AND "organizationId" = current_setting('app.user_org_id', true)
  );

-- ── TeamMember / ProjectTeam (T-TEAM-AUTHORITATIVE, 2026-09-13) ─────────────
-- ENABLE + policies land in migration 20260913010000 - additive expand-phase
-- tables (see Decision Audit Trail #39 in IMPLEMENTATION-PLAN-v1.md). Both
-- tables are net-new; there is no legacy policy to migrate.
--
-- TeamMember SELECT is intentionally non-recursive (design doc requirement):
-- own memberships, teams the actor manages (Team.managerId - not a query
-- back into TeamMember, so no self-reference), or organization ADMIN. It
-- does NOT let an ordinary team member see who else is on their team via
-- this policy alone - that "who's on my team" view is a service-layer
-- concern (TeamAccessService) once the removal-flow endpoints exist; for
-- now this is the minimum safe SELECT surface for the additive backfill to
-- be verifiable without opening membership to every authenticated role.
ALTER TABLE "TeamMember" ENABLE ROW LEVEL SECURITY;

CREATE POLICY teammember_select_own_or_managed_or_admin ON "TeamMember"
  FOR SELECT
  USING (
    "organizationId" = current_setting('app.user_org_id', true)
    AND (
      current_setting('app.user_role', true) = 'ADMIN'
      OR "userId" = current_setting('app.user_id', true)
      OR EXISTS (
        SELECT 1 FROM "Team" t
        WHERE t."id" = "TeamMember"."teamId"
          AND t."managerId" = current_setting('app.user_id', true)
      )
    )
  );

CREATE POLICY teammember_write_admin ON "TeamMember"
  FOR ALL
  USING (
    current_setting('app.user_role', true) = 'ADMIN'
    AND "organizationId" = current_setting('app.user_org_id', true)
  )
  WITH CHECK (
    current_setting('app.user_role', true) = 'ADMIN'
    AND "organizationId" = current_setting('app.user_org_id', true)
  );

-- ProjectTeam SELECT mirrors Project/Team's shape exactly: any authenticated
-- business role, org-gated. Writes are ADMIN-class for now; the eventual
-- Owner/Admin "Link team" / "Unlink" endpoints (UI3 in the design doc) are
-- the precise wall above this layer, same pattern as Project/Team.
ALTER TABLE "ProjectTeam" ENABLE ROW LEVEL SECURITY;

CREATE POLICY projectteam_select_any_authenticated ON "ProjectTeam"
  FOR SELECT
  USING (
    current_setting('app.user_role', true) IN
      ('ADMIN', 'MANAGER', 'TELECALLER', 'SALES_EXEC', 'CRON_SERVICE')
    AND "organizationId" = current_setting('app.user_org_id', true)
  );

CREATE POLICY projectteam_write_admin ON "ProjectTeam"
  FOR ALL
  USING (
    current_setting('app.user_role', true) = 'ADMIN'
    AND "organizationId" = current_setting('app.user_org_id', true)
  )
  WITH CHECK (
    current_setting('app.user_role', true) = 'ADMIN'
    AND "organizationId" = current_setting('app.user_org_id', true)
  );
