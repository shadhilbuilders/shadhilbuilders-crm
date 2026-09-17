-- T-AUTOASSIGN (2026-09-17): per-team lead auto-assignment + member weight.
--
-- Two additive columns on existing tables. No RLS change: manager ownership of a
-- lead is ALREADY permitted by LeadOwnerType (which includes MANAGER/ADMIN) and
-- the existing lead_insert_manager / lead_select_manager / lead_update_manager
-- policies, so the manager-owner (autoAssignLeads=false) path needs no policy work.
--
-- 1. `Team.autoAssignLeads` (Boolean, default false):
--      true  = NEW leads auto-assign across ALL project teams, to the
--              least-loaded telecaller by (openLeads / weight). Managers never own.
--      false = NEW leads land owned by this team's MANAGER (pending state,
--              ownerType=MANAGER), who hands off by reassigning to a telecaller.
-- 2. `TeamMember.weight` (Int, default 1): relative routing weight used by the
--    auto-assign engine. Higher = biased toward getting more leads.

ALTER TABLE "Team"
  ADD COLUMN "autoAssignLeads" BOOLEAN NOT NULL DEFAULT false;

ALTER TABLE "TeamMember"
  ADD COLUMN "weight" INTEGER NOT NULL DEFAULT 1;
