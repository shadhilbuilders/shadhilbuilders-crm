-- better-auth 1.7 auth-table columns.
--
-- better-auth 1.7 validates its own auth tables against the live schema on
-- every request and fails the whole request with "Prisma schema mismatch" when
-- a field it needs has no column. The 1.7 upgrade therefore turns five
-- previously harmless schema gaps into a hard 500 on POST /api/auth/sign-in:
--
--   user.organizationName          additionalField on the user model, set by
--                                  self-signup (createOrgForSignup reads it)
--   session.impersonatedBy         admin() plugin impersonation
--   account.accessTokenExpiresAt   per-token expiry (OAuth)
--   account.refreshTokenExpiresAt  per-token expiry (OAuth)
--   account.scope                  granted OAuth scope
--
-- Every column is nullable and none of them is read by existing code, so this
-- is additive and safe on a populated database. Table-level INSERT/UPDATE
-- GRANTs to shadhil_app already cover new columns, and no RLS policy changes.
--
-- Rendered with:
--   npx prisma migrate diff --from-migrations prisma/migrations \
--     --to-schema prisma/schema.prisma --script

-- AlterTable
ALTER TABLE "Account" ADD COLUMN     "accessTokenExpiresAt" TIMESTAMP(3),
ADD COLUMN     "refreshTokenExpiresAt" TIMESTAMP(3),
ADD COLUMN     "scope" TEXT;

-- AlterTable
ALTER TABLE "Session" ADD COLUMN     "impersonatedBy" TEXT;

-- AlterTable
ALTER TABLE "User" ADD COLUMN     "organizationName" TEXT;
