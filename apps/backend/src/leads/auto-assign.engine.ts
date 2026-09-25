// AutoAssign engine - least-loaded telecaller selection for NEW leads.
//
// T-AUTOASSIGN (2026-09-17): complements the ManagerAssignmentRule engine.
// A team with `autoAssignLeads=true` routes each NEW lead to the single most
// available telecaller across the routing scope (see below), instead of the
// deterministic rule chain. Managers NEVER own a lead on this path - matching
// the D2 ownership ruling and the existing `isAssignableRole` (TELECALLER /
// SALES_EXEC only).
//
// This module is PURE - no DB / no Nest / no Prisma. The service feeds in the
// candidate pool with their current load; the engine returns the pick (or null
// when nobody is eligible). The service persists + audits.
//
// ## Routing scope
//
// The flag is per-TEAM but the routing universe is per-PROJECT:
//   - `autoAssignLeads=true`  → route across ALL teams linked to the lead's
//     PROJECT (ProjectTeam join), NOT just the team the lead was created into.
//     Rationale (owner directive): "assign leads across multiple teams within
//     the project" so one telecaller is never drowned while a sibling team's
//     telecallers sit light.
//   - `autoAssignLeads=false` → leads land owned by the creating team's MANAGER
//     (pending state); the manager hands off manually. (Handled in the service,
//     not here - this engine only ever returns TELECALLER/SALES_EXEC.)
//
// ## Weight & availability
//
//   score(member) = openLeads(member) / weight(member)
//
// The engine assigns to the LOWEST score. A weight-2 telecaller with 4 open
// leads (score 2.0) is preferred over a weight-1 with 3 open leads (3.0) -
// i.e. weight biases toward an experienced member while still respecting load.
// Ties (equal score) break to the member with FEWER open leads, then
// lexicographically by userId for determinism.
//
// `openLeads` counts non-terminal leads (NOT IN WON/LOST/RNR), computed by the
// SERVICE in the same query that fetches the pool - the engine receives the
// number, not the rows.

/** A candidate telecaller or sales exec with their current open-lead load. */
export interface AutoAssignCandidate {
  /** TeamMember.userId (the assignable user). */
  userId: string;
  /** Active open-lead count for this user (non-terminal states only). */
  openLeads: number;
  /** Relative routing weight (>0; default 1). */
  weight: number;
}

/**
 * Engine output - discriminated union so the service can audit how the pick
 * was made and why, without re-deriving it.
 *
 *   picked         - a candidate was selected (their id + the score used).
 *   no-eligible    - the pool was empty / every candidate had weight <= 0.
 *                    Caller falls back to the existing rule chain.
 */
export type AutoAssignResult =
  | { kind: 'picked'; userId: string; openLeads: number; weight: number; score: number }
  | { kind: 'no-eligible' };

/**
 * Pick the least-loaded eligible member, weighted.
 *
 * @param candidates  The pooled candidates (deduped by userId) with load.
 *                    The service is responsible for:
 *                      - pooling across the routing scope (project vs team),
 *                      - deduping a telecaller who sits in multiple teams,
 *                      - excluding ADMIN / MANAGER / roles that cannot own leads.
 * @returns the best candidate, or no-eligible when none qualify.
 */
export function pickAutoAssignCandidate(
  candidates: readonly AutoAssignCandidate[],
): AutoAssignResult {
  const eligible = candidates.filter((c) => c.weight > 0 && c.openLeads >= 0);
  if (eligible.length === 0) return { kind: 'no-eligible' };

  let best: AutoAssignCandidate = eligible[0]!;
  let bestScore = best.openLeads / best.weight;

  for (const c of eligible.slice(1)) {
    const score = c.openLeads / c.weight;
    const better =
      score < bestScore ||
      (score === bestScore && c.openLeads < best.openLeads) ||
      // Fully deterministic tie-break so the same input always picks the same
      // person (stable across calls / tests).
      (score === bestScore &&
        c.openLeads === best.openLeads &&
        c.userId < best.userId);
    if (better) {
      best = c;
      bestScore = c.openLeads / c.weight;
    }
  }

  return {
    kind: 'picked',
    userId: best.userId,
    openLeads: best.openLeads,
    weight: best.weight,
    score: bestScore,
  };
}
