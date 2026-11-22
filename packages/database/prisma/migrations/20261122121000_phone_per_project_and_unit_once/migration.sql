-- A phone identifies a person PER PROJECT, and a unit is booked at most once.
--
-- Owner decision 2026-11-22:
--   * the same person may be a lead for two different projects, so the
--     phone identity is (organizationId, phoneE164, projectId);
--   * one lead may still book two different units in the same project
--     (Booking.leadId is many-to-one, nothing changes there);
--   * a unit must never be under two live bookings.
--
-- The unit rule was ALREADY enforced by `one_active_booking_per_unit`
-- (migration 20260915060000_unit_status_sync), the same partial unique index
-- over HOLD/TOKEN/APPROVED. This migration therefore does not add a second
-- one: two identical indexes on "unitId" cost every booking write twice and
-- protect nothing extra.
--
-- An earlier draft of this file created `Booking_unit_active_key`. It is
-- dropped here so a database that ran that draft converges with a fresh one.

-- 1. Phone identity, now scoped to the project.
DROP INDEX IF EXISTS "Lead_organizationId_phoneE164_key";

CREATE UNIQUE INDEX IF NOT EXISTS "Lead_organizationId_phoneE164_projectId_key"
  ON "Lead" ("organizationId", "phoneE164", "projectId");

-- 2. Collapse the duplicate unit index added by the earlier draft.
DROP INDEX IF EXISTS "Booking_unit_active_key";

-- 3. Re-assert the rule in place since 2026-09-15, so this migration stands on
--    its own where that index is somehow missing.
CREATE UNIQUE INDEX IF NOT EXISTS "one_active_booking_per_unit"
  ON "Booking" ("unitId")
  WHERE "status" IN ('HOLD', 'TOKEN', 'APPROVED');

-- Reverse: dropping the project-scoped phone index returns uniqueness to
-- (organizationId, phoneE164). `one_active_booking_per_unit` is left alone
-- because it predates this migration.
