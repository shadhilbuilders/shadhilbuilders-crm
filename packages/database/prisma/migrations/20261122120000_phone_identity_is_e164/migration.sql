-- Phone identity is the canonical column.
--
-- Before this, uniqueness keyed on `phone`, which held whatever the caller
-- typed: 144 rows carried the bare national form (`9876530002`) while
-- `phoneE164` correctly held `919876530002`. Two columns describing one
-- subscriber, and the index pointed at the wrong one.
--
-- The repairs run narrowest-first so nothing is deleted while it could still
-- be read. In particular a genuine foreign lead must never be deleted for
-- being foreign: stripping a `+` and its punctuation recovers the E.164 digits
-- without needing to know the country.
--
-- Every statement is guarded, so a re-run after a partial failure converges.

-- 1. Bare Indian mobiles that never got their prefix. Repair both columns.
UPDATE "Lead"
SET "phoneE164" = '91' || "phone",
    "phone"     = '91' || "phone"
WHERE "phoneE164" IS NULL
  AND "phone" ~ '^[6-9][0-9]{9}$';

-- 2. Anything else that is already an international number: `+6591234567`,
--    `6591234567`, `+971 50 123 4567`. The digits ARE the E.164 form, so this
--    needs no country table and cannot misread a foreign number as Indian.
UPDATE "Lead"
SET "phoneE164" = regexp_replace("phone", '[^0-9]', '', 'g'),
    "phone"     = regexp_replace("phone", '[^0-9]', '', 'g')
WHERE "phoneE164" IS NULL
  AND length(regexp_replace("phone", '[^0-9]', '', 'g')) BETWEEN 7 AND 15;

-- 3. Only now, delete what is genuinely unusable: no E.164 digits at all.
--    These are seed/demo fixtures ("B1 burden 0"), not customers. Owner
--    decision 2026-11-22: delete them rather than carry rows outside the
--    identity constraint forever, because Postgres treats NULLs as distinct
--    and a nullable identity column protects nothing.
DELETE FROM "Lead"
WHERE "phoneE164" IS NULL;

-- 4. Rows where the canonical column is right and `phone` is the bare form.
UPDATE "Lead"
SET "phone" = "phoneE164"
WHERE "phone" <> "phoneE164";

-- 5. Fail loudly rather than ship a NOT NULL that hides a row.
DO $$
DECLARE
  remaining bigint;
BEGIN
  SELECT count(*) INTO remaining FROM "Lead" WHERE "phoneE164" IS NULL;
  IF remaining > 0 THEN
    RAISE EXCEPTION 'phoneE164 backfill left % row(s) NULL; refusing to continue', remaining;
  END IF;
END $$;

ALTER TABLE "Lead" ALTER COLUMN "phoneE164" SET NOT NULL;

-- 6. The invariant, enforced by the database instead of by discipline.
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'Lead_phone_equals_phoneE164'
  ) THEN
    ALTER TABLE "Lead"
      ADD CONSTRAINT "Lead_phone_equals_phoneE164"
      CHECK ("phone" = "phoneE164");
  END IF;
END $$;

-- 7. Uniqueness moves to the canonical column. The old index keyed on the
--    typed value, which is what refused a legitimate lead once two countries
--    could share a national string.
DROP INDEX IF EXISTS "Lead_organizationId_phone_key";

-- Reverse (may legitimately fail, by design): re-adding a unique index on
-- (organizationId, phone) breaks as soon as two leads in one organisation
-- share a national string across countries, which is exactly what this change
-- enables. Rolling the constraint back means choosing which collided row to
-- keep, not running a migration.
