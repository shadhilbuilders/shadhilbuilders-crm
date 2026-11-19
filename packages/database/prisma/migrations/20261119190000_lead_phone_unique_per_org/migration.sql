-- T-PHONE-PER-ORG (2026-11-19, owner ruling).
--
-- Lead.phone and Lead.phoneE164 were GLOBALLY unique. That made the tenant
-- model a lie: the same buyer enquiring about two builders' projects was
-- rejected on the second one, and the public landing endpoint answered
-- 409 DUPLICATE_VALUE for any number that already existed anywhere in the
-- CRM - including the sandbox org, which is why the production org had zero
-- leads while 27 landing enquiries sat in `test`.
--
-- A phone identifies a person; the tenant axis is what must not repeat.
-- No data migration is required: the indexes being dropped were stronger than
-- the ones replacing them, so no existing pair of rows can violate these.
--
-- NULL phoneE164 rows do not collide - Postgres treats NULLs as distinct in a
-- unique index, same as before.

DROP INDEX IF EXISTS "Lead_phone_key";
DROP INDEX IF EXISTS "Lead_phoneE164_key";

CREATE UNIQUE INDEX "Lead_organizationId_phone_key" ON "Lead"("organizationId", "phone");
CREATE UNIQUE INDEX "Lead_organizationId_phoneE164_key" ON "Lead"("organizationId", "phoneE164");
