// Invites service - live-DB integration suite (2026-11-20).
//
// WHY A REAL DB rather than a mocked client: every meaningful property of this
// feature is enforced by POSTGRES, not by TypeScript. The claim is an
// updateMany guarded by an RLS policy (invite_update_accept), the new user's
// TeamMember insert is scoped by app.invite_team_id, and the accept path's
// re-read is fenced by app.invite_token_hash. A mocked client returns data
// regardless of the GUCs, so it would report all of that as working while it
// was not - exactly the failure mode users.service.rls.test.ts documents.
//
// Skips cleanly when DATABASE_URL is absent (CI's unit job has no DB), and
// RLS_MATRIX_REQUIRED=true turns that skip into a failure where a DB is
// supposed to exist.
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createId } from '@paralleldrive/cuid2';
import type { JwtPayload } from '@shadhil/auth';
import {
  INVITE_ALREADY_PENDING,
  INVITE_EMAIL_TAKEN,
  CreateInviteDtoSchema,
} from '@shadhil/api-types';
import { prisma as runtimePrisma, type PrismaClient, withRlsContext } from '@shadhil/database';

import { PrismaService } from '../prisma/prisma.module';
import { hashInviteToken } from './invites.tokens';
import { InvitesService } from './invites.service';

const HAS_DB = Boolean(process.env.DATABASE_URL);
const REQUIRED = process.env.RLS_MATRIX_REQUIRED === 'true';
const SKIP = !HAS_DB && !REQUIRED;
const prisma: PrismaClient | null = HAS_DB ? runtimePrisma : null;

if (!HAS_DB && REQUIRED) {
  throw new Error(
    'RLS_MATRIX_REQUIRED=true but DATABASE_URL is unset - the invite RLS matrix cannot run.',
  );
}

const ORG = 'ceid01lpfe1esm8jwsxid41k28';

const ADMIN_ID = createId();
const MANAGER_ID = createId();
const OTHER_MANAGER_ID = createId();
const TEAM_ID = createId();
const OTHER_TEAM_ID = createId();

/** Unique-ish email per run so a rerun never trips the partial unique index. */
function inviteEmail(tag: string): string {
  return `${tag}-${createId()}@test.local`;
}

/**
 * A UNIQUE valid Indian mobile per call.
 *
 * `User` has a partial unique index on (phone, organizationId), so every
 * accepted invite must carry a distinct number or the second accept fails with
 * a P2002 that has nothing to do with the code under test. 10 digits starting
 * 6-9 is a valid Indian mobile, and the counter keeps runs deterministic
 * within a process while staying out of real data's way.
 */
let phoneCounter = 0;
function uniquePhone(): string {
  // Seed the counter from the clock so a rerun against a DB that still holds
  // users from a previous process cannot collide on the org-wide unique index.
  // First call in a process starts somewhere fresh; later calls increment.
  if (phoneCounter === 0) {
    phoneCounter = 10_000_000 + (Date.now() % 20_000_000);
  }
  phoneCounter += 1;
  // 91 + 10 digits starting 9 keeps it a valid Indian mobile for PhoneSchema.
  return `919${String(phoneCounter).slice(-9)}`;
}

/**
 * Assert a thrown CodedException carries `code`.
 *
 * `CodedException` extends HttpException, which nests the body under
 * `response` - so `err.code` is undefined while `err.getResponse().code` is
 * the real contract the web client reads. Asserting the getter keeps the test
 * honest about the wire shape rather than about the class field.
 */
async function expectCoded(promise: Promise<unknown>, code: string): Promise<void> {
  await promise.then(
    () => {
      throw new Error(`expected rejection with code ${code}, but it resolved`);
    },
    (err: { getResponse?: () => unknown }) => {
      const body = err.getResponse?.() as { code?: string } | undefined;
      expect(body?.code).toBe(code);
    },
  );
}

function actorFor(sub: string, role: JwtPayload['role']): JwtPayload {
  return {
    sub,
    email: `${sub}@test.local`,
    role,
    organizationId: ORG,
    iat: 0,
    exp: 0,
    iss: 'shadhil-crm',
  };
}

const adminActor = actorFor(ADMIN_ID, 'ADMIN');
const managerActor = actorFor(MANAGER_ID, 'MANAGER');

function makeService(): InvitesService {
  return new InvitesService({ $client: prisma } as unknown as PrismaService);
}

async function seed<T>(fn: (db: PrismaClient) => Promise<T>): Promise<T> {
  if (prisma === null) throw new Error('prisma missing');
  return withRlsContext(
    prisma,
    { userId: ADMIN_ID, role: 'ADMIN', organizationId: ORG },
    async (tx) => fn(tx as unknown as PrismaClient),
  );
}

/** Delete every invite this suite created, so reruns stay clean. */
async function cleanupInvites(): Promise<void> {
  if (prisma === null) return;

  // Only touch rows THIS suite created. An earlier draft used a broad
  // `email contains '@test.local'` filter and hit `Lead_ownerId_fkey` - other
  // suites own leads for their own @test.local fixtures, so a shared-DB
  // cleanup must be maximally narrow.
  await seed(async (db) => {
    // Invites first (FK to User), then the accepted users they produced.
    const invites = await db.invite.findMany({
      where: { invitedById: { in: [ADMIN_ID, MANAGER_ID] } },
      select: { id: true, acceptedByUserId: true, email: true },
    });
    await db.invite.deleteMany({ where: { id: { in: invites.map((i) => i.id) } } });

    const acceptedIds = invites
      .map((i) => i.acceptedByUserId)
      .filter((id): id is string => id !== null);
    const acceptedEmails = invites.map((i) => i.email);

    // Delete the accepted accounts by the ids the invites point at - never by
    // a pattern that could match another suite's user.
    if (acceptedIds.length > 0) {
      await db.teamMember.deleteMany({ where: { userId: { in: acceptedIds } } });
      await db.auditLog.deleteMany({ where: { entityId: { in: acceptedIds } } });
      await db.account.deleteMany({ where: { accountId: { in: acceptedIds } } });
      await db.user.deleteMany({ where: { id: { in: acceptedIds } } });
    }
    // Belt-and-braces for a user created by a failed accept whose invite was
    // never claimed: match on the exact emails this suite minted.
    if (acceptedEmails.length > 0) {
      await db.user.deleteMany({
        where: { email: { in: acceptedEmails }, organizationId: ORG },
      });
    }
  });

  // Then the fixture actors + teams the suite owns outright.
  await prisma.auditLog.deleteMany({
    where: { userId: { in: [ADMIN_ID, MANAGER_ID, OTHER_MANAGER_ID] } },
  });
  await prisma.user.deleteMany({ where: { id: { in: [ADMIN_ID, MANAGER_ID, OTHER_MANAGER_ID] } } });
  await prisma.team.deleteMany({ where: { id: { in: [TEAM_ID, OTHER_TEAM_ID] } } });
}

beforeAll(async () => {
  if (prisma === null) return;
  await seed(async (db) => {
    for (const [id, role, name] of [
      [ADMIN_ID, 'ADMIN', 'Invite Test Admin'],
      [MANAGER_ID, 'MANAGER', 'Invite Test Manager'],
      [OTHER_MANAGER_ID, 'MANAGER', 'Invite Test Other Manager'],
    ] as const) {
      await db.user.upsert({
        where: { id },
        update: { role },
        create: { id, email: `${id}@test.local`, name, role, organizationId: ORG },
      });
    }
    for (const [id, name, managerId] of [
      [TEAM_ID, `Invite Team ${TEAM_ID.slice(0, 6)}`, MANAGER_ID],
      [OTHER_TEAM_ID, `Invite Other Team ${OTHER_TEAM_ID.slice(0, 6)}`, OTHER_MANAGER_ID],
    ] as const) {
      await db.team.upsert({
        where: { id },
        update: { managerId },
        create: { id, name, managerId, organizationId: ORG },
      });
    }
  });
});

afterAll(async () => {
  await cleanupInvites();
});

describe.skipIf(SKIP)('InvitesService.create - hierarchy and guards', () => {
  it('creates an invite and returns the one-time link set', async () => {
    const service = makeService();
    const email = inviteEmail('create');
    const result = await service.create(adminActor, {
      email,
      name: 'Ramesh Kumar',
      phone: uniquePhone(),
      role: 'TELECALLER',
      teamId: TEAM_ID,
    });

    expect(result.invite.email).toBe(email);
    expect(result.invite.status).toBe('PENDING');
    expect(result.invite.team?.id).toBe(TEAM_ID);
    expect(result.inviteUrl).toContain('/invite/');
    expect(result.whatsappUrl).toContain(`wa.me/${result.invite.phone}`);
    expect(result.messageText).toContain('Ramesh');

    // The raw token in the URL must hash to the stored column, and the raw
    // token must not be stored anywhere.
    const rawToken = result.inviteUrl.split('/invite/')[1] ?? '';
    const stored = await seed((db) =>
      db.invite.findUnique({ where: { id: result.invite.id }, select: { tokenHash: true } }),
    );
    expect(stored?.tokenHash).toBe(hashInviteToken(rawToken));
    expect(stored?.tokenHash).not.toBe(rawToken);
  });

  it('stores the digits-only phone it is given (the DTO normalizes upstream)', async () => {
    // NOTE: normalization happens in `PhoneSchema`, i.e. at the CONTROLLER
    // boundary. The service receives an already-transformed DTO, so this
    // asserts the contract it actually has - it stores `dto.phone` verbatim.
    // Passing '+91...' straight to the service (bypassing the DTO) would store
    // the plus, which is why the controller must always parse the body.
    const service = makeService();
    const parsed = CreateInviteDtoSchema.parse({
      email: inviteEmail('phone'),
      name: 'Phone Test',
      phone: '+919876543210',
      role: 'TELECALLER',
      teamId: TEAM_ID,
    });
    const result = await service.create(adminActor, parsed);
    expect(result.invite.phone).toBe(parsed.phone);
    // And the derived link therefore has no stray '+' in the wa.me path.
    expect(result.whatsappUrl).not.toContain('+91');
  });

  it('refuses a second live invite for the same address', async () => {
    const service = makeService();
    const email = inviteEmail('dupe');
    const dto = {
      email,
      name: 'Dupe Test',
      phone: uniquePhone(),
      role: 'TELECALLER' as const,
      teamId: TEAM_ID,
    };
    await service.create(adminActor, dto);
    await expectCoded(service.create(adminActor, dto), INVITE_ALREADY_PENDING);
  });

  it('refuses an address that already belongs to a user in this org', async () => {
    const service = makeService();
    await expectCoded(
      service.create(adminActor, {
        // MANAGER_ID is a real user in ORG.
        email: `${MANAGER_ID}@test.local`,
        name: 'Taken Test',
        phone: uniquePhone(),
        role: 'TELECALLER',
        teamId: TEAM_ID,
      }),
      INVITE_EMAIL_TAKEN,
    );
  });

  it('refuses CUSTOMER - it needs a lead this form cannot collect', async () => {
    const service = makeService();
    await expectCoded(
      service.create(adminActor, {
        email: inviteEmail('cust'),
        name: 'Customer Test',
        phone: uniquePhone(),
        role: 'CUSTOMER',
      }),
      'INVITE_ROLE_NOT_SUPPORTED',
    );
  });

  it('lets a MANAGER invite into their own team but not another manager’s', async () => {
    const service = makeService();
    await expect(
      service.create(managerActor, {
        email: inviteEmail('mgr-own'),
        name: 'Own Team',
        phone: uniquePhone(),
        role: 'TELECALLER',
        teamId: TEAM_ID,
      }),
    ).resolves.toBeTruthy();

    await expect(
      service.create(managerActor, {
        email: inviteEmail('mgr-other'),
        name: 'Other Team',
        phone: uniquePhone(),
        role: 'TELECALLER',
        teamId: OTHER_TEAM_ID,
      }),
    ).rejects.toThrow(/own team/i);
  });

  it('refuses ENGINEER from a MANAGER (admin-class act)', async () => {
    const service = makeService();
    await expect(
      service.create(managerActor, {
        email: inviteEmail('eng'),
        name: 'Engineer Test',
        phone: uniquePhone(),
        role: 'ENGINEER',
        teamId: TEAM_ID,
      }),
    ).rejects.toThrow(/ENGINEER/i);
  });

  it('requires a team for a team-bound role', async () => {
    const service = makeService();
    await expect(
      service.create(adminActor, {
        email: inviteEmail('noteam'),
        name: 'No Team',
        phone: uniquePhone(),
        role: 'TELECALLER',
      }),
    ).rejects.toThrow(/teamId is required/i);
  });
});

describe.skipIf(SKIP)('InvitesService.list - scope and the derived-status filter', () => {
  it('narrows to EXPIRED via SQL, not the stored column', async () => {
    const service = makeService();
    const created = await service.create(adminActor, {
      email: inviteEmail('expiring'),
      name: 'Expiring Test',
      phone: uniquePhone(),
      role: 'TELECALLER',
      teamId: TEAM_ID,
    });

    // Backdate the deadline: nothing writes EXPIRED to the column, so a naive
    // `WHERE status = 'EXPIRED'` would return nothing here.
    await seed((db) =>
      db.invite.update({
        where: { id: created.invite.id },
        data: { expiresAt: new Date(Date.now() - 60_000) },
      }),
    );

    const expired = await service.list(adminActor, { status: ['EXPIRED'], limit: 200, offset: 0 });
    expect(expired.rows.some((r) => r.id === created.invite.id)).toBe(true);
    expect(expired.rows.every((r) => r.status === 'EXPIRED')).toBe(true);

    const pending = await service.list(adminActor, { status: ['PENDING'], limit: 200, offset: 0 });
    expect(pending.rows.some((r) => r.id === created.invite.id)).toBe(false);
  });

  it('scopes a MANAGER to their own team’s invites', async () => {
    const service = makeService();
    const rows = await service.list(managerActor, { limit: 200, offset: 0 });
    // Every row a manager sees must belong to a team they lead.
    for (const row of rows.rows) {
      expect(row.team?.id).toBe(TEAM_ID);
    }
  });
});

describe.skipIf(SKIP)('InvitesService.resend / revoke', () => {
  it('resend rotates the token so the old link dies', async () => {
    const service = makeService();
    const created = await service.create(adminActor, {
      email: inviteEmail('resend'),
      name: 'Resend Test',
      phone: uniquePhone(),
      role: 'TELECALLER',
      teamId: TEAM_ID,
    });
    const oldToken = created.inviteUrl.split('/invite/')[1] ?? '';
    const resent = await service.resend(adminActor, created.invite.id);
    const newToken = resent.inviteUrl.split('/invite/')[1] ?? '';

    expect(newToken).not.toBe(oldToken);
    // The old token no longer resolves at all.
    await expectCoded(service.preview(oldToken), 'INVITE_INVALID');
    // The new one does.
    await expect(service.preview(newToken)).resolves.toBeTruthy();
  });

  it('revoke makes the link 410 and is idempotent', async () => {
    const service = makeService();
    const created = await service.create(adminActor, {
      email: inviteEmail('revoke'),
      name: 'Revoke Test',
      phone: uniquePhone(),
      role: 'TELECALLER',
      teamId: TEAM_ID,
    });
    const token = created.inviteUrl.split('/invite/')[1] ?? '';

    const revoked = await service.revoke(adminActor, created.invite.id);
    expect(revoked.status).toBe('REVOKED');
    await expectCoded(service.preview(token), 'INVITE_REVOKED');

    // Second revoke: same end state, not an error.
    const again = await service.revoke(adminActor, created.invite.id);
    expect(again.status).toBe('REVOKED');
  });

  it('an expired invite reports EXPIRED and cannot be accepted', async () => {
    const service = makeService();
    const created = await service.create(adminActor, {
      email: inviteEmail('expire-accept'),
      name: 'Expired Accept',
      phone: uniquePhone(),
      role: 'TELECALLER',
      teamId: TEAM_ID,
    });
    const token = created.inviteUrl.split('/invite/')[1] ?? '';
    await seed((db) =>
      db.invite.update({
        where: { id: created.invite.id },
        data: { expiresAt: new Date(Date.now() - 60_000) },
      }),
    );

    await expectCoded(service.preview(token), 'INVITE_EXPIRED');
    await expectCoded(
      service.accept(token, { name: 'Too Late', password: 'password123' }),
      'INVITE_EXPIRED',
    );

    // An expired invite must NOT have been flipped to ACCEPTED on the way out.
    const row = await seed((db) =>
      db.invite.findUnique({
        where: { id: created.invite.id },
        select: { status: true, acceptedAt: true },
      }),
    );
    expect(row?.status).toBe('PENDING');
    expect(row?.acceptedAt).toBeNull();
  });
});

describe.skipIf(SKIP)('InvitesService.accept - the transaction', () => {
  it('provisions User + credential + TeamMember + audits in one transaction', async () => {
    const service = makeService();
    const email = inviteEmail('accept-ok');
    const created = await service.create(adminActor, {
      email,
      name: 'Accept Test',
      phone: uniquePhone(),
      role: 'TELECALLER',
      teamId: TEAM_ID,
    });
    const token = created.inviteUrl.split('/invite/')[1] ?? '';

    const result = await service.accept(token, {
      name: 'Accepted Person',
      password: 'password123',
    });
    expect(result.ok).toBe(true);
    expect(result.email).toBe(email);

    const user = await prisma!.user.findFirst({
      where: { email, organizationId: ORG },
      select: { id: true, role: true, phone: true, mustChangePassword: true },
    });
    expect(user).not.toBeNull();
    expect(user?.role).toBe('TELECALLER');
    // The invitee chose their own password, so the rotation gate is NOT armed.
    expect(user?.mustChangePassword).toBe(false);
    // Omitted phone keeps the invite's number.
    expect(user?.phone).toBe(created.invite.phone);

    // Credential row exists in better-auth's sign-in shape.
    // Account has NO RLS, so the bare client is correct here (same precedent
    // as users.service.create, which writes credentials on the bare client).
    const account = await prisma!.account.findFirst({
      where: { providerId: 'credential', accountId: user!.id },
      select: { id: true, password: true },
    });
    expect(account).not.toBeNull();
    expect(account?.password).toBeTruthy();

    // Membership landed on the invite's team.
    // TeamMember is FORCE RLS too - the bare client sees nothing.
    const membership = await seed((db) =>
      db.teamMember.findFirst({
        where: { userId: user!.id, teamId: TEAM_ID },
        select: { teamId: true },
      }),
    );
    expect(membership?.teamId).toBe(TEAM_ID);

    // Both audit rows, in the same transaction as the action. AuditLog is
    // FORCE RLS, so the bare client returns ZERO of these - read through the
    // admin context.
    const audits = await seed((db) =>
      db.auditLog.findMany({
        where: { entityId: { in: [created.invite.id, user!.id] } },
        select: { action: true },
      }),
    );
    const actions = audits.map((a) => a.action);
    expect(actions).toContain('invite.accept');
    expect(actions).toContain('user.create');

    // The invite is claimed.
    const invite = await seed((db) =>
      db.invite.findUnique({
        where: { id: created.invite.id },
        select: { status: true, acceptedByUserId: true },
      }),
    );
    expect(invite?.status).toBe('ACCEPTED');
    expect(invite?.acceptedByUserId).toBe(user!.id);
  });

  it('a corrected phone is stored AND recorded as a change', async () => {
    const service = makeService();
    const created = await service.create(adminActor, {
      email: inviteEmail('phone-fix'),
      name: 'Phone Fix',
      phone: uniquePhone(),
      role: 'TELECALLER',
      teamId: TEAM_ID,
    });
    const token = created.inviteUrl.split('/invite/')[1] ?? '';

    const corrected = uniquePhone();
    await service.accept(token, {
      name: 'Phone Fix Person',
      password: 'password123',
      phone: corrected,
    });

    const user = await prisma!.user.findFirst({
      where: { email: created.invite.email, organizationId: ORG },
      select: { id: true, phone: true },
    });
    expect(user?.phone).toBe(corrected);

    // The change is auditable: an invite must not be silently redirected to a
    // different handset. AuditLog is FORCE RLS - read via the admin context.
    const audit = await seed((db) =>
      db.auditLog.findFirst({
        where: { entityId: created.invite.id, action: 'invite.accept' },
        select: { after: true },
      }),
    );
    expect(audit?.after).toMatchObject({
      phoneOnInvite: created.invite.phone,
      phoneUsed: corrected,
    });
  });

  it('rejects a replayed token with 410 and creates no second user', async () => {
    const service = makeService();
    const created = await service.create(adminActor, {
      email: inviteEmail('replay'),
      name: 'Replay Test',
      phone: uniquePhone(),
      role: 'TELECALLER',
      teamId: TEAM_ID,
    });
    const token = created.inviteUrl.split('/invite/')[1] ?? '';

    await service.accept(token, { name: 'First', password: 'password123' });
    await expectCoded(
      service.accept(token, { name: 'Second', password: 'password123' }),
      'INVITE_ALREADY_ACCEPTED',
    );

    const count = await prisma!.user.count({
      where: { email: created.invite.email, organizationId: ORG },
    });
    expect(count).toBe(1);
  });

  it('concurrent accepts: exactly one wins', async () => {
    const service = makeService();
    const created = await service.create(adminActor, {
      email: inviteEmail('race'),
      name: 'Race Test',
      phone: uniquePhone(),
      role: 'TELECALLER',
      teamId: TEAM_ID,
    });
    const token = created.inviteUrl.split('/invite/')[1] ?? '';

    const results = await Promise.allSettled([
      service.accept(token, { name: 'Race A', password: 'password123' }),
      service.accept(token, { name: 'Race B', password: 'password123' }),
    ]);
    const fulfilled = results.filter((r) => r.status === 'fulfilled');
    expect(fulfilled).toHaveLength(1);

    // Exactly one account, whatever the ordering.
    const count = await prisma!.user.count({
      where: { email: created.invite.email, organizationId: ORG },
    });
    expect(count).toBe(1);
  });

  it('a bad token is refused before any write', async () => {
    const service = makeService();
    await expectCoded(
      service.accept('not-a-real-token', { name: 'Nope', password: 'password123' }),
      'INVITE_INVALID',
    );
  });
});
