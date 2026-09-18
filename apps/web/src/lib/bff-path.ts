// BFF path reconstruction (pure - no Next/Prisma imports, so it unit-tests).
//
// The BFF proxy at app/api/bff/[...path]/route.ts forwards browser requests to
// NestJS. The one subtle part is rebuilding the backend path, because Next's
// catch-all and Nest's single-segment routes disagree about slashes.

/**
 * Rebuild the backend path from Next's decoded catch-all segments.
 *
 * Next DECODES each catch-all segment before handing it over. So a media key
 * stored as `/org/id/name.png` (sent by the browser as `%2Forg%2Fid%2Fname.png`
 * so it stays a single URL segment) arrives as ONE segment whose value already
 * contains real slashes:
 *
 *   params.path = ['media', '/org/id/name.png']
 *
 * Joining that verbatim yields `media//org/id/name.png` - a double slash.
 * Nest's `@Get(':key')` matches a single segment, so the request 404s with
 * "Cannot GET /api/media//org/id/name.png" and every attachment preview breaks.
 *
 * Re-encoding each segment keeps an embedded slash percent-encoded (so it stays
 * one segment end-to-end) while genuine separators - which arrive as separate
 * array elements - keep their '/'. MediaController.read() then decodes the
 * single `:key` it receives.
 *
 * @param segments Decoded path segments from `ctx.params.path`.
 * @returns The path to append to the backend's `/api/` prefix.
 */
export function buildBackendPath(segments: readonly string[]): string {
  return segments.map((segment) => encodeURIComponent(segment)).join('/');
}
