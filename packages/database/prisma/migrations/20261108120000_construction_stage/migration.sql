-- ────────────────────────────────────────────────────────────────────────────
-- Construction stage on a progress capture (2026-11-08).
--
-- WHY ON ProgressPhoto AND NOT ON Unit:
--   * An engineer's write authority is the photo row (progress_photo_insert /
--     _update are ProjectTeam-scoped). Unit has no write arm for them
--     (unit_select_team_member is SELECT only), so a stage column on Unit would
--     need a brand-new RLS policy to become usable.
--   * A column on Unit would record only the CURRENT stage and lose the
--     progression. On the photo it costs nothing and the unit's current stage
--     becomes a derived read of its newest photo.
--
-- NULLABLE with NO DEFAULT and NO BACKFILL, on purpose: existing rows stay NULL,
-- and NULL means "not recorded" - never "not started". Every surface says
-- "Stage not set" rather than guessing. Declaration order of the enum is the
-- progress order and must never be re-sorted.
-- ────────────────────────────────────────────────────────────────────────────

CREATE TYPE "ConstructionStage" AS ENUM (
  'NOT_STARTED',
  'FOUNDATION',
  'STRUCTURE',
  'MASONRY',
  'PLASTERING',
  'WATERPROOFING',
  'FLOORING',
  'FINISHING',
  'READY'
);

ALTER TABLE "ProgressPhoto" ADD COLUMN "stage" "ConstructionStage";
