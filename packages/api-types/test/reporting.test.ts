import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

import { RoleSchema } from '../src/enums';
import {
  REPORTING_TARGET_BY_ROLE,
  hasReportingLine,
  reportingTargetFor,
  reportsToTeamManager,
} from '../src/reporting';

// T-REPORTS-TO (2026-11-07): this file exists because ENGINEER was silently
// missing from the reporting rule for three weeks. The rule used to be written
// as a bare `role === 'TELECALLER' || role === 'SALES_EXEC'` union at three
// call sites, which TypeScript cannot check for completeness. These tests walk
// EVERY Role so the next role that forgets a reporting line goes red here
// instead of rendering a blank column in production.

describe('reportingTargetFor - every Role has a decided reporting line', () => {
  // The explicit expectation table. If a new role is added and this table is
  // not updated, the "covers every role" test below fails.
  const EXPECTED: ReadonlyArray<[string, string]> = [
    ['OWNER', 'NONE'],
    ['ADMIN', 'ORG_OWNER'],
    ['MANAGER', 'ORG_OWNER'],
    ['SALES_EXEC', 'TEAM_MANAGER'],
    ['TELECALLER', 'TEAM_MANAGER'],
    ['ENGINEER', 'TEAM_MANAGER'],
    ['CUSTOMER', 'NONE'],
  ];

  it('covers every role in RoleSchema - no role may be added without a decision', () => {
    const covered = EXPECTED.map(([role]) => role).sort();
    const all = [...RoleSchema.options].sort();
    expect(covered).toEqual(all);
  });

  it.each(EXPECTED)('%s reports via %s', (role, expected) => {
    expect(reportingTargetFor(role as never)).toBe(expected);
  });

  it('is total over every RoleSchema value (never undefined)', () => {
    for (const role of RoleSchema.options) {
      expect(REPORTING_TARGET_BY_ROLE[role]).toBeDefined();
      expect(['TEAM_MANAGER', 'ORG_OWNER', 'NONE']).toContain(REPORTING_TARGET_BY_ROLE[role]);
    }
  });
});

describe('RoleSchema matches the Prisma Role enum', () => {
  // The rule is only as good as the enum underneath it. RoleSchema is
  // hand-maintained in lockstep with schema.prisma; this pins that.
  it('has exactly the Prisma Role values', () => {
    const schema = readFileSync(join(__dirname, '../../database/prisma/schema.prisma'), 'utf8');
    const block = /enum Role \{([\s\S]*?)\}/.exec(schema)?.[1] ?? '';
    const prisma = block
      .split('\n')
      .map((line) => line.replace(/\/\/.*$/, '').trim())
      .filter(Boolean)
      .sort();
    expect([...RoleSchema.options].sort()).toEqual(prisma);
  });
});

describe('reportsToTeamManager - the assignable, team-derived roles', () => {
  it.each(['TELECALLER', 'SALES_EXEC', 'ENGINEER'] as const)('%s is team-manager derived', (role) => {
    expect(reportsToTeamManager(role)).toBe(true);
  });

  it.each(['OWNER', 'ADMIN', 'MANAGER', 'CUSTOMER'] as const)(
    '%s is NOT team-manager derived',
    (role) => {
      expect(reportsToTeamManager(role)).toBe(false);
    },
  );
});

describe('hasReportingLine - who gets a "Reports to" row at all', () => {
  it.each(['ADMIN', 'MANAGER', 'SALES_EXEC', 'TELECALLER', 'ENGINEER'] as const)(
    '%s has a reporting line',
    (role) => {
      expect(hasReportingLine(role)).toBe(true);
    },
  );

  it('OWNER reports to nobody', () => {
    expect(hasReportingLine('OWNER')).toBe(false);
  });

  // Regression: `showReportsTo = role !== 'OWNER'` rendered a bogus
  // "No manager assigned" row for CUSTOMER buyers on the user detail page.
  it('CUSTOMER reports to nobody (buyer portal, not staff)', () => {
    expect(hasReportingLine('CUSTOMER')).toBe(false);
  });
});
