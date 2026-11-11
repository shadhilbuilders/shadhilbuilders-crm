// Portal-only typeface (redesign 2026-11-09, pass 3): Space Grotesk.
//
// WHY SPACE GROTESK: the staff app's Inter reads as UI text. Space Grotesk
// carries real character at display sizes - squarish bowls, a distinctive 'a'
// and 'G' - which is what makes the record head look like a designed document
// instead of a scaled-up label. next/font self-hosts it, so there is no Google
// CDN request and the woff2 loads only on portal routes.
//
// NOTE: Space Grotesk varies on the WEIGHT axis only. It has no `opsz` axis, so
// display sizes are handled with tracking (see `.portal-display` in
// styles/portal.css), not font-variation-settings.
import { Space_Grotesk } from 'next/font/google';

const sans = Space_Grotesk({
  subsets: ['latin'],
  variable: '--font-portal-sans',
  display: 'swap',
});

/** Space-separated class names that define the CSS variable. */
export const PORTAL_FONT_VARIABLES = sans.variable;
