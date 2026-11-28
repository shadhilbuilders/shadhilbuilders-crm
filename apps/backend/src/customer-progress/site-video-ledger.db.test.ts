// Site video byte ledgers against the REAL database (site update video, step 5).
//
// protects= both caps hold under concurrency (two records racing for the last
// bytes cannot both win), a cap failure names the full scope and leaves NEITHER
// ledger moved, a credit never goes below zero, and a CUSTOMER cannot charge.
// fails_when= the conditional UPDATE is replaced by read-then-write, the org row
// is charged and left charged when the project cap refuses, or a credit
// underflows.
// no_claim= nothing about the routes; this is the arithmetic and the RLS.
// Skips cleanly with no DATABASE_URL, like the other DB-backed suites.
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { createId } from '@paralleldrive/cuid2';
import { prisma as runtimePrisma, withRlsContext, type PrismaClient } from '@shadhil/database';
import { assertHeadroom, chargeLedgers, creditLedgers } from './site-video-ledger';
import { createTestTenant, type TestTenant } from '../test-utils/test-tenant';

const HAS_DB = Boolean(process.env.DATABASE_URL);
const MB = 1_048_576;

const PROJECT = createId();
const OTHER_PROJECT = createId();
const caps = { orgCapBytes: 100 * MB, projectCapBytes: 30 * MB };

// A private org per run (test-utils/test-tenant). The org ledger is ONE row per
// organization, so sharing the demo org meant a suite running alongside this one
// moved the same counter: "expected {org: 36700160} to equal {org: 26214400}".
// The organization is the isolation unit, not the project - that counter is
// org-scoped, and so are the caps it is checked against.
let tenant: TestTenant;
let ORG: string;
const scope = () => ({ organizationId: ORG, projectId: PROJECT });
const staff = () => ({ userId: 'ledger-test-user', role: 'ADMIN' as const, organizationId: ORG });
const buyer = () => ({
  userId: 'ledger-test-buyer',
  role: 'CUSTOMER' as const,
  organizationId: ORG,
});

describe.skipIf(!HAS_DB)('site video ledgers (live database)', () => {
  const prisma = runtimePrisma as PrismaClient;
  const admin = () => tenant.admin;

  async function wipe(): Promise<void> {
    await admin().projectStorageUsage.deleteMany({
      where: { projectId: { in: [PROJECT, OTHER_PROJECT] } },
    });
    await admin().storageUsage.deleteMany({ where: { organizationId: ORG } });
  }
  async function used(): Promise<{ org: bigint; project: bigint }> {
    const org = await admin().storageUsage.findUnique({ where: { organizationId: ORG } });
    const project = await admin().projectStorageUsage.findUnique({ where: { projectId: PROJECT } });
    return { org: org?.usedBytes ?? 0n, project: project?.usedBytes ?? 0n };
  }

  beforeAll(async () => {
    tenant = await createTestTenant('site-video-ledger');
    ORG = tenant.organizationId;
    for (const id of [PROJECT, OTHER_PROJECT]) {
      await admin().project.create({
        data: { id, name: `ledger ${id}`, slug: `ledger-${id}`, address: 'x', organizationId: ORG },
      });
    }
  });
  beforeEach(wipe);
  afterAll(async () => {
    // Deleting the org cascades: both projects, both ledger rows, everything.
    await tenant.dispose();
  });

  const charge = (bytes: number, s = scope(), ctx = staff()) =>
    withRlsContext(prisma, ctx, (tx) => chargeLedgers(tx, s, bytes, caps));

  it('charges both ledgers and creates the rows on first use', async () => {
    await charge(10 * MB);
    expect(await used()).toEqual({ org: BigInt(10 * MB), project: BigInt(10 * MB) });
  });

  it('refuses the charge that would pass the PROJECT cap, and moves nothing', async () => {
    await charge(25 * MB);
    await expect(charge(10 * MB)).rejects.toMatchObject({
      response: { code: 'VIDEO_STORAGE_CAP_REACHED', details: { scope: 'PROJECT' } },
    });
    // The org row was incremented first inside the same transaction: it must
    // have rolled back with the failure.
    expect(await used()).toEqual({ org: BigInt(25 * MB), project: BigInt(25 * MB) });
  });

  it('does not refuse a project past the old ceiling when no project cap is set', async () => {
    const unlimited = { orgCapBytes: 100 * MB, projectCapBytes: null };
    const chargeUnlimited = (bytes: number) =>
      withRlsContext(prisma, staff(), (tx) => chargeLedgers(tx, scope(), bytes, unlimited));
    await chargeUnlimited(25 * MB);
    await chargeUnlimited(20 * MB); // 45 MB: past the 30 MB ceiling the other cases use
    expect(await used()).toEqual({ org: BigInt(45 * MB), project: BigInt(45 * MB) });
    // The org cap is still the wall, and it still rolls both rows back.
    await admin().storageUsage.update({
      where: { organizationId: ORG },
      data: { usedBytes: BigInt(100 * MB) },
    });
    await expect(chargeUnlimited(1 * MB)).rejects.toMatchObject({
      response: { details: { scope: 'ORGANIZATION' } },
    });
  });

  it('grant-time headroom ignores a project cap that is not set', async () => {
    const unlimited = { orgCapBytes: 100 * MB, projectCapBytes: null };
    await expect(
      withRlsContext(prisma, staff(), (tx) => assertHeadroom(tx, scope(), 60 * MB, unlimited)),
    ).resolves.toBeUndefined();
    await expect(
      withRlsContext(prisma, staff(), (tx) => assertHeadroom(tx, scope(), 200 * MB, unlimited)),
    ).rejects.toMatchObject({ response: { details: { scope: 'ORGANIZATION' } } });
  });

  it('refuses the charge that would pass the ORG cap even when the project has room', async () => {
    // Fill the org with another project's bytes.
    await withRlsContext(prisma, staff(), (tx) =>
      chargeLedgers(tx, { organizationId: ORG, projectId: OTHER_PROJECT }, 30 * MB, {
        orgCapBytes: 100 * MB,
        projectCapBytes: 100 * MB,
      }),
    );
    await admin().storageUsage.update({
      where: { organizationId: ORG },
      data: { usedBytes: BigInt(95 * MB) },
    });
    await expect(charge(10 * MB)).rejects.toMatchObject({
      response: { details: { scope: 'ORGANIZATION' } },
    });
    expect((await used()).project).toBe(0n);
  });

  it('lets exactly one of two racing records take the last bytes', async () => {
    await charge(20 * MB);
    const results = await Promise.allSettled([charge(8 * MB), charge(8 * MB)]);
    expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
    expect(results.filter((r) => r.status === 'rejected')).toHaveLength(1);
    expect((await used()).project).toBe(BigInt(28 * MB));
  });

  it('survives many racing charges without ever passing the cap', async () => {
    const results = await Promise.allSettled(Array.from({ length: 12 }, () => charge(5 * MB)));
    const ok = results.filter((r) => r.status === 'fulfilled').length;
    expect(ok).toBe(6); // 6 x 5MB = the 30MB project cap, exactly
    expect((await used()).project).toBe(BigInt(30 * MB));
  });

  it('credits both ledgers and never goes below zero', async () => {
    await charge(10 * MB);
    await withRlsContext(prisma, staff(), (tx) => creditLedgers(tx, scope(), 4 * MB));
    expect(await used()).toEqual({ org: BigInt(6 * MB), project: BigInt(6 * MB) });
    await withRlsContext(prisma, staff(), (tx) => creditLedgers(tx, scope(), 999 * MB));
    expect(await used()).toEqual({ org: 0n, project: 0n });
  });

  it('assertHeadroom refuses when one more maximum clip would not fit', async () => {
    await charge(25 * MB);
    await expect(
      withRlsContext(prisma, staff(), (tx) => assertHeadroom(tx, scope(), 10 * MB, caps)),
    ).rejects.toMatchObject({ response: { details: { scope: 'PROJECT' } } });
    await expect(
      withRlsContext(prisma, staff(), (tx) => assertHeadroom(tx, scope(), 4 * MB, caps)),
    ).resolves.toBeUndefined();
  });

  it('assertHeadroom treats a never-used project as empty', async () => {
    await expect(
      withRlsContext(prisma, staff(), (tx) => assertHeadroom(tx, scope(), 10 * MB, caps)),
    ).resolves.toBeUndefined();
  });

  it('denies a CUSTOMER charging the ledger, and leaves it untouched', async () => {
    await expect(charge(1 * MB, scope(), buyer() as never)).rejects.toThrow();
    expect(await used()).toEqual({ org: 0n, project: 0n });
  });
});
