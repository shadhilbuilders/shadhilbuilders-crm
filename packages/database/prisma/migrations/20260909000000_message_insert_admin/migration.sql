-- T-CHAT-ADMIN-INSERT (2026-09-09): allow ADMIN (and OWNER, which downcasts
-- to ADMIN at the RLS layer) to INSERT a Message into ANY lead's thread.
--
-- Symptom: sending a chat message as a seed ADMIN/OWNER returned
--   PrismaClientKnownRequestError 42501
--   "new row violates row-level security policy for table Message"
-- at chat.service.ts:165 (message.create).
--
-- Root cause (mirrors the lead_insert_admin bug, 2026-09-08):
--   1. Seed ADMIN/OWNER carry `teamId: null` on the JWT (seed keeps it null
--      by design - they are not team members).
--   2. withRlsContext sets `app.user_team_id` to '' for a null teamId.
--   3. The only INSERT policy (`message_insert_team`) requires
--      `l."teamId" = current_setting('app.user_team_id')` for ADMIN/MANAGER.
--      No lead has teamId = '', so the ADMIN insert is rejected with 42501.
--
-- DESIGN.md §3: admin-created/owned records can target any team - consistent
-- with lead_insert_admin / lead_update_admin / lead_delete_admin (role-only,
-- no team equality). OWNER needs no separate policy: withRlsContext downcasts
-- OWNER → ADMIN, so this single policy covers both.
--
-- PostgreSQL OR's overlapping FOR INSERT policies, so MANAGER still gets
-- team-equality enforcement; only ADMIN bypasses it. TELECALLER/SALES_EXEC
-- still gate on the parent lead's ownerId (unchanged).
CREATE POLICY message_insert_admin ON "Message"
  FOR INSERT
  WITH CHECK (current_setting('app.user_role', true) = 'ADMIN');
