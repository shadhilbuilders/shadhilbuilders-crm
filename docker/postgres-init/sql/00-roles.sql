-- ────────────────────────────────────────────────────────────────────────────
-- Shadhil Builders CRM - first-boot roles. Run by 00-init.sh, never directly:
-- the entrypoint only reads the top level of /docker-entrypoint-initdb.d, and
-- this body needs the app role's password as a psql variable.
--
-- SECOND-ROUND AUDIT AR-1 (2026-08-31): the app previously connected as the
-- table owner, which bypasses RLS entirely. The app must connect as a NON-owner
-- role. This script creates that role; policies.sql (applied via the first
-- Prisma migration) sets FORCE ROW LEVEL SECURITY per table.
--
-- 2026-11-28: the password is no longer a literal. It arrives as :'app_password'
-- and must differ from POSTGRES_PASSWORD, which 00-init.sh enforces. The old
-- literal matched the bootstrap superuser's password in every environment, so
-- the role split protected nothing.
-- ────────────────────────────────────────────────────────────────────────────

-- 1. Extensions ---------------------------------------------------------------

-- pgcrypto: for SCRAM-friendly auth flows and future crypto needs. (cuids
-- are generated app-side, not by Postgres, but keep for forward-compat.)
CREATE EXTENSION IF NOT EXISTS pgcrypto;

-- 2. Non-owner application role (AR-1) ---------------------------------------
-- `shadhil_app` owns NO tables. It passes through PgBouncer and gets its
-- row visibility ONLY via the RLS policies (policies.sql). The owner role
-- `shadhil` is reserved for migrations/seed (DIRECT_DATABASE_URL).
--
-- The password travels through a session setting because psql does not
-- substitute :'variables' inside a dollar-quoted body. Keeping it out of the
-- SQL text also keeps it out of the server log when log_statement is on.
SELECT set_config('app.init_app_password', :'app_password', false);

DO $$
DECLARE
  pw text := current_setting('app.init_app_password');
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'shadhil_app') THEN
    EXECUTE format(
      'CREATE ROLE shadhil_app LOGIN PASSWORD %L NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT',
      pw
    );
  END IF;
END
$$;

RESET app.init_app_password;

COMMENT ON ROLE shadhil_app IS 'Shadhil CRM app role - non-owner, RLS-enforced. NEVER use for migrations.';

-- Schema-level USAGE + CREATE grants. Without USAGE on `public`,
-- the table-level GRANTs in policies.sql are invisible to shadhil_app
-- and Postgres returns `42501 permission denied for schema public` (or
-- `42P01 relation does not exist` depending on the access path). CREATE
-- is needed for Prisma's $executeRawUnsafe during bootstrap migrations.
-- Round 25 (2026-09-03): explicit grants added - the schema's default
-- PUBLIC ACL was empty in this setup, so the implicit pseudo-role grant
-- did not apply.
GRANT USAGE, CREATE ON SCHEMA public TO shadhil_app;

-- Rotating the app password later: ALTER ROLE shadhil_app PASSWORD '<new>', then
-- regenerate the PgBouncer userlist (docker/userlist.txt for local, the
-- host-mounted copy at /data/coolify/shadhil/userlist.txt in production) and
-- reload PgBouncer. Both files carry the plaintext, so neither belongs in git
-- history with a production value in it.

-- 3. The owner split (docs/planning/OWNER-ROLE-MIGRATION.md, W12) ---------------
-- Three roles, three jobs, three secrets:
--
--   shadhil_owner  NOSUPERUSER NOBYPASSRLS LOGIN CREATEDB  owns the tables; migrations
--   shadhil_rls    NOSUPERUSER BYPASSRLS   NOLOGIN         owns the 19 SECURITY DEFINER
--                                                           helpers, so they keep seeing
--                                                           every row they are written to
--                                                           see (packages/database/
--                                                           scripts/rls-post-migrate.sql
--                                                           re-asserts that ownership
--                                                           after every migrate deploy)
--   shadhil_seed   NOSUPERUSER BYPASSRLS   LOGIN           pnpm seed, test fixtures
--
-- `shadhil` stays the bootstrap superuser and is not connected as by anything in the
-- request path. It cannot be demoted (initdb protects POSTGRES_USER: "The bootstrap user
-- must have the SUPERUSER attribute"), so it exists for CREATE EXTENSION and break-glass.
--
-- Passwords travel as session settings for the same reason as the app role's below: psql
-- does not substitute :'variables' inside a dollar-quoted body, and a setting keeps the
-- secret out of the server log when log_statement is on.
SELECT set_config('app.init_owner_password', :'owner_password', false);
SELECT set_config('app.init_seed_password', :'seed_password', false);

DO $$
DECLARE
  owner_pw text := current_setting('app.init_owner_password');
  seed_pw text := current_setting('app.init_seed_password');
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'shadhil_owner') THEN
    EXECUTE format(
      'CREATE ROLE shadhil_owner LOGIN PASSWORD %L NOSUPERUSER NOBYPASSRLS CREATEDB NOCREATEROLE',
      owner_pw
    );
  ELSE
    EXECUTE format('ALTER ROLE shadhil_owner WITH LOGIN NOSUPERUSER NOBYPASSRLS CREATEDB PASSWORD %L', owner_pw);
  END IF;

  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'shadhil_rls') THEN
    EXECUTE 'CREATE ROLE shadhil_rls NOLOGIN NOSUPERUSER BYPASSRLS';
  ELSE
    EXECUTE 'ALTER ROLE shadhil_rls WITH NOLOGIN NOSUPERUSER BYPASSRLS';
  END IF;

  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'shadhil_seed') THEN
    EXECUTE format(
      'CREATE ROLE shadhil_seed LOGIN PASSWORD %L NOSUPERUSER BYPASSRLS NOCREATEDB NOCREATEROLE',
      seed_pw
    );
  ELSE
    EXECUTE format('ALTER ROLE shadhil_seed WITH LOGIN NOSUPERUSER BYPASSRLS PASSWORD %L', seed_pw);
  END IF;
END
$$;

RESET app.init_owner_password;
RESET app.init_seed_password;

COMMENT ON ROLE shadhil_owner IS 'Shadhil CRM migration owner: owns the tables, NOBYPASSRLS. Used by DIRECT_DATABASE_URL.';
COMMENT ON ROLE shadhil_rls   IS 'Shadhil CRM SECURITY DEFINER owner: BYPASSRLS, no login. Re-asserted by scripts/rls-post-migrate.sql.';
COMMENT ON ROLE shadhil_seed  IS 'Shadhil CRM seed role: BYPASSRLS, login. Only pnpm seed and test fixtures.';

-- A migration that has to touch rows borrows the bypass with `SET LOCAL ROLE
-- shadhil_seed;` (a non-bypass owner's INSERT into a FORCEd table fails outright, and its
-- UPDATE silently touches zero rows). The membership is what makes that line legal.
GRANT shadhil_seed TO shadhil_owner;

-- Function EXECUTE for the callers, not for PUBLIC. The helpers are created by migration 1
-- with PUBLIC EXECUTE by default; scripts/rls-post-migrate.sql revokes that and grants these
-- three explicitly, because a role that queries a FORCEd table evaluates its policies and a
-- policy calls these helpers AS THE CALLER.

-- The schema and the database move too, or every later CREATE TABLE fails with
-- `permission denied for schema public`, which reads like a missing table.
GRANT USAGE, CREATE ON SCHEMA public TO shadhil_owner;
GRANT USAGE ON SCHEMA public TO shadhil_rls;
GRANT USAGE, CREATE ON SCHEMA public TO shadhil_seed;
ALTER SCHEMA public OWNER TO shadhil_owner;

DO $$
BEGIN
  EXECUTE format('ALTER DATABASE %I OWNER TO shadhil_owner', current_database());
END
$$;

-- Tables are created by migrations, so the helper role needs the privilege on tables that
-- do not exist yet.
ALTER DEFAULT PRIVILEGES FOR ROLE shadhil_owner IN SCHEMA public
  GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO shadhil_rls;
ALTER DEFAULT PRIVILEGES FOR ROLE shadhil_owner IN SCHEMA public
  GRANT USAGE, SELECT ON SEQUENCES TO shadhil_rls;
ALTER DEFAULT PRIVILEGES FOR ROLE shadhil_owner IN SCHEMA public
  GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO shadhil_seed;
ALTER DEFAULT PRIVILEGES FOR ROLE shadhil_owner IN SCHEMA public
  GRANT USAGE, SELECT ON SEQUENCES TO shadhil_seed;

-- 4. Future-proofing note ------------------------------------------------------
-- When Postgres 16 creates the initdb superuser (the `shadhil` owner), it
-- does NOT run this file as that role; statements here run as the bootstrap
-- superuser, which is fine: we only need world-grantable, non-ownership DDL.
-- Ownership grants for tables created later by Prisma happen in the first
-- migration (see packages/database/prisma/migrations/..._rls_policies)
