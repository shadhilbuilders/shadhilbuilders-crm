-- ────────────────────────────────────────────────────────────────────────────
-- Shadhil Builders CRM - Row-Level Security policies
-- ────────────────────────────────────────────────────────────────────────────
-- All policies key off three session variables, set per-request via
-- withRlsContext() in src/rls.ts:
--
--   app.user_id      cuid of the authenticated user
--   app.user_role    ADMIN | MANAGER | SALES_EXEC | TELECALLER
--   app.user_team_id cuid of the user's team (null for ADMIN with no team)
--
-- These are intentionally read with current_setting('app.<x>', true) so a
-- missing setting returns NULL (rather than throwing) - the policies then
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
    (
      current_setting('app.user_role', true) = 'CRON_SERVICE'
      AND current_setting('app.user_id', true) = 'cron-service'
    )
    OR "userId" = current_setting('app.user_id', true)
  )
  WITH CHECK (
    (
      current_setting('app.user_role', true) = 'CRON_SERVICE'
      AND current_setting('app.user_id', true) = 'cron-service'
    )
    OR "userId" = current_setting('app.user_id', true)
  );

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
-- Week 5 - ManagerAssignmentRule RLS (Plan §18 D2 + T-ARM-SCHEMA).
-- ────────────────────────────────────────────────────────────────────────────
-- The rules table is server-side state consulted by the engine at lead-
-- creation time (apps/backend/src/leads/leads.service.ts::create). Every
-- MANAGER needs to SELECT their team's rules so the engine can evaluate
-- them; ADMIN/OWNER see everything. No INSERT/UPDATE/DELETE policies -
-- rule management is an admin-class concern, exercised today via the
-- seed/bootstrap path (DIRECT_DATABASE_URL bypasses RLS) and tomorrow
-- via a dedicated admin endpoint with its own RLS-friendly write path.
-- Until that endpoint ships, INSERT/UPDATE/DELETE return zero rows
-- (DEFAULT DENY) on the pooled role.
ALTER TABLE "ManagerAssignmentRule" ENABLE ROW LEVEL SECURITY;

CREATE POLICY managerassignmentrule_select_team ON "ManagerAssignmentRule"
  FOR SELECT
  USING (
    (
      current_setting('app.user_role', true) = 'MANAGER'
      AND "teamId" = current_setting('app.user_team_id', true)
    )
    OR current_setting('app.user_role', true) IN ('ADMIN', 'OWNER')
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
    'WhatsappUnknownContact'
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
    'WhatsappUnknownContact'
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

CREATE POLICY webhook_cron_service_all ON "WebhookEvent"
  FOR ALL
  USING (current_setting('app.user_role', true) = 'CRON_SERVICE')
  WITH CHECK (current_setting('app.user_role', true) = 'CRON_SERVICE');

CREATE POLICY webhook_select_admin ON "WebhookEvent"
  FOR SELECT
  USING (current_setting('app.user_role', true) = 'ADMIN');

CREATE POLICY webhook_update_admin ON "WebhookEvent"
  FOR UPDATE
  USING (current_setting('app.user_role', true) = 'ADMIN')
  WITH CHECK (current_setting('app.user_role', true) = 'ADMIN');

CREATE POLICY wa_unknown_cron_service_all ON "WhatsappUnknownContact"
  FOR ALL
  USING (current_setting('app.user_role', true) = 'CRON_SERVICE')
  WITH CHECK (current_setting('app.user_role', true) = 'CRON_SERVICE');

-- Admin-class (ADMIN/OWNER/MANAGER) can see and update the follow-up
-- queue. The WhatsappUnknownContact table has no teamId column -
-- the queue is company-wide, not per-team - so the policy is just
-- role-based. T-E2b follow-up: telecallers see the result via the
-- converted Lead on the existing Leads page, not here.
CREATE POLICY wa_unknown_select_admin_class ON "WhatsappUnknownContact"
  FOR SELECT
  USING (
    current_setting('app.user_role', true) IN ('ADMIN', 'OWNER', 'MANAGER')
  );

CREATE POLICY wa_unknown_update_admin_class ON "WhatsappUnknownContact"
  FOR UPDATE
  USING (
    current_setting('app.user_role', true) IN ('ADMIN', 'OWNER', 'MANAGER')
  )
  WITH CHECK (
    current_setting('app.user_role', true) IN ('ADMIN', 'OWNER', 'MANAGER')
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
  USING (current_setting('app.user_role', true) = 'CRON_SERVICE');

CREATE POLICY outbound_cron_service_insert ON "OutboundMessage"
  FOR INSERT
  WITH CHECK (current_setting('app.user_role', true) = 'CRON_SERVICE');

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
  WITH CHECK (current_setting('app.user_role', true) = 'CRON_SERVICE');

-- Message DELETE bypass for ADMIN/CRON_SERVICE (cleanup paths,
-- e.g. test fixtures, manual purges). Without this, the bare
-- shadhil_app role cannot delete Message rows at all - only
-- inheritance via Lead/OutboundMessage cascade works in
-- production. The chat test cleanup and the cron test cleanup
-- both rely on this policy.
CREATE POLICY message_delete_admin_or_cron ON "Message"
  FOR DELETE
  USING (
    current_setting('app.user_role', true) = 'ADMIN'
    OR current_setting('app.user_role', true) = 'CRON_SERVICE'
  );

-- OutboundMessage status updates from the WhatsApp status webhook
-- (delivered/read/failed) also run as CRON_SERVICE. The existing
-- outbound_update_team policy requires the actor to be a staff
-- member with lead visibility, which doesn't apply - the actor IS
-- the system. Add a CRON_SERVICE bypass.
CREATE POLICY outbound_update_cron_service ON "OutboundMessage"
  FOR UPDATE
  USING (current_setting('app.user_role', true) = 'CRON_SERVICE')
  WITH CHECK (current_setting('app.user_role', true) = 'CRON_SERVICE');

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
  USING (current_setting('app.user_role', true) = 'CRON_SERVICE');

-- WhatsappUnknownContact SELECT for the upsert: the existing
-- cron_service_all policy already covers this (FOR ALL = all
-- commands), so no extra policy needed.

-- ── Project (registry - T-ProjectSwitch, 2026-09-05) ────────────────────────
-- ENABLE + policies landed in migration 20260905203000 (previously the
-- table had FORCE without ENABLE and zero policies - RLS was a no-op).
-- SELECT is open to every authenticated role (the sidebar switcher needs
-- the registry; RERA/CMDA are public-record fields). Writes are
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
  );

CREATE POLICY project_insert_admin ON "Project"
  FOR INSERT
  WITH CHECK (current_setting('app.user_role', true) = 'ADMIN');

CREATE POLICY project_update_admin ON "Project"
  FOR UPDATE
  USING (current_setting('app.user_role', true) = 'ADMIN')
  WITH CHECK (current_setting('app.user_role', true) = 'ADMIN');

CREATE POLICY project_delete_admin ON "Project"
  FOR DELETE
  USING (current_setting('app.user_role', true) = 'ADMIN');
