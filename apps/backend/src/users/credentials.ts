// Credentials service - writes the better-auth 1.7 credential Account row.
//
// Contract (from packages/database/src/seed.ts, mirroring better-auth
// dist/api/routes/sign-in.mjs:320): sign-in requires
//   account.accountId === user.id  AND  account.issuer === 'local:credential'
// with the password scrypt-hashed using @better-auth/utils params
// (N=16384, r=16, p=1, dkLen=64, NFKC-normalized), stored "salt:key".
//
// User/Account tables have NO RLS policies (policies.sql grants them to
// shadhil_app but never FORCEs them), so these writes run on the bare client
// - exactly the seed's path. Auth tables are pre-RLS by design: better-auth's
// own HTTP handlers write them session-agnostically.
import { randomBytes, scrypt, scryptSync, timingSafeEqual } from 'node:crypto';
import { promisify } from 'node:util';

const SCRYPT_PARAMS = {
  N: 16384,
  r: 16,
  p: 1,
  maxmem: 128 * 16384 * 16 * 2,
} as const;

const scryptAsync = promisify(scrypt) as unknown as (
  password: string,
  salt: string,
  keylen: number,
  options: typeof SCRYPT_PARAMS,
) => Promise<Buffer>;

/** NFKC-normalize, scrypt-hash with @better-auth/utils params, "salt:key". */
export function hashPassword(password: string): string {
  const salt = randomBytes(16).toString('hex');
  const normalized = password.normalize('NFKC');
  const hash = scryptSync(normalized, salt, 64, SCRYPT_PARAMS).toString('hex');
  return `${salt}:${hash}`;
}

/**
 * Split a stored "salt:key" once, for BOTH verify paths.
 *
 * Shared on purpose: the sync and async verifiers must agree on the format or
 * one of them silently rejects every correct password. That exact bug shipped
 * once already (the salt was hex-decoded in one place and used as a string in
 * another).
 */
function parseStoredPassword(
  stored: string | null | undefined,
): { salt: string; expected: Buffer } | null {
  if (stored === null || stored === undefined || stored.length === 0) return null;
  const [salt, key] = stored.split(':');
  if (salt === undefined || key === undefined || salt.length === 0 || key.length === 0) {
    return null;
  }
  const expected = Buffer.from(key, 'hex');
  if (expected.length === 0) return null;
  return { salt, expected };
}

/**
 * Verify a plaintext password against a stored "salt:key" string.
 * Constant-time comparison (timingSafeEqual) so an attacker can't
 * extract the scrypt-params from response-time variance. Returns
 * false on any malformed stored value (not "throw") so the caller
 * can map to a single BadRequestException for "wrong password".
 */
export function verifyPassword(plaintext: string, stored: string | null | undefined): boolean {
  const parsed = parseStoredPassword(stored);
  if (parsed === null) return false;
  // Salt is passed as the raw hex STRING, not hex-decoded to bytes - this
  // must match hashPassword() above (which does the same) and better-auth's
  // own @better-auth/utils password.node.ts (`scrypt(password, salt, ...)`
  // where `salt` is the hex string from `randomBytes(16).toString('hex')`,
  // used verbatim as UTF-8 bytes, never Buffer.from(salt, 'hex')). Decoding
  // it here silently derived a different key for every password, so the
  // "current password" check always failed even when the password was
  // correct.
  const candidate = scryptSync(
    plaintext.normalize('NFKC'),
    parsed.salt,
    parsed.expected.length,
    SCRYPT_PARAMS,
  );
  if (candidate.length !== parsed.expected.length) return false;
  return timingSafeEqual(candidate, parsed.expected);
}

/**
 * Same check, off the event loop.
 *
 * Use this on any path an unauthenticated caller can reach: `scryptSync` blocks
 * the whole process for tens of milliseconds, so a login endpoint built on it
 * is a trivial denial of service - one request at a time, from anywhere. The
 * work runs on the libuv threadpool instead.
 *
 * Identical semantics to the sync version, including the tolerance for a
 * malformed stored value: `false`, never a throw.
 */
export async function verifyPasswordAsync(
  plaintext: string,
  stored: string | null | undefined,
): Promise<boolean> {
  const parsed = parseStoredPassword(stored);
  if (parsed === null) return false;
  const candidate = await scryptAsync(
    plaintext.normalize('NFKC'),
    parsed.salt,
    parsed.expected.length,
    SCRYPT_PARAMS,
  );
  if (candidate.length !== parsed.expected.length) return false;
  return timingSafeEqual(candidate, parsed.expected);
}

/**
 * A real hash of a throwaway password, verified against when a lookup finds no
 * candidates.
 *
 * Without it, "no such account" returns in ~1ms while "wrong password" costs a
 * full scrypt, and that difference is a free account-enumeration oracle. Costs
 * one scrypt at module load, which happens once per process.
 */
export const TIMING_DUMMY_PASSWORD_HASH = hashPassword(
  `not-a-real-password-${randomBytes(8).toString('hex')}`,
);

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
