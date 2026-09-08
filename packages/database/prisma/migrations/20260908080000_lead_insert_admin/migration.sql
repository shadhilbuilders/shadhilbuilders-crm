-- T-TEAMLESS-CREATE (2026-09-08): allow ADMIN (and OWNER, which downcasts
-- to ADMIN at the RLS layer) to INSERT a Lead into ANY team.
--
-- Symptom: clicking "Create lead" as a seed ADMIN/OWNER returned
-- "teamId is required when an ADMIN/OWNER creates a lead (no actor teamId)".
-- Two-part root cause:
--   1. Service: ADMIN/OWNER carry `teamId: null` on the JWT (seed keeps it
--      null by design), and Lead.teamId is NOT NULL. The service previously
--      hard-threw. Fixed in leads.service.ts to resolve a DEFAULT team
--      (oldest first).
--   2. RLS: the only INSERT policy (`lead_insert_telecaller`) requires
--      `"teamId" = current_setting('app.user_team_id')`. A teamless admin
--      sets that GUC to '' (withRlsContext), so even after the service
--      resolved a team the INSERT was rejected with 42501
--      "new row violates row-level security policy for table Lead".
--
-- DESIGN.md §3: "admin-created leads can be assigned to any team" -
-- consistent with the existing lead_update_admin / lead_delete_admin
-- policies (role-only, no team equality). OWNER needs no separate policy:
-- withRlsContext downcasts OWNER → ADMIN, so this single policy covers both.
--
-- PostgreSQL OR's overlapping FOR INSERT policies, so TELECALLER/SE/MANAGER
-- still get team-equality enforcement; only ADMIN bypasses it.

CREATE POLICY lead_insert_admin ON "Lead"
  FOR INSERT
  WITH CHECK (current_setting('app.user_role', true) = 'ADMIN');
