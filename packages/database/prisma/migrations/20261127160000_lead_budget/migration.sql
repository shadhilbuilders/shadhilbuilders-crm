-- T-LEAD-BUDGET (2026-11-27): a filterable budget band on the lead.
--
-- Nullable on purpose: existing leads have never been asked, and a backfilled
-- guess would be worse than a blank. The 10 IPS 2026 leads carrying a budget in
-- their note are set explicitly after this migration runs.

CREATE TYPE "LeadBudgetBand" AS ENUM (
  'UNDER_50L',
  'FROM_50L_TO_1CR',
  'FROM_1CR_TO_2CR',
  'FROM_2CR_TO_5CR',
  'ABOVE_5CR',
  'NOT_DECIDED'
);

ALTER TABLE "Lead" ADD COLUMN IF NOT EXISTS "budget" "LeadBudgetBand";
