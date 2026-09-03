-- Round 25 fix part 2: the Jwks table was added in migration
-- 20260831140000_add_jwks without GRANTs for shadhil_app. Better-auth's
-- jwt() plugin reads/writes it on the pooled URL (DATABASE_URL → shadhil_app),
-- so every /api/auth/get-session and /api/auth/token request failed with
-- `42501 permission denied for table Jwks`. Sign-in itself worked because
-- it only touched User/Session/Account/Verification (granted in init).
--
-- This migration applies the missing GRANTs. Idempotent at the role level.
GRANT SELECT, INSERT, UPDATE, DELETE ON "Jwks" TO shadhil_app;