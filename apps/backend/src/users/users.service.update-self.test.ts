// Users service - updateSelf (PATCH /api/users/me) against the LIVE DB.
//
// WHY A REAL-DB TEST (same reasoning as users.service.rls.test.ts): the write
// spans two tables with different security models - `User` has NO row-level
// security (verified in the live DB: relrowsecurity = false) while `AuditLog`
// is FORCE RLS and its insert policy gates on app.user_id. A mocked client
// returns rows regardless of the `app.user_*` GUCs, so it would happily "pass"
// an audit insert that a real connection rejects. These tests run the real
// path, and skip cleanly when there is no DATABASE_URL (CI's unit job).
//
// Contracts pinned:
//   1. The write lands on the JWT subject's row.
//   2. The audit row lands IN THE SAME TRANSACTION, with a real before/after
//      pair - so an audit insert that RLS rejects fails the whole write rather
//      than leaving an unaudited rename (AGENTS.md A2/G-1).
//   3. The actor CANNOT reach another user's row - there is no id parameter in
//      the signature, and a second actor naming someone else's id in the body
//      still only changes their own name.
//   4. A JWT whose subject no longer exists fails loudly (404), not silently.
//   5. role/teamId are untouched by a self-edit.

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { NotFoundException } from '@nestjs/common';
import { createId } from '@paralleldrive/cuid2';
import type { JwtPayload } from '@shadhil/auth';
import {
  prisma as runtimePrisma,
  type PrismaClient,
  withRlsContext,
} from '@shadhil/database';

import { PrismaService } from '../prisma/prisma.module';
import { UsersService } from './users.service';

const HAS_DB = Boolean(process.env.DATABASE_URL);
const prisma: PrismaClient | null = HAS_DB ? runtimePrisma : null;

// The bootstrap org the rest of the users suites use.
const ORG = 'ceid01lpfe1esm8jwsxid41k28';

const SELF_ID = createId();
const OTHER_ID = createId();
const GHOST_ID = createId();
const TEAM_ID = createId();
const MANAGER_ID = createId();

const RUN_TAG = SELF_ID.slice(0, 6);

function actorFor(
  overrides: Partial<JwtPayload> & Pick<JwtPayload, 'sub' | 'role'>,
): JwtPayload {
  return {
    sub: overrides.sub,
    email: `${overrides.sub}@test.local`,
    role: overrides.role,
    organizationId: ORG,
    iat: 0,
    exp: 0,
    iss: 'shadhil-crm',
  };
}

function makeService(): UsersService {
  return new UsersService({ $client: prisma } as unknown as PrismaService);
}

async function bare<T>(fn: (db: PrismaClient) => Promise<T>): Promise<T> {
  if (prisma === null) throw new Error('prisma missing');
  return fn(prisma);
}

// Setup/teardown run through an ADMIN RLS context, not the bare connection.
//
// WHY: `Team` and `TeamMember` are FORCE ROW LEVEL SECURITY, so the bare
// (shadhil_app) client has no `app.user_*` GUCs and an INSERT is rejected with
// 42501 "new row violates row-level security policy" - verified by running it.
// This is the exact trap `users.service.rls.test.ts` documents. The bare
// client IS still correct for the `User` rows (User has no RLS at all), but a
// single admin-scoped helper keeps the fixture uniform and honest.
const ADMIN_SEED_ID = createId();

async function adminSeed<T>(fn: (db: PrismaClient) => Promise<T>): Promise<T> {
  if (prisma === null) throw new Error('prisma missing');
  return withRlsContext(
    prisma,
    { userId: ADMIN_SEED_ID, role: 'ADMIN', organizationId: ORG },
    async (tx) => fn(tx as unknown as PrismaClient),
  );
}

beforeAll(async () => {
  if (prisma === null) return;
  await adminSeed(async (db) => {
    await db.user.upsert({
      where: { id: ADMIN_SEED_ID },
      update: { role: 'ADMIN' },
      create: {
        id: ADMIN_SEED_ID,
        email: `${ADMIN_SEED_ID}@test.local`,
        name: 'Self-Edit Seed Admin',
        role: 'ADMIN',
        organizationId: ORG,
        mustChangePassword: false,
      },
    });
    await db.user.upsert({
      where: { id: MANAGER_ID },
      update: {},
      create: {
        id: MANAGER_ID,
        email: `${MANAGER_ID}@test.local`,
        name: 'Self-Edit Test Manager',
        role: 'MANAGER',
        organizationId: ORG,
        mustChangePassword: false,
      },
    });
    await db.user.upsert({
      where: { id: SELF_ID },
      update: { name: `Self Edit Original ${RUN_TAG}` },
      create: {
        id: SELF_ID,
        email: `${SELF_ID}@test.local`,
        name: `Self Edit Original ${RUN_TAG}`,
        role: 'TELECALLER',
        organizationId: ORG,
        mustChangePassword: false,
      },
    });
    await db.user.upsert({
      where: { id: OTHER_ID },
      update: { name: `Other Person Untouched ${RUN_TAG}` },
      create: {
        id: OTHER_ID,
        email: `${OTHER_ID}@test.local`,
        name: `Other Person Untouched ${RUN_TAG}`,
        role: 'TELECALLER',
        organizationId: ORG,
        mustChangePassword: false,
      },
    });
    await db.team.upsert({
      where: { id: TEAM_ID },
      update: {},
      create: {
        id: TEAM_ID,
        name: `Self Edit Team ${RUN_TAG}`,
        managerId: MANAGER_ID,
        organizationId: ORG,
      },
    });
    // Give the telecaller a team so we can prove the edit leaves it intact.
    await db.teamMember.upsert({
      where: { userId_teamId: { userId: SELF_ID, teamId: TEAM_ID } },
      update: {},
      create: { userId: SELF_ID, teamId: TEAM_ID, organizationId: ORG },
    });
  });
}, 30_000);

afterAll(async () => {
  if (prisma === null) return;
  await adminSeed(async (db) => {
    await db.auditLog.deleteMany({
      where: { entityId: { in: [SELF_ID, OTHER_ID, MANAGER_ID] } },
    });
    await db.teamMember.deleteMany({ where: { userId: { in: [SELF_ID, OTHER_ID] } } });
    await db.team.deleteMany({ where: { id: TEAM_ID } });
    await db.user.deleteMany({
      where: { id: { in: [SELF_ID, OTHER_ID, MANAGER_ID, ADMIN_SEED_ID] } },
    });
  });
}, 30_000);

/** Read a row back through admin context (see the RLS note above). */
async function readSelf(
  select: Record<string, boolean>,
): Promise<Record<string, unknown> | null> {
  return adminSeed((db) =>
    db.user.findUnique({
      where: { id: SELF_ID },
      select: select as never,
    }),
  ) as Promise<Record<string, unknown> | null>;
}

/** Read the OTHER user's row back through admin context. */
async function readOtherName(): Promise<string | null> {
  const row = (await adminSeed((db) =>
    db.user.findUnique({ where: { id: OTHER_ID }, select: { name: true } }),
  )) as { name: string } | null;
  return row?.name ?? null;
}

const selfActor = actorFor({ sub: SELF_ID, role: 'TELECALLER' });

describe.skipIf(!HAS_DB)('UsersService.updateSelf - live DB', () => {
  it('writes the new name to the JWT subject row and returns it', async () => {
    const service = makeService();
    const next = `Self Edit Renamed ${RUN_TAG}`;

    const result = await service.updateSelf(selfActor, { name: next });

    expect(result.id).toBe(SELF_ID);
    expect(result.name).toBe(next);

    const row = await readSelf({ name: true });
    expect(row?.['name']).toBe(next);
  });

  it('writes an audit row in the same transaction with a real before/after pair', async () => {
    const service = makeService();
    const before = await readSelf({ name: true });

    const next = `Self Edit Audited ${RUN_TAG}`;
    await service.updateSelf(selfActor, { name: next });

    const audits = (await adminSeed((db) =>
      db.auditLog.findMany({
        where: { action: 'user.updateSelf', entityId: SELF_ID },
        orderBy: { createdAt: 'desc' },
        take: 1,
      }),
    )) as Array<{
      userId: string | null;
      organizationId: string;
      entityType: string;
      before: unknown;
      after: unknown;
    }>;
    expect(audits).toHaveLength(1);
    const audit = audits[0]!;
    expect(audit.userId).toBe(SELF_ID);
    expect(audit.organizationId).toBe(ORG);
    expect(audit.entityType).toBe('User');
    expect(audit.before).toEqual({ name: before?.['name'] });
    expect(audit.after).toEqual({ name: next });
  });

  it('cannot reach another user: an id in the body is ignored (the route has no id param)', async () => {
    const service = makeService();
    const otherBefore = await readOtherName();

    // Smuggle the victim's id through every field name a naive implementation
    // might read. UpdateProfileDtoSchema strips unknown keys, and the service
    // pins `where` to actor.sub regardless - the row must not move.
    await service.updateSelf(selfActor, {
      name: `Self Edit Smuggle ${RUN_TAG}`,
      ...({ id: OTHER_ID, userId: OTHER_ID, sub: OTHER_ID } as object),
    } as never);

    expect(await readOtherName()).toBe(otherBefore);
    expect(otherBefore).toBe(`Other Person Untouched ${RUN_TAG}`);
  });

  it('a JWT whose subject no longer exists fails loudly (404), not silently', async () => {
    const service = makeService();
    const ghostActor = actorFor({ sub: GHOST_ID, role: 'TELECALLER' });

    const err = await service
      .updateSelf(ghostActor, { name: 'Ghost' })
      .then(() => null)
      .catch((e: unknown) => e);

    expect(err).toBeInstanceOf(NotFoundException);
  });

  it('leaves role and team membership untouched', async () => {
    const service = makeService();
    await service.updateSelf(selfActor, { name: `Self Edit Role Safe ${RUN_TAG}` });

    const row = await readSelf({ role: true, organizationId: true });
    expect(row?.['role']).toBe('TELECALLER');
    expect(row?.['organizationId']).toBe(ORG);

    const membership = (await adminSeed((db) =>
      db.teamMember.findFirst({ where: { userId: SELF_ID } }),
    )) as { teamId: string } | null;
    expect(membership?.teamId).toBe(TEAM_ID);
  });

  it('a non-staff role can edit itself too (every role reaches Settings)', async () => {
    const service = makeService();
    const managerActor = actorFor({ sub: MANAGER_ID, role: 'MANAGER' });

    const result = await service.updateSelf(managerActor, {
      name: `Self Edit Manager ${RUN_TAG}`,
    });

    expect(result.role).toBe('MANAGER');
    expect(result.name).toBe(`Self Edit Manager ${RUN_TAG}`);
  });

  it('the returned email/role come from the DB row, not from the request', async () => {
    const service = makeService();
    const result = await service.updateSelf(selfActor, { name: `Self Edit Echo ${RUN_TAG}` });

    expect(result.email).toBe(`${SELF_ID}@test.local`);
    expect(result.role).toBe('TELECALLER');
    expect(result.id).toBe(SELF_ID);
  });
});
