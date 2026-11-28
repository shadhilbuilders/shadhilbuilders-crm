-- T-WA-VISIT-REPLY (2026-11-28): system actions get a timeline row.
--
-- The customer replying YES on WhatsApp is a fact about the lead that a
-- telecaller reads on the timeline, but no staff member performed it and no
-- staff member should be credited. So Activity.userId becomes nullable (NULL =
-- the system wrote this row) and CRON_SERVICE gains a narrow INSERT policy.
--
-- Both halves are needed: without the policy the webhook's insert is refused
-- (Activity had only team/admin insert arms, both of which need a staff actor),
-- and without the nullable column the only way to satisfy them would be to name
-- a real user who did not do it.
ALTER TABLE "Activity" ALTER COLUMN "userId" DROP NOT NULL;

-- Org-scoped, and gated on BOTH GUCs so a staff user cannot borrow the service
-- account by setting only app.user_role (the impersonation guard the other
-- cron policies use).
CREATE POLICY "activity_insert_cron_service" ON "Activity"
  FOR INSERT
  WITH CHECK (
    current_setting('app.user_role', true) = 'CRON_SERVICE'
    AND current_setting('app.user_id', true) = 'cron-service'
    AND "organizationId" = current_setting('app.user_org_id', true)
  );
