// Media display-URL policy (PURE - no Nest/Prisma/network, so it unit-tests).
//
// MEDIA (2026-09-18, owner decision "Option A"): chat IMAGES render straight
// from the storage provider's public CDN (ImageKit today, R2 later), skipping
// the BFF proxy. DOCUMENTS (PDFs, and anything non-image) keep the
// authenticated BFF path.
//
// Why the split: every provider public URL here is WORLD-READABLE - verified
// against the live bucket (a bare GET with no cookie/JWT and an unrelated
// User-Agent returns 200). That is fine for a photo in a sales thread, but
// passport scans and signed paperwork should not become bearer-token URLs that
// anyone can fetch forever. So exposure is scoped to images only.
//
// THE PROVIDER SEAM LIVES HERE. `directUrl` is whatever the StorageProvider's
// publicUrl(key) returns (null for LocalDisk, which has no public base), and
// the policy below is provider-agnostic. Migrating ImageKit -> R2 means:
//   1. add an R2 adapter whose publicUrl(key) returns the r2.dev/domain URL,
//   2. point the env at it,
// and this file does not change. Because Message.mediaKey stores the
// provider-neutral KEY (not a baked URL), no row migration is needed either.

/** Whether a display URL is safe to hand to the browser un-authenticated. */
export type MediaDisplayKind = 'direct' | 'proxied';

export interface MediaDisplayUrl {
  /** The URL to render. Absolute (https://...) or same-origin (/api/bff/...). */
  url: string;
  /**
   * 'direct'  - public CDN URL; safe for next/image and needs no cookie.
   * 'proxied' - same-origin BFF path; needs the session cookie, so it MUST be
   *             rendered with a plain <img> (next/image's optimiser drops the
   *             cookie for such a URL and answers 400 - verified).
   */
  kind: MediaDisplayKind;
}

/** Same-origin BFF read path for a storage key (the authenticated fallback). */
export function bffMediaPath(key: string): string {
  // Key may contain slashes (org/id/name) and Nest's route is a single :key
  // segment, so the whole key is percent-encoded.
  return `/api/bff/media/${encodeURIComponent(key)}`;
}

/** True when the mime type is an image we are willing to serve publicly. */
export function isPubliclyServableImage(mediaType: string | null | undefined): boolean {
  if (mediaType === null || mediaType === undefined) return false;
  return mediaType.startsWith('image/');
}

/**
 * Decide the display URL for an attachment.
 *
 * Precedence:
 *   1. An image with a provider public URL  -> that URL, 'direct'.
 *   2. A storage key (any other type)       -> BFF path, 'proxied'.
 *   3. A stored legacy `mediaUrl`           -> used verbatim.
 *
 * The legacy branch is what keeps pre-existing rows working: they hold a
 * fully-formed BFF path and no mediaKey, so they resolve to 'proxied' exactly
 * as before. No backfill required.
 *
 * @param input.mediaKey    Provider-neutral storage key (may be null on legacy rows).
 * @param input.mediaType   Mime type, used for the image/document split.
 * @param input.directUrl   Provider public URL for `mediaKey`, or null when the
 *                          provider has no public base (LocalDisk) / no key.
 * @param input.storedUrl   The row's persisted `mediaUrl` (legacy fallback).
 */
export function resolveMediaDisplayUrl(input: {
  mediaKey?: string | null;
  mediaType?: string | null;
  directUrl?: string | null;
  storedUrl?: string | null;
}): MediaDisplayUrl | null {
  const { mediaKey, mediaType, directUrl, storedUrl } = input;

  // 1. Public image: go straight to the CDN.
  if (
    mediaKey !== null &&
    mediaKey !== undefined &&
    mediaKey.length > 0 &&
    isPubliclyServableImage(mediaType) &&
    directUrl !== null &&
    directUrl !== undefined &&
    directUrl.length > 0
  ) {
    return { url: directUrl, kind: 'direct' };
  }

  // 2. Everything else with a key stays behind the authenticated proxy.
  if (mediaKey !== null && mediaKey !== undefined && mediaKey.length > 0) {
    return { url: bffMediaPath(mediaKey), kind: 'proxied' };
  }

  // 3. Legacy: no key, just the stored URL.
  if (storedUrl !== null && storedUrl !== undefined && storedUrl.length > 0) {
    return {
      url: storedUrl,
      // A stored absolute URL is a legacy public URL; a stored path is the BFF.
      kind: storedUrl.startsWith('http') ? 'direct' : 'proxied',
    };
  }

  return null;
}
