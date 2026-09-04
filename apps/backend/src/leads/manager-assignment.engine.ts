// ManagerAssignmentRule engine — auto-routing for new leads.
//
// Per Plan §18 (Decision D2 ratified 2026-08-31): every NEW lead is
// routed by an evaluation chain at creation time. The engine is
// pure — no DB / no Nest / no Prisma. The service (leads.service.ts
// #create) feeds in the team + lead attributes; the engine returns
// the target user (or null); the service persists.
//
// Schema (current, 2026-09-03): ManagerAssignmentRule has
//   teamId, source, targetUserId, active
// The plan's full schema also has `priority`, `projectId`,
// `phaseId`, `language`, `region`. Those columns ship in a future
// schema migration; the engine is structured so adding them is a
// non-breaking change (criteria match is keyed by an extensible
// criteria object).
//
// Decision flow (per D2 + the Implementation-Plan §18 spec):
//
//   ┌─────────────────────────────────────┐
//   │ active=true rules for the team,     │
//   │ sorted by (priority ASC, createdAt  │
//   │ ASC) — first match wins.            │
//   └──────────────┬──────────────────────┘
//                  │
//                  ▼
//   ┌─────────────────────────────────────┐
//   │ For each rule: does the lead match? │
//   │   source (exact match, required)    │
//   │   projectId / phaseId / language /  │
//   │     region (when the columns ship)  │
//   │ If YES → return rule.targetUserId,  │
//   │   but only if the target is         │
//   │   TELECALLER or SALES_EXEC (ADMIN   │
//   │   / MANAGER are rejected — they     │
//   │   don't own leads directly).        │
//   └──────────────┬──────────────────────┘
//                  │ no match
//                  ▼
//   ┌─────────────────────────────────────┐
//   │ Team.defaultAssigneeId (when the    │
//   │ column ships) — also must be       │
//   │ TELECALLER or SALES_EXEC.           │
//   └──────────────┬──────────────────────┘
//                  │ no default
//                  ▼
//   ┌─────────────────────────────────────┐
//   │ No match, no default → lead stays   │
//   │ NEW with ownerId=null; notification │
//   │ trigger #1 fires to the team        │
//   │ manager for manual pickup.          │
//   └─────────────────────────────────────┘
//
// The caller (leads.service.ts) is responsible for the final write
// + audit log + notification; this module only decides WHO.

import type { Lead, Role } from '@shadhil/database';

export type { Lead, Role } from '@shadhil/database';

/**
 * Minimal rule shape. The actual Prisma model has `teamId`,
 * `source`, `targetUserId`, `active`; the engine only needs
 * those plus an `id` (for audit logs) and an optional `priority`
 * (when the column ships — for now, rules default to priority 0).
 */
export interface ManagerAssignmentRule {
  id: string;
  teamId: string;
  /** Lead source — exact match against Lead.source. */
  source: string;
  targetUserId: string;
  active: boolean;
  /** When the rule was created — used as a tiebreaker when priority is equal. */
  createdAt: Date;
  /**
   * Optional priority. Lower number = evaluated first. Missing
   * treated as 0. Future schema migration will make this a
   * required column.
   */
  priority?: number;
}

export interface TargetUser {
  id: string;
  role: Role;
}

export interface Team {
  id: string;
  /** Future: `defaultAssigneeId: string | null` for the per-team fallback. */
  // defaultAssigneeId?: string | null;
}

/**
 * The lead attributes the engine needs to evaluate a match.
 * Keeps the surface tiny — the engine doesn't need the whole
 * Lead row, just the fields used in criteria.
 */
export interface LeadAttributes {
  source: string;
  projectId?: string | null;
  phaseId?: string | null;
  language?: string | null;
  region?: string | null;
}

export type Resolution =
  | { kind: 'rule'; ruleId: string; userId: string }
  | { kind: 'default'; userId: string }
  | { kind: 'unassigned' };

/**
 * Evaluate the rule chain for a (team, lead) pair.
 *
 * @param rules  Active rules for this team (the caller filters
 *               `active: true` at the query level so the engine
 *               doesn't have to).
 * @param team   The team the lead belongs to. Today the engine
 *               only uses team.id; the future defaultAssigneeId
 *               field is commented out.
 * @param lead   Lead attributes used for criteria matching.
 * @param targetResolver  Looks up a user by id, returns the role.
 *               Required so the engine can reject ADMIN/MANAGER
 *               targets (they don't own leads directly).
 */
export function evaluateAssignment(
  rules: readonly ManagerAssignmentRule[],
  team: Team,
  lead: LeadAttributes,
  targetResolver: (userId: string) => TargetUser | null,
): Resolution {
  // Sort: priority ASC, then createdAt ASC (oldest first wins ties).
  const sorted = [...rules].sort((a, b) => {
    const pa = a.priority ?? 0;
    const pb = b.priority ?? 0;
    if (pa !== pb) return pa - pb;
    return a.createdAt.getTime() - b.createdAt.getTime();
  });

  for (const rule of sorted) {
    if (rule.teamId !== team.id) continue; // defensive — caller should pre-filter
    if (!matches(rule, lead)) continue;

    const target = targetResolver(rule.targetUserId);
    if (target === null) continue; // target was deleted — skip
    if (!isAssignableRole(target.role)) continue; // ADMIN/MANAGER can't own leads
    return { kind: 'rule', ruleId: rule.id, userId: rule.targetUserId };
  }

  // No-match fallback: team's defaultAssigneeId.
  // (Deferred — Team.defaultAssigneeId column ships in a future migration.)
  // const defaultUserId = team.defaultAssigneeId ?? null;
  // if (defaultUserId !== null) {
  //   const target = targetResolver(defaultUserId);
  //   if (target !== null && isAssignableRole(target.role)) {
  //     return { kind: 'default', userId: defaultUserId };
  //   }
  // }

  return { kind: 'unassigned' };
}

/**
 * Does the rule match this lead's attributes? Today only `source`
 * is checked; the future criteria (projectId / phaseId / language
 * / region) are TODO columns on the rule. The function is shaped
 * to accept them as zero-value when absent.
 *
 * A rule with all criteria absent (or null) is a "catch-all" — but
 * since the current schema has `source` as a non-nullable required
 * field, there is no true catch-all today. When the rule model
 * grows the "criteria absent = match anything" semantic, this
 * function gains the corresponding branch.
 */
function matches(rule: ManagerAssignmentRule, lead: LeadAttributes): boolean {
  if (rule.source !== lead.source) return false;
  // Future criteria — the rule will gain nullable columns and
  // we add the same `rule.X === lead.X || rule.X == null` checks
  // here. Skipped today because the columns don't exist on the
  // rule model yet.
  return true;
}

/**
 * TELECALLER and SALES_EXEC are the roles that can own a Lead
 * (per Plan §3 ownership rules). ADMIN/MANAGER can reassign and
 * read but never own directly.
 */
function isAssignableRole(role: Role): boolean {
  return role === 'TELECALLER' || role === 'SALES_EXEC';
}

/**
 * Convenience: validate a target user id for the rule-write
 * path. Used by the Admin UI rules page (future PR) to reject
 * "targetUserId = some-admin-id" before the rule is saved.
 */
export function canUserBeAssignedTo(user: TargetUser | null): boolean {
  return user !== null && isAssignableRole(user.role);
}

// Re-export Lead so the service can pass the typed attribute
// without an extra import. Avoids the consumer needing to
// type-cast lead → LeadAttributes at every call site.
export type { Lead as _LeadForCompat } from '@shadhil/database';