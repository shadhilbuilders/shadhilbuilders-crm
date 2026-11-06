// ────────────────────────────────────────────────────────────────────────────
// Lead source vocabulary + normalisation (single source of truth)
// ────────────────────────────────────────────────────────────────────────────
// T-LEAD-SOURCES (2026-11-05). A lead arrives from the landing form, Meta
// (Facebook or Instagram ads), a portal (Housing, MagicBricks, 99acres), a
// referral, a walk-in, or the website. The CRM cares about exactly one thing
// here: `Lead.source` is matched EXACTLY by the manager-assignment engine
// (`rule.source === lead.source`), so two spellings of the same channel split
// the routing rules in half and the leads land on the wrong team.
//
// Hence one canonical token per channel, and one place that maps whatever a
// caller sends onto it. The list lived in apps/web/src/lib/labels.ts before
// this; it moves here so the backend can validate and normalise against the
// same vocabulary the UI labels - two copies of a closed set is how a new
// channel ends up unassignable and unlabelled at the same time.
//
// NORMALISING NEVER REJECTS. An unrecognised channel becomes OTHER: losing a
// real enquiry because the ad platform sent 'ig' instead of 'INSTAGRAM' is a
// worse failure than an analytics bucket being coarse.
import { z } from 'zod';

export const LEAD_SOURCES = [
  '99ACRES',
  'HOUSING',
  'LANDING',
  'MAGICBRICKS',
  'META_AD',
  'OTHER',
  'REFERRAL',
  'WALK_IN',
  'WEBSITE',
] as const;

export const LeadSourceSchema = z.enum(LEAD_SOURCES);
export type LeadSource = z.infer<typeof LeadSourceSchema>;

/**
 * Aliases seen in the wild, and the canonical token each maps to.
 *
 * `META_AD` covers both Facebook and Instagram: they are one ad system with one
 * routing rule, and splitting them would mean two rules to keep in step for no
 * operational difference. If the business ever needs them apart, they become
 * FACEBOOK and INSTAGRAM here and the engine starts matching each.
 */
const SOURCE_ALIASES: Record<string, LeadSource> = {
  // Meta ads (Facebook + Instagram)
  meta: 'META_AD',
  meta_ad: 'META_AD',
  metaads: 'META_AD',
  'meta-ads': 'META_AD',
  facebook: 'META_AD',
  'facebook.com': 'META_AD',
  fb: 'META_AD',
  fb_ad: 'META_AD',
  instagram: 'META_AD',
  'instagram.com': 'META_AD',
  insta: 'META_AD',
  ig: 'META_AD',
  // Portals
  housing: 'HOUSING',
  'housing.com': 'HOUSING',
  housing_com: 'HOUSING',
  magicbricks: 'MAGICBRICKS',
  'magicbricks.com': 'MAGICBRICKS',
  magic_bricks: 'MAGICBRICKS',
  mb: 'MAGICBRICKS',
  '99acres': '99ACRES',
  '99acres.com': '99ACRES',
  '99_acres': '99ACRES',
  ninety_nine_acres: '99ACRES',
  // Owned
  landing: 'LANDING',
  'landing-page': 'LANDING',
  landing_page: 'LANDING',
  form: 'LANDING',
  enquiry_form: 'LANDING',
  website: 'WEBSITE',
  web: 'WEBSITE',
  site: 'WEBSITE',
  organic: 'WEBSITE',
  // Offline
  referral: 'REFERRAL',
  refer: 'REFERRAL',
  reference: 'REFERRAL',
  walkin: 'WALK_IN',
  walk_in: 'WALK_IN',
  'walk-in': 'WALK_IN',
  site_visit: 'WALK_IN',
  // Explicit catch-all
  other: 'OTHER',
  unknown: 'OTHER',
};

/**
 * Map anything a caller sends onto the canonical vocabulary.
 *
 * - absent/blank -> `LANDING`, which is what the landing page has always sent
 *   and keeps every existing caller working unchanged.
 * - an exact canonical token -> itself (case-insensitive).
 * - a known alias -> its canonical token.
 * - anything else -> `OTHER`.
 */
export function normalizeLeadSource(raw: string | null | undefined): LeadSource {
  const text = (raw ?? '').trim().toLowerCase();

  if (text === '') return 'LANDING';

  const key = text.replace(/\s+/g, '_');

  const canonical = LEAD_SOURCES.find(
    (source) => source.toLowerCase() === key,
  );
  if (canonical !== undefined) return canonical;

  const aliased = SOURCE_ALIASES[key];
  if (aliased !== undefined) return aliased;

  // Try the raw text too: 'housing.com' keeps its dot through the key step.
  const aliasedRaw = SOURCE_ALIASES[text];
  return aliasedRaw ?? 'OTHER';
}
