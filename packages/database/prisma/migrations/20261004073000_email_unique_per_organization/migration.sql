-- T-EMAIL-PER-ORG (2026-10-04): scope User.email uniqueness to the
-- organization instead of the whole database.
--
-- WHY: an ADMIN creating a user in Org A got a raw PrismaClientKnownRequest
-- Error (P2002 on the old global `User_email_key`), surfaced to the browser
-- as an unhandled "Internal server error", whenever that email already
-- existed in a COMPLETELY UNRELATED Org B. Two different organizations on
-- this platform should each be able to have their own "owner@gmail.com".
--
-- CAVEAT (accepted - see schema.prisma's comment on User.email): better-auth
-- email/password sign-in looks a user up by email alone (no org filter),
-- because /login has no org context. If the same email is ever created in
-- two different orgs, sign-in resolves to whichever row Postgres returns
-- first. No login-flow change ships in this migration to disambiguate by
-- org - accepted tradeoff per product decision (2026-10-04).
--
-- DropIndex
DROP INDEX "User_email_idx";

-- DropIndex
DROP INDEX "User_email_key";

-- CreateIndex
CREATE UNIQUE INDEX "User_email_organizationId_key" ON "User"("email", "organizationId");
