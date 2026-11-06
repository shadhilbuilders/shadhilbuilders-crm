// ────────────────────────────────────────────────────────────────────────────
// Lead fact rules - the decisions that must hold whatever the caller does.
// ────────────────────────────────────────────────────────────────────────────
// T-LEAD-FACTS (2026-11-05). Pure: takes a scored claim plus the current state
// of the field and returns what may happen to it. The service does the I/O;
// this file owns the policy, so the policy is testable without a database.
//
// The four things a prompt cannot be trusted to enforce, and why:
//   1. Never overwrite what a person typed. A telecaller's name beats a
//      WhatsApp profile name, and "be careful" is not enforcement.
//   2. Never re-offer a value a person dismissed. Otherwise dismissing is a
//      no-op that comes back tomorrow.
//   3. Never store a claim below the floor. Half-believed data is worse than
//      empty data: it looks like knowledge.
//   4. Never offer a rep the value already in the field. A click that can only
//      say yes is a click that trains people to stop reading.
// ────────────────────────────────────────────────────────────────────────────

import {
  LEAD_FACT_FIELDS,
  type FactBand,
  type LeadFactColumn,
  type LeadFactField,
  type Scored,
  sameValue,
} from './lead-evidence';

export type ExistingFactStatus =
  | 'APPLIED'
  | 'PROPOSED'
  | 'DISMISSED'
  | 'SUPERSEDED';

export type ExistingFact = {
  value: string;
  status: ExistingFactStatus;
};

/** The Lead row as far as the rules care: one nullable column per fact field. */
export type LeadFactSubject = Record<LeadFactColumn, string | null>;

export type WriteDecision =
  | { action: 'APPLY'; reason?: undefined }
  | { action: 'PROPOSE'; reason?: undefined }
  | { action: 'NOOP'; reason: string }
  | { action: 'REFUSE'; reason: string };

export type DecideInput = {
  field: LeadFactField;
  value: string;
  scored: Scored;
  subject: LeadFactSubject;
  /** Existing facts on THIS lead for THIS field. */
  existing: readonly ExistingFact[];
};

/**
 * PROBABLE is where a rep gets asked about a field that already has a value.
 * Below it, a conflict is noise: nobody wants a notification because a handle
 * looks a bit like a name already in the box.
 */
const CONFLICT_FLOOR: FactBand = 'PROBABLE';

export function decideLeadFactWrite(input: DecideInput): WriteDecision {
  const value = input.value.trim();

  if (value === '') {
    return { action: 'REFUSE', reason: 'Empty value.' };
  }

  if (input.scored.band === null) {
    return {
      action: 'REFUSE',
      reason:
        'Below the floor for keeping - not stored. Find a source that identifies them, or leave the field alone.',
    };
  }

  if (
    input.existing.some(
      (fact) =>
        fact.status === 'DISMISSED' && sameValue(fact.value, value),
    )
  ) {
    return {
      action: 'REFUSE',
      reason:
        'A person has already dismissed this exact value. Do not offer it again.',
    };
  }

  const applied = input.existing.find((fact) => fact.status === 'APPLIED');

  if (applied && sameValue(applied.value, value)) {
    return {
      action: 'NOOP',
      reason: 'Already on the record, from this same source. Nothing changed.',
    };
  }

  const owns = humanOwns(input);

  if (owns) {
    const alreadyProposed = input.existing.some(
      (fact) => fact.status === 'PROPOSED' && sameValue(fact.value, value),
    );

    if (alreadyProposed) {
      return {
        action: 'NOOP',
        reason:
          'This exact value is already in front of a rep, waiting on them. Offering it twice only makes them read it twice.',
      };
    }

    const current =
      input.subject[LEAD_FACT_FIELDS[input.field].column] ?? '';
    const strongEnoughToAsk =
      input.scored.band === 'VERIFIED' || input.scored.band === CONFLICT_FLOOR;

    // A person's value is never overwritten, at any band. It may still be
    // worth telling them a strong source disagrees.
    if (strongEnoughToAsk && !sameValue(current, value)) {
      return { action: 'PROPOSE' };
    }

    return {
      action: 'REFUSE',
      reason:
        input.scored.band === 'POSSIBLE'
          ? `"${input.field}" already has a value a person typed, and this evidence is not strong enough to ask them about it.`
          : `"${input.field}" already has a value a person typed. That outranks a guess.`,
    };
  }

  if (input.scored.band === 'VERIFIED') {
    return { action: 'APPLY' };
  }

  if (fillsBlank(input)) {
    return { action: 'APPLY' };
  }

  if (input.scored.band === CONFLICT_FLOOR) {
    return { action: 'PROPOSE' };
  }

  // Filled by an earlier APPLY and the new evidence is only POSSIBLE: not
  // worth a rep's attention, and not strong enough to replace the value.
  return {
    action: 'REFUSE',
    reason:
      'The field already carries a value this ledger wrote, and the new evidence is not strong enough to replace it.',
  };
}

/**
 * True when a person typed this value. "A person" means the column is filled
 * AND no APPLIED fact put it there; an agent-applied value is the ledger's own
 * and may be replaced by better evidence.
 */
export function humanOwns(input: {
  field: LeadFactField;
  subject: LeadFactSubject;
  existing: readonly ExistingFact[];
}): boolean {
  const column = LEAD_FACT_FIELDS[input.field].column;
  const applied = input.existing.some((fact) => fact.status === 'APPLIED');

  if (applied) return false;

  return Boolean(input.subject[column]);
}

/** True when nothing is in the way and nothing was found there before. */
export function fillsBlank(input: {
  field: LeadFactField;
  subject: LeadFactSubject;
  existing: readonly ExistingFact[];
}): boolean {
  const column = LEAD_FACT_FIELDS[input.field].column;
  const applied = input.existing.some((fact) => fact.status === 'APPLIED');

  if (applied) return false;

  return !input.subject[column];
}
