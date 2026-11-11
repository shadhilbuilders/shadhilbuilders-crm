// Storage-key tenant scope (2026-11-07).
//
// WHY THIS EXISTS: GET /api/media/:key used to check only "is there a session",
// then decode the key and stream the bytes. Both adapters name every key
// `{organizationId}/{randomId}/{filename}` (imagekit adds a leading slash), so
// the org was IN the key - but nothing ever compared it to the caller's org.
// A photo row is protected by RLS; the image bytes behind `mediaUrl` were not.
// Any authenticated session holding another org's key could read that file.
//
// The key namespace is the authorization boundary here, so this module is the
// one place that decides "may this key be served to this org". Pure and
// dependency-free so the rule is testable without a storage adapter, a request,
// or a database.
//
// FAIL CLOSED: a key that does not parse into `{org}/...` is rejected, not
// waved through. Every adapter writes the org first, so an unparseable key is
// either corrupt or crafted.

/**
 * Normalise an ImageKit-style key (leading slash) to the slash-free form both
 * adapters otherwise share, and reject anything that is not a plain relative
 * path.
 *
 * @returns the key with no leading slash, or null when it must not be served.
 */
function normaliseKey(key: string): string | null {
  if (typeof key !== 'string' || key.length === 0) return null;
  // A URL-encoded separator or a backslash would let the first segment lie
  // about the org while the provider resolves a deeper path.
  if (key.includes('\\') || key.includes('%2f') || key.includes('%2F')) return null;
  const stripped = key.startsWith('/') ? key.slice(1) : key;
  if (stripped.length === 0) return null;
  // Traversal segments are refused here as well as in the adapters: this rule
  // must not be the weaker of the two walls.
  if (stripped.split('/').some((segment) => segment === '..' || segment === '.')) {
    return null;
  }
  return stripped;
}

/**
 * True when `key` lives in `organizationId`'s namespace.
 *
 * @param key Storage key as stored on the row / in the URL (may carry a
 *            leading slash, as ImageKit's filePath does).
 * @param organizationId The caller's org, from the verified JWT.
 */
export function keyBelongsToOrg(key: string, organizationId: string): boolean {
  if (typeof organizationId !== 'string' || organizationId.length === 0) return false;
  const normalised = normaliseKey(key);
  if (normalised === null) return false;
  const separator = normalised.indexOf('/');
  // A key with no separator has no org segment at all - not ours.
  if (separator === -1) return false;
  return normalised.slice(0, separator) === organizationId;
}

/** The org segment of a key, or null. Exported for tests and diagnostics. */
export function orgOfKey(key: string): string | null {
  const normalised = normaliseKey(key);
  if (normalised === null) return null;
  const separator = normalised.indexOf('/');
  if (separator === -1) return null;
  return normalised.slice(0, separator);
}
