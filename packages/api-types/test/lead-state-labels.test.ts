import { describe, expect, it } from 'vitest';

import { ActivityTypeSchema, LeadStateSchema } from '../src/enums';
import { LEAD_STATE_LABELS, leadStateLabel } from '../src/lead-state-labels';

describe('lead state labels', () => {
  it('has a label for every LeadState', () => {
    for (const state of LeadStateSchema.options) {
      expect(LEAD_STATE_LABELS[state]).toBeTruthy();
    }
    expect(Object.keys(LEAD_STATE_LABELS).sort()).toEqual([...LeadStateSchema.options].sort());
  });

  it('humanizes unknown keys', () => {
    expect(leadStateLabel('PARTIAL_DEPOSIT')).toBe('Partial deposit');
    expect(leadStateLabel('VISIT_SCHEDULED')).toBe('Visit booked');
  });
});

describe('ActivityType', () => {
  it('includes ASSIGNMENT and matches the Prisma enum', async () => {
    const { readFileSync } = await import('node:fs');
    const { join } = await import('node:path');
    const schema = readFileSync(
      join(__dirname, '../../database/prisma/schema.prisma'),
      'utf8',
    );
    const block = /enum ActivityType \{([^}]*)\}/.exec(schema)?.[1] ?? '';
    const prisma = block.split(/\s+/).filter(Boolean).sort();
    expect([...ActivityTypeSchema.options].sort()).toEqual(prisma);
  });
});
