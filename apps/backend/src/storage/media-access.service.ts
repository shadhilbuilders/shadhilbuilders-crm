// Media byte authorization (2026-11-07).
//
// WHY THIS EXISTS: the same-origin media URL (/api/bff/media/:key -> GET
// /api/media/:key) serves the BYTES behind a row. The row has RLS; the bytes
// did not. Checking only the key's org segment (media-key-scope.ts) closed the
// cross-tenant hole but still let any authenticated session in the right org
// read a photo or attachment that RLS hides from them - e.g. a CUSTOMER whose
// own unit is empty but who obtained another buyer's key.
//
// The rule: a key is readable only when a row the CALLER can see owns it.
// "Can see" is decided by running the lookup inside the caller's own RLS
// context, so there is no second copy of the permission rules here - the
// policies stay the single source of truth. A key owned by no visible row is
// indistinguishable from a key that does not exist, and both answer 404 (never
// 403: that would confirm the key is real to someone with no right to know).
//
// Owning tables (the only columns that hold a provider-neutral storage key):
//   - ProgressPhoto.key      (site progress photos, slice 1/2)
//   - Message.mediaKey       (chat attachments)
//   - User.avatarKey         (profile photos, 2026-11-24)
// OutboundMessage.mediaKey is a MIRROR of Message.mediaKey (the chat service
// writes the same value to both), not a third owner, so it is not consulted.
//
// Legacy rows written before mediaKey existed carry the BFF path in
// Message.mediaUrl instead, so that column is matched too - otherwise the fix
// would 404 every attachment older than 2026-09-18.
import { Inject, Injectable, Logger, NotFoundException } from '@nestjs/common';
import { rlsContextFrom, withRlsContext } from '@shadhil/database';
import type { JwtPayload } from '@shadhil/auth';

import { PrismaService } from '../prisma/prisma.module';
import { keyBelongsToOrg } from './media-key-scope';

/** What a key belongs to, for logging. Not used in the response. */
export type MediaOwner = 'ProgressPhoto' | 'Message' | 'User' | null;

@Injectable()
export class MediaAccessService {
  private readonly logger = new Logger(MediaAccessService.name);

  constructor(@Inject(PrismaService) private readonly prismaService: PrismaService) {}

  /**
   * The legacy display path a pre-mediaKey row stored for this key.
   * Mirrors `bffMediaPath` / `mediaUrlFor`.
   */
  private legacyPathFor(key: string): string {
    return `/api/bff/media/${encodeURIComponent(key)}`;
  }

  /**
   * Resolve which owning row the caller can see for `key`, or null.
   *
   * Runs in the caller's RLS context, so a row the caller cannot see simply
   * does not match - the policies answer the question, not this code.
   */
  async resolveOwner(actor: JwtPayload, key: string): Promise<MediaOwner> {
    const legacy = this.legacyPathFor(key);
    return withRlsContext(this.prismaService.$client, rlsContextFrom(actor), async (tx) => {
      const photo = await tx.progressPhoto.findFirst({
        // A video row owns TWO keys: the clip in `key` and the JPEG frame in
        // `posterKey`. Only `key` was matched until 2026-11-24, so every video's
        // poster answered 404 through /api/media even though the timeline tile
        // and the WhatsApp site-update image both point at it (measured on a
        // recorded fixture: clip 200, poster 404).
        where: { OR: [{ key }, { posterKey: key }] },
        select: { id: true },
      });
      if (photo !== null) return 'ProgressPhoto';

      const message = await tx.message.findFirst({
        where: { OR: [{ mediaKey: key }, { mediaUrl: legacy }] },
        select: { id: true },
      });
      if (message !== null) return 'Message';

      // User photo (2026-11-24). The organizationId filter is the ONLY tenant
      // wall on this lookup: `User` carries no RLS policy at all (policies.sql
      // grants the app role straight through), so the RLS context above cannot
      // narrow it. Without the filter, one org's avatar key would resolve
      // another org's row and the bytes would come back.
      //
      // Deliberately not filtered by role or team: a face photo is org-wide
      // info for everyone signed in, the same exposure chat images already
      // accept (media-display.ts). The key is unguessable, and this arm is only
      // reached through the authenticated route.
      const avatarOwner = await tx.user.findFirst({
        where: { avatarKey: key, organizationId: actor.organizationId },
        select: { id: true },
      });
      if (avatarOwner !== null) return 'User';

      return null;
    });
  }

  /**
   * Throw 404 unless the caller may read this key's bytes.
   *
   * The org pre-check runs first: it is cheap, and it rejects a foreign-tenant
   * key before opening a transaction.
   */
  async assertReadable(actor: JwtPayload, key: string): Promise<void> {
    if (!keyBelongsToOrg(key, actor.organizationId)) {
      // Cross-tenant or malformed: same answer as "no such key".
      throw new NotFoundException('Media not found');
    }

    const owner = await this.resolveOwner(actor, key);
    if (owner === null) {
      this.logger.debug(`[media] ${actor.role} ${actor.sub} denied key with no visible owning row`);
      throw new NotFoundException('Media not found');
    }
  }
}
