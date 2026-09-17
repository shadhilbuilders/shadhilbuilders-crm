'use client';

// /whatsapp-unknown-contacts - T-E2b admin queue page.
//
// Inbound WhatsApp messages from numbers that don't match any known
// Lead are persisted to `WhatsappUnknownContact` (status=PENDING) by
// the inbound webhook (T-E2b inbound commit). This page is where
// ADMIN/OWNER/MANAGER triage those rows:
//
//   - PENDING (default): the active queue. Each row has
//       "Convert" → opens modal → POST /api/whatsapp-unknown-contacts/:id/convert
//                    (creates a Lead + links the contact atomically)
//       "Mark as Spam"  → POST /api/whatsapp-unknown-contacts/:id/spam
//   - CONVERTED:        history of contacts that became Leads.
//                       No actions - see the linked Lead via the Lead Inbox.
//   - SPAM:             history of contacts triaged out (wrong number /
//                       bot / not interested). No actions.
//
// Permission gate is on the nav item (`canConvertWhatsappUnknownContact`
// in lib/session.ts); the page itself does not re-check because a
// user without permission can't reach it. The backend re-checks at
// the controller via the new admin-class RLS policies - defense in depth.
//
// Manual refresh for v1 (no SSE channel for the queue yet - the
// admin-facing flow is low-volume and PUSH from the inbound webhook
// is an obvious next step but out of scope for this ticket).

import { useMemo, useState } from 'react';

import { Button, Card, CardContent, toast } from '@paalstack/react-ui';
import Link from 'next/link';

import { ModulePending } from '@/components/shared/ModulePending';
import { PhoneNumber } from '@/components/shared/PhoneNumber';
import { Skeleton } from '@/components/shared/Skeleton';
import {
  WhatsappUnknownContactConvertModal,
} from '@/components/whatsapp-unknown-contact-convert-modal';

import { PageHeader } from '@/components/shared/PageHeader';

import {
  useMarkWaUnknownSpam,
  useWaUnknownContacts,
} from '@/hooks/queries/whatsapp-unknown-contacts';

import type { WhatsappUnknownContactRow } from '@/hooks/queries/whatsapp-unknown-contacts';
import { pickDefaultProject, useProjects } from '@/hooks/queries';
import { dateIntl } from '@/lib/format';
import { projectHref } from '@/lib/nav';
import { useOrgSlug } from '@/lib/tenant-context';
import { LuArrowDown } from '@paalstack/react-icons/lu';

// ---------------------------------------------------------------------------
// Tab filter
// ---------------------------------------------------------------------------

type StatusTab = 'PENDING' | 'CONVERTED' | 'SPAM';

const STATUS_TABS: ReadonlyArray<{ value: StatusTab; label: string }> = [
  { value: 'PENDING', label: 'Pending' },
  { value: 'CONVERTED', label: 'Converted' },
  { value: 'SPAM', label: 'Spam' },
];

// ---------------------------------------------------------------------------
// Page
// ---------------------------------------------------------------------------

export default function WhatsappUnknownContactsPage() {
  const orgSlug = useOrgSlug();
  const [tab, setTab] = useState<StatusTab>('PENDING');
  const [convertTarget, setConvertTarget] =
    useState<WhatsappUnknownContactRow | null>(null);
  // Cursor pagination: accumulate rows across pages. `nextCursor` is null
  // when there are no more rows. Reset the accumulation whenever the tab
  // changes (each tab is its own queue).
  const [cursor, setCursor] = useState<string | null>(null);
  const [accumulated, setAccumulated] = useState<WhatsappUnknownContactRow[]>(
    [],
  );

  const listQuery = useWaUnknownContacts({
    status: tab,
    limit: 25,
    ...(cursor !== null ? { cursor } : {}),
  });
  const markSpam = useMarkWaUnknownSpam();
  const { data: projects } = useProjects();
  const defaultProjectSlug = pickDefaultProject(projects ?? [])?.slug ?? null;

  // Merge the latest fetched page into the accumulated list. When the tab
  // changes (or the cursor resets), start fresh from the first page.
  const rows = useMemo(() => {
    const page = listQuery.data?.rows ?? [];
    if (cursor === null) return page;
    const seen = new Set(accumulated.map((r) => r.id));
    return [...accumulated, ...page.filter((r) => !seen.has(r.id))];
  }, [listQuery.data, cursor, accumulated]);
  const total = listQuery.data?.total ?? 0;
  const nextCursor = listQuery.data?.nextCursor ?? null;
  const isPendingTab = tab === 'PENDING';

  function switchTab(next: StatusTab) {
    setTab(next);
    setCursor(null);
    setAccumulated([]);
  }

  function loadMore() {
    if (nextCursor !== null) {
      setAccumulated(rows);
      setCursor(nextCursor);
    }
  }

  function handleSpam(row: WhatsappUnknownContactRow) {
    markSpam.mutate(
      { id: row.id },
      {
        onSuccess: () => {
          toast.success(`${row.phoneE164} marked as spam`);
        },
        onError: (error) => {
          const msg =
            error instanceof Error ? error.message : 'Mark as spam failed';
          toast.error(msg);
        },
      },
    );
  }

  return (
    <div className="space-y-6">
      <PageHeader
        title="WhatsApp Unknown Contacts"
        breadcrumb={[{ label: 'Admin' }, { label: 'WA Unknown' }]}
        subtitle="Triage inbound WhatsApp messages from numbers that don't match a known Lead."
        action={
          <Button
            type="button"
            variant="outline"
            disabled={listQuery.isFetching}
            onClick={() => void listQuery.refetch()}
            data-qa="wa-unknown-refresh"
          >
            Refresh
          </Button>
        }
      />

      <div className="flex flex-wrap items-center gap-1.5">
        {STATUS_TABS.map((item) => (
          <Button
            key={item.value}
            variant={tab === item.value ? 'default' : 'outline'}
            onClick={() => switchTab(item.value)}
            aria-pressed={tab === item.value}
            data-qa={`wa-unknown-tab-${item.value.toLowerCase()}`}
          >
            {item.label}
          </Button>
        ))}
        <span
          className="text-muted-foreground ml-2 text-xs"
          data-qa="wa-unknown-total"
        >
          {total} {total === 1 ? 'contact' : 'contacts'}
        </span>
      </div>

      {listQuery.isLoading ? (
        <Skeleton variant="text" />
      ) : listQuery.error !== null && listQuery.error !== undefined ? (
        <ModulePending
          title="WhatsApp Unknown Contacts"
          description="Inbound WhatsApp messages from numbers without a matching Lead land here. Triage to Convert (becomes a Lead) or Spam."
          error={listQuery.error}
        />
      ) : rows.length === 0 ? (
        <EmptyState tab={tab} />
      ) : (
        <ul
          className="border-border divide-border divide-y rounded-lg border"
          data-qa="wa-unknown-list"
        >
          {rows.map((row) => (
            <Row
              key={row.id}
              row={row}
              orgSlug={orgSlug}
              showActions={isPendingTab}
              pendingSpamId={
                markSpam.isPending && markSpam.variables?.id === row.id
                  ? row.id
                  : null
              }
              onConvert={setConvertTarget}
              onSpam={handleSpam}
              projectSlug={defaultProjectSlug}
            />
          ))}
        </ul>
      )}

      {nextCursor !== null ? (
        <div className="flex justify-center pt-1">
          <Button
            type="button"
            variant="outline"
            size="sm"
            disabled={listQuery.isFetching}
            onClick={loadMore}
            data-qa="wa-unknown-load-more"
            isLoading={listQuery.isFetching}
            loadingText='Loading...'
            leftIcon={<LuArrowDown className="size-4" />}
          >
            Load more
          </Button>
        </div>
      ) : null}

      <WhatsappUnknownContactConvertModal
        contact={convertTarget}
        open={convertTarget !== null}
        orgId={orgSlug ?? ''}
        onOpenChange={(next) => {
          if (!next) setConvertTarget(null);
        }}
      />
    </div>
  );
}

// ---------------------------------------------------------------------------
// Row
// ---------------------------------------------------------------------------

type RowProps = {
  row: WhatsappUnknownContactRow;
  orgSlug: string | null;
  showActions: boolean;
  pendingSpamId: string | null;
  onConvert: (row: WhatsappUnknownContactRow) => void;
  onSpam: (row: WhatsappUnknownContactRow) => void;
  projectSlug: string | null;
};

function Row({
  row,
  orgSlug,
  showActions,
  pendingSpamId,
  onConvert,
  onSpam,
  projectSlug,
}: RowProps) {
  const isSpamming = pendingSpamId === row.id;
  return (
    <li
      className="flex flex-col gap-3 px-4 py-3 sm:flex-row sm:items-start sm:gap-4"
      data-qa="wa-unknown-row"
      data-contact-id={row.id}
      data-status={row.status}
    >
      <div className="min-w-0 flex-1">
        <p
          data-qa="wa-unknown-phone"
        >
          <PhoneNumber phone={row.phoneE164} variant="text" className="font-mono text-sm font-medium" />
        </p>
        <p
          className="text-muted-foreground mt-1 line-clamp-2 text-sm"
          data-qa="wa-unknown-first-message"
        >
          {row.firstMessageBody !== null && row.firstMessageBody.length > 0
            ? row.firstMessageBody
            : '(no message body)'}
        </p>
        <p
          className="text-muted-foreground mt-1 text-[10px] tracking-wide uppercase"
          data-qa="wa-unknown-meta"
        >
          {formatDateTime(row.firstMessageAt)}
          {' · '}
          {row.messageCount} {row.messageCount === 1 ? 'message' : 'messages'}
          {' · '}
          last {formatDateTime(row.lastMessageAt)}
          {row.status === 'CONVERTED' && row.convertedToLeadId !== null ? (
            <>
              {' · '}
              <Link
                href={projectHref(orgSlug, projectSlug, `/leads/${row.convertedToLeadId}`)}
                className="underline-offset-2 hover:underline"
                data-qa="wa-unknown-converted-lead"
              >
                View Lead
              </Link>
            </>
          ) : null}
        </p>
      </div>

      {showActions ? (
        <div className="flex flex-wrap items-center gap-2 sm:flex-col sm:items-stretch">
          <Button
            type="button"
            variant="default"
            onClick={() => onConvert(row)}
            data-qa="wa-unknown-convert"
          >
            Convert
          </Button>
          <Button
            type="button"
            variant="outline"
            disabled={isSpamming}
            onClick={() => onSpam(row)}
            data-qa="wa-unknown-spam"
          >
            {isSpamming ? 'Marking...' : 'Mark as Spam'}
          </Button>
        </div>
      ) : null}
    </li>
  );
}

// ---------------------------------------------------------------------------
// Empty state
// ---------------------------------------------------------------------------

function EmptyState({ tab }: { tab: StatusTab }) {
  const message =
    tab === 'PENDING'
      ? 'No pending contacts.'
      : tab === 'CONVERTED'
        ? 'No converted contacts yet.'
        : 'No spam-marked contacts.';
  const hint =
    tab === 'PENDING'
      ? 'New inbound WhatsApp messages from unknown numbers land here automatically.'
      : tab === 'CONVERTED'
        ? 'Converted contacts appear here once an admin triages a pending contact.'
        : 'Contacts triaged as spam appear here.';
  return (
    <Card data-qa="wa-unknown-empty">
      <CardContent className="space-y-1 p-10 text-center">
        <p className="text-base font-medium">{message}</p>
        <p className="text-muted-foreground text-sm">{hint}</p>
      </CardContent>
    </Card>
  );
}

// ---------------------------------------------------------------------------
// Date formatting
// ---------------------------------------------------------------------------

function formatDateTime(iso: string): string {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return iso;
  return dateIntl.formatDateTime(iso);
}