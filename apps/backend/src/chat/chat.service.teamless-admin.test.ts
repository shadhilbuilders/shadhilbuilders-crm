// T-CHAT-ADMIN-INSERT (2026-09-09): a teamless ADMIN/OWNER must be able to
// send a chat message to a lead.
//
// Real-DB tests (no mocks). Regression guard for the runtime error
//   PrismaClientKnownRequestError 42501
//   "new row violates row-level security policy for table Message"
// at chat.service.ts:165 (message.create).
//
// Root cause: the only INSERT policy (`message_insert_team`) requires
// `l."teamId" = current_setting('app.user_team_id')` for ADMIN/MANAGER.
// Seeded ADMIN/OWNER users carry `teamId: null` on their JWT (seed keeps
// it null by design), so withRlsContext sets app.user_team_id to '' and
// no lead matches → the insert is rejected. Fixed by the
// `message_insert_admin` policy (role-only, no team equality) - mirrors
// `lead_insert_admin` (2026-09-08).
//
// We seed our own team + lead so we don't depend on the seed DB, and
// assert a teamless ADMIN can send a message (the message insert no
// longer throws 42501).

import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import type { JwtPayload } from '@shadhil/auth';
import {
  prisma as runtimePrisma,
  type PrismaClient,
  withRlsContext,
} from '@shadhil/database';

import { ChatService } from './chat.service';

const HAS_DB = Boolean(process.env.DATABASE_URL);
const prisma: PrismaClient | null = HAS_DB ? runtimePrisma : null;

// Per-test unique IDs so re-runs don't collide on FK / unique constraints.
const RUN_TAG = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
const TEAM_ID = `test-chat-admin-team-${RUN_TAG}`;
// Teamless ADMIN actor (no teamId on the JWT, like the seed).
const ADMIN_ID = `test-chat-admin-${RUN_TAG}`;
const LEAD_ID = `test-chat-admin-lead-${RUN_TAG}`;

async function seedAdmin<T>(fn: (db: PrismaClient) => Promise<T>): Promise<T> {
  if (prisma === null) throw new Error('prisma missing');
  // Seeding writes as a test ADMIN who IS a member of the test team so RLS
  // allows the fixture inserts. This is distinct from the actor UNDER TEST
  // (the teamless admin), whose JWT carries teamId=null.
  return withRlsContext(
    prisma,
    { userId: ADMIN_ID, role: 'ADMIN', teamId: TEAM_ID, organizationId: 'org_bootstrap' },
    async (tx) => fn(tx as unknown as PrismaClient),
  );
}

function teamlessActor(): JwtPayload {
  return {
    sub: ADMIN_ID,
    email: `${ADMIN_ID}@test.local`,
    role: 'ADMIN',
    teamId: null, // <-- the bug: seeded ADMIN/OWNER have no teamId
    organizationId: 'org_bootstrap',
    iat: 0,
    exp: 0,
    iss: 'shadhil-crm',
  };
}

// Stub the OutboundService - the IN_APP path never calls it, and we only
// test IN_APP here (the WhatsApp path is covered by chat.service.send.test.ts).
const outboundStub = {
  enqueue: async () => ({ id: 'mock-out' }),
};

function makeService(): ChatService {
  if (prisma === null) throw new Error('prisma missing');
  const prismaService = { $client: prisma } as never;
  return new ChatService(prismaService, outboundStub as never);
}

beforeAll(async () => {
  if (prisma === null) return;
  await seedAdmin(async (db) => {
    await db.team.upsert({
      where: { id: TEAM_ID },
      update: {},
      create: { id: TEAM_ID, name: `Chat Admin Test Team ${RUN_TAG}`, organizationId: 'org_bootstrap' },
    });
    await db.user.upsert({
      where: { id: ADMIN_ID },
      update: {},
      create: {
        id: ADMIN_ID,
        email: `${ADMIN_ID}@test.local`,
        name: 'Chat Admin',
        role: 'ADMIN',
        mustChangePassword: false,
        organizationId: 'org_bootstrap',
      },
    });
    const uniquePhone = `9199${RUN_TAG.replace(/\D/g, '').slice(-8)}`;
    await db.lead.upsert({
      where: { id: LEAD_ID },
      update: { phoneE164: uniquePhone },
      create: {
        id: LEAD_ID,
        name: `Chat Admin Lead ${RUN_TAG}`,
        phone: uniquePhone,
        phoneE164: uniquePhone,
        source: 'REFERRAL',
        state: 'NEW',
        teamId: TEAM_ID,
        ownerId: ADMIN_ID,
        ownerType: 'ADMIN',
        organizationId: 'org_bootstrap',
      },
    });
  });
}, 30_000);

afterAll(async () => {
  if (prisma === null) return;
  await seedAdmin(async (db) => {
    await db.message.deleteMany({ where: { leadId: LEAD_ID } });
    await db.auditLog.deleteMany({ where: { userId: ADMIN_ID } });
    await db.lead.deleteMany({ where: { id: LEAD_ID } });
    await db.user.deleteMany({ where: { id: ADMIN_ID } });
    await db.team.deleteMany({ where: { id: TEAM_ID } });
  });
}, 30_000);

describe.skipIf(!HAS_DB)('ChatService.send - teamless ADMIN (T-CHAT-ADMIN-INSERT)', () => {
  it('ADMIN with no teamId sends a message to a lead (no 42501)', async () => {
    const service = makeService();
    const result = await service.send(teamlessActor(), {
      leadId: LEAD_ID,
      body: 'Hello from a teamless admin',
      channel: 'IN_APP',
    });

    expect(result.id).toBeTruthy();
    expect(result.leadId).toBe(LEAD_ID);
    expect(result.direction).toBe('OUT');
    expect(result.channel).toBe('IN_APP');
    expect(result.body).toBe('Hello from a teamless admin');

    // The message row actually persisted (RLS allowed the insert).
    const row = await seedAdmin((db) =>
      db.message.findUnique({ where: { id: result.id }, select: { id: true, body: true } }),
    );
    expect(row?.id).toBe(result.id);
    expect(row?.body).toBe('Hello from a teamless admin');
  });
});
