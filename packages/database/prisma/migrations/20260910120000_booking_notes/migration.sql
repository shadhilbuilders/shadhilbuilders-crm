-- T-BOOK (2026-09-10): add Booking.notes so the create-booking form's
-- Notes field is actually persisted (previously the service accepted
-- dto.notes but the column didn't exist, silently dropping the value).
--
-- Nullable Text, no backfill needed (existing rows have no notes).

ALTER TABLE "Booking" ADD COLUMN "notes" TEXT;
