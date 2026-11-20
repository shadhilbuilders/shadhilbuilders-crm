'use client';

// InviteRowActions + RevokeInviteDialog.
//
// The row menu mirrors UserRowActions' structure (published dropdown
// primitives, disabled items wrapped in an explaining Tooltip) because the two
// tables sit as tabs of the same page and must behave identically.
//
// WHAT A ROW CAN DO, and why:
//   * Call - the phone is on the row, so this works without a token.
//   * Resend - issues a NEW link and kills the old one; the result panel offers
//     Copy / WhatsApp because THAT is where a token exists.
//   * Revoke - terminal.
//
// There is deliberately NO "send on WhatsApp" or "copy link" on the row: the
// raw token is never recoverable from the database (only its sha256 is
// stored), so a row simply does not have a link to send. Offering either would
// be a dead action, which is worse than not offering it. Resend is the honest
// path to a working link.
import {
  Button,
  Dialog,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuRoot,
  DropdownMenuTrigger,
  toast,
} from '@paalstack/react-ui';
import { LuBan, LuEllipsis, LuPhone, LuRefreshCw } from '@paalstack/react-icons/lu';
import { useState } from 'react';

import type { InviteRow } from '@shadhil/api-types';
import { useResendInvite, useRevokeInvite } from '@/hooks/queries/invites';
import { formatPhone, telUrl } from '@/lib/phone';

import { CopyableLink } from './CopyableLink';
import { InviteSendActions } from './InviteSendActions';

export function InviteRowActions({ invite }: { invite: InviteRow }) {
  const [resendOpen, setResendOpen] = useState(false);
  const [revokeOpen, setRevokeOpen] = useState(false);
  const resend = useResendInvite();

  // Terminal states have no actions beyond "look at it". A 44px menu button on
  // every accepted row would be noise, so the trigger is only rendered where
  // there is something to do.
  const isTerminal = invite.status === 'ACCEPTED' || invite.status === 'REVOKED';
  const dial = telUrl(invite.phone);

  if (isTerminal) {
    return null;
  }

  return (
    <div className="text-right">
      <DropdownMenuRoot>
        <DropdownMenuTrigger
          render={
            <Button
              variant="ghost"
              // size-11 (44px) on a coarse pointer, compact with a mouse. The
              // Members table's trigger is a hard size-8, which is under the
              // 44px minimum - this does not reproduce that.
              className="flex size-11 p-0 pointer-fine:size-8"
              aria-label={`Actions for ${invite.name}`}
              data-qa={`invite-row-actions-${invite.id}`}
            >
              <LuEllipsis className="size-4" />
            </Button>
          }
        />

        <DropdownMenuContent align="end" className="w-52">
          {dial.length > 0 ? (
            <DropdownMenuItem
              render={
                <a href={dial} aria-label={`Call ${formatPhone(invite.phone)}`}>
                  <LuPhone className="text-muted-foreground mr-2 size-4" aria-hidden="true" />
                  Call {formatPhone(invite.phone)}
                </a>
              }
              className="cursor-pointer"
              data-qa="invite-row-call"
            />
          ) : null}

          <DropdownMenuItem className="cursor-pointer" onClick={() => setResendOpen(true)} data-qa="invite-row-resend">
            <LuRefreshCw className="text-muted-foreground mr-2 size-4" />
            Resend (new link)
          </DropdownMenuItem>

          <DropdownMenuItem className="cursor-pointer" onClick={() => setRevokeOpen(true)} data-qa="invite-row-revoke">
            <LuBan className="text-muted-foreground mr-2 size-4" />
            Revoke
          </DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenuRoot>

      {/* Resend result: a NEW link, shown once. Same panel as create. */}
      <Dialog
        open={resendOpen}
        onOpenChange={(next) => {
          setResendOpen(next);
          if (!next) resend.reset();
        }}
        header={{
          title: 'New invite link',
          description: 'The previous link has stopped working.',
        }}
        trigger={null}
        contentClassName="max-h-[calc(100dvh-4rem)] overflow-y-auto sm:max-w-lg"
        footer={
          <div className="flex w-full justify-end">
            <Button onClick={() => setResendOpen(false)}>Done</Button>
          </div>
        }
      >
        {resend.data !== undefined ? (
          <div className="space-y-4">
            <CopyableLink value={resend.data.inviteUrl} testId="invite-resend-link" />
            <InviteSendActions
              whatsappUrl={resend.data.whatsappUrl}
              phone={resend.data.invite.phone}
              inviteeName={resend.data.invite.name}
              testId="invite-resend-send"
            />
          </div>
        ) : resend.isPending ? (
          <p className="text-muted-foreground text-sm">Issuing a new link...</p>
        ) : resend.error !== null && resend.error !== undefined ? (
          <p role="alert" className="text-destructive text-sm">
            {resend.error instanceof Error ? resend.error.message : 'Could not resend.'}
          </p>
        ) : (
          <p className="text-muted-foreground text-sm">
            Issues a fresh link for {invite.name} and invalidates the current one.
          </p>
        )}
      </Dialog>

      <RevokeInviteDialog invite={invite} open={revokeOpen} onOpenChange={setRevokeOpen} />
    </div>
  );
}

/**
 * Confirm before revoking.
 *
 * Destructive actions always confirm (UX rule), and the dialog states the
 * CONSEQUENCE rather than asking "are you sure" - an admin needs to know the
 * staff member's link stops working instantly.
 */
export function RevokeInviteDialog({
  invite,
  open,
  onOpenChange,
}: {
  invite: InviteRow;
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  const revoke = useRevokeInvite();

  return (
    <Dialog
      open={open}
      onOpenChange={onOpenChange}
      trigger={null}
      header={{ title: `Revoke the invite for ${invite.name}?` }}
      contentClassName="max-h-[calc(100dvh-4rem)] overflow-y-auto sm:max-w-md"
      footer={
        <div className="flex w-full justify-end gap-2">
          <Button variant="outline" onClick={() => onOpenChange(false)}>
            Cancel
          </Button>
          <Button
            variant="destructive"
            isLoading={revoke.isPending}
            loadingText="Revoking..."
            data-qa="invite-revoke-confirm"
            onClick={() =>
              revoke.mutate(invite.id, {
                onSuccess: () => {
                  toast.success(`Invite for ${invite.name} revoked`);
                  onOpenChange(false);
                },
                onError: (error) => {
                  toast.error(error instanceof Error ? error.message : 'Could not revoke');
                },
              })
            }
          >
            Revoke invite
          </Button>
        </div>
      }
    >
      <p className="text-sm">
        Their link stops working immediately. You can send a new invite afterwards.
      </p>
    </Dialog>
  );
}
