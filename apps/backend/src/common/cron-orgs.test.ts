// T-CRON-MULTITENANT (2026-10-09): crons iterate organizations instead of
// trusting PUBLIC_ORG_ID. Live-DB tests for the helper and its DB function.
import { Logger } from '@nestjs/common';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import {
  prisma as runtimePrisma,
  withRlsContext,
  type PrismaClient,
} from '@shadhil/database';
import { createDirectPrismaClient } from '@shadhil/database/test-db-isolation';

import { cronContextFor, forEachOrganization, listOrganizationIds } from './cron-orgs';

const HAS_DB = Boolean(process.env.DATABASE_URL);
const prisma = runtimePrisma as unknown as PrismaClient;

describe('cronContextFor', () => {
  it('builds the cron service account context for an org', () => {
    expect(cronContextFor('org-1')).toEqual({
      userId: 'cron-service',
      role: 'CRON_SERVICE',
      organizationId: 'org-1',
    });
  });

  it('refuses an empty organization id', () => {
    expect(() => cronContextFor('')).toThrow(/organizationId is required/);
  });
});

describe.skipIf(!HAS_DB)('cron org enumeration (live DB)', () => {
  // T-CRON-MULTITENANT fixture: a freshly-reset database seeds exactly ONE
  // organization (`seed.ts` references the bootstrap org but never creates a
  // second one). This suite asserts multi-tenant behaviour, so it needs its
  // OWN second org rather than relying on whatever else happens to exist -
  // the earlier version passed only because a long-lived dev database had
  // accumulated extra orgs from manual testing, and failed the moment it ran
  // against a clean seed (CI, or `pnpm test:db:reset`).
  const ownerPrisma = createDirectPrismaClient();
  const FIXTURE_ORG_ID = 'crnorgtstfixtureorg00001';

  beforeAll(async () => {
    await ownerPrisma.organization.upsert({
      where: { id: FIXTURE_ORG_ID },
      update: {},
      create: {
        id: FIXTURE_ORG_ID,
        name: 'cron-orgs.test.ts fixture org',
        slug: FIXTURE_ORG_ID,
      },
    });
  });

  afterAll(async () => {
    await ownerPrisma.organization.deleteMany({ where: { id: FIXTURE_ORG_ID } });
  });

  it('lists every organization, not just the PUBLIC_ORG_ID one', async () => {
    const ids = await listOrganizationIds(prisma);
    expect(ids.length).toBeGreaterThanOrEqual(2);
    expect(new Set(ids).size).toBe(ids.length);
    expect(ids).toContain(FIXTURE_ORG_ID);
  });

  it('refuses callers that are not the cron service account', async () => {
    await expect(
      withRlsContext(
        prisma,
        { userId: 'someone', role: 'ADMIN', organizationId: 'x' },
        (tx) => (tx as unknown as PrismaClient).$queryRaw`SELECT cron_list_org_ids()`,
      ),
    ).rejects.toThrow(/not the cron service account|42501/);
  });

  it('refuses a CRON_SERVICE role that impersonates with another user id', async () => {
    await expect(
      withRlsContext(
        prisma,
        { userId: 'not-cron-service', role: 'CRON_SERVICE', organizationId: 'x' },
        (tx) => (tx as unknown as PrismaClient).$queryRaw`SELECT cron_list_org_ids()`,
      ),
    ).rejects.toThrow(/not the cron service account|42501/);
  });

  it('forEachOrganization visits each org once and survives one failing', async () => {
    const ids = await listOrganizationIds(prisma);
    const logger = new Logger('test');
    const errorSpy = vi.spyOn(logger, 'error').mockImplementation(() => undefined);
    const seen: string[] = [];
    const result = await forEachOrganization(prisma, logger, 'test', async (ctx, orgId) => {
      expect(ctx.organizationId).toBe(orgId);
      seen.push(orgId);
      if (orgId === ids[0]) throw new Error('boom');
    });
    expect(seen).toEqual(ids);
    expect(result).toEqual({ organizations: ids.length, failed: 1 });
    expect(errorSpy).toHaveBeenCalledWith(expect.stringContaining(ids[0] as string));
  });
});
