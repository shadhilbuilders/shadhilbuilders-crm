'use client';

// /[orgSlug]/webhooks - ADMIN/OWNER read-only log of raw inbound webhook
// events (WebhookEvent table). Confirms Meta payloads actually reached the
// API and how each was processed (deduped / Message created /
// unknown-contact upserted / status update / ignored).
//
// Permission: nav item is gated to isAdminLike (lib/nav.ts); the backend
// re-checks at the service + RLS (webhook_select_admin). Read-only - no
// actions on this page.

import { useState } from 'react';

import { Button, Card, CardContent } from '@paalstack/react-ui';
import { LuRefreshCw, LuSatellite } from '@paalstack/react-icons/lu';

import { ModulePending } from '@/components/shared/ModulePending';
import { PageHeader } from '@/components/shared/PageHeader';
import { Skeleton } from '@/components/shared/Skeleton';

import { useWebhookEvents, type WebhookEventRow } from '@/hooks/queries/integrations';

import { dateIntl } from '@/lib/format';

const PAGE_SIZE = 25;

export default function WebhookEventsPage() {
  const [offset, setOffset] = useState(0);
  const listQuery = useWebhookEvents({ limit: PAGE_SIZE, offset });

  const rows = listQuery.data?.rows ?? [];
  const total = listQuery.data?.total ?? 0;
  const isLoading = listQuery.isLoading;
  const error = listQuery.error;

  return (
    <div className="space-y-6">
      <PageHeader
        title="Webhook events"
        breadcrumb={[{ label: 'Admin' }, { label: 'Webhooks' }]}
        subtitle="Raw inbound webhook events received by the API (WhatsApp / FreJun)."
        action={
          <Button
            type="button"
            variant="outline"
            disabled={listQuery.isFetching}
            onClick={() => void listQuery.refetch()}
            data-qa="webhooks-refresh"
          >
            <LuRefreshCw className="size-4" />
            Refresh
          </Button>
        }
      />

      {isLoading ? (
        <Skeleton variant="text" />
      ) : error !== null && error !== undefined ? (
        <ModulePending
          title="Webhook events"
          description="Raw inbound webhook events land here for ops diagnosis."
          error={error}
        />
      ) : rows.length === 0 ? (
        <Card data-qa="webhooks-empty">
          <CardContent className="space-y-1 p-10 text-center">
            <LuSatellite className="text-muted-foreground mx-auto size-8" />
            <p className="text-base font-medium">No webhook events yet.</p>
            <p className="text-muted-foreground text-sm">
              Meta delivers events to /api/webhooks/whatsapp; they appear here
              as they arrive.
            </p>
          </CardContent>
        </Card>
      ) : (
        <>
          <span
            className="text-muted-foreground block text-xs"
            data-qa="webhooks-total"
          >
            {total} {total === 1 ? 'event' : 'events'}
          </span>
          <ul
            className="border-border divide-border divide-y rounded-lg border"
            data-qa="webhooks-list"
          >
            {rows.map((row) => (
              <WebhookEventListItem key={row.id} row={row} />
            ))}
          </ul>
          <div className="flex items-center justify-between pt-1">
            <Button
              type="button"
              variant="outline"
              size="sm"
              disabled={offset === 0 || listQuery.isFetching}
              onClick={() => setOffset((o) => Math.max(0, o - PAGE_SIZE))}
              data-qa="webhooks-prev"
            >
              Previous
            </Button>
            <span className="text-muted-foreground text-xs">
              {offset + 1}–{Math.min(offset + PAGE_SIZE, total)} of {total}
            </span>
            <Button
              type="button"
              variant="outline"
              size="sm"
              disabled={offset + PAGE_SIZE >= total || listQuery.isFetching}
              onClick={() => setOffset((o) => o + PAGE_SIZE)}
              data-qa="webhooks-next"
            >
              Next
            </Button>
          </div>
        </>
      )}
    </div>
  );
}

function WebhookEventListItem({ row }: { row: WebhookEventRow }) {
  return (
    <li className="px-4 py-3" data-qa="webhooks-row" data-event-id={row.id}>
      <div className="flex flex-wrap items-center gap-2">
        <span className="bg-secondary text-secondary-foreground inline-flex items-center rounded-full px-2 py-0.5 text-xs font-medium">
          {row.source}
        </span>
        <span
          className={
            row.processed
              ? 'inline-flex items-center rounded-full bg-emerald-500/10 px-2 py-0.5 text-xs font-medium text-emerald-600'
              : 'inline-flex items-center rounded-full bg-amber-500/10 px-2 py-0.5 text-xs font-medium text-amber-600'
          }
        >
          {row.processed ? 'processed' : 'unprocessed'}
        </span>
        {row.error !== null ? (
          <span className="inline-flex items-center rounded-full bg-red-500/10 px-2 py-0.5 text-xs font-medium text-red-600">
            error
          </span>
        ) : null}
      </div>
      <p className="text-muted-foreground mt-1 text-xs">
        external id: <code className="break-all">{row.externalId}</code>
      </p>
      <div className="mt-1 flex flex-wrap items-center gap-x-3 gap-y-1">
        <span className="text-muted-foreground text-[10px] tracking-wide uppercase">
          {formatDate(row.createdAt)}
        </span>
        {row.error !== null ? (
          <span className="text-muted-foreground text-xs">· {row.error}</span>
        ) : null}
      </div>
      <pre className="bg-muted/50 text-muted-foreground mt-2 max-h-40 overflow-auto rounded-md p-2 text-[11px] leading-relaxed">
        {JSON.stringify(row.payload, null, 2)}
      </pre>
    </li>
  );
}

function formatDate(iso: string): string {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return iso;
  return dateIntl.formatDateTime(iso);
}
