-- Hard invariant (Round 20, client-confirmed; carried into Round 21 rename):
-- there is EXACTLY ONE OWNER, ever. The partial unique index makes a
-- second one impossible at the database level - even a buggy query or
-- future migration cannot create another. Prisma cannot express partial
-- indexes in schema.prisma, so this lives here only.
CREATE UNIQUE INDEX IF NOT EXISTS one_owner
  ON "User" ("role")
  WHERE "role" = 'OWNER';