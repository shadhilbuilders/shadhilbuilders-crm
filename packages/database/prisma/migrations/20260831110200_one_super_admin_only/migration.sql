-- Hard invariant (Round 20, client-confirmed): there is EXACTLY ONE
-- SUPER_ADMIN, ever. The partial unique index makes a second one
-- impossible at the database level — even a buggy query or future
-- migration cannot create another. Prisma cannot express partial
-- indexes in schema.prisma, so this lives here only.
CREATE UNIQUE INDEX IF NOT EXISTS one_super_admin
  ON "User" ("role")
  WHERE "role" = 'SUPER_ADMIN';