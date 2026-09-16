-- Disable the mustChangePassword gate (2026-09-15).
--
-- WHY: the T-S hardening gate (2026-09-04) forced every seeded operator through
-- /change-password on first sign-in. That friction is no longer wanted, so the
-- gate is switched OFF by default and existing rows are cleared.
--
-- The FEATURE IS NOT REMOVED. All of this still exists and still works:
--   - the /change-password page and its form
--   - JwtAuthGuard.canActivate's mustChangePassword check + the 403
--     PASSWORD_CHANGE_REQUIRED response shape
--   - UsersService.changePassword's flip-to-false write and audit row
--   - the web api client's 403 -> /change-password bounce
-- Setting this column to true for an individual user re-arms the gate for that
-- user only, which is why the default is flipped instead of the check deleted.
--
-- Two changes, both needed:
--   1. The column DEFAULT becomes false, so a user created without an explicit
--      value (including any future signup path) does not land in the gate.
--   2. Existing rows are reset to false. Without this step the default change
--      would only affect NEW rows and every current user would stay gated.
--
-- No audit rows: this is a schema/config default change across the whole user
-- table, not a per-user state transition an operator performed.

-- 1. Flip the column default.
ALTER TABLE "User" ALTER COLUMN "mustChangePassword" SET DEFAULT false;

-- 2. Clear the flag on existing rows so current users are not gated.
UPDATE "User" SET "mustChangePassword" = false WHERE "mustChangePassword" = true;
