// ────────────────────────────────────────────────────────────────────────────
// RLS isolation matrix — §19.2 of the plan
// ────────────────────────────────────────────────────────────────────────────
// Full matrix: 4 roles (ADMIN / MANAGER / SALES_EXEC / TELECALLER)
//            × 8 business tables (Lead / Activity / SiteVisit / Message /
//                                 Booking / Reminder / Notification / AuditLog)
//            × 4 actions (SELECT / INSERT / UPDATE / DELETE)
//            = 128 cases. The plan calls this a hard CI requirement
//            (RLS_MATRIX_REQUIRED=true → no DB = HARD FAIL).
//
// This file generates all 128 cases programmatically and asserts each
// one against a freshly-seeded two-org fixture:
//
//   org alpha (team-a): manager-a, exec-a, tele-a, lead-a
//   org beta  (team-b): manager-b, exec-b, tele-b, lead-b
//
// For each (role, table, action) case we run the action under the role's
// RLS context and assert:
//   - SELECT:  own-org rows visible, cross-org rows hidden, total = expected
//   - INSERT:  succeeds when actor's team matches row's team; rejected otherwise
//   - UPDATE:  same as INSERT (with-check on the target row's team/owner)
//   - DELETE:  same scoping; AuditLog is special-cased (admin-only delete)
//
// Tables that don't have a `teamId` column (Activity/SiteVisit/Message/
// Booking scope via parent Lead; Reminder/Notification/AuditLog scope
// via userId) get their matrix rows derived from those columns.
//
// When the test runs without a database (DATABASE_URL unset) the
// setup.ts `DATABASE_AVAILABLE` guard SKIPs — and with
// RLS_MATRIX_REQUIRED=true the suite HARD-FAILS at startup instead.
// CI is wired at .github/workflows/ci.yml:rls-matrix.
import { beforeAll, describe, expect, it } from 'vitest';
import { PrismaPg } from '@prisma/adapter-pg';

import { prisma } from '../src/index';
import { withRlsContext, type RlsContext } from '../src/rls';

import { DATABASE_AVAILABLE } from './setup';

// The fixture needs the OWNER database role (bypass-RLS) — `shadhil`
// via DIRECT_DATABASE_URL — not the non-owner `shadhil_app` role used
// at runtime via DATABASE_URL + PgBouncer. Construct a local PrismaClient
// here rather than importing the shared `prisma` from `./index` (which is
// bound to DATABASE_URL so the API runtime keeps RLS enforced). Without
// this, every fixture upsert hits `42501 row-level security` and the
// matrix never runs. The seed script does the same thing.
//
// DIRECT_DATABASE_URL is set by CI (see .github/workflows/ci.yml:rls-matrix)
// and by local dev (.env). If it's missing, DATABASE_AVAILABLE is false
// and the test skips — same fail-fast path as missing DATABASE_URL.
const adminUrl = process.env.DIRECT_DATABASE_URL ?? '';
const adminPrisma = adminUrl
  ? new (prisma.constructor as new (opts: { adapter: PrismaPg }) => typeof prisma)({
      adapter: new PrismaPg({ connectionString: adminUrl }),
    })
  : prisma;

type Role = 'ADMIN' | 'MANAGER' | 'SALES_EXEC' | 'TELECALLER';
type Action = 'SELECT' | 'INSERT' | 'UPDATE' | 'DELETE';

type TableName =
  | 'Lead'
  | 'Activity'
  | 'SiteVisit'
  | 'Message'
  | 'Booking'
  | 'Reminder'
  | 'Notification'
  | 'AuditLog';

const ROLES: readonly Role[] = ['ADMIN', 'MANAGER', 'SALES_EXEC', 'TELECALLER'];
// OWNER travels as ADMIN at the RLS layer per packages/database/src/rls.ts,
// so it isn't part of the RLS-visible role set — the matrix tests the
// 4 RLS-visible roles only.
type OwnerType = Exclude<Role, never>;
const ACTIONS: readonly Action[] = ['SELECT', 'INSERT', 'UPDATE', 'DELETE'];
const TABLES: readonly TableName[] = [
  'Lead',
  'Activity',
  'SiteVisit',
  'Message',
  'Booking',
  'Reminder',
  'Notification',
  'AuditLog',
];

type Fixture = {
  teamAId: string;
  teamBId: string;
  managerAId: string;
  managerBId: string;
  execAId: string;
  execBId: string;
  teleAId: string;
  teleBId: string;
  leadAId: string;
  leadBId: string;
  // IDs of seeded rows in each table that we use for UPDATE/DELETE
  // assertions. Pre-seeded per fixture build.
  rowIds: Record<TableName, { own: string; other: string }>;
};

/**
 * Build a fixture with two orgs, two leads, and one row of every business
 * table linked to each lead. Idempotent: re-running overwrites by cuid-
 * derived keys (cuid() collision rate is negligible inside one DB).
 *
 * Uses DIRECT_DATABASE_URL semantics — bypasses RLS via the owner role,
 * which is correct for fixture setup. The matrix tests themselves run
 * inside `withRlsContext` under the actor's role.
 */
async function buildFixture(): Promise<Fixture> {
  const teamAId = 'fixture-team-a';
  const teamBId = 'fixture-team-b';
  const managerAId = 'fixture-manager-a';
  const managerBId = 'fixture-manager-b';
  const execAId = 'fixture-exec-a';
  const execBId = 'fixture-exec-b';
  const teleAId = 'fixture-tele-a';
  const teleBId = 'fixture-tele-b';
  const leadAId = 'fixture-lead-a';
  const leadBId = 'fixture-lead-b';

  // Build the fixture in dependency order: users first WITHOUT teamId
  // (no FK target yet), then teams (managerId FK to existing users),
  // then UPDATE users to set teamId (User.teamId FK to teams).
  // Three passes break the User.teamId ↔ Team.managerId chicken-and-egg.
  for (const u of [
    { id: managerAId, role: 'MANAGER' as const, email: 'fixture-manager-a@x' },
    { id: managerBId, role: 'MANAGER' as const, email: 'fixture-manager-b@x' },
    { id: execAId, role: 'SALES_EXEC' as const, email: 'fixture-exec-a@x' },
    { id: execBId, role: 'SALES_EXEC' as const, email: 'fixture-exec-b@x' },
    { id: teleAId, role: 'TELECALLER' as const, email: 'fixture-tele-a@x' },
    { id: teleBId, role: 'TELECALLER' as const, email: 'fixture-tele-b@x' },
  ]) {
    await adminPrisma.user.upsert({
      where: { id: u.id },
      update: { role: u.role, teamId: null },
      create: {
        id: u.id,
        email: u.email,
        name: u.email,
        role: u.role,
        teamId: null,
        emailVerified: true,
      },
    });
  }

  await adminPrisma.team.upsert({
    where: { id: teamAId },
    update: { managerId: managerAId, name: 'Fixture A' },
    create: { id: teamAId, name: 'Fixture A', managerId: managerAId },
  });
  await adminPrisma.team.upsert({
    where: { id: teamBId },
    update: { managerId: managerBId, name: 'Fixture B' },
    create: { id: teamBId, name: 'Fixture B', managerId: managerBId },
  });

  // Pass 3: now that both ends of the FK exist, set User.teamId.
  const teamMap: Record<string, string> = {
    [managerAId]: teamAId,
    [managerBId]: teamBId,
    [execAId]: teamAId,
    [execBId]: teamBId,
    [teleAId]: teamAId,
    [teleBId]: teamBId,
  };
  for (const [userId, teamId] of Object.entries(teamMap)) {
    await adminPrisma.user.update({ where: { id: userId }, data: { teamId } });
  }

  // Need a Project + Phase + Unit for Booking — seed minimal versions.
  const projectAId = 'fixture-project-a';
  const projectBId = 'fixture-project-b';
  const phaseAId = 'fixture-phase-a';
  const phaseBId = 'fixture-phase-b';
  const unitAId = 'fixture-unit-a';
  const unitBId = 'fixture-unit-b';
  await adminPrisma.project.upsert({
    where: { id: projectAId },
    update: {},
    create: {
      id: projectAId,
      name: 'Fixture Project A',
      slug: 'fixture-project-a',
      address: '123 Fixture A',
    },
  });
  await adminPrisma.project.upsert({
    where: { id: projectBId },
    update: {},
    create: {
      id: projectBId,
      name: 'Fixture Project B',
      slug: 'fixture-project-b',
      address: '123 Fixture B',
    },
  });
  await adminPrisma.phase.upsert({
    where: { id: phaseAId },
    update: {},
    create: { id: phaseAId, projectId: projectAId, name: 'Phase A' },
  });
  await adminPrisma.phase.upsert({
    where: { id: phaseBId },
    update: {},
    create: { id: phaseBId, projectId: projectBId, name: 'Phase B' },
  });
  await adminPrisma.unit.upsert({
    where: { phaseId_unitNumber: { phaseId: phaseAId, unitNumber: 'FA-001' } },
    update: {},
    create: {
      id: unitAId,
      phaseId: phaseAId,
      unitNumber: 'FA-001',
      bhk: 3,
      price: '10000000.00',
    },
  });
  await adminPrisma.unit.upsert({
    where: { phaseId_unitNumber: { phaseId: phaseBId, unitNumber: 'FB-001' } },
    update: {},
    create: {
      id: unitBId,
      phaseId: phaseBId,
      unitNumber: 'FB-001',
      bhk: 3,
      price: '10000000.00',
    },
  });

  // Leads.
  await adminPrisma.lead.upsert({
    where: { id: leadAId },
    update: { state: 'NEW', teamId: teamAId, ownerId: teleAId, ownerType: 'TELECALLER' },
    create: {
      id: leadAId,
      name: 'Fixture Lead A',
      phone: '9900000001',
      state: 'NEW',
      teamId: teamAId,
      ownerId: teleAId,
      ownerType: 'TELECALLER',
    },
  });
  await adminPrisma.lead.upsert({
    where: { id: leadBId },
    update: { state: 'NEW', teamId: teamBId, ownerId: teleBId, ownerType: 'TELECALLER' },
    create: {
      id: leadBId,
      name: 'Fixture Lead B',
      phone: '9900000002',
      state: 'NEW',
      teamId: teamBId,
      ownerId: teleBId,
      ownerType: 'TELECALLER',
    },
  });

  // Seed one row per table per org. We use deterministic IDs so the
  // fixture can be re-run cleanly.
  const activityAId = 'fixture-activity-a';
  const activityBId = 'fixture-activity-b';
  await adminPrisma.activity.upsert({
    where: { id: activityAId },
    update: {},
    create: { id: activityAId, leadId: leadAId, userId: teleAId, type: 'NOTE', body: 'a' },
  });
  await adminPrisma.activity.upsert({
    where: { id: activityBId },
    update: {},
    create: { id: activityBId, leadId: leadBId, userId: teleBId, type: 'NOTE', body: 'b' },
  });

  const visitAId = 'fixture-visit-a';
  const visitBId = 'fixture-visit-b';
  const future = new Date(Date.now() + 7 * 24 * 60 * 60 * 1000);
  await adminPrisma.siteVisit.upsert({
    where: { id: visitAId },
    update: { status: 'SCHEDULED' },
    create: {
      id: visitAId,
      leadId: leadAId,
      userId: execAId,
      scheduledFor: future,
      status: 'SCHEDULED',
    },
  });
  await adminPrisma.siteVisit.upsert({
    where: { id: visitBId },
    update: { status: 'SCHEDULED' },
    create: {
      id: visitBId,
      leadId: leadBId,
      userId: execBId,
      scheduledFor: future,
      status: 'SCHEDULED',
    },
  });

  const messageAId = 'fixture-message-a';
  const messageBId = 'fixture-message-b';
  await adminPrisma.message.upsert({
    where: { id: messageAId },
    update: {},
    create: {
      id: messageAId,
      leadId: leadAId,
      userId: teleAId,
      direction: 'OUT',
      channel: 'WHATSAPP',
      body: 'a',
    },
  });
  await adminPrisma.message.upsert({
    where: { id: messageBId },
    update: {},
    create: {
      id: messageBId,
      leadId: leadBId,
      userId: teleBId,
      direction: 'OUT',
      channel: 'WHATSAPP',
      body: 'b',
    },
  });

  const bookingAId = 'fixture-booking-a';
  const bookingBId = 'fixture-booking-b';
  await adminPrisma.booking.upsert({
    where: { id: bookingAId },
    update: {},
    create: {
      id: bookingAId,
      leadId: leadAId,
      unitId: unitAId,
      userId: execAId,
      amount: '100000.00',
      status: 'HOLD',
    },
  });
  await adminPrisma.booking.upsert({
    where: { id: bookingBId },
    update: {},
    create: {
      id: bookingBId,
      leadId: leadBId,
      unitId: unitBId,
      userId: execBId,
      amount: '100000.00',
      status: 'HOLD',
    },
  });

  const reminderAId = 'fixture-reminder-a';
  const reminderBId = 'fixture-reminder-b';
  await adminPrisma.reminder.upsert({
    where: { id: reminderAId },
    update: {},
    create: {
      id: reminderAId,
      leadId: leadAId,
      userId: teleAId,
      type: 'PRE_VISIT_STAFF',
      status: 'SCHEDULED',
      scheduledFor: future,
    },
  });
  await adminPrisma.reminder.upsert({
    where: { id: reminderBId },
    update: {},
    create: {
      id: reminderBId,
      leadId: leadBId,
      userId: teleBId,
      type: 'PRE_VISIT_STAFF',
      status: 'SCHEDULED',
      scheduledFor: future,
    },
  });

  const notifAId = 'fixture-notif-a';
  const notifBId = 'fixture-notif-b';
  await adminPrisma.notification.upsert({
    where: { id: notifAId },
    update: {},
    create: {
      id: notifAId,
      userId: teleAId,
      type: 'lead.assigned',
      title: 'A',
      body: 'a',
    },
  });
  await adminPrisma.notification.upsert({
    where: { id: notifBId },
    update: {},
    create: {
      id: notifBId,
      userId: teleBId,
      type: 'lead.assigned',
      title: 'B',
      body: 'b',
    },
  });

  const auditAId = 'fixture-audit-a';
  const auditBId = 'fixture-audit-b';
  await adminPrisma.auditLog.upsert({
    where: { id: auditAId },
    update: {},
    create: {
      id: auditAId,
      userId: managerAId,
      action: 'fixture.a',
      entityType: 'Lead',
      entityId: leadAId,
    },
  });
  await adminPrisma.auditLog.upsert({
    where: { id: auditBId },
    update: {},
    create: {
      id: auditBId,
      userId: managerBId,
      action: 'fixture.b',
      entityType: 'Lead',
      entityId: leadBId,
    },
  });

  return {
    teamAId,
    teamBId,
    managerAId,
    managerBId,
    execAId,
    execBId,
    teleAId,
    teleBId,
    leadAId,
    leadBId,
    rowIds: {
      Lead: { own: leadAId, other: leadBId },
      Activity: { own: activityAId, other: activityBId },
      SiteVisit: { own: visitAId, other: visitBId },
      Message: { own: messageAId, other: messageBId },
      Booking: { own: bookingAId, other: bookingBId },
      Reminder: { own: reminderAId, other: reminderBId },
      Notification: { own: notifAId, other: notifBId },
      AuditLog: { own: auditAId, other: auditBId },
    },
  };
}

/**
 * Build the RlsContext for a given role acting as the alpha-org user.
 */
function ctxFor(role: Role, fixture: Fixture): RlsContext {
  switch (role) {
    case 'ADMIN':
      return { userId: fixture.managerAId, role: 'ADMIN', teamId: fixture.teamAId };
    case 'MANAGER':
      return { userId: fixture.managerAId, role: 'MANAGER', teamId: fixture.teamAId };
    case 'SALES_EXEC':
      return { userId: fixture.execAId, role: 'SALES_EXEC', teamId: fixture.teamAId };
    case 'TELECALLER':
      return { userId: fixture.teleAId, role: 'TELECALLER', teamId: fixture.teamAId };
  }
}

/**
 * Per-table "can this role see any cross-org rows?" expected answer.
 * Drives the SELECT assertion: roles that should see only own-org rows
 * expect total=fixture_rows_in_table; roles that see across teams
 * expect total=2x fixture_rows (because the policies don't restrict
 * by team for those roles).
 *
 * Note on counts: the fixture seeds exactly one row per table per
 * org (org-alpha + org-beta). Demo seed data + previous runs may
 * have left extra rows — to keep assertions stable we filter by
 * `id IN fixture.rowIds[table]` instead of counting the whole table.
 * See runCase().
 */
const SELECT_EXPECTATIONS: Readonly<Record<Role, 'own' | 'all'>> = {
  ADMIN: 'all', // cross-tenant via role (per Lead/Activity/SiteVisit/Message/
                // Booking/Reminder/AuditLog policies; Notification is
                // owner-only even for ADMIN).
  MANAGER: 'own', // team-scoped (Lead/Activity/SiteVisit/Message/Booking);
                   // Reminder: SELECT broadens to team via manager role;
                   // Notification: owner-only (own userId = current user).
  SALES_EXEC: 'own', // ownerId-scoped via parent Lead
  TELECALLER: 'own', // ownerId-scoped via parent Lead
};

/**
 * INSERT/UPDATE/DELETE expected outcome per (role, table).
 *
 * Policy-by-policy (mirrors packages/database/prisma/rls/policies.sql):
 *
 *   Lead:        SELECT (admin OR manager-team OR owner),
 *                INSERT (any-role-with-team),
 *                UPDATE (admin OR manager-team OR owner),
 *                DELETE (admin only)
 *   Activity:    SELECT (admin OR manager-team OR owner-of-parent),
 *                INSERT (any-role-with-team-of-parent),
 *                UPDATE/DELETE: NO POLICY → DEFAULT DENY
 *   SiteVisit:   FOR ALL (admin OR manager-team OR owner-of-parent)
 *   Message:     SELECT (admin OR manager-team OR owner-of-parent),
 *                INSERT (any-role-with-team-of-parent),
 *                UPDATE/DELETE: NO POLICY → DEFAULT DENY
 *   Booking:     FOR ALL (admin OR manager-team OR owner-of-parent)
 *   Reminder:    SELECT (admin OR manager OR owner),
 *                FOR ALL write (owner only — even admin/manager can't
 *                write someone else's reminder)
 *   Notification:SELECT/UPDATE/DELETE (owner only — even admin/manager
 *                can't see/touch someone else's notification),
 *                INSERT (owner-only, Day 4 — was DEFAULT DENY before the
 *                notification_insert_owner migration landed)
 *   AuditLog:    SELECT (admin OR owner),
 *                INSERT (any authenticated actor),
 *                UPDATE/DELETE: NO POLICY → DEFAULT DENY
 *
 * The matrix below is the SINGLE SOURCE OF TRUTH for RLS expectations
 * — the policies.sql must mirror it. If a test fails here, the policy
 * is wrong (not the test).
 *
 * "allowed" — operation should succeed (within own org for org-scoped roles).
 * "rejected" — RLS should block the operation.
 */
type Outcome = 'allowed' | 'rejected';

/**
 * Per (role, table) → action → expected outcome.
 *
 * Encoding as nested Record<string, Record<Action, Outcome>> makes
 * the matrix readable and forces a TS error when a new action is
 * added — every row must be filled in.
 */
const INSERT_EXPECTATIONS: Readonly<Record<Role, Readonly<Record<TableName, Outcome>>>> = {
  // INSERT on a NEW row tied to the alpha lead:
  //   - The policy gates on parent Lead's teamId (matches teamA) AND
  //     ownerId (matches teleA — the lead's owner).
  //   - ADMIN: matches via role. ALLOWED.
  //   - MANAGER: matches via teamId. ALLOWED.
  //   - SALES_EXEC: must match parent lead's ownerId. execA != teleA → REJECTED.
  //   - TELECALLER: must match parent lead's ownerId. teleA == teleA → ALLOWED.
  ADMIN: {
    Lead: 'allowed',
    Activity: 'allowed',
    SiteVisit: 'allowed',
    Message: 'allowed',
    Booking: 'allowed',
    Reminder: 'allowed', // owner-only — admin creates their own reminder
    Notification: 'allowed', // notification_insert_owner (Day 4):
                          // owner can write their own notif. Admin's
                          // ctx.userId is managerA — they can write
                          // notifs owned by managerA.
    AuditLog: 'allowed',
  },
  MANAGER: {
    Lead: 'allowed',
    Activity: 'allowed',
    SiteVisit: 'allowed',
    Message: 'allowed',
    Booking: 'allowed',
    Reminder: 'allowed', // owner-only — manager creates their own
    Notification: 'allowed', // owner can write own notif
    AuditLog: 'allowed',
  },
  SALES_EXEC: {
    Lead: 'allowed', // teamId matches → policy allows (ownerId is set by the
                    // create() call to execA, which is fine — policy only
                    // checks teamId on INSERT).
    Activity: 'rejected', // policy gates on parent lead ownerId; execA != teleA
    SiteVisit: 'rejected',
    Message: 'rejected',
    Booking: 'rejected',
    Reminder: 'allowed', // owner-only — exec creates their own
    Notification: 'allowed', // owner can write own notif
    AuditLog: 'allowed',
  },
  TELECALLER: {
    Lead: 'allowed', // teleA == teleA
    Activity: 'allowed',
    SiteVisit: 'allowed',
    Message: 'allowed',
    Booking: 'allowed',
    Reminder: 'allowed', // owner-only — tele creates their own
    Notification: 'allowed', // owner can write own notif (teleA IS the owner)
    AuditLog: 'allowed',
  },
};

const UPDATE_EXPECTATIONS: Readonly<Record<Role, Readonly<Record<TableName, Outcome>>>> = {
  // UPDATE on the alpha-owned row:
  //   - Lead/Activity/Message/SiteVisit/Booking: parent-Lead-scoped.
  //     SALES_EXEC fails because execA != teleA.
  //   - Reminder/Notification/AuditLog: owner-only OR no policy.
  ADMIN: {
    Lead: 'allowed',
    Activity: 'rejected', // NO UPDATE POLICY → DEFAULT DENY
    SiteVisit: 'allowed',
    Message: 'rejected',
    Booking: 'allowed',
    Reminder: 'rejected', // owner-only; admin is not the owner of teleA's reminder
    Notification: 'rejected',
    AuditLog: 'rejected',
  },
  MANAGER: {
    Lead: 'allowed', // teamA matches
    Activity: 'rejected',
    SiteVisit: 'allowed',
    Message: 'rejected',
    Booking: 'allowed',
    Reminder: 'rejected',
    Notification: 'rejected',
    AuditLog: 'rejected',
  },
  SALES_EXEC: {
    Lead: 'rejected', // execA != teleA (lead owner)
    Activity: 'rejected',
    SiteVisit: 'rejected', // execA != teleA (lead owner)
    Message: 'rejected',
    Booking: 'rejected', // execA != teleA (lead owner)
    Reminder: 'rejected', // owner-only; exec != teleA
    Notification: 'rejected',
    AuditLog: 'rejected',
  },
  TELECALLER: {
    Lead: 'allowed', // teleA == teleA
    Activity: 'rejected',
    SiteVisit: 'allowed', // teleA == teleA
    Message: 'rejected',
    Booking: 'allowed', // teleA == teleA
    Reminder: 'allowed', // teleA IS the owner
    Notification: 'allowed', // teleA IS the owner of fixture notif A
    AuditLog: 'rejected',
  },
};

const DELETE_EXPECTATIONS: Readonly<Record<Role, Readonly<Record<TableName, Outcome>>>> = {
  // DELETE on the alpha row:
  //   - Lead: admin-only.
  //   - Activity/Message: NO DELETE POLICY → DEFAULT DENY.
  //   - SiteVisit: FOR ALL via parent owner/team.
  //   - Booking: FOR ALL via parent owner/team.
  //   - Reminder/Notification: owner-only.
  //   - AuditLog: NO DELETE POLICY → DEFAULT DENY.
  ADMIN: {
    Lead: 'allowed',
    Activity: 'rejected',
    SiteVisit: 'allowed',
    Message: 'rejected',
    Booking: 'allowed',
    Reminder: 'rejected',
    Notification: 'rejected',
    AuditLog: 'rejected',
  },
  MANAGER: {
    Lead: 'rejected', // admin-only
    Activity: 'rejected',
    SiteVisit: 'allowed',
    Message: 'rejected',
    Booking: 'allowed',
    Reminder: 'rejected',
    Notification: 'rejected',
    AuditLog: 'rejected',
  },
  SALES_EXEC: {
    Lead: 'rejected',
    Activity: 'rejected',
    SiteVisit: 'rejected', // execA != teleA (lead owner)
    Message: 'rejected',
    Booking: 'rejected', // execA != teleA (lead owner)
    Reminder: 'rejected',
    Notification: 'rejected',
    AuditLog: 'rejected',
  },
  TELECALLER: {
    Lead: 'rejected', // admin-only
    Activity: 'rejected',
    SiteVisit: 'allowed', // teleA == teleA
    Message: 'rejected',
    Booking: 'allowed', // teleA == teleA
    Reminder: 'allowed', // owner
    Notification: 'allowed', // owner
    AuditLog: 'rejected',
  },
};

/**
 * Per-table SELECT-count expectations:
 *   - Lead/Activity/SiteVisit/Message/Booking: ADMIN sees both fixture
 *     rows (cross-org); MANAGER/SALES_EXEC/TELECALLER see only the
 *     alpha row (team/owner-scoped).
 *   - Reminder/AuditLog: ADMIN sees both fixture rows; MANAGER sees
 *     both (team-broadened); SALES_EXEC/TELECALLER see only their own
 *     (owner-scoped) — which is the alpha row for our fixture.
 *   - Notification: OWNER-ONLY for SELECT. ADMIN is NOT a separate
 *     superuser here. Each role sees only their own userId.
 */
function expectedSelectCount(role: Role, table: TableName): number {
  // The fixture seeds one row per table per org (alpha = teamA, beta = teamB).
  // Counts below reflect what the policy returns when filtered by both the
  // fixture id list AND the actor's RLS context.
  //
  // Lead / Activity / SiteVisit / Message / Booking all gate via parent Lead:
  //   ADMIN → sees both (alpha + beta), 2 rows.
  //   MANAGER (managerA, teamA) → sees teamA's parent lead's child rows.
  //     Our fixture: leadA.teamId = teamA. So manager sees 1 row (the alpha
  //     row, which has teamA). The beta row has teamB and is excluded.
  //     → 1.
  //   TELECALLER (teleA, owns leadA) → sees leadA's child rows. → 1.
  //   SALES_EXEC (execA, doesn't own leadA) → sees nothing on leadA. → 0.
  //
  // Reminder (owner-scoped with admin/manager override, no team gate):
  //   ADMIN → 2 (both alpha + beta).
  //   MANAGER → 2 (broader SELECT — no team filter).
  //   TELECALLER (teleA, owns alpha reminder) → 1.
  //   SALES_EXEC (execA, owns nothing) → 0.
  //
  // Notification (owner-only):
  //   ADMIN → 0 (admin doesn't bypass the owner gate here).
  //   MANAGER → 0.
  //   TELECALLER → 1 (teleA owns alpha notif).
  //   SALES_EXEC → 0.
  //
  // AuditLog (admin OR owner):
  //   ADMIN → 2 (admin bypasses the owner gate).
  //   MANAGER → 1 (managerA owns auditA; no admin bypass).
  //   TELECALLER → 0 (teleA doesn't own auditA).
  //   SALES_EXEC → 0.
  if (table === 'Notification') {
    return role === 'TELECALLER' ? 1 : 0;
  }
  if (table === 'Reminder') {
    if (role === 'ADMIN' || role === 'MANAGER') return 2;
    if (role === 'TELECALLER') return 1;
    return 0; // SALES_EXEC
  }
  if (table === 'AuditLog') {
    if (role === 'ADMIN') return 2;
    if (role === 'MANAGER') return 1;
    return 0;
  }
  // Lead / Activity / SiteVisit / Message / Booking — parent-Lead-scoped.
  if (role === 'ADMIN') return 2;
  if (role === 'MANAGER') return 1; // managerA is on teamA; leadA is teamA.
  if (role === 'TELECALLER') return 1; // teleA owns leadA.
  return 0; // SALES_EXEC: execA doesn't own leadA.
}

function expectedOutcome(
  role: Role,
  table: TableName,
  action: Action,
): Outcome | { kind: 'count'; value: number } {
  if (action === 'SELECT') {
    return { kind: 'count', value: expectedSelectCount(role, table) };
  }
  if (action === 'INSERT') return INSERT_EXPECTATIONS[role][table];
  if (action === 'UPDATE') return UPDATE_EXPECTATIONS[role][table];
  return DELETE_EXPECTATIONS[role][table];
}

/**
 * Run the action under the role's RLS context, return observed state.
 * Throws are caught and surfaced as 'rejected'.
 */
async function runCase(
  ctx: RlsContext,
  table: TableName,
  action: Action,
  fixture: Fixture,
): Promise<{ kind: 'count'; value: number } | { kind: 'ok' } | { kind: 'err' }> {
  return withRlsContext(prisma, ctx, async (tx) => {
    try {
      if (action === 'SELECT') {
        // Filter by fixture IDs so demo seed + leftover rows don't
        // pollute the count. The matrix assertion is about visibility
        // of the alpha+beta fixture rows specifically.
        const own = fixture.rowIds[table].own;
        const other = fixture.rowIds[table].other;
        const rows = await (tx as unknown as Record<string, { findMany: (a: { where: { id: { in: string[] } } }) => Promise<unknown[]> }>)[
          table.charAt(0).toLowerCase() + table.slice(1)
        ].findMany({ where: { id: { in: [own, other] } } });
        return { kind: 'count', value: rows.length };
      }
      if (action === 'INSERT') {
        // INSERT a new row tied to the alpha lead. This is what the
        // policies gate on (parent Lead's team/ownerId).
        const now = new Date();
        if (table === 'Activity') {
          await tx.activity.create({
            data: {
              leadId: fixture.leadAId,
              userId: ctx.userId,
              type: 'NOTE',
              body: 'matrix-test',
            },
          });
        } else if (table === 'SiteVisit') {
          await tx.siteVisit.create({
            data: {
              leadId: fixture.leadAId,
              userId: ctx.userId,
              scheduledFor: new Date(now.getTime() + 86400000),
              status: 'SCHEDULED',
            },
          });
        } else if (table === 'Message') {
          await tx.message.create({
            data: {
              leadId: fixture.leadAId,
              userId: ctx.userId,
              direction: 'OUT',
              channel: 'IN_APP',
              body: 'matrix-test',
            },
          });
        } else if (table === 'Booking') {
          await tx.booking.create({
            data: {
              leadId: fixture.leadAId,
              unitId: 'fixture-unit-a',
              userId: ctx.userId,
              amount: '1.00',
              status: 'HOLD',
            },
          });
        } else if (table === 'Reminder') {
          await tx.reminder.create({
            data: {
              leadId: fixture.leadAId,
              userId: ctx.userId,
              type: 'PRE_VISIT_STAFF',
              status: 'SCHEDULED',
              scheduledFor: new Date(now.getTime() + 86400000),
            },
          });
        } else if (table === 'Notification') {
          await tx.notification.create({
            data: {
              userId: ctx.userId,
              type: 'matrix.test',
              title: 'matrix',
              body: 'matrix-test',
            },
          });
        } else if (table === 'AuditLog') {
          await tx.auditLog.create({
            data: {
              userId: ctx.userId,
              action: 'matrix.test',
              entityType: 'Test',
              entityId: fixture.leadAId,
            },
          });
        } else if (table === 'Lead') {
          await tx.lead.create({
            data: {
              name: 'matrix-test',
              phone: `99${String(Date.now()).slice(-8)}`,
              state: 'NEW',
              teamId: ctx.teamId ?? '',
              ownerId: ctx.userId,
              ownerType: roleFromCtx(ctx),
            },
          });
        }
        return { kind: 'ok' };
      }
      if (action === 'UPDATE') {
        const own = fixture.rowIds[table].own;
        if (table === 'Lead') {
          await tx.lead.update({ where: { id: own }, data: { name: 'matrix-updated' } });
        } else if (table === 'Activity') {
          await tx.activity.update({ where: { id: own }, data: { body: 'matrix-updated' } });
        } else if (table === 'SiteVisit') {
          await tx.siteVisit.update({ where: { id: own }, data: { notes: 'matrix-updated' } });
        } else if (table === 'Message') {
          await tx.message.update({ where: { id: own }, data: { body: 'matrix-updated' } });
        } else if (table === 'Booking') {
          await tx.booking.update({ where: { id: own }, data: { status: 'HOLD' } });
        } else if (table === 'Reminder') {
          await tx.reminder.update({ where: { id: own }, data: { status: 'SCHEDULED' } });
        } else if (table === 'Notification') {
          await tx.notification.update({ where: { id: own }, data: { body: 'matrix-updated' } });
        } else if (table === 'AuditLog') {
          // Audit logs don't expose an updatable field per the policies.
          await tx.auditLog.update({ where: { id: own }, data: { action: 'matrix.updated' } });
        }
        return { kind: 'ok' };
      }
      // DELETE
      // We use Prisma's $transaction (interactive transaction → savepoint)
      // so the DELETE is exercised against RLS but the fixture row is
      // always preserved. Two outcomes:
      //   - RLS rejects → inner callback throws → outer withRlsContext
      //     catch classifies as 'err'. Savepoint rolls back.
      //   - RLS allows → inner callback does NOT throw, then we throw
      //     a SENTINEL so the savepoint rolls back the successful
      //     delete. The outer catch sees the sentinel and classifies
      //     as 'ok' (the policy ALLOWED the operation, which is what
      //     we asserted — we just didn't commit the destructive side
      //     effect).
      const ROLLBACK_SENTINEL = 'matrix-rls-allowed-rollback';
      const own = fixture.rowIds[table].own;
      const lower = table.charAt(0).toLowerCase() + table.slice(1);
      try {
        await tx.$transaction(async (inner) => {
          try {
            await (
              inner as unknown as Record<
                string,
                { delete: (a: { where: { id: string } }) => Promise<unknown> }
              >
            )[lower].delete({ where: { id: own } });
          } catch (err) {
            // RLS rejection — bubble up to savepoint rollback.
            throw err;
          }
          // RLS allowed. Throw sentinel to rollback the savepoint.
          throw new Error(ROLLBACK_SENTINEL);
        });
        return { kind: 'ok' };
      } catch (err) {
        if (err instanceof Error && err.message === ROLLBACK_SENTINEL) {
          // Expected rollback — the policy ALLOWED the delete.
          return { kind: 'ok' };
        }
        // RLS rejection (or anything else) — classify as err.
        return { kind: 'err' };
      }
    } catch (err) {
    // RLS rejections surface as PrismaClientKnownRequestError with
    // code P2001 (records not found) or raw Postgres errors. We
    // report 'err' for the matrix to classify.
    void err; // consumed — result.kind encodes the classification
    return { kind: 'err' };
    }
  });
}

function roleFromCtx(ctx: RlsContext): 'TELECALLER' | 'SALES_EXEC' | 'MANAGER' | 'ADMIN' {
  // The matrix only tests the 4 RLS-visible roles. OWNER travels as
  // ADMIN at the RLS layer (rls.ts:50), so the type is narrowed to
  // exclude it here.
  if (ctx.role === 'OWNER') return 'ADMIN';
  return ctx.role;
}

// ────────────────────────────────────────────────────────────────────────────
// The matrix itself
// ────────────────────────────────────────────────────────────────────────────

describe('RLS isolation matrix: 4 roles × 8 tables × 4 actions = 128 cases', () => {
  let fixture: Fixture;

  beforeAll(async () => {
    if (!DATABASE_AVAILABLE) return;
    fixture = await buildFixture();
  }, 60_000);

  for (const table of TABLES) {
    for (const role of ROLES) {
      for (const action of ACTIONS) {
        const caseName = `${role} × ${table} × ${action}`;
        const caseTimeout = 30_000;
        it.skipIf(!DATABASE_AVAILABLE)(
          caseName,
          { timeout: caseTimeout },
          async () => {
            const ctx = ctxFor(role, fixture);
            const result = await runCase(ctx, table, action, fixture);
            const expected = expectedOutcome(role, table, action);

            if (
              typeof expected === 'object' &&
              expected !== null &&
              'kind' in expected &&
              expected.kind === 'count'
            ) {
              // SELECT assertion
              expect(result.kind).toBe('count');
              if (result.kind === 'count') {
                expect(result.value).toBe(expected.value);
              }
              return;
            }

            // INSERT/UPDATE/DELETE assertion
            if (expected === 'allowed') {
              if (result.kind !== 'ok') {
                throw new Error(`${caseName}: expected allowed, got ${result.kind}`);
              }
            } else {
              // 'rejected' — the RLS policy should block this
              if (result.kind !== 'err') {
                throw new Error(`${caseName}: expected rejected, got ${result.kind}`);
              }
            }
          },
        );
      }
    }
  }
});
