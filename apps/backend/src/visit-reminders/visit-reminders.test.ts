// T-VISIT-REMINDER: real-DB test of the reminder cron.
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { prisma as runtimePrisma, type PrismaClient, withRlsContext } from '@shadhil/database';

import { NotificationsService } from '../notifications/notifications.service';
import { PrismaService } from '../prisma/prisma.module';
import type { RedisService } from '../redis/redis.module';

import { VisitRemindersService } from './visit-reminders.service';

const HAS_DB = Boolean(process.env.DATABASE_URL);
const prisma: PrismaClient | null = HAS_DB ? runtimePrisma : null;
const ORG = 'ceid01lpfe1esm8jwsxid41k28';
const RUN = Date.now();
const P = `test-vrem-`;
const ids = {
  admin: `${P}admin-${RUN}`,
  exec: `${P}exec-${RUN}`,
  tc: `${P}tc-${RUN}`,
  mgr: `${P}mgr-${RUN}`,
  // one OWNER per org is enforced by the DB: use the org's real owner
  owner: '',
  project: `${P}proj-${RUN}`,
  team: `${P}team-${RUN}`,
  lead: `${P}lead-${RUN}`,
  lead2: `${P}lead2-${RUN}`,
  lead3: `${P}lead3-${RUN}`,
  soon: `${P}visit-soon-${RUN}`,
  later: `${P}visit-later-${RUN}`,
};

async function admin<T>(fn: (db: PrismaClient) => Promise<T>): Promise<T> {
  return withRlsContext(
    prisma!,
    { userId: ids.admin, role: 'ADMIN', organizationId: ORG },
    async (tx) => fn(tx as unknown as PrismaClient),
  );
}

async function inbox(userId: string): Promise<string[]> {
  const rows = await withRlsContext(
    prisma!,
    { userId, role: 'TELECALLER', organizationId: ORG },
    async (tx) =>
      (tx as unknown as PrismaClient).notification.findMany({
        where: { userId, type: 'visit.reminder' },
        select: { leadId: true },
      }),
  );
  return rows.map((r: { leadId: string | null }) => r.leadId ?? '');
}

async function cleanup(): Promise<void> {
  await admin(async (db) => {
    const like = `${P}%`;
    await db.$executeRawUnsafe(`DELETE FROM "SiteVisit" WHERE id LIKE $1`, like);
    await db.$executeRawUnsafe(
      `DELETE FROM "Notification" WHERE "userId" LIKE $1 OR "leadId" LIKE $1`,
      like,
    );
    await db.$executeRawUnsafe(`DELETE FROM "AuditLog" WHERE "userId" LIKE $1`, like);
    await db.$executeRawUnsafe(`DELETE FROM "Lead" WHERE id LIKE $1`, like);
    await db.$executeRawUnsafe(`DELETE FROM "Team" WHERE id LIKE $1`, like);
    await db.$executeRawUnsafe(`DELETE FROM "Project" WHERE id LIKE $1`, like);
    await db.$executeRawUnsafe(`DELETE FROM "User" WHERE id LIKE $1`, like);
  });
}

describe.skipIf(!HAS_DB)('VisitRemindersService', () => {
  vi.setConfig({ testTimeout: 60_000 });
  let service: VisitRemindersService;
  const redis = {
    acquireLock: async () => true,
    renewLease: async () => true,
    releaseLock: async () => true,
  } as unknown as RedisService;

  beforeAll(async () => {
    const ps = { $client: prisma as unknown as PrismaClient } as PrismaService;
    await cleanup();
    const owner = await admin((db) =>
      db.user.findFirst({
        where: { organizationId: ORG, role: 'OWNER', deletedAt: null },
        select: { id: true },
      }),
    );
    if (owner === null) throw new Error('fixture: org has no OWNER');
    ids.owner = owner.id;
    for (const [id, role] of [
      [ids.admin, 'ADMIN'],
      [ids.exec, 'SALES_EXEC'],
      [ids.tc, 'TELECALLER'],
      [ids.mgr, 'MANAGER'],
    ] as const) {
      await admin((db) =>
        db.user.create({
          data: { id, email: `${id}@example.com`, name: id, role, organizationId: ORG },
        }),
      );
    }
    await admin(async (db) => {
      await db.project.create({
        data: {
          id: ids.project,
          name: 'vrem',
          slug: `${P}${RUN}`,
          address: 't',
          organizationId: ORG,
        },
      });
      await db.team.create({
        data: { id: ids.team, name: `vrem ${RUN}`, managerId: ids.mgr, organizationId: ORG },
      });
      const phone = `91${String(RUN).slice(-8)}`;
      await db.lead.create({
        data: {
          id: ids.lead,
          name: 'Reminder Lead',
          phone,
          phoneE164: `9${phone}`,
          source: 'WHATSAPP',
          state: 'VISIT_SCHEDULED',
          ownerId: ids.tc,
          ownerType: 'TELECALLER',
          coOwnerId: ids.exec,
          teamId: ids.team,
          organizationId: ORG,
          projectId: ids.project,
        },
      });
      const phone2 = `92${String(RUN).slice(-8)}`;
      const phone3 = `93${String(RUN).slice(-8)}`;
      await db.lead.create({
        data: {
          id: ids.lead2,
          name: 'Reminder Lead 2',
          phone: phone2,
          phoneE164: `9${phone2}`,
          source: 'WHATSAPP',
          state: 'VISIT_SCHEDULED',
          ownerId: ids.tc,
          ownerType: 'TELECALLER',
          coOwnerId: ids.exec,
          teamId: ids.team,
          organizationId: ORG,
          projectId: ids.project,
        },
      });
      await db.lead.create({
        data: {
          id: ids.lead3,
          name: 'Reminder Lead 3',
          phone: phone3,
          phoneE164: `9${phone3}`,
          source: 'WHATSAPP',
          state: 'VISIT_SCHEDULED',
          ownerId: ids.tc,
          ownerType: 'TELECALLER',
          coOwnerId: ids.exec,
          teamId: ids.team,
          organizationId: ORG,
          projectId: ids.project,
        },
      });
    });
    service = new VisitRemindersService(ps, redis, new NotificationsService(ps));
  });

  afterAll(async () => {
    await admin((db) =>
      db.organization.update({ where: { id: ORG }, data: { visitReminderLeadMinutes: 60 } }),
    );
    await cleanup();
  });

  const seedVisit = (id: string, minutesAhead: number, leadId = ids.lead) =>
    admin((db) =>
      db.siteVisit.create({
        data: {
          id,
          leadId,
          userId: ids.exec,
          organizationId: ORG,
          status: 'SCHEDULED',
          scheduledFor: new Date(Date.now() + minutesAhead * 60_000),
        },
      }),
    );

  it('reminds exec, owner, team manager and org owner once, only inside the window', async () => {
    await admin((db) =>
      db.organization.update({ where: { id: ORG }, data: { visitReminderLeadMinutes: 60 } }),
    );
    await seedVisit(ids.soon, 30);
    await seedVisit(ids.later, 180, ids.lead2);

    const sent = await service.tick();
    expect(sent).toBeGreaterThanOrEqual(1);

    for (const who of [ids.exec, ids.tc, ids.mgr, ids.owner]) {
      expect(await inbox(who)).toContain(ids.lead);
    }

    // Second tick: no duplicate for the soon visit, and the later one is outside 60 min.
    await service.tick();
    expect(await inbox(ids.exec)).toHaveLength(1);
    const later = await admin((db) =>
      db.siteVisit.findUnique({ where: { id: ids.later }, select: { reminderSentAt: true } }),
    );
    expect(later?.reminderSentAt).toBeNull();
  });

  it('honours the per-organization lead time', async () => {
    await admin((db) =>
      db.organization.update({ where: { id: ORG }, data: { visitReminderLeadMinutes: 240 } }),
    );
    await service.tick();
    const later = await admin((db) =>
      db.siteVisit.findUnique({ where: { id: ids.later }, select: { reminderSentAt: true } }),
    );
    expect(later?.reminderSentAt).not.toBeNull();
    expect(await inbox(ids.exec)).toHaveLength(2);
  });

  it('does not remind for a closed visit', async () => {
    const closed = `${P}visit-closed-${RUN}`;
    await seedVisit(closed, 20, ids.lead3);
    await admin((db) =>
      db.siteVisit.update({ where: { id: closed }, data: { status: 'CANCELLED' } }),
    );
    await service.tick();
    const row = await admin((db) =>
      db.siteVisit.findUnique({ where: { id: closed }, select: { reminderSentAt: true } }),
    );
    expect(row?.reminderSentAt).toBeNull();
  });
});
