// Helpers for the public "email or phone + password" login resolver (2026-11-21).
//
// WHY THE SEMAPHORE: `scrypt` runs on the libuv threadpool, four threads by
// default and shared with every file read, DNS lookup and other crypto call in
// the process. The resolver is unauthenticated, so without a cap a handful of
// parallel requests starve the whole server. Two concurrent verifications is
// plenty for a login form and leaves the pool usable for everything else.
import { normalizePhoneDigits } from '@shadhil/api-types';

import { verifyPasswordAsync } from './credentials';

const MAX_IN_FLIGHT = 2;
let inFlight = 0;
const waiting: Array<() => void> = [];

async function withVerificationSlot<T>(work: () => Promise<T>): Promise<T> {
  if (inFlight >= MAX_IN_FLIGHT) {
    await new Promise<void>((resolve) => waiting.push(resolve));
  }
  inFlight += 1;
  try {
    return await work();
  } finally {
    inFlight -= 1;
    waiting.shift()?.();
  }
}

/** Verify a password off the event loop, at most twice at a time. */
export function verifyWithSlot(
  plaintext: string,
  stored: string | null | undefined,
): Promise<boolean> {
  return withVerificationSlot(() => verifyPasswordAsync(plaintext, stored));
}

/** True when the identifier is an address rather than a number. */
export function looksLikeEmail(identifier: string): boolean {
  return identifier.includes('@');
}

/**
 * Digits-only phone, or null when the value cannot be one.
 *
 * Uses the same normaliser as every form (`common.ts`), so `9876543210`,
 * `+91 98765 43210` and `098765 43210` all land on `919876543210`. Hand-rolling
 * the strip breaks plain 10-digit input, which is the common case.
 */
export function normalisePhoneIdentifier(identifier: string): string | null {
  try {
    return normalizePhoneDigits(identifier);
  } catch {
    return null;
  }
}
