-- T-ORG-OWNER (2026-09-17): self-signup creates a brand-new org whose
-- creator becomes its OWNER.
--
-- 1. `Organization.createdBy` records the signup user who created the org.
--    Nullable: the seeded bootstrap org predates the field. Set once on
--    user.create; never mutated afterward. The OWNER role (not this column)
--    is what actually grants access, so this is provenance, not authority.
--
-- 2. RLS INSERT policy. `Organization` is FORCE RLS with only
--    org_select_own (SELECT) + org_cron_service_all. The better-auth
--    signup hook runs on the bare `shadhil_app` client (no GUCs set), so a
--    `prisma.organization.create` would hit `42501 permission denied` with
--    no INSERT policy. There is NO other org-write path in the system (the
--    API never creates orgs - seed + signup are the only creators), so an
--    INSERT-only policy is safe: an inserted row is immediately gated by
--    org_select_own, meaning an empty org is invisible to everyone but its
--    OWNER (whose JWT carries the new org id after sign-in).
--    SELECT stays fully gated; this policy grants INSERT only.
ALTER TABLE "Organization" ADD COLUMN IF NOT EXISTS "createdBy" TEXT;

CREATE POLICY org_insert_public ON "Organization"
  FOR INSERT
  WITH CHECK (true);
