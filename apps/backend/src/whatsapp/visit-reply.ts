// T-WA-VISIT-REPLY (2026-11-11): what a customer's WhatsApp reply means.
//
// The visit reminder asks the customer to "Reply YES to confirm or
// RESCHEDULE", so those two words are a UI control delivered over a messaging
// app. Everything else is ordinary conversation and must stay ordinary: the
// parser answers null rather than guessing, because a visit confirmed by
// mistake sends a sales exec to a site where nobody is waiting.
//
// Pure: no Nest, no Prisma, no clock. The webhook owns the writes.
export type VisitReplyIntent = 'CONFIRM' | 'RESCHEDULE';

/**
 * The whole answer, and nothing else. One word per intent - `Y` because people
 * type it, `CONFIRM` because the staff-side copy uses that word.
 *
 * Deliberately absent: NO / CANCEL. Cancelling a visit from a one-word reply is
 * a product decision (who may cancel, what happens to the slot, does the lead
 * move) that this ticket does not make. The word falls through to `null` and is
 * still stored as a message, so a human sees it.
 */
const INTENTS: ReadonlyMap<string, VisitReplyIntent> = new Map([
  ['YES', 'CONFIRM'],
  ['Y', 'CONFIRM'],
  ['CONFIRM', 'CONFIRM'],
  ['RESCHEDULE', 'RESCHEDULE'],
  ['RESCHED', 'RESCHEDULE'],
]);

/**
 * Read a customer's reply.
 *
 * Whole-message matching only - never `includes()`. "yes I will come by 5" is a
 * customer with a question and must not flip a visit; the same rule keeps a
 * stray "no" inside a sentence from ever cancelling one.
 */
export function parseVisitReply(body: string): VisitReplyIntent | null {
  const word = normalize(body);
  if (word.length === 0) return null;
  return INTENTS.get(word) ?? null;
}

/**
 * Trim, uppercase, and strip punctuation or emoji from the ends, so `YES!`,
 * ` yes ` and `Yes 👍` are one answer. Inner punctuation and inner spacing are
 * kept on purpose: "yes, ok" and "Y E S" stay multi-word and therefore never
 * match.
 */
function normalize(body: string): string {
  return body
    .trim()
    .toUpperCase()
    .replace(/^[^A-Z]+/, '')
    .replace(/[^A-Z]+$/, '')
    .replace(/\s+/g, ' ');
}
