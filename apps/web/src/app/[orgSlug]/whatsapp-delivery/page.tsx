'use client';

// /[orgSlug]/whatsapp-delivery - ADMIN/OWNER read-only feed of outbound
// WhatsApp message delivery (OutboundMessage table). Each row reflects the
// latest Meta status callback: SENT → DELIVERED → READ, or FAILED with the
// error. Useful for confirming a test message actually delivered and
// watching the webhook status updates land.
//
// Permission: nav item gated to isAdminLike (lib/nav.ts); backend re-checks
// at the service + RLS (outbound_select_admin). Read-only.

import { useState } from 'react';

import {
  Badge,
  Button,
  Card,
  CardContent,
} from '@paalstack/react-ui';
import { LuRefreshCw, LuSend } from '@paalstack/react-icons/lu';

import { ModulePending } from '@/components/shared/ModulePending';
import { PageHeader } from '@/components/shared/PageHeader';
import { Skeleton } from '@/components/shared/Skeleton';

import {
  useWhatsAppDelivery,
  type WhatsAppDeliveryRow,
} from '@/hooks/queries/integrations';

import { dateIntl } from '@/lib/format';

const PAGE_SIZE = 25;

type StatusFilter = 'ALL' | 'PENDING' | 'SENDING' | 'SENT' | 'DELIVERED' | 'READ' | 'FAILED';

const STATUS_FILTERS: ReadonlyArray<{ value: StatusFilter; label: string }> = [
  { value: 'ALL', label: 'All' },
  { value: 'PENDING', label: 'Pending' },
  { value: 'SENDING', label: 'Sending' },
  { value: 'SENT', label: 'Sent' },
  { value: 'DELIVERED', label: 'Delivered' },
  { value: 'READ', label: 'Read' },
  { value: 'FAILED', label: 'Failed' },
];

const STATUS_STYLES: Record<string, string> = {
  PENDING: 'bg-muted text-muted-foreground',
  SENDING: 'bg-muted text-muted-foreground',
  SENT: 'bg-secondary text-secondary-foreground',
  DELIVERED: 'bg-emerald-500/10 text-emerald-600',
  READ: 'bg-emerald-500/15 text-emerald-700',
  FAILED: 'bg-red-500/10 text-red-600',
};

export default function WhatsAppDeliveryPage() {
  const [status, setStatus] = useState<StatusFilter>('ALL');
  const [offset, setOffset] = useState(0);

  const listQuery = useWhatsAppDelivery({
    limit: PAGE_SIZE,
    offset,
    status: status === 'ALL' ? undefined : status,
  });

  const rows = listQuery.data?.rows ?? [];
  const total = listQuery.data?.total ?? 0;
  const isLoading = listQuery.isLoading;
  const error = listQuery.error;

  function switchFilter(next: StatusFilter) {
    setStatus(next);
    setOffset(0);
  }

  return (
    <div className="space-y-6">
      <PageHeader
        title="WhatsApp delivery"
        breadcrumb={[{ label: 'Admin' }, { label: 'WA Delivery' }]}
        subtitle="Outbound WhatsApp message delivery status, updated by the Meta status webhook."
        action={
          <Button
            type="button"
            variant="outline"
            disabled={listQuery.isFetching}
            onClick={() => void listQuery.refetch()}
            data-qa="wa-delivery-refresh"
          >
            <LuRefreshCw className="size-4" />
            Refresh
          </Button>
        }
      />

      <div className="flex flex-wrap items-center gap-1.5">
        {STATUS_FILTERS.map((item) => (
          <Button
            key={item.value}
            type="button"
            variant={status === item.value ? 'default' : 'outline'}
            size="sm"
            onClick={() => switchFilter(item.value)}
            aria-pressed={status === item.value}
            data-qa={`wa-delivery-filter-${item.value.toLowerCase()}`}
          >
            {item.label}
          </Button>
        ))}
        <span
          className="text-muted-foreground ml-2 text-xs"
          data-qa="wa-delivery-total"
        >
          {total} {total === 1 ? 'message' : 'messages'}
        </span>
      </div>

      {isLoading ? (
        <Skeleton variant="text" />
      ) : error !== null && error !== undefined ? (
        <ModulePending
          title="WhatsApp delivery"
          description="Outbound WhatsApp delivery status appears here via the Meta status webhook."
          error={error}
        />
      ) : rows.length === 0 ? (
        <Card data-qa="wa-delivery-empty">
          <CardContent className="space-y-1 p-10 text-center">
            <LuSend className="text-muted-foreground mx-auto size-8" />
            <p className="text-base font-medium">
              No WhatsApp delivery records.
            </p>
            <p className="text-muted-foreground text-sm">
              Outbound messages to leads (via the chat outbox) appear here as
              they're sent and their Meta status callbacks land.
            </p>
          </CardContent>
        </Card>
      ) : (
        <>
          <ul
            className="border-border divide-border divide-y rounded-lg border"
            data-qa="wa-delivery-list"
          >
            {rows.map((row) => (
              <WhatsAppDeliveryListItem key={row.id} row={row} />
            ))}
          </ul>
          <div className="flex items-center justify-between pt-1">
            <Button
              type="button"
              variant="outline"
              size="sm"
              disabled={offset === 0 || listQuery.isFetching}
              onClick={() => setOffset((o) => Math.max(0, o - PAGE_SIZE))}
              data-qa="wa-delivery-prev"
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
              data-qa="wa-delivery-next"
            >
              Next
            </Button>
          </div>
        </>
      )}
    </div>
  );
}

function WhatsAppDeliveryListItem({ row }: { row: WhatsAppDeliveryRow }) {
  return (
    <li className="px-4 py-3" data-qa="wa-delivery-row" data-row-id={row.id}>
      <div className="flex flex-wrap items-center gap-2">
        <span className="text-sm font-medium">{row.leadName || row.leadId}</span>
        <Badge
          className={STATUS_STYLES[row.status] ?? 'bg-muted text-muted-foreground'}
        >
          {row.status}
        </Badge>
        <span className="text-muted-foreground text-xs">
          {row.sendType}
          {row.templateName !== null ? ` · ${row.templateName}` : ''}
        </span>
      </div>
      <div className="text-muted-foreground mt-1 flex flex-wrap items-center gap-x-3 gap-y-1 text-xs">
        <span>attempts: {row.attempts}</span>
        {row.wamid !== null ? (
          <span>
            wamid: <code className="break-all">{row.wamid}</code>
          </span>
        ) : null}
        <span>created: {formatDate(row.createdAt)}</span>
        {row.status === 'FAILED' ? (
          <span className="text-red-600">· {row.lastError ?? 'failed'}</span>
        ) : null}
      </div>
    </li>
  );
}

function formatDate(iso: string): string {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return iso;
  return dateIntl.formatDateTime(iso);
}
