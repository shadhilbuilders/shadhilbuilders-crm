// One-off: create a TEST organization + an OWNER-role test user inside it,
// with its own isolated test seed data for production testing.
//
// Usage (on VPS, inside the database container or via pnpm):
//   cd packages/database && pnpm exec tsx --env-file=../../.env scripts/seed-test-user.ts
//
// What it does (all of it scoped to TEST_ORG_ID - the real org is untouched):
//   1. Upserts the test Organization row (its own tenant).
//   2. Upserts an OWNER-role user test@shadhilbuilders.in INSIDE that org,
//      plus its credential Account.
//   3. Upserts a test team + project + phases + units + leads, so the test
//      org is not an empty shell.
//   4. Seeds chat / notifications / bookings for the test lists to render.
//
// WHY A SEPARATE ORG:
//   `User.organizationId` is single-valued (one org per user; there is no
//   membership table), and the DB enforces
//     one_owner_per_org  UNIQUE ("organizationId") WHERE role = 'OWNER'
//   i.e. EXACTLY ONE OWNER PER ORG. A second OWNER therefore cannot coexist
//   with the bootstrap org's owner - a different org is the only legal shape.
//
// RLS note: this script connects as the migration/owner role, so RLS is
// bypassed for these writes. That is deliberate - it is a provisioning script,
// not request-path code.
//
// Idempotent: every write is an upsert or a scoped delete-then-insert, so
// re-running resets the test data without duplicating rows.
import { randomBytes, scryptSync } from 'node:crypto';

import { PrismaPg } from '@prisma/adapter-pg';

import { PrismaClient } from '../src/generated/prisma/client.js';

const prisma: PrismaClient = new PrismaClient({
  adapter: new PrismaPg({
    connectionString: process.env.DIRECT_DATABASE_URL ?? process.env.DATABASE_URL,
  }),
});

const TEST_EMAIL = 'test@shadhilbuilders.in';
const TEST_PASSWORD = 'Test@123456';
const TEST_NAME = 'Test Owner';

// ── Test tenant identity (fixed cuid2 ids, so re-runs stay idempotent) ──────
const TEST_ORG_ID = 'k7mjd78nxvpq9vs8fqkzmfyb';
const TEST_ORG_NAME = 'Shadhil Test';
const TEST_ORG_SLUG = 'test';
const TEST_PROJECT_ID = 'uo4inf3gya03lyssknswpljq';
const TEST_PROJECT_SLUG = 'test-villas';
const TEST_PHASE_A = 'zfoou6t9bvsi5wux4amhr3lc';
const TEST_PHASE_B = 'a6bbl6uncqxwvzye5chn0dme';
const TEST_TEAM_ID = 'ne5v26zdocwey0594idqakuz';
const TEST_LEAD_1 = 'el7wu9er2k6rqx66pmasnd3g';
const TEST_LEAD_2 = 'et642l67tyugijbgad0y5pou';
const TEST_LEAD_3 = 'okcp4kh02kux5e6nbivv9bo7';
const TEST_LEAD_4 = 'wnsn7dbeakjw47a8k607aqmp';
const TEST_LEAD_5 = 'sv899fs2jmjyexbe9mr9r85n';
const TEST_LEAD_WON = 'lbwv7s9vyqj7soojonymxr6';

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
  // ── 1. The test organization (its own tenant) ───────────────────────────
  const testOrg = await prisma.organization.upsert({
    where: { id: TEST_ORG_ID },
    update: { name: TEST_ORG_NAME, slug: TEST_ORG_SLUG },
    create: { id: TEST_ORG_ID, name: TEST_ORG_NAME, slug: TEST_ORG_SLUG },
  });

  // ── 2. The test user: OWNER of the test org ─────────────────────────────
  //
  // mustChangePassword = FALSE even though the OWNER is the one role the gate
  // applies to (see packages/database/src/seed.ts). Rationale: this is a
  // test account whose password is known, so gating it would only block the
  // test path - and the gate's purpose (protect a privileged account with an
  // unknown password) does not apply. The real org's OWNER stays gated.
  const testUser = await prisma.user.upsert({
    where: { email: TEST_EMAIL },
    update: {
      name: TEST_NAME,
      role: 'OWNER',
      organizationId: testOrg.id,
      mustChangePassword: false,
    },
    create: {
      email: TEST_EMAIL,
      name: TEST_NAME,
      role: 'OWNER',
      organizationId: testOrg.id,
      emailVerified: true,
      mustChangePassword: false,
    },
  });

  // Credential Account (better-auth sign-in contract: accountId === user.id).
  await prisma.account.upsert({
    where: {
      providerId_accountId: {
        providerId: 'credential',
        accountId: testUser.id,
      },
    },
    update: { password: hash(TEST_PASSWORD), issuer: 'local:credential' },
    create: {
      accountId: testUser.id,
      providerId: 'credential',
      issuer: 'local:credential',
      userId: testUser.id,
      password: hash(TEST_PASSWORD),
    },
  });

  // ── 3. Test team + project + inventory + leads (all inside the test org) ─
  const testTeam = await prisma.team.upsert({
    where: { id: TEST_TEAM_ID },
    update: { name: 'Test Team', managerId: testUser.id },
    create: {
      id: TEST_TEAM_ID,
      name: 'Test Team',
      managerId: testUser.id,
      organizationId: testOrg.id,
    },
  });

  const testProject = await prisma.project.upsert({
    where: { id: TEST_PROJECT_ID },
    update: { name: 'Test Villas', slug: TEST_PROJECT_SLUG },
    create: {
      id: TEST_PROJECT_ID,
      name: 'Test Villas',
      slug: TEST_PROJECT_SLUG,
      organizationId: testOrg.id,
      address: 'Test Villas, Chennai, Tamil Nadu (test data)',
    },
  });

  await prisma.projectTeam.upsert({
    where: { projectId_teamId: { projectId: testProject.id, teamId: testTeam.id } },
    update: {},
    create: {
      projectId: testProject.id,
      teamId: testTeam.id,
      organizationId: testOrg.id,
    },
  });

  for (const p of [
    { id: TEST_PHASE_A, name: 'Phase A' },
    { id: TEST_PHASE_B, name: 'Phase B' },
  ]) {
    await prisma.phase.upsert({
      where: { id: p.id },
      update: { name: p.name },
      create: {
        id: p.id,
        projectId: testProject.id,
        organizationId: testOrg.id,
        name: p.name,
      },
    });
  }

  // Picker values, so the inventory form's facing/BHK selects are populated.
  for (const opt of [
    { type: 'FACING' as const, value: 'North' },
    { type: 'FACING' as const, value: 'South' },
    { type: 'FACING' as const, value: 'East' },
    { type: 'FACING' as const, value: 'West' },
    { type: 'BHK' as const, value: '2' },
    { type: 'BHK' as const, value: '3' },
    { type: 'BHK' as const, value: '4' },
  ]) {
    await prisma.projectOption.upsert({
      where: {
        projectId_type_value: {
          projectId: testProject.id,
          type: opt.type,
          value: opt.value,
        },
      },
      update: {},
      create: {
        projectId: testProject.id,
        organizationId: testOrg.id,
        type: opt.type,
        value: opt.value,
      },
    });
  }

  const unitDefs = [
    { phaseId: TEST_PHASE_A, unitNumber: 'T-101', bhk: 2, facing: 'North', sqft: 1050, price: 4_200_000 },
    { phaseId: TEST_PHASE_A, unitNumber: 'T-102', bhk: 3, facing: 'East', sqft: 1450, price: 5_800_000 },
    { phaseId: TEST_PHASE_A, unitNumber: 'T-103', bhk: 3, facing: 'South', sqft: 1480, price: 5_950_000 },
    { phaseId: TEST_PHASE_B, unitNumber: 'T-201', bhk: 3, facing: 'West', sqft: 1500, price: 6_100_000 },
    { phaseId: TEST_PHASE_B, unitNumber: 'T-202', bhk: 4, facing: 'North', sqft: 1900, price: 8_400_000 },
  ];
  for (const u of unitDefs) {
    await prisma.unit.upsert({
      where: { phaseId_unitNumber: { phaseId: u.phaseId, unitNumber: u.unitNumber } },
      update: {
        bhk: u.bhk,
        facing: u.facing,
        sqft: u.sqft,
        price: u.price.toFixed(2),
        // status intentionally omitted - derived from bookings (T-INV-SYNC).
      },
      create: {
        phaseId: u.phaseId,
        organizationId: testOrg.id,
        unitNumber: u.unitNumber,
        bhk: u.bhk,
        facing: u.facing,
        sqft: u.sqft,
        price: u.price.toFixed(2),
        status: 'AVAILABLE',
      },
    });
  }

  // Test leads - a spread of states so the inbox, board and filters all render
  // variety, owned by the test user's team (RLS scopes by owner/team/org).
  const leadDefs = [
    { id: TEST_LEAD_1, name: 'Test Priya', phone: '9876520001', state: 'NEW' as const, source: 'META_AD' as const },
    { id: TEST_LEAD_2, name: 'Test Arjun', phone: '9876520002', state: 'CONTACTED' as const, source: 'LANDING' as const },
    { id: TEST_LEAD_3, name: 'Test Kavya', phone: '9876520003', state: 'VISIT_SCHEDULED' as const, source: 'REFERRAL' as const },
    { id: TEST_LEAD_4, name: 'Test Rahul', phone: '9876520004', state: 'NEGOTIATION' as const, source: 'WALK_IN' as const },
    { id: TEST_LEAD_5, name: 'Test Meera', phone: '9876520005', state: 'BOOKING_INITIATED' as const, source: 'META_AD' as const },
    { id: TEST_LEAD_WON, name: 'Test Vikram', phone: '9876520006', state: 'WON' as const, source: 'REFERRAL' as const },
  ];
  for (const l of leadDefs) {
    await prisma.lead.upsert({
      where: { id: l.id },
      update: {
        name: l.name,
        state: l.state,
        source: l.source,
        projectId: testProject.id,
        ownerId: testUser.id,
        ownerType: 'MANAGER',
        teamId: testTeam.id,
        organizationId: testOrg.id,
      },
      create: {
        id: l.id,
        name: l.name,
        phone: l.phone,
        state: l.state,
        source: l.source,
        projectId: testProject.id,
        ownerId: testUser.id,
        ownerType: 'MANAGER',
        teamId: testTeam.id,
        organizationId: testOrg.id,
      },
    });
  }

  // ── 4. Test chat / notifications / bookings ─────────────────────────────
  // Clear this org's previous test rows first so a re-run does not append.
  const testLeadIds = leadDefs.map((l) => l.id);
  const clearMessages = await prisma.message.deleteMany({
    where: { leadId: { in: testLeadIds } },
  });
  const clearNotifs = await prisma.notification.deleteMany({
    where: { userId: testUser.id },
  });
  const clearBookings = await prisma.booking.deleteMany({
    where: { leadId: { in: testLeadIds } },
  });
  // eslint-disable-next-line no-console
  console.log(
    `[test-user] cleared previous test rows: ${clearMessages.count} messages, ${clearNotifs.count} notifications, ${clearBookings.count} bookings`,
  );

  const channelMix: Array<'IN_APP' | 'WHATSAPP'> = ['IN_APP', 'IN_APP', 'WHATSAPP'];
  for (let i = 0; i < leadDefs.length; i++) {
    const lead = leadDefs[i]!;
    const direction = i % 2 === 0 ? 'IN' : 'OUT';
    await prisma.message.create({
      data: {
        leadId: lead.id,
        organizationId: testOrg.id,
        userId: direction === 'OUT' ? testUser.id : null,
        direction,
        channel: channelMix[i % channelMix.length]!,
        body:
          direction === 'IN'
            ? `Hi, I'm interested in the project. Please share details.`
            : `Thanks for reaching out, ${lead.name.split(' ')[1]}. Sharing the brochure now.`,
      },
    });
  }

  await prisma.notification.createMany({
    data: [
      {
        userId: testUser.id,
        organizationId: testOrg.id,
        type: 'lead.assigned',
        title: `New lead: ${leadDefs[0]!.name}`,
        body: 'Assigned to you by the system. Review and respond within 24h.',
        leadId: leadDefs[0]!.id,
        read: false,
      },
      {
        userId: testUser.id,
        organizationId: testOrg.id,
        type: 'visit.scheduled',
        title: 'Visit confirmed for tomorrow',
        body: `${leadDefs[2]!.name} confirmed the site visit at 10:00 AM.`,
        leadId: leadDefs[2]!.id,
        read: false,
      },
      {
        userId: testUser.id,
        organizationId: testOrg.id,
        type: 'booking.requested',
        title: 'Token request received',
        body: `${leadDefs[4]!.name} requested a token for Unit T-102.`,
        leadId: leadDefs[4]!.id,
        read: true,
      },
    ],
  });

  // ── Test bookings ────────────────────────────────────────────────────────
  // These units are FIXED by number, not "the next available ones": the
  // notification above says "requested a token for Unit T-102", so the booking
  // has to BE on T-102 or the demo contradicts itself.
  //
  // The AMOUNT is taken from each unit's own `price`. It used to be hardcoded
  // (T-101 booked at 5,800,000 while its price is 4,200,000 - unit T-102's
  // price), i.e. every seeded booking disagreed with the unit it sat on. That is
  // precisely the mismatch T-BOOK-AMOUNT now REJECTS at the API
  // (bookings.service.ts derives the amount from the unit and refuses a
  // disagreeing client value), so a hardcoded amount here would seed data the
  // API itself would never accept - and would contradict the test dashboard's
  // own approval figures.
  const testBookingUnits = await prisma.unit.findMany({
    where: {
      organizationId: testOrg.id,
      unitNumber: { in: ['T-101', 'T-102'] },
    },
    select: { id: true, unitNumber: true, price: true },
    orderBy: { unitNumber: 'asc' },
  });
  const byUnitNumber = new Map(testBookingUnits.map((u) => [u.unitNumber, u]));
  const tokenUnit = byUnitNumber.get('T-101');
  const holdUnit = byUnitNumber.get('T-102');
  if (tokenUnit && holdUnit) {
    await prisma.booking.createMany({
      data: [
        {
          leadId: TEST_LEAD_WON,
          organizationId: testOrg.id,
          unitId: tokenUnit.id,
          userId: testUser.id,
          amount: tokenUnit.price,
          tokenAmount: '250000.00',
          status: 'TOKEN',
        },
        {
          leadId: TEST_LEAD_4,
          organizationId: testOrg.id,
          unitId: holdUnit.id,
          userId: testUser.id,
          amount: holdUnit.price,
          tokenAmount: null,
          status: 'HOLD' as const,
        },
      ],
    });
  } else {
    // eslint-disable-next-line no-console
    console.warn('[test-user] skipped test bookings: T-101/T-102 not found in the test org');
  }

  // ── Test visits ─────────────────────────────────────────────────────────────
  // Fixed cuid ids so re-runs are idempotent and the e2e specs can target them
  // by stable id.
  const TEST_VISIT_UPCOMING_1 = 'test-visit-upcoming-1';
  const TEST_VISIT_PAST_1 = 'test-visit-past-1';

  // Make sure the exec user exists (test user who attends visits).
  const testExec = await prisma.user.upsert({
    where: { email: TEST_EMAIL },
    update: {},
    create: {
      email: TEST_EMAIL,
      name: TEST_NAME,
      role: 'OWNER',
      organizationId: testOrg.id,
      emailVerified: true,
      mustChangePassword: false,
    },
  });

  const visitDefs = [
    // Upcoming visit on a live lead (Meera, BOOKING_INITIATED) — should render
    // in the default (upcoming-only) view.
    {
      id: TEST_VISIT_UPCOMING_1,
      leadId: TEST_LEAD_5, // Test Meera
      organizationId: testOrg.id,
      userId: testExec.id,
      // Fixed date in the future so it renders as upcoming
      scheduledFor: new Date('2026-12-31T11:00:00.000Z'),
      status: 'SCHEDULED' as const,
      outcome: null,
      notes: 'Seeded upcoming visit for testing',
    },
    // Past visit on a WON lead (Vikram, WON) — should NOT render in the default
    // view, but SHOULD render when "Show past visits" is toggled on.
    {
      id: TEST_VISIT_PAST_1,
      leadId: TEST_LEAD_WON, // Test Vikram (WON)
      organizationId: testOrg.id,
      userId: testExec.id,
      // Fixed date in the past
      scheduledFor: new Date('2026-01-15T10:00:00.000Z'),
      status: 'SCHEDULED' as const,
      outcome: null,
      notes: 'Seeded past visit on WON lead for testing',
    },
  ];
  for (const v of visitDefs) {
    await prisma.siteVisit.upsert({
      where: { id: v.id },
      update: {
        leadId: v.leadId,
        organizationId: v.organizationId,
        userId: v.userId,
        scheduledFor: v.scheduledFor,
        status: v.status,
        outcome: v.outcome,
        notes: v.notes,
      },
      create: v,
    });
  }

  // eslint-disable-next-line no-console
  console.log(
    `[test-user] org "${testOrg.name}" (${testOrg.slug}, ${testOrg.id}) ready`,
  );
  // eslint-disable-next-line no-console
  console.log(
    `[test-user] user ${TEST_EMAIL} (OWNER) password "${TEST_PASSWORD}"`,
  );
  // eslint-disable-next-line no-console
  console.log(
    `[test-user] seeded ${unitDefs.length} units, ${leadDefs.length} leads, ${leadDefs.length} chat messages, 3 notifications`,
  );
  // eslint-disable-next-line no-console
  console.log(
    `[test-user] sign in at /${TEST_ORG_SLUG}/projects/${TEST_PROJECT_SLUG}`,
  );

  await prisma.$disconnect();
}

main().catch((err) => {
  // eslint-disable-next-line no-console
  console.error('[test-user] failed:', err);
  process.exit(1);
});