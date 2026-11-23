// Per-suite tenant for DB-backed specs (2026-11-23).
//
// WHY: every DB-backed suite seeded into the SAME demo organization, so rows that
// are per-ORG - the storage ledgers, reminder scans, outbox drains, "who is the
// org's admin" lookups - were shared state between suites. Vitest runs files in
// parallel against one database, so a spec that counts org-wide rows or moves an
// org-wide counter read another file's writes. Three concurrent full suites failed
// 8, 11 and 6 tests that way; the same specs were green one at a time.
//
// The fix is the tenant boundary the app already enforces: RLS is scoped to
// app.user_org_id, so a private organization per suite means another file's rows
// are invisible at the POLICY layer, not filtered out by discipline in each spec.
// Nothing test-only leaks into a business path.
//
// Org, not project: the failures are per-ORG rows (StorageUsage is one row per
// organization; the overdue scan and the outbox are scanned org-wide). A new
// project inside the shared org would still collide on those. Specs keep their
// per-test project ids for routing semantics, but the ORGANIZATION is the unit of
// isolation.
//
// TEARDOWN IS NOT ONE DELETE. `Organization` is FORCE-RLS and seven of its children
// are ON DELETE RESTRICT (User, Team, Lead, Booking, AuditLog, LeadFact,
// WhatsappUnknownContact), so `deleteMany` on the org removes nothing and reports
// success - it silently leaked 73 orgs into the test database before this was
// found. `purgeOrganization` deletes the RESTRICT children in dependency order and
// then the org, letting the cascades take the rest. Everything else about the org
// (projects, phases, units, messages, outbound rows, deliveries, notifications,
// visits) really is Cascade.
import { createId } from '@paralleldrive/cuid2';
import type { PrismaClient } from '@shadhil/database';
import { createDirectPrismaClient } from '@shadhil/database/test-db-isolation';

export type TestTenant = {
  organizationId: string;
  /**
   * Bypass-RLS (owner role) client for fixtures and for reading rows back.
   * Tests that mean to exercise RLS must still go through `withRlsContext` with
   * a tenant-scoped actor; this client is the setup and teardown path only.
   */
  admin: PrismaClient;
  dispose: () => Promise<void>;
};

/**
 * Children of Organization that block its delete, in an order that respects their
 * own FKs: a lead holds owner/coOwner FKs into User, a booking holds a lead, and
 * LeadFact holds a lead. Deleting User first fails on Lead_ownerId_fkey.
 *
 * Verified against the live test database, not from the schema's intent: the org
 * delete fails on whichever of these is still populated.
 */
const ORG_RESTRICT_CHILDREN = [
  'LeadFact',
  'Booking',
  'Lead',
  'Team',
  'User',
  'AuditLog',
  'WhatsappUnknownContact',
] as const;

/**
 * Remove an organization and everything under it. Uses the owner-role client, which
 * is a superuser on the test database, so FORCE-RLS does not filter the deletes.
 */
export async function purgeOrganization(
  admin: PrismaClient,
  organizationId: string,
): Promise<boolean> {
  for (const table of ORG_RESTRICT_CHILDREN) {
    await admin.$executeRawUnsafe(
      `DELETE FROM "${table}" WHERE "organizationId" = $1`,
      organizationId,
    );
  }
  const deleted = await admin.$executeRawUnsafe(
    `DELETE FROM "Organization" WHERE "id" = $1`,
    organizationId,
  );
  return deleted > 0;
}

const CRON_TICK_LOCK_KEY = 'shadhil-test-cron-tick';

/**
 * Hold the cron advisory lock for a whole FILE: from beforeAll to afterAll.
 *
 * A tenant isolates ROWS, not WORK. The cron services scan and claim every
 * organization in the database, so a file that seeds a PENDING outbound row while
 * another file's tick is running has that row claimed, sent and stamped by the
 * other file. `withCronTickLock` around one tick cannot fix that: the other file's
 * tick still picks up what this one seeded in between.
 *
 * So a file that drives a global cron takes the lock BEFORE it seeds and releases
 * it AFTER teardown. That is the property production has - one cron replica ticking
 * at a time, held by the Redis lease. Files queue behind each other instead of
 * racing.
 *
 * Transaction-scoped (`pg_advisory_xact_lock`), see `withCronTickLock` for why. The
 * open transaction is only what holds the lock: it reads nothing, so it cannot
 * block the fixtures other connections write.
 */
export type CronFileLock = { release: () => Promise<void> };

export async function holdCronLockForFile(tenant: TestTenant): Promise<CronFileLock> {
  let openGate: () => void = () => undefined;
  let acquired: () => void = () => undefined;
  const gate = new Promise<void>((resolve) => {
    openGate = resolve;
  });
  const holding = new Promise<void>((resolve) => {
    acquired = resolve;
  });

  const inTransaction = tenant.admin.$transaction(
    async (tx) => {
      await tx.$executeRawUnsafe(`SELECT pg_advisory_xact_lock(hashtext('${CRON_TICK_LOCK_KEY}'))`);
      acquired();
      await gate;
    },
    // The transaction lasts as long as the file does, so it must not time out.
    { timeout: 1_800_000, maxWait: 1_800_000 },
  );

  await holding;
  // Now that no other cron file can be mid-run, clear what killed runs left
  // behind. A crashed or timed-out run never reaches dispose(), and its tenant's
  // PENDING outbound rows are exactly what the next tick claims - which is how a
  // "claims 1 row" assertion saw claimed=2 while every run was green on its own.
  await sweepStaleTestOrgs(tenant);
  return {
    release: async () => {
      openGate();
      await inTransaction.catch(() => undefined);
    },
  };
}

/**
 * Delete tenants left behind by a run that never reached dispose() (crash, timeout,
 * ctrl-c). Scoped to orgs this helper created (`test-*` slugs), excludes the
 * caller's own, and only takes orgs older than five minutes so a live parallel file
 * is never swept. Returns how many orgs went.
 *
 * The age window is the weak part and it is on purpose: there is no marker that
 * tells a crashed run's tenant from a live one, and the alternative (purge every
 * other test org while holding the cron lock) would delete rows out from under the
 * non-cron specs that write outbound rows - webhooks.controller and
 * site-update-delivery do. So a crash inside the window can still leave a PENDING
 * row for the next cron file's tick to claim; five minutes keeps that unlikely
 * without touching a live file. A marker on the org row would remove the guess.
 */
export async function sweepStaleTestOrgs(tenant: TestTenant): Promise<number> {
  const stale = await tenant.admin.$queryRawUnsafe<Array<{ id: string }>>(
    `SELECT "id" FROM "Organization"
      WHERE "slug" LIKE 'test-%'
        AND "id" <> $1
        AND "createdAt" < now() - interval '5 minutes'`,
    tenant.organizationId,
  );
  let purged = 0;
  for (const row of stale) {
    if (await purgeOrganization(tenant.admin, row.id)) purged += 1;
  }
  return purged;
}

/**
 * Serialise a cron `tick()` across test PROCESSES.
 *
 * Only for a file whose rows are private to it. If the file seeds rows that a tick
 * would claim, use `holdCronLockForFile` instead - this stops two ticks overlapping
 * but not another file's tick consuming what this one seeded.
 *
 * The cron specs stub the Redis lease to always grant, so two suites ticking at
 * once both run and then race on the same rows: one stamps what the other is about
 * to send, a duplicate slips past the cadence stamp, an inbox read lands between the
 * two. Production is serialised by that lease; the stub removes it, so the test
 * takes a Postgres advisory lock instead - cross-process by construction, because
 * the lock lives in the database both processes share.
 *
 * Transaction-scoped on purpose: a session-scoped lock would be taken on one
 * pooled connection and released on another, leaving it held.
 */
export async function withCronTickLock<T>(tenant: TestTenant, fn: () => Promise<T>): Promise<T> {
  return tenant.admin.$transaction(
    async (tx) => {
      await tx.$executeRawUnsafe(`SELECT pg_advisory_xact_lock(hashtext('${CRON_TICK_LOCK_KEY}'))`);
      return fn();
    },
    { timeout: 120_000 },
  );
}

/**
 * Create an isolated organization for one suite. `label` only shapes the name and
 * slug, so a failing database is readable ("test-org outbound-cron-...").
 */
export async function createTestTenant(label: string): Promise<TestTenant> {
  const admin = createDirectPrismaClient();
  const organizationId = createId();
  const slug = `test-${label}-${organizationId}`.toLowerCase().replace(/[^a-z0-9-]/g, '-');

  await admin.organization.create({
    data: { id: organizationId, name: `Test org ${label}`, slug },
  });

  return {
    organizationId,
    admin,
    dispose: async () => {
      try {
        const deleted = await purgeOrganization(admin, organizationId);
        // A leak here is invisible until a cron claims another run's rows, so say so
        // instead of swallowing it.
        if (!deleted) throw new Error(`test tenant ${organizationId} was already gone`);
      } finally {
        await admin.$disconnect().catch(() => undefined);
      }
    },
  };
}
