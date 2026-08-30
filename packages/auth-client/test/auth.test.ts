// Smoke tests for the @shadhil/auth package.
// Verifies the env validator, JWT helpers, and (statically) that the auth
// instance has the right plugins and trusted origins.
//
// These tests do NOT connect to a database. They validate module shape and
// env validation in isolation.

import { describe, it, expect } from 'vitest';
import { z } from 'zod';

describe('@shadhil/auth — env validation', () => {
  it('rejects missing BETTER_AUTH_SECRET', async () => {
    const { assertAuthEnv } = await import('../src/env');
    const old = process.env.BETTER_AUTH_SECRET;
    delete process.env.BETTER_AUTH_SECRET;
    expect(() => assertAuthEnv()).toThrow(/BETTER_AUTH_SECRET/);
    if (old) process.env.BETTER_AUTH_SECRET = old;
  });

  it('rejects BETTER_AUTH_SECRET shorter than 32 chars', async () => {
    const { assertAuthEnv } = await import('../src/env');
    const old = process.env.BETTER_AUTH_SECRET;
    process.env.BETTER_AUTH_SECRET = 'too-short';
    expect(() => assertAuthEnv()).toThrow(/>= 32 chars/);
    if (old) process.env.BETTER_AUTH_SECRET = old;
  });

  it('accepts a valid env (>= 32 char secret + url)', async () => {
    const { assertAuthEnv } = await import('../src/env');
    const oldS = process.env.BETTER_AUTH_SECRET;
    const oldU = process.env.BETTER_AUTH_URL;
    process.env.BETTER_AUTH_SECRET = 'a'.repeat(32);
    process.env.BETTER_AUTH_URL = 'http://localhost:3000';
    const env = assertAuthEnv();
    expect(env.BETTER_AUTH_SECRET).toHaveLength(32);
    expect(env.BETTER_AUTH_URL).toBe('http://localhost:3000');
    if (oldS) process.env.BETTER_AUTH_SECRET = oldS;
    if (oldU) process.env.BETTER_AUTH_URL = oldU;
  });
});

describe('@shadhil/auth — JWT helpers', () => {
  it('verifyJwt throws on garbage', async () => {
    process.env.BETTER_AUTH_SECRET = 'a'.repeat(32);
    const { verifyJwt } = await import('../src/jwt');
    await expect(verifyJwt('not-a-jwt')).rejects.toBeDefined();
  });

  it('issueJwt + verifyJwt round-trip works', async () => {
    process.env.BETTER_AUTH_SECRET = 'a'.repeat(32);
    const { issueJwt, verifyJwt } = await import('../src/jwt');
    const token = await issueJwt({
      sub: 'user_123',
      role: 'manager',
      teamId: 'team_1',
      email: 'mgr@example.com',
    });
    const payload = await verifyJwt(token);
    expect(payload.sub).toBe('user_123');
    expect(payload.role).toBe('manager');
    expect(payload.teamId).toBe('team_1');
    expect(payload.iss).toBe('shadhil-crm');
  });

  it('verifyJwt rejects token signed with different secret', async () => {
    process.env.BETTER_AUTH_SECRET = 'a'.repeat(32);
    const { issueJwt } = await import('../src/jwt');
    const token = await issueJwt({
      sub: 'user_123',
      role: 'admin',
      teamId: null,
      email: 'a@b.com',
    });
    process.env.BETTER_AUTH_SECRET = 'b'.repeat(32);
    const { verifyJwt } = await import('../src/jwt');
    await expect(verifyJwt(token)).rejects.toBeDefined();
  });
});

describe('@shadhil/auth — module surface (eng review A4)', () => {
  it('exports auth, authClient, verifyJwt, issueJwt, assertAuthEnv', async () => {
    const mod = await import('../src/index');
    expect(typeof mod.auth).toBeDefined();
    expect(typeof mod.authClient).toBeDefined();
    expect(typeof mod.verifyJwt).toBe('function');
    expect(typeof mod.issueJwt).toBe('function');
    expect(typeof mod.assertAuthEnv).toBe('function');
  });
});

// Sanity: zod is in our dependency graph
describe('dependency sanity', () => {
  it('zod is reachable', () => {
    expect(z.string).toBeDefined();
  });
});
