'use client';

// InviteStatusBadge - the ONE place an invite status becomes a label + tone.
//
// Every status carries TEXT. Colour is decoration, never the information:
// "Expired" vs "Pending" has to survive a phone in sunlight, a greyscale
// screenshot in a bug report, and a colour-blind reader. The frontend rule
// is explicit that colour alone is not an indicator.
//
// VARIANT CHOICE IS A CONTRAST DECISION. The repo's `destructive` badge variant
// is a TINT (bg-destructive/10 + text-destructive), which measures ~4.02:1
// light / ~3.24:1 dark - under AA for normal text. So EXPIRED deliberately uses
// `muted` rather than `destructive`: an expired invite is not an error the
// reader must act on urgently, it is a closed door, and `muted` reads correctly
// in both themes without leaning on a borderline pair.
import { Badge } from '@paalstack/react-ui';
import type { InviteStatus } from '@shadhil/api-types';

const LABELS: Readonly<Record<InviteStatus, string>> = {
  PENDING: 'Pending',
  ACCEPTED: 'Accepted',
  REVOKED: 'Revoked',
  EXPIRED: 'Expired',
};

/** Existing Badge variants only - no new colour is introduced for this feature. */
const VARIANTS: Readonly<
  Record<InviteStatus, 'success' | 'info' | 'muted' | 'warning'>
> = {
  // Waiting on the staff member: informational, not an alarm.
  PENDING: 'warning',
  // The account exists. This is the good outcome.
  ACCEPTED: 'success',
  // Deliberately closed by a human.
  REVOKED: 'muted',
  // Closed by the clock. See the header for why this is not `destructive`.
  EXPIRED: 'muted',
};

export function InviteStatusBadge({
  status,
  testId,
}: {
  status: InviteStatus;
  testId?: string;
}) {
  return (
    <Badge variant={VARIANTS[status]} data-qa={testId ?? `invite-status-${status}`}>
      {LABELS[status]}
    </Badge>
  );
}

export { LABELS as INVITE_STATUS_LABELS };
