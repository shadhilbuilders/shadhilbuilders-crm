'use client';

import { Button, Card, CardContent, CardHeader, CardTitle, TypographyP } from '@paalstack/react-ui';
import { dateIntl } from '@paalstack/react-ui/lib';
import type { LeadActivity } from '@shadhil/api-types';

import { Skeleton } from '@/components/shared/Skeleton';
import { labelFor } from '@/lib/labels';

/** Timeline - the lead's activity feed, rendered in the order given (newest first). */
export function LeadTimeline({
  leadName,
  activities,
  hasMore = false,
  isLoadingMore = false,
  onLoadMore,
  isLoading,
}: {
  leadName: string;
  activities: LeadActivity[] | undefined;
  /** True when older events exist beyond what is loaded. */
  hasMore?: boolean;
  isLoadingMore?: boolean;
  onLoadMore?: () => void;
  isLoading: boolean;
}) {
  if (isLoading) {
    return (
      <div className="space-y-3">
        <div className="border-border text-xs font-semibold tracking-wide uppercase">
          Timeline
        </div>
        <Skeleton variant="list" count={3} />
      </div>
    );
  }

  const hasActivities = Array.isArray(activities) && activities.length > 0;

  return (
    <Card data-qa="lead-timeline">
      <CardHeader>
        <CardTitle className="text-base">Timeline</CardTitle>
      </CardHeader>
      <CardContent>
        {hasActivities ? (
          <ol className="space-y-0">
            {activities!.map((entry) => (
              <li
                key={entry.id}
                className="border-border flex gap-3 border-b py-3 last:border-b-0"
              >
                <div className="bg-muted-foreground/20 mt-1.5 h-2 w-2 shrink-0 rounded-full" />
                <div className="min-w-0 flex-1">
                  <div className="flex flex-wrap items-baseline justify-between gap-x-3">
                    <span className="text-sm font-medium">
                      {labelFor('activity', entry.type)}
                    </span>
                    <span className="text-muted-foreground text-xs">
                      {formatDateTime(entry.createdAt)}
                    </span>
                  </div>
                  <p className="text-muted-foreground mt-0.5 text-sm">{entry.body}</p>
                  {entry.userName !== null ? (
                    <p className="text-muted-foreground mt-0.5 text-xs">
                      by {entry.userName}
                    </p>
                  ) : null}
                </div>
              </li>
            ))}
          </ol>
        ) : (
          <TypographyP className="text-muted-foreground text-sm">
            No activity for {leadName} yet. Timeline entries appear as the lead
            is called, visited, and moved through the pipeline.
          </TypographyP>
        )}
        {hasMore ? (
          <div className="mt-3 flex justify-center">
            <Button
              type="button"
              variant="outline"
              size="sm"
              data-qa="lead-timeline-load-earlier"
              disabled={isLoadingMore || onLoadMore === undefined}
              onClick={onLoadMore}
            >
              {isLoadingMore ? 'Loading...' : 'Load earlier events'}
            </Button>
          </div>
        ) : null}
      </CardContent>
    </Card>
  );
}

function formatDateTime(iso: string): string {
  if (typeof iso !== 'string' || iso.length === 0) return '-';
  const raw = dateIntl.formatDateTime(iso);
  return raw.length === 0 ? '-' : raw;
}
