-- Add OWNER to the Role enum (Round 21 rename of SUPER_ADMIN → OWNER).
-- Split from the data migration: ALTER TYPE ... ADD VALUE cannot run inside
-- the same transaction as statements USING the new value.
ALTER TYPE "Role" ADD VALUE IF NOT EXISTS 'OWNER' BEFORE 'ADMIN';