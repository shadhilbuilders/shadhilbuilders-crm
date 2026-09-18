-- T-OVERDUE-ALERTS (2026-09-18): track when the overdue-alert cron last pushed
-- a reminder for a lead, so it only re-nags every 1 hour (not every minute).
-- NULL = never nagged yet; the cron pushes leads where lastOverduePushedAt is
-- older than 1h (or NULL). Mirrors schema.prisma (Lead).

ALTER TABLE "Lead"
  ADD COLUMN "lastOverduePushedAt" TIMESTAMP(3);

-- The overdue-alert cron updates Lead.lastOverduePushedAt for NEW + overdue
-- leads. lead_select_cron_service (from t_org_rls_policies) grants SELECT;
-- without this UPDATE bypass the cron's update() returns zero rows. Same
-- impersonation guard as the reminder cron policy (role=CRON_SERVICE AND
-- user_id='cron-service'). Mirrors lead_update_cron_service in
-- prisma/rls/policies.sql (canonical).
CREATE POLICY lead_update_cron_service ON "Lead"
  FOR UPDATE
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
