// protects= the two contract rules the phone-login work depends on: an invite can
//   go out without an email (and then the server, not the client, invents an
//   unusable one), and a user can only change their address with a password.
// fails_when= a blank email is accepted as a valid address, the placeholder
//   helper matches a real domain, or the profile DTO lets an email change through
//   without `currentPassword`.
// no_claim= nothing about how the backend generates the random local part; that
//   is covered by the invites service and tokens tests.
import { describe, expect, it } from 'vitest';

import { UpdateProfileDtoSchema } from '../src/auth';
import {
  PLACEHOLDER_EMAIL_DOMAIN,
  PLACEHOLDER_EMAIL_PREFIX,
  isPlaceholderEmail,
} from '../src/common';
import { CreateInviteDtoSchema } from '../src/invites';

describe('isPlaceholderEmail', () => {
  it('recognises the generated shape', () => {
    expect(isPlaceholderEmail(`${PLACEHOLDER_EMAIL_PREFIX}0123456789abcdef@users.invalid`)).toBe(
      true,
    );
    // Case and stray whitespace are normalised before the check.
    expect(isPlaceholderEmail(` NoEmail+0123456789ABCDEF@Users.Invalid `)).toBe(true);
  });

  it('refuses everything a person could type, including a lookalike domain', () => {
    expect(isPlaceholderEmail('ravi@shadhilbuilders.in')).toBe(false);
    expect(isPlaceholderEmail(`noemail+0123456789abcdef@users.invalid.example.com`)).toBe(false);
    expect(isPlaceholderEmail(`someone@${PLACEHOLDER_EMAIL_DOMAIN}`)).toBe(false);
    expect(isPlaceholderEmail('')).toBe(false);
    expect(isPlaceholderEmail(null)).toBe(false);
    expect(isPlaceholderEmail(undefined)).toBe(false);
  });
});

describe('CreateInviteDtoSchema', () => {
  const base = { name: 'Ravi Kumar', phone: '9876543210', role: 'TELECALLER', teamId: 'team-1' };

  it('accepts an invite with no email at all, and normalises the phone', () => {
    const parsed = CreateInviteDtoSchema.safeParse(base);
    expect(parsed.success).toBe(true);
    expect(parsed.data?.email).toBeUndefined();
    expect(parsed.data?.phone).toBe('919876543210');
  });

  it('still validates an address when one is given', () => {
    expect(CreateInviteDtoSchema.safeParse({ ...base, email: 'ravi@example.com' }).success).toBe(
      true,
    );
    expect(CreateInviteDtoSchema.safeParse({ ...base, email: 'not-an-address' }).success).toBe(
      false,
    );
  });

  it('refuses a blank string instead of treating it as "no email"', () => {
    // The dialog must OMIT the key. Sending '' is a client bug, and silently
    // accepting it would hide that bug behind a generated address.
    expect(CreateInviteDtoSchema.safeParse({ ...base, email: '' }).success).toBe(false);
  });
});

describe('UpdateProfileDtoSchema', () => {
  it('keeps name-only and phone-only edits password-free', () => {
    expect(UpdateProfileDtoSchema.safeParse({ name: 'Ravi K' }).success).toBe(true);
    expect(UpdateProfileDtoSchema.safeParse({ phone: '9876500000' }).success).toBe(true);
  });

  it('requires currentPassword whenever an email is present', () => {
    const withoutPassword = UpdateProfileDtoSchema.safeParse({ email: 'ravi@example.com' });
    expect(withoutPassword.success).toBe(false);

    const withPassword = UpdateProfileDtoSchema.safeParse({
      email: 'ravi@example.com',
      currentPassword: 'password123',
    });
    expect(withPassword.success).toBe(true);
  });

  it('rejects an empty body and a bad address', () => {
    const empty = UpdateProfileDtoSchema.safeParse({});
    expect(empty.success).toBe(false);
    expect(JSON.stringify(empty.error?.issues)).toContain('Nothing to update');

    expect(
      UpdateProfileDtoSchema.safeParse({ email: 'nope', currentPassword: 'password123' }).success,
    ).toBe(false);
  });
});
