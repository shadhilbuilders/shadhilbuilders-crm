// T-CRON-MULTITENANT (2026-10-09): crons iterate organizations instead of
// trusting PUBLIC_ORG_ID. Live-DB tests for the helper and its DB function.
import { Logger } from '@nestjs/common';
import { describe, expect, it, vi } from 'vitest';
import { prisma as runtimePrisma, withRlsContext, type PrismaClient } from '@shadhil/database';

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
  it('lists every organization, not just the PUBLIC_ORG_ID one', async () => {
    const ids = await listOrganizationIds(prisma);
    expect(ids.length).toBeGreaterThanOrEqual(2);
    expect(new Set(ids).size).toBe(ids.length);
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
