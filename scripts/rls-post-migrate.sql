-- RLS post-migrate: W4(b) of docs/planning/OWNER-ROLE-MIGRATION.md.
--
-- Run AFTER `prisma migrate deploy`, as the bootstrap superuser, on every install
-- including a fresh one:
--
--   docker exec -i shadhil-postgres psql -U shadhil -d shadhil_crm < scripts/rls-post-migrate.sql
--
-- Why it exists: migration 1 creates the SECURITY DEFINER helpers via policies.sql, so on
-- a fresh database they are owned by whoever ran the migration. After the cutover that is
-- shadhil_owner, which does NOT bypass RLS, and a helper owned by a non-bypass role does
-- not fail: it silently answers with the caller's own visibility. That is the exact
-- failure this migration exists to prevent, so the re-assert has to run where a fresh
-- install cannot forget it.
\set ON_ERROR_STOP on

DO $$
BEGIN
  IF current_user <> 'shadhil' THEN
    RAISE EXCEPTION 'run this as the bootstrap superuser (shadhil), not %', current_user;
  END IF;
END $$;

SELECT format('ALTER FUNCTION public.%I(%s) OWNER TO shadhil_rls',
              p.proname, pg_get_function_identity_arguments(p.oid))
FROM pg_proc p
JOIN pg_namespace n ON n.oid = p.pronamespace
WHERE n.nspname = 'public' AND p.prosecdef
  AND NOT EXISTS (SELECT 1 FROM pg_depend d WHERE d.objid = p.oid AND d.deptype = 'e')
\gexec

SELECT format('REVOKE ALL ON FUNCTION public.%I(%s) FROM PUBLIC',
              p.proname, pg_get_function_identity_arguments(p.oid))
FROM pg_proc p
JOIN pg_namespace n ON n.oid = p.pronamespace
WHERE n.nspname = 'public' AND p.prosecdef
  AND NOT EXISTS (SELECT 1 FROM pg_depend d WHERE d.objid = p.oid AND d.deptype = 'e')
\gexec

-- Three roles, not one: every role that may run a query against a FORCEd table evaluates
-- its policies, and a policy calls these helpers, so the EXECUTE check happens as the
-- CALLER. Revoking PUBLIC without granting the callers back fails every policy in the
-- database with `42501 permission denied for function ...`.
SELECT format('GRANT EXECUTE ON FUNCTION public.%I(%s) TO shadhil_app, shadhil_owner, shadhil_seed',
              p.proname, pg_get_function_identity_arguments(p.oid))
FROM pg_proc p
JOIN pg_namespace n ON n.oid = p.pronamespace
WHERE n.nspname = 'public' AND p.prosecdef
  AND NOT EXISTS (SELECT 1 FROM pg_depend d WHERE d.objid = p.oid AND d.deptype = 'e')
\gexec

-- A migration may have created a table after the default privileges were set, or the
-- database may predate them. Re-assert rather than assume.
GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public TO shadhil_rls;
GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA public TO shadhil_rls;

SELECT
  (SELECT count(*) FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
     WHERE n.nspname = 'public' AND p.prosecdef
       AND pg_get_userbyid(p.proowner) = 'shadhil_rls') AS helpers_owned_by_rls,
  (SELECT count(*) FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
     WHERE n.nspname = 'public' AND p.prosecdef) AS helpers_total;
