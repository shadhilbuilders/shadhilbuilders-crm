// AutoAssign engine - least-loaded telecaller selection for NEW leads.
//
// T-AUTOASSIGN (2026-09-17): complements the ManagerAssignmentRule engine.
// A team with `autoAssignLeads=true` routes each NEW lead to the single most
// available telecaller across the routing scope (see below), instead of the
// deterministic rule chain.
//
// This module is PURE - no DB / no Nest / no Prisma. The service feeds in the
// candidate pool with their current load; the engine returns the pick (or null
// when nobody is eligible). The service persists + audits.
//
// ## Who is eligible (fixed 2026-09-28)
//
// TELECALLERS ONLY. A NEW lead is first-touch work: plan §3 owns
// NEW..VISIT_SCHEDULED by a telecaller, and a sales exec only takes over from
// VISITED onwards (Model C handoff) or via a deliberate manual reassign.
// Sales execs used to share this pool and be scored by the same
// openLeads/weight ratio, so an idle sales exec (score 0.0) beat every working
// telecaller and took first touch - the reported bug.
//
// Eligibility is the CALLER's job (leads.service#resolveAutoAssign), not this
// module's: the engine stays pure and simply ranks the pool it is handed. The
// caller also owns the "no eligible telecaller" outcome - it hands the lead to
// the creating team's MANAGER as a pending handoff (never to a sales exec) and
// only falls back to the rule chain when that team has no manager.
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
//     not here - this engine only ever returns a telecaller.)
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
// ## Hard cap (T-MAXOPENLEADS, 2026-09-28)
//
// `weight` is a SHARE; `maxOpenLeads` is a CEILING. They answer different
// questions, which is why they are separate:
//
//   weight        - among members who CAN take this lead, who should?
//                   (a divisor: higher weight absorbs more of the same flow)
//   maxOpenLeads  - can this member take it at all?
//                   (an eligibility gate, checked BEFORE scoring)
//
// A member at or over their ceiling is filtered out of the pool entirely, so
// they neither receive the lead nor distort the ratio for everyone else. The
// boundary is `openLeads < maxOpenLeads`: at exactly the ceiling they are full.
// `null`/`undefined` = uncapped, which is every pre-existing row.
//
// When EVERY candidate is capped the pool is empty and the engine returns
// `no-eligible`. The caller's response is to hand the lead to the creating
// team's MANAGER as a pending handoff - never a sales exec, and never silently
// exceeding a configured ceiling.
//
// `openLeads` counts non-terminal leads (NOT IN WON/LOST/RNR), computed by the
// SERVICE in the same query that fetches the pool - the engine receives the
// number, not the rows.

// ## Team rotation (T-TEAM-ROUND-ROBIN, 2026-10-08)
//
// Equal sharing BETWEEN teams is a strict round-robin over the project's linked
// teams, one lead per team in turn, regardless of headcount or load. This
// module only owns the ORDER ("whose turn is it"); the service decides whether
// a team in that order can actually take the lead (telecaller pool / manager),
// skips the ones that cannot, and advances the cursor of the one it uses.
//
//   ON team  -> least-loaded telecaller in THAT team (pickAutoAssignCandidate)
//   OFF team -> that team's manager, as a pending handoff
//   a team with no telecallers is skipped (its manager never gets a lead just
//   because the team is empty)

/** A project-linked team and where it sits in the rotation. */
export interface RotationTeam {
  teamId: string;
  /** When this team last received a routed lead; null = never. */
  lastAssignedAt: Date | null;
}

/**
 * Order teams for rotation: never-routed (null) first, then oldest
 * `lastAssignedAt` first; ties break by teamId so the same input always yields
 * the same order. Returns a NEW array - the input is never mutated.
 */
export function orderTeamsForRotation<T extends RotationTeam>(
  teams: readonly T[],
): T[] {
  return [...teams].sort((a, b) => {
    const at = a.lastAssignedAt === null ? Number.NEGATIVE_INFINITY : a.lastAssignedAt.getTime();
    const bt = b.lastAssignedAt === null ? Number.NEGATIVE_INFINITY : b.lastAssignedAt.getTime();
    if (at !== bt) return at < bt ? -1 : 1;
    return a.teamId < b.teamId ? -1 : a.teamId > b.teamId ? 1 : 0;
  });
}

/** A candidate telecaller with their current open-lead load. */
export interface AutoAssignCandidate {
  /** TeamMember.userId (the assignable user). */
  userId: string;
  /** Active open-lead count for this user (non-terminal states only). */
  openLeads: number;
  /** Relative routing weight (>0; default 1). */
  weight: number;
  /**
   * T-MAXOPENLEADS (2026-09-28): hard ceiling on open leads. A member at or
   * over their ceiling is INELIGIBLE, not merely lower-scored - the cap is an
   * availability gate, while `weight` only decides the share among those still
   * available. `null`/`undefined` = no cap.
   */
  maxOpenLeads?: number | null;
}

/**
 * Engine output - discriminated union so the service can audit how the pick
 * was made and why, without re-deriving it.
 *
 *   picked         - a candidate was selected (their id + the score used).
 *   no-eligible    - the pool was empty / every candidate had weight <= 0.
 *                    Caller takes the no-eligible-telecaller path (manager
 *                    handoff), or the rule chain when that is unavailable.
 */
export type AutoAssignResult =
  | { kind: 'picked'; userId: string; openLeads: number; weight: number; score: number }
  | { kind: 'no-eligible' };

/**
 * T-MAXOPENLEADS (2026-09-28): is this candidate still under their ceiling?
 *
 * The cap is a hard gate, and the boundary is `openLeads < maxOpenLeads`:
 * a member at EXACTLY the ceiling is full, because the ceiling is "how many
 * open leads they may hold" and this lead would become the (max+1)th. A
 * `null`/`undefined` ceiling means uncapped.
 */
function withinCap(c: AutoAssignCandidate): boolean {
  const cap = c.maxOpenLeads;
  if (cap === null || cap === undefined) return true;
  return c.openLeads < cap;
}

/**
 * Pick the least-loaded eligible member, weighted.
 *
 * @param candidates  The pooled candidates (deduped by userId) with load.
 *                    The service is responsible for:
 *                      - pooling across the routing scope (project vs team),
 *                      - restricting the pool to TELECALLERs (never sales execs),
 *                      - deduping a telecaller who sits in multiple teams,
 *                      - excluding ADMIN / MANAGER / roles that cannot own leads.
 * @returns the best candidate, or no-eligible when none qualify. `no-eligible`
 *          is also what an all-capped pool returns, and the caller treats it as
 *          "hand the lead to the team's manager" (T-MAXOPENLEADS).
 */
export function pickAutoAssignCandidate(
  candidates: readonly AutoAssignCandidate[],
): AutoAssignResult {
  const eligible = candidates.filter(
    (c) => c.weight > 0 && c.openLeads >= 0 && withinCap(c),
  );
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
