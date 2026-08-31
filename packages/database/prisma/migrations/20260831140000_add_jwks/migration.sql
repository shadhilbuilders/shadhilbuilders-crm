-- Jwks — required by better-auth's jwt() plugin. Its absence made every
-- GET /api/auth/get-session throw "Model jwks does not exist" (500), which
-- broke authClient.useSession() across the web UI. Column set follows
-- better-auth 1.7's jwt() plugin schema: publicKey/privateKey/createdAt
-- required; the rest nullable but written even in HS256/EdDSA lazy-key mode.
-- NOTE: column order matches prisma db push's alphabetical layout so
-- existing dev databases (already pushed manually) are identical to what
-- `migrate deploy` would create.
CREATE TABLE "Jwks" (
    "id" TEXT NOT NULL,
    "publicKey" TEXT NOT NULL,
    "privateKey" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "alg" TEXT,
    "crv" TEXT,
    "e" TEXT,
    "expiresAt" TIMESTAMP(3),
    "kid" TEXT,
    "kty" TEXT,
    "n" TEXT,
    "use" TEXT,

    CONSTRAINT "Jwks_pkey" PRIMARY KEY ("id")
);