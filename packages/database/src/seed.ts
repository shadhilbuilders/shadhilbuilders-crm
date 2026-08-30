// ────────────────────────────────────────────────────────────────────────────
// Shadhil Builders CRM — Placeholder seed
// ────────────────────────────────────────────────────────────────────────────
// Creates 1 admin, 1 manager (with their own team), 1 telecaller and 1
// sales exec (both members of the manager's team). Reads credentials from
// the SEED_*_EMAIL/NAME/PASSWORD env vars defined in .env.example §17 input #5.
//
// NOTE: This is a placeholder. better-auth's User.create() handles password
// hashing via its own API; for the seed we use a simple bcrypt-equivalent
// placeholder via Node's crypto.scrypt so this works without a better-auth
// server running. The real seed will live in apps/api and use better-auth.
// ────────────────────────────────────────────────────────────────────────────

import 'dotenv/config';
import { randomBytes, scryptSync } from 'node:crypto';
import { prisma } from './index.js';

function hashPassword(password: string): string {
  const salt = randomBytes(16).toString('hex');
  const hash = scryptSync(password, salt, 64).toString('hex');
  return `${salt}:${hash}`;
}

interface SeedUser {
  email: string;
  name: string;
  password: string;
}

function readSeedUser(prefix: 'ADMIN' | 'MANAGER' | 'TELECALLER' | 'SALES_EXEC'): SeedUser {
  const email = process.env[`SEED_${prefix}_EMAIL`];
  const name = process.env[`SEED_${prefix}_NAME`];
  const password = process.env[`SEED_${prefix}_PASSWORD`];

  if (!email || !name || !password) {
    throw new Error(
      `Missing SEED_${prefix}_EMAIL / SEED_${prefix}_NAME / SEED_${prefix}_PASSWORD in env`,
    );
  }

  return { email, name, password };
}

async function main() {
  // Disable RLS for seed — the bootstrap admin needs to bypass policies until
  // the database is fully populated. In production, run migrations with the
  // DIRECT_DATABASE_URL (owner role), which bypasses RLS by default.
  await prisma.$executeRawUnsafe(`SET LOCAL row_security = off`).catch(() => {
    // session-level fallback if SET LOCAL is not allowed (no active tx)
    return prisma.$executeRawUnsafe(`SET row_security = off`);
  });

  const admin = readSeedUser('ADMIN');
  const manager = readSeedUser('MANAGER');
  const telecaller = readSeedUser('TELECALLER');
  const salesExec = readSeedUser('SALES_EXEC');

  // ── Manager first so we have a teamId ────────────────────────────────────
  const managerUser = await prisma.user.upsert({
    where: { email: manager.email },
    update: {},
    create: {
      email: manager.email,
      name: manager.name,
      role: 'MANAGER',
      emailVerified: true,
      // password lives in better-auth Account, not on User — placeholder here
      accounts: {
        create: {
          accountId: manager.email,
          providerId: 'credential',
          password: hashPassword(manager.password),
        },
      },
    },
  });

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

  // ── Admin (no team) ───────────────────────────────────────────────────────
  await prisma.user.upsert({
    where: { email: admin.email },
    update: {},
    create: {
      email: admin.email,
      name: admin.name,
      role: 'ADMIN',
      emailVerified: true,
      accounts: {
        create: {
          accountId: admin.email,
          providerId: 'credential',
          password: hashPassword(admin.password),
        },
      },
    },
  });

  // ── Telecaller ────────────────────────────────────────────────────────────
  await prisma.user.upsert({
    where: { email: telecaller.email },
    update: { teamId: team.id },
    create: {
      email: telecaller.email,
      name: telecaller.name,
      role: 'TELECALLER',
      teamId: team.id,
      emailVerified: true,
      accounts: {
        create: {
          accountId: telecaller.email,
          providerId: 'credential',
          password: hashPassword(telecaller.password),
        },
      },
    },
  });

  // ── Sales exec ────────────────────────────────────────────────────────────
  await prisma.user.upsert({
    where: { email: salesExec.email },
    update: { teamId: team.id },
    create: {
      email: salesExec.email,
      name: salesExec.name,
      role: 'SALES_EXEC',
      teamId: team.id,
      emailVerified: true,
      accounts: {
        create: {
          accountId: salesExec.email,
          providerId: 'credential',
          password: hashPassword(salesExec.password),
        },
      },
    },
  });

  // eslint-disable-next-line no-console
  console.log('[seed] ✓ admin, manager, telecaller, sales exec created/updated');
  // eslint-disable-next-line no-console
  console.log(`[seed] team: ${team.name} (${team.id})`);
}

main()
  .then(async () => {
    await prisma.$disconnect();
    process.exit(0);
  })
  .catch(async (err) => {
    // eslint-disable-next-line no-console
    console.error('[seed] FAIL:', err);
    await prisma.$disconnect();
    process.exit(1);
  });