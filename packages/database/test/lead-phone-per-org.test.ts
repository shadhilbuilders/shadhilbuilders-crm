// T-PHONE-PER-ORG (2026-11-19, owner ruling): a phone is unique per ORGANIZATION.
//
// WHY THIS TEST DRIVES THE DATABASE AND NOT THE SERVICE
//
// The property is a schema property. `leads.service.create` checks for a
// duplicate phone before inserting, and that check can be bypassed - raw SQL in
// webhooks, psql, a future code path that forgets. What has to hold is the
// index: two orgs may both hold the same customer, one org may not hold the
// same customer twice.
//
// It used to be a GLOBAL unique, which broke the product in a way that showed
// up as "the landing page form always fails": the production org had zero leads
// while 27 landing enquiries sat in the sandbox org, because every real number
// already existed somewhere and the insert answered 409 DUPLICATE_VALUE. So the
// cross-org case is not a nicety - it is the bug.
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

// Seeding goes through the OWNER role (BYPASSRLS) - the pooled app role cannot
// insert these parent rows without the RLS GUCs set.
import { createDirectPrismaClient } from '../src/test-db-isolation';

const TAG = `phoneorg${Date.now().toString()}`;
const OWNER = createDirectPrismaClient();

/** One tenant: org + the FK parents a Lead needs. */
function tenant(suffix: string) {
  return {
    org: `${TAG}org${suffix}`,
    user: `${TAG}user${suffix}`,
    team: `${TAG}team${suffix}`,
    project: `${TAG}proj${suffix}`,
  };
}

const A = tenant('a');
const B = tenant('b');

// 2026-11-22: both columns hold the SAME canonical digits, enforced by the
// Lead_phone_equals_phoneE164 CHECK. A fixture that makes them differ is now
// an invalid row, which is the point of the constraint.
const PHONE = `91${`9${Date.now().toString().slice(-9)}`}`;
const E164 = PHONE;

type CreateArgs = { create: (a: unknown) => Promise<unknown> };
const db = OWNER as unknown as Record<
  string,
  CreateArgs & { deleteMany: (a: unknown) => Promise<unknown> }
>;

beforeAll(async () => {
  for (const t of [A, B]) {
    await db['organization']!.create({
      data: { id: t.org, name: `phoneorg ${t.org}`, slug: t.org },
    });
    await db['user']!.create({
      data: {
        id: t.user,
        email: `${t.user}@x.local`,
        name: 'Phone Org Check',
        role: 'TELECALLER',
        organizationId: t.org,
        mustChangePassword: false,
      },
    });
    await db['team']!.create({ data: { id: t.team, name: 'phoneorg', organizationId: t.org } });
    await db['project']!.create({
      data: {
        id: t.project,
        name: 'phoneorg',
        slug: t.project,
        address: 'x',
        organizationId: t.org,
      },
    });
  }
});

afterAll(async () => {
  for (const t of [A, B]) {
    await db['lead']!.deleteMany({ where: { organizationId: t.org } });
    await db['project']!.deleteMany({ where: { id: t.project } });
    await db['team']!.deleteMany({ where: { id: t.team } });
    await db['user']!.deleteMany({ where: { id: t.user } });
    await db['organization']!.deleteMany({ where: { id: t.org } });
  }
  await OWNER.$disconnect();
});

function leadRow(t: ReturnType<typeof tenant>, overrides: Record<string, unknown>) {
  return {
    data: {
      name: 'Phone Org Lead',
      ownerId: t.user,
      ownerType: 'TELECALLER',
      teamId: t.team,
      projectId: t.project,
      organizationId: t.org,
      ...overrides,
    },
  };
}

/**
 * The constraint the database raised, by name, or 'accepted'.
 *
 * Prisma 7 reports a unique violation as P2002 and names the culprit in the
 * message ("Unique constraint failed on the constraint: `Lead_..._key`"), but
 * leaves meta.target empty for a composite index. The name is what we want to
 * assert on anyway: it pins WHICH rule fired, not just that one did.
 */
async function insert(t: ReturnType<typeof tenant>, overrides: Record<string, unknown>) {
  try {
    await db['lead']!.create(leadRow(t, overrides));
    return 'accepted';
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    const m = /on the constraint: `([^`]+)`/.exec(msg);
    if ((err as { code?: string }).code === 'P2002' && m !== null) return `constraint:${m[1]}`;
    return `other: ${msg.slice(0, 120)}`;
  }
}

describe('Lead phone uniqueness is per organization', () => {
  it('ACCEPTS the same phone in a different organization', async () => {
    // The whole point: the same buyer enquiring with builder A and builder B.
    expect(await insert(A, { phone: PHONE, phoneE164: E164 })).toBe('accepted');
    expect(await insert(B, { phone: PHONE, phoneE164: E164 })).toBe('accepted');
  });

  it('rejects a second lead with the same phone in ONE organization', async () => {
    // Phone and phoneE164 now hold the same canonical digits, so this is the
    // phoneE164 index firing rather than a separate `phone` index.
    expect(await insert(A, { phone: PHONE, phoneE164: E164 })).toBe(
      'constraint:Lead_organizationId_phoneE164_projectId_key',
    );
  });

  it('REJECTS the same phoneE164 twice in ONE organization', async () => {
    expect(await insert(A, { phone: E164, phoneE164: E164 })).toBe(
      'constraint:Lead_organizationId_phoneE164_projectId_key',
    );
  });

  it('REFUSES a lead with no phoneE164 at all', async () => {
    // 2026-11-22: the identity column is NOT NULL. A nullable identity key is
    // a constraint that looks like it protects you and does not, because
    // Postgres treats NULLs as distinct.
    const result = await insert(A, { phone: `${PHONE}9`, phoneE164: null });
    expect(result.startsWith('other:')).toBe(true);
  });

  it('REFUSES phone and phoneE164 that disagree', async () => {
    const result = await insert(A, { phone: '9876500099', phoneE164: '919876500099' });
    expect(result.startsWith('other:')).toBe(true);
  });
});
