// ────────────────────────────────────────────────────────────────────────────
// Shadhil CRM - seed default option values (reference only)
// ────────────────────────────────────────────────────────────────────────────
// Facing and BHK are now PER-PROJECT data (ProjectOption table), managed from
// the phases page and read by the inventory pickers. These constants remain
// ONLY as the documented default set the seed backfills (see
// packages/database/src/seed.ts). Do NOT wire pickers to these - load from
// useProjectOptions() instead.
// ────────────────────────────────────────────────────────────────────────────

/** Historical default facings the seed backfills for a new project. */
export const DEFAULT_FACING_VALUES = ['North', 'South', 'East', 'West'] as const;

/** Historical default BHK values the seed backfills for a new project. */
export const DEFAULT_BHK_VALUES = ['1', '2', '3', '4', '5'] as const;
