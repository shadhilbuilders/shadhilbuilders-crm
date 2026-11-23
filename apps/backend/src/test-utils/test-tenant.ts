// Per-suite tenant for DB-backed specs (2026-11-23).
//
// WHY: every DB-backed suite seeds into the SAME demo organization, so rows that
// are per-ORG - the storage ledgers, reminder scans, outbox drains, "who is the
// org's admin" lookups - are shared state between suites. Vitest runs files in
// parallel against one database, so a spec that counts org-wide rows or moves an
// org-wide counter reads another file's writes. Three concurrent full suites
// failed 8, 11 and 6 tests that way; the same specs are green one at a time.
//
// The fix is the tenant boundary the app already enforces: RLS is scoped to
// app.user_org_id, so a private organization per suite means another file's rows
// are invisible at the POLICY layer, not filtered out by discipline in each spec.
// Nothing test-only leaks into a business path.
//
// Org, not project: the failures are per-ORG rows (StorageUsage is one row per
// organization; overdue reminders and the outbox are scanned org-wide). A new
// project inside the shared org would still collide on those. Specs keep their
// per-test project ids for routing semantics, but the ORGANIZATION is the unit
// of isolation.
//
// Cleanup is one DELETE: every Organization relation is onDelete: Cascade, so
// dropping the org takes its projects, users, ledgers and rows with it. Called
// from afterAll; a killed run leaves an org behind, which is inert (nothing scans
// for it) and reaped by the next full reset of the test database.
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
 * Serialise a cron `tick()` across test PROCESSES.
 *
 * The cron specs drive services that scan EVERY organization, and they stub the
 * Redis lock to always grant. Two suites ticking at once therefore both run, and
 * then race each other on the same rows: one stamps what the other is about to
 * send, a duplicate slips past the cadence stamp, an inbox read lands between the
 * two. Production is serialised by the Redis lock; the stub removes it, so the
 * test takes a Postgres advisory lock instead - cross-process by construction,
 * because the lock lives in the database both processes share.
 *
 * Transaction-scoped on purpose: a session-scoped lock would be taken on one
 * pooled connection and released on another, leaving it held.
 */
export async function withCronTickLock<T>(tenant: TestTenant, fn: () => Promise<T>): Promise<T> {
  return tenant.admin.$transaction(
    async (tx) => {
      await tx.$executeRawUnsafe(
        `SELECT pg_advisory_xact_lock(hashtext('shadhil-test-cron-tick'))`,
      );
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
      // Best effort: a suite that already dropped something must not fail teardown,
      // and the cascade handles the rest of the org's rows.
      await admin.organization.deleteMany({ where: { id: organizationId } }).catch(() => undefined);
      await admin.$disconnect().catch(() => undefined);
    },
  };
}
