// Visit notifications - reschedule + outcome (2026-09-29, owner request).
//
// OWNER REQUIREMENT: "if visit reschedule is reschedule team manager and
// admin/owner should know do push notification and inapp notification".
//
// WHAT THIS SUITE IS FOR. Both writes previously emitted NOTHING - `reschedule`
// and `updateOutcome` created no Notification row at all, so a visit could slide
// repeatedly and the people accountable for it never found out. These tests pin
// the recipient SET and the exclusion of the actor, because those are the parts
// that are easy to get subtly wrong and impossible to see from the UI.
//
// REAL DB, no mocks on the notification path: `emit` writes a real Notification
// row through its own `withRlsContext` transaction, and a mocked prisma cannot
// tell us whether the row landed or which `userId` it carries.
//
// TWO RLS FACTS THIS SUITE HAS TO RESPECT (learned the hard way here - the first
// version of this file failed on both):
//
//   1. `notification_select_owner` requires `userId = app.user_id`. So NOTHING
//      can read another user's notifications - not even an ADMIN. Asserting
//      delivery therefore means opening the RLS context AS THE RECIPIENT, which
//      is exactly what the real inbox does. Reading as the seeding admin returns
//      an empty list and looks identical to "no notification was sent".
//   2. `site_visit_select_team` / `site_visit_write_team` admit a MANAGER only
//      via `Team.managerId` for the LEAD'S team. An arbitrary manager in the same
//      org cannot see or reschedule the visit at all - so the reschedule actor
//      here leads the lead's team, and a SECOND team on the same project supplies
//      a different manager as a recipient.
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import type { JwtPayload } from '@shadhil/auth';
import { prisma as runtimePrisma, type PrismaClient, withRlsContext } from '@shadhil/database';

import { LeadsService } from '../leads/leads.service';
import { NotificationsService } from '../notifications/notifications.service';
import { PrismaService } from '../prisma/prisma.module';

import { VisitsService } from './visits.service';

const HAS_DB = Boolean(process.env.DATABASE_URL);
const prisma: PrismaClient | null = HAS_DB ? runtimePrisma : null;

// Must match PUBLIC_ORG_ID: NotificationsService.emit writes
// `organizationId: process.env['PUBLIC_ORG_ID']`, and the insert policy compares
// it to the context's org, so a different org would silently insert nothing.
const ORG_ID = 'ceid01lpfe1esm8jwsxid41k28';

const RUN = Date.now();
const PROJECT_ID = `test-vnotif-proj-${RUN}`;
/** The lead's team - its manager reschedules, so they can also SEE the visit. */
const LEAD_TEAM_ID = `test-vnotif-teamA-${RUN}`;
/** A second team on the same project: its manager is a recipient, not an actor. */
const OTHER_TEAM_ID = `test-vnotif-teamB-${RUN}`;
const MANAGER_ID = `test-vnotif-mgr-${RUN}`;
const ADMIN_ID = `test-vnotif-admin-${RUN}`;
/** Leads the lead's team - the reschedule ACTOR. Must not be notified themself. */
const ACTOR_ID = `test-vnotif-actor-${RUN}`;
/** The lead's owner (a telecaller who booked the visit). */
const OWNER_ID = `test-vnotif-owner-${RUN}`;
/** The visit's assignee - conducts it and records the outcome. */
const EXEC_ID = `test-vnotif-exec-${RUN}`;

const SEEDED_USERS = [MANAGER_ID, ADMIN_ID, ACTOR_ID, OWNER_ID, EXEC_ID];
const CREATED_LEAD_IDS: string[] = [];
const CREATED_VISIT_IDS: string[] = [];

function actorFor(userId: string, role: JwtPayload['role']): JwtPayload {
  return {
    sub: userId,
    email: `${userId}@example.com`,
    role,
    organizationId: ORG_ID,
    iat: 0,
    exp: 0,
    iss: 'shadhil-crm',
  };
}

/** Seeding/cleanup as the org admin (bypasses the per-row read policies). */
async function adminSeed<T>(fn: (db: PrismaClient) => Promise<T>): Promise<T> {
  if (prisma === null) throw new Error('prisma missing');
  return withRlsContext(
    prisma,
    { userId: ADMIN_ID, role: 'ADMIN', organizationId: ORG_ID },
    async (tx) => fn(tx as unknown as PrismaClient),
  );
}

/**
 * A recipient's notifications - read AS THAT RECIPIENT, because
 * `notification_select_owner` admits nobody else's rows (see note 1 above).
 */
async function notificationsFor(
  userId: string,
  role: JwtPayload['role'] = 'TELECALLER',
): Promise<{ type: string; title: string }[]> {
  if (prisma === null) return [];
  return withRlsContext(
    prisma,
    { userId, role, organizationId: ORG_ID },
    async (tx) =>
      (tx as unknown as PrismaClient).notification.findMany({
        where: { userId },
        orderBy: { createdAt: 'desc' },
        select: { type: true, title: true },
      }),
  ) as Promise<{ type: string; title: string }[]>;
}

/**
 * Poll until `predicate` holds, so a slow emit cannot make the suite flaky.
 *
 * T-NOTIF-WAIT-BUDGET (2026-09-30): the budget is 8s, not 2.5s.
 *
 * It was `for (i < 25) { …; await sleep(100) }` - a hard 2.5s ceiling assuming
 * the notification is committed almost immediately. That holds when the file runs
 * alone (4/4 green, ~1s of polling). It does NOT hold inside the full parallel
 * `pnpm test` run: turbo starts one worker per core, the backend's test phase
 * measured 176s vs ~130s in isolation, and the emit is FIRE-AND-FORGET - see
 * `emitToMany`, which does `void this.notifications.emit(...)` so the write lands
 * strictly after `reschedule()` returns and after the row lock is released. Under
 * contention that easily exceeds 2.5s.
 *
 * THE BUDGET IS DELIBERATELY NOT LARGER. The first test makes TWO sequential
 * waits (manager, then admin), so the real ceiling is twice this value; a 15s
 * budget could run 30s and hit the file's own `testTimeout` instead, converting a
 * slow-poll failure into a timeout failure. 8s x 2 fits inside a 60s per-test
 * limit with room for the queries themselves.
 *
 * The failure signature was the documented one - green in isolation, red only
 * under full load - the same trap `vitest.config.ts` widened `testTimeout` for
 * (5s -> 30s). The POLLING budget was missed there, so the test failed on its own
 * assertion, which reads like a product bug ("the manager was never notified")
 * rather than a slow test.
 *
 * Deadline-based rather than an iteration count, so the budget is stated in
 * seconds and stays honest if the query gets slower.
 */
const NOTIFICATION_WAIT_MS = 8_000;
const NOTIFICATION_POLL_MS = 100;

async function waitForNotifications(
  userId: string,
  role: JwtPayload['role'],
  predicate: (rows: { type: string }[]) => boolean,
): Promise<{ type: string; title: string }[]> {
  const deadline = Date.now() + NOTIFICATION_WAIT_MS;
  // Read once up front so the first value is genuinely used by the loop
  // condition (a `do { … } while (true)` shape trips no-constant-condition and
  // leaves an unused assignment). Always reads at least once.
  let rows = await notificationsFor(userId, role);
  while (!predicate(rows)) {
    if (Date.now() >= deadline) break;
    await new Promise((r) => setTimeout(r, NOTIFICATION_POLL_MS));
    rows = await notificationsFor(userId, role);
  }
  return rows;
}

async function seedUser(id: string, role: JwtPayload['role']): Promise<void> {
  await adminSeed((db) =>
    db.user.create({
      data: { id, email: `${id}@example.com`, name: id, role, organizationId: ORG_ID },
    }),
  );
}

/**
 * A monotonic counter, NOT derived from CREATED_LEAD_IDS.length. That array is
 * emptied by every cleanup() (and by the beforeAll pre-clean), so an index-based
 * phone restarts at 0 and collides with an earlier lead's on `Lead_phone_key` -
 * which is what actually happened here and masked the real assertions.
 */
let seq = 0;

async function seedLeadWithVisit(): Promise<{ leadId: string; visitId: string }> {
  seq += 1;
  const n = seq;
  const leadId = `test-vnotif-lead-${RUN}-${n}`;
  const visitId = `test-vnotif-visit-${RUN}-${n}`;
  const phone = `91${String(RUN).slice(-7)}${String(n).padStart(4, '0')}`;
  await adminSeed(async (db) => {
    await db.lead.create({
      data: {
        id: leadId,
        name: `Notif Lead ${n}`,
        phone,
        phoneE164: `9${phone}`,
        source: 'WHATSAPP',
        state: 'VISIT_SCHEDULED',
        // The telecaller owns; the exec conducts (the real plan §3 shape).
        ownerId: OWNER_ID,
        ownerType: 'TELECALLER',
        coOwnerId: EXEC_ID,
        teamId: LEAD_TEAM_ID,
        organizationId: ORG_ID,
        projectId: PROJECT_ID,
      },
    });
    await db.siteVisit.create({
      data: {
        id: visitId,
        leadId,
        userId: EXEC_ID,
        scheduledFor: new Date(),
        status: 'SCHEDULED',
        organizationId: ORG_ID,
      },
    });
  });
  CREATED_LEAD_IDS.push(leadId);
  CREATED_VISIT_IDS.push(visitId);
  return { leadId, visitId };
}

async function cleanup(): Promise<void> {
  if (prisma === null) return;
  await adminSeed(async (db) => {
    if (CREATED_VISIT_IDS.length > 0) {
      await db.$executeRawUnsafe(
        `DELETE FROM "SiteVisit" WHERE id = ANY($1::text[])`,
        CREATED_VISIT_IDS,
      );
    }
    if (CREATED_LEAD_IDS.length > 0) {
      await db.$executeRawUnsafe(`DELETE FROM "Lead" WHERE id = ANY($1::text[])`, CREATED_LEAD_IDS);
    }
    for (const id of SEEDED_USERS) {
      await db.$executeRawUnsafe(`DELETE FROM "Notification" WHERE "userId" = $1`, id);
      await db.$executeRawUnsafe(`DELETE FROM "AuditLog" WHERE "userId" = $1`, id);
    }
    await db.$executeRawUnsafe(`DELETE FROM "User" WHERE id LIKE $1`, `test-vnotif-%`);
    await db.$executeRawUnsafe(`DELETE FROM "ProjectTeam" WHERE "teamId" = ANY($1::text[])`, [
      LEAD_TEAM_ID,
      OTHER_TEAM_ID,
    ]);
    await db.$executeRawUnsafe(`DELETE FROM "Team" WHERE id = ANY($1::text[])`, [
      LEAD_TEAM_ID,
      OTHER_TEAM_ID,
    ]);
    await db.$executeRawUnsafe(`DELETE FROM "Project" WHERE id = $1`, PROJECT_ID);
  });
  CREATED_LEAD_IDS.length = 0;
  CREATED_VISIT_IDS.length = 0;
}

describe.skipIf(!HAS_DB)('visits notifications - reschedule + outcome', () => {
  // T-NOTIF-WAIT-BUDGET (2026-09-30): the first test below makes TWO sequential
  // `waitForNotifications` calls (manager, then admin), so its worst case is
  // 2 x 8s of polling plus the queries themselves - past the package's 30s
  // `testTimeout` under full load, which is how a slow poll became a timeout
  // failure. Raised for this file only: waiting on a fire-and-forget emit is
  // inherently slower than the rest of the suite, and a file-scoped limit keeps
  // that honesty local instead of loosening the whole package.
  vi.setConfig({ testTimeout: 60_000 });
  let service: VisitsService;
  let prismaService: PrismaService;

  beforeAll(async () => {
    if (prisma === null) return;
    prismaService = { $client: prisma as unknown as PrismaClient } as PrismaService;

    // Clean any residue from an earlier failed run BEFORE seeding: the fixture
    // uses `Lead.phone` (unique) derived from RUN, so a leftover row from a run
    // that crashed mid-suite collides on re-run and masks the real failure.
    await cleanup();

    for (const [id, role] of [
      [MANAGER_ID, 'MANAGER'],
      [ADMIN_ID, 'ADMIN'],
      [ACTOR_ID, 'MANAGER'],
      [OWNER_ID, 'TELECALLER'],
      [EXEC_ID, 'SALES_EXEC'],
    ] as const) {
      await seedUser(id, role);
    }

    await adminSeed(async (db) => {
      await db.project.create({
        data: {
          id: PROJECT_ID,
          name: `Notif Project ${RUN}`,
          slug: `test-vnotif-${RUN}`,
          address: 'test',
          organizationId: ORG_ID,
        },
      });
      // Two teams on one project: the actor leads the lead's team (so RLS admits
      // them to the visit), and the other team's manager is a recipient who is
      // NOT the actor.
      await db.team.create({
        data: {
          id: LEAD_TEAM_ID,
          name: `Notif Lead Team ${RUN}`,
          managerId: ACTOR_ID,
          organizationId: ORG_ID,
        },
      });
      await db.team.create({
        data: {
          id: OTHER_TEAM_ID,
          name: `Notif Other Team ${RUN}`,
          managerId: MANAGER_ID,
          organizationId: ORG_ID,
        },
      });
      await db.projectTeam.createMany({
        data: [
          { projectId: PROJECT_ID, teamId: LEAD_TEAM_ID, organizationId: ORG_ID },
          { projectId: PROJECT_ID, teamId: OTHER_TEAM_ID, organizationId: ORG_ID },
        ],
      });
    });

    // REAL NotificationsService, so `emit` writes real rows.
    const notifications = new NotificationsService(prismaService);
    const leadsService = new LeadsService(prismaService);
    service = new VisitsService(prismaService, leadsService, notifications);
  });

  afterAll(async () => {
    await cleanup();
  });

  it('notifies the project managers + the org admin when a visit is RESCHEDULED', async () => {
    const { visitId } = await seedLeadWithVisit();
    const actor = actorFor(ACTOR_ID, 'MANAGER');

    await service.reschedule(actor, visitId, {
      visitId,
      scheduledFor: new Date(Date.now() + 3 * 24 * 60 * 60 * 1000).toISOString(),
    });

    // MANAGER_ID leads the OTHER team on the project - a recipient, not the actor.
    const managerRows = await waitForNotifications(MANAGER_ID, 'MANAGER', (r) =>
      r.some((x) => x.type === 'visit.rescheduled'),
    );
    const adminRows = await waitForNotifications(ADMIN_ID, 'ADMIN', (r) =>
      r.some((x) => x.type === 'visit.rescheduled'),
    );

    expect(managerRows.map((r) => r.type)).toContain('visit.rescheduled');
    expect(adminRows.map((r) => r.type)).toContain('visit.rescheduled');
    // The type keeps the inbox's existing `visit` prefix filter working.
    expect(managerRows[0]?.type?.startsWith('visit.')).toBe(true);
    // The title names the LEAD, so the recipient knows WHICH visit moved.
    expect(managerRows[0]?.title).toContain('Notif Lead');
  });

  it('does NOT notify the actor about their own reschedule', async () => {
    const { visitId } = await seedLeadWithVisit();
    // ACTOR_ID leads the lead's team, so they ARE in the manager recipient set -
    // which is what makes the exclusion assertion meaningful rather than vacuous.
    const actor = actorFor(ACTOR_ID, 'MANAGER');

    await service.reschedule(actor, visitId, {
      visitId,
      scheduledFor: new Date(Date.now() + 4 * 24 * 60 * 60 * 1000).toISOString(),
    });

    // Wait for the OTHER manager to be notified first, which proves the emit ran
    // before asserting the actor's inbox is empty - otherwise this would pass
    // simply because nothing had fired yet.
    await waitForNotifications(MANAGER_ID, 'MANAGER', (r) =>
      r.some((x) => x.type === 'visit.rescheduled'),
    );

    const actorRows = await notificationsFor(ACTOR_ID, 'MANAGER');
    expect(actorRows).toEqual([]);
  });

  it('notifies the lead owner when a visit is COMPLETED', async () => {
    const { visitId } = await seedLeadWithVisit();
    // The exec conducted it and is NOT the lead's owner.
    const actor = actorFor(EXEC_ID, 'SALES_EXEC');

    await service.updateOutcome(actor, visitId, { visitId, outcome: 'COMPLETED' });

    const ownerRows = await waitForNotifications(OWNER_ID, 'TELECALLER', (r) =>
      r.some((x) => x.type === 'visit.completed'),
    );

    // OWNER_ID is the telecaller who booked the visit. Before this change the
    // person who arranged it was never told what happened.
    expect(ownerRows.map((r) => r.type)).toContain('visit.completed');
    expect(ownerRows[0]?.title).toContain('Notif Lead');
  });

  it('uses a distinct type for a NO_SHOW so the inbox can tell them apart', async () => {
    const { visitId } = await seedLeadWithVisit();
    const actor = actorFor(EXEC_ID, 'SALES_EXEC');

    await service.updateOutcome(actor, visitId, { visitId, outcome: 'NO_SHOW' });

    const ownerRows = await waitForNotifications(OWNER_ID, 'TELECALLER', (r) =>
      r.some((x) => x.type === 'visit.no_show'),
    );

    // One `visit.outcome` type with the state buried in the body would force the
    // UI to parse prose to separate "it happened" from "they did not turn up".
    expect(ownerRows.map((r) => r.type)).toContain('visit.no_show');
  });
});
