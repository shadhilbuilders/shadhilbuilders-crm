// Whether a buyer may receive a MARKETING template (owner note 2026-11-23).
//
// WHY THIS EXISTS: the site-update templates were approved as MARKETING, not the
// UTILITY they were submitted as. Meta requires MARKETING opt-in for marketing
// templates, and repeatedly sending marketing to people who did not opt in is
// what damages a sender number's quality rating - eventually down to a block.
// So the send needs a consent answer, not an assumption.
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

/** The slice of the caller's RLS transaction this check needs. */
export interface ConsentReader {
  consent: {
    findFirst(args: unknown): Promise<{ granted: boolean; grantedAt: Date } | null>;
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
): Promise<{ granted: boolean; grantedAt: Date } | null> {
  const type: ConsentType = 'MARKETING';
  return tx.consent.findFirst({
    where: { leadId, consentType: type },
    orderBy: [{ grantedAt: 'desc' }, { createdAt: 'desc' }],
    select: { granted: true, grantedAt: true },
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
