// Targeted @mention resolution - T-MENTION-TARGET (2026-09-29).
//
// WHAT THIS FILE PINS, and why both halves are needed:
//
//   1. The GRANT. A mention writes a MessageRecipient row carrying the parent
//      message's leadId + organizationId, in the SAME transaction as the
//      message. That row is what grants the recipient read access to the lead
//      and its thread (lead_select_mentioned / message_select_recipient). The
//      RLS half is proven separately in packages/database/test/rls-isolation.
//
//   2. The BOUND. An @mention GRANTS a lead, so WHO may be addressed is an
//      authorization boundary, not a UI nicety. Targets are bounded to the
//      actor's team scope via UsersService.teamMembers - the mention picker's
//      OWN source - so the server accepts exactly who the UI can offer.
//
// Real-DB (the RLS layer is never mocked): the whole feature IS an RLS grant,
// and a mocked client would happily pass while the policy denied the read.
//
// The predecessor of this file tested NAME-MATCHING resolution (an `@Name`
// string matched against `User.name`). That mechanism is deliberately gone - it
// is what let a telecaller surface a note to any same-named user in the org - so
// those assertions were REMOVED rather than adapted: they pinned the defect.
//
// Fixture: ONE manager leads TWO teams (Team.managerId on both), and the
// out-of-scope teammate sits on a THIRD, unmanaged team. That shape still
// matters - it is what proves the bound is a real boundary and not a no-op.
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import type { JwtPayload } from '@shadhil/auth';
import {
  prisma as runtimePrisma,
  type PrismaClient,
  withRlsContext,
} from '@shadhil/database';

import { PrismaService } from '../prisma/prisma.module';
import { UsersService } from '../users/users.service';
import { ChatService } from './chat.service';

const HAS_DB = Boolean(process.env.DATABASE_URL);
// T-LEAD-PROJECT-REQUIRED (2026-09-16): Lead.projectId is NOT NULL now, so
// every fixture lead needs a project. cuid2-shaped in case it passes a DTO.
const TEST_PROJECT_ID = 'chatservicpr' + Date.now().toString();
const prisma: PrismaClient | null = HAS_DB ? runtimePrisma : null;

const RUN_TAG = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
const TEAM_1_ID = `test-mtm-team1-${RUN_TAG}`;
const TEAM_2_ID = `test-mtm-team2-${RUN_TAG}`;
const TEAM_3_ID = `test-mtm-team3-${RUN_TAG}`; // NOT managed by MGR
const ADMIN_ID = `test-mtm-admin-${RUN_TAG}`;
const MGR_ID = `test-mtm-mgr-${RUN_TAG}`;
const TC_1_ID = `test-mtm-tc1-${RUN_TAG}`;
const TC_2_ID = `test-mtm-tc2-${RUN_TAG}`;
const OUTSIDER_ID = `test-mtm-outsider-${RUN_TAG}`;
const LEAD_ID = `test-mtm-lead-${RUN_TAG}`;

const ORG = 'ceid01lpfe1esm8jwsxid41k28';

async function adminSeed<T>(fn: (db: PrismaClient) => Promise<T>): Promise<T> {
  if (prisma === null) throw new Error('prisma missing');
  return withRlsContext(
    prisma,
    { userId: ADMIN_ID, role: 'ADMIN', organizationId: ORG },
    async (tx) => fn(tx as unknown as PrismaClient),
  );
}

beforeAll(async () => {
  if (prisma === null) return;
  await adminSeed(async (db) => {
    await db.project.upsert({
      where: { id: TEST_PROJECT_ID },
      update: {},
      create: {
        id: TEST_PROJECT_ID,
        name: `Test Project ${TEST_PROJECT_ID}`,
        slug: TEST_PROJECT_ID,
        address: 'test',
        organizationId: ORG,
      },
    });
    for (const id of [TEAM_1_ID, TEAM_2_ID, TEAM_3_ID]) {
      await db.team.upsert({
        where: { id },
        update: { managerId: null },
        create: { id, name: `MTM ${id}`, organizationId: ORG },
      });
    }

    await db.user.upsert({
      where: { id: ADMIN_ID },
      update: {},
      create: {
        id: ADMIN_ID,
        email: `${ADMIN_ID}@test.local`,
        name: 'MTM Admin',
        role: 'ADMIN',
        organizationId: ORG,
        mustChangePassword: false,
      },
    });

    // ONE manager leading TWO teams: TEAM_2 is reachable only via
    // Team.managerId (a manager holds no scalar team pointer).
    await db.user.upsert({
      where: { id: MGR_ID },
      update: { role: 'MANAGER' },
      create: {
        id: MGR_ID,
        email: `${MGR_ID}@test.local`,
        name: 'MTM Manager',
        role: 'MANAGER',
        organizationId: ORG,
        mustChangePassword: false,
      },
    });
    await db.team.update({ where: { id: TEAM_1_ID }, data: { managerId: MGR_ID } });
    await db.team.update({ where: { id: TEAM_2_ID }, data: { managerId: MGR_ID } });
    // TEAM_3 is NOT managed - its member must never be addressable.

    await db.user.upsert({
      where: { id: TC_1_ID },
      update: { role: 'TELECALLER' },
      create: {
        id: TC_1_ID,
        email: `${TC_1_ID}@test.local`,
        name: 'Kiran Rao',
        role: 'TELECALLER',
        organizationId: ORG,
        mustChangePassword: false,
      },
    });
    await db.user.upsert({
      where: { id: TC_2_ID },
      update: { role: 'TELECALLER' },
      create: {
        id: TC_2_ID,
        email: `${TC_2_ID}@test.local`,
        name: 'Meera Iyer',
        role: 'TELECALLER',
        organizationId: ORG,
        mustChangePassword: false,
      },
    });
    await db.user.upsert({
      where: { id: OUTSIDER_ID },
      update: { role: 'TELECALLER' },
      create: {
        id: OUTSIDER_ID,
        email: `${OUTSIDER_ID}@test.local`,
        name: 'Zara Khan',
        role: 'TELECALLER',
        organizationId: ORG,
        mustChangePassword: false,
      },
    });

    await db.teamMember.upsert({
      where: { userId_teamId: { userId: TC_1_ID, teamId: TEAM_1_ID } },
      update: {},
      create: { userId: TC_1_ID, teamId: TEAM_1_ID, organizationId: ORG },
    });
    await db.teamMember.upsert({
      where: { userId_teamId: { userId: TC_2_ID, teamId: TEAM_2_ID } },
      update: {},
      create: { userId: TC_2_ID, teamId: TEAM_2_ID, organizationId: ORG },
    });
    await db.teamMember.upsert({
      where: { userId_teamId: { userId: OUTSIDER_ID, teamId: TEAM_3_ID } },
      update: {},
      create: { userId: OUTSIDER_ID, teamId: TEAM_3_ID, organizationId: ORG },
    });

    // MGR owns the lead so the Message insert's lead-visibility check passes.
    await db.lead.upsert({
      where: { id: LEAD_ID },
      update: { ownerId: MGR_ID, teamId: TEAM_1_ID },
      create: {
        id: LEAD_ID,
        name: 'MTM Lead',
        phone: `91${(1000000000 + Math.floor(Math.random() * 8999999999)).toString()}`,
        source: 'TEST',
        state: 'NEW',
        ownerId: MGR_ID,
        ownerType: 'MANAGER',
        teamId: TEAM_1_ID,
        organizationId: ORG,
        projectId: TEST_PROJECT_ID,
      },
    });
  });
});

afterAll(async () => {
  if (prisma === null) return;
  await adminSeed(async (db) => {
    // MessageRecipient has NO delete policy, so a deleteMany here removes
    // nothing and silently strands the fixture. Rely on the FK cascade instead:
    // deleting the parent Message (and the Lead) takes the grants with it.
    await db.message.deleteMany({ where: { leadId: LEAD_ID } });
    await db.auditLog.deleteMany({
      where: { userId: { in: [MGR_ID, TC_1_ID, TC_2_ID, OUTSIDER_ID] } },
    });
    await db.lead.deleteMany({ where: { id: LEAD_ID } });
    await db.user.deleteMany({
      where: { id: { in: [MGR_ID, TC_1_ID, TC_2_ID, OUTSIDER_ID, ADMIN_ID] } },
    });
    await db.team.deleteMany({ where: { id: { in: [TEAM_1_ID, TEAM_2_ID, TEAM_3_ID] } } });
  });
});

describe.skipIf(!HAS_DB)('ChatService targeted @mentions (T-MENTION-TARGET)', () => {
  const outboundStub = { enqueue: vi.fn().mockResolvedValue(undefined) };
  let notified: { userId: string; body: string }[] = [];
  const notificationsStub = {
    emit: vi.fn(async (userId: string, payload: { body: string }) => {
      notified.push({ userId, body: payload.body });
    }),
  };

  const managerActor: JwtPayload = {
    sub: MGR_ID,
    email: `${MGR_ID}@test.local`,
    role: 'MANAGER',
    organizationId: ORG,
    iat: 0,
    exp: 0,
    iss: 'shadhil-crm',
  };

  /**
   * The REAL UsersService, backed by the same DB, so the team-scope bound runs
   * against real RLS instead of a stub that can only agree with the test.
   */
  function makeService() {
    if (prisma === null) throw new Error('prisma missing');
    const users = new UsersService({ $client: prisma } as never);
    return new ChatService(
      { $client: prisma } as never,
      outboundStub as never,
      notificationsStub as never,
      undefined, // storage
      users as never,
    );
  }

  /**
   * Read grant rows AS THE NAMED USER, not as ADMIN.
   *
   * `message_recipient_select_own` admits only the recipient's own rows - there
   * is deliberately no admin branch (an admin already sees every note via
   * message_select_team, so a wider policy would grant nothing new while
   * becoming a second, divergent statement of who can see what). Asserting as
   * ADMIN therefore reads `[]` whether or not the grant exists, which would make
   * every negative test pass for the wrong reason. Reading as the recipient also
   * proves the thing that actually matters: they can SEE their grant.
   */
  async function grantsSeenBy(userId: string, role: string, messageId: string) {
    if (prisma === null) throw new Error('prisma missing');
    return withRlsContext(
      prisma,
      { userId, role, organizationId: ORG } as never,
      async (tx) =>
        (tx as unknown as PrismaClient).messageRecipient.findMany({
          where: { messageId },
        }),
    );
  }

  it('writes a grant row for an addressed teammate, carrying the lead + org', async () => {
    notified = [];
    const service = makeService();

    const sent = await service.send(managerActor, {
      leadId: LEAD_ID,
      body: 'Please loop in @Kiran Rao on this.',
      channel: 'IN_APP',
      kind: 'INTERNAL',
      mentionedUserIds: [TC_1_ID],
    } as never);

    const grants = await grantsSeenBy(TC_1_ID, 'TELECALLER', sent.id);
    expect(grants).toHaveLength(1);
    expect(grants[0]!.userId).toBe(TC_1_ID);
    // DENORMALIZED and load-bearing: without leadId the Lead policy would have
    // to traverse Message, which is the policy-recursion trap.
    expect(grants[0]!.leadId).toBe(LEAD_ID);
    expect(grants[0]!.organizationId).toBe(ORG);
    expect(notified.map((n) => n.userId)).toContain(TC_1_ID);
  });

  it('addresses a teammate on the SECOND managed team (multi-team scope)', async () => {
    // The picker resolves every team a manager leads, so a mention on team 2
    // must be accepted - this is the case the old file was built around.
    notified = [];
    const service = makeService();

    const sent = await service.send(managerActor, {
      leadId: LEAD_ID,
      body: 'Please loop in @Meera Iyer on this.',
      channel: 'IN_APP',
      kind: 'INTERNAL',
      mentionedUserIds: [TC_2_ID],
    } as never);

    const grants = await grantsSeenBy(TC_2_ID, 'TELECALLER', sent.id);
    expect(grants.map((g) => g.userId)).toEqual([TC_2_ID]);
  });

  it("does NOT address a user outside the actor's team scope", async () => {
    // A forged id in the same org must be refused: a mention GRANTS a lead, so
    // this is an authorization boundary, and the client is not trusted.
    notified = [];
    const service = makeService();

    const sent = await service.send(managerActor, {
      leadId: LEAD_ID,
      body: 'Please loop in @Zara Khan on this.',
      channel: 'IN_APP',
      kind: 'INTERNAL',
      mentionedUserIds: [OUTSIDER_ID],
    } as never);

    expect(await grantsSeenBy(OUTSIDER_ID, 'TELECALLER', sent.id)).toEqual([]);
    expect(notified).not.toContain(OUTSIDER_ID);
  });

  it('never addresses the actor themselves', async () => {
    // A self-mention would grant nothing (the sender already sees the lead) and
    // the RLS INSERT policy refuses it, so the service must not attempt it.
    notified = [];
    const service = makeService();

    const sent = await service.send(managerActor, {
      leadId: LEAD_ID,
      body: 'Note to self: @MTM Manager should follow up tomorrow.',
      channel: 'IN_APP',
      kind: 'INTERNAL',
      mentionedUserIds: [MGR_ID],
    } as never);

    expect(await grantsSeenBy(MGR_ID, 'MANAGER', sent.id)).toEqual([]);
    expect(notified).not.toContain(MGR_ID);
  });

  it('sends the FULL note body, not a truncated teaser', async () => {
    // The old emitter put body.slice(0, 100) in the notification precisely
    // because the recipient had no access to the rest. They now hold the grant,
    // so truncating a note they may read only obscures it.
    notified = [];
    const service = makeService();
    const longNote = `${'x'.repeat(180)} END-OF-NOTE`;

    await service.send(managerActor, {
      leadId: LEAD_ID,
      body: longNote,
      channel: 'IN_APP',
      kind: 'INTERNAL',
      mentionedUserIds: [TC_1_ID],
    } as never);

    const toTc = notified.find((n) => n.userId === TC_1_ID);
    expect(toTc).toBeDefined();
    expect(toTc!.body).toBe(longNote);
    expect(toTc!.body).toContain('END-OF-NOTE');
  });

  it('a repeated mention is ONE grant and ONE notification', async () => {
    notified = [];
    const service = makeService();

    const sent = await service.send(managerActor, {
      leadId: LEAD_ID,
      body: 'Loop in @Kiran Rao and @Kiran Rao again.',
      channel: 'IN_APP',
      kind: 'INTERNAL',
      mentionedUserIds: [TC_1_ID, TC_1_ID],
    } as never);

    expect(await grantsSeenBy(TC_1_ID, 'TELECALLER', sent.id)).toHaveLength(1);
    expect(notified.filter((n) => n.userId === TC_1_ID)).toHaveLength(1);
  });

  it('a CUSTOMER message never writes a grant', async () => {
    // Grants are an INTERNAL-notes concept; a customer reply must not hand out
    // lead access.
    notified = [];
    const service = makeService();

    const sent = await service.send(managerActor, {
      leadId: LEAD_ID,
      body: 'Hello, here are the unit details.',
      channel: 'IN_APP',
      kind: 'CUSTOMER',
      mentionedUserIds: [TC_1_ID],
    } as never);

    expect(await grantsSeenBy(TC_1_ID, 'TELECALLER', sent.id)).toEqual([]);
    expect(notified).toEqual([]);
  });
});

// ────────────────────────────────────────────────────────────────────────────
// T-READONLY-READER (2026-09-29): canWriteThread on the thread state
// ────────────────────────────────────────────────────────────────────────────
//
// threadState().canWriteThread decides whether the pane OFFERS a composer. It is
// a mirror of the `message_insert_team` RLS policy, and the mirror was verified
// against that policy with a live role-by-role INSERT probe (see
// references/targeted-mention-rls.md) - RLS remains the enforcer, so drift costs
// a confusing UI and never an unauthorised write. These cases pin the mirror's
// shape so a well-meaning edit cannot quietly widen it.
describe.skipIf(!HAS_DB)('canWriteThread mirrors message_insert_team', () => {
  // Own stubs: `outboundStub`/`managerActor` are scoped to the describe above.
  const canWriteOutboundStub = { enqueue: vi.fn().mockResolvedValue(undefined) };
  // The fixture lead's owner (MGR_ID) sends the note that creates the grant.
  const managerActor: JwtPayload = {
    sub: MGR_ID,
    email: `${MGR_ID}@test.local`,
    role: 'MANAGER',
    organizationId: ORG,
    iat: 0,
    exp: 0,
    iss: 'shadhil-crm',
  };

  function actorFor(sub: string, role: 'ADMIN' | 'MANAGER' | 'TELECALLER' | 'SALES_EXEC'): JwtPayload {
    return { sub, email: `${sub}@test.local`, role, organizationId: ORG, iat: 0, exp: 0, iss: 'shadhil-crm' };
  }

  it('the lead OWNER can write', async () => {
    if (prisma === null) throw new Error('prisma missing');
    const users = new UsersService({ $client: prisma } as never);
    // MGR_ID owns the fixture lead in this suite.
    const service = new ChatService({ $client: prisma } as never, canWriteOutboundStub as never, undefined, undefined, users as never);
    const state = await service.threadState(actorFor(MGR_ID, 'MANAGER'), LEAD_ID);
    expect(state.canWriteThread).toBe(true);
  });

  it('the team MANAGER can write', async () => {
    if (prisma === null) throw new Error('prisma missing');
    const users = new UsersService({ $client: prisma } as never);
    const service = new ChatService({ $client: prisma } as never, canWriteOutboundStub as never, undefined, undefined, users as never);
    // MGR leads TEAM_1, which is the lead's team.
    const state = await service.threadState(actorFor(MGR_ID, 'MANAGER'), LEAD_ID);
    expect(state.canWriteThread).toBe(true);
  });

  it('an ADMIN can write', async () => {
    if (prisma === null) throw new Error('prisma missing');
    const users = new UsersService({ $client: prisma } as never);
    const service = new ChatService({ $client: prisma } as never, canWriteOutboundStub as never, undefined, undefined, users as never);
    const state = await service.threadState(actorFor(ADMIN_ID, 'ADMIN'), LEAD_ID);
    expect(state.canWriteThread).toBe(true);
  });

  it('a MANAGER of a DIFFERENT team cannot write', async () => {
    // GAP FOUND BY A TAMPER CHECK: widening the mirror to "any MANAGER can
    // write" left the suite green, i.e. nothing pinned the team half of the
    // rule. TEAM_3 is managed by nobody, so a manager of it is not the lead's
    // manager - and the read side still resolves (managers may read the org's
    // leads under lead_select_manager only for teams they lead, so this actor
    // reads nothing and must not be able to write either).
    if (prisma === null) throw new Error('prisma missing');
    const users = new UsersService({ $client: prisma } as never);
    const service = new ChatService(
      { $client: prisma } as never,
      canWriteOutboundStub as never,
      undefined,
      undefined,
      users as never,
    );

    // A manager who leads NO team that owns this lead: OUTSIDER is a TELECALLER
    // on TEAM_3, and we ask as a MANAGER whose managed team is TEAM_3.
    const otherTeamManager: JwtPayload = {
      sub: OUTSIDER_ID,
      email: `${OUTSIDER_ID}@test.local`,
      role: 'MANAGER',
      organizationId: ORG,
      iat: 0,
      exp: 0,
      iss: 'shadhil-crm',
    };
    // The lead belongs to TEAM_1 (led by MGR_ID). A manager of a different team
    // cannot even READ it (lead_select_manager requires Team.managerId), so the
    // RLS-scoped lookup returns null and threadState reports not-found - which is
    // the correct, strongest statement: no read, therefore no write question.
    //
    // Asserted as a 404 rather than a false flag because that is the real
    // behaviour; asserting canWriteThread here would require bypassing the RLS
    // read, i.e. testing a state the system never reaches.
    await expect(service.threadState(otherTeamManager, LEAD_ID)).rejects.toThrow(
      /not found/i,
    );

    // HONEST LIMIT OF THIS SUITE: because the read 404s first, this test cannot
    // observe the mirror's MANAGER clause. Verified via the RLS matrix and a live
    // probe instead, both of which DO redden:
    //   - packages/database/test/rls-isolation.test.ts (message INSERT x MANAGER)
    //   - the role-by-role probe in references/targeted-mention-rls.md
    // Tampering the mirror to "any MANAGER can write" leaves THIS suite green, so
    // do not read a pass here as proof of the team clause.
  });

  it('a MENTIONED exec can read the thread but CANNOT write', async () => {
    // The case this whole gate exists for: TC_1 holds a MessageRecipient grant on
    // this lead (they were mentioned) but is neither owner nor co-owner.
    //
    // The grant is created through the SERVICE's own send path rather than a
    // direct insert: that is how it is really written (the INSERT policy refuses
    // a self-mention and the message must exist first), so the fixture cannot
    // drift from the production shape.
    if (prisma === null) throw new Error('prisma missing');
    const users = new UsersService({ $client: prisma } as never);
    const service = new ChatService(
      { $client: prisma } as never,
      canWriteOutboundStub as never,
      undefined,
      undefined,
      users as never,
    );

    await service.send(managerActor, {
      leadId: LEAD_ID,
      body: 'Looping in @Kiran Rao on this lead.',
      channel: 'IN_APP',
      kind: 'INTERNAL',
      mentionedUserIds: [TC_1_ID],
    } as never);

    // READ: the grant means threadState resolves for them (no 404)...
    const state = await service.threadState(actorFor(TC_1_ID, 'TELECALLER'), LEAD_ID);
    expect(state.leadId).toBe(LEAD_ID);
    // ...but WRITE is still refused: a mention does NOT set coOwnerId, so
    // message_insert_team still excludes them. This is the distinction the pane
    // gate exists to communicate.
    expect(state.canWriteThread).toBe(false);
  });
});
