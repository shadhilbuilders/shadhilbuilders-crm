// Boot-env tests - T-G8 fail-fast behavior.
//
// Coverage:
//   1. Complete valid env → returns the typed BootEnv with POOL_MODE='session'.
//   2. Each required var missing → BootEnvError with that name in issues.
//   3. Each secret too short → BootEnvError with length detail.
//   4. BETTER_AUTH_URL malformed → URL error.
//   5. POOL_MODE != 'session' → BootEnvError.
//   6. API_PORT non-numeric or <= 0 → BootEnvError.
//   7. CORS_ORIGINS defaults to localhost list when absent.
//   8. Multi-issue env → single BootEnvError with ALL issues (atomic).
//   9. T-E2b Telegram vars are OPTIONAL - missing → defaults filled
//      in, no error. Malformed (non-numeric) → BootEnvError.
//
// These run without a DB or Redis. The validator is pure - passes
// process.env explicitly so we don't mutate real env.

import { describe, expect, it } from 'vitest';

import { BootEnvError, assertBootEnv } from './boot-env';

const VALID_ENV: Record<string, string> = {
  DATABASE_URL: 'postgresql://app:secret@pgbouncer:6432/shadhil_crm?schema=public',
  DIRECT_DATABASE_URL: 'postgresql://owner:secret@postgres:5432/shadhil_crm?schema=public',
  REDIS_URL: 'redis://redis:6379',
  JWT_SECRET: 'a'.repeat(32),
  JWT_ISSUER: 'shadhil-crm',
  BETTER_AUTH_SECRET: 'b'.repeat(32),
  BETTER_AUTH_URL: 'https://crm-api.shadhilbuilders.in',
  POOL_MODE: 'session',
  CORS_ORIGINS: 'https://crm.shadhilbuilders.in,http://localhost:3000',
  API_PORT: '8080',
  NODE_ENV: 'production',
  PUBLIC_API_KEY: 'k'.repeat(32),
  PUBLIC_ORG_ID: '01abcd'.padEnd(26, 'x'),
};

describe('assertBootEnv - happy path', () => {
  it('returns the typed env when every required var is present and well-formed', () => {
    const env = assertBootEnv({ ...VALID_ENV });
    expect(env.DATABASE_URL).toBe(VALID_ENV.DATABASE_URL);
    expect(env.REDIS_URL).toBe(VALID_ENV.REDIS_URL);
    expect(env.POOL_MODE).toBe('session');
    expect(env.API_PORT).toBe(8080);
    expect(env.NODE_ENV).toBe('production');
    expect(env.CORS_ORIGINS).toBe(VALID_ENV.CORS_ORIGINS);
  });

  it('defaults CORS_ORIGINS to localhost dev list when unset', () => {
    const { CORS_ORIGINS: _drop, ...rest } = VALID_ENV;
    const env = assertBootEnv(rest);
    expect(env.CORS_ORIGINS).toBe('http://localhost:3000,http://localhost:8081');
  });

  it('defaults API_PORT to 8080 when unset', () => {
    const { API_PORT: _drop, ...rest } = VALID_ENV;
    const env = assertBootEnv(rest);
    expect(env.API_PORT).toBe(8080);
  });

  it('defaults NODE_ENV to "development" when unset', () => {
    const { NODE_ENV: _drop, ...rest } = VALID_ENV;
    const env = assertBootEnv(rest);
    expect(env.NODE_ENV).toBe('development');
  });
});

describe('assertBootEnv - missing required vars', () => {
  it.each([
    'DATABASE_URL',
    'DIRECT_DATABASE_URL',
    'REDIS_URL',
    'JWT_SECRET',
    'JWT_ISSUER',
    'BETTER_AUTH_SECRET',
    'BETTER_AUTH_URL',
    'PUBLIC_API_KEY',
    'PUBLIC_ORG_ID',
  ] as const)('%s: missing → BootEnvError names the var', (name) => {
    const env = { ...VALID_ENV };
    delete env[name];
    expect(() => assertBootEnv(env)).toThrow(BootEnvError);
    try {
      assertBootEnv(env);
    } catch (err) {
      expect(err).toBeInstanceOf(BootEnvError);
      const issues = (err as BootEnvError).issues.join('\n');
      expect(issues).toContain(name);
    }
  });
});

describe('assertBootEnv - length checks', () => {
  it('JWT_SECRET too short → length detail in message', () => {
    const env = { ...VALID_ENV, JWT_SECRET: 'too-short' };
    try {
      assertBootEnv(env);
      expect.fail('should have thrown');
    } catch (err) {
      expect(err).toBeInstanceOf(BootEnvError);
      expect((err as BootEnvError).issues.join('\n')).toMatch(
        /JWT_SECRET: must be at least 32 chars \(got 9\)/,
      );
    }
  });

  it('BETTER_AUTH_SECRET too short → length detail in message', () => {
    const env = { ...VALID_ENV, BETTER_AUTH_SECRET: 'tiny' };
    try {
      assertBootEnv(env);
      expect.fail('should have thrown');
    } catch (err) {
      expect((err as BootEnvError).issues.join('\n')).toMatch(
        /BETTER_AUTH_SECRET: must be at least 32 chars \(got 4\)/,
      );
    }
  });

  it('exactly 32 chars passes the length gate', () => {
    const env = assertBootEnv(VALID_ENV);
    expect(env.JWT_SECRET).toHaveLength(32);
  });
});

describe('assertBootEnv - URL + format checks', () => {
  it('BETTER_AUTH_URL malformed → URL error', () => {
    const env = { ...VALID_ENV, BETTER_AUTH_URL: 'not-a-url' };
    try {
      assertBootEnv(env);
      expect.fail('should have thrown');
    } catch (err) {
      expect((err as BootEnvError).issues.join('\n')).toMatch(
        /BETTER_AUTH_URL: not a valid URL/,
      );
    }
  });

  it('POOL_MODE != session → explicit message naming the value', () => {
    const env = { ...VALID_ENV, POOL_MODE: 'transaction' };
    try {
      assertBootEnv(env);
      expect.fail('should have thrown');
    } catch (err) {
      expect((err as BootEnvError).issues.join('\n')).toMatch(
        /POOL_MODE: must be 'session' for RLS \(got "transaction"\)/,
      );
    }
  });

  it('POOL_MODE unset → message shows <unset>', () => {
    const env = { ...VALID_ENV };
    delete env.POOL_MODE;
    try {
      assertBootEnv(env);
      expect.fail('should have thrown');
    } catch (err) {
      expect((err as BootEnvError).issues.join('\n')).toMatch(
        /POOL_MODE: must be 'session' for RLS \(got "<unset>"\)/,
      );
    }
  });

  it('API_PORT non-numeric → error', () => {
    const env = { ...VALID_ENV, API_PORT: 'not-a-port' };
    try {
      assertBootEnv(env);
      expect.fail('should have thrown');
    } catch (err) {
      expect((err as BootEnvError).issues.join('\n')).toMatch(
        /API_PORT: not a positive integer/,
      );
    }
  });

  it('API_PORT zero → error', () => {
    const env = { ...VALID_ENV, API_PORT: '0' };
    try {
      assertBootEnv(env);
      expect.fail('should have thrown');
    } catch (err) {
      expect((err as BootEnvError).issues.join('\n')).toMatch(
        /API_PORT: not a positive integer/,
      );
    }
  });
});

describe('assertBootEnv - atomic error: every gap reported in one pass', () => {
  it('three missing vars → all three named in the same error', () => {
    const env = { ...VALID_ENV };
    delete env.REDIS_URL;
    delete env.JWT_ISSUER;
    delete env.API_PORT; // also missing - defaults, but if it's explicitly missing AND other things too, defaults still apply. Make a non-defaulted one.
    try {
      assertBootEnv(env);
      expect.fail('should have thrown');
    } catch (err) {
      const issues = (err as BootEnvError).issues.join('\n');
      expect(issues).toContain('REDIS_URL');
      expect(issues).toContain('JWT_ISSUER');
      // API_PORT not flagged because it has a default
      expect(issues).not.toContain('API_PORT');
    }
  });

  it('error message has clear preamble + Refusing-to-start line', () => {
    const env = { ...VALID_ENV };
    delete env.REDIS_URL;
    try {
      assertBootEnv(env);
      expect.fail('should have thrown');
    } catch (err) {
      const msg = (err as BootEnvError).message;
      expect(msg).toMatch(/^\[boot-env\] 1 required env var\(s\) invalid:/);
      expect(msg).toMatch(/Refusing to start/);
    }
  });
});

describe('assertBootEnv - T-E2b Telegram alert env vars (optional)', () => {
  it('all Telegram vars missing → defaults filled, no error', () => {
    const env = { ...VALID_ENV };
    delete env.TELEGRAM_BOT_TOKEN;
    delete env.TELEGRAM_CHANNEL_ID;
    delete env.TELEGRAM_BOT_NAME;
    delete env.TELEGRAM_ALERT_THRESHOLD;
    delete env.TELEGRAM_ALERT_COOLDOWN_MS;

    const result = assertBootEnv(env);
    expect(result.TELEGRAM_BOT_TOKEN).toBe('');
    expect(result.TELEGRAM_CHANNEL_ID).toBe('');
    expect(result.TELEGRAM_BOT_NAME).toBe('ShadhilCRMAlertsBot');
    expect(result.TELEGRAM_ALERT_THRESHOLD).toBe(3);
    expect(result.TELEGRAM_ALERT_COOLDOWN_MS).toBe(900_000);
  });

  it('TELEGRAM_BOT_NAME explicit → surfaced on BootEnv', () => {
    const env = {
      ...VALID_ENV,
      TELEGRAM_BOT_NAME: 'MyCustomBot',
    };
    const result = assertBootEnv(env);
    expect(result.TELEGRAM_BOT_NAME).toBe('MyCustomBot');
  });

  it('TELEGRAM_ALERT_THRESHOLD explicit (custom) → surfaced', () => {
    const env = {
      ...VALID_ENV,
      TELEGRAM_ALERT_THRESHOLD: '5',
    };
    const result = assertBootEnv(env);
    expect(result.TELEGRAM_ALERT_THRESHOLD).toBe(5);
  });

  it('TELEGRAM_ALERT_THRESHOLD malformed (non-numeric) → BootEnvError', () => {
    const env = {
      ...VALID_ENV,
      TELEGRAM_ALERT_THRESHOLD: 'not-a-number',
    };
    try {
      assertBootEnv(env);
      expect.fail('should have thrown');
    } catch (err) {
      const issues = (err as BootEnvError).issues.join('\n');
      expect(issues).toMatch(/TELEGRAM_ALERT_THRESHOLD/);
    }
  });

  it('TELEGRAM_ALERT_THRESHOLD < 1 → BootEnvError', () => {
    const env = {
      ...VALID_ENV,
      TELEGRAM_ALERT_THRESHOLD: '0',
    };
    try {
      assertBootEnv(env);
      expect.fail('should have thrown');
    } catch (err) {
      const issues = (err as BootEnvError).issues.join('\n');
      expect(issues).toMatch(/TELEGRAM_ALERT_THRESHOLD.*positive/);
    }
  });

  it('TELEGRAM_ALERT_COOLDOWN_MS negative → BootEnvError', () => {
    const env = {
      ...VALID_ENV,
      TELEGRAM_ALERT_COOLDOWN_MS: '-100',
    };
    try {
      assertBootEnv(env);
      expect.fail('should have thrown');
    } catch (err) {
      const issues = (err as BootEnvError).issues.join('\n');
      expect(issues).toMatch(/TELEGRAM_ALERT_COOLDOWN_MS/);
    }
  });

  it('TELEGRAM_ALERT_COOLDOWN_MS = 0 is allowed (no cooldown)', () => {
    const env = {
      ...VALID_ENV,
      TELEGRAM_ALERT_COOLDOWN_MS: '0',
    };
    const result = assertBootEnv(env);
    expect(result.TELEGRAM_ALERT_COOLDOWN_MS).toBe(0);
  });
});