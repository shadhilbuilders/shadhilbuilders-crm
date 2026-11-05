// T-LEAD-FACTS (2026-11-05): the four rules, tested without a database.
import { describe, expect, it } from 'vitest';

import { scoreEvidence, type Evidence } from './lead-evidence';
import {
  decideLeadFactWrite,
  fillsBlank,
  humanOwns,
  type ExistingFact,
  type LeadFactSubject,
} from './lead-facts.rules';

const blankSubject = (): LeadFactSubject => ({
  name: 'Ramesh',
  email: null,
  source: 'meta-ads',
});

const evidence = (kind: Evidence['kind']): Evidence => ({
  kind,
  detail: 'probe',
});

function decide(input: {
  field?: 'name' | 'email' | 'source';
  value: string;
  kinds?: Evidence[];
  subject?: LeadFactSubject;
  existing?: ExistingFact[];
}) {
  return decideLeadFactWrite({
    field: input.field ?? 'email',
    value: input.value,
    scored: scoreEvidence(input.kinds ?? [evidence('lead.reply-from-number')]),
    subject: input.subject ?? blankSubject(),
    existing: input.existing ?? [],
  });
}

describe('decideLeadFactWrite - never store what is not really known', () => {
  it('refuses an empty value', () => {
    expect(decide({ value: '   ' }).action).toBe('REFUSE');
  });

  it('refuses anything below the floor for keeping', () => {
    const decision = decide({
      value: 'ramesh@example.com',
      kinds: [evidence('handle.name-form')],
    });
    expect(decision).toEqual({
      action: 'REFUSE',
      reason: expect.stringContaining('Below the floor'),
    });
  });
});

describe('decideLeadFactWrite - never re-offer a dismissal', () => {
  it('refuses a value a person already dismissed, however strong the evidence', () => {
    const decision = decide({
      value: 'Ramesh Kumar',
      field: 'name',
      kinds: [evidence('lead.reply-from-number'), evidence('booking.contact-match')],
      existing: [{ value: 'ramesh  kumar', status: 'DISMISSED' }],
    });
    expect(decision.action).toBe('REFUSE');
    expect(decision.reason).toBe(
      'A person has already dismissed this exact value. Do not offer it again.',
    );
  });
});

describe('decideLeadFactWrite - no-ops that look like work', () => {
  it('does nothing when the value is already applied', () => {
    expect(
      decide({
        value: 'ramesh@example.com',
        existing: [{ value: 'Ramesh@Example.com', status: 'APPLIED' }],
      }).action,
    ).toBe('NOOP');
  });

  it('does not offer the same pending value twice', () => {
    expect(
      decide({
        value: 'ramesh@example.com',
        subject: { ...blankSubject(), email: 'old@example.com' },
        existing: [{ value: 'ramesh@example.com', status: 'PROPOSED' }],
      }).action,
    ).toBe('NOOP');
  });
});

describe('decideLeadFactWrite - never overwrite what a person typed', () => {
  it('fills a blank field with anything that cleared the floor', () => {
    const decision = decide({
      value: 'ramesh@example.com',
      kinds: [evidence('whatsapp.profile-name')],
    });
    expect(decision.action).toBe('APPLY');
  });

  it('refuses to touch a filled field with weak evidence', () => {
    const decision = decide({
      value: 'Ramesh Kumar',
      field: 'name',
      kinds: [evidence('whatsapp.profile-name')],
    });
    expect(decision.action).toBe('REFUSE');
    expect(decision.reason).toMatch(/already has a value a person typed/);
  });

  it('proposes instead of writing when a strong source disagrees with a human value', () => {
    const decision = decide({
      value: 'Ramesh Kumar',
      field: 'name',
      kinds: [evidence('lead.reply-from-number')],
    });
    expect(decision.action).toBe('PROPOSE');
  });

  it('says nothing when the strong source agrees with the human value', () => {
    const decision = decide({
      value: ' ramesh ',
      field: 'name',
      kinds: [evidence('lead.reply-from-number')],
    });
    expect(decision.action).toBe('REFUSE');
  });

  it('treats a value the ledger applied as replaceable by better evidence', () => {
    const decision = decide({
      value: 'ramesh.kumar@example.com',
      subject: { ...blankSubject(), email: 'ramesh@example.com' },
      existing: [{ value: 'ramesh@example.com', status: 'APPLIED' }],
    });
    expect(decision.action).toBe('APPLY');
  });

  it('will not replace a ledger value on POSSIBLE evidence alone', () => {
    // POSSIBLE scores 0.3..0.55; a POSSIBLE claim on a field the ledger already
    // filled is noise, not a correction.
    const scored = {
      score: 0.5,
      band: 'POSSIBLE' as const,
      hasPrimary: false,
      rationale: 'probe',
    };
    const decision = decideLeadFactWrite({
      field: 'email',
      value: 'other@example.com',
      scored,
      subject: { ...blankSubject(), email: 'ramesh@example.com' },
      existing: [{ value: 'ramesh@example.com', status: 'APPLIED' }],
    });
    expect(decision.action).toBe('REFUSE');
  });
});

describe('helpers', () => {
  it('humanOwns is false once the ledger applied the value', () => {
    expect(
      humanOwns({
        field: 'email',
        subject: { ...blankSubject(), email: 'x@example.com' },
        existing: [{ value: 'x@example.com', status: 'APPLIED' }],
      }),
    ).toBe(false);

    expect(
      humanOwns({
        field: 'email',
        subject: { ...blankSubject(), email: 'x@example.com' },
        existing: [],
      }),
    ).toBe(true);
  });

  it('fillsBlank is false for a field with a human value', () => {
    expect(
      fillsBlank({
        field: 'name',
        subject: blankSubject(),
        existing: [],
      }),
    ).toBe(false);
  });
});
