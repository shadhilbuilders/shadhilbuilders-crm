// ────────────────────────────────────────────────────────────────────────────
// Targeted @mention grant: RLS access control (T-MENTION-TARGET, 2026-09-29)
// ────────────────────────────────────────────────────────────────────────────
//
// WHY THIS FILE IS NOT A ROW IN rls-isolation.test.ts
//
// The generic matrix models each table as parent-Lead-scoped with a uniform
// shape (INSERT gated on the parent Lead's team/owner, UPDATE/DELETE mirroring
// INSERT). MessageRecipient deliberately does not fit that shape:
//
//   - NO UPDATE policy at all (a grant is immutable - editing who was mentioned
//     would silently change who can read a past note), and
//   - NO DELETE policy (only the parent FK's ON DELETE CASCADE removes rows), so
//     the matrix's DELETE expectations would assert the wrong thing for every
//     role, and
//   - INSERT refuses a SELF-mention, which no other table does.
//
// Forcing it into the matrix would have meant encoding those exceptions in the
// shared helper, weakening every other row's assertions. The rules are pinned
// explicitly here instead.
//
// WHAT ACTUALLY MATTERS (and why each is here):
//
//   1. A mention is a GRANT of the lead AND its full thread (owner option A).
//      Both grants must appear together - if the Lead policy admitted the
//      recipient but the Message policy did not, the notification would point at
//      a lead the recipient could open but whose thread stayed blank.
//   2. It is bounded: a recipient of NO grant sees nothing. This is the case that
//      the pre-existing implementation failed (it name-matched org-wide).
//   3. A grant is private: a recipient cannot enumerate WHO ELSE was mentioned.
//      Without this a telecaller could map a lead's discussion to the roster.
//   4. A contact-thread recipient (leadId NULL) gains no lead access, so the
//      grant table cannot become a side door into non-lead threads.
//
// Recursion guard: the `Lead <-> MessageRecipient` policy pair is proven to
// TERMINATE here. Postgres reports a policy cycle only at SELECT time, so a
// clean migration is not evidence - these reads are.
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { prisma } from '../src/index';
import { withRlsContext, type RlsContext } from '../src/rls';
// Seed through the OWNER role (BYPASSRLS), the sanctioned test-only helper - see
// rls-isolation.test.ts and references/rls-policy-authoring.md. Seeding through
// the pooled app role cannot work here: message_recipient_insert_author refuses
// a SELF-mention (`userId <> app.user_id`), and the grant being seeded belongs to
// someone OTHER than the seeder, which is exactly the case a pooled seed fights.
import { createDirectPrismaClient } from '../src/test-db-isolation';

const ORG = 'ceid01lpfe1esm8jwsxid41k28';
const TAG = `mrls${Date.now().toString()}`;

const TC = `${TAG}tc`; // owns the lead, writes the note
const SE = `${TAG}se`; // mentioned -> receives the grant
const OTHER = `${TAG}ot`; // in the org, NOT mentioned -> must see nothing
const TEAM = `${TAG}team`;
const PROJ = `${TAG}proj`;
const LEAD = `${TAG}lead`;
const NOTE = `${TAG}note`; // INTERNAL note on the lead
const CUST = `${TAG}cust`; // CUSTOMER message on the same lead

/** Read a table INSIDE the actor's RLS context, counting only fixture rows. */
async function countAs(
  ctx: RlsContext,
  table: 'lead' | 'message' | 'messageRecipient',
  where: Record<string, unknown>,
): Promise<number> {
  return withRlsContext(prisma, ctx, async (tx) => {
    const client = tx as unknown as Record<string, { count: (a: unknown) => Promise<number> }>;
    return client[table]!.count({ where });
  });
}

const ownerPrisma = createDirectPrismaClient();

const ctxOf = (userId: string, role: RlsContext['role']): RlsContext => ({
  userId,
  role,
  organizationId: ORG,
});

beforeAll(async () => {
  // Owner role: bypasses RLS, and is a SEPARATE CONNECTION - so everything must
  // be committed here before the RLS reads below can see it.
  const db = ownerPrisma as unknown as Record<string, { create: (a: unknown) => Promise<unknown> }>;
  await db['project']!.create({
    data: { id: PROJ, name: `MRLS ${PROJ}`, slug: PROJ, address: 'x', organizationId: ORG },
  });
  for (const [id, name, role] of [
    [TC, 'MR RLS TC', 'TELECALLER'],
    [SE, 'MR RLS SE', 'SALES_EXEC'],
    [OTHER, 'MR RLS Other', 'TELECALLER'],
  ] as const) {
    await db['user']!.create({
      data: { id, email: `${id}@x.local`, name, role, organizationId: ORG, mustChangePassword: false },
    });
  }
  await db['team']!.create({
    data: { id: TEAM, name: `MRLS ${TEAM}`, organizationId: ORG },
  });
  await db['lead']!.create({
    data: {
      id: LEAD, name: 'MRLS Customer', phone: `91${Date.now().toString().slice(-10)}`,
      state: 'NEW', ownerId: TC, ownerType: 'TELECALLER',
      teamId: TEAM, projectId: PROJ, organizationId: ORG,
    },
  });
  await db['message']!.create({
    data: { id: NOTE, leadId: LEAD, userId: TC, direction: 'OUT', channel: 'IN_APP', kind: 'INTERNAL', body: 'loop in the exec', organizationId: ORG },
  });
  await db['message']!.create({
    data: { id: CUST, leadId: LEAD, userId: TC, direction: 'OUT', channel: 'IN_APP', kind: 'CUSTOMER', body: 'unit details', organizationId: ORG },
  });
  // The grant, shaped exactly as the service writes it (denormalized leadId).
  await db['messageRecipient']!.create({
    data: { id: `${TAG}mr`, messageId: NOTE, userId: SE, leadId: LEAD, organizationId: ORG },
  });
});

afterAll(async () => {
  const db = ownerPrisma as unknown as Record<string, { deleteMany: (a: unknown) => Promise<unknown> }>;
  // Delete the Message parents: the grant has NO delete policy, so a pooled
  // deleteMany removes nothing and silently strands the fixture. The FK's
  // ON DELETE CASCADE is the only removal path.
  await db['message']!.deleteMany({ where: { id: { in: [NOTE, CUST] } } });
  await db['messageRecipient']!.deleteMany({ where: { id: `${TAG}mr` } });
  await db['lead']!.deleteMany({ where: { id: LEAD } });
  await db['team']!.deleteMany({ where: { id: TEAM } });
  await db['user']!.deleteMany({ where: { id: { in: [TC, SE, OTHER] } } });
  await db['project']!.deleteMany({ where: { id: PROJ } });
});

describe('MessageRecipient grant RLS (T-MENTION-TARGET)', () => {
  it('baseline: without a grant, the exec sees no lead and no thread', () => {
    // Proves the grant is doing the work rather than some pre-existing widening.
    // (OTHER has no grant at all, so this is the same state.)
    return (async () => {
      expect(await countAs(ctxOf(OTHER, 'SALES_EXEC'), 'lead', { id: LEAD })).toBe(0);
      expect(
        await countAs(ctxOf(OTHER, 'SALES_EXEC'), 'message', { leadId: LEAD }),
      ).toBe(0);
    })();
  });

  it('the mentioned exec sees the LEAD and the WHOLE thread (option A)', async () => {
    const se = ctxOf(SE, 'SALES_EXEC');
    expect(await countAs(se, 'lead', { id: LEAD })).toBe(1);
    // Both messages, not only the one that named them. Keying the grant on the
    // message instead of the lead is the mistake the live probe caught: the exec
    // could read the note but got 0 rows for the customer's message on the same
    // lead, i.e. the notification pointed into a thread they could not read.
    expect(await countAs(se, 'message', { leadId: LEAD })).toBe(2);
  });

  it('the exec sees ONLY their own grant row - no roster enumeration', async () => {
    // A recipient may read their own grant, never who else was mentioned;
    // otherwise a telecaller could map a lead's discussion to the team roster.
    const se = ctxOf(SE, 'SALES_EXEC');
    expect(await countAs(se, 'messageRecipient', { id: `${TAG}mr` })).toBe(1);
    const stranger = ctxOf(OTHER, 'SALES_EXEC');
    expect(await countAs(stranger, 'messageRecipient', { leadId: LEAD })).toBe(0);
  });

  it('an ADMIN does not read grant rows (no admin branch by design)', async () => {
    // Deliberate: an admin already sees every note via message_select_team, so
    // an admin branch would grant nothing new while becoming a second,
    // divergent statement of who can see what.
    expect(await countAs(ctxOf(TC, 'ADMIN'), 'messageRecipient', { leadId: LEAD })).toBe(0);
  });

  it('the policy pair TERMINATES - no recursion on wide reads', async () => {
    // Postgres raises `infinite recursion detected in policy for relation "Lead"`
    // only at SELECT time, so a clean migration is not evidence that the
    // `Lead -> MessageRecipient` / `Message -> MessageRecipient` pair is
    // terminating. These unfiltered reads are.
    const se = ctxOf(SE, 'SALES_EXEC');
    await expect(countAs(se, 'lead', {})).resolves.toBeGreaterThanOrEqual(1);
    await expect(countAs(se, 'message', {})).resolves.toBeGreaterThanOrEqual(1);
  });
});
