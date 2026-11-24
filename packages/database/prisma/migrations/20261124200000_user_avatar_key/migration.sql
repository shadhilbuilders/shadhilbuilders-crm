-- User photo (2026-11-24).
--
-- Stores the storage KEY, not a URL: storage/media-display.ts resolves it to a
-- display URL at read time, so a provider migration (ImageKit -> R2) needs no
-- backfill, exactly like Message.mediaKey. Nullable: existing rows have no
-- photo and the UI falls back to initials.
ALTER TABLE "User" ADD COLUMN "avatarKey" TEXT;
