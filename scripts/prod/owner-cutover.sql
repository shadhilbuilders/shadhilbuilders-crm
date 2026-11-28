-- Production cutover for the owner split (docs/planning/OWNER-ROLE-MIGRATION.md, W10).
--
-- Moves every object in `public` off the bootstrap superuser onto three roles that each do
-- one job, then proves the move instead of assuming it. Rehearsed against a restore of the
-- production dump before it is run anywhere real.
--
-- Usage, inside the postgres container:
--   psql -U shadhil -d shadhil_crm -v ON_ERROR_STOP=1 \
--        -v owner_password="$SHADHIL_OWNER_PASSWORD" \
--        -v seed_password="$SHADHIL_SEED_PASSWORD" \
--        -f owner-cutover.sql
--
-- The two passwords arrive as psql variables and are handed to plpgsql through session
-- settings, so they never appear in the server log when log_statement is on.
--
-- Safe to re-run: role creation is conditional, every ownership statement is a no-op when
-- the owner is already correct, and the grants are absolute.

-- 1. Guards -------------------------------------------------------------------
DO $$
BEGIN
  IF current_user <> 'shadhil' THEN
    RAISE EXCEPTION 'run this as the bootstrap superuser (shadhil), not as %', current_user;
  END IF;
  IF current_database() <> 'shadhil_crm' THEN
    RAISE EXCEPTION 'this is the production cutover and the database is %', current_database();
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = current_user AND rolsuper) THEN
    RAISE EXCEPTION 'current_user is not a superuser; the ownership walk needs one';
  END IF;
END
$$;

-- The cutover is the moment a wrong move becomes expensive, so it refuses to run without a
-- fresh dump. `-v backup_seen=yes` is set by the runbook immediately after pg_dump exits 0.
\if :{?backup_seen}
\else
  \echo 'refusing: pass -v backup_seen=yes after pg_dump exits 0'
  \quit
\endif

-- 2. Roles --------------------------------------------------------------------
SELECT set_config('app.cutover_owner_password', :'owner_password', false);
SELECT set_config('app.cutover_seed_password', :'seed_password', false);

DO $$
DECLARE
  owner_pw text := current_setting('app.cutover_owner_password');
  seed_pw text := current_setting('app.cutover_seed_password');
BEGIN
  IF owner_pw IS NULL OR length(owner_pw) < 20 THEN
    RAISE EXCEPTION 'owner password missing or shorter than 20 characters';
  END IF;
  IF seed_pw IS NULL OR length(seed_pw) < 20 THEN
    RAISE EXCEPTION 'seed password missing or shorter than 20 characters';
  END IF;
  IF owner_pw = seed_pw THEN
    RAISE EXCEPTION 'owner and seed passwords are identical';
  END IF;

  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'shadhil_owner') THEN
    EXECUTE format('CREATE ROLE shadhil_owner LOGIN PASSWORD %L NOSUPERUSER NOBYPASSRLS CREATEDB NOCREATEROLE', owner_pw);
  ELSE
    EXECUTE format('ALTER ROLE shadhil_owner WITH LOGIN NOSUPERUSER NOBYPASSRLS CREATEDB PASSWORD %L', owner_pw);
  END IF;

  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'shadhil_rls') THEN
    EXECUTE 'CREATE ROLE shadhil_rls NOLOGIN NOSUPERUSER BYPASSRLS';
  ELSE
    EXECUTE 'ALTER ROLE shadhil_rls WITH NOLOGIN NOSUPERUSER BYPASSRLS';
  END IF;

  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'shadhil_seed') THEN
    EXECUTE format('CREATE ROLE shadhil_seed LOGIN PASSWORD %L NOSUPERUSER BYPASSRLS NOCREATEDB NOCREATEROLE', seed_pw);
  ELSE
    EXECUTE format('ALTER ROLE shadhil_seed WITH LOGIN NOSUPERUSER BYPASSRLS PASSWORD %L', seed_pw);
  END IF;
END
$$;

RESET app.cutover_owner_password;
RESET app.cutover_seed_password;

COMMENT ON ROLE shadhil_owner IS 'Shadhil CRM migration owner: owns the tables, NOBYPASSRLS. Used by DIRECT_DATABASE_URL.';
COMMENT ON ROLE shadhil_rls   IS 'Shadhil CRM SECURITY DEFINER owner: BYPASSRLS, no login. Re-asserted by scripts/prod/rls-post-migrate.sql.';
COMMENT ON ROLE shadhil_seed  IS 'Shadhil CRM seed role: BYPASSRLS, login. Only pnpm seed and test fixtures.';

-- 3. Privileges before ownership, so the walk never lands the new owner somewhere it
--    cannot then grant from.
GRANT USAGE, CREATE ON SCHEMA public TO shadhil_owner;
GRANT USAGE ON SCHEMA public TO shadhil_rls;
GRANT USAGE, CREATE ON SCHEMA public TO shadhil_seed;
-- A migration that must touch rows borrows the bypass: `SET LOCAL ROLE shadhil_seed;`.
-- The membership is what makes that line legal.
GRANT shadhil_seed TO shadhil_owner;

GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public TO shadhil_owner;
GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public TO shadhil_rls;
GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public TO shadhil_seed;

GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA public TO shadhil_owner;
GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA public TO shadhil_rls;
GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA public TO shadhil_seed;

-- 3b. Record the ACLs the cutover is about to rewrite --------------------------
-- `ALTER ... OWNER TO` does not merely change the owner: it rewrites the GRANTOR of every
-- existing ACL entry to the new owner. A rollback that re-grants "the usual privileges"
-- therefore restores something that was never there. Measured in the rehearsal: a blanket
-- GRANT on rollback gave shadhil_app DELETE on Feedback, Invite and OutboundMessage, which
-- it had never held, and INSERT/UPDATE/DELETE on _prisma_migrations, which it should never
-- hold. So the cutover records the exact (object, grantee, privileges) set first and the
-- rollback replays it.
CREATE TABLE IF NOT EXISTS public._owner_split_acl (
  relkind text NOT NULL,
  obj     text NOT NULL,
  grantee text NOT NULL,
  privs   text[] NOT NULL
);

TRUNCATE public._owner_split_acl;

INSERT INTO public._owner_split_acl (relkind, obj, grantee, privs)
SELECT c.relkind::text,
       c.relname,
       CASE WHEN x.grantee = 0 THEN 'PUBLIC' ELSE pg_get_userbyid(x.grantee) END,
       array_agg(x.privilege_type ORDER BY x.privilege_type)
  FROM pg_class c
  JOIN pg_namespace n ON n.oid = c.relnamespace
  CROSS JOIN LATERAL aclexplode(c.relacl) AS x
 WHERE n.nspname = 'public' AND c.relkind IN ('r', 'p', 'S')
 GROUP BY 1, 2, 3;

-- 4. Ownership walk -----------------------------------------------------------
-- `REASSIGN OWNED BY` cannot be used: shadhil owns the plpgsql extension's member objects
-- and REASSIGN aborts on them. A catalogue-driven loop with `deptype = 'e'` excluded moves
-- what can be moved and leaves the extension alone.
--
-- Tables first, while the views that depend on them are still owned by the superuser, so
-- no ALTER ... OWNER can fail on a dependency the new owner cannot see.
DO $$
DECLARE
  r record;
BEGIN
  FOR r IN
    SELECT c.relname, c.relkind::text AS kind
      FROM pg_class c
      JOIN pg_namespace n ON n.oid = c.relnamespace
     WHERE n.nspname = 'public'
       AND c.relkind IN ('r', 'p', 'S')
       AND pg_get_userbyid(c.relowner) = 'shadhil'
       AND c.relname <> '_owner_split_acl'
       AND NOT EXISTS (
         SELECT 1 FROM pg_depend d
          WHERE d.objid = c.oid AND d.classid = 'pg_class'::regclass AND d.deptype = 'e'
       )
     ORDER BY c.relkind, c.relname
  LOOP
    EXECUTE format(
      'ALTER %s public.%I OWNER TO shadhil_owner',
      CASE r.kind WHEN 'S' THEN 'SEQUENCE' ELSE 'TABLE' END,
      r.relname
    );
  END LOOP;
END
$$;

DO $$
DECLARE
  r record;
BEGIN
  FOR r IN
    SELECT c.relname, c.relkind::text AS kind
      FROM pg_class c
      JOIN pg_namespace n ON n.oid = c.relnamespace
     WHERE n.nspname = 'public'
       AND c.relkind IN ('v', 'm')
       AND pg_get_userbyid(c.relowner) = 'shadhil'
       AND NOT EXISTS (
         SELECT 1 FROM pg_depend d
          WHERE d.objid = c.oid AND d.classid = 'pg_class'::regclass AND d.deptype = 'e'
       )
  LOOP
    EXECUTE format(
      'ALTER %s public.%I OWNER TO shadhil_owner',
      CASE r.kind WHEN 'm' THEN 'MATERIALIZED VIEW' ELSE 'VIEW' END,
      r.relname
    );
  END LOOP;
END
$$;

-- Types next: an enum owned by the old role cannot be altered by the new one.
DO $$
DECLARE
  r record;
BEGIN
  FOR r IN
    SELECT t.typname
      FROM pg_type t
      JOIN pg_namespace n ON n.oid = t.typnamespace
     WHERE n.nspname = 'public' AND t.typtype IN ('e', 'd')
       AND pg_get_userbyid(t.typowner) = 'shadhil'
       AND NOT EXISTS (
         SELECT 1 FROM pg_depend d
          WHERE d.objid = t.oid AND d.classid = 'pg_type'::regclass AND d.deptype = 'e'
       )
  LOOP
    EXECUTE format('ALTER TYPE public.%I OWNER TO shadhil_owner', r.typname);
  END LOOP;
END
$$;

-- The SECURITY DEFINER helpers go to the bypass role, and only those. Everything else
-- (plpgsql utilities, triggers that are not DEFINER) stays with the owner.
DO $$
DECLARE
  r record;
BEGIN
  FOR r IN
    SELECT p.proname, pg_get_function_identity_arguments(p.oid) AS args, p.prosecdef
      FROM pg_proc p
      JOIN pg_namespace n ON n.oid = p.pronamespace
     WHERE n.nspname = 'public'
       AND pg_get_userbyid(p.proowner) = 'shadhil'
       AND NOT EXISTS (
         SELECT 1 FROM pg_depend d
          WHERE d.objid = p.oid AND d.classid = 'pg_proc'::regclass AND d.deptype = 'e'
       )
  LOOP
    EXECUTE format(
      'ALTER FUNCTION public.%I(%s) OWNER TO %I',
      r.proname, r.args,
      CASE WHEN r.prosecdef THEN 'shadhil_rls' ELSE 'shadhil_owner' END
    );
  END LOOP;
END
$$;

ALTER SCHEMA public OWNER TO shadhil_owner;

DO $$
BEGIN
  EXECUTE format('ALTER DATABASE %I OWNER TO shadhil_owner', current_database());
END
$$;

-- 5. Function EXECUTE for the callers ----------------------------------------
-- Revoking PUBLIC is the point: before this, every role that could reach the schema could
-- call a DEFINER helper. But a role that queries a FORCEd table evaluates its policies, and
-- a policy calls these helpers AS THE CALLER, so the two roles that run queries plus the
-- app are granted back explicitly. Measured on dev: revoking PUBLIC without this fails
-- every policy in the database with `42501 permission denied for function ...`.
DO $$
DECLARE
  r record;
BEGIN
  FOR r IN
    SELECT p.proname, pg_get_function_identity_arguments(p.oid) AS args
      FROM pg_proc p
      JOIN pg_namespace n ON n.oid = p.pronamespace
     WHERE n.nspname = 'public' AND p.prosecdef
  LOOP
    EXECUTE format('REVOKE ALL ON FUNCTION public.%I(%s) FROM PUBLIC', r.proname, r.args);
    EXECUTE format(
      'GRANT EXECUTE ON FUNCTION public.%I(%s) TO shadhil_app, shadhil_owner, shadhil_seed',
      r.proname, r.args
    );
  END LOOP;

  FOR r IN
    SELECT p.proname, pg_get_function_identity_arguments(p.oid) AS args
      FROM pg_proc p
      JOIN pg_namespace n ON n.oid = p.pronamespace
     WHERE n.nspname = 'public' AND NOT p.prosecdef
  LOOP
    EXECUTE format(
      'GRANT EXECUTE ON FUNCTION public.%I(%s) TO shadhil_app, shadhil_owner, shadhil_seed',
      r.proname, r.args
    );
  END LOOP;
END
$$;

-- 6. Future objects -----------------------------------------------------------
ALTER DEFAULT PRIVILEGES FOR ROLE shadhil_owner IN SCHEMA public
  GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO shadhil_rls;
ALTER DEFAULT PRIVILEGES FOR ROLE shadhil_owner IN SCHEMA public
  GRANT USAGE, SELECT ON SEQUENCES TO shadhil_rls;
ALTER DEFAULT PRIVILEGES FOR ROLE shadhil_owner IN SCHEMA public
  GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO shadhil_seed;
ALTER DEFAULT PRIVILEGES FOR ROLE shadhil_owner IN SCHEMA public
  GRANT USAGE, SELECT ON SEQUENCES TO shadhil_seed;
ALTER DEFAULT PRIVILEGES FOR ROLE shadhil_owner IN SCHEMA public
  GRANT EXECUTE ON FUNCTIONS TO shadhil_rls;

-- 7. Prove it -----------------------------------------------------------------
-- A statement that "should be fine" is not evidence. These raise, which means a partial
-- cutover cannot be mistaken for a finished one.
DO $$
DECLARE
  left_behind int;
  helpers_wrong int;
  helpers_total int;
BEGIN
  SELECT count(*) INTO left_behind
    FROM pg_class c
    JOIN pg_namespace n ON n.oid = c.relnamespace
   WHERE n.nspname = 'public' AND pg_get_userbyid(c.relowner) = 'shadhil'
     AND c.relname <> '_owner_split_acl'
     AND c.relkind IN ('r', 'p', 'S', 'v', 'm');
  IF left_behind > 0 THEN
    RAISE EXCEPTION '% relations in public are still owned by shadhil', left_behind;
  END IF;

  SELECT count(*), count(*) FILTER (WHERE pg_get_userbyid(p.proowner) <> 'shadhil_rls')
    INTO helpers_total, helpers_wrong
    FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
   WHERE n.nspname = 'public' AND p.prosecdef;

  IF helpers_total = 0 THEN
    RAISE EXCEPTION 'no SECURITY DEFINER helpers found; refusing to report success';
  END IF;
  IF helpers_wrong > 0 THEN
    RAISE EXCEPTION '% of % SECURITY DEFINER helpers are not owned by shadhil_rls', helpers_wrong, helpers_total;
  END IF;

  RAISE NOTICE 'cutover proven: 0 relations on shadhil, % of % helpers on shadhil_rls',
    helpers_total, helpers_total;
END
$$;

\echo 'Now: flip DIRECT_DATABASE_URL in Coolify to shadhil_owner, recreate the api container,'
\echo 'then run scripts/prod/rls-post-migrate.sql after the next prisma migrate deploy.'
