import type { PrismaClient } from '@shadhil/database';

/**
 * Can this lead actually receive a WhatsApp message?
 *
 * There is NO pre-flight lookup in the WhatsApp Cloud API: nothing answers
 * "is this number on WhatsApp" before a send. The state is derived from
 * evidence we already store, and it says so rather than pretending to know:
 *
 *   REACHABLE    they wrote to us, or Meta reported a delivery
 *   UNREACHABLE  the last attempt came back 131026 (undeliverable / not a
 *                WhatsApp user) and nothing has come in since
 *   UNKNOWN      never messaged, never wrote in - the state of every new lead
 *
 * 131030 is deliberately NOT unreachable: it means the sender is in test mode
 * (recipient not on the allowlist), not that the person lacks WhatsApp.
 */

export type WhatsAppReachability = 'REACHABLE' | 'UNREACHABLE' | 'UNKNOWN';

export const UNDELIVERABLE_CODE = '131026';

export interface ReachabilityVerdict {
  state: WhatsAppReachability;
  /** Why, in one sentence a person can act on. Null when UNKNOWN. */
  detail: string | null;
}

export const UNREACHABLE_DETAIL =
  'The last message to this number was not delivered. WhatsApp reports it is not on WhatsApp.';

export async function deriveWhatsAppReachability(
  client: PrismaClient,
  leadId: string,
): Promise<ReachabilityVerdict> {
  const [inbound, lastOutbound] = await Promise.all([
    client.message.findFirst({
      where: { leadId, direction: 'IN' },
      select: { id: true },
    }),
    client.outboundMessage.findFirst({
      where: { leadId },
      orderBy: { createdAt: 'desc' },
      select: { status: true, lastError: true, createdAt: true },
    }),
  ]);

  if (inbound !== null) return { state: 'REACHABLE', detail: null };

  if (lastOutbound === null) return { state: 'UNKNOWN', detail: null };

  if (lastOutbound.status === 'SENT' || lastOutbound.status === 'DELIVERED') {
    return { state: 'REACHABLE', detail: null };
  }

  if (lastOutbound.status === 'FAILED' && isUndeliverable(lastOutbound.lastError)) {
    return { state: 'UNREACHABLE', detail: UNREACHABLE_DETAIL };
  }

  return { state: 'UNKNOWN', detail: null };
}

/**
 * Meta's code arrives as JSON in `lastError`, and older rows only carry the
 * prose. Both are checked: a code inside the text is the reliable signal, and
 * a false negative just leaves the state UNKNOWN, which is honest.
 */
function isUndeliverable(lastError: string | null): boolean {
  if (lastError === null) return false;
  return lastError.includes(UNDELIVERABLE_CODE);
}
