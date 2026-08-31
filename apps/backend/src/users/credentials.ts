// Credentials service — writes the better-auth 1.7 credential Account row.
//
// Contract (from packages/database/src/seed.ts, mirroring better-auth
// dist/api/routes/sign-in.mjs:320): sign-in requires
//   account.accountId === user.id  AND  account.issuer === 'local:credential'
// with the password scrypt-hashed using @better-auth/utils params
// (N=16384, r=16, p=1, dkLen=64, NFKC-normalized), stored "salt:key".
//
// User/Account tables have NO RLS policies (policies.sql grants them to
// shadhil_app but never FORCEs them), so these writes run on the bare client
// — exactly the seed's path. Auth tables are pre-RLS by design: better-auth's
// own HTTP handlers write them session-agnostically.
import { randomBytes, scryptSync } from 'node:crypto';

const SCRYPT_PARAMS = {
  N: 16384,
  r: 16,
  p: 1,
  maxmem: 128 * 16384 * 16 * 2,
} as const;

/** NFKC-normalize, scrypt-hash with @better-auth/utils params, "salt:key". */
export function hashPassword(password: string): string {
  const salt = randomBytes(16).toString('hex');
  const normalized = password.normalize('NFKC');
  const hash = scryptSync(
    normalized,
    salt,
    64,
    SCRYPT_PARAMS,
  ).toString('hex');
  return `${salt}:${hash}`;
}

/**
 * Attach (or reset) credential credentials for a user, in better-auth 1.7's
 * exact sign-in contract shape. Mirrors seed.ts upsertUser's Account upsert
 * so a user created here and a user created by seed behave identically.
 */
export async function upsertCredentialAccount(
  prisma: import('@shadhil/database').PrismaClient,
  userId: string,
  password: string,
): Promise<void> {
  await prisma.account.upsert({
    where: {
      providerId_accountId: { providerId: 'credential', accountId: userId },
    },
    update: { password: hashPassword(password), issuer: 'local:credential' },
    create: {
      accountId: userId,
      providerId: 'credential',
      issuer: 'local:credential',
      userId,
      password: hashPassword(password),
    },
  });
}