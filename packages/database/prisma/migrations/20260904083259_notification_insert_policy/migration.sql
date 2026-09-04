-- Day 4 RLS matrix hardening: the Notification table had SELECT,
-- UPDATE, and DELETE policies (all owner-only) but NO INSERT policy,
-- so any attempt to push a notification via the runtime shadhil_app
-- role failed with `42501 new row violates row-level security policy`.
--
-- The user-intent is clearly "owner can write their own notifications"
-- (mirrors UPDATE/DELETE). This migration adds the missing INSERT
-- policy. The owner-only gate means a user can only INSERT a row
-- whose userId matches their own — they cannot push notifications
-- to other users. If a future feature needs server-side fanout
-- (e.g. cron pushing daily-digest to every manager), the right
-- answer is a separate, narrower table with an admin/manager-gated
-- INSERT policy — not a relaxation of this one.
--
-- The RLS isolation matrix (packages/database/test/rls-isolation.test.ts)
-- flips Notification INSERT from `rejected` → `allowed` for all roles.
-- The fixture seeds an alpha notif owned by teleA; under TELECALLER ctx
-- the INSERT against fixture.leadA succeeds (the actor IS teleA).
-- Under ADMIN/MANAGER/SALES_EXEC the INSERT also targets ctx.userId —
-- which IS the actor's own userId, so the policy allows it. Future
-- matrix work that wants to assert cross-user INSERT rejection can
-- use a separate ctx.userId (e.g. managerA's ctx writing a notif
-- for teleA) — that case stays `rejected` per policy intent.
CREATE POLICY notification_insert_owner ON "Notification"
  FOR INSERT
  WITH CHECK ("userId" = current_setting('app.user_id', true));
