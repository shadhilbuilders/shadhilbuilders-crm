-- ────────────────────────────────────────────────────────────────────────────
-- Shadhil Builders CRM - first-boot SQL (postgres:16-alpine entrypoint).
-- Applied automatically on volume init (docker/postgres-init is mounted
-- at /docker-entrypoint-initdb.d).
--
-- SECOND-ROUND AUDIT AR-1 (2026-08-31): the app previously connected as the
-- table owner, which bypasses RLS entirely. The app must connect as a
-- NON-owner role. This script creates that role; policies.sql (applied via
-- the first Prisma migration) sets FORCE ROW LEVEL SECURITY per table.
--
-- Password for both roles comes from POSTGRES_PASSWORD (set in
-- docker-compose.yml). The owner role `shadhil` is created automatically by
-- the postgres image from POSTGRES_USER/POSTGRES_PASSWORD.
-- ────────────────────────────────────────────────────────────────────────────

-- 1. Extensions ---------------------------------------------------------------

-- pgcrypto: for SCRAM-friendly auth flows and future crypto needs. (cuids
-- are generated app-side, not by Postgres, but keep for forward-compat.)
CREATE EXTENSION IF NOT EXISTS pgcrypto;

-- 2. Non-owner application role (AR-1) ---------------------------------------
-- `shadhil_app` owns NO tables. It passes through PgBouncer and gets its
-- row visibility ONLY via the RLS policies (policies.sql). The owner role
-- `shadhil` is reserved for migrations/seed (DIRECT_DATABASE_URL).

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'shadhil_app') THEN
    CREATE ROLE shadhil_app LOGIN PASSWORD 'shadhil' NOSUPERUSER NOCREATEDB
      NOCREATEROLE NOINHERIT;
  END IF;
END
$$;

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

-- NOTE on the password: this default matches POSTGRES_PASSWORD from
-- docker-compose for local dev (dev-only throwaway, same as the owner role).
-- Production MUST override both via Coolify env vars; compose passes
-- POSTGRES_PASSWORD through. A rotation here means regenerating the PgBouncer
-- SCRAM userlist (docker/userlist.txt) - see docker/userlist.txt header.

-- 3. Future-proofing note ------------------------------------------------------
-- When Postgres 16 creates the initdb superuser (the `shadhil` owner), it
-- does NOT run this file as that role; statements here run as the bootstrap
-- superuser, which is fine: we only need world-grantable, non-ownership DDL.
-- Ownership grants for tables created later by Prisma happen in the first
-- migration (see packages/database/prisma/migrations/..._rls_policies).