// Backfill guard (docs/planning/OWNER-ROLE-MIGRATION.md, W8).
//
// After the owner split, `prisma migrate deploy` connects as `shadhil_owner`, which owns
// the tables and does NOT bypass RLS. That makes DML in a migration lie to you. Measured
// on 2026-11-28 with a throwaway table the owner had just FORCEd:
//
//   INSERT into it   ERROR: new row violates row-level security policy
//   UPDATE on it     succeeds, touches ZERO rows
//
// The UPDATE case is the dangerous one: a backfill reports success and changes nothing. So
// a migration that touches rows has to borrow the bypass explicitly, and this test is what
// makes forgetting visible before a deploy does.
//
// Scope: only migrations from the cutover onwards. The nine INSERT and seventeen UPDATE
// migrations before it are historical truth, they are not editable while a production
// database exists, and a fresh install replays them as the bootstrap superuser before
// ownership is handed over. Flagging them would make this test fail forever for no reason.
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

// The first migration written after the owner split. Anything at or after it must be
// replayable against a FORCEd schema owned by a role that cannot bypass RLS.
const CUTOVER = '20261128120000';
const MIGRATIONS = join(__dirname, '..', 'prisma', 'migrations');

/** Comments carry the word INSERT in prose often enough to matter. */
function stripComments(sql: string): string {
  return sql.replace(/--[^\n]*/g, '').replace(/\/\*[\s\S]*?\*\//g, '');
}

const DML = /\b(?:INSERT\s+INTO|UPDATE\s+"|DELETE\s+FROM)\b/i;
const BORROWS_BYPASS = /SET\s+LOCAL\s+ROLE\s+shadhil_seed/i;

function migrationsFromCutover(): Array<{ name: string; body: string }> {
  return readdirSync(MIGRATIONS, { withFileTypes: true })
    .filter((d) => d.isDirectory() && d.name >= CUTOVER)
    .sort((a, b) => a.name.localeCompare(b.name))
    .flatMap((d) => {
      const file = join(MIGRATIONS, d.name, 'migration.sql');
      try {
        return [{ name: d.name, body: stripComments(readFileSync(file, 'utf8')) }];
      } catch {
        // A directory with no migration.sql is Prisma's problem, not this test's.
        return [];
      }
    });
}

describe('migration DML guard', () => {
  it('only lets a post-cutover migration touch rows while borrowing the bypass', () => {
    const offenders = migrationsFromCutover()
      .filter((m) => DML.test(m.body) && !BORROWS_BYPASS.test(m.body))
      .map((m) => m.name);

    // A migration that must write across tenants adds `SET LOCAL ROLE shadhil_seed;` at
    // the top of its migration.sql. Every other DML statement is a silent no-op against a
    // FORCEd schema owned by a role with NOBYPASSRLS.
    expect(offenders).toEqual([]);
  });

  it('scopes itself to the cutover, so the historical backfills are not flagged', () => {
    const scanned = migrationsFromCutover().map((m) => m.name);
    // An INSERT backfill from before the split, which a fresh install replays as the
    // bootstrap superuser. If the scope ever drifts, this test starts failing for a
    // migration nobody is allowed to edit.
    expect(scanned).not.toContain('20260909120000_project_members');
    expect(scanned.every((n) => n >= CUTOVER)).toBe(true);
  });
});
