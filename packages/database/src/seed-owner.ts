// ────────────────────────────────────────────────────────────────────────────
// Owner-only bootstrap seed (prod cutover, 2026-10-01).
//
// Creates ONE user - the org OWNER - and NOTHING else:
//   - Organization (created first if absent; name/slug configurable)
//   - the owner User + better-auth credential Account row
//   - the owner's better-auth Session rows are left untouched
// No teams, no projects, no leads, no inventory, no assignment rules.
// The owner creates all staff users and data through the UI.
//
// Idempotent: safe to re-run. The owner's password is REFRESHED only when
// SEED_OWNER_PASSWORD is set (deliberate re-rotation via re-run); without
// it, an existing owner keeps their current password.
//
// The bootstrap org id is FIXED (SEED_ORG_ID, imported from seed.ts) and
// must stay in sync with PUBLIC_ORG_ID env (public lead/feedback endpoints
// write under it).
//
// Run with the OWNER role URL (migrations/seed privilege):
//   DIRECT_DATABASE_URL=postgresql://shadhil:***@host:5432/shadhil_crm \
//     pnpm --filter @shadhil/database seed:owner
// ────────────────────────────────────────────────────────────────────────────
import { PrismaClient } from './generated/prisma/client';
import { PrismaPg } from '@prisma/adapter-pg';
import { randomBytes, scryptSync } from 'node:crypto';
import { SEED_ORG_ID } from './seed';

function hashPassword(password: string): string {
  const salt = randomBytes(16).toString('hex');
  const normalized = password.normalize('NFKC');
  const hash = scryptSync(normalized, salt, 64, {
    N: 16384,
    r: 16,
    p: 1,
    maxmem: 128 * 16384 * 16 * 2,
  }).toString('hex');
  return `${salt}:${hash}`;
}

const prisma: PrismaClient = new PrismaClient({
  adapter: new PrismaPg({
    connectionString: process.env.DIRECT_DATABASE_URL ?? process.env.DATABASE_URL,
  }),
});

async function main() {
  const email = process.env.SEED_OWNER_EMAIL ?? 'owner@shadhilbuilders.in';
  const name = process.env.SEED_OWNER_NAME ?? 'Owner';

  // Password: REQUIRED on first run; optional on re-runs (keeps existing).
  let password = process.env.SEED_OWNER_PASSWORD;
  // T-EMAIL-PER-ORG: `email` alone is no longer a unique key - the lookup
  // must go through the (email, organizationId) compound unique. This
  // bootstrap seed only ever targets the ONE fixed SEED_ORG_ID org anyway.
  const existing = await prisma.user.findUnique({
    where: { email_organizationId: { email, organizationId: SEED_ORG_ID } },
    select: { id: true },
  });
  if (!password) {
    if (existing === null) {
      throw new Error(
        'SEED_OWNER_PASSWORD is required to create the owner on a fresh database.',
      );
    }
    // eslint-disable-next-line no-console
    console.log('[seed:owner] owner exists and SEED_OWNER_PASSWORD unset - keeping current password');
    password = undefined;
  }

  // ── 1. Organization ──────────────────────────────────────────────────────
  const orgName = process.env.SEED_ORG_NAME ?? 'Shadhil Builders';
  const orgSlug = process.env.SEED_ORG_SLUG ?? 'shadhil-builders';
  await prisma.organization.upsert({
    where: { id: SEED_ORG_ID },
    update: { name: orgName, slug: orgSlug },
    create: { id: SEED_ORG_ID, name: orgName, slug: orgSlug },
  });
  // eslint-disable-next-line no-console
  console.log(`[seed:owner] org: ${orgName} (${SEED_ORG_ID})`);

  // ── 2. Owner user + credential ───────────────────────────────────────────
  // cuid ids: generated with @paralleldrive/cuid2 (same shape the runtime
  // generates). Fixed so re-runs upsert instead of duplicating.
  const OWNER_ID = 'oet70k7svsjrta4480fnyenx'; // same id the full seed used

  const user = await prisma.user.upsert({
    where: { id: OWNER_ID },
    update: { role: 'OWNER', email, name },
    create: {
      id: OWNER_ID,
      email,
      name,
      role: 'OWNER',
      organizationId: SEED_ORG_ID,
      emailVerified: true,
      // The single highest-privilege account: gate rotates-on-first-login.
      // Set on CREATE only - re-runs never re-arm an already-rotated owner.
      mustChangePassword: true,
    },
  });

  if (password !== undefined) {
    await prisma.account.upsert({
      where: {
        providerId_accountId: { providerId: 'credential', accountId: user.id },
      },
      update: { password: hashPassword(password), issuer: 'local:credential' },
      create: {
        accountId: user.id,
        providerId: 'credential',
        issuer: 'local:credential',
        userId: user.id,
        password: hashPassword(password),
      },
    });
    // eslint-disable-next-line no-console
    console.log('[seed:owner] credential (re)set - rotate on first login');
  }
  // eslint-disable-next-line no-console
  console.log(`[seed:owner] ✓ owner: ${email} (ROLE OWNER, gated for first-login rotation)`);

  // ── 3. Everything else: NOTHING. Owner creates staff + data via the UI. ─
}

main()
  .then(async () => {
    await prisma.$disconnect();
    process.exit(0);
  })
  .catch(async (e) => {
    // eslint-disable-next-line no-console
    console.error('[seed:owner] FAIL:', e instanceof Error ? e.message : e);
    await prisma.$disconnect();
    process.exit(1);
  });