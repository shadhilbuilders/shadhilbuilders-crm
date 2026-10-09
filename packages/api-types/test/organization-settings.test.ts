import { describe, expect, it } from 'vitest';

import { UpdateOrganizationSettingsSchema } from '../src/organizations';

describe('UpdateOrganizationSettingsSchema', () => {
  it('accepts the bounds and rejects outside them / non-integers / empty', () => {
    const ok = (n: number) =>
      UpdateOrganizationSettingsSchema.safeParse({ visitReminderLeadMinutes: n }).success;
    expect(ok(5)).toBe(true);
    expect(ok(1440)).toBe(true);
    expect(ok(4)).toBe(false);
    expect(ok(1441)).toBe(false);
    expect(ok(30.5)).toBe(false);
    expect(UpdateOrganizationSettingsSchema.safeParse({}).success).toBe(false);
  });
});
