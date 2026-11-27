'use client';

// ResendDeliveryButton (2026-11-26): act on a site update that did not send.
//
// WHY: every non-sent outcome used to be a dead record. The live one is
// SKIPPED_OPTED_OUT - a buyer who asked us to stop - and once they say yes again
// the staff member staring at that row needs something to press. SKIPPED_NO_CONSENT
// is the same situation from before the templates went UTILITY.
//
// The server decides everything. This button sends one request keyed on the
// delivery row and then SHOWS WHAT THE SERVER ANSWERED: the gates re-run, so a
// resend can refuse again (consent still missing, switch still off) and the
// message says which one. A refusal is not an error toast - nothing failed, and
// red for "the buyer has not opted in" would teach people to ignore red.
import { Button, toast } from '@paalstack/react-ui';
import { LuRefreshCw } from '@paalstack/react-icons/lu';

import { useResendSiteUpdate } from '@/hooks/queries/customer-progress';

/**
 * Delivery states worth a retry press.
 *
 * SENT/DELIVERED/READ: the buyer has it, and a second send is a duplicate
 * message to a real person. PENDING: the worker owns it. A row with no delivery
 * id (saved before delivery tracking existed) has nothing to act on, so the
 * caller should not render this at all.
 */
const RETRYABLE = new Set([
  'SKIPPED_WINDOW',
  'SKIPPED_NO_TEMPLATE',
  'SKIPPED_NO_BUYER',
  'SKIPPED_OPTED_OUT',
  // Legacy rows from when a missing opt-in blocked the send. Retryable for the
  // same reason as the row above: the server re-runs every gate, so the press
  // either sends now or says again why it cannot.
  'SKIPPED_NO_CONSENT',
  'SKIPPED_DISABLED',
  'FAILED',
]);

export function isRetryableDelivery(status: string | null | undefined): boolean {
  return status !== null && status !== undefined && RETRYABLE.has(status);
}

export function ResendDeliveryButton({
  unitId,
  deliveryId,
  className,
}: {
  unitId: string;
  deliveryId: string;
  className?: string;
}) {
  const resend = useResendSiteUpdate(unitId);

  return (
    <Button
      type="button"
      variant="ghost"
      size="sm"
      className={className}
      disabled={resend.isPending}
      data-qa="progress-resend"
      onClick={() => {
        resend.mutate(deliveryId, {
          onSuccess: (result) => {
            // The sentence comes from the server (resendMessage), so the staff
            // row and the API cannot disagree about why nothing was sent.
            toast.success(result.message);
          },
          onError: (err) => {
            toast.error(err instanceof Error ? err.message : 'Could not send the update again.');
          },
        });
      }}
    >
      <LuRefreshCw className={resend.isPending ? 'size-4 animate-spin' : 'size-4'} aria-hidden />
      {resend.isPending ? 'Sending…' : 'Send again'}
    </Button>
  );
}
