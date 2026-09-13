// Pure helpers for the team-member removal/reassignment flow
// (T-TEAM-AUTHORITATIVE, 2026-09-13, Decision Audit Trail #39). Kept
// dependency-free (no Prisma/Nest imports) so they're unit-testable without
// a database, per AGENTS.md ("pure helpers are named exports, tested
// without Nest").
import { createHash } from 'node:crypto';

export interface LeadOwnershipSnapshot {
  id: string;
  updatedAt: Date | string;
  ownerId: string;
  coOwnerId: string | null;
}

/**
 * Opaque, deterministic preview token derived from every affected lead's
 * (id, updatedAt, ownerId, coOwnerId) - the design doc's exact recipe.
 * Sorted by id first so row order never affects the hash. Any change to
 * any affected lead's ownership or updatedAt between preview and execute
 * changes the token, which is how STALE_PREVIEW is detected: the caller's
 * `previewToken` (captured at preview time) is compared against a FRESH
 * token recomputed from the just-locked rows at execute time.
 */
export function computePreviewToken(leads: readonly LeadOwnershipSnapshot[]): string {
  const sorted = [...leads].sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
  const material = sorted
    .map((l) => {
      const updatedAt =
        typeof l.updatedAt === 'string' ? l.updatedAt : l.updatedAt.toISOString();
      return `${l.id}|${updatedAt}|${l.ownerId}|${l.coOwnerId ?? ''}`;
    })
    .join('\n');
  return createHash('sha256').update(material).digest('hex');
}

export interface OwnershipTransferPlan {
  /** Leads where the departing user was OWNER and the replacement was
   * already the CO-OWNER: promote replacement to owner, clear coOwnerId
   * (owner === coOwner is never allowed). */
  promoteCoOwnerToOwnerLeadIds: string[];
  /** Leads where the departing user was OWNER and the replacement was
   * NOT already the co-owner: simple owner handoff, coOwnerId untouched. */
  reassignOwnerLeadIds: string[];
  /** Leads where the departing user was CO-OWNER and the replacement was
   * already the OWNER: clear coOwnerId (would otherwise equal owner). */
  clearCoOwnerLeadIds: string[];
  /** Leads where the departing user was CO-OWNER and the replacement was
   * NOT already the owner: simple co-owner handoff. */
  reassignCoOwnerLeadIds: string[];
}

/**
 * Partition affected leads into the 4 set-based collision categories from
 * the design doc's "Collision rules" section. A lead is affected via
 * EXACTLY ONE of ownerId===departingUserId or coOwnerId===departingUserId
 * (never both - `ownerId <> coOwnerId` is a DB invariant), so these 4
 * buckets are mutually exclusive and their union is every affected lead.
 */
export function planOwnershipTransfer(
  leads: readonly LeadOwnershipSnapshot[],
  departingUserId: string,
  replacementUserId: string,
): OwnershipTransferPlan {
  const plan: OwnershipTransferPlan = {
    promoteCoOwnerToOwnerLeadIds: [],
    reassignOwnerLeadIds: [],
    clearCoOwnerLeadIds: [],
    reassignCoOwnerLeadIds: [],
  };
  for (const lead of leads) {
    if (lead.ownerId === departingUserId) {
      if (lead.coOwnerId === replacementUserId) {
        plan.promoteCoOwnerToOwnerLeadIds.push(lead.id);
      } else {
        plan.reassignOwnerLeadIds.push(lead.id);
      }
    } else if (lead.coOwnerId === departingUserId) {
      if (lead.ownerId === replacementUserId) {
        plan.clearCoOwnerLeadIds.push(lead.id);
      } else {
        plan.reassignCoOwnerLeadIds.push(lead.id);
      }
    }
  }
  return plan;
}
