-- Bootstrap: the seeded owner account becomes the OWNER (one bootstrap
-- per Round 20/21/23 — OWNER is the org-owner role; there is exactly
-- one). Separate transaction: ALTER TYPE ... ADD VALUE cannot run in
-- the same tx as statements using the new enum value.
--
-- Round 23: this UPDATE targets owner@shadhilbuilders.in (was
-- admin@shadhilbuilders.in) so the migration and the seed.ts
-- fallback email agree.
UPDATE "User" SET "role" = 'OWNER' WHERE "email" = 'owner@shadhilbuilders.in';