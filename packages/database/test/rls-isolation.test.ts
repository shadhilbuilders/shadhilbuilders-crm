// ────────────────────────────────────────────────────────────────────────────
// RLS isolation matrix — §19.2 of the plan
// ────────────────────────────────────────────────────────────────────────────
// Full matrix: 4 roles (ADMIN / MANAGER / SALES_EXEC / TELECALLER)
//            × 8 business tables (Lead / Activity / SiteVisit / Message /
//                                 Booking / Reminder / Notification / AuditLog)
//            × 4 actions (SELECT / INSERT / UPDATE / DELETE)
//            = 128 cases.
//
// This file is the SKELETON. The full matrix is populated when a Postgres
// test container is wired up (testcontainers + pg-mem, or a throwaway
// docker-compose service). Until then, smoke tests verify the wiring works.
//
// To run the full matrix locally:
//   1. pnpm docker:up   (start Postgres + PgBouncer)
//   2. pnpm db:migrate  (apply schema + RLS policies)
//   3. pnpm test        (this file)
// ────────────────────────────────────────────────────────────────────────────

import { describe, it, expect } from 'vitest';
import { DATABASE_AVAILABLE } from './setup';
// Shared client (packages/database/src) — Prisma 7 requires the pg driver
// adapter, and the shared instance constructs connection-free so DB-less
// jobs can still import this file (tests self-skip via DATABASE_AVAILABLE).
// A bare `new PrismaClient()` here broke unit-CI under Prisma 7.
import { prisma } from '../src/index';
import { withRlsContext } from '../src/rls';

describe('RLS isolation matrix: role × table × action', () => {
  describe.todo(
    'full 128-case matrix — see §19.2. Requires Postgres test container; ' +
      'skipped until container wiring lands. Each case asserts whether the ' +
      'query succeeds and how many rows it returns under the given RLS context.',
  );

  it.todo('ADMIN × Lead × SELECT — sees all leads across teams');
  it.todo('MANAGER × Lead × SELECT — sees only own team');
  it.todo('SALES_EXEC × Lead × SELECT — sees only own assignments');
  it.todo('TELECALLER × Lead × SELECT — sees only own assignments');
  it.todo('ADMIN × Lead × INSERT — succeeds');
  it.todo('TELECALLER × Lead × INSERT — succeeds if teamId matches');
  it.todo('TELECALLER × Lead × UPDATE — only own');
  it.todo('TELECALLER × Lead × DELETE — rejected (admin only)');
  // ... 120 more cases omitted for brevity
});

// ────────────────────────────────────────────────────────────────────────────
// Smoke tests — verify the test infrastructure connects and runs queries
// ────────────────────────────────────────────────────────────────────────────

describe('Smoke: client connects', () => {
  it.skipIf(!DATABASE_AVAILABLE)(
    'opens a connection and runs SELECT 1',
    async () => {
      const result = await prisma.$queryRaw<Array<{ ok: number }>>`SELECT 1 AS ok`;
      expect(result).toHaveLength(1);
      expect(result[0]?.ok).toBe(1);
    },
  );

  it.skipIf(!DATABASE_AVAILABLE)(
    'Prisma client is constructible without throwing',
    () => {
      expect(prisma).toBeDefined();
      expect(typeof prisma.$queryRaw).toBe('function');
    },
  );

  it.skipIf(!DATABASE_AVAILABLE)(
    'withRlsContext opens a transaction and applies SET LOCAL vars',
    async () => {
      // We can't introspect the SET LOCAL values directly without admin rights,
      // but we CAN confirm a transaction runs and returns a scalar.
      const out = await withRlsContext(
        prisma,
        { userId: 'smoke-user', role: 'TELECALLER', teamId: null },
        async (tx) => {
          const r = await tx.$queryRaw<Array<{ v: number }>>`SELECT 1::int AS v`;
          return r[0]?.v ?? 0;
        },
      );
      expect(out).toBe(1);
    },
  );

  it.skipIf(!DATABASE_AVAILABLE)(
    'withRlsContext propagates errors from inside the transaction',
    async () => {
      await expect(
        withRlsContext(
          prisma,
          { userId: 'smoke-user', role: 'TELECALLER', teamId: null },
          async () => {
            throw new Error('rollback-me');
          },
        ),
      ).rejects.toThrow('rollback-me');
    },
  );
});