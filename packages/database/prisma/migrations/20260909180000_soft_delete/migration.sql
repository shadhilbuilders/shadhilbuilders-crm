-- Soft delete for User and Project (T-SOFT-DELETE, 2026-09-09).
--
-- Both entities previously hard-deleted (DELETE). Now they soft-delete via a
-- nullable `deletedAt` sentinel: NULL = active, NOT NULL = deleted.
--
--   User.deletedAt    - soft-deleted users are blocked from sign-in and
--                       hidden from every list/picker (ADMIN/OWNER only).
--   Project.deletedAt - soft-deleted projects are hidden from the registry,
--                       switcher, and staff page (ADMIN + OWNER only).
--
-- Column-level add on both; no data migration needed (all existing rows are
-- active → NULL).

ALTER TABLE "User"    ADD COLUMN "deletedAt" TIMESTAMP(3);
ALTER TABLE "Project" ADD COLUMN "deletedAt" TIMESTAMP(3);
