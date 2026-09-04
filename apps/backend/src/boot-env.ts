// Boot-time env validation (T-G8 / eng review A2 — 2026-09-03).
//
// Fail-fast at the very first line of main.ts:bootstrap so a
// misconfigured container exits with a clear, multi-line error listing
// every missing or malformed env var — not a half-initialized NestJS
// app failing on the first Redis call. The previous behavior was:
//
//   process.env.REDIS_URL ?? 'redis://localhost:6379'
//
// …which silently lost pub/sub + cron locks in production when the real
// env var was missing. Same pattern for JWT_SECRET, BETTER_AUTH_URL, etc.
//
// This module owns ONE function: assertBootEnv(). Tests live next door
// (boot-env.test.ts) and exercise every required var + every branch of
// the URL/length validators. Importing it from main.ts keeps the
// runtime gate visible at the very top of bootstrap().

export interface BootEnv {
  DATABASE_URL: string;
  DIRECT_DATABASE_URL: string;
  REDIS_URL: string;
  JWT_SECRET: string;
  JWT_ISSUER: string;
  BETTER_AUTH_SECRET: string;
  BETTER_AUTH_URL: string;
  POOL_MODE: 'session';
  CORS_ORIGINS: string;
  API_PORT: number;
  NODE_ENV: 'development' | 'production' | 'test';
}

export class BootEnvError extends Error {
  constructor(public readonly issues: readonly string[]) {
    super(
      `[boot-env] ${issues.length} required env var(s) invalid:\n${issues.join('\n')}\n` +
        `Refusing to start. Fix .env (or the deploy platform env vars) and retry.`,
    );
    this.name = 'BootEnvError';
  }
}

/**
 * Validate every required env var. Throws BootEnvError with the full
 * list of issues if anything is missing or malformed. Otherwise returns
 * the parsed env (typed) so callers don't need to re-read process.env.
 */
export function assertBootEnv(env: NodeJS.ProcessEnv = process.env): BootEnv {
  const issues: string[] = [];

  const required = (name: string, minLength?: number): string | null => {
    const value = env[name];
    if (value === undefined || value === '') {
      issues.push(`  - ${name}: missing (required)`);
      return null;
    }
    if (minLength !== undefined && value.length < minLength) {
      issues.push(
        `  - ${name}: must be at least ${minLength} chars (got ${value.length})`,
      );
      return null;
    }
    return value;
  };

  const DATABASE_URL = required('DATABASE_URL') ?? '';
  const DIRECT_DATABASE_URL = required('DIRECT_DATABASE_URL') ?? '';
  const REDIS_URL = required('REDIS_URL') ?? '';
  const JWT_SECRET = required('JWT_SECRET', 32) ?? '';
  const JWT_ISSUER = required('JWT_ISSUER') ?? '';
  const BETTER_AUTH_SECRET = required('BETTER_AUTH_SECRET', 32) ?? '';
  const BETTER_AUTH_URL = env['BETTER_AUTH_URL'] ?? '';
  if (BETTER_AUTH_URL === '') {
    issues.push('  - BETTER_AUTH_URL: missing (required)');
  } else {
    try {
      new URL(BETTER_AUTH_URL);
    } catch {
      issues.push(
        `  - BETTER_AUTH_URL: not a valid URL (got "${BETTER_AUTH_URL}")`,
      );
    }
  }

  const POOL_MODE = env['POOL_MODE'] ?? '';
  if (POOL_MODE !== 'session') {
    issues.push(
      `  - POOL_MODE: must be 'session' for RLS (got "${POOL_MODE || '<unset>'}")`,
    );
  }

  const CORS_ORIGINS =
    env['CORS_ORIGINS'] ?? 'http://localhost:3000,http://localhost:8081';

  const rawApiPort = env['API_PORT'];
  const API_PORT = rawApiPort === undefined ? 8080 : Number.parseInt(rawApiPort, 10);
  if (!Number.isFinite(API_PORT) || API_PORT <= 0) {
    issues.push(`  - API_PORT: not a positive integer (got "${rawApiPort}")`);
  }

  const NODE_ENV = (env['NODE_ENV'] ?? 'development') as BootEnv['NODE_ENV'];

  if (issues.length > 0) {
    throw new BootEnvError(issues);
  }

  return {
    DATABASE_URL,
    DIRECT_DATABASE_URL,
    REDIS_URL,
    JWT_SECRET,
    JWT_ISSUER,
    BETTER_AUTH_SECRET,
    BETTER_AUTH_URL,
    POOL_MODE: 'session',
    CORS_ORIGINS,
    API_PORT,
    NODE_ENV,
  };
}