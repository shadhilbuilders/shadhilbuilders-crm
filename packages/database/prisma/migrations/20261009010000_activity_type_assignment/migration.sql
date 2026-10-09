-- Lead timeline: new Activity type for owner / co-owner changes.
-- Postgres cannot USE a freshly added enum value in the transaction that adds
-- it, so the backfill that writes 'ASSIGNMENT' rows lives in the next migration.
ALTER TYPE "ActivityType" ADD VALUE IF NOT EXISTS 'ASSIGNMENT';
