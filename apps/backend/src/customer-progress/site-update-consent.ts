// What a buyer said about site-update messages (owner note 2026-11-23).
//
// WHY THIS EXISTS: the site-update templates were MARKETING when this was
// written, so an opt-in was a delivery precondition. They are UTILITY now
// (2026-11-24), and since 2026-11-27 only a denial blocks: the answer is still
// read on every outside-window send, but "never asked" no longer stops one. What
// remains is the part that matters legally and for the sender's quality rating -
// the buyer who said stop must not be messaged.
//
// THE RULE, in order:
//   1. The latest MARKETING row for this lead, if any, decides. Consent is a
//      LEDGER (rows, not a boolean), so a later opt-out overrides an earlier
//      opt-in; `granted` on the newest row is the answer.
//   2. No MARKETING row at all is NOT consent. A lead that existed before the
//      consent model has no row, and "we never asked" must not read as "yes" -
//      that is exactly the population a quality-rating complaint comes from.
//
// Inside the 24h customer-service window this never runs: a freeform reply is
// not a marketing template, so no opt-in is required.
import type { ConsentType } from '@shadhil/database';

/** One row of the ledger, as every reader of it needs it. */
export interface NewestConsentRow {
  granted: boolean;
  grantedAt: Date;
  /** How it was obtained; the panel names it, the sender ignores it. */
  source: string;
  /** The buyer's words, if the operator recorded any. */
  note: string | null;
}

/** The slice of the caller's RLS transaction this check needs. */
export interface ConsentReader {
  consent: {
    findFirst(args: unknown): Promise<NewestConsentRow | null>;
  };
}

export type MarketingConsent = 'granted' | 'denied' | 'never-asked';

/**
 * The newest MARKETING row itself, or null when the lead has never been asked.
 *
 * Every reader of this ledger goes through here, because the ordering IS the
 * rule: a later opt-out has to beat an earlier opt-in, and two call sites
 * ordering it differently is how a "granted" answer survives an opt-out.
 * Two, not one: the send decision needs the answer (`marketingConsent`), the
 * lead detail needs the moment it was given.
 */
export async function newestMarketingConsentRow(
  tx: ConsentReader,
  leadId: string,
): Promise<NewestConsentRow | null> {
  const type: ConsentType = 'MARKETING';
  return tx.consent.findFirst({
    where: { leadId, consentType: type },
    orderBy: [{ grantedAt: 'desc' }, { createdAt: 'desc' }],
    // Source and note ride along because the panel shows them and the dialog
    // prefills the note from here: without them a rep reopens the dialog and
    // the words they just recorded are gone from the box (2026-11-27).
    select: { granted: true, grantedAt: true, source: true, note: true },
  });
}

/**
 * The newest MARKETING consent state for a lead, as three distinct answers.
 *
 * Three, not two: "denied" and "never-asked" are both non-sends, but they are
 * different things to tell an operator - one is a customer who said no, the
 * other is a record nobody has asked yet.
 */
export async function marketingConsent(
  tx: ConsentReader,
  leadId: string,
): Promise<MarketingConsent> {
  const latest = await newestMarketingConsentRow(tx, leadId);
  if (latest === null) return 'never-asked';
  return latest.granted ? 'granted' : 'denied';
}
