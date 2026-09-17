'use client';

// LeadQueueRow - one actionable row in the dashboard work queue
// (T-DASH-QUEUE, 2026-09-16).
//
// THE POINT OF THIS COMPONENT: the primary next action is a real, labelled
// button on the COLLAPSED row. Nothing a telecaller needs on a given pass is
// hidden behind a click. That is a deliberate response to the research finding
// that hiding interaction cuts discoverability roughly in half and raises
// perceived difficulty - and this population is working in a CRM for the first
// time. Only the RARE, negative actions (Lost, Cold) live in the expansion.
//
// Reveal, not navigation: clicking the row body expands the rest of that lead's
// workspace IN PLACE. The row never becomes a navigation event, and the primary
// action never moves into a dialog. Scheduling is the one exception - a
// date-time + assignee form genuinely needs a dialog, and an inline form inside
// a queue row is worse for a novice.
//
// Role-gating is done here rather than server-side-fingers-crossed: the action
// table below is the telecaller lane, and `canScheduleVisits` /
// `canLogVisitOutcome` guard the two actions that have role gates. The server
// remains the authority (it still 403s a bad call) but the UI must not OFFER
// what the API will refuse.

import { Button } from '@paalstack/react-ui';
import { useState } from 'react';
import type { ReactNode } from 'react';

import { LEAD_AGE_TIER_CLASS } from '@/lib/leads';
import { labelFor } from '@/lib/labels';
import { queueReason, slaTier } from '@/lib/work-queue';

export type QueueLead = {
  id: string;
  name: string;
  phone?: string;
  status?: string;
  createdAt?: string;
  ownerName?: string;
};

/** The single primary action offered on a collapsed row, per state. */
export type QueueAction = {
  label: string;
  onClick: () => void;
  dataQa: string;
  /** Secondary is rendered as an outline button beside the primary. */
  variant?: 'default' | 'outline' | 'ghost';
  busy?: boolean;
} | null;

/**
 * How many actions render on the collapsed row before "More" appears. Two,
 * because the busiest state (NEW) genuinely has two equally common outcomes
 * ("Called" / "Wants a visit") and both must be one tap away.
 */
const ALWAYS_VISIBLE_ACTIONS = 2;

export type LeadQueueRowProps = {
  lead: QueueLead;
  /**
   * 1-based position in the visible queue. Rendered as a plain number so
   * "work top-down" is literal rather than implied - for someone using a CRM
   * for the first time, "start at 1, then 2" needs no teaching, and it also
   * makes the list's urgency order visible without reading a single status.
   */
  position?: number;
  /** Phone rendered as a tel: link (opens the dialer). */
  phone?: ReactNode;
  /** Primary + optional secondary action for this row's state. */
  actions: QueueAction[];
  /** Expanded content: the rest of the workspace for this lead. */
  expanded?: ReactNode;
  /** True while this row is the expanded one. */
  isExpanded: boolean;
  onToggle: () => void;
};

/**
 * The identifying column goes first (name + phone), per the standing preference
 * that a row leads with what identifies it. For a lead at NEW there is no unit
 * yet - the unit number is a booking's identifier - so name + phone is the
 * correct leading pair here.
 */
export function LeadQueueRow({
  lead,
  position,
  phone,
  actions,
  expanded,
  isExpanded,
  onToggle,
}: LeadQueueRowProps) {
  const [showAllActions, setShowAllActions] = useState(false);
  const status = typeof lead.status === 'string' ? lead.status : '';
  const tier = slaTier(lead);
  const reason = queueReason(lead);

  // The age tint is re-used verbatim from the leads inbox so a lead can never
  // look "amber" in one surface and "red" in another.
  const tint = tier === null ? '' : LEAD_AGE_TIER_CLASS[tier];

  // CONTRAST (T-DASH-CONTRAST, verified in a real browser): `text-muted-foreground`
  // measures 3.27:1 on the overdue tint (#ffc9c9) and `text-destructive` 3.21:1,
  // both under the 4.5:1 AA floor for 12px text. A muted token is only accessible
  // against the plain card, not against a tint. So on a tinted row the secondary
  // text steps up to the primary foreground; untinted rows keep the muted
  // hierarchy. Note jsdom cannot catch this - axe's color-contrast rule is a
  // silent no-op there - so this was found by the real-browser audit.
  const secondary = tier === null ? 'text-muted-foreground' : 'text-foreground';

  // The overdue reason stays visually emphasised via weight, not via the
  // destructive colour, which is unreadable on the red tint. Urgency is still
  // carried three ways: the tint, the word "Overdue", and the bold weight - so
  // colour is never the sole signal.
  const reasonClass = tier === 'overdue' ? 'text-foreground font-semibold' : secondary;

  return (
    <li
      // The expanded row must survive a list refetch. Every mutation
      // invalidates ['leads'], so with an urgency sort the row can move while
      // it is open - `data-expanded` plus a stable key is what lets the page
      // pin it. See the page's sticky-expansion handling.
      data-expanded={isExpanded ? 'true' : undefined}
      data-qa="queue-row"
      className={`border-border bg-card rounded-lg border ${tint}`}
    >
      <div className="flex flex-col gap-3 p-3 sm:flex-row sm:items-center sm:justify-between">
        {/* Identifying column first, then status + reason. */}
        <div className="flex min-w-0 flex-1 items-baseline gap-2">
          {typeof position === 'number' ? (
            <span className={`w-5 shrink-0 text-xs tabular-nums ${secondary}`} aria-hidden="true">
              {position}.
            </span>
          ) : null}
          <div className="flex min-w-0 flex-1 flex-col gap-0.5">
            <div className="flex min-w-0 flex-wrap items-baseline gap-x-2 gap-y-0.5">
              <span
                // Long names must not break the row; the full value stays
                // available on hover and to screen readers.
                className="max-w-64 truncate text-sm font-semibold"
                title={lead.name}
              >
                {lead.name}
              </span>
              <span className={`text-xs ${secondary}`}>{labelFor('lead', status)}</span>
            </div>
            <div className="flex flex-wrap items-center gap-x-3 gap-y-0.5 text-xs">
              {phone}
              {reason.length > 0 ? <span className={reasonClass}>{reason}</span> : null}
            </div>
          </div>
        </div>

        {/*
 Actions. The primary is always visible; a second action only appears
 on request so the row stays calm on a phone. The expansion toggle is
 separated from the action buttons so a mis-tap on "Called" never
 opens the row.
 */}
        <div className="flex shrink-0 flex-wrap items-center gap-2">
          {actions
            .filter((a): a is NonNullable<QueueAction> => a !== null)
            .map((action, index) => {
              // BOTH of the telecaller's common outcomes stay visible. An
              // earlier version showed only the first and put the rest behind
              // "More" - which hid "Wants a visit", one of the two answers a
              // telecaller gives most often. Hiding a frequent action behind a
              // click is exactly the anti-pattern this page exists to avoid, so
              // the threshold is 2 and "More" only appears beyond that.
              const visible = index < ALWAYS_VISIBLE_ACTIONS || showAllActions;
              if (!visible) return null;
              return (
                <Button
                  key={action.dataQa}
                  type="button"
                  size="sm"
                  variant={action.variant ?? (index === 0 ? 'default' : 'outline')}
                  disabled={action.busy === true}
                  onClick={action.onClick}
                  data-qa={action.dataQa}
                >
                  {action.busy === true ? 'Saving...' : action.label}
                </Button>
              );
            })}

          {actions.length > ALWAYS_VISIBLE_ACTIONS ? (
            <Button
              type="button"
              variant="ghost"
              size="sm"
              aria-expanded={showAllActions}
              onClick={() => setShowAllActions((v) => !v)}
              data-qa="queue-more-actions"
            >
              {showAllActions ? 'Less' : 'More'}
            </Button>
          ) : null}

          <Button
            type="button"
            variant="outline"
            size="sm"
            aria-expanded={isExpanded}
            onClick={onToggle}
            data-qa="queue-row-toggle"
          >
            {isExpanded ? 'Close' : 'Open'}
          </Button>
        </div>
      </div>

      {isExpanded && expanded !== undefined ? (
        <div className="border-border border-t p-3" data-qa="queue-row-expanded">
          {expanded}
        </div>
      ) : null}
    </li>
  );
}
