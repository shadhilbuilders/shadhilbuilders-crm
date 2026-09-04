// ManagerAssignmentRule engine — auto-routing for new leads.
//
// Per Plan §18 (Decision D2 ratified 2026-08-31): every NEW lead is
// routed by an evaluation chain at creation time. The engine is
// pure — no DB / no Nest / no Prisma. The service (leads.service.ts
// #create) feeds in the team + lead attributes; the engine returns
// the target user (or null); the service persists.
//
// T-ARM-SCHEMA (2026-09-04) brings the engine to the FULL D2 spec:
//   - priority-ordered rule evaluation (lower number = wins, CSS-style)
//   - criteria matching: projectId / phaseId / language / region
//     (any column = NULL means "wildcard", match anything)
//   - Team.defaultAssigneeId fallback when no rule matches
//   - ResolverResult discriminated union so the service can audit
//     which path matched
//
// Schema (current, 2026-09-04):
//   ManagerAssignmentRule has teamId, source, priority, projectId?,
//     phaseId?, language?, region?, targetUserId, active, createdAt.
//   Team has defaultAssigneeId? (SetNull relation to User).
//
// Decision flow (per D2):
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
//   │     region (NULL = wildcard)        │
//   │ If YES → return rule.targetUserId,  │
//   │   but only if the target is         │
//   │   TELECALLER or SALES_EXEC (ADMIN   │
//   │   / MANAGER are rejected — they     │
//   │   don't own leads directly).        │
//   └──────────────┬──────────────────────┘
//                  │ no match
//                  ▼
//   ┌─────────────────────────────────────┐
//   │ Team.defaultAssigneeId              │
//   │ (also must be TELECALLER / SE).     │
//   └──────────────┬──────────────────────┘
//                  │ no default
//                  ▼
//   ┌─────────────────────────────────────┐
//   │ No match, no default →             │
//   │   { kind: 'fallback', userId: actor.sub } │
//   │ The service stamps ownerId = actor.sub │
//   │ and audits the unassigned state.    │
//   └─────────────────────────────────────┘
//
// The caller (leads.service.ts) is responsible for the final write
// + audit log + notification; this module only decides WHO.

import type { Lead, Role } from '@shadhil/database';

export type { Lead, Role } from '@shadhil/database';

/**
 * Minimal rule shape. The Prisma model has all the criteria columns
 * (priority, projectId, phaseId, language, region) — the engine
 * accepts them as plain optional fields so a future schema addition
 * (e.g. "campaign") is a non-breaking type change.
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
  /** Lower number = higher priority. Defaults to 0 when undefined. */
  priority?: number;
  /** When set, the rule only matches leads with this projectId. NULL = wildcard. */
  projectId?: string | null;
  /** When set, the rule only matches leads with this phaseId. NULL = wildcard. */
  phaseId?: string | null;
  /** ISO 639-1 (en/hi/ta). NULL = wildcard. */
  language?: string | null;
  /** ISO 3166-1 / UN subdivision (IN-TN, IN-KA). NULL = wildcard. */
  region?: string | null;
}

export interface TargetUser {
  id: string;
  role: Role;
}

export interface Team {
  id: string;
  /**
   * Per-team fallback assignee. When no rule matches, the engine
   * returns this user (must still be TELECALLER/SALES_EXEC). The
   * column ships with T-ARM-SCHEMA (2026-09-04); nullable to allow
   * teams that genuinely have no fallback (their leads stay
   * unassigned + notification fires).
   */
  defaultAssigneeId?: string | null;
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

/**
 * Engine output — discriminated union so the service can audit
 * which path matched without re-deriving it.
 *
 *   rule         — the lowest-priority rule whose criteria all
 *                  matched AND whose target is assignable. The
 *                  service records the rule id + priority in
 *                  AuditLog.metadata.
 *   team-default — no rule matched, but team.defaultAssigneeId is
 *                  set and points at an assignable role.
 *   fallback     — neither rule nor team-default matched. The
 *                  caller (service) passes actor.sub as the safe
 *                  default — a placeholder until the operator
 *                  wires a rule. Audit logged as 'fallback'.
 */
export type ResolverResult =
  | { kind: 'rule'; ruleId: string; userId: string; priority: number }
  | { kind: 'team-default'; userId: string }
  | { kind: 'fallback'; userId: string };

/**
 * Evaluate the rule chain for a (team, lead) pair.
 *
 * @param rules  Active rules for this team (the caller filters
 *               `active: true` at the query level so the engine
 *               doesn't have to).
 * @param team   The team the lead belongs to. Today the engine
 *               only uses team.id and team.defaultAssigneeId.
 * @param lead   Lead attributes used for criteria matching.
 * @param targetResolver  Looks up a user by id, returns the role.
 *               Required so the engine can reject ADMIN/MANAGER
 *               targets (they don't own leads directly).
 * @param fallbackUserId  When no rule / team-default matches, the
 *               engine returns this as a `fallback` result. The
 *               service passes actor.sub — a placeholder until the
 *               operator wires a rule or default assignee.
 */
export function evaluateAssignment(
  rules: readonly ManagerAssignmentRule[],
  team: Team,
  lead: LeadAttributes,
  targetResolver: (userId: string) => TargetUser | null,
  fallbackUserId: string,
): ResolverResult {
  // Sort: priority ASC, then createdAt ASC (oldest first wins ties).
  const sorted = [...rules].sort((a, b) => {
    const pa = a.priority ?? 0;
    const pb = b.priority ?? 0;
    if (pa !== pb) return pa - pb;
    return a.createdAt.getTime() - b.createdAt.getTime();
  });

  for (const rule of sorted) {
    if (rule.teamId !== team.id) continue; // defensive — caller should pre-filter
    if (!rule.active) continue; // defensive — caller filters
    if (!matchesCriteria(rule, lead)) continue;

    const target = targetResolver(rule.targetUserId);
    if (target === null) continue; // target was deleted — skip
    if (!isAssignableRole(target.role)) continue; // ADMIN/MANAGER can't own leads
    return {
      kind: 'rule',
      ruleId: rule.id,
      userId: rule.targetUserId,
      priority: rule.priority ?? 0,
    };
  }

  // No rule matched. Try the team default.
  const defaultUserId = team.defaultAssigneeId ?? null;
  if (defaultUserId !== null) {
    const target = targetResolver(defaultUserId);
    if (target !== null && isAssignableRole(target.role)) {
      return { kind: 'team-default', userId: defaultUserId };
    }
    // Default exists but points at ADMIN/MANAGER / deleted user —
    // fall through to the actor fallback rather than risk assigning
    // to the wrong role.
  }

  return { kind: 'fallback', userId: fallbackUserId };
}

/**
 * Does the rule match this lead's attributes?
 *
 * `source` is required (non-null on the rule, treated as the
 * discriminator). The four criteria columns (projectId, phaseId,
 * language, region) are independent wildcards: when the rule's
 * column is null/undefined, ANY value on the lead matches. When
 * set, only an exact match counts.
 */
function matchesCriteria(
  rule: ManagerAssignmentRule,
  lead: LeadAttributes,
): boolean {
  if (rule.source !== lead.source) return false;
  if (!criterionMatches(rule.projectId, lead.projectId)) return false;
  if (!criterionMatches(rule.phaseId, lead.phaseId)) return false;
  if (!criterionMatches(rule.language, lead.language)) return false;
  if (!criterionMatches(rule.region, lead.region)) return false;
  return true;
}

/**
 * Single-criterion match. The rule's column is null/undefined → wildcard
 * (any lead value matches, including null — useful for catch-all rules
 * that have NO criteria set). When set, exact string equality is required.
 *
 * Note: we treat an empty string the same as null on the rule side
 * because the schema defaults are NULL but UI form inputs sometimes
 * submit "" — both should behave as wildcard.
 */
function criterionMatches(
  ruleValue: string | null | undefined,
  leadValue: string | null | undefined,
): boolean {
  if (ruleValue === null || ruleValue === undefined || ruleValue === '') {
    return true; // wildcard
  }
  if (leadValue === null || leadValue === undefined) return false;
  return ruleValue === leadValue;
}

/**
 * Extract lead attributes (language / region) from the source
 * string. Currently a no-op: lead sources today are free-form
 * (META_AD, LANDING, REFERRAL, WALK_IN) and don't carry embedded
 * language/region hints. The function exists so Week 8
 * (marketing-attribution module) can add UTM-style parsing
 * ("meta-ad?lang=hi&region=IN-TN") without changing the engine
 * signature.
 *
 * Pure — no DB / no Nest / no Prisma. Easy to exhaustively test.
 */
export function extractCriteriaFromSource(
  source: string,
): { language?: string; region?: string } {
  // Today: no-op. Week 8 will parse UTM tags here.
  void source;
  return {};
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