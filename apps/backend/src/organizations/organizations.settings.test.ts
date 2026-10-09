// T-VISIT-REMINDER: org settings access control + persistence.
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { JwtPayload } from '@shadhil/auth';
import { prisma as runtimePrisma, type PrismaClient, withRlsContext } from '@shadhil/database';

import { PrismaService } from '../prisma/prisma.module';

import { OrganizationsService } from './organizations.service';

const HAS_DB = Boolean(process.env.DATABASE_URL);
const ORG = 'ceid01lpfe1esm8jwsxid41k28';

function actor(role: JwtPayload['role']): JwtPayload {
  return {
    sub: `test-orgset-${role}`,
    email: `${role}@example.com`,
    role,
    organizationId: ORG,
    iat: 0,
    exp: 0,
    iss: 'shadhil-crm',
  };
}

describe.skipIf(!HAS_DB)('OrganizationsService settings', () => {
  const service = new OrganizationsService({
    $client: runtimePrisma as unknown as PrismaClient,
  } as PrismaService);

  const adminCtx = { userId: 'test-orgset-ADMIN', role: 'ADMIN' as const, organizationId: ORG };

  beforeAll(async () => {
    // The audit row's userId is an FK, so the acting admin must exist.
    await withRlsContext(runtimePrisma, adminCtx, async (tx) => {
      const db = tx as unknown as PrismaClient;
      await db.user.deleteMany({ where: { id: adminCtx.userId } });
      await db.user.create({
        data: {
          id: adminCtx.userId,
          email: 'test-orgset@example.com',
          name: 'orgset',
          role: 'ADMIN',
          organizationId: ORG,
        },
      });
    });
  });

  afterAll(async () => {
    await withRlsContext(runtimePrisma, adminCtx, async (tx) => {
      const db = tx as unknown as PrismaClient;
      await db.auditLog.deleteMany({ where: { userId: adminCtx.userId } });
    });
    await service.updateSettings(actor('ADMIN'), { visitReminderLeadMinutes: 60 });
    await withRlsContext(runtimePrisma, adminCtx, async (tx) => {
      const db = tx as unknown as PrismaClient;
      await db.auditLog.deleteMany({ where: { userId: adminCtx.userId } });
      await db.user.deleteMany({ where: { id: adminCtx.userId } });
    });
  });

  it('lets ADMIN change the lead time and reads it back', async () => {
    const saved = await service.updateSettings(actor('ADMIN'), { visitReminderLeadMinutes: 120 });
    expect(saved.visitReminderLeadMinutes).toBe(120);
    expect((await service.getSettings(actor('TELECALLER'))).visitReminderLeadMinutes).toBe(120);
  });

  it.each(['MANAGER', 'SALES_EXEC', 'TELECALLER'] as const)('refuses %s', async (role) => {
    await expect(
      service.updateSettings(actor(role), { visitReminderLeadMinutes: 30 }),
    ).rejects.toMatchObject({ name: 'ForbiddenException' });
  });

  it('the database rejects an out-of-range value', async () => {
    await expect(
      service.updateSettings(actor('ADMIN'), { visitReminderLeadMinutes: 1 }),
    ).rejects.toBeDefined();
  });
});
