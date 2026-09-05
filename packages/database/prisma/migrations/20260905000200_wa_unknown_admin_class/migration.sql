-- T-E2b follow-up (2026-09-05): broaden the WhatsappUnknownContact
-- admin policies from ADMIN-only to admin-class (ADMIN, OWNER, MANAGER).
--
-- The T-E2b inbound commit (20260905000100) created admin-only
-- policies because the plan at the time didn't have an admin UI for
-- the follow-up queue. Now that the admin page ships (Week 7 work
-- following the user's approval), MANAGERs need read+update too
-- so they can work the queue from the team-management perspective.
--
-- The WhatsappUnknownContact table has no teamId column — the queue
-- is company-wide, not per-team — so the policy is just role-based.
-- TELECALLERs do not see this queue; they see the result of a
-- conversion on the existing Leads page (the manager routes via
-- the ManagerAssignmentRule engine after the manual call).
--
-- Drops the old admin-only policies, then recreates them as
-- admin-class.
DROP POLICY IF EXISTS wa_unknown_select_admin ON "WhatsappUnknownContact";
DROP POLICY IF EXISTS wa_unknown_update_admin ON "WhatsappUnknownContact";

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
