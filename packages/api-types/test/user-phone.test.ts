// User phone DTO contract (2026-11-18).
//
// Pins the four-way behaviour of ClearablePhoneSchema, because it is the one
// place where "unset" and "clear" must stay distinguishable:
//
//   value      -> normalized digits   (set)
//   null       -> null                (clear the column)
//   undefined  -> undefined           (omit, column untouched)
//   ''         -> rejected            (never a silent no-op)
//
// The union wraps a `superRefine` + `transform`, which is exactly the shape
// that can misbehave in Zod, so these assertions are the contract rather than
// a restatement of the implementation.
import { describe, expect, it } from 'vitest';

import {
  ClearablePhoneSchema,
  CreateUserDtoSchema,
  UpdateProfileDtoSchema,
  UpdateUserDtoSchema,
  UserFilterDtoSchema,
} from '../src/auth';

describe('ClearablePhoneSchema', () => {
  it('normalizes a bare 10-digit Indian mobile to digits-only', () => {
    expect(ClearablePhoneSchema.parse('9876543210')).toBe('919876543210');
  });

  it('normalizes a +91 E164 value', () => {
    expect(ClearablePhoneSchema.parse('+919876543210')).toBe('919876543210');
  });

  it('strips a leading 0 and prepends 91', () => {
    expect(ClearablePhoneSchema.parse('09876543210')).toBe('919876543210');
  });

  it('passes null through - this is the ERASE path', () => {
    expect(ClearablePhoneSchema.parse(null)).toBeNull();
  });

  it('rejects an empty string so a blank field is never a silent no-op', () => {
    expect(ClearablePhoneSchema.safeParse('').success).toBe(false);
  });

  it('rejects garbage with a readable message', () => {
    const result = ClearablePhoneSchema.safeParse('not-a-number');
    expect(result.success).toBe(false);
    if (!result.success) {
      expect(JSON.stringify(result.error.issues)).toContain('valid phone number');
    }
  });

  it('rejects a masked placeholder (not a real number)', () => {
    expect(ClearablePhoneSchema.safeParse('+919****3210').success).toBe(false);
  });
});

describe('UpdateUserDtoSchema (admin edit)', () => {
  it('accepts a phone-only update', () => {
    const parsed = UpdateUserDtoSchema.parse({ phone: '9876543210' });
    expect(parsed.phone).toBe('919876543210');
    expect(parsed.name).toBeUndefined();
  });

  it('accepts null to clear the number', () => {
    expect(UpdateUserDtoSchema.parse({ phone: null }).phone).toBeNull();
  });

  it('omitting phone leaves it undefined (column untouched)', () => {
    expect(UpdateUserDtoSchema.parse({ name: 'Asha' }).phone).toBeUndefined();
  });

  it('accepts an empty object (all fields optional)', () => {
    expect(UpdateUserDtoSchema.safeParse({}).success).toBe(true);
  });
});

describe('UpdateProfileDtoSchema (self edit)', () => {
  it('accepts a phone-only self edit - name is optional as of 2026-11-18', () => {
    const parsed = UpdateProfileDtoSchema.parse({ phone: '9876543210' });
    expect(parsed.phone).toBe('919876543210');
    expect(parsed.name).toBeUndefined();
  });

  it('accepts a name-only self edit', () => {
    expect(UpdateProfileDtoSchema.parse({ name: 'Asha' }).name).toBe('Asha');
  });

  it('accepts clearing the phone from settings', () => {
    expect(UpdateProfileDtoSchema.parse({ phone: null }).phone).toBeNull();
  });

  it('rejects an EMPTY body rather than reporting a successful no-op', () => {
    const result = UpdateProfileDtoSchema.safeParse({});
    expect(result.success).toBe(false);
    if (!result.success) {
      expect(JSON.stringify(result.error.issues)).toContain('Nothing to update');
    }
  });

  it('still refuses an email self-edit (login identifier stays admin-only)', () => {
    // Zod strips unknown keys, so the parse SUCCEEDS but email is never
    // present in the output - the service therefore cannot write it.
    const parsed = UpdateProfileDtoSchema.parse({ name: 'Asha', email: 'x@y.z' });
    expect(parsed).not.toHaveProperty('email');
  });
});

describe('CreateUserDtoSchema', () => {
  it('accepts a staff user with a phone', () => {
    const parsed = CreateUserDtoSchema.parse({
      email: 'asha@shadhilbuilders.in',
      password: 'correct-horse-battery',
      name: 'Asha',
      role: 'TELECALLER',
      teamId: 'team-1',
      phone: '9876543210',
    });
    expect(parsed.phone).toBe('919876543210');
  });

  it('accepts a staff user WITHOUT a phone (optional)', () => {
    const parsed = CreateUserDtoSchema.parse({
      email: 'asha@shadhilbuilders.in',
      password: 'correct-horse-battery',
      name: 'Asha',
      role: 'TELECALLER',
      teamId: 'team-1',
    });
    expect(parsed.phone).toBeUndefined();
  });
});

describe('UserFilterDtoSchema', () => {
  it('includePhone is opt-in and defaults to absent', () => {
    const parsed = UserFilterDtoSchema.parse({});
    expect(parsed.includePhone).toBeUndefined();
  });

  it('accepts includePhone: true', () => {
    expect(UserFilterDtoSchema.parse({ includePhone: true }).includePhone).toBe(true);
  });
});
