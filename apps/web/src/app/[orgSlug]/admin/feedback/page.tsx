'use client';

// /feedback - admin triage for public feedback submissions.
//
// Feedback from the landing page (/feedback, FeedbackForm) now lands in the
// CRM database (POST /api/public/feedback, API-key-gated) instead of
// Supabase. This page is where ADMIN/OWNER read + triage those rows:
//
//   NEW (default):   the untouched inbox. Each row has "Mark reviewed" (→
//                    REVIEWED) and "Archive" (→ ARCHIVED).
//   REVIEWED:        acknowledged. Has "Archive" only.
//   ARCHIVED:        done. Read-only.
//
// Permission gate is on the nav item (canViewAudit - admin-class only in
// lib/session.ts); the page itself does not re-check because a non-admin
// can't reach it. The backend re-checks at the controller + RLS
// (feedback_select_admin / feedback_update_admin) - defense in depth.
//
// Manual refresh for v1 (no SSE channel for feedback yet).

import { useState } from 'react';

import { Button, Card, CardContent, toast } from '@paalstack/react-ui';
import { LuArrowDown, LuStar } from '@paalstack/react-icons/lu';

import { ModulePending } from '@/components/shared/ModulePending';
import { PageHeader } from '@/components/shared/PageHeader';
import { Skeleton } from '@/components/shared/Skeleton';

import {
  useFeedback,
  useUpdateFeedbackStatus,
  type FeedbackRow,
} from '@/hooks/queries/feedback';

import { dateIntl } from '@/lib/format';
import { labelFor } from '@/lib/labels';

// ---------------------------------------------------------------------------
// Tab filter
// ---------------------------------------------------------------------------

type StatusTab = 'NEW' | 'REVIEWED' | 'ARCHIVED';

const STATUS_TABS: ReadonlyArray<{ value: StatusTab; label: string }> = [
  { value: 'NEW', label: 'New' },
  { value: 'REVIEWED', label: 'Reviewed' },
  { value: 'ARCHIVED', label: 'Archived' },
];

// ---------------------------------------------------------------------------
// Page
// ---------------------------------------------------------------------------

export default function FeedbackPage() {
  const [tab, setTab] = useState<StatusTab>('NEW');
  // Cursor pagination: accumulate rows across pages. `nextCursor` is null
  // when there are no more rows. Reset the accumulation on tab change.
  const [cursor, setCursor] = useState<string | null>(null);
  const [accumulated, setAccumulated] = useState<FeedbackRow[]>([]);

  const listQuery = useFeedback({
    status: tab,
    limit: 25,
    ...(cursor !== null ? { cursor } : {}),
  });
  const updateStatus = useUpdateFeedbackStatus();

  const rows =
    cursor === null
      ? (listQuery.data?.rows ?? [])
      : (() => {
          const page = listQuery.data?.rows ?? [];
          const seen = new Set(accumulated.map((r) => r.id));
          return [...accumulated, ...page.filter((r) => !seen.has(r.id))];
        })();
  const total = listQuery.data?.total ?? 0;
  const nextCursor = listQuery.data?.nextCursor ?? null;

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

  function handleStatus(row: FeedbackRow, status: 'REVIEWED' | 'ARCHIVED') {
    updateStatus.mutate(
      { id: row.id, status },
      {
        onSuccess: () => {
          toast.success(
            `Feedback ${labelFor('feedback', status).toLowerCase()}`,
          );
        },
        onError: (error) => {
          const msg =
            error instanceof Error ? error.message : 'Update failed';
          toast.error(msg);
        },
      },
    );
  }

  return (
    <div className="space-y-6">
      <PageHeader
        title="Feedback"
        breadcrumb={[{ label: 'Admin' }, { label: 'Feedback' }]}
        subtitle="Customer feedback submitted from the shadhilbuilders.in feedback form."
        action={
          <Button
            type="button"
            variant="outline"
            disabled={listQuery.isFetching}
            onClick={() => void listQuery.refetch()}
            data-qa="feedback-refresh"
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
            data-qa={`feedback-tab-${item.value.toLowerCase()}`}
          >
            {item.label}
          </Button>
        ))}
        <span
          className="text-muted-foreground ml-2 text-xs"
          data-qa="feedback-total"
        >
          {total} {total === 1 ? 'item' : 'items'}
        </span>
      </div>

      {listQuery.isLoading ? (
        <Skeleton variant="text" />
      ) : listQuery.error !== null && listQuery.error !== undefined ? (
        <ModulePending
          title="Feedback"
          description="Customer feedback submitted from the landing page lands here for triage."
          error={listQuery.error}
        />
      ) : rows.length === 0 ? (
        <EmptyState tab={tab} />
      ) : (
        <ul
          className="border-border divide-border divide-y rounded-lg border"
          data-qa="feedback-list"
        >
          {rows.map((row) => (
            <Row
              key={row.id}
              row={row}
              tab={tab}
              pendingStatusId={updateStatus.isPending ? updateStatus.variables?.id : null}
              onStatus={handleStatus}
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
            data-qa="feedback-load-more"
            isLoading={listQuery.isFetching}
            loadingText="Loading..."
            leftIcon={<LuArrowDown className="size-4" />}
          >
            Load more
          </Button>
        </div>
      ) : null}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Row
// ---------------------------------------------------------------------------

type RowProps = {
  row: FeedbackRow;
  tab: StatusTab;
  pendingStatusId: string | null;
  onStatus: (row: FeedbackRow, status: 'REVIEWED' | 'ARCHIVED') => void;
};

function Row({ row, tab, pendingStatusId, onStatus }: RowProps) {
  const isUpdating = pendingStatusId === row.id;
  const isArchived = row.status === 'ARCHIVED';

  return (
    <li
      className="flex flex-col gap-3 px-4 py-3 sm:flex-row sm:items-start sm:gap-4"
      data-qa="feedback-row"
      data-feedback-id={row.id}
      data-status={row.status}
    >
      <div className="min-w-0 flex-1">
        <div className="flex flex-wrap items-center gap-2">
          <StarRating rating={row.rating} />
          <p className="text-sm font-medium">
            {row.name !== null && row.name.trim().length > 0
              ? row.name
              : '(anonymous)'}
          </p>
          {row.project !== null && row.project.trim().length > 0 ? (
            <span className="text-muted-foreground text-xs">
              · {row.project}
            </span>
          ) : null}
          {row.phone !== null && row.phone.length > 0 ? (
            <span className="text-muted-foreground text-xs">
              · {row.phone}
            </span>
          ) : null}
        </div>

        <p
          className="text-muted-foreground mt-1 line-clamp-3 text-sm"
          data-qa="feedback-message"
        >
          {row.message !== null && row.message.trim().length > 0
            ? row.message
            : '(no message)'}
        </p>

        <p
          className="text-muted-foreground mt-1 text-[10px] tracking-wide uppercase"
          data-qa="feedback-meta"
        >
          {formatDateTime(row.createdAt)}
          {row.page !== null && row.page.length > 0 ? ` · ${row.page}` : ''}
        </p>
      </div>

      {!isArchived ? (
        <div className="flex flex-wrap items-center gap-2 sm:flex-col sm:items-stretch">
          {tab === 'NEW' ? (
            <Button
              type="button"
              variant="default"
              size="sm"
              disabled={isUpdating}
              onClick={() => onStatus(row, 'REVIEWED')}
              data-qa="feedback-review"
            >
              {isUpdating ? 'Saving...' : 'Mark reviewed'}
            </Button>
          ) : null}
          <Button
            type="button"
            variant="outline"
            size="sm"
            disabled={isUpdating}
            onClick={() => onStatus(row, 'ARCHIVED')}
            data-qa="feedback-archive"
          >
            Archive
          </Button>
        </div>
      ) : (
        <span className="text-muted-foreground text-xs" data-qa="feedback-archived">
          Archived
        </span>
      )}
    </li>
  );
}

function StarRating({ rating }: { rating: number }) {
  return (
    <span
      className="inline-flex items-center gap-0.5"
      data-qa="feedback-rating"
      aria-label={`${rating} out of 5`}
    >
      {[1, 2, 3, 4, 5].map((n) => (
        <LuStar
          key={n}
          className={
            `size-3.5 ` +
            (n <= rating
              ? 'fill-warning text-warning'
              : 'text-muted-foreground')
          }
        />
      ))}
    </span>
  );
}

// ---------------------------------------------------------------------------
// Empty state
// ---------------------------------------------------------------------------

function EmptyState({ tab }: { tab: StatusTab }) {
  const message =
    tab === 'NEW'
      ? 'No new feedback.'
      : tab === 'REVIEWED'
        ? 'No reviewed feedback.'
        : 'No archived feedback.';
  const hint =
    tab === 'NEW'
      ? 'New feedback from the landing page appears here automatically.'
      : tab === 'REVIEWED'
        ? 'Reviewed feedback appears here once you acknowledge a new item.'
        : 'Archived feedback appears here after you archive an item.';
  return (
    <Card data-qa="feedback-empty">
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
