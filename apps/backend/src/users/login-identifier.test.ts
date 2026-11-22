// Public login resolver - live-DB suite (2026-11-21).
//
// WHY A REAL DB: the resolver's correctness is mostly about WHICH ROWS it picks
// (a shared phone, soft-deleted accounts, the credential issuer shape) and about
// the SECURITY DEFINER helper answering for a caller with no RLS context. A
// mocked client would report all of that as working.
//
// Uses the seeded organisation: `Organization` is FORCE ROW LEVEL SECURITY, so a
// bare `organization.create` fails on the RETURNING half without a GUC, and
// creating throwaway orgs per run would be noise. `User` and `Account` are
// pre-RLS, which is exactly why the resolver can use the bare client.
//
// Skips cleanly without DATABASE_URL, like the other RLS suites.
import { afterAll, describe, expect, it } from 'vitest';
import { createId } from '@paralleldrive/cuid2';
import { prisma as runtimePrisma, withRlsContext, type PrismaClient } from '@shadhil/database';

import { hashPassword, verifyPassword, verifyPasswordAsync } from './credentials';
import { UsersService } from './users.service';
import { PrismaService } from '../prisma/prisma.module';
import type { JwtPayload } from '@shadhil/auth';

const HAS_DB = Boolean(process.env.DATABASE_URL);
const REQUIRED = process.env.RLS_MATRIX_REQUIRED === 'true';
const SKIP = !HAS_DB && !REQUIRED;
const prisma: PrismaClient | null = HAS_DB ? runtimePrisma : null;

/** The seeded organisation every other live-DB suite uses. */
const ORG = 'ceid01lpfe1esm8jwsxid41k28';

const PASSWORD = 'password123';
const WRONG = 'password456';

/** A unique valid Indian mobile per call, so runs never collide. */
let phoneCounter = 0;
function uniquePhone(): string {
  // 91 + ten digits starting 9, i.e. a real Indian mobile. The leading 9 matters:
  // `normalizePhoneDigits` only prepends 91 to a bare 10-digit number that looks
  // like an Indian mobile, so a number starting 2 would not survive the
  // "person typed it without the country code" case the test covers.
  if (phoneCounter === 0) phoneCounter = 100_000_000 + (Date.now() % 800_000_000);
  phoneCounter += 1;
  return `919${String(phoneCounter).padStart(9, '0').slice(-9)}`;
}

function makeService(): UsersService {
  return new UsersService({ $client: prisma } as unknown as PrismaService);
}

const createdUserIds: string[] = [];
const createdOrgIds: string[] = [];

/**
 * Create a throwaway organisation and return its id.
 *
 * `Organization` is FORCE ROW LEVEL SECURITY. The INSERT policy is open, but
 * Prisma's create also RETURNINGs the row, and that half is judged by the SELECT
 * policy, which needs `app.user_org_id` to equal the row's id. Setting the RLS
 * context to the NEW org's id satisfies both halves in one statement.
 */
async function createOrgThroughRls(tag: string): Promise<string> {
  if (prisma === null) throw new Error('prisma missing');
  const id = createId();
  await withRlsContext(
    prisma,
    { userId: createId(), role: 'OWNER', organizationId: id },
    async (tx) => {
      await (tx as unknown as PrismaClient).organization.create({
        data: { id, name: `Login Test ${tag}`, slug: `${tag}-${id.slice(0, 8)}` },
      });
    },
  );
  createdOrgIds.push(id);
  return id;
}

/** A user in the seeded org with a working credential account. */
async function createLoginUser(input: {
  email: string;
  name: string;
  phone: string | null;
  password?: string;
  deletedAt?: Date | null;
  organizationId?: string;
}): Promise<string> {
  if (prisma === null) throw new Error('prisma missing');
  const id = createId();
  await prisma.user.create({
    data: {
      id,
      email: input.email,
      name: input.name,
      role: 'TELECALLER',
      organizationId: input.organizationId ?? ORG,
      phone: input.phone,
      deletedAt: input.deletedAt ?? null,
    },
  });
  await prisma.account.create({
    data: {
      accountId: id,
      providerId: 'credential',
      issuer: 'local:credential',
      userId: id,
      password: hashPassword(input.password ?? PASSWORD),
    },
  });
  createdUserIds.push(id);
  return id;
}

describe.skipIf(SKIP)('UsersService.resolveLoginIdentifier', () => {
  afterAll(async () => {
    if (prisma === null) return;
    if (createdUserIds.length > 0) {
      await prisma.account.deleteMany({ where: { userId: { in: createdUserIds } } });
      await prisma.user.deleteMany({ where: { id: { in: createdUserIds } } });
    }
    // Deleting an organisation needs the CRON_SERVICE policy
    // (`org_cron_service_all`), the only FOR ALL policy on that table.
    for (const orgId of createdOrgIds) {
      await withRlsContext(
        prisma,
        { userId: createId(), role: 'CRON_SERVICE', organizationId: orgId },
        async (tx) => {
          await (tx as unknown as PrismaClient).organization.delete({ where: { id: orgId } });
        },
      );
    }
  });

  it('resolves an email with the right password, and refuses a wrong one', async () => {
    const service = makeService();
    const email = `byemail-${createId()}@test.local`;
    await createLoginUser({ email, name: 'By Email', phone: null });

    await expect(
      service.resolveLoginIdentifier({ identifier: email, password: PASSWORD }),
    ).resolves.toEqual({ kind: 'ok', email });
    await expect(
      service.resolveLoginIdentifier({ identifier: email, password: WRONG }),
    ).resolves.toEqual({ kind: 'invalid' });
  });

  it('resolves a phone in every shape a person types it', async () => {
    const service = makeService();
    const phone = uniquePhone();
    const email = `byphone-${createId()}@test.local`;
    await createLoginUser({ email, name: 'By Phone', phone });

    const tenDigits = phone.slice(2);
    const spaced = `+91 ${tenDigits.slice(0, 5)} ${tenDigits.slice(5)}`;
    for (const identifier of [phone, tenDigits, spaced]) {
      await expect(
        service.resolveLoginIdentifier({ identifier, password: PASSWORD }),
      ).resolves.toEqual({ kind: 'ok', email });
    }
  });

  it('answers invalid - not an error - for an unknown number or a junk identifier', async () => {
    const service = makeService();
    await expect(
      service.resolveLoginIdentifier({ identifier: '9000000000', password: PASSWORD }),
    ).resolves.toEqual({ kind: 'invalid' });
    await expect(
      service.resolveLoginIdentifier({ identifier: 'not a number', password: PASSWORD }),
    ).resolves.toEqual({ kind: 'invalid' });
  });

  it('offers the picker when one number and one password match two accounts', async () => {
    const service = makeService();
    const phone = uniquePhone();
    const emailA = `shared-a-${createId()}@test.local`;
    const emailB = `shared-b-${createId()}@test.local`;
    const userA = await createLoginUser({ email: emailA, name: 'Shared A', phone });
    // A second ORG on purpose: `User` has a partial unique index on
    // (phone, organizationId), so two accounts can only share a number across
    // organisations - which is exactly the case the picker exists for.
    const otherOrgId = await createOrgThroughRls('login-pick');
    await createLoginUser({
      email: emailB,
      name: 'Shared B',
      phone,
      organizationId: otherOrgId,
    });

    const first = await service.resolveLoginIdentifier({ identifier: phone, password: PASSWORD });
    expect(first.kind).toBe('pick');
    if (first.kind !== 'pick') throw new Error('expected pick');
    expect(first.accounts).toHaveLength(2);
    // The picker must never carry an address or a number.
    const serialised = JSON.stringify(first);
    expect(serialised).not.toContain(emailA);
    expect(serialised).not.toContain(emailB);
    expect(serialised).not.toContain(phone);
    expect(new Set(first.accounts.map((a) => a.organizationSlug)).size).toBe(2);

    // Choosing one narrows the answer to that account.
    const second = await service.resolveLoginIdentifier({
      identifier: phone,
      password: PASSWORD,
      accountUserId: userA,
    });
    expect(second).toEqual({ kind: 'ok', email: emailA });
  });

  it('ignores a stale picker handle when only one account matched', async () => {
    const service = makeService();
    const phone = uniquePhone();
    const email = `own-${createId()}@test.local`;
    await createLoginUser({ email, name: 'Own', phone });
    const stranger = await createLoginUser({
      email: `stranger-${createId()}@test.local`,
      name: 'Stranger',
      phone: null,
    });

    // One match means there is nothing to choose, so the handle is ignored
    // rather than turned into a refusal: a picker left open in a tab must not
    // be able to block a correct login. The handle only matters when it is
    // needed to disambiguate, which the next case covers.
    await expect(
      service.resolveLoginIdentifier({
        identifier: phone,
        password: PASSWORD,
        accountUserId: stranger,
      }),
    ).resolves.toEqual({ kind: 'ok', email });
  });

  it('refuses a picker handle that is not one of two matched accounts', async () => {
    const service = makeService();
    const phone = uniquePhone();
    const stranger = await createLoginUser({
      email: `stranger2-${createId()}@test.local`,
      name: 'Stranger Two',
      phone: null,
    });
    const otherOrgId = await createOrgThroughRls('login-reject');
    await createLoginUser({ email: `first-${createId()}@test.local`, name: 'First', phone });
    await createLoginUser({
      email: `second-${createId()}@test.local`,
      name: 'Second',
      phone,
      organizationId: otherOrgId,
    });

    await expect(
      service.resolveLoginIdentifier({
        identifier: phone,
        password: PASSWORD,
        accountUserId: stranger,
      }),
    ).resolves.toEqual({ kind: 'invalid' });
  });

  it('gives no picker when the two accounts have different passwords', async () => {
    const service = makeService();
    const phone = uniquePhone();
    const emailA = `diff-a-${createId()}@test.local`;
    await createLoginUser({ email: emailA, name: 'Diff A', phone });
    const otherOrgId = await createOrgThroughRls('login-diff');
    await createLoginUser({
      email: `diff-b-${createId()}@test.local`,
      name: 'Diff B',
      phone,
      password: WRONG,
      organizationId: otherOrgId,
    });

    await expect(
      service.resolveLoginIdentifier({ identifier: phone, password: PASSWORD }),
    ).resolves.toEqual({ kind: 'ok', email: emailA });
  });

  it('ignores a soft-deleted account holding the same number', async () => {
    const service = makeService();
    const phone = uniquePhone();
    const email = `live-${createId()}@test.local`;
    await createLoginUser({
      email: `gone-${createId()}@test.local`,
      name: 'Gone',
      phone,
      deletedAt: new Date(),
    });
    await createLoginUser({ email, name: 'Live', phone });

    await expect(
      service.resolveLoginIdentifier({ identifier: phone, password: PASSWORD }),
    ).resolves.toEqual({ kind: 'ok', email });
  });
});

describe.skipIf(SKIP)('UsersService.updateSelf - the narrow email change', () => {
  /** A JWT payload for the seeded org, as the controller would build it. */
  function actorFor(userId: string, email: string): JwtPayload {
    return {
      sub: userId,
      email,
      role: 'TELECALLER',
      organizationId: ORG,
      iat: 0,
      exp: 0,
      iss: 'shadhil-crm',
    };
  }

  /** A user whose stored address is a generated placeholder. */
  async function createPlaceholderUser(phone: string | null): Promise<{ id: string }> {
    const id = createId();
    await createLoginUser({ email: `noemail+${id.slice(0, 16)}@users.invalid`, name: 'Ph', phone });
    return { id };
  }

  it('replaces a placeholder with a real address, using the current password', async () => {
    const service = makeService();
    const phone = uniquePhone();
    const id = await createLoginUser({
      email: `noemail+${createId().slice(0, 16)}@users.invalid`,
      name: 'Placeholder Owner',
      phone,
    });
    const actor = actorFor(id, 'placeholder@users.invalid');
    const next = `real-${createId()}@test.local`;

    const updated = await service.updateSelf(actor, {
      email: next,
      currentPassword: PASSWORD,
    });
    expect(updated.email).toBe(next);

    const stored = await prisma!.user.findUnique({
      where: { id },
      select: { email: true, emailVerified: true },
    });
    expect(stored?.email).toBe(next);
    // Nothing has proven the address yet.
    expect(stored?.emailVerified).toBe(false);
  });

  it('refuses a real-to-real change and points at an administrator', async () => {
    const service = makeService();
    const email = `already-real-${createId()}@test.local`;
    const id = await createLoginUser({ email, name: 'Real', phone: uniquePhone() });

    await expect(
      service.updateSelf(actorFor(id, email), {
        email: `other-${createId()}@test.local`,
        currentPassword: PASSWORD,
      }),
    ).rejects.toThrow(/already set/);
  });

  it('refuses the change when the current password is wrong', async () => {
    const service = makeService();
    const id = await createLoginUser({
      email: `noemail+${createId().slice(0, 16)}@users.invalid`,
      name: 'Placeholder Two',
      phone: uniquePhone(),
    });

    await expect(
      service.updateSelf(actorFor(id, 'p2@users.invalid'), {
        email: `wont-land-${createId()}@test.local`,
        currentPassword: WRONG,
      }),
    ).rejects.toThrow(/password is not correct/i);
  });

  it('refuses to clear the phone while the address is still a placeholder', async () => {
    const service = makeService();
    const id = await createLoginUser({
      email: `noemail+${createId().slice(0, 16)}@users.invalid`,
      name: 'Placeholder Three',
      phone: uniquePhone(),
    });

    // Losing both identifiers would lock the account out, and the synthetic
    // address is never shown to its owner.
    await expect(
      service.updateSelf(actorFor(id, 'p3@users.invalid'), { phone: null }),
    ).rejects.toThrow(/Add an email address/);
  });

  it('allows clearing the phone once a real address exists', async () => {
    const service = makeService();
    const email = `real-clear-${createId()}@test.local`;
    const id = await createLoginUser({ email, name: 'Real Clear', phone: uniquePhone() });

    const updated = await service.updateSelf(actorFor(id, email), { phone: null });
    expect(updated.phone).toBeNull();
  });
});

describe.skipIf(SKIP)('credentials - the two verifiers agree', () => {
  it('accepts the same stored hash synchronously and asynchronously', async () => {
    const stored = hashPassword('correct horse battery staple');
    expect(verifyPassword('correct horse battery staple', stored)).toBe(true);
    expect(await verifyPasswordAsync('correct horse battery staple', stored)).toBe(true);
    expect(verifyPassword('wrong', stored)).toBe(false);
    expect(await verifyPasswordAsync('wrong', stored)).toBe(false);
  });

  it('returns false rather than throwing on a malformed stored value', async () => {
    for (const stored of ['', 'nocolon', ':', 'abc:', ':abc']) {
      expect(verifyPassword('whatever', stored)).toBe(false);
      expect(await verifyPasswordAsync('whatever', stored)).toBe(false);
    }
  });
});
