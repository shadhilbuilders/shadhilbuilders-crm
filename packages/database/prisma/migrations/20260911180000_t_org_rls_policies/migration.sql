-- ─────────────────────────────────────────────────────────────────────────────
-- T-ORG RLS policies: org-scope every Row-Level Security policy (2026-09-11)
-- ─────────────────────────────────────────────────────────────────────────────
-- Canonical source: prisma/rls/policies.sql. This migration applies the SAME
-- org-scoping to the live database, dropping the prior org-less policies and
-- recreating them with the identical name plus an org gate:
--
--     "<Table>"."organizationId" = current_setting('app.user_org_id', true)
--
-- withRlsContext() (packages/database/src/rls.ts) now sets app.user_org_id on
-- every transaction, so a user can never see or touch another org's rows. A
-- NULL app.user_org_id (fail-closed) matches nothing.
--
-- Policy NAMES are unchanged so the RLS isolation matrix
-- (packages/database/test/rls-isolation.test.ts) still binds.
-- Runs via DIRECT_DATABASE_URL (owner role, bypasses RLS).
-- ─────────────────────────────────────────────────────────────────────────────

-- Re-assert ROW LEVEL SECURITY (idempotent) on every policy-bearing table.

ALTER TABLE "Activity" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "AuditLog" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "Booking" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "Consent" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "Lead" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "ManagerAssignmentRule" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "Message" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "Notification" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "Project" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "PushNotification" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "PushSubscription" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "Reminder" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "SiteVisit" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "WebhookEvent" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "WhatsappUnknownContact" ENABLE ROW LEVEL SECURITY;

-- ── Drop + recreate every policy org-scoped (identical names) ─────────────

DROP POLICY IF EXISTS lead_select_telecaller ON "Lead";
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

DROP POLICY IF EXISTS lead_select_manager ON "Lead";
CREATE POLICY lead_select_manager ON "Lead"
  FOR SELECT
  USING (
    current_setting('app.user_role', true) = 'MANAGER'
    AND "teamId" = current_setting('app.user_team_id', true)
    AND "organizationId" = current_setting('app.user_org_id', true)
  );

DROP POLICY IF EXISTS lead_select_admin ON "Lead";
CREATE POLICY lead_select_admin ON "Lead"
  FOR SELECT
  USING (
    current_setting('app.user_role', true) = 'ADMIN'
    AND "organizationId" = current_setting('app.user_org_id', true)
  );

DROP POLICY IF EXISTS lead_insert_telecaller ON "Lead";
CREATE POLICY lead_insert_telecaller ON "Lead"
  FOR INSERT
  WITH CHECK (
    current_setting('app.user_role', true) IN ('TELECALLER', 'SALES_EXEC', 'MANAGER', 'ADMIN')
    AND "teamId" = current_setting('app.user_team_id', true)
    AND "organizationId" = current_setting('app.user_org_id', true)
  );

DROP POLICY IF EXISTS lead_insert_admin ON "Lead";
CREATE POLICY lead_insert_admin ON "Lead"
  FOR INSERT
  WITH CHECK (
    current_setting('app.user_role', true) = 'ADMIN'
    AND "organizationId" = current_setting('app.user_org_id', true)
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

DROP POLICY IF EXISTS lead_update_manager ON "Lead";
CREATE POLICY lead_update_manager ON "Lead"
  FOR UPDATE
  USING (
    current_setting('app.user_role', true) = 'MANAGER'
    AND "teamId" = current_setting('app.user_team_id', true)
    AND "organizationId" = current_setting('app.user_org_id', true)
  )
  WITH CHECK (
    current_setting('app.user_role', true) = 'MANAGER'
    AND "teamId" = current_setting('app.user_team_id', true)
    AND "organizationId" = current_setting('app.user_org_id', true)
  );

DROP POLICY IF EXISTS lead_update_admin ON "Lead";
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

DROP POLICY IF EXISTS lead_delete_admin ON "Lead";
CREATE POLICY lead_delete_admin ON "Lead"
  FOR DELETE
  USING (
    current_setting('app.user_role', true) = 'ADMIN'
    AND "organizationId" = current_setting('app.user_org_id', true)
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
    "Activity"."organizationId" = current_setting('app.user_org_id', true)
    AND EXISTS (
      SELECT 1 FROM "Lead" l
      WHERE l.id = "Activity"."leadId"
        AND l."organizationId" = current_setting('app.user_org_id', true)
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
    "SiteVisit"."organizationId" = current_setting('app.user_org_id', true)
    AND EXISTS (
      SELECT 1 FROM "Lead" l
      WHERE l.id = "SiteVisit"."leadId"
        AND l."organizationId" = current_setting('app.user_org_id', true)
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
    "SiteVisit"."organizationId" = current_setting('app.user_org_id', true)
    AND EXISTS (
      SELECT 1 FROM "Lead" l
      WHERE l.id = "SiteVisit"."leadId"
        AND l."organizationId" = current_setting('app.user_org_id', true)
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

DROP POLICY IF EXISTS site_visit_insert_admin ON "SiteVisit";
CREATE POLICY site_visit_insert_admin ON "SiteVisit"
  FOR INSERT
  WITH CHECK (
    current_setting('app.user_role', true) = 'ADMIN'
    AND "organizationId" = current_setting('app.user_org_id', true)
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
    "Message"."organizationId" = current_setting('app.user_org_id', true)
    AND EXISTS (
      SELECT 1 FROM "Lead" l
      WHERE l.id = "Message"."leadId"
        AND l."organizationId" = current_setting('app.user_org_id', true)
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

DROP POLICY IF EXISTS message_insert_admin ON "Message";
CREATE POLICY message_insert_admin ON "Message"
  FOR INSERT
  WITH CHECK (
    current_setting('app.user_role', true) = 'ADMIN'
    AND "organizationId" = current_setting('app.user_org_id', true)
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
    "Booking"."organizationId" = current_setting('app.user_org_id', true)
    AND EXISTS (
      SELECT 1 FROM "Lead" l
      WHERE l.id = "Booking"."leadId"
        AND l."organizationId" = current_setting('app.user_org_id', true)
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
    "Booking"."organizationId" = current_setting('app.user_org_id', true)
    AND EXISTS (
      SELECT 1 FROM "Lead" l
      WHERE l.id = "Booking"."leadId"
        AND l."organizationId" = current_setting('app.user_org_id', true)
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

DROP POLICY IF EXISTS booking_write_admin ON "Booking";
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

DROP POLICY IF EXISTS reminder_select_owner ON "Reminder";
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

DROP POLICY IF EXISTS reminder_write_owner ON "Reminder";
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

DROP POLICY IF EXISTS reminder_cron_service ON "Reminder";
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

DROP POLICY IF EXISTS notification_select_owner ON "Notification";
CREATE POLICY notification_select_owner ON "Notification"
  FOR SELECT
  USING (
    "organizationId" = current_setting('app.user_org_id', true)
    AND "userId" = current_setting('app.user_id', true)
  );

DROP POLICY IF EXISTS notification_update_owner ON "Notification";
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

DROP POLICY IF EXISTS notification_delete_owner ON "Notification";
CREATE POLICY notification_delete_owner ON "Notification"
  FOR DELETE
  USING (
    "organizationId" = current_setting('app.user_org_id', true)
    AND "userId" = current_setting('app.user_id', true)
  );

DROP POLICY IF EXISTS notification_insert_owner ON "Notification";
CREATE POLICY notification_insert_owner ON "Notification"
  FOR INSERT
  WITH CHECK (
    "organizationId" = current_setting('app.user_org_id', true)
    AND "userId" = current_setting('app.user_id', true)
  );

DROP POLICY IF EXISTS push_subscription_select_owner ON "PushSubscription";
CREATE POLICY push_subscription_select_owner ON "PushSubscription"
  FOR SELECT
  USING (
    "organizationId" = current_setting('app.user_org_id', true)
    AND "userId" = current_setting('app.user_id', true)
  );

DROP POLICY IF EXISTS push_subscription_insert_owner ON "PushSubscription";
CREATE POLICY push_subscription_insert_owner ON "PushSubscription"
  FOR INSERT
  WITH CHECK (
    "organizationId" = current_setting('app.user_org_id', true)
    AND "userId" = current_setting('app.user_id', true)
  );

DROP POLICY IF EXISTS push_subscription_update_owner ON "PushSubscription";
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

DROP POLICY IF EXISTS push_subscription_delete_owner ON "PushSubscription";
CREATE POLICY push_subscription_delete_owner ON "PushSubscription"
  FOR DELETE
  USING (
    "organizationId" = current_setting('app.user_org_id', true)
    AND "userId" = current_setting('app.user_id', true)
  );

DROP POLICY IF EXISTS push_notification_select_owner ON "PushNotification";
CREATE POLICY push_notification_select_owner ON "PushNotification"
  FOR SELECT
  USING (
    "organizationId" = current_setting('app.user_org_id', true)
    AND "userId" = current_setting('app.user_id', true)
  );

DROP POLICY IF EXISTS push_notification_insert_owner ON "PushNotification";
CREATE POLICY push_notification_insert_owner ON "PushNotification"
  FOR INSERT
  WITH CHECK (
    "organizationId" = current_setting('app.user_org_id', true)
    AND "userId" = current_setting('app.user_id', true)
  );

DROP POLICY IF EXISTS auditlog_select_admin_or_owner ON "AuditLog";
CREATE POLICY auditlog_select_admin_or_owner ON "AuditLog"
  FOR SELECT
  USING (
    "organizationId" = current_setting('app.user_org_id', true)
    AND (
      current_setting('app.user_role', true) = 'ADMIN'
      OR "userId" = current_setting('app.user_id', true)
    )
  );

DROP POLICY IF EXISTS auditlog_insert_any_authenticated ON "AuditLog";
CREATE POLICY auditlog_insert_any_authenticated ON "AuditLog"
  FOR INSERT
  WITH CHECK (
    current_setting('app.user_id', true) IS NOT NULL
    AND "organizationId" = current_setting('app.user_org_id', true)
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
            (current_setting('app.user_role', true) = 'MANAGER'
             AND l."teamId" = current_setting('app.user_team_id', true))
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

DROP POLICY IF EXISTS managerassignmentrule_select_team ON "ManagerAssignmentRule";
CREATE POLICY managerassignmentrule_select_team ON "ManagerAssignmentRule"
  FOR SELECT
  USING (
    "organizationId" = current_setting('app.user_org_id', true)
    AND (
      (
        current_setting('app.user_role', true) = 'MANAGER'
        AND "teamId" = current_setting('app.user_team_id', true)
      )
      OR current_setting('app.user_role', true) IN ('ADMIN', 'OWNER')
    )
  );

DROP POLICY IF EXISTS webhook_cron_service_all ON "WebhookEvent";
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

DROP POLICY IF EXISTS webhook_select_admin ON "WebhookEvent";
CREATE POLICY webhook_select_admin ON "WebhookEvent"
  FOR SELECT
  USING (
    current_setting('app.user_role', true) = 'ADMIN'
    AND "organizationId" = current_setting('app.user_org_id', true)
  );

DROP POLICY IF EXISTS webhook_update_admin ON "WebhookEvent";
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

DROP POLICY IF EXISTS wa_unknown_cron_service_all ON "WhatsappUnknownContact";
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

DROP POLICY IF EXISTS wa_unknown_select_admin_class ON "WhatsappUnknownContact";
CREATE POLICY wa_unknown_select_admin_class ON "WhatsappUnknownContact"
  FOR SELECT
  USING (
    current_setting('app.user_role', true) IN ('ADMIN', 'OWNER', 'MANAGER')
    AND ("organizationId" IS NULL OR "organizationId" = current_setting('app.user_org_id', true))
  );

DROP POLICY IF EXISTS wa_unknown_update_admin_class ON "WhatsappUnknownContact";
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

DROP POLICY IF EXISTS wa_unknown_insert_admin_class ON "WhatsappUnknownContact";
CREATE POLICY wa_unknown_insert_admin_class ON "WhatsappUnknownContact"
  FOR INSERT
  WITH CHECK (
    current_setting('app.user_role', true) IN ('ADMIN', 'OWNER', 'MANAGER')
    AND ("organizationId" IS NULL OR "organizationId" = current_setting('app.user_org_id', true))
  );

DROP POLICY IF EXISTS outbound_cron_service_select ON "OutboundMessage";
CREATE POLICY outbound_cron_service_select ON "OutboundMessage"
  FOR SELECT
  USING (
    current_setting('app.user_role', true) = 'CRON_SERVICE'
    AND "organizationId" = current_setting('app.user_org_id', true)
  );

DROP POLICY IF EXISTS outbound_cron_service_insert ON "OutboundMessage";
CREATE POLICY outbound_cron_service_insert ON "OutboundMessage"
  FOR INSERT
  WITH CHECK (
    current_setting('app.user_role', true) = 'CRON_SERVICE'
    AND "organizationId" = current_setting('app.user_org_id', true)
  );

DROP POLICY IF EXISTS message_insert_cron_service ON "Message";
CREATE POLICY message_insert_cron_service ON "Message"
  FOR INSERT
  WITH CHECK (
    current_setting('app.user_role', true) = 'CRON_SERVICE'
    AND "organizationId" = current_setting('app.user_org_id', true)
  );

DROP POLICY IF EXISTS message_delete_admin_or_cron ON "Message";
CREATE POLICY message_delete_admin_or_cron ON "Message"
  FOR DELETE
  USING (
    (
      current_setting('app.user_role', true) = 'ADMIN'
      OR current_setting('app.user_role', true) = 'CRON_SERVICE'
    )
    AND "organizationId" = current_setting('app.user_org_id', true)
  );

DROP POLICY IF EXISTS outbound_update_cron_service ON "OutboundMessage";
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

DROP POLICY IF EXISTS lead_select_cron_service ON "Lead";
CREATE POLICY lead_select_cron_service ON "Lead"
  FOR SELECT
  USING (
    current_setting('app.user_role', true) = 'CRON_SERVICE'
    AND "organizationId" = current_setting('app.user_org_id', true)
  );

DROP POLICY IF EXISTS project_select_any_authenticated ON "Project";
CREATE POLICY project_select_any_authenticated ON "Project"
  FOR SELECT
  USING (
    current_setting('app.user_role', true) IN
      ('ADMIN', 'MANAGER', 'TELECALLER', 'SALES_EXEC', 'CRON_SERVICE')
    AND "organizationId" = current_setting('app.user_org_id', true)
  );

DROP POLICY IF EXISTS project_insert_admin ON "Project";
CREATE POLICY project_insert_admin ON "Project"
  FOR INSERT
  WITH CHECK (
    current_setting('app.user_role', true) = 'ADMIN'
    AND "organizationId" = current_setting('app.user_org_id', true)
  );

DROP POLICY IF EXISTS project_update_admin ON "Project";
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

DROP POLICY IF EXISTS project_delete_admin ON "Project";
CREATE POLICY project_delete_admin ON "Project"
  FOR DELETE
  USING (
    current_setting('app.user_role', true) = 'ADMIN'
    AND "organizationId" = current_setting('app.user_org_id', true)
  );
