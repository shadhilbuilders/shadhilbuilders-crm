-- T-VISIT-REMINDER (2026-10-09): reminder sent before a scheduled visit.
--   Organization.visitReminderLeadMinutes  per-org lead time (default 60, 5..1440)
--   SiteVisit.reminderSentAt               durable once-only stamp
-- plus CRON_SERVICE read/narrow-update policies on SiteVisit and an
-- ADMIN/OWNER update policy on Organization (settings endpoint).

ALTER TABLE "Organization"
  ADD COLUMN "visitReminderLeadMinutes" INTEGER NOT NULL DEFAULT 60,
  ADD CONSTRAINT "Organization_visitReminderLeadMinutes_range"
    CHECK ("visitReminderLeadMinutes" BETWEEN 5 AND 1440);

ALTER TABLE "SiteVisit" ADD COLUMN "reminderSentAt" TIMESTAMP(3);

-- The reminder cron's scan: only unreminded, still-open visits.
CREATE INDEX "SiteVisit_reminder_due_idx"
  ON "SiteVisit" ("scheduledFor")
  WHERE "reminderSentAt" IS NULL AND "status" = 'SCHEDULED';

-- CRON_SERVICE: org-scoped read, and an UPDATE the cron uses only to stamp
-- reminderSentAt (column privilege is not narrowed here; the service only ever
-- writes that column).
CREATE POLICY "site_visit_select_cron_service" ON "SiteVisit" FOR SELECT
  USING (
    current_setting('app.user_role', true) = 'CRON_SERVICE'
    AND current_setting('app.user_id', true) = 'cron-service'
    AND "organizationId" = current_setting('app.user_org_id', true)
  );

CREATE POLICY "site_visit_update_cron_service" ON "SiteVisit" FOR UPDATE
  USING (
    current_setting('app.user_role', true) = 'CRON_SERVICE'
    AND current_setting('app.user_id', true) = 'cron-service'
    AND "organizationId" = current_setting('app.user_org_id', true)
  )
  WITH CHECK (
    current_setting('app.user_role', true) = 'CRON_SERVICE'
    AND current_setting('app.user_id', true) = 'cron-service'
    AND "organizationId" = current_setting('app.user_org_id', true)
  );

CREATE POLICY "org_update_admin" ON "Organization" FOR UPDATE
  USING (
    "id" = current_setting('app.user_org_id', true)
    AND current_setting('app.user_role', true) IN ('ADMIN', 'OWNER')
  )
  WITH CHECK (
    "id" = current_setting('app.user_org_id', true)
    AND current_setting('app.user_role', true) IN ('ADMIN', 'OWNER')
  );
