// PATCH /api/users/me - the photo field (2026-11-24).
//
// protects= a photo-only save is a real change, and clearing it is expressible;
// fails_when= the superRefine stops counting `avatarKey` (the form would be
//            rejected with "nothing to update") or an empty body slips through;
// no_claim= the server-side key validation (org namespace, stored mime type) -
//            that lives in users.service and is covered against the live DB.
import { describe, expect, it } from 'vitest';

import { UpdateProfileDtoSchema, UserDetailSchema } from '../src/auth';

const KEY = '/ceid01lpfe1esm8jwsxid41k28/abc123/face.webp';

describe('UpdateProfileDtoSchema - photo', () => {
  it('accepts a photo on its own, with no name, phone or email', () => {
    const parsed = UpdateProfileDtoSchema.safeParse({ avatarKey: KEY });
    expect(parsed.success).toBe(true);
  });

  it('accepts null, which is the removal path', () => {
    const parsed = UpdateProfileDtoSchema.safeParse({ avatarKey: null });
    expect(parsed.success).toBe(true);
  });

  it('still refuses an empty body', () => {
    const parsed = UpdateProfileDtoSchema.safeParse({});
    expect(parsed.success).toBe(false);
    if (!parsed.success) {
      expect(parsed.error.issues[0]?.message).toContain('photo');
    }
  });

  it('refuses an empty-string key (that would be neither a photo nor a removal)', () => {
    expect(UpdateProfileDtoSchema.safeParse({ avatarKey: '' }).success).toBe(false);
  });
});

describe('UserDetailSchema - photo', () => {
  const base = {
    id: 'u-1',
    email: 'u@x.in',
    name: 'U',
    role: 'TELECALLER' as const,
    teamId: null,
    teamName: null,
    manager: null,
    projects: [],
  };

  it('carries both the key and the resolved URL', () => {
    const parsed = UserDetailSchema.parse({
      ...base,
      avatarKey: KEY,
      imageUrl: '/api/bff/media/x',
    });
    expect(parsed.avatarKey).toBe(KEY);
    expect(parsed.imageUrl).toBe('/api/bff/media/x');
  });

  it('stays valid for a response from an older API that has neither field', () => {
    expect(UserDetailSchema.safeParse(base).success).toBe(true);
  });
});
