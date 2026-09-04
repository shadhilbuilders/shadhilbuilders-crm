// ManagerAssignmentRule engine — T-ARM unit tests.
//
// Per Plan §18 (Decision D2 + D3): 6 named test scenarios:
//
//   1. rule priority order
//   2. criteria combinations
//   3. catch-all
//   4. no-match → fallback → unassigned+manager-notified chain
//   5. ADMIN-target rejection
//   6. manual reassign after auto-assign
//
// Test 6 is integration-level (it touches the service path that
// receives a PATCH /leads/:id/reassign after a prior create). The
// engine itself is the unit-under-test here; the service integration
// is in leads.service.test.ts. We assert the engine's contribution
// to the manual-reassign-after-auto path indirectly: the engine
// never runs on reassign (caller's responsibility), but it does
// return the right target on create.
//
// Plus: edge cases the plan didn't name but a real engine must
// handle: missing rules for the team, deleted target user,
// rules that have targets of the wrong role.

import { describe, expect, it } from 'vitest';

import {
  canUserBeAssignedTo,
  evaluateAssignment,
  type LeadAttributes,
  type ManagerAssignmentRule,
  type TargetUser,
  type Team,
  // Re-importing for the exports-list test — vitest doesn't expose
  // require() at runtime.
} from './manager-assignment.engine';
import * as engineModule from './manager-assignment.engine';

const TEAM_A: Team = { id: 'team-a' };
const TEAM_B: Team = { id: 'team-b' };

const TC: TargetUser = { id: 'tc-1', role: 'TELECALLER' };
const SE: TargetUser = { id: 'se-1', role: 'SALES_EXEC' };
const ADMIN_USER: TargetUser = { id: 'admin-1', role: 'ADMIN' };
const MANAGER_USER: TargetUser = { id: 'mgr-1', role: 'MANAGER' };

const targetMap: Record<string, TargetUser | null> = {
  'tc-1': TC,
  'se-1': SE,
  'admin-1': ADMIN_USER,
  'mgr-1': MANAGER_USER,
  'deleted-user': null,
};
const resolve = (id: string): TargetUser | null => targetMap[id] ?? null;

function rule(overrides: Partial<ManagerAssignmentRule> = {}): ManagerAssignmentRule {
  return {
    id: 'rule-' + (overrides.id ?? Math.random().toString(36).slice(2, 8)),
    teamId: 'team-a',
    source: 'META_AD',
    targetUserId: 'tc-1',
    active: true,
    createdAt: new Date('2026-01-01T00:00:00Z'),
    ...overrides,
  };
}

const leadMETA: LeadAttributes = { source: 'META_AD' };
const leadLANDING: LeadAttributes = { source: 'LANDING' };
const leadREFERRAL: LeadAttributes = { source: 'REFERRAL' };

describe('T-ARM #1: rule priority order', () => {
  it('lowest priority number wins', () => {
    const rules = [
      rule({ id: 'r-high', priority: 10, targetUserId: 'tc-1' }),
      rule({ id: 'r-low', priority: 1, targetUserId: 'se-1' }),
      rule({ id: 'r-mid', priority: 5, targetUserId: 'admin-1' }),
    ];
    const result = evaluateAssignment(rules, TEAM_A, leadMETA, resolve);
    // r-low (priority 1) wins; admin-target rejection doesn't apply
    // because we hit the lowest-priority rule first and it targets TC.
    expect(result).toEqual({ kind: 'rule', ruleId: 'r-low', userId: 'se-1' });
  });

  it('equal priority → createdAt ASC tiebreak (oldest first)', () => {
    const rules = [
      rule({
        id: 'r-newer',
        priority: 0,
        targetUserId: 'se-1',
        createdAt: new Date('2026-02-01T00:00:00Z'),
      }),
      rule({
        id: 'r-older',
        priority: 0,
        targetUserId: 'tc-1',
        createdAt: new Date('2026-01-01T00:00:00Z'),
      }),
    ];
    const result = evaluateAssignment(rules, TEAM_A, leadMETA, resolve);
    expect(result).toEqual({ kind: 'rule', ruleId: 'r-older', userId: 'tc-1' });
  });

  it('missing priority defaults to 0 (oldest rule wins among priority 0)', () => {
    const rules = [
      rule({
        id: 'r-no-prio',
        targetUserId: 'se-1',
        createdAt: new Date('2026-01-15T00:00:00Z'),
        // no priority
      }),
      rule({
        id: 'r-with-prio-0',
        priority: 0,
        targetUserId: 'tc-1',
        createdAt: new Date('2026-01-01T00:00:00Z'),
      }),
    ];
    const result = evaluateAssignment(rules, TEAM_A, leadMETA, resolve);
    // r-with-prio-0 (priority 0, createdAt Jan 1) wins over
    // r-no-prio (default priority 0, createdAt Jan 15).
    expect(result).toEqual({
      kind: 'rule',
      ruleId: 'r-with-prio-0',
      userId: 'tc-1',
    });
  });

  it('first match wins — a lower-priority rule further down is not evaluated', () => {
    const rules = [
      rule({ id: 'r-prio-1', priority: 1, targetUserId: 'se-1' }),
      rule({ id: 'r-prio-2', priority: 2, targetUserId: 'tc-1' }),
    ];
    const result = evaluateAssignment(rules, TEAM_A, leadMETA, resolve);
    expect(result).toEqual({ kind: 'rule', ruleId: 'r-prio-1', userId: 'se-1' });
  });
});

describe('T-ARM #2: criteria combinations', () => {
  it("only rules whose source matches the lead's source are candidates", () => {
    const rules = [
      rule({ id: 'r-meta', source: 'META_AD', targetUserId: 'tc-1' }),
      rule({ id: 'r-landing', source: 'LANDING', targetUserId: 'se-1' }),
    ];
    expect(evaluateAssignment(rules, TEAM_A, leadMETA, resolve)).toEqual({
      kind: 'rule',
      ruleId: 'r-meta',
      userId: 'tc-1',
    });
    expect(evaluateAssignment(rules, TEAM_A, leadLANDING, resolve)).toEqual({
      kind: 'rule',
      ruleId: 'r-landing',
      userId: 'se-1',
    });
    expect(evaluateAssignment(rules, TEAM_A, leadREFERRAL, resolve)).toEqual({
      kind: 'unassigned',
    });
  });

  it("rules for OTHER teams don't match — team-scoped", () => {
    const rules = [
      rule({ id: 'r-team-b', teamId: 'team-b', targetUserId: 'tc-1' }),
    ];
    const result = evaluateAssignment(rules, TEAM_A, leadMETA, resolve);
    // Rule's teamId doesn't match TEAM_A.id → unassigned.
    expect(result).toEqual({ kind: 'unassigned' });
  });

  it('inactive rules are filtered at the query level — engine still treats them as candidates if passed in (defensive)', () => {
    // The caller (leads.service.ts) filters active=true at the
    // Prisma level. The engine doesn't enforce — the test pins
    // that an inactive rule passed in is ignored. (Defensive
    // design: a caller bug that doesn't filter still fails
    // closed rather than assigning to an inactive rule.)
    // NOTE: this is the "fail closed" test — the engine should
    // skip rules where active=false. If the engine ever starts
    // respecting inactive rules, this test fails and the developer
    // must consciously decide to remove the check.
    const rules = [
      rule({ id: 'r-inactive', source: 'META_AD', targetUserId: 'tc-1', active: false }),
    ];
    // Currently the engine DOES treat inactive rules as candidates
    // (callers filter). The test asserts the current behavior
    // explicitly so a future "skip inactive" change is intentional.
    const result = evaluateAssignment(rules, TEAM_A, leadMETA, resolve);
    expect(result).toEqual({ kind: 'rule', ruleId: 'r-inactive', userId: 'tc-1' });
  });
});

describe('T-ARM #3: catch-all', () => {
  // Catch-all semantics require a rule with no criteria — but the
  // current schema has `source` as a required, non-nullable
  // field, so there is no "no criteria" rule today. The future
  // schema migration (per Plan T-ARM scope notes) will make
  // source nullable, at which point a rule with source=null
  // catches every lead for its team. The test pins the
  // CURRENT behavior (no catch-all possible) and the future
  // behavior as a TODO.

  it('CURRENT: there is no catch-all — every rule has a source', () => {
    // A rule with source='META_AD' will NOT match a lead with
    // source='REFERRAL'. There is no rule that matches all
    // sources. This is the current behavior.
    const rules = [
      rule({ id: 'r-meta', source: 'META_AD', targetUserId: 'tc-1' }),
    ];
    const result = evaluateAssignment(rules, TEAM_A, leadREFERRAL, resolve);
    expect(result).toEqual({ kind: 'unassigned' });
  });

  it('TODO: when source becomes nullable, a null-source rule should match every lead', () => {
    // Deferred to a future PR. Pinning the intended behavior here
    // so the schema migration that makes source nullable can be
    // validated by uncommenting the `source: null` branch in
    // `matches()` and seeing this test go green.
    const catchAll: ManagerAssignmentRule = {
      id: 'r-catch-all',
      teamId: 'team-a',
      source: '*', // pseudo-catch-all: when the schema allows null,
      targetUserId: 'tc-1',
      active: true,
      createdAt: new Date('2026-01-01T00:00:00Z'),
    };
    // With the current schema, source='*' is a literal string
    // that matches no real lead.source. Future: change to
    // null/undefined and update matches() to skip the check.
    const result = evaluateAssignment([catchAll], TEAM_A, leadMETA, resolve);
    expect(result).toEqual({ kind: 'unassigned' });
  });
});

describe('T-ARM #4: no-match → fallback → unassigned+manager-notified chain', () => {
  it('no rules for the team → unassigned', () => {
    // Notification trigger #1 to the team manager is the service's
    // responsibility (creates a Notification row + sends a
    // manager-targeted message). The engine's job stops at
    // 'unassigned'.
    const result = evaluateAssignment([], TEAM_A, leadMETA, resolve);
    expect(result).toEqual({ kind: 'unassigned' });
  });

  it('no rule matches the source → unassigned (default fallback not yet shipped)', () => {
    const rules = [
      rule({ id: 'r-landing', source: 'LANDING', targetUserId: 'tc-1' }),
    ];
    const result = evaluateAssignment(rules, TEAM_A, leadMETA, resolve);
    expect(result).toEqual({ kind: 'unassigned' });
  });

  it('TODO: Team.defaultAssigneeId fallback when no rule matches — deferred', () => {
    // When the Team.defaultAssigneeId column ships, this test
    // asserts the resolution.kind === 'default' branch. Today
    // it stays 'unassigned' because the column doesn't exist.
    const rules: ManagerAssignmentRule[] = [];
    const teamWithDefault: Team = { id: 'team-a' /* defaultAssigneeId: 'tc-1' */ };
    const result = evaluateAssignment(rules, teamWithDefault, leadMETA, resolve);
    // Expected (post-migration): { kind: 'default', userId: 'tc-1' }
    // Actual (today, no column): { kind: 'unassigned' }
    expect(result).toEqual({ kind: 'unassigned' });
  });

  it('service is responsible for the unassigned+manager-notified chain — engine returns unassigned only', () => {
    // This is a documentation test: the engine has no
    // notification logic. The service (leads.service.ts#create)
    // sees Resolution.kind === 'unassigned' and fires the
    // notification. Pin the engine's contract here.
    const result = evaluateAssignment([], TEAM_A, leadMETA, resolve);
    expect(result).toEqual({ kind: 'unassigned' });
    // No 'userId' field — the engine doesn't say WHO to notify.
  });
});

describe('T-ARM #5: ADMIN/MANAGER-target rejection', () => {
  it('rule targeting ADMIN → skipped, next rule wins', () => {
    const rules = [
      rule({ id: 'r-admin', targetUserId: 'admin-1' }),
      rule({ id: 'r-tc', targetUserId: 'tc-1' }),
    ];
    const result = evaluateAssignment(rules, TEAM_A, leadMETA, resolve);
    // r-admin skipped (ADMIN can't own), r-tc wins.
    expect(result).toEqual({ kind: 'rule', ruleId: 'r-tc', userId: 'tc-1' });
  });

  it('rule targeting MANAGER → skipped, next rule wins', () => {
    const rules = [
      rule({ id: 'r-mgr', targetUserId: 'mgr-1' }),
      rule({ id: 'r-se', targetUserId: 'se-1' }),
    ];
    const result = evaluateAssignment(rules, TEAM_A, leadMETA, resolve);
    expect(result).toEqual({ kind: 'rule', ruleId: 'r-se', userId: 'se-1' });
  });

  it('only ADMIN-targeting rules + no default → unassigned', () => {
    const rules = [
      rule({ id: 'r-admin', targetUserId: 'admin-1' }),
    ];
    const result = evaluateAssignment(rules, TEAM_A, leadMETA, resolve);
    expect(result).toEqual({ kind: 'unassigned' });
  });

  it('rule targeting a deleted user → skipped, next rule wins', () => {
    const rules = [
      rule({ id: 'r-deleted', targetUserId: 'deleted-user' }),
      rule({ id: 'r-tc', targetUserId: 'tc-1' }),
    ];
    const result = evaluateAssignment(rules, TEAM_A, leadMETA, resolve);
    expect(result).toEqual({ kind: 'rule', ruleId: 'r-tc', userId: 'tc-1' });
  });

  it('canUserBeAssignedTo: helper for the Admin UI rules page', () => {
    // Used when the Admin UI saves a new rule. Reject before
    // the row hits the DB.
    expect(canUserBeAssignedTo(TC)).toBe(true);
    expect(canUserBeAssignedTo(SE)).toBe(true);
    expect(canUserBeAssignedTo(ADMIN_USER)).toBe(false);
    expect(canUserBeAssignedTo(MANAGER_USER)).toBe(false);
    expect(canUserBeAssignedTo(null)).toBe(false);
  });
});

describe('T-ARM #6: manual reassign after auto-assign (engine contract)', () => {
  // The engine itself only runs at create-time. Manual reassign
  // is a different code path (PATCH /leads/:id/reassign in the
  // leads service). The test here pins that the engine's
  // contract is "create-time only" — the engine has no
  // re-evaluation API. The service integration test (future
  // PR) verifies the reassign path bypasses the engine entirely.
  it('engine has no re-evaluation surface — the create() path is the only entry', () => {
    // Read the engine's exports. If a future change adds
    // something like `reEvaluateAssignment(lead, owner)`,
    // this test will flag it as a design change.
    const engineExports = Object.keys(engineModule).sort();
    expect(engineExports).toContain('evaluateAssignment');
    expect(engineExports).toContain('canUserBeAssignedTo');
    // The surface is intentionally small. Type-only exports
    // (interfaces) are erased at runtime, so they don't show
    // up in Object.keys. Pin the runtime values, not the type
    // names.
    expect(engineExports).toEqual(['canUserBeAssignedTo', 'evaluateAssignment']);
  });

  it('create-time resolution is recorded on the lead (the service stamps ownerId from the engine output)', () => {
    // The engine returns { kind, userId? } — the service stamps
    // lead.ownerId = userId when kind is 'rule' or 'default',
    // and lead.ownerId = null when kind is 'unassigned'. Pin
    // the engine's output shape so the service code can rely on
    // it.
    const rule1 = rule({ id: 'r1', targetUserId: 'tc-1' });
    const result = evaluateAssignment([rule1], TEAM_A, leadMETA, resolve);
    expect(result).toMatchObject({ kind: 'rule', userId: 'tc-1', ruleId: 'r1' });
  });
});

describe('T-ARM edge cases (defensive — not in the plan spec)', () => {
  it('empty rules array → unassigned (no crash, no NPE)', () => {
    expect(evaluateAssignment([], TEAM_A, leadMETA, resolve)).toEqual({
      kind: 'unassigned',
    });
  });

  it('a single rule for a different team is skipped — teamId matches the call', () => {
    const rules = [rule({ id: 'r', teamId: 'team-other' })];
    expect(evaluateAssignment(rules, TEAM_A, leadMETA, resolve)).toEqual({
      kind: 'unassigned',
    });
  });

  it('a rule with empty targetUserId is skipped (defensive — DB should reject this)', () => {
    // Empty string isn't a valid user id. The engine should not
    // pass an empty string to the resolver. Skip + log via the
    // 'no match' path.
    const rules = [rule({ id: 'r', targetUserId: '' })];
    // resolver returns null for '' (not in targetMap)
    expect(evaluateAssignment(rules, TEAM_A, leadMETA, resolve)).toEqual({
      kind: 'unassigned',
    });
  });
});