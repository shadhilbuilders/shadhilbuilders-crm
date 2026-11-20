// Server-only fetch for the PUBLIC invite preview.
//
// The accept page is unauthenticated, so it cannot use the BFF (which requires
// a session cookie) or `lib/server/tenant.ts` (which mints a JWT). It calls the
// backend's public route directly with no Authorization header - the invite
// TOKEN in the path is the credential.
//
// The result is a discriminated union rather than `T | null`, for the same
// reason tenant.ts uses one: "expired", "revoked", "already accepted", "no such
// link" and "the backend is down" are five different screens, and collapsing
// them into one would tell a staff member their link never existed when it had
// simply lapsed.
import 'server-only';

import { cache } from 'react';

import type { PublicInvitePreview } from '@shadhil/api-types';

import { env } from '@/lib/env/env';

/** Why a preview did not produce a row. */
export type InvitePreviewFailure =
  /** No such token (or malformed). */
  | { kind: 'invalid' }
  | { kind: 'expired' }
  | { kind: 'revoked' }
  | { kind: 'accepted' }
  /** Backend unreachable / 5xx - transient, offer a retry. */
  | { kind: 'unavailable' };

export type InvitePreviewResult =
  | { ok: true; data: PublicInvitePreview }
  | { ok: false; failure: InvitePreviewFailure };

/** Matches the backend's invite error codes (see @shadhil/api-types). */
function classify(status: number, body: unknown): InvitePreviewFailure {
  const code =
    body !== null && typeof body === 'object' && 'code' in body
      ? (body as { code?: unknown }).code
      : undefined;
  if (status === 404) return { kind: 'invalid' };
  if (status === 410) {
    if (code === 'INVITE_EXPIRED') return { kind: 'expired' };
    if (code === 'INVITE_REVOKED') return { kind: 'revoked' };
    if (code === 'INVITE_ALREADY_ACCEPTED') return { kind: 'accepted' };
    return { kind: 'invalid' };
  }
  return { kind: 'unavailable' };
}

/**
 * GET /api/public/invites/:token.
 *
 * Cached per request so the page body and any metadata share one lookup.
 */
export const getInvitePreview = cache(async function getInvitePreview(
  token: string,
): Promise<InvitePreviewResult> {
  const target = new URL(`/api/public/invites/${encodeURIComponent(token)}`, env.BACKEND_API_URL);

  let upstream: Response;
  try {
    upstream = await fetch(target, {
      method: 'GET',
      cache: 'no-store',
      // A hung backend must not hang the page: the invitee sees a blank screen
      // with no retry otherwise.
      signal: AbortSignal.timeout(8_000),
    });
  } catch {
    return { ok: false, failure: { kind: 'unavailable' } };
  }

  if (!upstream.ok) {
    const body: unknown = await upstream.json().catch(() => null);
    return { ok: false, failure: classify(upstream.status, body) };
  }

  try {
    return { ok: true, data: (await upstream.json()) as PublicInvitePreview };
  } catch {
    return { ok: false, failure: { kind: 'unavailable' } };
  }
});

/**
 * POST /api/public/invites/:token/accept.
 *
 * Runs on the CLIENT (the form submits from the browser) through the same
 * public path - so this helper is only the URL, not a fetch. Kept here so the
 * path is defined once.
 */
export function inviteAcceptPath(token: string): string {
  return `/api/public/invites/${encodeURIComponent(token)}/accept`;
}
