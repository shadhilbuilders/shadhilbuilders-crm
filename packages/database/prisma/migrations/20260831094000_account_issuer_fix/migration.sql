-- AR-2/B4b followup (2026-08-31): `issuer` must be NON-unique — every
-- credential account shares 'local:credential', so the unique index from the
-- previous migration would cap the CRM at one credential user. This migration
-- drops that unique index (live DB had it dropped manually, recorded via
-- prisma migrate resolve).
DROP INDEX IF EXISTS "Account_issuer_key";
