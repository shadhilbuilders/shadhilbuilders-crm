-- Unit: buildup sq.ft + price per sq.ft (unit total `price` becomes derived).
-- Booking: list amount + negotiated rate/amount.
--
-- Backfill rules (strict model, no NULLs left behind):
--   * Unit with sqft > 0: buildupSqft = sqft, pricePerSqft = round(price / sqft, 2).
--   * Unit with NULL sqft: placeholder buildupSqft = 1, pricePerSqft = price so the
--     stored total is preserved. These units MUST be corrected in the edit dialog;
--     find them with: SELECT id, "unitNumber" FROM "Unit" WHERE sqft IS NULL;
--   * Booking.listAmount = amount for all existing rows.

ALTER TABLE "Unit" ADD COLUMN IF NOT EXISTS "buildupSqft" DECIMAL(10,2),
ADD COLUMN IF NOT EXISTS "pricePerSqft" DECIMAL(12,2);

UPDATE "Unit"
SET "buildupSqft" = CASE WHEN sqft IS NOT NULL AND sqft > 0 THEN sqft ELSE 1 END,
    "pricePerSqft" = CASE WHEN sqft IS NOT NULL AND sqft > 0 THEN ROUND(price / sqft, 2) ELSE price END;

ALTER TABLE "Unit" ALTER COLUMN "buildupSqft" SET NOT NULL,
ALTER COLUMN "pricePerSqft" SET NOT NULL;

ALTER TABLE "Booking" ADD COLUMN IF NOT EXISTS "listAmount" DECIMAL(12,2),
ADD COLUMN IF NOT EXISTS "negotiatedRate" DECIMAL(12,2),
ADD COLUMN IF NOT EXISTS "negotiatedAmount" DECIMAL(12,2);

-- booking_token_within_total is NOT VALID (legacy rows already violate it), but
-- Postgres still re-checks it on every UPDATE of such a row, which would abort
-- this backfill. Drop it for the backfill and re-add it identically (NOT VALID)
-- so enforcement on new writes is unchanged.
ALTER TABLE "Booking" DROP CONSTRAINT IF EXISTS booking_token_within_total;
UPDATE "Booking" SET "listAmount" = amount WHERE "listAmount" IS NULL;
ALTER TABLE "Booking" ADD CONSTRAINT booking_token_within_total
  CHECK (("tokenAmount" IS NULL) OR (("tokenAmount" > (0)::numeric) AND ("tokenAmount" <= amount))) NOT VALID;

ALTER TABLE "Booking" ALTER COLUMN "listAmount" SET NOT NULL;
