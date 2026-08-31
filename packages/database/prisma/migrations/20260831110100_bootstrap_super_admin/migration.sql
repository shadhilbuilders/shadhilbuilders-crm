-- Bootstrap: the seeded admin account becomes the SUPER_ADMIN (one bootstrap
-- per Round 20 — SUPER_ADMIN is the org-owner role; there is exactly one).
-- Separate transaction: ALTER TYPE ... ADD VALUE cannot run in the same tx
-- as statements using the new enum value.
UPDATE "User" SET "role" = 'SUPER_ADMIN' WHERE "email" = 'admin@shadhilbuilders.in';