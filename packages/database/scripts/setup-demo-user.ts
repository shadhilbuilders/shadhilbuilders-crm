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

  // eslint-disable-next-line no-console
  console.log(
    `[demo-user] user ${DEMO_EMAIL} (MANAGER) ready, password "${DEMO_PASSWORD}"`,
  );
  // eslint-disable-next-line no-console
  console.log(
    `[demo-user] ${reassign.count} leads reassigned to demo user (team: ${demoTeam.id})`,
  );

  await prisma.$disconnect();
}

main().catch((err) => {
  // eslint-disable-next-line no-console
  console.error('[demo-user] failed:', err);
  process.exit(1);
});
