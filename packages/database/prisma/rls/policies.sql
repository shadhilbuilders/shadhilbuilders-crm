-- ────────────────────────────────────────────────────────────────────────────
-- Shadhil Builders CRM — Row-Level Security policies
-- ────────────────────────────────────────────────────────────────────────────
-- All policies key off three session variables, set per-request via
-- withRlsContext() in src/rls.ts:
--
--   app.user_id      cuid of the authenticated user
--   app.user_role    ADMIN | MANAGER | SALES_EXEC | TELECALLER
--   app.user_team_id cuid of the user's team (null for ADMIN with no team)
--
-- These are intentionally read with current_setting('app.<x>', true) so a
-- missing setting returns NULL (rather than throwing) — the policies then
-- evaluate NULL comparisons safely (no rows match).
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

CREATE POLICY lead_select_telecaller ON "Lead"
  FOR SELECT
  USING (
    current_setting('app.user_role', true) IN ('TELECALLER', 'SALES_EXEC')
    AND "ownerId" = current_setting('app.user_id', true)
  );

CREATE POLICY lead_select_manager ON "Lead"
  FOR SELECT
  USING (
    current_setting('app.user_role', true) = 'MANAGER'
    AND "teamId" = current_setting('app.user_team_id', true)
  );

CREATE POLICY lead_select_admin ON "Lead"
  FOR SELECT
  USING (current_setting('app.user_role', true) = 'ADMIN');

CREATE POLICY lead_insert_telecaller ON "Lead"
  FOR INSERT
  WITH CHECK (
    current_setting('app.user_role', true) IN ('TELECALLER', 'SALES_EXEC', 'MANAGER', 'ADMIN')
    AND "teamId" = current_setting('app.user_team_id', true)
  );

CREATE POLICY lead_update_telecaller ON "Lead"
  FOR UPDATE
  USING (
    current_setting('app.user_role', true) IN ('TELECALLER', 'SALES_EXEC')
    AND "ownerId" = current_setting('app.user_id', true)
  )
  WITH CHECK (
    current_setting('app.user_role', true) IN ('TELECALLER', 'SALES_EXEC')
    AND "ownerId" = current_setting('app.user_id', true)
  );

CREATE POLICY lead_update_manager ON "Lead"
  FOR UPDATE
  USING (
    current_setting('app.user_role', true) = 'MANAGER'
    AND "teamId" = current_setting('app.user_team_id', true)
  )
  WITH CHECK (
    current_setting('app.user_role', true) = 'MANAGER'
    AND "teamId" = current_setting('app.user_team_id', true)
  );

CREATE POLICY lead_update_admin ON "Lead"
  FOR UPDATE
  USING (current_setting('app.user_role', true) = 'ADMIN')
  WITH CHECK (current_setting('app.user_role', true) = 'ADMIN');

CREATE POLICY lead_delete_admin ON "Lead"
  FOR DELETE
  USING (current_setting('app.user_role', true) = 'ADMIN');

-- ── Activity (scoped via its parent Lead) ──────────────────────────────────
ALTER TABLE "Activity" ENABLE ROW LEVEL SECURITY;

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
              AND l."ownerId" = current_setting('app.user_id', true))
        )
    )
  );

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
              AND l."ownerId" = current_setting('app.user_id', true))
        )
    )
  );

-- ── SiteVisit (team-scoped via lead) ───────────────────────────────────────
ALTER TABLE "SiteVisit" ENABLE ROW LEVEL SECURITY;

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
              AND l."ownerId" = current_setting('app.user_id', true))
        )
    )
  );

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
              AND l."ownerId" = current_setting('app.user_id', true))
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
              AND l."ownerId" = current_setting('app.user_id', true))
        )
    )
  );

-- ── Message (team-scoped via lead) ─────────────────────────────────────────
ALTER TABLE "Message" ENABLE ROW LEVEL SECURITY;

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
              AND l."ownerId" = current_setting('app.user_id', true))
        )
    )
  );

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
              AND l."ownerId" = current_setting('app.user_id', true))
        )
    )
  );

-- ── Booking (team-scoped via lead) ─────────────────────────────────────────
ALTER TABLE "Booking" ENABLE ROW LEVEL SECURITY;

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
              AND l."ownerId" = current_setting('app.user_id', true))
        )
    )
  );

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
              AND l."ownerId" = current_setting('app.user_id', true))
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
              AND l."ownerId" = current_setting('app.user_id', true))
        )
    )
  );

-- ── Reminder (ownerId-scoped; team visibility for managers) ─────────────────
ALTER TABLE "Reminder" ENABLE ROW LEVEL SECURITY;

CREATE POLICY reminder_select_owner ON "Reminder"
  FOR SELECT
  USING (
    "userId" = current_setting('app.user_id', true)
    OR current_setting('app.user_role', true) = 'ADMIN'
    OR current_setting('app.user_role', true) = 'MANAGER'
  );

CREATE POLICY reminder_write_owner ON "Reminder"
  FOR ALL
  USING ("userId" = current_setting('app.user_id', true))
  WITH CHECK ("userId" = current_setting('app.user_id', true));

-- ── Notification (only owner) ──────────────────────────────────────────────
ALTER TABLE "Notification" ENABLE ROW LEVEL SECURITY;

CREATE POLICY notification_select_owner ON "Notification"
  FOR SELECT
  USING ("userId" = current_setting('app.user_id', true));

CREATE POLICY notification_update_owner ON "Notification"
  FOR UPDATE
  USING ("userId" = current_setting('app.user_id', true))
  WITH CHECK ("userId" = current_setting('app.user_id', true));

CREATE POLICY notification_delete_owner ON "Notification"
  FOR DELETE
  USING ("userId" = current_setting('app.user_id', true));

CREATE POLICY notification_insert_owner ON "Notification"
  FOR INSERT
  WITH CHECK ("userId" = current_setting('app.user_id', true));

-- ── AuditLog (admin sees all; others see their own) ────────────────────────
ALTER TABLE "AuditLog" ENABLE ROW LEVEL SECURITY;

CREATE POLICY auditlog_select_admin_or_owner ON "AuditLog"
  FOR SELECT
  USING (
    current_setting('app.user_role', true) = 'ADMIN'
    OR "userId" = current_setting('app.user_id', true)
  );

CREATE POLICY auditlog_insert_any_authenticated ON "AuditLog"
  FOR INSERT
  WITH CHECK (current_setting('app.user_id', true) IS NOT NULL);

-- ── Consent (admin sees all; others see leads they own) ────────────────────
ALTER TABLE "Consent" ENABLE ROW LEVEL SECURITY;

CREATE POLICY consent_select_admin_or_owner ON "Consent"
  FOR SELECT
  USING (
    current_setting('app.user_role', true) = 'ADMIN'
    OR EXISTS (
      SELECT 1 FROM "Lead" l
      WHERE l.id = "Consent"."leadId"
        AND (
          (current_setting('app.user_role', true) = 'MANAGER'
           AND l."teamId" = current_setting('app.user_team_id', true))
          OR (current_setting('app.user_role', true) IN ('TELECALLER', 'SALES_EXEC')
              AND l."ownerId" = current_setting('app.user_id', true))
        )
    )
  );

CREATE POLICY consent_insert_owner ON "Consent"
  FOR INSERT
  WITH CHECK (
    EXISTS (
      SELECT 1 FROM "Lead" l
      WHERE l.id = "Consent"."leadId"
        AND (
          (current_setting('app.user_role', true) IN ('ADMIN', 'MANAGER')
           AND l."teamId" = current_setting('app.user_team_id', true))
          OR (current_setting('app.user_role', true) IN ('TELECALLER', 'SALES_EXEC')
              AND l."ownerId" = current_setting('app.user_id', true))
        )
    )
  );
-- ────────────────────────────────────────────────────────────────────────────
-- AR-1 (2026-08-31): FORCE ROW LEVEL SECURITY.
-- ENABLE alone does NOT constrain the table owner — FORCE does. These run
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
    'Phase','Unit'
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
    'Phase','Unit'
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

-- Jwks — better-auth's jwt() plugin key store. Added in migration
-- 20260831140000_add_jwks; original migration omitted the GRANTs
-- (Round 25 fix). Listed here for future psql -f policies.sql runs.
GRANT SELECT, INSERT, UPDATE, DELETE ON "Jwks" TO shadhil_app;
