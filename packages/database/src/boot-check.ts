// ────────────────────────────────────────────────────────────────────────────
// Shadhil Builders CRM - Boot-time POOL_MODE check
// ────────────────────────────────────────────────────────────────────────────
// ENG REVIEW A5: PgBouncer transaction pooling silently breaks RLS because
// per-request session variables (SET LOCAL app.user_id = ...) do not survive
// across pooled transactions. The CRM depends on session-mode pooling for
// every code path that touches business tables. Refuse to boot otherwise.
//
// Call verifyPoolMode() at process start (NestJS bootstrap, Next.js
// instrumentation, worker startup). It exits 1 on failure in production.
// ────────────────────────────────────────────────────────────────────────────

const REQUIRED_POOL_MODE = 'session' as const;

export class PoolModeError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'PoolModeError';
  }
}

/**
 * Verify the POOL_MODE environment variable is set to 'session'.
 *
 * Throws PoolModeError if:
 *   - POOL_MODE is unset
 *   - POOL_MODE is not exactly 'session' (case-sensitive)
 *
 * Returns the validated value ('session') on success.
 */
export async function verifyPoolMode(): Promise<'session'> {
  const value = process.env.POOL_MODE;

  if (value === undefined || value === null || value === '') {
    throw new PoolModeError(
      `POOL_MODE must be 'session' for RLS to work (eng review A5). Current value: ${value === undefined ? 'undefined' : value}`,
    );
  }

  if (value !== REQUIRED_POOL_MODE) {
    throw new PoolModeError(
      `POOL_MODE must be 'session' for RLS to work (eng review A5). Current value: ${value}`,
    );
  }

  return REQUIRED_POOL_MODE;
}

// Allow `pnpm dev` / `pnpm boot-check` to invoke directly.
const isMain =
  typeof process !== 'undefined' &&
  process.argv[1] &&
  process.argv[1].endsWith('boot-check.ts');

if (isMain) {
  verifyPoolMode()
    .then((mode) => {
      // eslint-disable-next-line no-console
      console.log(`[boot-check] POOL_MODE=${mode} ✓`);
      process.exit(0);
    })
    .catch((err: unknown) => {
      const message = err instanceof Error ? err.message : String(err);
      // eslint-disable-next-line no-console
      console.error(`[boot-check] FAIL - ${message}`);
      process.exit(1);
    });
}