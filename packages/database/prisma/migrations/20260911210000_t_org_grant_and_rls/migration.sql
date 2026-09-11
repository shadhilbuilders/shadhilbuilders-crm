-- T-ORG-FIX (2026-09-11): the Organization table was created by the
-- org-multitenancy migration WITHOUT grants for shadhil_app and WITHOUT RLS —
-- so the app role could not read it (42501 permission denied) and the root
-- page's getOrganizationBySlug / GET /organizations hung forever.
--
-- This migration grants shadhil_app access, enables FORCE RLS, and adds the
-- org-scoped OWN/CRON policies (canonical copy in rls/policies.sql).

GRANT SELECT, INSERT, UPDATE, DELETE ON "Organization" TO shadhil_app;

ALTER TABLE "Organization" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "Organization" FORCE ROW LEVEL SECURITY;

CREATE POLICY org_select_own ON "Organization"
  FOR SELECT
  USING (
    "id" = current_setting('app.user_org_id', true)
  );

CREATE POLICY org_cron_service_all ON "Organization"
  FOR ALL
  USING (
    current_setting('app.user_role', true) = 'CRON_SERVICE'
    AND "id" = current_setting('app.user_org_id', true)
  )
  WITH CHECK (
    current_setting('app.user_role', true) = 'CRON_SERVICE'
    AND "id" = current_setting('app.user_org_id', true)
  );
