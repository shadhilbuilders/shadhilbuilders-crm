// The site-video feature flag, read on the SERVER only (page.tsx) and passed down
// as a boolean. Same rule as the backend (readSiteVideoConfig): exactly 'true'
// turns it on; anything else, including unset, is off.
export function isSiteVideoEnabled(env: Readonly<Record<string, string | undefined>>): boolean {
  return env.SITE_VIDEO_CAPTURE === 'true';
}
