-- T-WA-VISIT-REPLY (2026-11-28): the cron service account must be able to read
-- the audit rows it writes.
--
-- AuditLog's INSERT policy (auditlog_insert_any_authenticated) lets CRON_SERVICE
-- insert - and the insert FAILS anyway with 42501 "new row violates row-level
-- security policy" whenever the writer asks for the row back, because RETURNING
-- is evaluated against the SELECT policy and auditlog_select_admin_or_owner
-- admits only ADMIN or the row's own userId. Prisma's typed `auditLog.create()`
-- always returns the row, so every system-actor audit write (a webhook confirming
-- a visit, a state transition driven by a customer reply) was refused while a
-- plain INSERT without RETURNING succeeded.
--
-- This mirrors lead_select_cron_service: org-scoped, and gated on BOTH
-- app.user_role='CRON_SERVICE' AND app.user_id='cron-service' so a staff user
-- cannot borrow the service account's visibility by setting only the role GUC.
CREATE POLICY "auditlog_select_cron_service" ON "AuditLog"
  FOR SELECT
  USING (
    current_setting('app.user_role', true) = 'CRON_SERVICE'
    AND current_setting('app.user_id', true) = 'cron-service'
    AND "organizationId" = current_setting('app.user_org_id', true)
  );
