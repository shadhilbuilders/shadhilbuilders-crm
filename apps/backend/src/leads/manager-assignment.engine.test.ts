// ManagerAssignmentRule engine - T-ARM-SCHEMA unit tests.
//
// Per Plan §18 (Decision D2 + D3), the Week-5 engine covers:
//   1. rule priority order
//   2. criteria combinations (projectId / phaseId / language / region)
//   3. team.defaultAssigneeId fallback
//   4. no-match → fallback (actor.sub)
//   5. ADMIN/MANAGER-target rejection
//   6. inactive rule excluded
//   7. manual reassign after auto-assign (the engine is create-time only)
//
// Plus: edge cases the plan didn't name but a real engine must
// handle: missing rules for the team, deleted target user,
// rules that have targets of the wrong role.

import { describe, expect, it } from 'vitest';

import {
  canUserBeAssignedTo,
  evaluateAssignment,
  extractCriteriaFromSource,
  type LeadAttributes,
  type ManagerAssignmentRule,
  type TargetUser,
  type Team,
} from './manager-assignment.engine';
import * as engineModule from './manager-assignment.engine';

const TEAM_A: Team = { id: 'team-a' };
const TEAM_B: Team = { id: 'team-b' };
const TEAM_A_WITH_DEFAULT: Team = { id: 'team-a', defaultAssigneeId: 'se-1' };

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

// Default fallback user - the service passes actor.sub in production,
// but the engine tests don't care about the actor identity; any
// stable string works.
const FALLBACK = 'actor-sub';

describe('T-ARM #1: rule priority order', () => {
  it('lowest priority number wins', () => {
    const rules = [
      rule({ id: 'r-high', priority: 10, targetUserId: 'tc-1' }),
      rule({ id: 'r-low', priority: 1, targetUserId: 'se-1' }),
      rule({ id: 'r-mid', priority: 5, targetUserId: 'admin-1' }),
    ];
    const result = evaluateAssignment(rules, TEAM_A, leadMETA, resolve, FALLBACK);
    // r-low (priority 1) wins; admin-target rejection doesn't apply
    // because we hit the lowest-priority rule first and it targets TC.
    expect(result).toEqual({
      kind: 'rule',
      ruleId: 'r-low',
      userId: 'se-1',
      priority: 1,
    });
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
    const result = evaluateAssignment(rules, TEAM_A, leadMETA, resolve, FALLBACK);
    expect(result).toEqual({
      kind: 'rule',
      ruleId: 'r-older',
      userId: 'tc-1',
      priority: 0,
    });
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
    const result = evaluateAssignment(rules, TEAM_A, leadMETA, resolve, FALLBACK);
    expect(result).toEqual({
      kind: 'rule',
      ruleId: 'r-with-prio-0',
      userId: 'tc-1',
      priority: 0,
    });
  });

  it('first match wins - a lower-priority rule further down is not evaluated', () => {
    const rules = [
      rule({ id: 'r-prio-1', priority: 1, targetUserId: 'se-1' }),
      rule({ id: 'r-prio-2', priority: 2, targetUserId: 'tc-1' }),
    ];
    const result = evaluateAssignment(rules, TEAM_A, leadMETA, resolve, FALLBACK);
    expect(result).toEqual({
      kind: 'rule',
      ruleId: 'r-prio-1',
      userId: 'se-1',
      priority: 1,
    });
  });
});

describe('T-ARM #2: criteria combinations', () => {
  it("only rules whose source matches the lead's source are candidates", () => {
    const rules = [
      rule({ id: 'r-meta', source: 'META_AD', targetUserId: 'tc-1' }),
      rule({ id: 'r-landing', source: 'LANDING', targetUserId: 'se-1' }),
    ];
    expect(evaluateAssignment(rules, TEAM_A, leadMETA, resolve, FALLBACK)).toEqual({
      kind: 'rule',
      ruleId: 'r-meta',
      userId: 'tc-1',
      priority: 0,
    });
    expect(evaluateAssignment(rules, TEAM_A, leadLANDING, resolve, FALLBACK)).toEqual({
      kind: 'rule',
      ruleId: 'r-landing',
      userId: 'se-1',
      priority: 0,
    });
    expect(evaluateAssignment(rules, TEAM_A, leadREFERRAL, resolve, FALLBACK)).toEqual({
      kind: 'fallback',
      userId: FALLBACK,
    });
  });

  it('rule with projectId filter that does not match lead → excluded', () => {
    // Two rules with the same source + priority. The lower-id one has
    // projectId="A" (won't match lead with no projectId); the higher-id
    // one has projectId=null (wildcard). Only the wildcard one fires.
    const rules = [
      rule({
        id: 'r-proj-a',
        source: 'META_AD',
        projectId: 'A',
        targetUserId: 'tc-1',
        createdAt: new Date('2026-01-01T00:00:00Z'),
      }),
      rule({
        id: 'r-wildcard',
        source: 'META_AD',
        projectId: null,
        targetUserId: 'se-1',
        createdAt: new Date('2026-01-02T00:00:00Z'),
      }),
    ];
    const leadNoProject: LeadAttributes = { source: 'META_AD', projectId: null };
    const result = evaluateAssignment(rules, TEAM_A, leadNoProject, resolve, FALLBACK);
    expect(result).toEqual({
      kind: 'rule',
      ruleId: 'r-wildcard',
      userId: 'se-1',
      priority: 0,
    });
  });

  it('rule with projectId filter that DOES match lead → fires', () => {
    const rules = [
      rule({
        id: 'r-proj-a',
        source: 'META_AD',
        projectId: 'A',
        targetUserId: 'tc-1',
        priority: 10,
      }),
      rule({
        id: 'r-wildcard',
        source: 'META_AD',
        projectId: null,
        targetUserId: 'se-1',
        priority: 20,
      }),
    ];
    const leadOnA: LeadAttributes = { source: 'META_AD', projectId: 'A' };
    const result = evaluateAssignment(rules, TEAM_A, leadOnA, resolve, FALLBACK);
    // r-proj-a wins (lower priority AND criteria match)
    expect(result).toEqual({
      kind: 'rule',
      ruleId: 'r-proj-a',
      userId: 'tc-1',
      priority: 10,
    });
  });

  it('language / region criteria - null on rule is wildcard; set value must match exactly', () => {
    const rules = [
      rule({ id: 'r-hi-tn', language: 'hi', region: 'IN-TN', targetUserId: 'tc-1' }),
      rule({ id: 'r-wildcard', targetUserId: 'se-1' }),
    ];
    // Lead in hi/IN-TN → r-hi-tn wins (priority tie → createdAt ASC: r-hi-tn is older).
    expect(
      evaluateAssignment(
        rules,
        TEAM_A,
        { source: 'META_AD', language: 'hi', region: 'IN-TN' },
        resolve,
        FALLBACK,
      ),
    ).toEqual({ kind: 'rule', ruleId: 'r-hi-tn', userId: 'tc-1', priority: 0 });
    // Lead in en/IN-KA → r-hi-tn excluded (language mismatch) → r-wildcard wins.
    expect(
      evaluateAssignment(
        rules,
        TEAM_A,
        { source: 'META_AD', language: 'en', region: 'IN-KA' },
        resolve,
        FALLBACK,
      ),
    ).toEqual({ kind: 'rule', ruleId: 'r-wildcard', userId: 'se-1', priority: 0 });
    // Lead with no language/region → r-hi-tn excluded (lead.language missing) → r-wildcard.
    expect(
      evaluateAssignment(rules, TEAM_A, leadMETA, resolve, FALLBACK),
    ).toEqual({ kind: 'rule', ruleId: 'r-wildcard', userId: 'se-1', priority: 0 });
  });

  it('rules for OTHER teams do not match - team-scoped', () => {
    const rules = [
      rule({ id: 'r-team-b', teamId: 'team-b', targetUserId: 'tc-1' }),
    ];
    const result = evaluateAssignment(rules, TEAM_A, leadMETA, resolve, FALLBACK);
    expect(result).toEqual({ kind: 'fallback', userId: FALLBACK });
  });

  it('inactive rules are filtered out at the engine level (defensive - caller filters)', () => {
    const rules = [
      rule({ id: 'r-inactive', active: false, targetUserId: 'tc-1' }),
      rule({ id: 'r-active', targetUserId: 'se-1' }),
    ];
    expect(evaluateAssignment(rules, TEAM_A, leadMETA, resolve, FALLBACK)).toEqual({
      kind: 'rule',
      ruleId: 'r-active',
      userId: 'se-1',
      priority: 0,
    });
  });
});

describe('T-ARM #3: team.defaultAssigneeId fallback', () => {
  it('no rules match → team default wins when set + target is assignable', () => {
    // No rules at all → falls through to team default.
    expect(evaluateAssignment([], TEAM_A_WITH_DEFAULT, leadMETA, resolve, FALLBACK)).toEqual({
      kind: 'team-default',
      userId: 'se-1',
    });
  });

  it('rules exist but none match (wrong source) → team default wins', () => {
    const rules = [rule({ id: 'r-meta', source: 'META_AD', targetUserId: 'tc-1' })];
    // Lead has source REFERRAL - no rule matches → team default.
    expect(evaluateAssignment(rules, TEAM_A_WITH_DEFAULT, leadREFERRAL, resolve, FALLBACK)).toEqual({
      kind: 'team-default',
      userId: 'se-1',
    });
  });

  it('team default pointing at ADMIN → rejected, falls through to actor fallback', () => {
    const teamAdminDefault: Team = { id: 'team-a', defaultAssigneeId: 'admin-1' };
    const result = evaluateAssignment([], teamAdminDefault, leadMETA, resolve, FALLBACK);
    expect(result).toEqual({ kind: 'fallback', userId: FALLBACK });
  });

  it('team default pointing at a deleted user → falls through to fallback', () => {
    const teamDeletedDefault: Team = {
      id: 'team-a',
      defaultAssigneeId: 'deleted-user',
    };
    expect(
      evaluateAssignment([], teamDeletedDefault, leadMETA, resolve, FALLBACK),
    ).toEqual({ kind: 'fallback', userId: FALLBACK });
  });

  it('no team default AND no matching rule → actor fallback', () => {
    // TEAM_A has no defaultAssigneeId; rules have wrong source.
    const rules = [rule({ id: 'r-landing', source: 'LANDING' })];
    expect(evaluateAssignment(rules, TEAM_A, leadMETA, resolve, FALLBACK)).toEqual({
      kind: 'fallback',
      userId: FALLBACK,
    });
  });

  it('matching rule wins over team default (rule priority beats default)', () => {
    const rules = [rule({ id: 'r-meta', source: 'META_AD', targetUserId: 'tc-1' })];
    expect(evaluateAssignment(rules, TEAM_A_WITH_DEFAULT, leadMETA, resolve, FALLBACK)).toEqual({
      kind: 'rule',
      ruleId: 'r-meta',
      userId: 'tc-1',
      priority: 0,
    });
  });
});

describe('T-ARM #4: no-match → fallback chain', () => {
  it('returns the fallback user when no rule AND no team default', () => {
    expect(evaluateAssignment([], TEAM_A, leadMETA, resolve, 'specific-actor-id')).toEqual({
      kind: 'fallback',
      userId: 'specific-actor-id',
    });
  });

  it('engine does NOT call the notification side - that is the service responsibility', () => {
    // Pure-function contract: no callbacks other than the synchronous
    // target resolver. Pin the surface so a future change doesn't
    // accidentally drag in side effects (Notification.create, etc.).
    const engineExports = Object.keys(engineModule).sort();
    expect(engineExports).toContain('evaluateAssignment');
    expect(engineExports).toContain('canUserBeAssignedTo');
    expect(engineExports).toContain('extractCriteriaFromSource');
  });
});

describe('T-ARM #5: ADMIN/MANAGER-target rejection', () => {
  it('rule targeting ADMIN → skipped, next rule wins', () => {
    const rules = [
      rule({ id: 'r-admin', targetUserId: 'admin-1' }),
      rule({ id: 'r-tc', targetUserId: 'tc-1' }),
    ];
    const result = evaluateAssignment(rules, TEAM_A, leadMETA, resolve, FALLBACK);
    expect(result).toEqual({ kind: 'rule', ruleId: 'r-tc', userId: 'tc-1', priority: 0 });
  });

  it('rule targeting MANAGER → skipped, next rule wins', () => {
    const rules = [
      rule({ id: 'r-mgr', targetUserId: 'mgr-1' }),
      rule({ id: 'r-se', targetUserId: 'se-1' }),
    ];
    const result = evaluateAssignment(rules, TEAM_A, leadMETA, resolve, FALLBACK);
    expect(result).toEqual({ kind: 'rule', ruleId: 'r-se', userId: 'se-1', priority: 0 });
  });

  it('only ADMIN-targeting rules + no default → fallback', () => {
    const rules = [
      rule({ id: 'r-admin', targetUserId: 'admin-1' }),
    ];
    expect(evaluateAssignment(rules, TEAM_A, leadMETA, resolve, FALLBACK)).toEqual({
      kind: 'fallback',
      userId: FALLBACK,
    });
  });

  it('rule targeting a deleted user → skipped, next rule wins', () => {
    const rules = [
      rule({ id: 'r-deleted', targetUserId: 'deleted-user' }),
      rule({ id: 'r-tc', targetUserId: 'tc-1' }),
    ];
    const result = evaluateAssignment(rules, TEAM_A, leadMETA, resolve, FALLBACK);
    expect(result).toEqual({ kind: 'rule', ruleId: 'r-tc', userId: 'tc-1', priority: 0 });
  });

  it('canUserBeAssignedTo: helper for the Admin UI rules page', () => {
    expect(canUserBeAssignedTo(TC)).toBe(true);
    expect(canUserBeAssignedTo(SE)).toBe(true);
    expect(canUserBeAssignedTo(ADMIN_USER)).toBe(false);
    expect(canUserBeAssignedTo(MANAGER_USER)).toBe(false);
    expect(canUserBeAssignedTo(null)).toBe(false);
  });
});

describe('T-ARM #6: inactive rule excluded', () => {
  it('inactive rule → skipped entirely (no audit row, no return)', () => {
    const rules = [
      rule({ id: 'r-inactive', active: false, targetUserId: 'tc-1' }),
    ];
    // With no team default either → fallback.
    expect(evaluateAssignment(rules, TEAM_A, leadMETA, resolve, FALLBACK)).toEqual({
      kind: 'fallback',
      userId: FALLBACK,
    });
  });

  it('active rule wins over inactive rule when both match', () => {
    const rules = [
      rule({
        id: 'r-inactive',
        active: false,
        priority: 1,
        targetUserId: 'tc-1',
      }),
      rule({ id: 'r-active', priority: 10, targetUserId: 'se-1' }),
    ];
    expect(evaluateAssignment(rules, TEAM_A, leadMETA, resolve, FALLBACK)).toEqual({
      kind: 'rule',
      ruleId: 'r-active',
      userId: 'se-1',
      priority: 10,
    });
  });
});

describe('T-ARM #7: manual reassign after auto-assign (engine contract)', () => {
  it('engine has no re-evaluation surface - create() is the only entry', () => {
    const engineExports = Object.keys(engineModule).sort();
    // Pin the runtime surface. Type-only exports (interfaces) are
    // erased at runtime so they don't appear here. If a future change
    // adds something like `reEvaluateAssignment(lead, owner)`, this
    // test will flag it as a design change.
    expect(engineExports).toEqual([
      'canUserBeAssignedTo',
      'evaluateAssignment',
      'extractCriteriaFromSource',
    ]);
  });

  it('create-time resolution is recorded on the lead (service stamps ownerId from engine output)', () => {
    const rule1 = rule({ id: 'r1', targetUserId: 'tc-1' });
    const result = evaluateAssignment([rule1], TEAM_A, leadMETA, resolve, FALLBACK);
    expect(result).toMatchObject({ kind: 'rule', userId: 'tc-1', ruleId: 'r1' });
  });
});

describe('extractCriteriaFromSource - T-ARM Week-8 placeholder', () => {
  it('returns empty object for today\'s free-form sources (META_AD / LANDING / REFERRAL / WALK_IN)', () => {
    expect(extractCriteriaFromSource('META_AD')).toEqual({});
    expect(extractCriteriaFromSource('LANDING')).toEqual({});
    expect(extractCriteriaFromSource('REFERRAL')).toEqual({});
    expect(extractCriteriaFromSource('WALK_IN')).toEqual({});
    expect(extractCriteriaFromSource('')).toEqual({});
    expect(extractCriteriaFromSource('some-future-source')).toEqual({});
  });

  it('is a pure function - same input always yields the same output', () => {
    const a = extractCriteriaFromSource('META_AD');
    const b = extractCriteriaFromSource('META_AD');
    expect(a).toEqual(b);
  });
});

describe('T-ARM edge cases (defensive - not in the plan spec)', () => {
  it('empty rules array + no team default → fallback (no crash, no NPE)', () => {
    expect(evaluateAssignment([], TEAM_A, leadMETA, resolve, FALLBACK)).toEqual({
      kind: 'fallback',
      userId: FALLBACK,
    });
  });

  it('a single rule for a different team is skipped - teamId must match the call', () => {
    const rules = [rule({ id: 'r', teamId: 'team-other' })];
    expect(evaluateAssignment(rules, TEAM_A, leadMETA, resolve, FALLBACK)).toEqual({
      kind: 'fallback',
      userId: FALLBACK,
    });
  });

  it('a rule with empty targetUserId is skipped (defensive - DB should reject this)', () => {
    const rules = [rule({ id: 'r', targetUserId: '' })];
    expect(evaluateAssignment(rules, TEAM_A, leadMETA, resolve, FALLBACK)).toEqual({
      kind: 'fallback',
      userId: FALLBACK,
    });
  });
});