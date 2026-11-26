// Login lookup - "email or phone + password" resolved to the address the
// browser should sign in with (Round 67 split, extracted from users.service.ts).
//
// PUBLIC path: no JWT, no RLS context. The timing-safe miss path and the
// candidate cap live in ./login-identifier and ./credentials; this file decides
// WHICH identity the actor meant.

import type { PrismaClient } from '@shadhil/database';
import { LOGIN_IDENTIFIER_CANDIDATE_CAP } from '@shadhil/api-types';
import type { LoginIdentifierDto, LoginIdentifierResult } from '@shadhil/api-types';
import { TIMING_DUMMY_PASSWORD_HASH } from './credentials';
import { looksLikeEmail, normalisePhoneIdentifier, verifyWithSlot } from './login-identifier';
import { UsersBase } from './users.support';
import type { UsersDeps } from './users.support';

export class UsersLoginLookup extends UsersBase {
  /**
   * Resolve "email or phone + password" into the address the browser should
   * sign in with. PUBLIC path: no JWT, no RLS context.
   *
   * Two rules shape the whole method:
   *
   *   1. Every failure looks the same from outside. A malformed identifier, a
   *      phone with no account and a wrong password all answer `invalid`, and
   *      the controller returns 200 for all three (see `LoginIdentifierResult`).
   *   2. A request with no candidate still pays for one full scrypt, against a
   *      throwaway hash, so "no such account" cannot be told from "wrong
   *      password" by timing.
   *
   * The password is checked against the stored credential hash rather than
   * through better-auth: this route only answers "which address?", and the
   * browser then calls the ordinary sign-in with it, so sessions, cookies and
   * every better-auth hook stay on the path that already works.
   *
   * A number shared by two accounts is NOT an error. `Invite.phone` and
   * `User.phone` are deliberately non-unique (a site phone is shared), so the
   * picker exists: the password filters the candidates first, and only the ones
   * it matched are ever named.
   */
  async resolveLoginIdentifier(dto: LoginIdentifierDto): Promise<LoginIdentifierResult> {
    // User and Account are pre-RLS auth tables, so the bare client is correct.
    const client = this.client;
    const identifier = dto.identifier.trim();

    if (looksLikeEmail(identifier)) {
      const user = await client.user.findFirst({
        where: {
          email: identifier.toLowerCase(),
          deletedAt: null,
          // `banned` is NULLABLE, so `banned: false` alone would exclude every
          // row that has never been touched - the same trap the assignee
          // picker documents at :1781.
          OR: [{ banned: false }, { banned: null }],
        },
        select: { id: true, email: true },
      });
      const hash = user === null ? null : await this.credentialHash(client, user.id);
      const matches = await verifyWithSlot(dto.password, hash ?? TIMING_DUMMY_PASSWORD_HASH);
      return user !== null && hash !== null && matches
        ? { kind: 'ok', email: user.email }
        : { kind: 'invalid' };
    }

    const phone = normalisePhoneIdentifier(identifier);
    if (phone === null) {
      await verifyWithSlot(dto.password, TIMING_DUMMY_PASSWORD_HASH);
      return { kind: 'invalid' };
    }

    const candidates = await client.user.findMany({
      where: {
        phone,
        deletedAt: null,
        OR: [{ banned: false }, { banned: null }],
      },
      select: { id: true, email: true, name: true, role: true },
      orderBy: { id: 'asc' },
      take: LOGIN_IDENTIFIER_CANDIDATE_CAP,
    });
    if (candidates.length === 0) {
      await verifyWithSlot(dto.password, TIMING_DUMMY_PASSWORD_HASH);
      return { kind: 'invalid' };
    }

    // Sequential on purpose: the semaphore caps concurrent scrypt work anyway,
    // and a phone shared by five accounts already costs five hashes.
    const matched: typeof candidates = [];
    for (const candidate of candidates) {
      const hash = await this.credentialHash(client, candidate.id);
      if (hash !== null && (await verifyWithSlot(dto.password, hash))) {
        matched.push(candidate);
      }
    }
    const first = matched[0];
    if (first === undefined) return { kind: 'invalid' };
    if (matched.length === 1) return { kind: 'ok', email: first.email };

    const identities = await this.accountIdentities(
      client,
      matched.map((m) => m.id),
      phone,
    );

    // Second attempt from the picker: the person chose a specific account. It
    // must be one whose password already matched, so the handle cannot be used
    // to point at somebody else's row.
    if (dto.accountUserId !== undefined) {
      const chosen = matched.find((m) => m.id === dto.accountUserId);
      return chosen === undefined ? { kind: 'invalid' } : { kind: 'ok', email: chosen.email };
    }

    const accounts = matched.flatMap((m) => {
      const identity = identities.get(m.id);
      if (identity === undefined) return [];
      return [
        {
          userId: m.id,
          name: m.name,
          organizationName: identity.organizationName,
          organizationSlug: identity.organizationSlug,
          role: m.role,
        },
      ];
    });
    if (accounts.length === 0) return { kind: 'invalid' };
    if (accounts.length === 1) return { kind: 'ok', email: first.email };
    return { kind: 'pick', accounts };
  }

  /** Stored password hash for a user's credential account, or null. */
  private async credentialHash(client: PrismaClient, userId: string): Promise<string | null> {
    const account = await client.account.findFirst({
      where: { userId, providerId: 'credential', issuer: 'local:credential' },
      select: { password: true },
    });
    return account?.password ?? null;
  }
}
