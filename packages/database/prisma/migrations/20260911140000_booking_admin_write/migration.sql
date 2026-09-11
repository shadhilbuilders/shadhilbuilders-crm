-- 20260911140000_booking_admin_write
-- ------------------------------------------------------------------------
-- Bug: booking create/update/delete fails 42501 for ADMIN (and OWNER, which
-- downcasts to ADMIN at the RLS layer).
--
-- booking_write_team is `FOR ALL` and requires the parent Lead's teamId to
-- equal app.user_team_id even for ADMIN. But the seed ADMIN/OWNER carry
-- teamId=null -> app.user_team_id='' -> the write is rejected on any Lead
-- that belongs to a team.
--
-- The SELECT policy (booking_select_team) already gives ADMIN a standalone
-- bypass; and every other via-lead write table (Lead, SiteVisit, Message,
-- Activity) shipped a dedicated admin-bypass policy. Booking is the missing
-- one. Postgres OR's overlapping policies, so this policy lets ADMIN write
-- any booking while MANAGER/TELECALLER/SALES_EXEC still get their existing
-- team/owner enforcement from booking_write_team.
-- ------------------------------------------------------------------------

CREATE POLICY booking_write_admin ON "Booking"
  FOR ALL
  USING (current_setting('app.user_role', true) = 'ADMIN')
  WITH CHECK (current_setting('app.user_role', true) = 'ADMIN');
