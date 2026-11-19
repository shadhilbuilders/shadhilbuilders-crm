// Webhooks controller test - T-E2b (2026-09-04).
//
// Verifies the WhatsApp inbound handler against the real Meta
// envelope shape:
//   • known-lead inbound text → Message row created
//   • unknown-number inbound text → WhatsappUnknownContact upserted
//   • status update (delivered/read/failed) → matching OutboundMessage
//     row's status field updated
//   • dedup: same Meta externalId twice → second call short-circuits
//   • GET verify-handshake unchanged
//
// Tests use a real Prisma client + real Postgres (the same shape as
// chat.service.send.test.ts). This is slower than mock-based
// testing but proves the RLS + migration actually work - a mock
// would let us skip the schema and the policies.
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { prisma as runtimePrisma, type PrismaClient, withRlsContext } from '@shadhil/database';

import { WebhooksController } from './webhooks.controller';

// DB-backed test (real Postgres via pgbouncer). Skip cleanly when
// DATABASE_URL isn't loaded (e.g. bare `pnpm vitest run` without env),
// matching chat.service.send.test.ts's HAS_DB guard. Without this, the
// module-level beforeAll connects to the DB and fails loudly with
// "client password must be a string" instead of skipping.
const HAS_DB = Boolean(process.env.DATABASE_URL);
// T-LEAD-PROJECT-REQUIRED (2026-09-16): Lead.projectId is NOT NULL now, so
// every fixture lead needs a project. cuid2-shaped in case it passes a DTO.
const TEST_PROJECT_ID = 'webhookscopr' + Date.now().toString();

// ── Test fixtures ──────────────────────────────────────────────────
const TEST_USER_ID = 'test-wa-handler-user';
const TEST_TEAM_ID = 'test-wa-handler-team';

const uniquePhone = () => `9${Date.now().toString().padStart(11, '0')}`.slice(0, 12);

let knownLeadId: string;
let knownPhone: string;
let unknownPhone: string;
let outboundMessageId: string;

// ── T-WA-MULTITENANT (2026-11-19): fixtures in a SECOND organization ──
// These prove the webhook resolves the owning org instead of assuming
// PUBLIC_ORG_ID. They use the seeded `test` tenant and skip themselves when that
// tenant is absent, so the suite still runs on a single-org database.
const OTHER_ORG_ID = 'test-wa-handler-org2';
const OTHER_USER_ID = 'test-wa-handler-other-user';
const OTHER_TEAM_ID = 'test-wa-handler-other-team';
const OTHER_PROJECT_ID = 'webhookscop2' + Date.now().toString();

let otherLeadId = '';
let otherPhone = '';
let otherOutboundId = '';

beforeAll(async () => {
  if (!HAS_DB) return;
  // Seed a manager user + a team that owns the known lead. The
  // WhatsappUnknownContact / WebhookEvent / OutboundMessage rows
  // we create here are owned by CRON_SERVICE (no real actor), so
  // the user+team is only needed for the known Lead. Membership is a
  // TeamMember row now (User.teamId was dropped in the cutover).
  const adminClient = runtimePrisma as unknown as PrismaClient;
  await withRlsContext(
    adminClient,
    { userId: TEST_USER_ID, role: 'ADMIN', organizationId: 'ceid01lpfe1esm8jwsxid41k28' },
    async (tx) => {
      // Lead.projectId is NOT NULL (T-LEAD-PROJECT-REQUIRED) - the lead
      // fixtures below need a project to point at.
      await tx.project.upsert({
        where: { id: TEST_PROJECT_ID },
        update: {},
        create: {
          id: TEST_PROJECT_ID,
          name: `Test Project ${TEST_PROJECT_ID}`,
          slug: TEST_PROJECT_ID,
          address: 'test',
          organizationId: 'ceid01lpfe1esm8jwsxid41k28',
        },
      });
      await tx.team.upsert({
        where: { id: TEST_TEAM_ID },
        update: {},
        create: {
          id: TEST_TEAM_ID,
          name: 'WA Handler Test Team',
          organizationId: 'ceid01lpfe1esm8jwsxid41k28',
        },
      });
      await tx.user.upsert({
        where: { id: TEST_USER_ID },
        update: {},
        create: {
          id: TEST_USER_ID,
          email: 'wa-handler-admin@test.local',
          name: 'WA Handler Test Admin',
          role: 'ADMIN',
          organizationId: 'ceid01lpfe1esm8jwsxid41k28',
        },
      });
      // T-TEAM-AUTHORITATIVE (2026-09-13 clean cutover): a couple of
      // assertions below read the Message row back impersonating this same
      // user as MANAGER (message_select_team's MANAGER branch is now
      // Team.managerId-EXISTS only - the legacy app.user_team_id GUC
      // fallback has been removed) - set it explicitly.
      await tx.team.update({ where: { id: TEST_TEAM_ID }, data: { managerId: TEST_USER_ID } });
    },
  );

  // Second-org fixtures for the multi-tenant tests. The organization is CREATED
  // here rather than reused: this suite runs against shadhil_crm_test, which only
  // carries the shadhil-builders tenant. Seeding has no catch, so a database
  // problem fails the suite instead of silently skipping these tests.
  await withRlsContext(
    adminClient,
    { userId: TEST_USER_ID, role: 'ADMIN', organizationId: OTHER_ORG_ID },
    async (tx) => {
      // org_insert_public allows the row itself; everything below needs this
      // org's own context because the child tables' policies compare
      // organizationId to app.user_org_id.
      await tx.organization.upsert({
        where: { id: OTHER_ORG_ID },
        update: {},
        create: { id: OTHER_ORG_ID, name: 'WA Handler Other Org', slug: 'wa-handler-other-org' },
      });
    },
  );
  await withRlsContext(
    adminClient,
    { userId: OTHER_USER_ID, role: 'ADMIN', organizationId: OTHER_ORG_ID },
    async (tx) => {
        await tx.project.upsert({
          where: { id: OTHER_PROJECT_ID },
          update: {},
          create: {
            id: OTHER_PROJECT_ID,
            name: `Other Org Project ${OTHER_PROJECT_ID}`,
            slug: OTHER_PROJECT_ID,
            address: 'test',
            organizationId: OTHER_ORG_ID,
          },
        });
        await tx.team.upsert({
          where: { id: OTHER_TEAM_ID },
          update: {},
          create: {
            id: OTHER_TEAM_ID,
            name: 'WA Handler Other Team',
            organizationId: OTHER_ORG_ID,
          },
        });
        await tx.user.upsert({
          where: { id: OTHER_USER_ID },
          update: {},
          create: {
            id: OTHER_USER_ID,
            email: 'wa-handler-other-admin@test.local',
            name: 'WA Handler Other Admin',
            role: 'ADMIN',
            organizationId: OTHER_ORG_ID,
          },
        });
        await tx.team.update({ where: { id: OTHER_TEAM_ID }, data: { managerId: OTHER_USER_ID } });
    },
  );
});

beforeEach(async () => {
  // Each test starts with a clean set of fixture rows so the
  // assertions can count + look up without cross-test bleed. The
  // phone numbers include a per-test suffix to avoid unique-key
  // collisions with rows left by previous crashed runs.
  const suffix = Date.now().toString(36);
  knownPhone = `91${suffix.padStart(10, '0')}`.slice(0, 12);
  unknownPhone = `92${suffix.padStart(10, '0')}`.slice(0, 12);

  await withRlsContext(
    runtimePrisma as unknown as PrismaClient,
    { userId: TEST_USER_ID, role: 'ADMIN', organizationId: 'ceid01lpfe1esm8jwsxid41k28' },
    async (tx) => {
      const lead = await tx.lead.create({
        data: {
          name: 'Known Lead',
          phone: knownPhone,
          phoneE164: knownPhone,
          source: 'WEBSITE',
          teamId: TEST_TEAM_ID,
          ownerId: TEST_USER_ID,
          ownerType: 'ADMIN',
          organizationId: 'ceid01lpfe1esm8jwsxid41k28',

          projectId: TEST_PROJECT_ID,
        },
        select: { id: true },
      });
      knownLeadId = lead.id;

      // Create an OutboundMessage with a known wamid so we can
      // test the status-update path. The Outbound row needs a
      // backing Message (FK constraint).
      const msg = await tx.message.create({
        data: {
          leadId: lead.id,
          userId: TEST_USER_ID,
          direction: 'OUT',
          channel: 'WHATSAPP',
          body: 'hi from staff',
          organizationId: 'ceid01lpfe1esm8jwsxid41k28',
        },
        select: { id: true },
      });
      const out = await tx.outboundMessage.create({
        data: {
          messageId: msg.id,
          leadId: lead.id,
          sendType: 'FREEFORM',
          freeformBody: 'hi from staff',
          status: 'SENT',
          attempts: 1,
          lastAttemptAt: new Date(),
          wamid: 'wamid.test.status.update',
          organizationId: 'ceid01lpfe1esm8jwsxid41k28',
        },
        select: { id: true },
      });
      outboundMessageId = out.id;
    },
  );

  // Second-org rows: a lead + its outbox row, recreated per test so the phone
  // number stays unique and the status test always starts from SENT.
  otherPhone = `93${suffix.padStart(10, '0')}`.slice(0, 12);
    await withRlsContext(
      runtimePrisma as unknown as PrismaClient,
      { userId: OTHER_USER_ID, role: 'ADMIN', organizationId: OTHER_ORG_ID },
      async (tx) => {
        const lead = await tx.lead.create({
          data: {
            name: 'Other Org Lead',
            phone: otherPhone,
            phoneE164: otherPhone,
            source: 'WEBSITE',
            teamId: OTHER_TEAM_ID,
            ownerId: OTHER_USER_ID,
            ownerType: 'ADMIN',
            organizationId: OTHER_ORG_ID,
            projectId: OTHER_PROJECT_ID,
          },
          select: { id: true },
        });
        otherLeadId = lead.id;
        const msg = await tx.message.create({
          data: {
            leadId: lead.id,
            userId: OTHER_USER_ID,
            direction: 'OUT',
            channel: 'WHATSAPP',
            body: 'hi other org',
            organizationId: OTHER_ORG_ID,
          },
          select: { id: true },
        });
        const out = await tx.outboundMessage.create({
          data: {
            messageId: msg.id,
            leadId: lead.id,
            sendType: 'FREEFORM',
            freeformBody: 'hi other org',
            status: 'SENT',
            attempts: 1,
            lastAttemptAt: new Date(),
            wamid: 'wamid.test.other.status',
            organizationId: OTHER_ORG_ID,
          },
          select: { id: true },
        });
        otherOutboundId = out.id;
      },
    );
});

afterAll(async () => {
  if (!HAS_DB) return;
  // Clean up our fixtures. Order matters: WebhookEvent /
  // OutboundMessage / Message / Lead / WhatsappUnknownContact
  // before User / Team (FK cascade may already handle some of this
  // but explicit ordering avoids surprises).
  const adminClient = runtimePrisma as unknown as PrismaClient;
  await withRlsContext(
    adminClient,
    { userId: TEST_USER_ID, role: 'ADMIN', organizationId: 'ceid01lpfe1esm8jwsxid41k28' },
    async (tx) => {
      // Find all leads we created in this test session
      const leads = await tx.lead.findMany({
        where: { ownerId: TEST_USER_ID, source: 'WEBSITE' },
        select: { id: true },
      });
      for (const l of leads) {
        // Cascade deletes handle Message + OutboundMessage
        await tx.lead.delete({ where: { id: l.id } }).catch(() => null);
      }
      // Clean up unknown contacts we created
      await tx.whatsappUnknownContact
        .deleteMany({
          where: { phoneE164: { startsWith: '9' }, messageCount: { gte: 1 } },
        })
        .catch(() => null);
      // Clean up webhook events from this test
      await tx.webhookEvent.deleteMany({ where: { source: 'WHATSAPP' } }).catch(() => null);
    },
  );
  await withRlsContext(
    runtimePrisma as unknown as PrismaClient,
    { userId: OTHER_USER_ID, role: 'ADMIN', organizationId: OTHER_ORG_ID },
    async (tx) => {
      const leads = await tx.lead.findMany({
        where: { ownerId: OTHER_USER_ID },
        select: { id: true },
      });
      for (const l of leads) {
        await tx.lead.delete({ where: { id: l.id } }).catch(() => null);
      }
      await tx.webhookEvent.deleteMany({ where: { organizationId: OTHER_ORG_ID } }).catch(() => null);
    },
  );
  // Remove the fixture organization itself, children first. Best-effort: a leftover
  // row in the test database is harmless, and the beforeAll upserts make it reusable.
  await withRlsContext(
    runtimePrisma as unknown as PrismaClient,
    { userId: TEST_USER_ID, role: 'ADMIN', organizationId: OTHER_ORG_ID },
    async (tx) => {
      await tx.team.delete({ where: { id: OTHER_TEAM_ID } }).catch(() => null);
      await tx.user.delete({ where: { id: OTHER_USER_ID } }).catch(() => null);
      await tx.project.delete({ where: { id: OTHER_PROJECT_ID } }).catch(() => null);
      await tx.organization.delete({ where: { id: OTHER_ORG_ID } }).catch(() => null);
    },
  );
  await runtimePrisma.$disconnect();
});

// ── The tests ──────────────────────────────────────────────────────

describe.skipIf(!HAS_DB)('WhatsApp inbound webhook - T-E2b', () => {
  const controller = new WebhooksController();

  it('writes a Message row when an inbound text comes from a known lead', async () => {
    const externalId = `wamid.test.${Date.now()}.known`;
    const result = await controller.whatsappInbound({
      object: 'whatsapp_business_account',
      entry: [
        {
          changes: [
            {
              field: 'messages',
              value: {
                metadata: { phone_number_id: '123456' },
                messages: [
                  {
                    from: knownPhone,
                    id: externalId,
                    timestamp: '1700000000',
                    type: 'text',
                    text: { body: 'hi from a real lead' },
                  },
                ],
              },
            },
          ],
        },
      ],
    });

    expect(result.received).toBe(true);
    expect(result.messagesCreated).toBe(1);
    expect(result.deduped).toBe(0);

    // The Message row was actually written
    const msg = await withRlsContext(
      runtimePrisma as unknown as PrismaClient,
      { userId: TEST_USER_ID, role: 'MANAGER', organizationId: 'ceid01lpfe1esm8jwsxid41k28' },
      async (tx) =>
        tx.message.findFirst({
          where: { externalId, leadId: knownLeadId },
          select: { direction: true, channel: true, body: true, userId: true },
        }),
    );
    expect(msg).toBeTruthy();
    expect(msg?.direction).toBe('IN');
    expect(msg?.channel).toBe('WHATSAPP');
    expect(msg?.body).toBe('hi from a real lead');
    expect(msg?.userId).toBeNull(); // inbound from lead, not staff
  });

  it('upserts WhatsappUnknownContact for inbound from an unknown number', async () => {
    const externalId = `wamid.test.${Date.now()}.unknown`;
    const result = await controller.whatsappInbound({
      object: 'whatsapp_business_account',
      entry: [
        {
          changes: [
            {
              field: 'messages',
              value: {
                metadata: { phone_number_id: '123456' },
                messages: [
                  {
                    from: unknownPhone,
                    id: externalId,
                    timestamp: '1700000000',
                    type: 'text',
                    text: { body: 'is this available?' },
                  },
                ],
              },
            },
          ],
        },
      ],
    });

    expect(result.received).toBe(true);
    expect(result.unknownContactsUpserted).toBe(1);
    // T-WA-INBOX (2026-09-25): this USED to be 0, because an unknown number's
    // message was discarded after bumping the counters. The WhatsApp inbox has
    // to show the conversation, so the inbound is now stored as a Message row
    // on the contact thread too - a created message.
    expect(result.messagesCreated).toBe(1);

    // The contact row was created
    const contact = await withRlsContext(
      runtimePrisma as unknown as PrismaClient,
      { userId: TEST_USER_ID, role: 'ADMIN', organizationId: 'ceid01lpfe1esm8jwsxid41k28' },
      async (tx) =>
        tx.whatsappUnknownContact.findUnique({
          where: { phoneE164: unknownPhone },
          select: { id: true, status: true, firstMessageBody: true, messageCount: true },
        }),
    );
    expect(contact?.status).toBe('PENDING');
    expect(contact?.firstMessageBody).toBe('is this available?');
    expect(contact?.messageCount).toBe(1);

    // The message itself is now on the contact thread, readable by the inbox.
    // Scoped to THIS run's externalId: the test DB is not reset between runs,
    // so the thread accumulates rows and a bare count would drift.
    const stored = await withRlsContext(
      runtimePrisma as unknown as PrismaClient,
      { userId: TEST_USER_ID, role: 'ADMIN', organizationId: 'ceid01lpfe1esm8jwsxid41k28' },
      async (tx) =>
        tx.message.findMany({
          where: { externalId },
          select: {
            contactId: true,
            direction: true,
            channel: true,
            body: true,
            leadId: true,
            externalId: true,
          },
        }),
    );
    expect(stored).toHaveLength(1);
    expect(stored[0]!.contactId).toBe(contact!.id);
    expect(stored[0]).toMatchObject({
      direction: 'IN',
      channel: 'WHATSAPP',
      body: 'is this available?',
      externalId,
      // A contact thread must never carry a leadId (exactly one thread per row).
      leadId: null,
    });

    // A second message from the same number bumps the count
    const secondExternalId = `wamid.test.${Date.now()}.unknown2`;
    await controller.whatsappInbound({
      object: 'whatsapp_business_account',
      entry: [
        {
          changes: [
            {
              field: 'messages',
              value: {
                messages: [
                  {
                    from: unknownPhone,
                    id: secondExternalId,
                    timestamp: '1700000001',
                    type: 'text',
                    text: { body: 'still there?' },
                  },
                ],
              },
            },
          ],
        },
      ],
    });
    const updated = await withRlsContext(
      runtimePrisma as unknown as PrismaClient,
      { userId: TEST_USER_ID, role: 'ADMIN', organizationId: 'ceid01lpfe1esm8jwsxid41k28' },
      async (tx) =>
        tx.whatsappUnknownContact.findUnique({
          where: { phoneE164: unknownPhone },
          select: { messageCount: true, firstMessageBody: true },
        }),
    );
    expect(updated?.messageCount).toBe(2);
    // firstMessageBody should NOT change on the 2nd+ message
    expect(updated?.firstMessageBody).toBe('is this available?');

    // ...and BOTH messages are on the thread (history, not just a counter).
    const all = await withRlsContext(
      runtimePrisma as unknown as PrismaClient,
      { userId: TEST_USER_ID, role: 'ADMIN', organizationId: 'ceid01lpfe1esm8jwsxid41k28' },
      async (tx) =>
        tx.message.findMany({
          where: { externalId: { in: [externalId, secondExternalId] } },
          select: { body: true },
          orderBy: { createdAt: 'asc' },
        }),
    );
    expect(all.map((m) => m.body)).toEqual(['is this available?', 'still there?']);
  });

  it('updates the matching OutboundMessage when a status update arrives', async () => {
    const result = await controller.whatsappInbound({
      object: 'whatsapp_business_account',
      entry: [
        {
          changes: [
            {
              field: 'messages',
              value: {
                statuses: [
                  {
                    id: 'wamid.test.status.update',
                    status: 'delivered',
                    timestamp: '1700000000',
                    recipient_id: knownPhone,
                  },
                ],
              },
            },
          ],
        },
      ],
    });

    expect(result.received).toBe(true);
    expect(result.statusesUpdated).toBe(1);

    const updated = await withRlsContext(
      runtimePrisma as unknown as PrismaClient,
      {
        userId: 'CRON_SERVICE',
        role: 'CRON_SERVICE',
        organizationId: 'ceid01lpfe1esm8jwsxid41k28',
      },
      async (tx) =>
        tx.outboundMessage.findUnique({
          where: { id: outboundMessageId },
          select: { status: true },
        }),
    );
    expect(updated?.status).toBe('DELIVERED');
  });

  // ── T-WA-MULTITENANT (2026-11-19) ────────────────────────────────
  // Both regressions below were live in prod: a status callback for a row in
  // any org other than PUBLIC_ORG_ID matched nothing (the row stayed SENT while
  // the customer's phone showed delivered), and a reply from another org's lead
  // was filed as an unknown contact in the public org.

  it(
    'status callback updates an OutboundMessage that belongs to another org',
    async () => {
      const result = await controller.whatsappInbound({
        object: 'whatsapp_business_account',
        entry: [
          {
            changes: [
              {
                field: 'messages',
                value: {
                  metadata: { phone_number_id: '123456' },
                  statuses: [
                    {
                      id: 'wamid.test.other.status',
                      status: 'delivered',
                      timestamp: '1700000000',
                      recipient_id: otherPhone,
                    },
                  ],
                },
              },
            ],
          },
        ],
      });

      expect(result.received).toBe(true);
      expect(result.statusesUpdated).toBe(1);

      const updated = await withRlsContext(
        runtimePrisma as unknown as PrismaClient,
        { userId: 'CRON_SERVICE', role: 'CRON_SERVICE', organizationId: OTHER_ORG_ID },
        async (tx) =>
          tx.outboundMessage.findUnique({
            where: { id: otherOutboundId },
            select: { status: true },
          }),
      );
      expect(updated?.status).toBe('DELIVERED');
    },
  );

  it(
    'inbound from another org lead lands on that lead, not an unknown contact',
    async () => {
      const externalId = `wamid.test.${Date.now()}.other.in`;

      const result = await controller.whatsappInbound({
        object: 'whatsapp_business_account',
        entry: [
          {
            changes: [
              {
                field: 'messages',
                value: {
                  metadata: { phone_number_id: '123456' },
                  messages: [
                    {
                      from: otherPhone,
                      id: externalId,
                      timestamp: '1700000000',
                      type: 'text',
                      text: { body: 'hi from the other org lead' },
                    },
                  ],
                },
              },
            ],
          },
        ],
      });

      expect(result.messagesCreated).toBe(1);
      expect(result.unknownContactsUpserted).toBe(0);

      const msg = await withRlsContext(
        runtimePrisma as unknown as PrismaClient,
        { userId: OTHER_USER_ID, role: 'ADMIN', organizationId: OTHER_ORG_ID },
        async (tx) =>
          tx.message.findFirst({
            where: { externalId },
            select: { leadId: true, organizationId: true, direction: true },
          }),
      );
      expect(msg?.leadId).toBe(otherLeadId);
      expect(msg?.organizationId).toBe(OTHER_ORG_ID);
      expect(msg?.direction).toBe('IN');
    },
  );

  it('dedupes by WebhookEvent.externalId (Meta retries)', async () => {
    const externalId = `wamid.test.${Date.now()}.dedup`;

    const first = await controller.whatsappInbound({
      object: 'whatsapp_business_account',
      entry: [
        {
          changes: [
            {
              field: 'messages',
              value: {
                messages: [
                  {
                    from: knownPhone,
                    id: externalId,
                    timestamp: '1700000000',
                    type: 'text',
                    text: { body: 'first delivery' },
                  },
                ],
              },
            },
          ],
        },
      ],
    });
    expect(first.messagesCreated).toBe(1);

    // Second call with the SAME externalId - should be a no-op
    // for Message creation (still records the WebhookEvent
    // attempt, but the unique constraint fails and we return
    // 'deduped').
    const second = await controller.whatsappInbound({
      object: 'whatsapp_business_account',
      entry: [
        {
          changes: [
            {
              field: 'messages',
              value: {
                messages: [
                  {
                    from: knownPhone,
                    id: externalId,
                    timestamp: '1700000000',
                    type: 'text',
                    text: { body: 'duplicate - should be ignored' },
                  },
                ],
              },
            },
          ],
        },
      ],
    });
    expect(second.messagesCreated).toBe(0);
    expect(second.deduped).toBe(1);

    // Only one Message row was created for that externalId
    const messages = await withRlsContext(
      runtimePrisma as unknown as PrismaClient,
      { userId: TEST_USER_ID, role: 'MANAGER', organizationId: 'ceid01lpfe1esm8jwsxid41k28' },
      async (tx) =>
        tx.message.findMany({
          where: { externalId, leadId: knownLeadId },
          select: { id: true, body: true },
        }),
    );
    expect(messages).toHaveLength(1);
    expect(messages[0]?.body).toBe('first delivery');
  });

  it('GET verify-handshake echoes the challenge with a valid token', () => {
    process.env['WA_WEBHOOK_VERIFY_TOKEN'] = 'test-token';
    const challenge = controller.verify('subscribe', 'test-token', 'CHALLENGE_123');
    expect(challenge).toBe('CHALLENGE_123');
    delete process.env['WA_WEBHOOK_VERIFY_TOKEN'];
  });

  it('GET verify-handshake rejects a bad token', () => {
    process.env['WA_WEBHOOK_VERIFY_TOKEN'] = 'test-token';
    expect(() => controller.verify('subscribe', 'wrong-token', 'CHALLENGE')).toThrow();
    delete process.env['WA_WEBHOOK_VERIFY_TOKEN'];
  });
});
