// The link a site-update WhatsApp message carries (build-sequence step 8, gap 6).
//
// WHY A LINK AND NOT JUST MEDIA: the media header is the update; the link is
// where the buyer goes to see the whole record (the stage ladder, the earlier
// photos, the note in context). It must also survive a SIGNED-OUT buyer, which
// is the normal case on a phone that has never opened the portal: the proxy
// bounces the path to `/login?next=<path>`, and LoginForm's `isSafeNextPath`
// accepts only same-origin absolute paths, so the buyer lands on the record
// after signing in rather than on the dashboard.
//
// The origin resolution is DELIBERATELY the same order as `invites.service.ts`:
// the two links have the same failure mode (a link that points at the API host),
// and two copies of that resolution would drift.

/**
 * The web app's origin, or throws. Same four rules as the invite link, and for
 * the same reason: the API and the web app are different hosts in production.
 */
export function resolveAppOrigin(env: Readonly<Record<string, string | undefined>>): string {
  const explicit = env['APP_URL'] ?? env['NEXT_PUBLIC_APP_URL'];
  if (explicit !== undefined && explicit.length > 0) return explicit;

  const corsFirst = (env['CORS_ORIGINS'] ?? '')
    .split(',')
    .map((s) => s.trim())
    .find((s) => s.length > 0);
  if (corsFirst !== undefined) return corsFirst;

  const authUrl = env['BETTER_AUTH_URL'];
  const apiPort = env['API_PORT'];
  if (authUrl !== undefined && authUrl.length > 0) {
    const isApiOrigin =
      apiPort !== undefined && apiPort.length > 0 && authUrl.includes(`:${apiPort}`);
    if (!isApiOrigin) return authUrl;
  }

  throw new Error(
    'Cannot build a site-update link: set APP_URL to the WEB app origin (e.g. https://crm.example.com).',
  );
}

/**
 * The buyer's portal, at the photo (or clip) that was just saved:
 * `<origin>/portal?unit=<unitId>&photo=<rowId>`.
 *
 * `photo` is the existing key the portal already opens full-bleed, so no new
 * route or query contract is introduced. Both values are ids we just wrote, and
 * they are encoded so an id can never smuggle a second parameter.
 */
export function buildSiteUpdateLink(origin: string, unitId: string, rowId: string): string {
  const params = new URLSearchParams({ unit: unitId, photo: rowId });
  return `${origin.replace(/\/+$/, '')}/portal?${params.toString()}`;
}

/** The message body a buyer reads: what happened, then the link to the record. */
export function siteUpdateMessage(input: {
  unitNumber: string;
  stage: string | null;
  takenAt: string;
  link: string;
}): string {
  const bits = [`Site update for ${input.unitNumber}`];
  if (input.stage !== null && input.stage.length > 0) bits.push(input.stage);
  bits.push(new Date(input.takenAt).toISOString().slice(0, 10));
  return `${bits.join(' · ')}\n${input.link}`;
}
