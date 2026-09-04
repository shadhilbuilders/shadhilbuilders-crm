// One-off: create a DEMO user with a real (non-placeholder) password and
// reassign all seeded leads to that user, so the T-S placeholder gate
// doesn't block the Sunday client demo.
//
// Usage:
//   cd packages/database && pnpm exec tsx --env-file=../../.env scripts/setup-demo-user.ts
//
// What it does:
//   1. Upserts a MANAGER-role user demo@shadhilbuilders.in (password demo123)
//   2. Upserts a credential Account for them (better-auth sign-in contract)
//   3. Reassigns all seeded leads' ownerId to the demo user, keeps teamId
//   4. Leaves the 5 seed users untouched (they stay in placeholder-users.json)
//
// Idempotent — re-running just resets the password and re-reassigns leads.
//
// DO NOT commit the demo user to prod: this is a local demo helper.
// Delete the script after Sunday's demo.
import { randomBytes, scryptSync } from 'node:crypto';

import { PrismaPg } from '@prisma/adapter-pg';

import { PrismaClient } from '../src/generated/prisma/client.js';

const prisma: PrismaClient = new PrismaClient({
  adapter: new PrismaPg({
    connectionString: process.env.DIRECT_DATABASE_URL ?? process.env.DATABASE_URL,
  }),
});

const DEMO_EMAIL = 'demo@shadhilbuilders.in';
const DEMO_PASSWORD = 'demo123';
const DEMO_NAME = 'Demo Manager';

function hash(pw: string): string {
  const salt = randomBytes(16).toString('hex');
  const normalized = pw.normalize('NFKC');
  const hash = scryptSync(normalized, salt, 64, {
    N: 16384,
    r: 16,
    p: 1,
    maxmem: 128 * 16384 * 16 * 2,
  }).toString('hex');
  return `${salt}:${hash}`;
}

async function main() {
  // 1. Upsert demo user (no team yet — the team needs demoUser.id).
  const demoUser = await prisma.user.upsert({
    where: { email: DEMO_EMAIL },
    update: { name: DEMO_NAME, role: 'MANAGER' },
    create: {
      email: DEMO_EMAIL,
      name: DEMO_NAME,
      role: 'MANAGER',
      emailVerified: true,
    },
  });

  // Create a fresh team for the demo user so RLS team-scoped queries
  // return rows. The seed's MANAGER team is also available (after the
  // Day 3 ordering-bug fix), but using a separate team keeps demo data
  // clearly partitioned — anyone touching demo@shadhilbuilders.in can't
  // accidentally read other users' rows.
  //
  // managerId MUST be set: leads.service.ts:managerTeamId() resolves the
  // MANAGER's team via Team.findFirst({ managerId: actor.sub }), so a
  // team with no managerId leaves the manager with teamId=null from the
  // backend's perspective, and listWhere narrows to '__no_team__'
  // (zero rows).
  const demoTeam = await prisma.team.upsert({
    where: { id: 'demo-team' },
    update: { name: 'Demo Team', managerId: demoUser.id },
    create: {
      id: 'demo-team',
      name: 'Demo Team',
      managerId: demoUser.id,
    },
  });

  // 1b. Now that the team exists, set the demo user's teamId.
  await prisma.user.update({
    where: { id: demoUser.id },
    data: { teamId: demoTeam.id },
  });

  // 2. Upsert credential Account (better-auth sign-in contract).
  await prisma.account.upsert({
    where: {
      providerId_accountId: {
        providerId: 'credential',
        accountId: demoUser.id,
      },
    },
    update: { password: hash(DEMO_PASSWORD), issuer: 'local:credential' },
    create: {
      accountId: demoUser.id,
      providerId: 'credential',
      issuer: 'local:credential',
      userId: demoUser.id,
      password: hash(DEMO_PASSWORD),
    },
  });

  // 3. Reassign all leads to the demo user + demo team.
  const reassign = await prisma.lead.updateMany({
    where: {},
    data: { ownerId: demoUser.id, ownerType: 'MANAGER', teamId: demoTeam.id },
  });

  // 4. T-DEMOSET: seed chat, notifications, and bookings for the demo user
  // so the demo lists (chat pane, /notifications, /bookings) render with
  // real data on Sunday 2026-09-07. RLS uses the parent-Lead (or userId for
  // Notification) to scope rows; we connect as the owner role here, so RLS
  // is bypassed for the inserts and the demo user will see them via their
  // JWT-scoped reads at runtime.
  //
  // Idempotency: re-running this script must not append duplicate rows.
  // Strategy — clear the previous demo-seeded rows for this user/team
  // first, then re-insert. We scope by userId (Notification) and by the
  // demo-team lead set (Message, Booking) so any unrelated rows
  // (e.g. matrix-test fixtures) are untouched.
  const demoLeads = await prisma.lead.findMany({
    where: { teamId: demoTeam.id },
    select: { id: true, name: true, state: true },
    orderBy: { name: 'asc' },
  });
  const demoLeadIds = demoLeads.map((l) => l.id);
  const clearMessages = await prisma.message.deleteMany({
    where: { leadId: { in: demoLeadIds } },
  });
  const clearNotifs = await prisma.notification.deleteMany({
    where: { userId: demoUser.id },
  });
  const clearBookings = await prisma.booking.deleteMany({
    where: { leadId: { in: demoLeadIds } },
  });
  // eslint-disable-next-line no-console
  console.log(
    `[demo-user] cleared previous demo rows: ${clearMessages.count} messages, ${clearNotifs.count} notifications, ${clearBookings.count} bookings`
  );

  const wonLead = demoLeads.find((l) => l.state === 'WON');
  // Pick a deterministic unit from the seed roster (avoids creating new
  // rows the inventory module hasn't audited).
  const unit = await prisma.unit.findFirst({ select: { id: true } });
  const unitId = unit?.id ?? 'fixture-unit-a';

  // 4a. Chat: 1 message per demo lead (alternating directions + channels
  // so the chat pane has visual variety).
  const channelMix: Array<'IN_APP' | 'WHATSAPP'> = ['IN_APP', 'IN_APP', 'WHATSAPP'];
  for (let i = 0; i < demoLeads.length; i++) {
    const lead = demoLeads[i]!;
    const direction = i % 2 === 0 ? 'IN' : 'OUT';
    const channel = channelMix[i % channelMix.length]!;
    const body =
      direction === 'IN'
        ? `Hi, I'm interested in the ${lead.state} property. Please share details.`
        : `Thanks for reaching out, ${lead.name.split(' ')[0]}. Sharing the brochure now.`;
    await prisma.message.create({
      data: {
        leadId: lead.id,
        userId: direction === 'OUT' ? demoUser.id : null,
        direction,
        channel,
        body,
      },
    });
  }

  // 4b. Notifications: 3 for the demo user, mixing read + unread, across
  // different lead.contexts (matches the wireframe's "All / Unread" filter
  // chips).
  await prisma.notification.createMany({
    data: [
      {
        userId: demoUser.id,
        type: 'lead.assigned',
        title: `New lead: ${demoLeads[0]?.name ?? 'Unassigned'}`,
        body: 'Assigned to you by the system. Review and respond within 24h.',
        leadId: demoLeads[0]?.id,
        read: false,
      },
      {
        userId: demoUser.id,
        type: 'visit.scheduled',
        title: 'Visit confirmed for tomorrow',
        body: `${demoLeads[1]?.name ?? 'Lead'} confirmed the site visit at 10:00 AM.`,
        leadId: demoLeads[1]?.id,
        read: false,
      },
      {
        userId: demoUser.id,
        type: 'booking.requested',
        title: 'Token request received',
        body: `${demoLeads[2]?.name ?? 'Lead'} requested a token for Unit A-1201.`,
        leadId: demoLeads[2]?.id,
        read: true,
      },
    ],
  });

  // 4c. Bookings: 2 on the WON lead (so /bookings has data on the demo
  // path). Different statuses to exercise the status filter.
  if (wonLead) {
    await prisma.booking.createMany({
      data: [
        {
          leadId: wonLead.id,
          unitId,
          userId: demoUser.id,
          amount: '7500000.00',
          tokenAmount: '250000.00',
          status: 'APPROVED',
          approvedById: demoUser.id,
        },
        {
          leadId: wonLead.id,
          unitId,
          userId: demoUser.id,
          amount: '1200000.00',
          tokenAmount: null,
          status: 'HOLD',
        },
      ],
    });
  }

  // eslint-disable-next-line no-console
  console.log(
    `[demo-user] user ${DEMO_EMAIL} (MANAGER) ready, password "${DEMO_PASSWORD}"`
  );
  // eslint-disable-next-line no-console
  console.log(
    `[demo-user] ${reassign.count} leads reassigned to demo user (team: ${demoTeam.id})`
  );
  // eslint-disable-next-line no-console
  console.log(
    `[demo-user] seeded: ${demoLeads.length} chat messages, 3 notifications, ${wonLead ? 2 : 0} bookings`
  );

  await prisma.$disconnect();
}

main().catch((err) => {
  // eslint-disable-next-line no-console
  console.error('[demo-user] failed:', err);
  process.exit(1);
});
