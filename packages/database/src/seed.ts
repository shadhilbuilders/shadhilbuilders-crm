import { randomBytes, scryptSync } from 'node:crypto';
import { PrismaClient } from './generated/prisma/client';
import { PrismaPg } from '@prisma/adapter-pg';

// ────────────────────────────────────────────────────────────────────────────
// Seed project identities (T-PROJID-CUID2, 2026-09-08).
//
// Project.id is a real cuid2 - the same shape the app generates at runtime
// via @paralleldrive/cuid2 (schema.prisma `@default(cuid())` is Prisma's
// cuid v1; the runtime DTOs + URL segment pin cuid2 via z.cuid2()). The seed
// uses a FIXED, pre-generated cuid2 per project so re-runs are idempotent
// (upsert by stable id), while `slug` stays the human-readable URL-safe form.
// These were generated once (`createId()` from @paralleldrive/cuid2) and
// validated against z.cuid2() - do not hand-edit.
// ────────────────────────────────────────────────────────────────────────────
// Shadhil Builders CRM - bootstrap seed.
// AR-8/B4b (2026-08-31): credentials are created in the EXACT shape better-auth
// 1.7 expects at sign-in (dist/api/routes/sign-in.mjs:320):
//   account.accountId === user.id  AND  account.issuer === 'local:credential'
// Passwords use @better-auth/utils scrypt params (N=16384, r=16, p=1, dkLen=64,
// NFKC-normalized) stored as "salt:key".
// Placeholder fallbacks per plan §17 Input #5 - rotate on first login (T-S).
// ────────────────────────────────────────────────────────────────────────────

// The seed needs the OWNER database role (migration privileges,
// bypass-RLS) - `shadhil` via DIRECT_DATABASE_URL - not the
// non-owner `shadhil_app` role used at runtime via DATABASE_URL
// + PgBouncer. Construct a local PrismaClient here rather than
// importing the shared `prisma` from `./index` (which is bound
// to DATABASE_URL so the API runtime keeps RLS enforced).
// Without this, the seed hits `42501 permission denied for
// schema public` on the very first upsert.
const prisma: PrismaClient = new PrismaClient({
  adapter: new PrismaPg({
    connectionString: process.env.DIRECT_DATABASE_URL ?? process.env.DATABASE_URL,
  }),
});

function hashPassword(password: string): string {
  const salt = randomBytes(16).toString('hex');
  const normalized = password.normalize('NFKC');
  const hash = scryptSync(normalized, salt, 64, { N: 16384, r: 16, p: 1, maxmem: 128 * 16384 * 16 * 2 }).toString('hex');
  return `${salt}:${hash}`;
}

interface SeedUser {
  email: string;
  name: string;
  password: string;
}

function readSeedUser(
  prefix: 'OWNER' | 'ADMIN' | 'MANAGER' | 'TELECALLER' | 'SALES_EXEC',
): SeedUser {
  // Plan §17 Input #5: fall back to documented placeholder users so a fresh
  // clone can seed before the client roster arrives. Placeholders MUST be
  // rotated on first login (plan task T-S). Round 20/21: the seeded
  // owner@shadhilbuilders.in account IS the single OWNER (exactly one
  // exists - partial unique index one_owner). Round 22: a second
  // ADMIN placeholder is seeded so the OWNER isn't the only account
  // that can create managers + admins out of the box.
  //   OWNER       → owner@shadhilbuilders.in
  //   ADMIN       → admin@shadhilbuilders.in
  //   MANAGER     → manager@shadhilbuilders.in
  //   TELECALLER  → telecaller@shadhilbuilders.in
  //   SALES_EXEC  → sales_exec@shadhilbuilders.in
  // Each email mirrors the role name - Round 23 swap from
  // admin@/admin2@ → owner@/admin@.
  const FALLBACK_EMAIL: Record<typeof prefix, string> = {
    OWNER: 'owner@shadhilbuilders.in',
    ADMIN: 'admin@shadhilbuilders.in',
    MANAGER: 'manager@shadhilbuilders.in',
    TELECALLER: 'telecaller@shadhilbuilders.in',
    SALES_EXEC: 'sales_exec@shadhilbuilders.in',
  };
  const FALLBACK_NAME: Record<typeof prefix, string> = {
    OWNER: 'Owner',
    ADMIN: 'Admin',
    MANAGER: 'Manager',
    TELECALLER: 'Telecaller',
    SALES_EXEC: 'Sales Exec',
  };
  const FALLBACK_PASSWORD: Record<typeof prefix, string> = {
    OWNER: 'owner_placeholder_pw',
    ADMIN: 'admin_placeholder_pw',
    MANAGER: 'manager_placeholder_pw',
    TELECALLER: 'telecaller_placeholder_pw',
    SALES_EXEC: 'sales_exec_placeholder_pw',
  };

  const email = process.env[`SEED_${prefix}_EMAIL`] ?? FALLBACK_EMAIL[prefix];
  const name = process.env[`SEED_${prefix}_NAME`] ?? `${FALLBACK_NAME[prefix]} (placeholder)`;
  const password = process.env[`SEED_${prefix}_PASSWORD`] ?? FALLBACK_PASSWORD[prefix];

  if (!email || !name || !password) {
    throw new Error(
      `Missing SEED_${prefix}_EMAIL / SEED_${prefix}_NAME / SEED_${prefix}_PASSWORD in env`,
    );
  }

  return { email, name, password };
}

type Role = 'OWNER' | 'ADMIN' | 'MANAGER' | 'TELECALLER' | 'SALES_EXEC';

// Fixed cuid2 ids for the seeded projects. Generated once with
// `createId()` from @paralleldrive/cuid2 and validated against
// z.cuid2() - stable so the seed's upsert-by-id stays idempotent.
export const SEED_PROJECT_METRO_ID = 'oe6g1xkagiisnn4oeefpdyhk';
export const SEED_PROJECT_SKYLINE_ID = 'u5ou76r0nsnximp7kwljgrgv';
export const SEED_PROJECT_LAKEVIEW_ID = 'o0n22ikcbvecgkqqa6rc5aqt';

// Fixed cuid2 ids for the seeded demo team + manager-assignment rules.
// Generated once with createId() and validated against z.cuid2() - stable
// so the seed's upsert-by-id stays idempotent (mirrors the project ids).
export const SEED_TEAM_ID = 'vfm3sd2qgekdrvmc2tm8h4me';
export const SEED_RULE_IDS = [
  'e55ymkfrqjnjhwnokgoyvh5l',
  'qq7ex8m4f9acollfjd6b70qq',
  'mjsclqqbj6yo651icus0kw2y',
  'ikvpgy4i289xd2o1e4m4brcb',
];

// Fixed cuid2 ids for the 5 seed user accounts (owner/admin/manager/
// telecaller/sales_exec). Generated once with createId() and validated
// against z.cuid2() - stable so the upsert-by-id stays idempotent and
// every seeded account carries a real cuid2 (not Prisma's c-prefixed
// cuid1 default). The Account credential row keys off User.id, so it
// follows automatically.
export const SEED_OWNER_ID = 'oet70k7svsjrta4480fnyenx';
// T-ORG (2026-09-11): SEED_ORG_ID must be a VALID cuid2 (z.cuid2). The
// bootstrap org drives every org_* RLS policy comparison, and API DTOs /
// issueJwt validate organizationId as cuid2 - so the org id can no longer be
// the plaintext 'ceid01lpfe1esm8jwsxid41k28' (which failed z.cuid2()).
export const SEED_ORG_ID = 'ceid01lpfe1esm8jwsxid41k28';
export const SEED_ADMIN_ID = 'b2djb8x7jpk8702v8o83rl6s';
export const SEED_MANAGER_ID = 'jhl2a7l1x7d7bes0jf7ktkhw';
export const SEED_TELECALLER_ID = 'bscdnl31d81fmwioebupnmwr';
export const SEED_SALES_EXEC_ID = 'b7ucheo93987ss7oldrzlazd';

/**
 * Upsert user, then upsert the credential account keyed on user.id (the
 * better-auth 1.7 sign-in contract: sign-in.mjs requires
 * account.accountId === user.id && account.issuer === 'local:credential').
 * Password is refreshed on every seed run so re-seeding after a password
 * rotation works.
 */
async function upsertUser(
  id: string,
  user: SeedUser,
  role: Role,
  teamId?: string,
) {
  const dbUser = await prisma.user.upsert({
    where: { id },
    update: { role },
    create: {
      id,
      email: user.email,
      name: user.name,
      role,
      organizationId: SEED_ORG_ID,
      emailVerified: true,
      // Placeholder-password gate (T-S hardening, 2026-09-04, re-scoped
      // 2026-09-15): ONLY the OWNER is forced through /change-password on
      // first sign-in. Every other role starts ungated.
      //
      // OWNER-only because it is the single highest-privilege account and the
      // only one that cannot be created through the API
      // (`assertCanCreateRole` rejects an OWNER target - "exactly one exists
      // via seed") nor reassigned into, so this seed is its sole writer.
      // Gating it costs one rotation and protects the account that can do
      // everything.
      //
      // Set on CREATE only, matching the previous behaviour: a re-seed must not
      // re-arm the gate after the OWNER has legitimately rotated their
      // password (which flips this to false).
      mustChangePassword: role === 'OWNER',
    },
  });

  await prisma.account.upsert({
    where: {
      providerId_accountId: { providerId: 'credential', accountId: dbUser.id },
    },
    update: { password: hashPassword(user.password), issuer: 'local:credential' },
    create: {
      accountId: dbUser.id,
      providerId: 'credential',
      issuer: 'local:credential',
      userId: dbUser.id,
      password: hashPassword(user.password),
    },
  });

  // T-TEAM-AUTHORITATIVE (2026-09-13): TeamMember is the sole
  // "who's on this team" record. A MANAGER's leadership is
  // Team.managerId - they don't need a TeamMember row for a team they
  // lead, so this only fires for ordinary (non-manager) team members.
  if (teamId && role !== 'MANAGER') {
    await prisma.teamMember.upsert({
      where: { userId_teamId: { userId: dbUser.id, teamId } },
      update: {},
      create: { userId: dbUser.id, teamId, organizationId: SEED_ORG_ID },
    });
  }

  return dbUser;
}

async function main() {
  // Disable RLS for seed - the bootstrap admin needs to bypass policies until
  // the database is fully populated. In production, run migrations with the
  // DIRECT_DATABASE_URL (owner role), which bypasses RLS by default.
  await prisma.$executeRawUnsafe(`SET LOCAL row_security = off`).catch(() => {
    // session-level fallback if SET LOCAL is not allowed (no active tx)
    return prisma.$executeRawUnsafe(`SET row_security = off`);
  });

  const owner = readSeedUser('OWNER');
  const admin = readSeedUser('ADMIN');
  const manager = readSeedUser('MANAGER');
  const telecaller = readSeedUser('TELECALLER');
  const salesExec = readSeedUser('SALES_EXEC');

  // ── Manager first so we have a teamId ────────────────────────────────────
  const managerUser = await upsertUser(SEED_MANAGER_ID, manager, 'MANAGER');

  // ── Team owned by the manager ────────────────────────────────────────────
  const team = await prisma.team.upsert({
    where: { id: SEED_TEAM_ID },
    update: { managerId: managerUser.id, name: `${manager.name}'s Team` },
    create: {
      id: SEED_TEAM_ID,
      name: `${manager.name}'s Team`,
      managerId: managerUser.id,
      organizationId: SEED_ORG_ID,
    },
  });

  // Re-upsert so a re-run refreshes the manager row after the team exists.
  // Leadership is Team.managerId (set on the team upsert above), not a
  // TeamMember row.
  await upsertUser(SEED_MANAGER_ID, manager, 'MANAGER');

  // ── Owner (no team), Admin (no team), telecaller + sales exec (team members)
  await upsertUser(SEED_OWNER_ID, owner, 'OWNER');
  await upsertUser(SEED_ADMIN_ID, admin, 'ADMIN');
  const telecallerUser = await upsertUser(SEED_TELECALLER_ID, telecaller, 'TELECALLER', team.id);
  await upsertUser(SEED_SALES_EXEC_ID, salesExec, 'SALES_EXEC', team.id);

  // ── Demo projects - the REAL Project registry (T-ProjectSwitch) ─────────
  // Phase 2 of real project switching: the sidebar switcher reads
  // GET /api/projects (the Project table), NOT the Team table. Metro
  // Heights is created FIRST so createdAt-ordering makes it the default
  // active project. Lead.projectId points at these rows; demo leads below
  // are attached to Metro Heights.
  const metroHeights = await prisma.project.upsert({
    where: { id: SEED_PROJECT_METRO_ID },
    update: {
      name: 'Shadhil Metro Heights',
      slug: 'shadhil-metro-heights',
      address: 'Metro Heights, Chennai, Tamil Nadu (placeholder address)',
    },
    create: {
      id: SEED_PROJECT_METRO_ID,
      name: 'Shadhil Metro Heights',
      slug: 'shadhil-metro-heights',
      organizationId: SEED_ORG_ID,
      address: 'Metro Heights, Chennai, Tamil Nadu (placeholder address)',
      // RERA/CMDA numbers are still open inputs (sign-off doc §Inputs);
      // left null until the client supplies the certificate values.
    },
  });
  const upcomingProjects = [
    {
      id: SEED_PROJECT_SKYLINE_ID,
      name: 'Shadhil Skyline Towers',
      slug: 'shadhil-skyline-towers',
    },
    {
      id: SEED_PROJECT_LAKEVIEW_ID,
      name: 'Shadhil Lakeview Residences',
      slug: 'shadhil-lakeview-residences',
    },
  ];
  for (const p of upcomingProjects) {
    await prisma.project.upsert({
      where: { id: p.id },
      update: { name: p.name, slug: p.slug },
      create: {
        id: p.id,
        name: p.name,
        slug: p.slug,
        organizationId: SEED_ORG_ID,
        address: 'Upcoming project (placeholder address)',
      },
    });
  }
  // T-ProjectSwitch cleanup: the sidebar-07 iteration seeded the two
  // upcoming projects as FAKE TEAMS (Team-as-registry hack). Remove them
  // now that the Project table is the registry. deleteMany is idempotent
  // (0 rows on re-runs) and the Team rows have no leads pointing at them.
  await prisma.team.deleteMany({
    where: { id: { in: ['seed-project-skyline', 'seed-project-lakeview'] } },
  });
  // Staff the seed team onto every demo project so GET /api/projects
  // (ProjectTeam-scoped for managers) returns the registry.
  for (const projectId of [
    SEED_PROJECT_METRO_ID,
    SEED_PROJECT_SKYLINE_ID,
    SEED_PROJECT_LAKEVIEW_ID,
  ]) {
    await prisma.projectTeam.upsert({
      where: { projectId_teamId: { projectId, teamId: team.id } },
      update: {},
      create: {
        projectId,
        teamId: team.id,
        organizationId: SEED_ORG_ID,
      },
    });
  }
  // eslint-disable-next-line no-console
  console.log(`[seed] ✓ project registry: ${metroHeights.name} (default) + 2 upcoming`);
  // eslint-disable-next-line no-console
  console.log('[seed] ✓ legacy fake project-teams removed');

  // ── Demo inventory - phases + units for Metro Heights (DESIGN.md module 4) ─
  // Realistic villa inventory so the grid renders live. Phases use FIXED,
  // pre-generated cuid2 ids (T-PROJID-CUID2 pattern - the same shape the app
  // generates at runtime; CreateUnitDtoSchema requires phaseId to be a cuid).
  // Units are upserted by the (phaseId, unitNumber) unique key. Statuses are
  // mixed so the AVAILABLE/HOLD/TOKEN/SOLD filters all show data.
  //
  // Legacy cleanup: the first inventory seed used readable `seed-phase-metro-*`
  // ids which are NOT valid cuids - a create-unit form would reject them with
  // "invalid cuid". Remove those rows (and their units) so re-seeding is
  // idempotent and no non-cuid phase id survives.
  await prisma.unit.deleteMany({
    where: { phaseId: { startsWith: 'seed-phase-metro-' } },
  });
  await prisma.phase.deleteMany({
    where: { id: { startsWith: 'seed-phase-metro-' } },
  });

  const phaseDefs = [
    { id: 'zpn4utpch0ncq4esh46cl4ug', name: 'Phase A' },
    { id: 's4pd095o2ll58e8ujhe7yfap', name: 'Phase B' },
    { id: 'dkegmcasqq0ts5mzw6vjxpq1', name: 'Phase C' },
  ] as const;
  const phases: { id: string; name: string }[] = [];
  for (const p of phaseDefs) {
    const phase = await prisma.phase.upsert({
      where: { id: p.id },
      update: { name: p.name },
      create: { id: p.id, projectId: metroHeights.id, organizationId: SEED_ORG_ID, name: p.name },
    });
    phases.push(phase);
  }

  // ---- Project options - per-project facing/BHK pickers -----------------
  // Backfill the demo project with the historical defaults so the
  // inventory pickers (which now read from DB) keep offering the same
  // values the seed units use. Idempotent via the (projectId, type, value)
  // unique key.
  await prisma.projectOption.createMany({
    data: [
      { projectId: metroHeights.id, organizationId: SEED_ORG_ID, type: 'FACING', value: 'North' },
      { projectId: metroHeights.id, organizationId: SEED_ORG_ID, type: 'FACING', value: 'South' },
      { projectId: metroHeights.id, organizationId: SEED_ORG_ID, type: 'FACING', value: 'East' },
      { projectId: metroHeights.id, organizationId: SEED_ORG_ID, type: 'FACING', value: 'West' },
      { projectId: metroHeights.id, organizationId: SEED_ORG_ID, type: 'BHK', value: '1' },
      { projectId: metroHeights.id, organizationId: SEED_ORG_ID, type: 'BHK', value: '2' },
      { projectId: metroHeights.id, organizationId: SEED_ORG_ID, type: 'BHK', value: '3' },
      { projectId: metroHeights.id, organizationId: SEED_ORG_ID, type: 'BHK', value: '4' },
      { projectId: metroHeights.id, organizationId: SEED_ORG_ID, type: 'BHK', value: '5' },
    ],
    skipDuplicates: true,
  });

  // (phaseId, unitNumber) → { bhk, facing, sqft, price }
  //
  // T-INV-SYNC (2026-09-15): `status` is deliberately NOT part of the seeded
  // unit definition. Unit.status is DERIVED from the booking lifecycle (a
  // trigger on "Booking" recomputes it), so seeding HOLD/TOKEN/SOLD here used
  // to plant units that no booking could ever clear - one of the two sources
  // of the inventory/bookings drift. Every unit is created AVAILABLE and only
  // a booking moves it.
  const unitDefs: Array<{
    phaseId: string;
    unitNumber: string;
    bhk: number;
    facing: string;
    sqft: number;
    price: number;
  }> = [
    // Phase A - 2 BHK
    { phaseId: 'zpn4utpch0ncq4esh46cl4ug', unitNumber: 'A-101', bhk: 2, facing: 'North', sqft: 1050, price: 4_200_000 },
    { phaseId: 'zpn4utpch0ncq4esh46cl4ug', unitNumber: 'A-102', bhk: 2, facing: 'East', sqft: 1080, price: 4_350_000 },
    { phaseId: 'zpn4utpch0ncq4esh46cl4ug', unitNumber: 'A-103', bhk: 2, facing: 'South', sqft: 1020, price: 4_100_000 },
    { phaseId: 'zpn4utpch0ncq4esh46cl4ug', unitNumber: 'A-104', bhk: 2, facing: 'West', sqft: 1100, price: 4_400_000 },
    // Phase A - 3 BHK
    { phaseId: 'zpn4utpch0ncq4esh46cl4ug', unitNumber: 'A-201', bhk: 3, facing: 'North', sqft: 1450, price: 5_800_000 },
    { phaseId: 'zpn4utpch0ncq4esh46cl4ug', unitNumber: 'A-202', bhk: 3, facing: 'East', sqft: 1480, price: 5_950_000 },
    { phaseId: 'zpn4utpch0ncq4esh46cl4ug', unitNumber: 'A-203', bhk: 3, facing: 'South', sqft: 1420, price: 5_700_000 },
    // Phase B - 3 BHK
    { phaseId: 's4pd095o2ll58e8ujhe7yfap', unitNumber: 'B-101', bhk: 3, facing: 'North', sqft: 1500, price: 6_100_000 },
    { phaseId: 's4pd095o2ll58e8ujhe7yfap', unitNumber: 'B-102', bhk: 3, facing: 'East', sqft: 1520, price: 6_250_000 },
    { phaseId: 's4pd095o2ll58e8ujhe7yfap', unitNumber: 'B-103', bhk: 3, facing: 'West', sqft: 1490, price: 6_050_000 },
    // Phase B - 4 BHK
    { phaseId: 's4pd095o2ll58e8ujhe7yfap', unitNumber: 'B-201', bhk: 4, facing: 'North', sqft: 1900, price: 8_400_000 },
    { phaseId: 's4pd095o2ll58e8ujhe7yfap', unitNumber: 'B-202', bhk: 4, facing: 'South', sqft: 1850, price: 8_200_000 },
    // Phase C - 2 BHK
    { phaseId: 'dkegmcasqq0ts5mzw6vjxpq1', unitNumber: 'C-101', bhk: 2, facing: 'East', sqft: 1060, price: 4_300_000 },
    { phaseId: 'dkegmcasqq0ts5mzw6vjxpq1', unitNumber: 'C-102', bhk: 2, facing: 'North', sqft: 1090, price: 4_380_000 },
    // Phase C - 3 BHK
    { phaseId: 'dkegmcasqq0ts5mzw6vjxpq1', unitNumber: 'C-201', bhk: 3, facing: 'South', sqft: 1440, price: 5_750_000 },
    { phaseId: 'dkegmcasqq0ts5mzw6vjxpq1', unitNumber: 'C-202', bhk: 3, facing: 'West', sqft: 1460, price: 5_850_000 },
  ];
  for (const u of unitDefs) {
    await prisma.unit.upsert({
      where: { phaseId_unitNumber: { phaseId: u.phaseId, unitNumber: u.unitNumber } },
      update: {
        bhk: u.bhk,
        facing: u.facing,
        sqft: u.sqft,
        price: u.price.toFixed(2),
        // Buildup defaults to the plot sq.ft for seed data; price/sqft is the derived rate.
        buildupSqft: u.sqft.toFixed(2),
        pricePerSqft: (u.price / u.sqft).toFixed(2),
        // status intentionally omitted - derived from bookings (T-INV-SYNC).
      },
      create: {
        phaseId: u.phaseId,
        organizationId: SEED_ORG_ID,
        unitNumber: u.unitNumber,
        bhk: u.bhk,
        facing: u.facing,
        sqft: u.sqft,
        price: u.price.toFixed(2),
        // Buildup defaults to the plot sq.ft for seed data; price/sqft is the derived rate.
        buildupSqft: u.sqft.toFixed(2),
        pricePerSqft: (u.price / u.sqft).toFixed(2),
        status: 'AVAILABLE',
      },
    });
  }
  // eslint-disable-next-line no-console
  console.log(`[seed] ✓ ${phases.length} phases + ${unitDefs.length} units for ${metroHeights.name}`);

  // eslint-disable-next-line no-console
  console.log('[seed] ✓ owner, admin, manager, telecaller, sales exec created/updated');
  // eslint-disable-next-line no-console
  console.log(`[seed] team: ${team.name} (${team.id})`);

  // ── Demo leads - one per LeadState so the Lead Inbox renders variety. ───
  // Phone numbers are 10-digit Indian-style; using the +91 98xxx / 87xxx /
  // 76xxx ranges so they don't collide with real customer numbers. The seed
  // is idempotent (upsert on phone) so re-running is safe. Owner is the
  // telecaller (the most common assignment in production).
  const demoLeads = [
    { name: 'Priya Sharma',   phone: '9876500001', email: 'priya.sharma@example.in',  source: 'META_AD',     state: 'NEW' },
    { name: 'Arjun Reddy',    phone: '9876500002', email: 'arjun.reddy@example.in',   source: 'LANDING',    state: 'CONTACTED' },
    { name: 'Kavya Iyer',     phone: '9876500003', email: 'kavya.iyer@example.in',    source: 'REFERRAL',   state: 'VISIT_REQUESTED' },
    { name: 'Rahul Verma',    phone: '9876500004', email: 'rahul.verma@example.in',   source: 'META_AD',    state: 'VISIT_SCHEDULED' },
    { name: 'Anita Krishnan', phone: '9876500005', email: 'anita.k@example.in',       source: 'WALK_IN',    state: 'VISITED' },
    { name: 'Sanjay Patel',   phone: '9876500006', email: 'sanjay.patel@example.in',  source: 'REFERRAL',   state: 'NEGOTIATION' },
    { name: 'Deepa Nair',     phone: '9876500007', email: 'deepa.nair@example.in',    source: 'META_AD',    state: 'BOOKING_INITIATED' },
    { name: 'Vikram Singh',   phone: '9876500008', email: 'vikram.singh@example.in',  source: 'LANDING',    state: 'WON' },
    { name: 'Meera Joshi',    phone: '9876500009', email: 'meera.joshi@example.in',   source: 'WALK_IN',    state: 'LOST' },
    { name: 'Rohan Gupta',    phone: '9876500010', email: 'rohan.gupta@example.in',   source: 'REFERRAL',   state: 'RNR' },
  ] as const;

  for (const lead of demoLeads) {
    await prisma.lead.upsert({
      where: { phone: lead.phone },
      update: {
        state: lead.state,
        name: lead.name,
        // T-ProjectSwitch: backfill the project on re-seed (older rows
        // have projectId=null).
        projectId: metroHeights.id,
      },
      create: {
        name: lead.name,
        phone: lead.phone,
        email: lead.email,
        source: lead.source,
        state: lead.state,
        ownerId: telecallerUser.id,
        ownerType: 'TELECALLER',
        teamId: team.id,
        organizationId: SEED_ORG_ID,
        projectId: metroHeights.id,
      },
    });
  }
  // eslint-disable-next-line no-console
  console.log(`[seed] ✓ ${demoLeads.length} demo leads created/updated across all LeadStates`);

  // ── Demo ManagerAssignmentRule rows (T-ARM-SCHEMA, 2026-09-04) ────────
  // Three rules demonstrating the priority + criteria engine:
  //   priority 10 (lowest) → telecaller - META_AD only
  //   priority 20          → sales_exec - LANDING only
  //   priority 30          → manager    - catch-all (any source)
  // Plus: Team.defaultAssigneeId → manager (the team's catch-all).
  //
  // The ManagerAssignmentRule model's unique constraint is now
  // (teamId, source, priority, projectId, phaseId, language, region) so
  // we can have multiple rules for the same source differentiated by
  // priority. The seed is idempotent - re-running upserts each rule by
  // a stable composite key in the orderBy of createdAt.
  const rules = [
    { source: 'META_AD', priority: 10, targetEmail: telecaller.email },
    { source: 'LANDING', priority: 20, targetEmail: salesExec.email },
    { source: 'REFERRAL', priority: 30, targetEmail: manager.email },
    { source: 'WALK_IN', priority: 30, targetEmail: manager.email },
  ] as const;

  for (let i = 0; i < rules.length; i++) {
    const r = rules[i]!;
    // T-EMAIL-PER-ORG: `email` alone is no longer a unique key - go through
    // the (email, organizationId) compound unique (this seed only ever
    // targets the fixed SEED_ORG_ID org).
    const target = await prisma.user.findUnique({
      where: { email_organizationId: { email: r.targetEmail, organizationId: SEED_ORG_ID } },
      select: { id: true },
    });
    if (target === null) continue;
    // Stable cuid2 id (SEED_RULE_IDS, index-aligned with `rules`) so the
    // upsert is idempotent across re-runs. Real rule creation goes through
    // the future admin endpoint; this is a seed-time helper.
    const ruleId = SEED_RULE_IDS[i]!;
    await prisma.managerAssignmentRule.upsert({
      where: { id: ruleId },
      update: {
        teamId: team.id,
        source: r.source,
        priority: r.priority,
        targetUserId: target.id,
        active: true,
      },
      create: {
        id: ruleId,
        teamId: team.id,
        organizationId: SEED_ORG_ID,
        source: r.source,
        priority: r.priority,
        targetUserId: target.id,
        active: true,
      },
    });
  }
  // eslint-disable-next-line no-console
  console.log(`[seed] ✓ ${rules.length} demo ManagerAssignmentRule rows for team ${team.id}`);

  // Team.defaultAssigneeId → manager (the per-team catch-all after
  // rules fail to match).
  await prisma.team.update({
    where: { id: team.id },
    data: { defaultAssigneeId: managerUser.id },
  });
  // eslint-disable-next-line no-console
  console.log(`[seed] ✓ team.defaultAssigneeId = ${managerUser.id} (manager)`);
}

main()
  .then(async () => {
    await prisma.$disconnect();
    process.exit(0);
  })
  .catch(async (e) => {
    // eslint-disable-next-line no-console
    console.error('[seed] FAIL:', e instanceof Error ? e.message : e);
    await prisma.$disconnect();
    process.exit(1);
  });