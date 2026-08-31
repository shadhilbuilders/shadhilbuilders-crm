-- Add SUPER_ADMIN to the Role enum (Round 20).
-- Split from the data migration: ALTER TYPE ... ADD VALUE cannot run inside
-- the same transaction as statements USING the new value.
ALTER TYPE "Role" ADD VALUE IF NOT EXISTS 'SUPER_ADMIN' BEFORE 'ADMIN';