// Migration 20261009010100_activity_backfill: replays AuditLog rows into
// "Activity". Verifies content, that createdAt/userId are preserved, and that a
// second run inserts nothing. Runs against the isolated test DB (setup.ts).
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { createDirectPrismaClient } from '../src/test-db-isolation';

import { DATABASE_AVAILABLE } from './setup';

const ORG = 'ceid01lpfe1esm8jwsxid41k28';
const RUN = `bf${Date.now()}`;
const MIGRATION = resolve(
  __dirname,
  '../prisma/migrations/20261009010100_activity_backfill/migration.sql',
);

const adminPrisma = createDirectPrismaClient();

const ids = {
  team: `${RUN}-team`,
  project: `${RUN}-proj`,
  actor: `${RUN}-actor`,
  other: `${RUN}-other`,
  lead: `${RUN}-lead`,
  visit: `${RUN}-visit`,
};
const T0 = new Date('2026-09-01T10:00:00.000Z');

function runMigration(): void {
  const url = (process.env.DIRECT_DATABASE_URL ?? '').split('?')[0];
  execFileSync('psql', [url, '-v', 'ON_ERROR_STOP=1', '-q', '-f', MIGRATION], {
    stdio: 'pipe',
  });
}

async function backfilled() {
  return adminPrisma.activity.findMany({
    where: { leadId: ids.lead },
    orderBy: { createdAt: 'asc' },
  });
}

describe.skipIf(!DATABASE_AVAILABLE)('activity backfill migration', () => {
  beforeAll(async () => {
    for (const [id, name] of [
      [ids.actor, 'Backfill Actor'],
      [ids.other, 'Backfill Other'],
    ] as const) {
      await adminPrisma.user.create({
        data: {
          id,
          email: `${id}@test.local`,
          name,
          role: 'TELECALLER',
          organizationId: ORG,
          mustChangePassword: false,
        },
      });
    }
    await adminPrisma.team.create({
      data: { id: ids.team, name: `bf team ${RUN}`, organizationId: ORG },
    });
    await adminPrisma.project.create({
      data: {
        id: ids.project,
        name: `bf ${RUN}`,
        slug: ids.project,
        address: 'x',
        organizationId: ORG,
      },
    });
    await adminPrisma.lead.create({
      data: {
        id: ids.lead,
        name: 'Backfill Lead',
        phone: `91${RUN.slice(-9)}`,
        phoneE164: `91${RUN.slice(-9)}`,
        source: 'WEBSITE',
        state: 'CONTACTED',
        teamId: ids.team,
        ownerId: ids.actor,
        ownerType: 'TELECALLER',
        organizationId: ORG,
        projectId: ids.project,
      },
    });
    await adminPrisma.siteVisit.create({
      data: {
        id: ids.visit,
        leadId: ids.lead,
        userId: ids.other,
        scheduledFor: new Date('2026-10-12T10:30:00.000Z'), // 4:00 pm IST
        status: 'SCHEDULED',
        organizationId: ORG,
      },
    });
    const at = (m: number) => new Date(T0.getTime() + m * 60_000);
    const audit = (
      n: number,
      action: string,
      entityType: string,
      entityId: string,
      extra: Record<string, unknown>,
    ) =>
      adminPrisma.auditLog.create({
        data: {
          id: `${RUN}-a${n}`,
          userId: ids.actor,
          organizationId: ORG,
          action,
          entityType,
          entityId,
          createdAt: at(n),
          ...extra,
        },
      });
    await audit(1, 'lead.create', 'Lead', ids.lead, {
      after: { source: 'WEBSITE', ownerId: ids.actor },
    });
    await audit(2, 'lead.transition', 'Lead', ids.lead, {
      before: { state: 'NEW' },
      after: { state: 'CONTACTED' },
      reason: 'Picked up',
    });
    await audit(3, 'lead.reassign', 'Lead', ids.lead, {
      before: { ownerId: ids.actor },
      after: { ownerId: ids.other },
      reason: 'Balance',
    });
    await audit(4, 'lead.co_owner.noop', 'Lead', ids.lead, {
      before: { coOwnerId: null },
      after: { coOwnerId: null },
    });
    await audit(5, 'visit.create', 'SiteVisit', ids.visit, {});
    // Skipped: no actor.
    await adminPrisma.auditLog.create({
      data: {
        id: `${RUN}-a6`,
        userId: null,
        organizationId: ORG,
        action: 'lead.transition',
        entityType: 'Lead',
        entityId: ids.lead,
        before: { state: 'NEW' },
        after: { state: 'LOST' },
        createdAt: at(6),
      },
    });
  }, 30_000);

  afterAll(async () => {
    await adminPrisma.auditLog.deleteMany({ where: { id: { startsWith: RUN } } });
    await adminPrisma.activity.deleteMany({ where: { leadId: ids.lead } });
    await adminPrisma.siteVisit.deleteMany({ where: { id: ids.visit } });
    await adminPrisma.lead.deleteMany({ where: { id: ids.lead } });
    await adminPrisma.project.deleteMany({ where: { id: ids.project } });
    await adminPrisma.team.deleteMany({ where: { id: ids.team } });
    await adminPrisma.user.deleteMany({ where: { id: { in: [ids.actor, ids.other] } } });
  }, 30_000);

  it('is readable (sanity: migration file exists)', () => {
    expect(readFileSync(MIGRATION, 'utf8')).toContain('INSERT INTO "Activity"');
  });

  it('replays audit rows with friendly text, preserving createdAt and userId', async () => {
    runMigration();
    const rows = await backfilled();
    expect(rows.map((r) => [r.type, r.body])).toEqual([
      ['STATUS_CHANGE', 'Lead created (WEBSITE), assigned to Backfill Actor'],
      ['STATUS_CHANGE', 'New -> Talked - Picked up'],
      ['ASSIGNMENT', 'Reassigned from Backfill Actor to Backfill Other - Balance'],
      ['VISIT', 'Visit booked for 12 Oct, 4:00 pm with Backfill Other'],
    ]);
    expect(rows[1].createdAt.toISOString()).toBe(
      new Date(T0.getTime() + 2 * 60_000).toISOString(),
    );
    expect(rows.every((r) => r.userId === ids.actor && r.organizationId === ORG)).toBe(true);
  });

  it('a second run inserts nothing', async () => {
    const before = (await backfilled()).length;
    runMigration();
    expect((await backfilled()).length).toBe(before);
  });
});
