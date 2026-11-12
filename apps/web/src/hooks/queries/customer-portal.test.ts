// notLinkedInfo (issue #8 slice 2).
// protects= only the coded "not linked" 403 becomes the lock screen; fails_when=
// any other 403/error is mistaken for it, or the phone is lost; no_claim= does
// not exercise the hooks or the network.
import { describe, expect, it } from 'vitest';

import { ApiError } from '@/apis/client';

import { NOT_LINKED_CODE, notLinkedInfo } from './customer-portal';

describe('notLinkedInfo', () => {
  it('extracts the office phone from the coded 403', () => {
    const err = new ApiError('x', 403, NOT_LINKED_CODE, { officePhone: '+91 1' });
    expect(notLinkedInfo(err)).toEqual({ officePhone: '+91 1' });
  });
  it('is phone-less when the org has none', () => {
    expect(notLinkedInfo(new ApiError('x', 403, NOT_LINKED_CODE, { officePhone: null }))).toEqual({
      officePhone: null,
    });
    expect(notLinkedInfo(new ApiError('x', 403, NOT_LINKED_CODE))).toEqual({ officePhone: null });
  });
  it('ignores every other error', () => {
    expect(notLinkedInfo(new ApiError('x', 403, 'OTHER'))).toBeNull();
    expect(notLinkedInfo(new ApiError('x', 404, NOT_LINKED_CODE))).toBeNull();
    expect(notLinkedInfo(new Error('boom'))).toBeNull();
    expect(notLinkedInfo(null)).toBeNull();
  });
});
