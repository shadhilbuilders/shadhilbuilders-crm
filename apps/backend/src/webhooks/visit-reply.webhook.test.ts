// T-WA-VISIT-REPLY (2026-11-28): a customer's WhatsApp "YES" / "RESCHEDULE"
// reply has to DO something.
//
// The visit reminder asks the customer to reply YES, and until this suite every
// such reply was stored as a message and then ignored: the visit stayed
// SCHEDULED, nobody was told, and the answer sat in a thread until someone
// happened to open it. A confirmed visit that nobody knows about is the same as
// no confirmation at all.
//
// REAL DB, real services. `NotificationsService.emit` writes a real Notification
// row through its own RLS transaction, and `LeadsService.transitionInTransaction`
// runs the real state machine, so these tests can prove the visit moved, the lead
// moved and the right people were told. A mocked notification service would only
// prove that a function was called.
//
// PRIVATE TENANT PER FILE (test-utils/test-tenant): the audience for a visit
// includes every OWNER in the organization, so a shared org would mean other
// suites' users in these counts - and other suites' notifications in these
// recipients' inboxes.
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { prisma as runtimePrisma, withRlsContext } from '@shadhil/database';

import { LeadsService } from '../leads/leads.service';
import { NotificationsService } from '../notifications/notifications.service';
import { PrismaService } from '../prisma/prisma.module';
import { createTestTenant, type TestTenant } from '../test-utils/test-tenant';

import { WebhooksController } from './webhooks.controller';

const HAS_DB = Boolean(process.env.DATABASE_URL);

const HOUR = 60 * 60 * 1000;
const RUN = Date.now();

let tenant: TestTenant;
let ORG_ID = '';
let PROJECT_ID = '';
let TEAM_ID = '';
let OWNER_ID = '';
let MANAGER_ID = '';
let EXEC_ID = '';

/** The controller with the real notification + lead services wired in. */
function controllerWith(
  notifications: NotificationsService,
  leads: LeadsService | undefined,
): WebhooksController {
  return new WebhooksController(undefined, undefined, undefined, notifications, leads);
}

/** A Meta inbound envelope carrying one text message. */
function envelope(
  from: string,
  externalId: string,
  message: { type: string; text?: { body: string }; image?: { id: string } },
) {
  return {
    object: 'whatsapp_business_account',
    entry: [
      {
        changes: [
          {
            field: 'messages',
            value: {
              metadata: { phone_number_id: '123456' },
              messages: [{ from, id: externalId, ...message }],
            },
          },
        ],
      },
    ],
  };
}

/** Unique, digits-only, and valid as E.164 digits (the webhook parses `from`). */
let phoneSeq = 0;
function nextPhone(): string {
  phoneSeq += 1;
  return `9198${String(RUN).slice(-6)}${String(phoneSeq).padStart(2, '0')}`;
}

type SeededLead = { leadId: string; phone: string };

/** A lead in this tenant, owned by OWNER_ID, on the seeded team. */
async function seedLead(
  overrides: { state?: string; visits?: Array<{ at: Date; status?: string }> } = {},
): Promise<SeededLead> {
  const phone = nextPhone();
  const lead = await tenant.admin.lead.create({
    data: {
      name: `Reply Lead ${phoneSeq}`,
      phone,
      phoneE164: phone,
      source: 'WEBSITE',
      state: (overrides.state ?? 'VISIT_SCHEDULED') as never,
      teamId: TEAM_ID,
      ownerId: OWNER_ID,
      ownerType: 'TELECALLER',
      organizationId: ORG_ID,
      projectId: PROJECT_ID,
    },
    select: { id: true },
  });
  for (const visit of overrides.visits ?? []) {
    await tenant.admin.siteVisit.create({
      data: {
        leadId: lead.id,
        organizationId: ORG_ID,
        userId: EXEC_ID,
        scheduledFor: visit.at,
        status: (visit.status ?? 'SCHEDULED') as never,
      },
    });
  }
  return { leadId: lead.id, phone };
}

const visitsOf = (leadId: string) =>
  tenant.admin.siteVisit.findMany({
    where: { leadId },
    select: { id: true, status: true, confirmedAt: true, confirmedVia: true },
  });
const notificationsOf = (leadId: string) =>
  tenant.admin.notification.findMany({
    where: { leadId },
    select: { userId: true, type: true, title: true, body: true },
  });
const auditOf = (entityId: string) =>
  tenant.admin.auditLog.findMany({
    where: { entityId },
    select: { action: true, userId: true, before: true, after: true, reason: true },
  });
const messagesOf = (leadId: string) =>
  tenant.admin.message.findMany({ where: { leadId, direction: 'IN' }, select: { body: true } });
const activitiesOf = (leadId: string) =>
  tenant.admin.activity.findMany({
    where: { leadId },
    orderBy: { createdAt: 'asc' },
    select: { userId: true, type: true, body: true, user: { select: { name: true } } },
  });

beforeAll(async () => {
  if (!HAS_DB) return;
  tenant = await createTestTenant('wa-visit-reply');
  ORG_ID = tenant.organizationId;

  PROJECT_ID = `test-vreply-proj-${RUN}`;
  TEAM_ID = `test-vreply-team-${RUN}`;
  OWNER_ID = `test-vreply-owner-${RUN}`;
  MANAGER_ID = `test-vreply-mgr-${RUN}`;
  EXEC_ID = `test-vreply-exec-${RUN}`;

  // Seeded through this tenant's own RLS context: every child table's policy
  // compares organizationId to app.user_org_id, so the fixture has to look like
  // a real tenant's data, not a privileged back door.
  await withRlsContext(
    tenant.admin,
    { userId: 'test-vreply-seed', role: 'ADMIN', organizationId: ORG_ID },
    async (tx) => {
      await tx.project.create({
        data: {
          id: PROJECT_ID,
          name: `Reply Project ${RUN}`,
          slug: `test-vreply-proj-${RUN}`,
          address: 'test',
          organizationId: ORG_ID,
        },
      });
      for (const [id, role, email] of [
        [OWNER_ID, 'TELECALLER', 'reply-owner'],
        [MANAGER_ID, 'MANAGER', 'reply-mgr'],
        [EXEC_ID, 'SALES_EXEC', 'reply-exec'],
      ] as const) {
        await tx.user.create({
          data: { id, email: `${email}@test.local`, name: email, role, organizationId: ORG_ID },
        });
      }
      // After the users: Team.managerId points at MANAGER_ID.
      await tx.team.create({
        data: {
          id: TEAM_ID,
          name: `Reply Team ${RUN}`,
          organizationId: ORG_ID,
          managerId: MANAGER_ID,
        },
      });
    },
  );
});

afterAll(async () => {
  if (!HAS_DB) return;
  await tenant.dispose();
});

describe.skipIf(!HAS_DB)('a customer replies to a visit reminder', () => {
  const notifications = () => new NotificationsService(new PrismaService());
  const leads = () => new LeadsService(new PrismaService());

  it('confirms the one open visit, audits it, and tells the three stakeholders', async () => {
    const { leadId, phone } = await seedLead({
      visits: [{ at: new Date(Date.now() + 24 * HOUR) }],
    });

    const result = await controllerWith(notifications(), leads()).whatsappInbound(
      envelope(phone, `wamid.reply.confirm.${RUN}.a`, { type: 'text', text: { body: 'YES' } }),
    );

    expect(result.messagesCreated).toBe(1);

    const visits = await visitsOf(leadId);
    expect(visits).toHaveLength(1);
    expect(visits[0]?.confirmedVia).toBe('WHATSAPP');
    expect(visits[0]?.confirmedAt).not.toBeNull();
    // Confirmation is not a lifecycle move: the visit is still the appointment.
    expect(visits[0]?.status).toBe('SCHEDULED');

    const audit = await auditOf(visits[0]!.id);
    expect(audit).toHaveLength(1);
    expect(audit[0]?.action).toBe('visit.confirm');
    // No staff member did this, so no staff member is credited with it.
    expect(audit[0]?.userId).toBeNull();
    expect(audit[0]?.reason).toContain('WhatsApp');

    const told = await notificationsOf(leadId);
    expect(told.map((n) => n.userId).sort()).toEqual([EXEC_ID, MANAGER_ID, OWNER_ID].sort());
    expect(told.every((n) => n.type === 'visit.confirmed')).toBe(true);

    // The lead timeline is where staff actually read the history. The customer
    // did this, so nobody is credited with it: no userId, and the UI's existing
    // "by <name>" line simply does not render.
    const timeline = await activitiesOf(leadId);
    expect(timeline).toHaveLength(1);
    expect(timeline[0]?.userId).toBeNull();
    expect(timeline[0]?.user).toBeNull();
    expect(timeline[0]?.type).toBe('VISIT');
    expect(timeline[0]?.body).toContain('confirmed the visit');
    expect(timeline[0]?.body).toContain('WhatsApp');
  });

  it('ignores a second YES: one confirmation, one audit row, one notification each', async () => {
    const { leadId, phone } = await seedLead({
      visits: [{ at: new Date(Date.now() + 24 * HOUR) }],
    });
    const controller = controllerWith(notifications(), leads());

    await controller.whatsappInbound(
      envelope(phone, `wamid.reply.confirm.${RUN}.b1`, { type: 'text', text: { body: 'YES' } }),
    );
    const first = (await visitsOf(leadId))[0]?.confirmedAt;
    await controller.whatsappInbound(
      envelope(phone, `wamid.reply.confirm.${RUN}.b2`, { type: 'text', text: { body: 'yes!' } }),
    );

    const visits = await visitsOf(leadId);
    expect(visits).toHaveLength(1);
    expect(visits[0]?.confirmedAt).toEqual(first);
    expect(await auditOf(visits[0]!.id)).toHaveLength(1);
    expect(await notificationsOf(leadId)).toHaveLength(3);
    expect(await activitiesOf(leadId)).toHaveLength(1);
  });

  it('leaves a visit that has already happened alone, and still stores the message', async () => {
    const { leadId, phone } = await seedLead({ visits: [{ at: new Date(Date.now() - 2 * HOUR) }] });

    await controllerWith(notifications(), leads()).whatsappInbound(
      envelope(phone, `wamid.reply.past.${RUN}`, { type: 'text', text: { body: 'YES' } }),
    );

    expect((await visitsOf(leadId))[0]?.confirmedAt).toBeNull();
    expect(await notificationsOf(leadId)).toHaveLength(0);
    expect(await activitiesOf(leadId)).toHaveLength(0);
    expect((await messagesOf(leadId)).map((m) => m.body)).toEqual(['YES']);
  });

  it('treats a sentence as ordinary conversation', async () => {
    const { leadId, phone } = await seedLead({
      visits: [{ at: new Date(Date.now() + 24 * HOUR) }],
    });

    await controllerWith(notifications(), leads()).whatsappInbound(
      envelope(phone, `wamid.reply.sentence.${RUN}`, {
        type: 'text',
        text: { body: 'yes I will come by 5' },
      }),
    );

    expect((await visitsOf(leadId))[0]?.confirmedAt).toBeNull();
    expect(await notificationsOf(leadId)).toHaveLength(0);
  });

  it('does not read a photo caption as a reply', async () => {
    const { leadId, phone } = await seedLead({
      visits: [{ at: new Date(Date.now() + 24 * HOUR) }],
    });

    // The WhatsAppClient is absent in tests, so the media download fails and the
    // Message row lands without bytes - what matters here is that a non-text
    // message never reaches the parser.
    await controllerWith(notifications(), leads()).whatsappInbound(
      envelope(phone, `wamid.reply.image.${RUN}`, { type: 'image', image: { id: 'media-1' } }),
    );

    expect((await visitsOf(leadId))[0]?.confirmedAt).toBeNull();
  });

  it('RESCHEDULE moves the lead and the visit, and says nobody has called yet', async () => {
    const { leadId, phone } = await seedLead({
      visits: [{ at: new Date(Date.now() + 24 * HOUR) }],
    });

    await controllerWith(notifications(), leads()).whatsappInbound(
      envelope(phone, `wamid.reply.resched.${RUN}`, { type: 'text', text: { body: 'RESCHEDULE' } }),
    );

    const lead = await tenant.admin.lead.findUnique({
      where: { id: leadId },
      select: { state: true },
    });
    expect(lead?.state).toBe('RESCHEDULED');
    // The cascade owns the visit, not this handler: one rule, one writer.
    expect((await visitsOf(leadId))[0]?.status).toBe('RESCHEDULED');

    // The transition's own `lead.transition` notification is fire-and-forget
    // (LeadsService.emitBestEffort) and lands whenever its own transaction
    // finishes, so it is not counted here. What this ticket owns is the
    // reschedule row, and that one is awaited.
    const reschedule = (await notificationsOf(leadId)).filter(
      (n) => n.type === 'visit.reschedule_requested',
    );
    expect(reschedule.map((n) => n.userId).sort()).toEqual([EXEC_ID, MANAGER_ID, OWNER_ID].sort());
    expect(reschedule[0]?.body.toLowerCase()).toContain('no one has called');

    const timeline = await activitiesOf(leadId);
    expect(timeline).toHaveLength(1);
    expect(timeline[0]?.userId).toBeNull();
    expect(timeline[0]?.body.toLowerCase()).toContain('reschedule');
  });

  it('a lead the machine will not move still reaches the team', async () => {
    // WON is terminal for a TELECALLER, so the transition is refused. The customer
    // still asked for a new time, and that is the fact a human must act on.
    const { leadId, phone } = await seedLead({
      state: 'WON',
      visits: [{ at: new Date(Date.now() + 24 * HOUR) }],
    });

    const result = await controllerWith(notifications(), leads()).whatsappInbound(
      envelope(phone, `wamid.reply.won.${RUN}`, { type: 'text', text: { body: 'RESCHEDULE' } }),
    );

    expect(result.errors).toEqual([]);
    const lead = await tenant.admin.lead.findUnique({
      where: { id: leadId },
      select: { state: true },
    });
    expect(lead?.state).toBe('WON');
    expect((await visitsOf(leadId))[0]?.status).toBe('SCHEDULED');
    const reschedule = (await notificationsOf(leadId)).filter(
      (n) => n.type === 'visit.reschedule_requested',
    );
    expect(reschedule).toHaveLength(3);
  });

  it('keeps the confirmation when telling people fails', async () => {
    const { leadId, phone } = await seedLead({
      visits: [{ at: new Date(Date.now() + 24 * HOUR) }],
    });
    const failing = {
      emit: vi.fn(async () => {
        throw new Error('push service down');
      }),
    };

    const result = await controllerWith(failing as never, leads()).whatsappInbound(
      envelope(phone, `wamid.reply.notifyfail.${RUN}`, { type: 'text', text: { body: 'YES' } }),
    );

    expect(result.errors).toEqual([]);
    expect((await visitsOf(leadId))[0]?.confirmedAt).not.toBeNull();
  });
});
