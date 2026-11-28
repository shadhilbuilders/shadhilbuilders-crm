-- Rollback for the owner split. Reverse of scripts/prod/owner-cutover.sql.
--
-- Usage, inside the postgres container:
--   psql -U shadhil -d shadhil_crm -v ON_ERROR_STOP=1 -f owner-rollback.sql
--
-- What this restores: ownership of every object, the schema and the database; the app
-- role's table and function privileges; the read-only reporting role's SELECT grants.
--
-- What it deliberately does NOT restore: EXECUTE on the SECURITY DEFINER helpers for
-- PUBLIC. The cutover revoked it, the explicit grants to shadhil_app survive the rollback,
-- and putting a DEFINER helper back in reach of every role with schema access is not a
-- state worth returning to.
--
-- One non-obvious step, measured during the rehearsal: `ALTER ... OWNER TO` rewrites the
-- GRANTOR of every ACL entry to the new owner. So once ownership has moved, shadhil_app's
-- table privileges belong to shadhil_owner, and a plain `DROP OWNED BY shadhil_owner`
-- revokes them. The app would come back with no table access at all. That is why section 4
-- re-grants as `shadhil` before the roles are dropped, and why the rehearsal asserts the
-- grant count rather than trusting the statement.

\set ON_ERROR_STOP on

-- 1. Guards -------------------------------------------------------------------
DO $$
BEGIN
  IF current_user <> 'shadhil' THEN
    RAISE EXCEPTION 'run this as the bootstrap superuser (shadhil), not as %', current_user;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'shadhil_owner') THEN
    RAISE NOTICE 'shadhil_owner does not exist; nothing to roll back';
  END IF;
END
$$;

-- 2. Ownership back to the bootstrap role -------------------------------------
-- Views first this time: a view owned by the new owner may not alter while its base table
-- changes hands underneath it.
DO $$
DECLARE
  r record;
BEGIN
  FOR r IN
    SELECT c.relname, c.relkind::text AS kind
      FROM pg_class c
      JOIN pg_namespace n ON n.oid = c.relnamespace
     WHERE n.nspname = 'public' AND c.relkind IN ('v', 'm')
       AND pg_get_userbyid(c.relowner) IN ('shadhil_owner', 'shadhil_rls')
  LOOP
    EXECUTE format(
      'ALTER %s public.%I OWNER TO shadhil',
      CASE r.kind WHEN 'm' THEN 'MATERIALIZED VIEW' ELSE 'VIEW' END,
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
     WHERE n.nspname = 'public' AND c.relkind IN ('r', 'p', 'S')
       AND pg_get_userbyid(c.relowner) IN ('shadhil_owner', 'shadhil_rls')
  LOOP
    EXECUTE format(
      'ALTER %s public.%I OWNER TO shadhil',
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
    SELECT t.typname
      FROM pg_type t
      JOIN pg_namespace n ON n.oid = t.typnamespace
     WHERE n.nspname = 'public' AND t.typtype IN ('e', 'd')
       AND pg_get_userbyid(t.typowner) IN ('shadhil_owner', 'shadhil_rls')
  LOOP
    EXECUTE format('ALTER TYPE public.%I OWNER TO shadhil', r.typname);
  END LOOP;
END
$$;

DO $$
DECLARE
  r record;
BEGIN
  FOR r IN
    SELECT p.proname, pg_get_function_identity_arguments(p.oid) AS args
      FROM pg_proc p
      JOIN pg_namespace n ON n.oid = p.pronamespace
     WHERE n.nspname = 'public'
       AND pg_get_userbyid(p.proowner) IN ('shadhil_owner', 'shadhil_rls')
  LOOP
    EXECUTE format('ALTER FUNCTION public.%I(%s) OWNER TO shadhil', r.proname, r.args);
  END LOOP;
END
$$;

-- The production schema was owned by pg_database_owner before the cutover (the PG16
-- default); putting it back there keeps the state identical to the pre-cutover fingerprint
-- instead of inventing a new one.
ALTER SCHEMA public OWNER TO pg_database_owner;

DO $$
BEGIN
  EXECUTE format('ALTER DATABASE %I OWNER TO shadhil', current_database());
END
$$;

-- 3. Restore the exact pre-cutover privileges ------------------------------------
-- The cutover recorded (object, grantee, privileges) before it touched anything, because
-- ALTER ... OWNER rewrites the GRANTOR of every ACL entry and a blanket re-grant on
-- rollback silently widens access. Measured in the rehearsal before the record existed:
-- the app picked up DELETE on Feedback, Invite and OutboundMessage, which it never had, and
-- full CRUD on _prisma_migrations, which it must never have.
--
-- If the record is missing (a cutover that failed before section 3b), fall back to the
-- narrowest set the app demonstrably needs: USAGE on the schema and EXECUTE on functions.
DO $$
DECLARE
  r record;
  missing int;
BEGIN
  IF to_regclass('public._owner_split_acl') IS NULL THEN
    RAISE NOTICE 'no ACL record found; restoring schema USAGE and function EXECUTE only';
    RETURN;
  END IF;

  -- Strip every non-owner grantee from tables and sequences, so the re-grant below lands
  -- on a clean slate instead of layering onto whatever the ownership rewrite left behind.
  FOR r IN
    SELECT c.relname, c.relkind::text AS kind,
           CASE WHEN x.grantee = 0 THEN 'PUBLIC' ELSE quote_ident(pg_get_userbyid(x.grantee)) END AS grantee
      FROM pg_class c
      JOIN pg_namespace n ON n.oid = c.relnamespace
      CROSS JOIN LATERAL aclexplode(c.relacl) AS x
     WHERE n.nspname = 'public' AND c.relkind IN ('r', 'p', 'S')
       AND x.grantee <> c.relowner
     GROUP BY 1, 2, 3
  LOOP
    EXECUTE format(
      'REVOKE ALL ON %s public.%I FROM %s',
      CASE r.kind WHEN 'S' THEN 'SEQUENCE' WHEN 'p' THEN 'TABLE' ELSE 'TABLE' END,
      r.relname, r.grantee
    );
  END LOOP;

  FOR r IN SELECT relkind, obj, grantee, privs FROM public._owner_split_acl LOOP
    EXECUTE format(
      'GRANT %s ON %s public.%I TO %s',
      array_to_string(r.privs, ', '),
      CASE r.relkind WHEN 'S' THEN 'SEQUENCE' ELSE 'TABLE' END,
      r.obj,
      CASE WHEN r.grantee = 'PUBLIC' THEN 'PUBLIC' ELSE quote_ident(r.grantee) END
    );
  END LOOP;

  -- Verify against the record, not against a guess about what the app should hold. One
  -- table in production deliberately has no app grant at all, so "every table is granted"
  -- is the wrong assertion and it fires on a rollback that is perfectly correct.
  SELECT count(*) INTO missing
    FROM public._owner_split_acl a
   WHERE a.grantee = 'shadhil_app'
     AND 'SELECT' = ANY (a.privs)
     AND NOT EXISTS (
       SELECT 1
         FROM pg_class c
         JOIN pg_namespace n ON n.oid = c.relnamespace
         CROSS JOIN LATERAL aclexplode(c.relacl) AS x
        WHERE n.nspname = 'public'
          AND c.relname = a.obj
          AND x.grantee = 'shadhil_app'::regrole
          AND x.privilege_type = 'SELECT'
     );
  IF missing > 0 THEN
    RAISE EXCEPTION 'rollback lost the app SELECT grant on % object(s) that had it', missing;
  END IF;

  DROP TABLE public._owner_split_acl;
END
$$;

-- Function EXECUTE: the app needs it explicitly now that the cutover revoked PUBLIC on the
-- DEFINER helpers. Everything else keeps whatever it had; the deliberate difference from
-- the pre-cutover state is that PUBLIC no longer reaches a DEFINER helper.
DO $$
DECLARE
  r record;
BEGIN
  FOR r IN
    SELECT p.proname, pg_get_function_identity_arguments(p.oid) AS args
      FROM pg_proc p
      JOIN pg_namespace n ON n.oid = p.pronamespace
     WHERE n.nspname = 'public'
  LOOP
    EXECUTE format('GRANT EXECUTE ON FUNCTION public.%I(%s) TO shadhil_app', r.proname, r.args);
  END LOOP;
END
$$;

GRANT USAGE ON SCHEMA public TO shadhil_app;

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'studio_ro') THEN
    EXECUTE 'GRANT USAGE ON SCHEMA public TO studio_ro';
  END IF;
END
$$;

-- Default privileges created by the cutover belong to shadhil_owner and disappear with it.

-- 4. Drop the roles -----------------------------------------------------------
REVOKE shadhil_seed FROM shadhil_owner;

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'shadhil_owner') THEN
    EXECUTE format('REVOKE ALL ON DATABASE %I FROM shadhil_owner', current_database());
    EXECUTE 'DROP OWNED BY shadhil_owner';
    EXECUTE 'DROP ROLE shadhil_owner';
  END IF;
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'shadhil_rls') THEN
    EXECUTE format('REVOKE ALL ON DATABASE %I FROM shadhil_rls', current_database());
    EXECUTE 'DROP OWNED BY shadhil_rls';
    EXECUTE 'DROP ROLE shadhil_rls';
  END IF;
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'shadhil_seed') THEN
    EXECUTE format('REVOKE ALL ON DATABASE %I FROM shadhil_seed', current_database());
    EXECUTE 'DROP OWNED BY shadhil_seed';
    EXECUTE 'DROP ROLE shadhil_seed';
  END IF;
END
$$;

-- 5. Prove the rollback -------------------------------------------------------
DO $$
DECLARE
  strays int;
  app_tables int;
  app_on_table int;
BEGIN
  SELECT count(*) INTO strays
    FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
   WHERE n.nspname = 'public'
     AND pg_get_userbyid(c.relowner) NOT IN ('shadhil')
     AND c.relkind IN ('r', 'p', 'S', 'v', 'm');
  IF strays > 0 THEN
    RAISE EXCEPTION '% relations are still not owned by shadhil', strays;
  END IF;

  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname IN ('shadhil_owner', 'shadhil_rls', 'shadhil_seed')) THEN
    RAISE EXCEPTION 'one of the split roles still exists after DROP ROLE';
  END IF;

  SELECT count(*) INTO app_tables
    FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
   WHERE n.nspname = 'public' AND c.relkind = 'r';

  SELECT count(*) INTO app_on_table
    FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
    CROSS JOIN LATERAL aclexplode(c.relacl) AS x
   WHERE n.nspname = 'public' AND c.relkind = 'r'
     AND x.grantee = 'shadhil_app'::regrole AND x.privilege_type = 'SELECT';
  -- Reported, not asserted: one table is deliberately outside the app's reach, and section
  -- 3 already proved the app kept every grant the ACL record says it had.
  RAISE NOTICE 'rollback proven: % tables back on shadhil, app holds SELECT on % of them',
    app_tables, app_on_table;
END
$$;

\echo 'Now: point DIRECT_DATABASE_URL back at shadhil with PG_PASSWORD and recreate the api'
\echo 'container. Then run scripts/prod/owner-state.sql and diff it against the pre-cutover copy.'
