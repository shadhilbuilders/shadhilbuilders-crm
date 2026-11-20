'use client';

// InviteSendActions - the three ways to get an invite link to a staff member.
//
// Copy / WhatsApp / Call, in that order of reliability, with WhatsApp as the
// PRIMARY because it is the path that actually reaches staff in this
// deployment. Used twice: on the create/resend result panel (where the raw
// token is available) and on each PENDING row (where the table offers WhatsApp
// and Call but NOT a link - the link is only ever shown once).
//
// THREE DELIBERATE CONSTRAINTS, each from a real failure mode:
//
// 1. NEVER auto-open WhatsApp. The link is an explicit tap, never a redirect
//    after create. An unexpected app launch on a phone is a jarring,
//    hard-to-undo surprise, and on a desktop with no WhatsApp installed it
//    would do nothing at all - looking broken.
//
// 2. WhatsApp does NOT replace Copy. On iOS the wa.me handoff leaves the
//    browser and the admin may not come back, so the link must be readable and
//    copyable BEFORE the tap. They sit side by side, never one instead of the
//    other.
//
// 3. The wa.me URL comes FROM THE SERVER. It needs the digits-only phone form
//    and a stray `+` 404s silently, so one tested implementation server-side
//    beats a template built here.
import { Button } from '@paalstack/react-ui';
import { LuMessageCircle, LuPhone } from '@paalstack/react-icons/lu';

import { formatPhone, telUrl } from '@/lib/phone';

type Props = {
  /** Server-derived `https://wa.me/<digits>?text=<encoded>`. Null when the
   *  caller only has a phone (a table row) and no fresh token. */
  whatsappUrl?: string | null;
  /** Normalized digits-only phone. Drives the tel: fallback. */
  phone: string;
  /** For the accessible label, so a screen reader hears WHO this opens. */
  inviteeName: string;
  /** Suffix for data-qa, so a row instance and a dialog instance differ. */
  testId?: string;
};

export function InviteSendActions({ whatsappUrl, phone, inviteeName, testId = 'invite-send' }: Props) {
  const dial = telUrl(phone);
  const formatted = formatPhone(phone);

  return (
    // Stacked full-width below `sm`, in a row from `sm` up. Three buttons
    // across ~288px of dialog content is impossible, and there is no third
    // tier - the same two-tier rule the rest of this surface follows.
    <div className="flex flex-col gap-2 sm:flex-row sm:flex-wrap" data-qa={testId}>
      {whatsappUrl !== null && whatsappUrl !== undefined ? (
        <Button
          as="a"
          href={whatsappUrl}
          target="_blank"
          rel="noopener noreferrer"
          leftIcon={<LuMessageCircle className="size-4" />}
          aria-label={`Send the invite to ${inviteeName} on WhatsApp`}
          data-qa={`${testId}-whatsapp`}
          className="w-full sm:w-auto"
        >
          Send on WhatsApp
        </Button>
      ) : null}

      {dial.length > 0 ? (
        <Button
          as="a"
          href={dial}
          variant="outline"
          leftIcon={<LuPhone className="size-4" />}
          aria-label={`Call ${inviteeName} at ${formatted}`}
          data-qa={`${testId}-call`}
          className="w-full sm:w-auto"
        >
          Call {formatted}
        </Button>
      ) : null}
    </div>
  );
}
