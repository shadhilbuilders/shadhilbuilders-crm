// T-VISIT-REMINDER: real-DB test of the reminder cron.
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { prisma as runtimePrisma, type PrismaClient, withRlsContext } from '@shadhil/database';

import { NotificationsService } from '../notifications/notifications.service';
import { PrismaService } from '../prisma/prisma.module';
import type { RedisService } from '../redis/redis.module';

import {
  createTestTenant,
  holdCronLockForFile,
  type CronFileLock,
  type TestTenant,
} from '../test-utils/test-tenant';
import { VisitRemindersService } from './visit-reminders.service';

// Lead.phone and Lead.phoneE164 hold the same canonical digits (DB CHECK
// Lead_phone_equals_phoneE164). One evaluation feeds both columns.
const leadPhoneFields = (phone: string) => ({ phone, phoneE164: phone });

const HAS_DB = Boolean(process.env.DATABASE_URL);
const prisma: PrismaClient | null = HAS_DB ? runtimePrisma : null;
// A private organization per run (test-utils/test-tenant). This spec MUTATES the
// organization row it works against (`visitReminderLeadMinutes`), which is
// org-level configuration: on the demo org that is a shared switch two suites can
// flip on each other. The tenant also owns the one OWNER the reminder resolves.
let ORG: string;
let tenant: TestTenant;
/** Held for the whole file: a tick claims rows from EVERY org. */
let cronLock: CronFileLock;
const RUN = Date.now();
const P = `test-vrem-`;
const ids = {
  admin: `${P}admin-${RUN}`,
  exec: `${P}exec-${RUN}`,
  tc: `${P}tc-${RUN}`,
  mgr: `${P}mgr-${RUN}`,
  // one OWNER per org is enforced by the DB: seeded into this run's org.
  owner: `${P}ownr-${RUN}`,
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
    tenant = await createTestTenant('visit-reminders');
    // Before any fixture exists: see holdCronLockForFile. Another file's tick must
    // not be able to claim what this file is about to seed.
    cronLock = await holdCronLockForFile(tenant);
    ORG = tenant.organizationId;
    for (const [id, role] of [
      [ids.owner, 'OWNER'],
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
          ...leadPhoneFields(phone),
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
          ...leadPhoneFields(phone2),
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
          ...leadPhoneFields(phone3),
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
    // The hook may queue behind another file driving a global cron (see
    // holdCronLockForFile), so it needs more room than the default.
  }, 120_000);

  afterAll(async () => {
    // Release first, so the next file driving a cron stops waiting.
    await cronLock.release();
    // The org cascades to its users, team, project, leads, visits and the
    // notifications the cron wrote.
    await tenant.dispose();
  }, 120_000);

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

    // The return value is deliberately not asserted. `tick()` scans EVERY
    // organization in the database, so a suite running in parallel can process this
    // tenant's visit first and leave this tick with nothing due (it returns 0).
    // What the spec claims is that the reminder reached the right four people
    // exactly once, which holds whoever's tick delivered it - the inboxes below
    // are the assertion.
    await service.tick();

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
