// T-TOKEN-GATE (2026-09-29): the token invariant as a DATABASE rule.
//
// WHY THIS TEST EXISTS SEPARATELY FROM THE SERVICE TESTS
//
// The service and the Zod DTO both enforce "a token is a part payment, so it
// cannot exceed the total" - but every one of those guards is BYPASSABLE by a raw
// write. In this codebase that is not hypothetical:
//
//   * `webhooks.controller.ts` and maintenance scripts use $executeRawUnsafe;
//   * psql can write directly (which is how the two bad production figures got
//     there);
//   * a future service method can simply forget the check.
//
// A CHECK constraint holds for every one of those, including paths not written
// yet. This test drives the REAL table with raw SQL - deliberately not through
// the service - because going through the service would prove the service works
// and say nothing about the constraint.
//
// The constraint is NOT VALID by design: it applies to new rows immediately
// without scanning existing ones, so historical dummy rows do not block the
// migration. That is exactly the property under test - existing rows tolerated,
// new rows constrained.
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { prisma } from '../src/index';
// Seeding goes through the OWNER role (BYPASSRLS), the sanctioned test-only
// helper - the pooled app role cannot insert these parent rows without the RLS
// GUCs set. See references/rls-policy-authoring.md.
import { createDirectPrismaClient } from '../src/test-db-isolation';
import { withRlsContext } from '../src/rls';

const ORG = 'ceid01lpfe1esm8jwsxid41k28';
const TAG = `tokchk${Date.now().toString()}`;
const OWNER = createDirectPrismaClient();

// Fixture ids, created in beforeAll and removed in afterAll. The test DB is a
// bare schema with no seed data, so the parents must be made here.
const USER = `${TAG}user`;
const TEAM = `${TAG}team`;
const UNIT = `${TAG}unit`;
const LEAD = `${TAG}lead`;
const PROJECT = `${TAG}proj`;

beforeAll(async () => {
  const db = OWNER as unknown as Record<string, { create: (a: unknown) => Promise<unknown>; findFirst: (a: unknown) => Promise<unknown> }>;
  await db['project']!.create({
    data: { id: PROJECT, name: 'tokchk', slug: PROJECT, address: 'x', organizationId: ORG },
  });
  await db['user']!.create({
    data: {
      id: USER, email: `${USER}@x.local`, name: 'Token Check', role: 'TELECALLER',
      organizationId: ORG, mustChangePassword: false,
    },
  });
  await db['team']!.create({ data: { id: TEAM, name: 'tokchk', organizationId: ORG } });
  // A Unit needs a Phase (phaseId is NOT NULL); Phase needs the project.
  const phaseId = `${TAG}phase`;
  await db['phase']!.create({
    data: { id: phaseId, name: 'tokchk', projectId: PROJECT, organizationId: ORG },
  });
  await db['unit']!.create({
    data: { id: UNIT, phaseId, unitNumber: 'TC-1', bhk: 2, buildupSqft: 100, pricePerSqft: 1000, price: 100000, status: 'AVAILABLE', organizationId: ORG },
  });
  await db['lead']!.create({
    data: {
      id: LEAD, name: 'Token Check Lead', phone: '+910000000099', state: 'NEGOTIATION',
      ownerId: USER, ownerType: 'TELECALLER', teamId: TEAM, projectId: PROJECT, organizationId: ORG,
    },
  });
});

afterAll(async () => {
  const db = OWNER as unknown as Record<string, { deleteMany: (a: unknown) => Promise<unknown> }>;
  await db['booking']!.deleteMany({ where: { leadId: LEAD } });
  await db['lead']!.deleteMany({ where: { id: LEAD } });
  await db['unit']!.deleteMany({ where: { id: UNIT } });
  await db['phase']!.deleteMany({ where: { id: `${TAG}phase` } });
  await db['team']!.deleteMany({ where: { id: TEAM } });
  await db['user']!.deleteMany({ where: { id: USER } });
  await db['project']!.deleteMany({ where: { id: PROJECT } });
});

/**
 * Insert a Booking with raw SQL, bypassing every service guard.
 * Returns 'accepted' or the constraint the database raised.
 */
async function rawInsert(amount: number, token: string): Promise<string> {
  // Real FKs so no earlier constraint masks the money rule.
  const id = `${TAG}-${Math.random().toString(36).slice(2, 8)}`;
  try {
    // Via the OWNER connection: this test is about the CHECK constraint, and the
    // pooled app role would reject the insert on RLS first, masking the answer.
    // `token === 'NULL'` must be a real SQL NULL, not the 4-character string -
    // binding it as a parameter would insert text and trip a type error rather
    // than testing the "no token recorded yet" case.
    const tokenExpr = token === 'NULL' ? 'NULL' : '$7';
    const params: unknown[] = [id, LEAD, UNIT, ORG, USER, amount.toFixed(2)];
    if (token !== 'NULL') params.push(token);
    await (OWNER as unknown as { $executeRawUnsafe: (q: string, ...a: unknown[]) => Promise<unknown> }).$executeRawUnsafe(
      `INSERT INTO "Booking" (id,"leadId","unitId","organizationId","userId",status,amount,"listAmount","tokenAmount","updatedAt")
       VALUES ($1,$2,$3,$4,$5,'HOLD',$6,$6,${tokenExpr},now())`,
      ...params,
    );
    await (OWNER as unknown as { $executeRawUnsafe: (q: string, ...a: unknown[]) => Promise<unknown> }).$executeRawUnsafe(
      `DELETE FROM "Booking" WHERE id = $1`,
      id,
    );
    return 'accepted';
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    const m = /check constraint "([^"]+)"/.exec(msg);
    return m === null ? `other: ${msg.slice(0, 80)}` : `constraint:${m[1]}`;
  }
}

describe('Booking token CHECK constraint (booking_token_within_total)', () => {
  it('REJECTS a token larger than the total - on a RAW write', async () => {
    // The exact shape that reached production: B-103, token 16,525,612 against a
    // 6,050,000 total. The service would refuse this now; the point here is that
    // the DATABASE refuses it too, so no path can reintroduce it.
    expect(await rawInsert(6050000, '16525612.00')).toBe(
      'constraint:booking_token_within_total',
    );
  });

  it('REJECTS a zero token (not a payment)', async () => {
    expect(await rawInsert(1000, '0.00')).toBe('constraint:booking_token_within_total');
  });

  it('REJECTS a negative token (nonsense)', async () => {
    expect(await rawInsert(1000, '-5.00')).toBe('constraint:booking_token_within_total');
  });

  it('ACCEPTS a part payment', async () => {
    expect(await rawInsert(1000, '400.00')).toBe('accepted');
  });

  it('ACCEPTS a full payment (equal to the total)', async () => {
    // The rule is "not greater", not "less": paying in full is still a payment.
    expect(await rawInsert(1000, '1000.00')).toBe('accepted');
  });

  it('ACCEPTS NULL (no token recorded yet)', async () => {
    // A booking legitimately exists before any token is taken. The constraint
    // must not require a value - presence is a TRANSITION rule the service owns
    // (a token may be recorded at HOLD time), and a CHECK cannot see which
    // transition produced the row.
    expect(await rawInsert(1000, 'NULL')).toBe('accepted');
  });
});
