// Staff invite token helpers (2026-11-20).
//
// A token is a 43-character base64url string (32 random bytes). Only its
// sha256 hex is ever stored (`Invite.tokenHash`), so a database read - or a
// leaked backup - cannot mint a working link. Lookup is by that unique
// column, which means no secret is compared in application code: the database
// index does it, and a wrong token is simply an absent row.
//
// WHY 32 BYTES: this is a bearer credential in a URL that travels over
// WhatsApp, so it needs to be unguessable against an online attack
// (256 bits is far past any practical brute force) while staying short enough
// to paste into a chat without wrapping awkwardly. base64url, not base64,
// because the token sits in a URL path and `+` / `/` would need escaping.
import { createHash, randomBytes } from 'node:crypto';

/** Length of the raw token in characters (32 bytes -> 43 base64url chars). */
export const INVITE_TOKEN_LENGTH = 43;

/** Generate a fresh raw token. Never stored; returned to the caller once. */
export function generateInviteToken(): string {
  return randomBytes(32).toString('base64url');
}

/**
 * sha256 hex of a raw token. This is what goes in `Invite.tokenHash`.
 *
 * Deliberately NOT a password hash (bcrypt/argon): the token is 256 bits of
 * true entropy, not a human-chosen secret, so there is nothing to slow down -
 * a fast hash is correct here, and it keeps the accept lookup a single index
 * probe instead of a scan.
 */
export function hashInviteToken(rawToken: string): string {
  return createHash('sha256').update(rawToken, 'utf8').digest('hex');
}

/**
 * Cheap shape check before any database work.
 *
 * A raw token is base64url and exactly 43 chars. Rejecting a malformed value
 * here means a scanner hitting `/invite/<garbage>` costs no query, and the
 * public endpoints cannot be used to probe the token index with arbitrary
 * strings. It is NOT a substitute for the hash lookup - it only filters
 * input that could never match.
 */
export function looksLikeInviteToken(rawToken: string): boolean {
  return /^[A-Za-z0-9_-]{43}$/.test(rawToken);
}

/**
 * What the caller is allowed to do with an invite right now.
 *
 * EXPIRED is DERIVED, never stored: a PENDING row past `expiresAt` reports
 * EXPIRED on every read. That keeps the DB free of a cron that would have to
 * sweep rows, and it means an invite cannot be "accidentally valid" because a
 * sweeper fell behind. The stored enum value EXPIRED exists for completeness
 * and for a future explicit expiry sweep; nothing writes it today.
 */
export type EffectiveInviteStatus = 'PENDING' | 'ACCEPTED' | 'REVOKED' | 'EXPIRED';

export interface InviteStatusFields {
  status: 'PENDING' | 'ACCEPTED' | 'REVOKED' | 'EXPIRED';
  expiresAt: Date;
}

/**
 * Resolve the status a user should SEE, from the stored status + deadline.
 *
 * Order matters: ACCEPTED and REVOKED are terminal and win over the deadline.
 * An invite accepted on day 6 stays ACCEPTED on day 8 rather than flipping to
 * EXPIRED, which would make the admin table rewrite history.
 */
export function effectiveStatus(
  invite: InviteStatusFields,
  now: Date = new Date(),
): EffectiveInviteStatus {
  if (invite.status === 'ACCEPTED') return 'ACCEPTED';
  if (invite.status === 'REVOKED') return 'REVOKED';
  if (invite.status === 'EXPIRED') return 'EXPIRED';
  return invite.expiresAt.getTime() <= now.getTime() ? 'EXPIRED' : 'PENDING';
}

/** Absolute expiry for a freshly issued token. */
export function inviteExpiryFrom(now: Date = new Date(), ttlDays = 7): Date {
  return new Date(now.getTime() + ttlDays * 24 * 60 * 60 * 1000);
}
