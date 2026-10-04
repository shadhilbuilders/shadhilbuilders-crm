// Users service - real-DB integration test for the RLS write paths
// (T-TEAM-AUTHORITATIVE follow-up, 2026-09-13).
//
// WHY THIS FILE EXISTS (regression shape, not coverage theatre):
// `users.service.assignManager.test.ts` mocks the Prisma client, and every
// mock returned data regardless of the `app.user_*` GUCs. That let a real
// bug ship green: `assignManager` read `Team` on the BARE client, but `Team`
// is FORCE ROW LEVEL SECURITY, so the policy hid the row, `findUnique`
// returned null, and the endpoint 404'd for a team that demonstrably
// existed. The mocked suite could never see it.
//
// These tests therefore use the LIVE DB (no mocks) exactly like
// leads.detail.test.ts, so an RLS-policy violation surfaces as a real
// failure rather than a passing fiction. Run with a DATABASE_URL pointing
// at the dev DB; skip cleanly when absent (CI's unit job has no DB).
//
// Covered:
//   1. assignManager happy path: a VALID team id resolves and the target's
//      TeamMember row is replaced (+ audit row written in the same tx).
//      This is the exact call that used to 404.
//   2. assignManager into a soft-deleted team → 404 (treated as absent).
//   3. assignManager is atomic: the audit row and the membership move both
//      land, or neither does.
//   4. getUser returns the resolved team name + manager for a staff user
//      (the same bare-client read bug, on the read path).
//   5. Every write path is subject to the actor's RLS context: a MANAGER
//      cannot write into another manager's team, and the failure is a
//      typed 403 - not a silent no-op.

import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { BadRequestException, ForbiddenException, NotFoundException } from '@nestjs/common';
import { createId } from '@paralleldrive/cuid2';
import type { JwtPayload } from '@shadhil/auth';
import {
  prisma as runtimePrisma,
  type PrismaClient,
  withRlsContext,
} from '@shadhil/database';
import { createDirectPrismaClient } from '@shadhil/database/test-db-isolation';

import { PrismaService } from '../prisma/prisma.module';
import { UsersService } from './users.service';

const HAS_DB = Boolean(process.env.DATABASE_URL);
const prisma: PrismaClient | null = HAS_DB ? runtimePrisma : null;

const ORG = 'ceid01lpfe1esm8jwsxid41k28';

// Real cuid2 so ids satisfy z.cuid2() and look like production rows.
const ADMIN_ID = createId();
const MANAGER_A_ID = createId();
const MANAGER_B_ID = createId();
const TEAM_A_ID = createId();
const TEAM_B_ID = createId();
const TEAM_DEAD_ID = createId();
const TELECALLER_ID = createId();

async function adminSeed<T>(fn: (db: PrismaClient) => Promise<T>): Promise<T> {
  if (prisma === null) throw new Error('prisma missing');
  return withRlsContext(
    prisma,
    { userId: ADMIN_ID, role: 'ADMIN', organizationId: ORG },
    async (tx) => fn(tx as unknown as PrismaClient),
  );
}

function actorFor(
  overrides: Partial<JwtPayload> & Pick<JwtPayload, 'sub' | 'role'>,
): JwtPayload {
  return {
    sub: overrides.sub,
    email: `${overrides.sub}@test.local`,
    role: overrides.role,
    // T-EMAIL-PER-ORG: overridable (defaults to the suite's main ORG) - the
    // cross-org test below needs an actor who genuinely belongs to a
    // DIFFERENT org, which this helper never had to produce before.
    organizationId: overrides.organizationId ?? ORG,
    iat: 0,
    exp: 0,
    iss: 'shadhil-crm',
  };
}

const adminActor = actorFor({ sub: ADMIN_ID, role: 'ADMIN' });
const managerAActor = actorFor({ sub: MANAGER_A_ID, role: 'MANAGER' });

function makeService(): UsersService {
  return new UsersService({ $client: prisma } as unknown as PrismaService);
}

beforeAll(async () => {
  if (prisma === null) return;
  await adminSeed(async (db) => {
    // Users BEFORE teams - Team.managerId is an FK to User.
    for (const [id, role, name] of [
      [ADMIN_ID, 'ADMIN', 'RLS Test Admin'],
      [MANAGER_A_ID, 'MANAGER', 'RLS Test Manager A'],
      [MANAGER_B_ID, 'MANAGER', 'RLS Test Manager B'],
      [TELECALLER_ID, 'TELECALLER', 'RLS Test Telecaller'],
    ] as const) {
      await db.user.upsert({
        where: { id },
        update: { role },
        create: {
          id,
          email: `${id}@test.local`,
          name,
          role,
          organizationId: ORG,
          mustChangePassword: false,
        },
      });
    }
    for (const [id, name, managerId, deleted] of [
      [TEAM_A_ID, `RLS Test Team A ${TEAM_A_ID.slice(0, 6)}`, MANAGER_A_ID, false],
      [TEAM_B_ID, `RLS Test Team B ${TEAM_B_ID.slice(0, 6)}`, MANAGER_B_ID, false],
      [TEAM_DEAD_ID, `RLS Test Team Dead ${TEAM_DEAD_ID.slice(0, 6)}`, MANAGER_A_ID, true],
    ] as const) {
      await db.team.upsert({
        where: { id },
        update: { managerId, deletedAt: deleted ? new Date() : null },
        create: {
          id,
          name,
          managerId,
          organizationId: ORG,
          deletedAt: deleted ? new Date() : null,
        },
      });
    }
    // The telecaller starts as an ordinary member of team A.
    await db.teamMember.upsert({
      where: { userId_teamId: { userId: TELECALLER_ID, teamId: TEAM_A_ID } },
      update: {},
      create: {
        userId: TELECALLER_ID,
        teamId: TEAM_A_ID,
        organizationId: ORG,
      },
    });
  });
}, 30_000);

afterAll(async () => {
  if (prisma === null) return;
  await adminSeed(async (db) => {
    await db.auditLog.deleteMany({ where: { entityId: TELECALLER_ID } });
    await db.teamMember.deleteMany({ where: { userId: TELECALLER_ID } });
    await db.teamMember.deleteMany({ where: { teamId: { in: [TEAM_A_ID, TEAM_B_ID, TEAM_DEAD_ID] } } });
    await db.team.deleteMany({ where: { id: { in: [TEAM_A_ID, TEAM_B_ID, TEAM_DEAD_ID] } } });
    await db.user.deleteMany({
      where: { id: { in: [ADMIN_ID, MANAGER_A_ID, MANAGER_B_ID, TELECALLER_ID] } },
    });
  });
}, 30_000);

beforeEach(async () => {
  // Reset the telecaller to "ordinary member of team A" before each test.
  if (prisma === null) return;
  await adminSeed(async (db) => {
    await db.auditLog.deleteMany({ where: { entityId: TELECALLER_ID } });
    await db.teamMember.deleteMany({ where: { userId: TELECALLER_ID } });
    await db.teamMember.create({
      data: { userId: TELECALLER_ID, teamId: TEAM_A_ID, organizationId: ORG },
    });
  });
});

describe.skipIf(!HAS_DB)('UsersService.assignManager - real DB / RLS', () => {
  it('resolves a VALID team id and moves the member (the call that used to 404)', async () => {
    const users = makeService();

    const result = await users.assignManager(adminActor, TELECALLER_ID, {
      teamId: TEAM_B_ID,
    });

    // Returned shape reflects the move.
    expect(result.id).toBe(TELECALLER_ID);
    expect(result.teamId).toBe(TEAM_B_ID);

    // The DB actually moved the membership (this is what a bare-client
    // write would have silently skipped with 42501 or count: 0).
    const memberships = await adminSeed(async (db) =>
      db.teamMember.findMany({ where: { userId: TELECALLER_ID } }),
    );
    expect(memberships).toHaveLength(1);
    expect(memberships[0]!.teamId).toBe(TEAM_B_ID);

    // Audit row written with before/after in the SAME transaction.
    const audit = await adminSeed(async (db) =>
      db.auditLog.findFirst({
        where: { entityId: TELECALLER_ID, action: 'user.assignManager' },
      }),
    );
    expect(audit).not.toBeNull();
    expect((audit!.before as { teamId: string }).teamId).toBe(TEAM_A_ID);
    expect((audit!.after as { teamId: string }).teamId).toBe(TEAM_B_ID);
  });

  it('treats a soft-deleted team as absent → 404', async () => {
    const users = makeService();
    await expect(
      users.assignManager(adminActor, TELECALLER_ID, { teamId: TEAM_DEAD_ID }),
    ).rejects.toBeInstanceOf(NotFoundException);
  });

  it('404s for a team id that does not exist at all', async () => {
    const users = makeService();
    await expect(
      users.assignManager(adminActor, TELECALLER_ID, { teamId: createId() }),
    ).rejects.toBeInstanceOf(NotFoundException);
  });

  // Closes the gap documented when this test was written as `.fails`.
  //
  // The design doc's authorization matrix grants MANAGER "Add/remove
  // TeamMember: Managed teams only", and TeamAccessService.canMutateTeam
  // agrees - but the only TeamMember write policy WAS
  // `teammember_write_admin` (ADMIN-only), so a MANAGER acting on a team
  // they legitimately lead got
  // `42501 new row violates row-level security policy for table "TeamMember"`.
  //
  // Fixed by migration 20260913060000_manager_teammember_write, which adds
  // `teammember_write_manager` scoped to `Team.managerId = app.user_id`
  // (narrower than the role-only phase_manager_write precedent, because the
  // matrix restricts a MANAGER to MANAGED teams).
  it('a MANAGER can move staff within their OWN team', async () => {
    const users = makeService();
    const result = await users.assignManager(managerAActor, TELECALLER_ID, {
      teamId: TEAM_A_ID,
    });
    expect(result.teamId).toBe(TEAM_A_ID);

    // The DB actually moved the membership (before the policy this
    // createMany/create silently failed or threw 42501).
    const memberships = await adminSeed(async (db) =>
      db.teamMember.findMany({ where: { userId: TELECALLER_ID } }),
    );
    expect(memberships).toHaveLength(1);
    expect(memberships[0]!.teamId).toBe(TEAM_A_ID);
  });

  it('a MANAGER cannot move staff into another manager’s team → 403', async () => {
    const users = makeService();
    await expect(
      users.assignManager(managerAActor, TELECALLER_ID, { teamId: TEAM_B_ID }),
    ).rejects.toBeInstanceOf(ForbiddenException);
  });

  // REGRESSION (2026-09-13): the partial-move bug.
  //
  // assignManager used to run an UNSCOPED `deleteMany({ userId })`. For a
  // MANAGER, RLS silently skips rows on teams they don't lead (an invisible
  // row never matches `USING`), so the "move" ADDED a membership and left
  // the old one - the user ended up in two teams while the call reported
  // success. The end state is now asserted inside the transaction.
  it('a MANAGER moving a user who is on ANOTHER manager’s team fails closed (no partial move)', async () => {
    const users = makeService();

    // Put the telecaller on team B (led by Manager B) only.
    await adminSeed(async (db) => {
      await db.teamMember.deleteMany({ where: { userId: TELECALLER_ID } });
      await db.teamMember.create({
        data: { userId: TELECALLER_ID, teamId: TEAM_B_ID, organizationId: ORG },
      });
    });

    // Manager A tries to move them into their own team. Manager A cannot see
    // the team-B row at all, so this must fail closed rather than silently
    // creating a second membership.
    await expect(
      users.assignManager(managerAActor, TELECALLER_ID, { teamId: TEAM_A_ID }),
    ).rejects.toBeInstanceOf(ForbiddenException);

    // Nothing changed - the user is still ONLY on team B.
    const after = await adminSeed(async (db) =>
      db.teamMember.findMany({ where: { userId: TELECALLER_ID } }),
    );
    expect(after).toHaveLength(1);
    expect(after[0]!.teamId).toBe(TEAM_B_ID);
  }, 30_000);

  it('an ADMIN moving a user who is on another manager’s team still fully replaces memberships', async () => {
    const users = makeService();

    await adminSeed(async (db) => {
      await db.teamMember.deleteMany({ where: { userId: TELECALLER_ID } });
      await db.teamMember.create({
        data: { userId: TELECALLER_ID, teamId: TEAM_B_ID, organizationId: ORG },
      });
    });

    // An ADMIN can see + mutate every membership, so the move is a true replace.
    const result = await users.assignManager(adminActor, TELECALLER_ID, {
      teamId: TEAM_A_ID,
    });
    expect(result.teamId).toBe(TEAM_A_ID);

    const after = await adminSeed(async (db) =>
      db.teamMember.findMany({ where: { userId: TELECALLER_ID } }),
    );
    expect(after).toHaveLength(1);
    expect(after[0]!.teamId).toBe(TEAM_A_ID);
  }, 30_000);

  it('rejects a non-staff target (only TELECALLER/SALES_EXEC report to a manager) → 400', async () => {
    const users = makeService();
    await expect(
      users.assignManager(adminActor, MANAGER_B_ID, { teamId: TEAM_A_ID }),
    ).rejects.toBeInstanceOf(BadRequestException);
  });
});

describe.skipIf(!HAS_DB)('UsersService.getUser - real DB / RLS', () => {
  it('resolves the team name + manager for a staff user (bare-client read bug on the read path)', async () => {
    const users = makeService();

    const result = await users.getUser(adminActor, TELECALLER_ID);

    // Both of these were `null` when the read ran outside an RLS context.
    expect(result.teamId).toBe(TEAM_A_ID);
    expect(result.teamName).toContain('RLS Test Team A');
    expect(result.manager?.id).toBe(MANAGER_A_ID);
  });
});

describe.skipIf(!HAS_DB)('UsersService.create - real DB / RLS', () => {
  it('creates a staff user and links them via a TeamMember row', async () => {
    const users = makeService();
    const email = `${createId()}@test.local`;

    const created = await users.create(adminActor, {
      email,
      name: 'RLS Test Created',
      role: 'TELECALLER',
      password: 'Str0ng-Passw0rd!',
      teamId: TEAM_A_ID,
    } as never);

    expect(created.teamId).toBe(TEAM_A_ID);

    const memberships = await adminSeed(async (db) =>
      db.teamMember.findMany({ where: { userId: created.id } }),
    );
    expect(memberships).toHaveLength(1);
    expect(memberships[0]!.teamId).toBe(TEAM_A_ID);

    // The credential row exists so the user can actually sign in.
    const account = await adminSeed(async (db) =>
      db.account.findFirst({ where: { accountId: created.id } }),
    );
    expect(account).not.toBeNull();

    await adminSeed(async (db) => {
      await db.auditLog.deleteMany({ where: { entityId: created.id } });
      await db.teamMember.deleteMany({ where: { userId: created.id } });
      await db.account.deleteMany({ where: { accountId: created.id } });
      await db.user.deleteMany({ where: { id: created.id } });
    });
  }, 30_000);

  it('rolls the whole create back when the team id is stale (no orphan user)', async () => {
    const users = makeService();
    const email = `${createId()}@test.local`;

    await expect(
      users.create(adminActor, {
        email,
        name: 'RLS Test Orphan',
        role: 'TELECALLER',
        password: 'Str0ng-Passw0rd!',
        teamId: createId(),
      } as never),
    ).rejects.toBeInstanceOf(NotFoundException);

    // The transaction must have rolled back - no half-created user.
    const orphan = await adminSeed(async (db) =>
      db.user.findFirst({ where: { email } }),
    );
    expect(orphan).toBeNull();
  }, 30_000);

  // T-EMAIL-PER-ORG (2026-10-04) - the reported bug: a duplicate email
  // within the SAME org used to bubble up as a raw
  // PrismaClientKnownRequestError (P2002 on the old global `@unique`),
  // which the (un-filtered) controller surfaced as a bare "Internal server
  // error" with no actionable message.
  it('a duplicate email WITHIN the same org is a 409 with a friendly message, not a 500', async () => {
    const users = makeService();
    const email = `${createId()}@test.local`;

    const first = await users.create(adminActor, {
      email,
      name: 'RLS Test Dup First',
      role: 'TELECALLER',
      password: 'Str0ng-Passw0rd!',
      teamId: TEAM_A_ID,
    } as never);

    await expect(
      users.create(adminActor, {
        email,
        name: 'RLS Test Dup Second',
        role: 'TELECALLER',
        password: 'Str0ng-Passw0rd!',
        teamId: TEAM_A_ID,
      } as never),
    ).rejects.toMatchObject({
      status: 409,
      response: expect.objectContaining({ code: 'EMAIL_ALREADY_EXISTS' }),
    });

    await adminSeed(async (db) => {
      await db.auditLog.deleteMany({ where: { entityId: first.id } });
      await db.teamMember.deleteMany({ where: { userId: first.id } });
      await db.account.deleteMany({ where: { accountId: first.id } });
      await db.user.deleteMany({ where: { id: first.id } });
    });
  }, 30_000);

  // The flip side of the fix: uniqueness is scoped to the ORG now, so the
  // SAME email in a DIFFERENT org must succeed (this is the whole point of
  // T-EMAIL-PER-ORG - see schema.prisma's comment on User.email for the
  // accepted login-ambiguity caveat).
  it('the SAME email in a DIFFERENT org is allowed (uniqueness is per-org, not global)', async () => {
    const users = makeService();
    const email = `${createId()}@test.local`;
    const otherOrgId = createId();
    const otherOrgAdminId = createId();

    // Organization's `org_select_own` policy only admits rows whose id
    // already equals the ACTOR's own app.user_org_id - so no actor can ever
    // see-back a BRAND NEW org they just inserted (Prisma's generated
    // INSERT has a RETURNING clause, which re-checks the SELECT policy on
    // the new row). Production self-signup hits the identical constraint
    // and seeds via the owner role for the same reason - use the direct
    // (BYPASSRLS) client here too, exactly like other RLS-SELECT-only
    // fixtures in this suite.
    const direct = createDirectPrismaClient();
    await direct.organization.create({
      data: {
        id: otherOrgId,
        name: `RLS Other Org ${otherOrgId.slice(0, 6)}`,
        slug: `rls-other-org-${otherOrgId.slice(0, 8)}`,
      },
    });
    await adminSeed(async (db) => {
      await db.user.create({
        data: {
          id: otherOrgAdminId,
          email: `${otherOrgAdminId}@test.local`,
          name: 'RLS Other Org Admin',
          role: 'ADMIN',
          organizationId: otherOrgId,
          mustChangePassword: false,
        },
      });
    });
    const otherOrgAdminActor = actorFor({
      sub: otherOrgAdminId,
      role: 'ADMIN',
      organizationId: otherOrgId,
    });

    const inOrgA = await users.create(adminActor, {
      email,
      name: 'RLS Cross-Org A',
      role: 'TELECALLER',
      password: 'Str0ng-Passw0rd!',
      teamId: TEAM_A_ID,
    } as never);

    // role: MANAGER, no teamId - an ADMIN creating a MANAGER auto-creates
    // their team (create()'s step 2 branch), so this org needs no team
    // fixture of its own. (ADMIN cannot create another ADMIN - OWNER-only
    // per assertCanCreateRole - so MANAGER is the highest role this actor
    // can use here.)
    const inOrgB = await users.create(otherOrgAdminActor, {
      email,
      name: 'RLS Cross-Org B',
      role: 'MANAGER',
      password: 'Str0ng-Passw0rd!',
    } as never);

    expect(inOrgA.id).not.toBe(inOrgB.id);

    await adminSeed(async (db) => {
      await db.auditLog.deleteMany({ where: { entityId: inOrgA.id } });
      await db.teamMember.deleteMany({ where: { userId: inOrgA.id } });
      await db.account.deleteMany({ where: { accountId: inOrgA.id } });
      await db.user.deleteMany({ where: { id: inOrgA.id } });
    });
    await withRlsContext(
      prisma!,
      { userId: otherOrgAdminId, role: 'ADMIN', organizationId: otherOrgId },
      async (tx) => {
        const db = tx as unknown as PrismaClient;
        await db.auditLog.deleteMany({ where: { entityId: inOrgB.id } });
        // create() auto-created a Team for this MANAGER (step 4's
        // "auto-create the team for a new manager" branch).
        await db.team.deleteMany({ where: { managerId: inOrgB.id } });
        await db.account.deleteMany({ where: { accountId: inOrgB.id } });
        await db.user.deleteMany({ where: { id: inOrgB.id } });
      },
    );
    await adminSeed(async (db) => {
      await db.user.deleteMany({ where: { id: otherOrgAdminId } });
    });
    // AuditLog rows written under otherOrgId's RLS context (user.create,
    // user.assignManager/changeRole etc. all write one) FK-reference the
    // org - clear them (bypass client; AuditLog is FORCE RLS) before the
    // org row itself can be deleted.
    await direct.auditLog.deleteMany({ where: { organizationId: otherOrgId } });
    await direct.organization.deleteMany({ where: { id: otherOrgId } });
  }, 30_000);
});

describe.skipIf(!HAS_DB)('UsersService read paths - real DB / RLS', () => {
  // These three all resolved their team scope on the BARE client, so a
  // MANAGER (whose Team/TeamMember rows are RLS-visible only inside their
  // own context) got an empty result - an empty Users table, an empty
  // mention picker, an empty exec picker. No error, just nothing.

  it('list(): a MANAGER sees their own team members (was rows=0)', async () => {
    const users = makeService();

    const result = await users.list(managerAActor);

    // Ground truth: the telecaller is a member of team A, which Manager A
    // leads. Before the fix this returned { rows: [], total: 0 }.
    expect(result.total).toBeGreaterThan(0);
    expect(result.rows.map((r) => r.id)).toContain(TELECALLER_ID);
  }, 30_000);

  it('list(): an ADMIN still sees users too (regression guard)', async () => {
    const users = makeService();
    const result = await users.list(adminActor);
    expect(result.total).toBeGreaterThan(0);
  }, 30_000);

  it('teamMembers(): a MANAGER resolves their own roster (was [])', async () => {
    const users = makeService();

    const roster = await users.teamMembers(managerAActor);

    expect(roster.map((u) => u.id)).toContain(TELECALLER_ID);
  }, 30_000);

  it('teamMembers(): a TELECALLER resolves their team + manager (was [])', async () => {
    const users = makeService();
    const telecallerActor = actorFor({ sub: TELECALLER_ID, role: 'TELECALLER' });

    const roster = await users.teamMembers(telecallerActor);

    // Their own row plus the team's manager - both via RLS-gated reads.
    expect(roster.map((u) => u.id)).toContain(TELECALLER_ID);
    expect(roster.map((u) => u.id)).toContain(MANAGER_A_ID);
  }, 30_000);

  it('projectSalesExecs(): an ADMIN resolves execs owning leads in a project', async () => {
    const users = makeService();
    const seId = createId();
    const projectId = createId();
    const leadId = createId();

    // Seed an ADMIN-owned project + a SALES_EXEC who owns a lead in it.
    await adminSeed(async (db) => {
      await db.user.upsert({
        where: { id: seId },
        update: {},
        create: {
          id: seId,
          email: `${seId}@test.local`,
          name: 'RLS Test SE',
          role: 'SALES_EXEC',
          organizationId: ORG,
          mustChangePassword: false,
        },
      });
      await db.project.create({
        data: {
          id: projectId,
          name: `RLS Test Project ${projectId.slice(0, 6)}`,
          slug: `rls-test-${projectId.slice(0, 8)}`,
          address: 'RLS Test Address',
          organizationId: ORG,
        },
      });
      await db.lead.create({
        data: {
          id: leadId,
          name: 'RLS Test Lead',
          phone: `91${leadId.slice(0, 8)}`,
          phoneE164: `91${leadId.slice(0, 8)}`,
          source: 'WEBSITE',
          state: 'NEW',
          teamId: TEAM_A_ID,
          ownerId: seId,
          ownerType: 'SALES_EXEC',
          projectId,
          organizationId: ORG,
        },
      });
    });

    const execs = await users.projectSalesExecs(adminActor, projectId);
    expect(execs.map((e) => e.id)).toContain(seId);

    await adminSeed(async (db) => {
      await db.lead.deleteMany({ where: { id: leadId } });
      await db.project.deleteMany({ where: { id: projectId } });
      await db.user.deleteMany({ where: { id: seId } });
    });
  }, 30_000);

  it('projectSalesExecs(): resolves a project-staffed exec who owns NO lead (T-VISIT-EXEC-SOURCE)', async () => {
    // THE REPORTED BUG. A project can have an assigned SALES_EXEC who simply has
    // not been given a lead yet. The original implementation derived the picker
    // from LEAD OWNERSHIP only, so that exec was invisible and the schedule-visit
    // dialog had no assignee to offer - reported by the owner against
    // shadhil-metro-heights, which had exactly that situation.
    //
    // The link must come from PROJECT STAFFING (ProjectTeam -> Team -> member).
    const users = makeService();
    const seId = createId();
    const teamId = createId();
    const projectId = createId();

    await adminSeed(async (db) => {
      await db.team.create({
        data: {
          id: teamId,
          name: `RLS Staffed Team ${teamId.slice(0, 6)}`,
          organizationId: ORG,
        },
      });
      await db.user.upsert({
        where: { id: seId },
        update: {},
        create: {
          id: seId,
          email: `${seId}@test.local`,
          name: 'RLS Staffed SE',
          role: 'SALES_EXEC',
          organizationId: ORG,
          mustChangePassword: false,
        },
      });
      // TeamMember has a COMPOSITE @@id([userId, teamId]) - no `id` column.
      await db.teamMember.create({
        data: { userId: seId, teamId, organizationId: ORG },
      });
      await db.project.create({
        data: {
          id: projectId,
          name: `RLS Staffed Project ${projectId.slice(0, 6)}`,
          slug: `rls-staffed-${projectId.slice(0, 8)}`,
          address: 'RLS Staffed Address',
          organizationId: ORG,
        },
      });
      // The team is staffed onto the project. NOTE: no Lead is created at all -
      // that is the whole point of this test.
      // ProjectTeam has a COMPOSITE @@id([projectId, teamId]) - no `id` column.
      await db.projectTeam.create({
        data: { projectId, teamId, organizationId: ORG },
      });
    });

    const execs = await users.projectSalesExecs(adminActor, projectId);
    expect(execs.map((e) => e.id)).toContain(seId);

    await adminSeed(async (db) => {
      await db.projectTeam.deleteMany({ where: { projectId } });
      await db.project.deleteMany({ where: { id: projectId } });
      await db.teamMember.deleteMany({ where: { teamId } });
      await db.user.deleteMany({ where: { id: seId } });
      await db.team.deleteMany({ where: { id: teamId } });
    });
  }, 30_000);
});
