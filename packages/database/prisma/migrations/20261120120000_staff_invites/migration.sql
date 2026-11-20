-- ────────────────────────────────────────────────────────────────────────────
-- Staff invites (2026-11-20): a single-use link a staff member completes
-- themselves, ADDITIVE to the existing temp-password create path.
--
-- Plan: .cursor/plans/staff_invite_path_6738bdd5.plan.md
-- Canonical policy copy: packages/database/prisma/rls/policies.sql
--
-- Design in one paragraph. An admin creates an Invite (email pinned, phone
-- required, role + team chosen). The raw token leaves the server exactly
-- once and is sent by a plain wa.me deep link / copy / tel. The invitee opens
-- /invite/<token>, sets their own name / phone / password, and ONE
-- transaction claims the invite and creates User + credential Account +
-- TeamMember + two AuditLog rows. The User row does not exist before
-- acceptance, so no half-provisioned account is ever visible to a picker,
-- team roster, or RLS join.
--
-- RLS. This table IS fenced, unlike User/Verification/StreamTicket. The
-- problem: accepting a token has no JWT, so there is no app.user_org_id to
-- scope by until the row is read (chicken-and-egg). Solved by making the
-- TOKEN ITSELF the scope - the accept path sets app.invite_token_hash and
-- the token arms match that exact column. A caller who does not hold the
-- token matches zero rows. One unfenced read remains unavoidable (resolving
-- the token to an org BEFORE withRlsContext can be called); it goes by the
-- UNIQUE tokenHash and returns ids only.
--
-- Verified shape notes:
--   * "Invite"."tokenHash" is UNIQUE, so the accept path's lookup is a
--     single-row index probe.
--   * team_manager_is_self is SECURITY DEFINER with a pinned search_path,
--     mirroring team_member_exists. A raw EXISTS on "TeamMember" from an
--     "Invite" policy would recurse (Invite -> TeamMember's own policy
--     subqueries Team -> back), the documented 42P17 trap.
-- ────────────────────────────────────────────────────────────────────────────

-- ── 1. InviteStatus enum ───────────────────────────────────────────────────
CREATE TYPE "InviteStatus" AS ENUM ('PENDING', 'ACCEPTED', 'REVOKED', 'EXPIRED');

-- ── 2. Invite table ────────────────────────────────────────────────────────
CREATE TABLE "Invite" (
  "id"               TEXT NOT NULL,
  "organizationId"   TEXT NOT NULL,
  "email"            TEXT NOT NULL,
  "name"             TEXT NOT NULL,
  "phone"            TEXT NOT NULL,
  "role"             "Role" NOT NULL,
  "teamId"           TEXT,
  "tokenHash"        TEXT NOT NULL,
  "invitedById"      TEXT NOT NULL,
  "status"           "InviteStatus" NOT NULL DEFAULT 'PENDING',
  "expiresAt"        TIMESTAMP(3) NOT NULL,
  "lastSentAt"       TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "acceptedAt"       TIMESTAMP(3),
  "acceptedByUserId" TEXT,
  "revokedAt"        TIMESTAMP(3),
  "revokedById"      TEXT,
  "createdAt"        TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt"        TIMESTAMP(3) NOT NULL,
  CONSTRAINT "Invite_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "Invite_tokenHash_key" ON "Invite"("tokenHash");
CREATE UNIQUE INDEX "Invite_acceptedByUserId_key" ON "Invite"("acceptedByUserId");
CREATE INDEX "Invite_organizationId_status_idx" ON "Invite"("organizationId", "status");
CREATE INDEX "Invite_email_idx" ON "Invite"("email");
CREATE INDEX "Invite_expiresAt_idx" ON "Invite"("expiresAt");

-- ONE LIVE INVITE PER (org, email). A partial unique index, which Prisma's
-- schema language cannot express - same precedent as one_owner and
-- ChatReadState's two partial indexes. `lower(email)` because EmailSchema
-- normalizes on the way in, but a hand-written row must not be able to
-- shadow a normalized one in a different case.
CREATE UNIQUE INDEX "Invite_one_pending_per_email"
  ON "Invite"("organizationId", lower("email"))
  WHERE status = 'PENDING';

ALTER TABLE "Invite"
  ADD CONSTRAINT "Invite_organizationId_fkey"
  FOREIGN KEY ("organizationId") REFERENCES "Organization"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "Invite"
  ADD CONSTRAINT "Invite_teamId_fkey"
  FOREIGN KEY ("teamId") REFERENCES "Team"("id") ON DELETE SET NULL ON UPDATE CASCADE;
-- Restrict: the inviter is an audit reference; deleting them should not
-- silently orphan (or worse, revive) a live invite.
ALTER TABLE "Invite"
  ADD CONSTRAINT "Invite_invitedById_fkey"
  FOREIGN KEY ("invitedById") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "Invite"
  ADD CONSTRAINT "Invite_acceptedByUserId_fkey"
  FOREIGN KEY ("acceptedByUserId") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "Invite"
  ADD CONSTRAINT "Invite_revokedById_fkey"
  FOREIGN KEY ("revokedById") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- ── 3. App-role access ─────────────────────────────────────────────────────
-- The role owns nothing, so it needs the table grant before RLS can even be
-- evaluated (a missing GRANT is 42501 permission denied, not an empty set).
--
-- COLUMN-LEVEL UPDATE IS LOAD-BEARING. A policy's WITH CHECK can only see the
-- NEW row - Postgres has no OLD inside WITH CHECK - so no policy can stop an
-- UPDATE that rewrites `email`, `role` or `teamId` while still landing on
-- status='ACCEPTED'. Verified live: an INVITE_ACCEPT UPDATE that also set
-- role='ADMIN' succeeded under a status-only WITH CHECK. The privilege layer
-- is the right place for this, and it is absolute: the app role simply cannot
-- write those columns.
--
-- The accept path writes exactly three columns: status, acceptedAt,
-- acceptedByUserId. Resend writes tokenHash + expiresAt + lastSentAt + status;
-- revoke writes status + revokedAt + revokedById. Those are the grants below -
-- note this ALSO means the admin service cannot rewrite email/role/team on an
-- invite, which is the intended contract (delete and re-invite instead).
GRANT SELECT, INSERT, DELETE ON "Invite" TO shadhil_app;
GRANT UPDATE (
  "status",
  "expiresAt",
  "lastSentAt",
  "tokenHash",
  "acceptedAt",
  "acceptedByUserId",
  "revokedAt",
  "revokedById",
  "updatedAt"
) ON "Invite" TO shadhil_app;

-- ── 4. team_manager_is_self (recursion-safe helper) ────────────────────────
-- "Does this user manage this team?" - the only question the manager arms
-- need, answered WITHOUT touching TeamMember (whose own SELECT policy reads
-- Team, so a raw join here closes the cycle: 42P17 infinite recursion).
-- Same shape as team_member_exists / project_unit_ids: SECURITY DEFINER,
-- search_path pinned, EXECUTE granted only to the app role.
CREATE OR REPLACE FUNCTION team_manager_is_self(p_team_id TEXT, p_user_id TEXT)
RETURNS BOOLEAN
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
  SELECT EXISTS (
    SELECT 1 FROM "Team" t
    WHERE t."id" = p_team_id
      AND t."managerId" = p_user_id
      AND t."deletedAt" IS NULL
  );
$$;

GRANT EXECUTE ON FUNCTION team_manager_is_self(TEXT, TEXT) TO shadhil_app;

-- ── The token pre-flight resolver ──────────────────────────────────────────
-- THE CHICKEN-AND-EGG, SOLVED PROPERLY.
--
-- The accept path has no JWT, so it has no app.user_org_id - and
-- invite_select_token requires one. A plain `SELECT` on the bare client
-- therefore returns ZERO rows under FORCE RLS (verified live: the bare client
-- sees 0 Invite rows). So the pre-flight lookup cannot be an ordinary query.
--
-- This function is that one deliberate hole, and it is as narrow as possible:
--   * input is the sha256 hash, never the raw token
--   * output is ids + status + deadline + the inviter - no email, no name,
--     no phone, no token echo
--   * SECURITY DEFINER with search_path pinned, EXECUTE granted only to
--     shadil_app, exactly like team_member_exists / project_unit_ids
--   * STABLE (read-only), so it cannot be used to mutate anything
--
-- Holding a valid 256-bit token is what makes this return a row; a wrong hash
-- returns nothing. Everything AFTER this call runs inside withRlsContext under
-- the INVITE_ACCEPT policy set and is fully fenced.
CREATE OR REPLACE FUNCTION invite_resolve_token(p_token_hash TEXT)
RETURNS TABLE (
  "id"               TEXT,
  "organizationId"   TEXT,
  "teamId"           TEXT,
  "status"           "InviteStatus",
  "expiresAt"        TIMESTAMP(3),
  "invitedById"      TEXT,
  "organizationSlug" TEXT
)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
  SELECT i."id"                AS "id",
         i."organizationId"    AS "organizationId",
         i."teamId"            AS "teamId",
         i."status"            AS "status",
         i."expiresAt"         AS "expiresAt",
         i."invitedById"       AS "invitedById",
         o."slug"              AS "organizationSlug"
  FROM "Invite" i
  JOIN "Organization" o ON o."id" = i."organizationId"
  WHERE i."tokenHash" = p_token_hash;
$$;

GRANT EXECUTE ON FUNCTION invite_resolve_token(TEXT) TO shadhil_app;

-- ── 5. Invite RLS ──────────────────────────────────────────────────────────
ALTER TABLE "Invite" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "Invite" FORCE ROW LEVEL SECURITY;

-- 5a. Org-wide read for the admin class. OWNER arrives as ADMIN at the RLS
--     layer (rls.ts downcast), so listing both is belt-and-braces.
CREATE POLICY invite_select_admin ON "Invite"
  FOR SELECT
  USING (
    "organizationId" = current_setting('app.user_org_id', true)
    AND current_setting('app.user_role', true) IN ('ADMIN', 'OWNER')
  );

-- 5b. A manager sees invites into teams they lead, and nothing else.
--     Mirrors teammember_write_manager's scope.
CREATE POLICY invite_select_manager ON "Invite"
  FOR SELECT
  USING (
    "organizationId" = current_setting('app.user_org_id', true)
    AND current_setting('app.user_role', true) = 'MANAGER'
    AND "teamId" IS NOT NULL
    AND team_manager_is_self("Invite"."teamId", current_setting('app.user_id', true))
  );

-- 5c. The invitee's own row with no JWT: matched by the token hash alone.
--     The org conjunct is belt-and-braces (tokenHash is globally unique), and
--     it keeps every arm on this table expressible as "same shape".
CREATE POLICY invite_select_token ON "Invite"
  FOR SELECT
  USING (
    "organizationId" = current_setting('app.user_org_id', true)
    AND current_setting('app.invite_token_hash', true) IS NOT NULL
    AND "tokenHash" = current_setting('app.invite_token_hash', true)
  );

-- 5d. Admin-class write (create / resend / revoke).
CREATE POLICY invite_write_admin ON "Invite"
  FOR ALL
  USING (
    "organizationId" = current_setting('app.user_org_id', true)
    AND current_setting('app.user_role', true) IN ('ADMIN', 'OWNER')
  )
  WITH CHECK (
    "organizationId" = current_setting('app.user_org_id', true)
    AND current_setting('app.user_role', true) IN ('ADMIN', 'OWNER')
  );

-- 5e. Manager write, scoped to teams they lead (create / resend / revoke).
--
--     CONFIRMED 2026-11-20: a MANAGER may also REVOKE and RESEND an invite
--     for a team they lead. That is deliberate and consistent with how a
--     manager already adds/removes TeamMember rows on their own team
--     (teammember_write_manager), i.e. they own their team's roster.
--     Residual risk, accepted: a manager can revoke a link they did not
--     create, which is a denial of an onboarding in their own team only -
--     never a cross-team or cross-org action, and it is fully audited
--     (invite.revoke carries the actor). Do NOT narrow this to admin-class
--     later without also narrowing teammember_write_manager, or the two
--     surfaces will disagree about who owns a team's people.
CREATE POLICY invite_write_manager ON "Invite"
  FOR ALL
  USING (
    "organizationId" = current_setting('app.user_org_id', true)
    AND current_setting('app.user_role', true) = 'MANAGER'
    AND "teamId" IS NOT NULL
    AND team_manager_is_self("Invite"."teamId", current_setting('app.user_id', true))
  )
  WITH CHECK (
    "organizationId" = current_setting('app.user_org_id', true)
    AND current_setting('app.user_role', true) = 'MANAGER'
    AND "teamId" IS NOT NULL
    AND team_manager_is_self("Invite"."teamId", current_setting('app.user_id', true))
  );

-- 5f. The accept path's single UPDATE: PENDING -> ACCEPTED.
--     USING pins the token AND the pre-state, so a replayed or already-
--     accepted invite is not even visible to this arm. WITH CHECK pins the
--     terminal state and the org, so acceptance cannot be abused to rewrite
--     the invite's email / role / teamId (those are not in the SET, and a
--     WITH CHECK that only names org + status refuses any attempt to move
--     them out of the invariant).
--
--     Deliberately NO "tokenHash" in WITH CHECK: the GUC is SET LOCAL and
--     stable inside the transaction, but pinning it there too would break
--     the claim if Prisma ever re-ordered the statement - and it would add
--     no security, since USING already refused a row we do not hold.
CREATE POLICY invite_update_accept ON "Invite"
  FOR UPDATE
  USING (
    current_setting('app.user_role', true) = 'INVITE_ACCEPT'
    AND "organizationId" = current_setting('app.user_org_id', true)
    AND "tokenHash" = current_setting('app.invite_token_hash', true)
    AND "status" = 'PENDING'
  )
  WITH CHECK (
    "organizationId" = current_setting('app.user_org_id', true)
    AND "status" = 'ACCEPTED'
  );

-- ── 6. The two writes the accept transaction needs ─────────────────────────
-- Acceptance runs as INVITE_ACCEPT (no JWT), so neither existing policy
-- admits it: teammember_write_admin / teammember_write_manager both key off
-- ADMIN/MANAGER, and auditlog_insert_any_authenticated checks app.user_id
-- but not the marker. These two arms are the minimum that lets the accept
-- transaction commit, and nothing more.

-- The new user's own membership, on the ONE team the invite names.
-- "userId" = app.user_id is load-bearing: it stops acceptance writing a
-- membership for anyone other than the user being created.
CREATE POLICY teammember_write_invite_accept ON "TeamMember"
  FOR INSERT
  WITH CHECK (
    current_setting('app.user_role', true) = 'INVITE_ACCEPT'
    AND "organizationId" = current_setting('app.user_org_id', true)
    AND "teamId" = current_setting('app.invite_team_id', true)
    AND "userId" = current_setting('app.user_id', true)
  );

-- The invite.accept + user.create audit rows, written in the SAME
-- transaction as the action (AGENTS.md A2/G-1).
CREATE POLICY auditlog_insert_invite_accept ON "AuditLog"
  FOR INSERT
  WITH CHECK (
    current_setting('app.user_role', true) = 'INVITE_ACCEPT'
    AND current_setting('app.user_id', true) IS NOT NULL
    AND "organizationId" = current_setting('app.user_org_id', true)
  );
