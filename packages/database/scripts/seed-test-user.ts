// ────────────────────────────────────────────────────────────────────────────
// Test-tenant seed - `pnpm --filter @shadhil/database seed:test`
// ────────────────────────────────────────────────────────────────────────────
// Creates the isolated TEST organization and fills it with the full bulk
// dataset: 121 staff users + the OWNER, 6 teams, 2 projects, 120 units,
// 144 leads (every LeadState), 144 visits (every VisitStatus), 120 bookings
// (every BookingStatus), plus activities, messages, notifications, reminders,
// consents and audit rows - enough for pagination, filters, sorting, the
// dashboards and the role-scoped screens to be exercised for real.
//
// SINGLE SOURCE OF TRUTH: the ROWS live in ./generate-test-data-sql.ts (the
// dataset), which also renders them to ./seed-test-user.sql for the psql path.
// This script only EXECUTES that same dataset through Prisma - it must never
// restate a row. Adding a table means editing the dataset, not this file.
// Regenerate the SQL with `pnpm --filter @shadhil/database seed:test:sql`.
//
// WHY A SEPARATE ORGANIZATION:
//   `User.organizationId` is single-valued (one org per user; there is no
//   membership table), and the DB enforces
//     one_owner_per_org  UNIQUE ("organizationId") WHERE role = 'OWNER'
//   i.e. EXACTLY ONE OWNER PER ORG. A second OWNER therefore cannot coexist
//   with the bootstrap org's owner - a different org is the only legal shape.
//
// RLS note: this script connects as the migration/owner role via
// DIRECT_DATABASE_URL, which is superuser + BYPASSRLS on this deployment, so
// RLS is deliberately not consulted for these provisioning writes.
//
// Idempotent: every row carries a deterministic id derived from a stable seed
// and every write is an upsert, so re-running RESETS the test data instead of
// appending. Safe to run against prod.
//
// Usage:
//   pnpm --filter @shadhil/database seed:test
//   DIRECT_DATABASE_URL=postgresql://shadhil:...@localhost:5433/shadhil_crm \
//     pnpm --filter @shadhil/database seed:test
// ────────────────────────────────────────────────────────────────────────────
import { PrismaPg } from '@prisma/adapter-pg';

import { PrismaClient } from '../src/generated/prisma/client.js';

import { buildTestDataStatements, TEST_DATA_SUMMARY } from './generate-test-data-sql.js';

const prisma: PrismaClient = new PrismaClient({
  adapter: new PrismaPg({
    connectionString: process.env.DIRECT_DATABASE_URL ?? process.env.DATABASE_URL,
  }),
});

async function main() {
  const statements = buildTestDataStatements();
  // A dataset that renders to nothing would otherwise "succeed" silently.
  if (statements.length === 0) {
    throw new Error('[seed:test] the dataset produced 0 statements - refusing to report success');
  }

  // ONE transaction, matching the .sql path (which wraps the same statements in
  // BEGIN/COMMIT): a failure part-way leaves the test org untouched rather than
  // half-seeded. `timeout` is raised because ~60 chunked upserts go through a
  // single interactive transaction.
  await prisma.$transaction(
    async (tx) => {
      for (const statement of statements) {
        await tx.$executeRawUnsafe(statement);
      }
    },
    { maxWait: 10_000, timeout: 120_000 },
  );

  const { counts } = TEST_DATA_SUMMARY;
  /* eslint-disable no-console */
  console.log(
    `[seed:test] org "${TEST_DATA_SUMMARY.orgName}" (${TEST_DATA_SUMMARY.orgSlug}, ${TEST_DATA_SUMMARY.orgId}) ready`,
  );
  console.log(
    `[seed:test] applied ${statements.length} statements: ${counts.users} users, ${counts.teams} teams, ` +
      `${counts.units} units, ${counts.leads} leads, ${counts.bookings} bookings, ${counts.visits} visits, ` +
      `${counts.activities} activities, ${counts.messages} messages, ${counts.notifications} notifications, ` +
      `${counts.reminders} reminders, ${counts.consents} consents, ${counts.audit} audit`,
  );
  console.log(
    `[seed:test] sign in as ${TEST_DATA_SUMMARY.email} / ${TEST_DATA_SUMMARY.password} (OWNER of the test org); ` +
      `every seeded staff account shares that password, so any role can be exercised`,
  );
  console.log(
    `[seed:test] entry: /${TEST_DATA_SUMMARY.orgSlug}/projects/test-villas and /${TEST_DATA_SUMMARY.orgSlug}/projects/test-greens`,
  );
  /* eslint-enable no-console */

  await prisma.$disconnect();
}

main().catch(async (err) => {
  // eslint-disable-next-line no-console
  console.error('[seed:test] failed:', err instanceof Error ? err.message : err);
  await prisma.$disconnect().catch(() => undefined);
  process.exit(1);
});
