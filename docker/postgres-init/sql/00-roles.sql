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

-- 3. Future-proofing note ------------------------------------------------------
-- When Postgres 16 creates the initdb superuser (the `shadhil` owner), it
-- does NOT run this file as that role; statements here run as the bootstrap
-- superuser, which is fine: we only need world-grantable, non-ownership DDL.
-- Ownership grants for tables created later by Prisma happen in the first
-- migration (see packages/database/prisma/migrations/..._rls_policies)
