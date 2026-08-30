-- Shadhil Builders CRM — first-boot SQL.
-- Creates the database role + enables required extensions.
-- Applied automatically by the postgres:16-alpine entrypoint.

-- Enable UUID generation for Prisma's @default(cuid()) — actually cuids
-- are generated app-side, not by Postgres. Keeping this here as a no-op
-- for forward-compat with v2.

-- Track last-vacuum-analyze for the leads table (high-traffic).
-- (No DDL on app tables — those are managed by Prisma migrate.)
