'use client';

// /whatsapp-chat - the WhatsApp chat system (T-WA-INBOX, 2026-09-25).
//
// A WhatsApp-Web-style two-pane inbox:
//
//   ┌──────────────────┬──────────────────────────────────────┐
//   │ conversation list│ chat panel for the SELECTED thread    │
//   │ (leads + unknown │ (bubbles, 24h window state, composer, │
//   │  numbers, unread)│  convert-to-lead on unknown numbers)  │
//   └──────────────────┴──────────────────────────────────────┘
//
// Selecting a row in the left pane drives the right pane; nothing is loaded
// until a thread is chosen.
//
// ACCESS: managers, admins and owners only. Enforced three times over -
//   1. the nav item is hidden (`canUseWhatsappInbox` in lib/nav.ts),
//   2. this page re-checks and renders "Not authorized" (a direct URL is the
//      obvious way round a hidden nav item),
//   3. the backend controller 403s and the RLS policies scope the data.
// A user without access therefore cannot reach the data by any route.

import { Button, Heading, TypographyP, toast } from '@paalstack/react-ui';
import { LuArrowLeft, LuMessagesSquare } from '@paalstack/react-icons/lu';
import { useEffect, useState } from 'react';

import { PageHeader } from '@/components/shared/PageHeader';
import { Skeleton } from '@/components/shared/Skeleton';
import { WhatsappUnknownContactConvertModal } from '@/components/whatsapp-unknown-contact-convert-modal';
import { ChatConversationList } from '@/components/whatsapp/ChatConversationList';
import {
  ChatThreadPanel,
  type ChatThreadSelection,
} from '@/components/whatsapp/ChatThreadPanel';
import {
  useWaUnknownContacts,
  type WhatsappUnknownContactRow,
} from '@/hooks/queries/whatsapp-unknown-contacts';
import { useSessionUser } from '@/lib/session';
import { canUseWhatsappInbox } from '@/lib/session';
import { useOrgSlug } from '@/lib/tenant-context';

export default function WhatsappChatPage() {
  const { user, isPending: sessionPending } = useSessionUser();
  const orgSlug = useOrgSlug();
  const [mounted, setMounted] = useState(false);
  const [selected, setSelected] = useState<ChatThreadSelection | null>(null);
  // The convert modal takes the full contact ROW (it renders the phone and
  // drives the API call), so this page holds the selected row. The row comes
  // from the same PENDING queue the admin triage page uses - converting is
  // that flow, reused rather than reimplemented.
  const [converting, setConverting] = useState<WhatsappUnknownContactRow | null>(null);
  const pendingContacts = useWaUnknownContacts({ status: 'PENDING', limit: 100 });

  useEffect(() => {
    setMounted(true);
  }, []);

  if (!mounted || sessionPending) {
    return (
      <div className="mt-3 flex h-[calc(100vh-12rem)] min-h-96 gap-4">
        <div className="hidden w-80 md:block lg:w-96">
          <Skeleton variant="list" count={1} />
        </div>
        <div className="flex-1">
          <Skeleton variant="card" />
        </div>
      </div>
    );
  }

  // The org slug is required to build lead links; without it the panels
  // cannot render anything useful, so wait for it (same as other pages that
  // read useOrgSlug()).
  if (user === null || !canUseWhatsappInbox(user.role) || orgSlug === null) {
    return (
      <div className="py-24 text-center text-sm">
        <Heading className="mb-2">Not authorized</Heading>
        <TypographyP className="text-muted-foreground">
          The WhatsApp chat system is available to managers, admins and owners.
          To message a customer you own, open the lead and use its chat panel.
        </TypographyP>
      </div>
    );
  }

  return (
    <>
      <PageHeader
        title="WhatsApp Chats"
        subtitle="Every WhatsApp conversation - known customers and numbers not yet linked to a lead"
      />

      {/* Two panes. The list is hidden on small screens once a thread is
          open, so a phone shows one pane at a time (as WhatsApp Web does). */}
      <div
        className="border-border mt-3 flex h-[calc(100vh-12rem)] min-h-96 overflow-hidden rounded-lg border"
        data-qa="whatsapp-chat-page"
      >
        <div
          className={`${selected !== null ? 'hidden md:flex' : 'flex'} h-full w-full md:w-80 md:shrink-0 lg:w-96`}
        >
          <ChatConversationList
            selectedKey={selected === null ? null : `${selected.kind}:${selected.id}`}
            onSelect={setSelected}
            orgSlug={orgSlug}
          />
        </div>

        <div
          className={`${selected !== null ? 'flex' : 'hidden md:flex'} h-full min-w-0 flex-1 border-border md:border-l`}
        >
          {selected === null ? (
            // Empty state, mirroring WhatsApp Web's "select a chat" panel.
            <div className="bg-muted/20 flex h-full w-full flex-col items-center justify-center gap-3 p-8 text-center">
              <LuMessagesSquare className="text-muted-foreground size-12" />
              <Heading as="h2" className="text-base">
                Select a conversation
              </Heading>
              <TypographyP className="text-muted-foreground max-w-sm text-xs">
                Pick a chat on the left to read the history and reply. Replies go
                out on WhatsApp to the customer.
              </TypographyP>
            </div>
          ) : (
            <div className="flex h-full min-w-0 flex-1 flex-col">
              {/* Back link for the small-screen single-pane view. */}
              <div className="border-border flex items-center justify-between border-b px-3 py-2 md:hidden">
                <Button variant="ghost" size="sm" leftIcon={<LuArrowLeft className="size-4" />} onClick={() => setSelected(null)}>
                  All chats
                </Button>
              </div>
              <div className="min-h-0 flex-1">
                <ChatThreadPanel
                  key={`${selected.kind}:${selected.id}`}
                  thread={selected}
                  onConvert={(t) => {
                    const row = (pendingContacts.data?.rows ?? []).find(
                      (c) => c.id === t.id,
                    );
                    if (row === undefined) {
                      toast.error(
                        'This number is already being processed - open it from Admin → WhatsApp → WA Unknown.',
                      );
                      return;
                    }
                    setConverting(row);
                  }}
                />
              </div>
            </div>
          )}
        </div>
      </div>

      {/* Convert-to-lead, reusing the EXISTING triage flow rather than
          reimplementing lead creation for a number. */}
      <WhatsappUnknownContactConvertModal
        contact={converting}
        open={converting !== null}
        orgId={orgSlug}
        onOpenChange={(next) => {
          if (!next) setConverting(null);
        }}
      />
    </>
  );
}
