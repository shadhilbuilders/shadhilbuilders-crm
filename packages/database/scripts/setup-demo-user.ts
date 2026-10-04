// One-off: create the DEMO organization + an OWNER-role demo user inside it,
// with its own isolated demo data.
//
// Usage:
//   cd packages/database && pnpm exec tsx --env-file=../../.env scripts/setup-demo-user.ts
//
// What it does (all of it scoped to DEMO_ORG_ID - the real org is untouched):
//   1. Upserts the demo Organization row (its own tenant).
//   2. Upserts an OWNER-role user demo@shadhilbuilders.in (password demo123)
//      INSIDE that org, plus its credential Account.
//   3. Upserts a demo team + project + phases + units + leads, so the demo
//      org is not an empty shell.
//   4. Seeds chat / notifications / bookings for the demo lists to render.
//
// WHY A SEPARATE ORG, AND WHY THAT IS THE ONLY OPTION FOR OWNER:
//   `User.organizationId` is single-valued (one org per user; there is no
//   membership table), and the DB enforces
//     one_owner_per_org  UNIQUE ("organizationId") WHERE role = 'OWNER'
//   i.e. EXACTLY ONE OWNER PER ORG. A second OWNER therefore cannot coexist
//   with the bootstrap org's owner - a different org is the only legal shape.
//
// WHY THE PREVIOUS VERSION WAS DANGEROUS (removed here):
//   It ran `lead.updateMany({ where: { id: { not: { startsWith: 'test-' } } } })`
//   - reassigning ~120 REAL leads from the bootstrap org to the demo user and
//   the demo team. With the demo user in its own org that is both wrong (it
//   would steal another tenant's rows) and pointless (RLS is org-scoped, so the
//   demo user could not read them anyway). The demo org now gets its OWN leads.
//
// RLS note: this script connects as the migration/owner role, so RLS is
// bypassed for these writes. That is deliberate - it is a provisioning script,
// not request-path code.
//
// Idempotent: every write is an upsert or a scoped delete-then-insert, so
// re-running resets the demo data without duplicating rows.
//
// DO NOT commit the demo user to prod: this is a local demo helper.
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
const DEMO_NAME = 'Demo Owner';

// ── Demo tenant identity (fixed cuid2 ids, so re-runs stay idempotent) ──────
const DEMO_ORG_ID = 'j6lic67mwuop8ur7epjylexz';
const DEMO_ORG_NAME = 'Shadhil Demo';
const DEMO_ORG_SLUG = 'demo';
const DEMO_PROJECT_ID = 'tnvhme2fxh92kxrrjmrvokip';
const DEMO_PROJECT_SLUG = 'demo-villas';
const DEMO_PHASE_A = 'yennyts583urar4ztg3sa82p';
const DEMO_PHASE_B = 'n5aak5hnpetukvoddg7gofb8';
const DEMO_TEAM_ID = 'md4u15ycnbvdx9483hcp9tjy';
const DEMO_LEAD_1 = 'hki6tw8qj15qpw55ol9rmc2f';
const DEMO_LEAD_2 = 'ds531k56sxtfhiafzc9x4ont';
const DEMO_LEAD_3 = 'njbo3jgz1jtw4d5mahuu896q';
const DEMO_LEAD_4 = 'vmrm6cadajiv36z7j596zplo';
const DEMO_LEAD_5 = 'ruz788er1ilinxdazl8lq74m';
const DEMO_LEAD_WON = 'kavsu6r8uxqi6rnninmxwqi5';

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
  // ── 1. The demo organization (its own tenant) ───────────────────────────
  const demoOrg = await prisma.organization.upsert({
    where: { id: DEMO_ORG_ID },
    update: { name: DEMO_ORG_NAME, slug: DEMO_ORG_SLUG },
    create: { id: DEMO_ORG_ID, name: DEMO_ORG_NAME, slug: DEMO_ORG_SLUG },
  });

  // ── 2. The demo user: OWNER of the demo org ─────────────────────────────
  //
  // mustChangePassword = FALSE even though the OWNER is the one role the gate
  // applies to (see packages/database/src/seed.ts). Rationale: this is a
  // throwaway local demo account whose password is published in this file and
  // in the e2e specs, so gating it would only block the demo path - and the
  // gate's purpose (protect a privileged account with an unknown password)
  // does not apply. The real org's OWNER stays gated.
  const demoUser = await prisma.user.upsert({
    // T-EMAIL-PER-ORG: `email` alone is no longer a unique key.
    where: { email_organizationId: { email: DEMO_EMAIL, organizationId: demoOrg.id } },
    update: {
      name: DEMO_NAME,
      role: 'OWNER',
      organizationId: demoOrg.id,
      mustChangePassword: false,
    },
    create: {
      email: DEMO_EMAIL,
      name: DEMO_NAME,
      role: 'OWNER',
      organizationId: demoOrg.id,
      emailVerified: true,
      mustChangePassword: false,
    },
  });

  // Credential Account (better-auth sign-in contract: accountId === user.id).
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

  // ── 3. Demo team + project + inventory + leads (all inside the demo org) ─
  const demoTteam = await prisma.team.upsert({
    where: { id: DEMO_TEAM_ID },
    update: { name: 'Demo Team', managerId: demoUser.id },
    create: {
      id: DEMO_TEAM_ID,
      name: 'Demo Team',
      managerId: demoUser.id,
      organizationId: demoOrg.id,
    },
  });

  const demoProject = await prisma.project.upsert({
    where: { id: DEMO_PROJECT_ID },
    update: { name: 'Demo Villas', slug: DEMO_PROJECT_SLUG },
    create: {
      id: DEMO_PROJECT_ID,
      name: 'Demo Villas',
      slug: DEMO_PROJECT_SLUG,
      organizationId: demoOrg.id,
      address: 'Demo Villas, Chennai, Tamil Nadu (demo data)',
    },
  });

  await prisma.projectTeam.upsert({
    where: { projectId_teamId: { projectId: demoProject.id, teamId: demoTteam.id } },
    update: {},
    create: {
      projectId: demoProject.id,
      teamId: demoTteam.id,
      organizationId: demoOrg.id,
    },
  });

  for (const p of [
    { id: DEMO_PHASE_A, name: 'Phase A' },
    { id: DEMO_PHASE_B, name: 'Phase B' },
  ]) {
    await prisma.phase.upsert({
      where: { id: p.id },
      update: { name: p.name },
      create: {
        id: p.id,
        projectId: demoProject.id,
        organizationId: demoOrg.id,
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
  ]) {
    await prisma.projectOption.upsert({
      where: {
        projectId_type_value: {
          projectId: demoProject.id,
          type: opt.type,
          value: opt.value,
        },
      },
      update: {},
      create: {
        projectId: demoProject.id,
        organizationId: demoOrg.id,
        type: opt.type,
        value: opt.value,
      },
    });
  }

  const unitDefs = [
    { phaseId: DEMO_PHASE_A, unitNumber: 'D-101', bhk: 2, facing: 'North', sqft: 1050, price: 4_200_000 },
    { phaseId: DEMO_PHASE_A, unitNumber: 'D-102', bhk: 3, facing: 'East', sqft: 1450, price: 5_800_000 },
    { phaseId: DEMO_PHASE_A, unitNumber: 'D-103', bhk: 3, facing: 'South', sqft: 1480, price: 5_950_000 },
    { phaseId: DEMO_PHASE_B, unitNumber: 'D-201', bhk: 3, facing: 'West', sqft: 1500, price: 6_100_000 },
    { phaseId: DEMO_PHASE_B, unitNumber: 'D-202', bhk: 4, facing: 'North', sqft: 1900, price: 8_400_000 },
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
        organizationId: demoOrg.id,
        unitNumber: u.unitNumber,
        bhk: u.bhk,
        facing: u.facing,
        sqft: u.sqft,
        price: u.price.toFixed(2),
        status: 'AVAILABLE',
      },
    });
  }

  // Demo leads - a spread of states so the inbox, board and filters all render
  // variety, owned by the demo user's team (RLS scopes by owner/team/org).
  // 12 leads = 2 pages (page size 10) so pagination tests can assert page 2.
  const leadDefs = [
    { id: DEMO_LEAD_1, name: 'Demo Priya', phone: '9876510001', state: 'NEW' as const, source: 'META_AD' as const },
    { id: DEMO_LEAD_2, name: 'Demo Arjun', phone: '9876510002', state: 'CONTACTED' as const, source: 'LANDING' as const },
    { id: DEMO_LEAD_3, name: 'Demo Kavya', phone: '9876510003', state: 'VISIT_SCHEDULED' as const, source: 'REFERRAL' as const },
    { id: DEMO_LEAD_4, name: 'Demo Rahul', phone: '9876510004', state: 'NEGOTIATION' as const, source: 'WALK_IN' as const },
    { id: DEMO_LEAD_5, name: 'Demo Meera', phone: '9876510005', state: 'BOOKING_INITIATED' as const, source: 'META_AD' as const },
    { id: DEMO_LEAD_WON, name: 'Demo Vikram', phone: '9876510006', state: 'WON' as const, source: 'REFERRAL' as const },
    // Additional leads for pagination (page size 10 → 12 total = 2 pages)
    { id: 'hki6tw8qj15qpw55ol9rmc30', name: 'Demo Sneha', phone: '9876510007', state: 'NEW' as const, source: 'LANDING' as const },
    { id: 'ds531k56sxtfhiafzc9x4on0', name: 'Demo Rohan', phone: '9876510008', state: 'CONTACTED' as const, source: 'REFERRAL' as const },
    { id: 'njbo3jgz1jtw4d5mahuu8961', name: 'Demo Anjali', phone: '9876510009', state: 'VISIT_SCHEDULED' as const, source: 'META_AD' as const },
    { id: 'vmrm6cadajiv36z7j596zpl1', name: 'Demo Karan', phone: '9876510010', state: 'NEGOTIATION' as const, source: 'WALK_IN' as const },
    { id: 'ruj788er1ilinxdazl8lq74n', name: 'Demo Deepa', phone: '9876510011', state: 'BOOKING_INITIATED' as const, source: 'LANDING' as const },
    { id: 'kavsu6r8uxqi6rnninmxwqi6', name: 'Demo Amit', phone: '9876510012', state: 'LOST' as const, source: 'REFERRAL' as const },
  ];
  for (const l of leadDefs) {
    await prisma.lead.upsert({
      where: { id: l.id },
      update: {
        name: l.name,
        state: l.state,
        source: l.source,
        projectId: demoProject.id,
        ownerId: demoUser.id,
        ownerType: 'MANAGER',
        teamId: demoTteam.id,
        organizationId: demoOrg.id,
      },
      create: {
        id: l.id,
        name: l.name,
        phone: l.phone,
        state: l.state,
        source: l.source,
        projectId: demoProject.id,
        ownerId: demoUser.id,
        ownerType: 'MANAGER',
        teamId: demoTteam.id,
        organizationId: demoOrg.id,
      },
    });
  }

  // ── 4. Demo chat / notifications / bookings ─────────────────────────────
  // Clear this org's previous demo rows first so a re-run does not append.
  const demoLeadIds = leadDefs.map((l) => l.id);
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
    `[demo-user] cleared previous demo rows: ${clearMessages.count} messages, ${clearNotifs.count} notifications, ${clearBookings.count} bookings`,
  );

  const channelMix: Array<'IN_APP' | 'WHATSAPP'> = ['IN_APP', 'IN_APP', 'WHATSAPP'];
  for (let i = 0; i < leadDefs.length; i++) {
    const lead = leadDefs[i]!;
    const direction = i % 2 === 0 ? 'IN' : 'OUT';
    await prisma.message.create({
      data: {
        leadId: lead.id,
        organizationId: demoOrg.id,
        userId: direction === 'OUT' ? demoUser.id : null,
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
        userId: demoUser.id,
        organizationId: demoOrg.id,
        type: 'lead.assigned',
        title: `New lead: ${leadDefs[0]!.name}`,
        body: 'Assigned to you by the system. Review and respond within 24h.',
        leadId: leadDefs[0]!.id,
        read: false,
      },
      {
        userId: demoUser.id,
        organizationId: demoOrg.id,
        type: 'visit.scheduled',
        title: 'Visit confirmed for tomorrow',
        body: `${leadDefs[2]!.name} confirmed the site visit at 10:00 AM.`,
        leadId: leadDefs[2]!.id,
        read: false,
      },
      {
        userId: demoUser.id,
        organizationId: demoOrg.id,
        type: 'booking.requested',
        title: 'Token request received',
        body: `${leadDefs[4]!.name} requested a token for Unit D-102.`,
        leadId: leadDefs[4]!.id,
        read: true,
      },
    ],
  });

  // ── Demo bookings ────────────────────────────────────────────────────────
  // These units are FIXED by number, not "the next available ones": the
  // notification above says "requested a token for Unit D-102", so the booking
  // has to BE on D-102 or the demo contradicts itself. (The earlier version took
  // `status: AVAILABLE` ordered by unit number, which silently changed which
  // units got booked whenever an unrelated booking moved a status.)
  //
  // The AMOUNT is taken from each unit's own `price`. It used to be hardcoded
  // (D-101 booked at 5,800,000 while its price is 4,200,000 - unit D-102's
  // price), i.e. every seeded booking disagreed with the unit it sat on. That is
  // precisely the mismatch T-BOOK-AMOUNT now REJECTS at the API
  // (bookings.service.ts derives the amount from the unit and refuses a
  // disagreeing client value), so a hardcoded amount here would seed data the
  // API itself would never accept - and would contradict the demo dashboard's
  // own approval figures.
  const demoBookingUnits = await prisma.unit.findMany({
    where: {
      organizationId: demoOrg.id,
      unitNumber: { in: ['D-101', 'D-102'] },
    },
    select: { id: true, unitNumber: true, price: true },
    orderBy: { unitNumber: 'asc' },
  });
  const byUnitNumber = new Map(demoBookingUnits.map((u) => [u.unitNumber, u]));
  const tokenUnit = byUnitNumber.get('D-101');
  const holdUnit = byUnitNumber.get('D-102');
  if (tokenUnit && holdUnit) {
    await prisma.booking.createMany({
      data: [
        {
          leadId: DEMO_LEAD_WON,
          organizationId: demoOrg.id,
          unitId: tokenUnit.id,
          userId: demoUser.id,
          amount: tokenUnit.price,
          tokenAmount: '250000.00',
          status: 'TOKEN',
        },
        {
          leadId: DEMO_LEAD_4,
          organizationId: demoOrg.id,
          unitId: holdUnit.id,
          userId: demoUser.id,
          amount: holdUnit.price,
          tokenAmount: null,
          status: 'HOLD' as const,
        },
      ],
    });
  } else {
    // eslint-disable-next-line no-console
    console.warn('[demo-user] skipped demo bookings: D-101/D-102 not found in the demo org');
  }

  // ── Demo visits ─────────────────────────────────────────────────────────────
  // Fixed cuid ids so re-runs are idempotent and the e2e specs can target them
  // by stable id (visits-show-past-toggle.spec.ts expects these exact ids).
  const DEMO_VISIT_UPCOMING_1 = 'demo-visit-upcoming-1';
  const DEMO_VISIT_PAST_1 = 'demo-visit-past-1';

  // Make sure the exec user exists (demo user who attends visits).
  const demoExec = await prisma.user.upsert({
    // T-EMAIL-PER-ORG: `email` alone is no longer a unique key.
    where: {
      email_organizationId: { email: 'demo@shadhilbuilders.in', organizationId: demoOrg.id },
    },
    update: {},
    create: {
      email: 'demo@shadhilbuilders.in',
      name: 'Demo Owner',
      role: 'OWNER',
      organizationId: demoOrg.id,
      emailVerified: true,
      mustChangePassword: false,
    },
  });

  const visitDefs = [
    // Upcoming visit on a live lead (Meera, BOOKING_INITIATED) — should render
    // in the default (upcoming-only) view. Must be in the CURRENT month of
    // selectedDate (which is the week's Monday, Sep 28 → September) so the
    // agenda view's month filter includes it.
    // FIXED: use explicit September 2026 dates (the "current" month in the demo
    // fixture) instead of Date.now() which uses the real current date.
    {
      id: DEMO_VISIT_UPCOMING_1,
      leadId: DEMO_LEAD_5, // Demo Meera
      organizationId: demoOrg.id,
      userId: demoExec.id,
      // Thursday of the demo week (Sep 30, 2026) at 11:00 — inside September
      scheduledFor: new Date('2026-09-30T11:00:00.000Z'),
      status: 'SCHEDULED' as const,
      outcome: null,
      notes: 'Seeded upcoming visit for e2e',
    },
    // Past visit on a WON lead (Vikram, WON) — should NOT render in the default
    // view, but SHOULD render when "Show past visits" is toggled on.
    // Must be within the current month (September) so the agenda view includes it.
    {
      id: DEMO_VISIT_PAST_1,
      leadId: DEMO_LEAD_WON, // Demo Vikram (WON)
      organizationId: demoOrg.id,
      userId: demoExec.id,
      // Wednesday of the demo week (Sep 28, 2026) at 10:00 — inside September
      scheduledFor: new Date('2026-09-28T10:00:00.000Z'),
      status: 'SCHEDULED' as const,
      outcome: null,
      notes: 'Seeded past visit on WON lead for e2e',
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
    `[demo-user] org "${demoOrg.name}" (${demoOrg.slug}, ${demoOrg.id}) ready`,
  );
  // eslint-disable-next-line no-console
  console.log(
    `[demo-user] user ${DEMO_EMAIL} (OWNER) password "${DEMO_PASSWORD}"`,
  );
  // eslint-disable-next-line no-console
  console.log(
    `[demo-user] seeded ${unitDefs.length} units, ${leadDefs.length} leads, ${leadDefs.length} chat messages, 3 notifications`,
  );
  // eslint-disable-next-line no-console
  console.log(
    `[demo-user] sign in at /${DEMO_ORG_SLUG}/projects/${DEMO_PROJECT_SLUG}`,
  );

  await prisma.$disconnect();
}

main().catch((err) => {
  // eslint-disable-next-line no-console
  console.error('[demo-user] failed:', err);
  process.exit(1);
});
