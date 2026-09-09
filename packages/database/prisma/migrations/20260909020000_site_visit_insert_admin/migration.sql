-- T-VISIT-ADMIN-INSERT (2026-09-09): allow ADMIN (and OWNER, which downcasts
-- to ADMIN at the RLS layer) to INSERT a SiteVisit for ANY lead.
--
-- Symptom: scheduling a site visit as a seed ADMIN/OWNER returned
--   PrismaClientKnownRequestError 42501 P2039
--   "new row violates row-level security policy for table SiteVisit"
-- at visits.service.ts:248 (siteVisit.create).
--
-- Root cause (mirrors the lead_insert_admin bug, 2026-09-08, and the
-- message_insert_admin bug, 2026-09-09):
--   1. Seed ADMIN/OWNER carry `teamId: null` on the JWT (seed keeps it null
--      by design - they are not team members).
--   2. withRlsContext sets `app.user_team_id` to '' for a null teamId.
--   3. The only write policy (`site_visit_write_team`) requires, for
--      ADMIN/MANAGER, `l."teamId" = current_setting('app.user_team_id')`.
--      No lead has teamId = '', so the ADMIN insert is rejected with 42501.
--
-- DESIGN.md §3: admin-created/owned records can target any team - consistent
-- with lead_insert_admin / update_admin / delete_admin and message_insert_admin
-- (role-only, no team equality). OWNER needs no separate policy: withRlsContext
-- downcasts OWNER → ADMIN, so this single policy covers both.
--
-- PostgreSQL OR's overlapping FOR INSERT policies, so MANAGER still gets
-- team-equality enforcement; only ADMIN bypasses it. TELECALLER/SALES_EXEC
-- still gate on the parent lead's ownerId (unchanged).
CREATE POLICY site_visit_insert_admin ON "SiteVisit"
  FOR INSERT
  WITH CHECK (current_setting('app.user_role', true) = 'ADMIN');
