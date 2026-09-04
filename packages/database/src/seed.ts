import { randomBytes, scryptSync } from 'node:crypto';
import { PrismaClient } from './generated/prisma/client';
import { PrismaPg } from '@prisma/adapter-pg';

// ────────────────────────────────────────────────────────────────────────────
// Shadhil Builders CRM — bootstrap seed.
// AR-8/B4b (2026-08-31): credentials are created in the EXACT shape better-auth
// 1.7 expects at sign-in (dist/api/routes/sign-in.mjs:320):
//   account.accountId === user.id  AND  account.issuer === 'local:credential'
// Passwords use @better-auth/utils scrypt params (N=16384, r=16, p=1, dkLen=64,
// NFKC-normalized) stored as "salt:key".
// Placeholder fallbacks per plan §17 Input #5 — rotate on first login (T-S).
// ────────────────────────────────────────────────────────────────────────────

// The seed needs the OWNER database role (migration privileges,
// bypass-RLS) — `shadhil` via DIRECT_DATABASE_URL — not the
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
  // exists — partial unique index one_owner). Round 22: a second
  // ADMIN placeholder is seeded so the OWNER isn't the only account
  // that can create managers + admins out of the box.
  //   OWNER       → owner@shadhilbuilders.in
  //   ADMIN       → admin@shadhilbuilders.in
  //   MANAGER     → manager@shadhilbuilders.in
  //   TELECALLER  → telecaller@shadhilbuilders.in
  //   SALES_EXEC  → sales_exec@shadhilbuilders.in
  // Each email mirrors the role name — Round 23 swap from
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

/**
 * Upsert user, then upsert the credential account keyed on user.id (the
 * better-auth 1.7 sign-in contract: sign-in.mjs requires
 * account.accountId === user.id && account.issuer === 'local:credential').
 * Password is refreshed on every seed run so re-seeding after a password
 * rotation works.
 */
async function upsertUser(
  user: SeedUser,
  role: Role,
  teamId?: string,
) {
  const dbUser = await prisma.user.upsert({
    where: { email: user.email },
    update: { role, ...(teamId ? { teamId } : {}) },
    create: {
      email: user.email,
      name: user.name,
      role,
      teamId,
      emailVerified: true,
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

  return dbUser;
}

async function main() {
  // Disable RLS for seed — the bootstrap admin needs to bypass policies until
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
  const managerUser = await upsertUser(manager, 'MANAGER');

  // ── Team owned by the manager ────────────────────────────────────────────
  const team = await prisma.team.upsert({
    where: { id: `seed-team-${managerUser.id}` },
    update: { managerId: managerUser.id, name: `${manager.name}'s Team` },
    create: {
      id: `seed-team-${managerUser.id}`,
      name: `${manager.name}'s Team`,
      managerId: managerUser.id,
    },
  });

  // BUG FIX (Day 3 demo prep): the manager was upserted above WITHOUT a
  // teamId because the team didn't exist yet. Re-upsert with the team id
  // now that we have one. Without this the manager has teamId=null,
  // RLS team-scoped queries return 0 rows for them, and the demo inbox
  // renders empty. The original ordering bug means a fresh seed run
  // produces a manager with no team even though the team is created.
  await upsertUser(manager, 'MANAGER', team.id);

  // ── Owner (no team), Admin (no team), telecaller + sales exec (team members)
  await upsertUser(owner, 'OWNER');
  await upsertUser(admin, 'ADMIN');
  const telecallerUser = await upsertUser(telecaller, 'TELECALLER', team.id);
  await upsertUser(salesExec, 'SALES_EXEC', team.id);

  // eslint-disable-next-line no-console
  console.log('[seed] ✓ owner, admin, manager, telecaller, sales exec created/updated');
  // eslint-disable-next-line no-console
  console.log(`[seed] team: ${team.name} (${team.id})`);

  // ── Demo leads — one per LeadState so the Lead Inbox renders variety. ───
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
    { name: 'Rohan Gupta',    phone: '9876500010', email: 'rohan.gupta@example.in',   source: 'REFERRAL',   state: 'COLD' },
  ] as const;

  for (const lead of demoLeads) {
    await prisma.lead.upsert({
      where: { phone: lead.phone },
      update: { state: lead.state, name: lead.name },
      create: {
        name: lead.name,
        phone: lead.phone,
        email: lead.email,
        source: lead.source,
        state: lead.state,
        ownerId: telecallerUser.id,
        ownerType: 'TELECALLER',
        teamId: team.id,
      },
    });
  }
  // eslint-disable-next-line no-console
  console.log(`[seed] ✓ ${demoLeads.length} demo leads created/updated across all LeadStates`);
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