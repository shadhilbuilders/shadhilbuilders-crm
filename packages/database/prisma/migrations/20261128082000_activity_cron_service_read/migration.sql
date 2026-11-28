-- T-WA-VISIT-REPLY (2026-11-28): the cron service account reads the timeline
-- rows it writes.
--
-- Same shape of defect as the AuditLog one fixed in
-- 20261128074500_auditlog_cron_service_read, and found the same way: the INSERT
-- policy (activity_insert_cron_service) passes, but the insert still fails 42501
-- because RETURNING is evaluated against the SELECT policy - and
-- activity_select_team resolves visibility from the actor's role and lead
-- ownership, neither of which a CRON_SERVICE actor has. Prisma's typed create()
-- always returns the row, so a system-written timeline row could not be created.
--
-- Org-scoped, gated on BOTH GUCs, mirroring the other cron bypasses.
CREATE POLICY "activity_select_cron_service" ON "Activity"
  FOR SELECT
  USING (
    current_setting('app.user_role', true) = 'CRON_SERVICE'
    AND current_setting('app.user_id', true) = 'cron-service'
    AND "organizationId" = current_setting('app.user_org_id', true)
  );
