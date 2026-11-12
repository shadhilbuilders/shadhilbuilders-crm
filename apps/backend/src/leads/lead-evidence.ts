// ────────────────────────────────────────────────────────────────────────────
// Lead evidence - what it means for a source to "say" something about a lead.
// ────────────────────────────────────────────────────────────────────────────
// T-LEAD-FACTS (2026-11-05). Pure functions only: no Nest, no Prisma, no I/O.
// The pattern is deliberately borrowed from Comp AI's open-source CRM
// (`apps/agent/lib/evidence.ts`), which solves the same problem for the same
// reason and is worth crediting rather than re-deriving.
//
// THE RULE
// No producer ever supplies a confidence. A producer reports what it OBSERVED
// ("the WhatsApp profile name is 'Ramesh'", "they replied from this number on
// thread X") and this file prices it. A model asked to grade its own certainty
// will, and it will be wrong in the direction that makes it look useful. A
// confidently wrong phone number or name on a lead is worse than a blank one,
// because nobody downstream can tell it is wrong.
//
// WHY WEIGHTS, NOT A SUM
// Independent sources combine multiplicatively: `1 - Π(1 - w)`. Two weak
// observations cannot add up to certainty the way summing would let them, and
// one strong source does not have to be perfect to clear the bar.
// ────────────────────────────────────────────────────────────────────────────

/**
 * The Lead columns a fact may name, and the column it writes when applied.
 * A field with `column: null` would be suggestion-only; none are today, and
 * adding one means adding it here AND to `lead-facts.rules.ts`'s blank check.
 *
 * Deliberately absent: `phone` and `phoneE164`. They are the identity key
 * (the WhatsApp webhook resolves a Lead by `phoneE164`), so a guessed phone
 * is not a data-quality problem, it is a merge of two customers.
 */
export const LEAD_FACT_FIELDS = {
  name: { column: 'name' },
  email: { column: 'email' },
  source: { column: 'source' },
} as const;

export type LeadFactField = keyof typeof LEAD_FACT_FIELDS;

export type LeadFactColumn = NonNullable<(typeof LEAD_FACT_FIELDS)[LeadFactField]['column']>;

export const LEAD_FACT_FIELD_NAMES = Object.keys(LEAD_FACT_FIELDS) as LeadFactField[];

export type FactBand = 'VERIFIED' | 'PROBABLE' | 'POSSIBLE';

/**
 * How a claim was observed. The `primary` flag is the important half: only a
 * source that identifies THIS person can carry a fact on its own. Everything
 * else is true-but-not-enough, which is most of what intake sees.
 */
export type EvidenceKind =
  // Primary - a source identifying this person, not merely consistent with them.
  | 'lead.reply-from-number'
  | 'enquiry.form-email'
  | 'booking.contact-match'
  | 'site-visit.signin'
  // Supporting - consistent, and deliberately worth less than the floor for
  // applying on its own once something is already on the record.
  | 'call.note-mentions'
  | 'whatsapp.message-mentions'
  | 'whatsapp.profile-name'
  | 'handle.name-form'
  // Sources disagree. Holds the fact rather than averaging it.
  | 'contradiction';

type Weighting = {
  weight: number;
  primary: boolean;
  label: string;
};

export const EVIDENCE_WEIGHTS = {
  'lead.reply-from-number': {
    weight: 0.9,
    primary: true,
    label: 'they replied from this number on a thread we hold',
  },
  'enquiry.form-email': {
    weight: 0.9,
    primary: true,
    label: 'the enquiry form itself carried this address',
  },
  'booking.contact-match': {
    weight: 0.85,
    primary: true,
    label: 'a booking exists under this name and number',
  },
  'site-visit.signin': {
    weight: 0.75,
    primary: true,
    label: 'they signed in at a site visit',
  },
  'call.note-mentions': {
    weight: 0.55,
    primary: false,
    label: "a telecaller's note says so",
  },
  'whatsapp.message-mentions': {
    weight: 0.45,
    primary: false,
    label: 'their own message says so',
  },
  'whatsapp.profile-name': {
    weight: 0.4,
    primary: false,
    label: 'their WhatsApp profile name says so (what they typed into their own phone)',
  },
  'handle.name-form': {
    // Below BAND_FLOOR.POSSIBLE on purpose: `github.com/ramesh` is a form of
    // every Ramesh's name, so on its own it is never worth storing. It only
    // becomes evidence alongside something that identifies a person.
    weight: 0.25,
    primary: false,
    label: 'the handle is a form of the name',
  },
  contradiction: {
    weight: 0,
    primary: false,
    label: 'another source disagrees',
  },
} satisfies Record<EvidenceKind, Weighting>;

export type Evidence = {
  kind: EvidenceKind;
  detail: string;
  sourceUrl?: string;
};

export type Scored = {
  score: number;
  band: FactBand | null;
  hasPrimary: boolean;
  rationale: string;
};

/** Independence is capped: five sources cannot claim certainty. */
const CEILING = 0.99;

/**
 * A contradiction does not shade the score, it holds the fact. Set below
 * BAND_FLOOR.POSSIBLE so "held" means held: no band, nothing stored, nothing
 * offered. Comp AI caps at 0.45, which still clears their POSSIBLE floor and
 * so lets a contradicted claim fill a blank field; that is the one place this
 * port deliberately differs.
 */
const CONTRADICTED = 0.2;

export const BAND_FLOOR = {
  VERIFIED: 0.85,
  PROBABLE: 0.55,
  POSSIBLE: 0.3,
} as const;

export function scoreEvidence(evidence: readonly Evidence[]): Scored {
  if (evidence.length === 0) {
    return {
      score: 0,
      band: null,
      hasPrimary: false,
      rationale: 'No evidence.',
    };
  }

  const contradicted = evidence.some((item) => item.kind === 'contradiction');
  const hasPrimary = evidence.some((item) => EVIDENCE_WEIGHTS[item.kind].primary);

  const remaining = evidence.reduce(
    (rest, item) => rest * (1 - EVIDENCE_WEIGHTS[item.kind].weight),
    1,
  );

  let score = Math.min(CEILING, 1 - remaining);
  if (contradicted) score = Math.min(score, CONTRADICTED);

  return {
    score: round(score),
    band: bandFor(score, hasPrimary),
    hasPrimary,
    rationale: rationaleFor(evidence, contradicted, hasPrimary),
  };
}

export function bandFor(score: number, hasPrimary: boolean): FactBand | null {
  if (score >= BAND_FLOOR.VERIFIED && hasPrimary) return 'VERIFIED';
  if (score >= BAND_FLOOR.PROBABLE) return 'PROBABLE';
  if (score >= BAND_FLOOR.POSSIBLE) return 'POSSIBLE';
  return null;
}

/**
 * The sentence a rep reads next to the suggestion. Written for them, not for
 * a log: "their WhatsApp profile name says so" is actionable, "score 0.4" is
 * not.
 */
function rationaleFor(
  evidence: readonly Evidence[],
  contradicted: boolean,
  hasPrimary: boolean,
): string {
  if (contradicted) {
    const clash = evidence.find((item) => item.kind === 'contradiction');
    return `Held: ${clash?.detail || 'sources disagree'}.`;
  }

  const reasons = evidence
    .filter((item) => item.kind !== 'contradiction')
    .map((item) => EVIDENCE_WEIGHTS[item.kind].label);

  if (reasons.length === 0) return 'No supporting evidence.';

  const list = joinWords(reasons);
  return hasPrimary
    ? capitalise(list)
    : `${capitalise(list)}, but nothing that identifies them directly.`;
}

function joinWords(words: readonly string[]): string {
  if (words.length === 1) return words[0] as string;
  return `${words.slice(0, -1).join(', ')} and ${words.at(-1)}`;
}

function capitalise(value: string): string {
  return value.charAt(0).toUpperCase() + value.slice(1);
}

function round(value: number): number {
  return Math.round(value * 1000) / 1000;
}

const HOST_ALIASES = new Map([
  ['twitter.com', 'x.com'],
  ['mobile.twitter.com', 'x.com'],
]);

/**
 * Compare a stored value to an offered one. The STORED value is always what
 * the source said; only the comparison normalises.
 *
 * Byte comparison is the bug this exists to prevent: `.../in/ramesh/` and
 * `.../in/ramesh` are the same profile, so a suggestion that offers back the
 * value already in the field is a click that can only say yes.
 */
export function sameValue(a: string, b: string): boolean {
  return canonicalValue(a) === canonicalValue(b);
}

export function canonicalValue(value: string): string {
  const text = value.trim().replace(/\s+/g, ' ').toLowerCase();
  const url = asWebUrl(text);

  if (!url) return text;

  const host = url.host.replace(/^www\./, '');
  const path = url.pathname.replace(/\/+$/, '');

  return `${HOST_ALIASES.get(host) ?? host}${path}`;
}

function asWebUrl(value: string): URL | null {
  try {
    const url = new URL(value);
    return url.protocol === 'http:' || url.protocol === 'https:' ? url : null;
  } catch {
    return null;
  }
}
