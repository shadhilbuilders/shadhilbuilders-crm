import { randomBytes, scryptSync } from 'node:crypto';
import { prisma } from './index';

// ────────────────────────────────────────────────────────────────────────────
// Shadhil Builders CRM — bootstrap seed.
// AR-8/B4b (2026-08-31): credentials are created in the EXACT shape better-auth
// 1.7 expects at sign-in (dist/api/routes/sign-in.mjs:320):
//   account.accountId === user.id  AND  account.issuer === 'local:credential'
// Passwords use @better-auth/utils scrypt params (N=16384, r=16, p=1, dkLen=64,
// NFKC-normalized) stored as "salt:key".
// Placeholder fallbacks per plan §17 Input #5 — rotate on first login (T-S).
// ────────────────────────────────────────────────────────────────────────────

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
  prefix: 'SUPER_ADMIN' | 'MANAGER' | 'TELECALLER' | 'SALES_EXEC',
): SeedUser {
  // Plan §17 Input #5: fall back to documented placeholder users so a fresh
  // clone can seed before the client roster arrives. Placeholders MUST be
  // rotated on first login (plan task T-S). Round 20: the ADMIN placeholder
  // is now the single SUPER_ADMIN (exactly one exists — partial unique
  // index one_super_admin).
  const email = process.env[`SEED_${prefix}_EMAIL`] ?? `${prefix === 'SUPER_ADMIN' ? 'admin' : prefix.toLowerCase()}@shadhilbuilders.in`;
  const name = process.env[`SEED_${prefix}_NAME`] ?? `${prefix === 'SUPER_ADMIN' ? 'Super Admin' : prefix[0] + prefix.slice(1).toLowerCase()} (placeholder)`;
  const password = process.env[`SEED_${prefix}_PASSWORD`] ?? `${prefix === 'SUPER_ADMIN' ? 'admin' : prefix.toLowerCase()}_placeholder_pw`;

  if (!email || !name || !password) {
    throw new Error(
      `Missing SEED_${prefix}_EMAIL / SEED_${prefix}_NAME / SEED_${prefix}_PASSWORD in env`,
    );
  }

  return { email, name, password };
}

type Role = 'SUPER_ADMIN' | 'ADMIN' | 'MANAGER' | 'TELECALLER' | 'SALES_EXEC';

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

  const superAdmin = readSeedUser('SUPER_ADMIN');
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

  // ── Super admin (no team), telecaller + sales exec (team members) ────────
  await upsertUser(superAdmin, 'SUPER_ADMIN');
  await upsertUser(telecaller, 'TELECALLER', team.id);
  await upsertUser(salesExec, 'SALES_EXEC', team.id);

  // eslint-disable-next-line no-console
  console.log('[seed] ✓ super admin, manager, telecaller, sales exec created/updated');
  // eslint-disable-next-line no-console
  console.log(`[seed] team: ${team.name} (${team.id})`);
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