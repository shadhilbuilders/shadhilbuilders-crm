// The create-lead form's schema and payload, tested at the seam the bug lived on.
//
// Reported 2026-11-24: clicking "Auto-assign (rule engine)" in the Assignee
// combobox answered "Invalid input: expected string, received undefined".
// Cause: the Form library stores `value || undefined` for select/combobox, and
// this form's "nothing chosen" option carries the empty string. `z.string()`
// then rejected the undefined that actually arrived. The same trap sat on the
// multi-team manager's Team select ("Default (first team)").
//
// These cases pin the three shapes a picker produces, so the schema can never
// go back to demanding a string that the library refuses to give it.
import { describe, expect, it } from 'vitest';

import {
  NO_OWNER_OVERRIDE,
  NO_TEAM_OVERRIDE,
  buildLeadPayload,
  createLeadSchema,
} from './new-lead-form';

const base = {
  name: '  Priya   Sharma  ',
  phone: '9876543210',
  phoneCountry: 'IN' as const,
  email: '',
  source: 'WALK_IN' as const,
  notes: '',
};

describe('createLeadSchema - picker values', () => {
  it('accepts the empty sentinel the form defaults to', () => {
    const parsed = createLeadSchema.safeParse({
      ...base,
      teamId: NO_TEAM_OVERRIDE,
      assignedOwnerId: NO_OWNER_OVERRIDE,
    });
    expect(parsed.success).toBe(true);
  });

  it('accepts undefined, which is what a picker reports for an empty-valued option', () => {
    // The library calls onChange(value || undefined): an empty string never
    // arrives at the resolver, so this is the shape that has to parse.
    const parsed = createLeadSchema.safeParse({
      ...base,
      teamId: undefined,
      assignedOwnerId: undefined,
    });
    expect(parsed.success).toBe(true);
  });

  it('accepts a real id for both pickers', () => {
    const parsed = createLeadSchema.safeParse({
      ...base,
      teamId: 'cmteam000000000000000001',
      assignedOwnerId: 'cmuser000000000000000001',
    });
    expect(parsed.success).toBe(true);
  });

  it('still refuses a null picker value and an empty name', () => {
    expect(createLeadSchema.safeParse({ ...base, teamId: null }).success).toBe(false);
    expect(createLeadSchema.safeParse({ ...base, name: '   ' }).success).toBe(false);
  });
});

describe('buildLeadPayload', () => {
  const parsed = (over: Record<string, unknown>) => {
    const result = createLeadSchema.safeParse({ ...base, ...over });
    if (!result.success) throw new Error(`fixture did not parse: ${result.error.message}`);
    return result.data;
  };

  it('omits both picker keys when nothing was chosen, whichever shape arrived', () => {
    for (const empty of [undefined, NO_TEAM_OVERRIDE]) {
      const payload = buildLeadPayload(
        parsed({ teamId: empty, assignedOwnerId: empty }),
        'cmproj1',
      );
      expect(payload).not.toHaveProperty('teamId');
      expect(payload).not.toHaveProperty('assignedOwnerId');
    }
  });

  it('carries the ids when the user did choose', () => {
    const payload = buildLeadPayload(
      parsed({ teamId: 'cmteam1', assignedOwnerId: 'cmuser1' }),
      'cmproj1',
    );
    expect(payload.teamId).toBe('cmteam1');
    expect(payload.assignedOwnerId).toBe('cmuser1');
  });

  it('trims the name, drops empty email and notes, and keeps the required fields', () => {
    const payload = buildLeadPayload(parsed({}), 'cmproj1');
    expect(payload).toEqual({
      name: 'Priya Sharma',
      phone: '9876543210',
      phoneCountry: 'IN',
      projectId: 'cmproj1',
      source: 'WALK_IN',
    });
  });
});
