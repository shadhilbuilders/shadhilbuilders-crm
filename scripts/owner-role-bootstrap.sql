-- Owner-role bootstrap: W1 to W3 of docs/planning/OWNER-ROLE-MIGRATION.md.
--
-- Run this AS THE BOOTSTRAP SUPERUSER, never from the app and never through prisma:
--
--   ssh <vps> "docker exec -i shadhil-postgres psql -U shadhil -d shadhil_crm \
--     -v owner_password='...' -v seed_password='...'" < scripts/owner-role-bootstrap.sql
--
-- It exists as a script rather than a migration for one measured reason: after this
-- runs, `prisma migrate deploy` connects as shadhil_owner, and a non-superuser owner
-- cannot `ALTER FUNCTION ... OWNER TO` or reassign anything ("must be owner of
-- function"), so the step that CREATES the owner cannot also be run by it.
--
-- Idempotent: a second run changes nothing and reports the same counts.
--
-- What it does not do: revoke LOGIN from `shadhil` (H4), rotate its password, or touch
-- pg_hba. Those are separate work with their own rollback.
\set ON_ERROR_STOP on

-- Preflight: refuse to run from the wrong URL. A half-applied ownership move is much
-- worse than a refusal, and the failure mode without this is that someone runs it as
-- shadhil_owner and gets a stream of "must be owner" errors halfway through.
DO $$
BEGIN
  IF current_user <> 'shadhil' THEN
    RAISE EXCEPTION
      'run this as the bootstrap superuser (shadhil), not %; nothing was changed',
      current_user;
  END IF;
END $$;

-- W1. Roles. CREATE is guarded, ALTER is unconditional so attributes converge even on a
-- second run or a hand-edited role.
SELECT format('CREATE ROLE %I', r) FROM unnest(ARRAY['shadhil_owner','shadhil_rls','shadhil_seed']) r
WHERE NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = r)
\gexec

SELECT format('ALTER ROLE %I WITH LOGIN NOSUPERUSER NOBYPASSRLS CREATEDB PASSWORD %L',
              'shadhil_owner', :'owner_password')
\gexec

-- NOLOGIN on purpose: this role is a function owner, not a credential. Nothing is
-- gained by making it reachable, and a password would make it one more thing to rotate.
SELECT format('ALTER ROLE %I WITH NOLOGIN NOSUPERUSER BYPASSRLS CREATEDB', 'shadhil_rls')
\gexec

-- The seed writes across every table including role-shaped policies, so it needs the
-- bypass (H2). A login, because `pnpm seed` connects with it.
SELECT format('ALTER ROLE %I WITH LOGIN NOSUPERUSER BYPASSRLS NOCREATEDB PASSWORD %L',
              'shadhil_seed', :'seed_password')
\gexec

-- PG16 grants USAGE on public to PUBLIC but not CREATE, and this cluster's public schema
-- carries an explicit ACL anyway. Without CREATE the first migration fails with
-- "permission denied for schema public", which reads like a missing table.
GRANT USAGE, CREATE ON SCHEMA public TO shadhil_owner;
GRANT USAGE ON SCHEMA public TO shadhil_rls;
-- The seed writes every table, so it needs the privileges as well as the bypass:
-- BYPASSRLS skips policies, not GRANTs. Measured 2026-11-28: without this the seed dies
-- on its first upsert with `42501 permission denied for schema public`.
GRANT USAGE, CREATE ON SCHEMA public TO shadhil_seed;

-- The owner may become the seed role. Measured 2026-11-28: a non-bypass owner can create
-- a table, ENABLE and FORCE RLS and add a policy, but an INSERT into that FORCEd table
-- fails outright ("new row violates row-level security policy") and an UPDATE silently
-- touches zero rows. Nine historical migrations contain INSERT and 17 contain UPDATE, and
-- editing applied migrations is forbidden while a production database exists, so a
-- migration that needs to touch rows must borrow the bypass explicitly:
--
--   SET LOCAL ROLE shadhil_seed;
--
-- That membership is what makes the line work. Fresh installs migrate as the bootstrap
-- superuser and hand over afterwards, so the history replays untouched.
GRANT shadhil_seed TO shadhil_owner;

-- W2. The 19 SECURITY DEFINER helpers move to the bypass role. Measured trap: if they
-- stay owned by a non-bypass owner they do not fail, they silently start answering with
-- the caller's own visibility, which is exactly what project_unit_ids exists to avoid.
SELECT format('ALTER FUNCTION public.%I(%s) OWNER TO shadhil_rls',
              p.proname, pg_get_function_identity_arguments(p.oid))
FROM pg_proc p
JOIN pg_namespace n ON n.oid = p.pronamespace
WHERE n.nspname = 'public' AND p.prosecdef
  AND NOT EXISTS (SELECT 1 FROM pg_depend d WHERE d.objid = p.oid AND d.deptype = 'e')
\gexec

-- PUBLIC executes every function by default. Revoke on the helpers only, then re-assert
-- the one grant that matters: the app role, explicitly.
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

-- The definer role needs table privileges of its own: BYPASSRLS skips policies, not
-- GRANTs. Deliberately broad rather than derived from each body, because a narrow grant
-- fails at RUNTIME with 42501 only on the code path that hits the missing table, and the
-- role cannot log in, so it is reachable only through the helpers.
GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public TO shadhil_rls;
GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public TO shadhil_seed;
GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA public TO shadhil_rls;
GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA public TO shadhil_seed;
-- Future tables: after this script the migrations create them as shadhil_owner, so
-- without this line every new table is invisible to the helpers.
ALTER DEFAULT PRIVILEGES FOR ROLE shadhil_owner IN SCHEMA public
  GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO shadhil_rls;
ALTER DEFAULT PRIVILEGES FOR ROLE shadhil_owner IN SCHEMA public
  GRANT USAGE, SELECT ON SEQUENCES TO shadhil_rls;
ALTER DEFAULT PRIVILEGES FOR ROLE shadhil_owner IN SCHEMA public
  GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO shadhil_seed;
ALTER DEFAULT PRIVILEGES FOR ROLE shadhil_owner IN SCHEMA public
  GRANT USAGE, SELECT ON SEQUENCES TO shadhil_seed;

-- W3. Ownership walk. `REASSIGN OWNED BY shadhil TO shadhil_owner` aborts because shadhil
-- owns the plpgsql extension ("objects required by the database system"), and it is
-- atomic, so nothing moves. Walk the catalogue instead and skip extension members.
SELECT format('ALTER TABLE public.%I OWNER TO shadhil_owner', c.relname)
FROM pg_class c
JOIN pg_namespace n ON n.oid = c.relnamespace
WHERE n.nspname = 'public' AND c.relkind IN ('r','p')
  AND pg_get_userbyid(c.relowner) = 'shadhil'
  AND NOT EXISTS (SELECT 1 FROM pg_depend d WHERE d.objid = c.oid AND d.deptype = 'e')
\gexec

SELECT format('ALTER VIEW public.%I OWNER TO shadhil_owner', c.relname)
FROM pg_class c
JOIN pg_namespace n ON n.oid = c.relnamespace
WHERE n.nspname = 'public' AND c.relkind IN ('v','m')
  AND pg_get_userbyid(c.relowner) = 'shadhil'
  AND NOT EXISTS (SELECT 1 FROM pg_depend d WHERE d.objid = c.oid AND d.deptype = 'e')
\gexec

SELECT format('ALTER SEQUENCE public.%I OWNER TO shadhil_owner', c.relname)
FROM pg_class c
JOIN pg_namespace n ON n.oid = c.relnamespace
WHERE n.nspname = 'public' AND c.relkind = 'S'
  AND pg_get_userbyid(c.relowner) = 'shadhil'
  AND NOT EXISTS (SELECT 1 FROM pg_depend d WHERE d.objid = c.oid AND d.deptype = 'e')
\gexec

-- Types: enums, domains, and standalone composites. A table's row type moves with the
-- table, so it is already shadhil_owner by the time this runs.
SELECT format('ALTER TYPE public.%I OWNER TO shadhil_owner', t.typname)
FROM pg_type t
JOIN pg_namespace n ON n.oid = t.typnamespace
WHERE n.nspname = 'public' AND t.typtype IN ('e','d','c')
  AND pg_get_userbyid(t.typowner) = 'shadhil'
  AND NOT EXISTS (SELECT 1 FROM pg_depend d WHERE d.objid = t.oid AND d.deptype = 'e')
  AND NOT EXISTS (SELECT 1 FROM pg_class c WHERE c.reltype = t.oid)
\gexec

-- Functions that are not helpers: ordinary and trigger functions the migrations created.
SELECT format('ALTER FUNCTION public.%I(%s) OWNER TO shadhil_owner',
              p.proname, pg_get_function_identity_arguments(p.oid))
FROM pg_proc p
JOIN pg_namespace n ON n.oid = p.pronamespace
WHERE n.nspname = 'public' AND NOT p.prosecdef AND p.prokind = 'f'
  AND pg_get_userbyid(p.proowner) = 'shadhil'
  AND NOT EXISTS (SELECT 1 FROM pg_depend d WHERE d.objid = p.oid AND d.deptype = 'e')
\gexec

ALTER SCHEMA public OWNER TO shadhil_owner;
SELECT format('ALTER DATABASE %I OWNER TO shadhil_owner', current_database())
\gexec

-- Report, so the caller can see the move happened and a second run is a no-op.
SELECT
  (SELECT count(*) FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
     WHERE n.nspname = 'public' AND pg_get_userbyid(c.relowner) = 'shadhil') AS objects_still_owned_by_shadhil,
  (SELECT count(*) FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
     WHERE n.nspname = 'public' AND p.prosecdef
       AND pg_get_userbyid(p.proowner) = 'shadhil_rls') AS helpers_owned_by_rls,
  (SELECT count(*) FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
     WHERE n.nspname = 'public' AND p.prosecdef) AS helpers_total,
  (SELECT pg_get_userbyid(nspowner) FROM pg_namespace WHERE nspname = 'public') AS public_schema_owner;
