-- T-CRONS (Sunday 2026-09-07 demo sprint): close the reminder cron RLS gap.
--
-- Symptom (Day 5 T-G4): after the reminder cron shipped with
-- Redis-lock + status-claim idempotency, the unit test exercised the
-- lease + status-claim logic correctly but in production every tick's
-- updateMany(SCHEDULED → PROCESSING) returned 0 rows. Root cause: the
-- `reminder_write_owner` policy (FOR ALL USING/WITH CHECK
-- userId = app.user_id) blocked any actor whose userId didn't match
-- the row's userId — including the service-account cron actor with
-- userId='cron-service'.
--
-- Fix: add a parallel `reminder_cron_service` policy that allows the
-- cron actor (role=CRON_SERVICE AND userId='cron-service') to claim
-- any row regardless of owner. PostgreSQL OR's overlapping FOR ALL
-- policies, so the owner check is still enforced for every real user
-- role — only the canonical cron service-account pair bypasses it.
--
-- Impersonation guard: the CRON_SERVICE branch requires BOTH
-- app.user_role='CRON_SERVICE' AND app.user_id='cron-service'. A user
-- who somehow sets app.user_role='CRON_SERVICE' but uses their own
-- userId cannot satisfy this AND clause, so they fall through to the
-- OR'd owner check and the bypass is denied. The cron is the only
-- legitimate caller of withRlsContext with role='CRON_SERVICE' (see
-- reminders.service.ts:tick), so userId='cron-service' is the
-- canonical service-account sentinel. The 129th RLS matrix case
-- pins this behavior end-to-end against a real DB.
--
-- Alternative considered (rejected): split `shadhil_app_cron` role with
-- BYPASSRLS — wider blast radius and breaks the 128-case matrix for
-- every read. Per postgres-multi-role-grants.md, option 2 (explicit
-- service-account policy) is the minimum-blast-radius fix.

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
