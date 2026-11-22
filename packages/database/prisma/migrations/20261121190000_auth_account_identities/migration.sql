-- Phone sign-in: the organisation names the account picker needs (2026-11-21).
--
-- WHY A SECURITY DEFINER HELPER. The login resolver finds candidate accounts by
-- phone on the bare client (the User table is pre-RLS, like every auth table),
-- then needs each candidate's organisation to render "which account?". That read
-- hits "Organization", which IS row-level-security scoped to app.user_org_id
-- (packages/database/prisma/rls/policies.sql). An unauthenticated request sets no
-- such GUC, so it reads nothing and the picker would be empty for exactly the
-- person who needs it.
--
-- WHY IT TAKES THE PHONE TOO. A helper that answered "give me the organisation
-- for these user ids" would be an organisation lookup for anyone who could guess
-- or harvest ids. Requiring the stored phone to equal the argument means the
-- caller must already hold the number, and the rows returned are accounts the
-- caller has just proven something about. There is no role check because there
-- is no session at all: this runs before anyone is signed in.
--
-- WHAT IT DOES NOT RETURN: any name, email, password hash or phone. Only what the
-- picker renders - the organisation's display name and slug, keyed by user id.
CREATE OR REPLACE FUNCTION auth_account_identities(p_user_ids TEXT[], p_phone TEXT)
RETURNS TABLE (user_id TEXT, organization_name TEXT, organization_slug TEXT)
LANGUAGE sql
SECURITY DEFINER
SET search_path = public
STABLE
AS $$
  SELECT u."id", o."name", o."slug"
  FROM "User" u
  JOIN "Organization" o ON o."id" = u."organizationId"
  WHERE u."id" = ANY (p_user_ids)
    AND u."phone" = p_phone
    AND u."deletedAt" IS NULL;
$$;

-- Owner-only execution for the application role. PUBLIC is revoked first so a
-- future role cannot inherit it by accident.
REVOKE ALL ON FUNCTION auth_account_identities(TEXT[], TEXT) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION auth_account_identities(TEXT[], TEXT) TO shadhil_app;
