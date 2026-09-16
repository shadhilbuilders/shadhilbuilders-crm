-- Re-scope the mustChangePassword gate to the OWNER account only (2026-09-15).
--
-- Supersedes 20260915140000_disable_must_change_password, which flipped the
-- column default to false AND cleared the flag for every row. That correctly
-- removed the gate from the four staff roles but also removed it from the
-- OWNER, which is the one account that should still rotate its placeholder.
--
-- Desired end state:
--   OWNER                       -> gated (mustChangePassword = true)
--   ADMIN/MANAGER/SALES_EXEC/TELECALLER -> ungated (false)
--
-- WHY OWNER ONLY: it is the single highest-privilege account, and the only one
-- that cannot be created through the API - `assertCanCreateRole` in
-- apps/backend/src/users/roles.ts rejects an OWNER target ("exactly one exists
-- via seed") and `assertCanChangeRole` refuses to move anyone into or out of
-- the OWNER role. So the seed is OWNER's sole writer and the seed arms the
-- gate (`mustChangePassword: role === 'OWNER'`).
--
-- The column DEFAULT stays false: new users are created through the API as
-- ADMIN/MANAGER/SALES_EXEC/TELECALLER only, and those should start ungated.
--
-- No audit rows: this is a backfill of one account to its intended default,
-- not an operator action against a specific user.

-- 1. Arm the gate for every OWNER row.
UPDATE "User" SET "mustChangePassword" = true WHERE role = 'OWNER';

-- 2. Make sure every non-OWNER row is ungated, including any that a previous
--    state left armed (e.g. rows created while the old default was true).
UPDATE "User"
   SET "mustChangePassword" = false
 WHERE role <> 'OWNER' AND "mustChangePassword" = true;
