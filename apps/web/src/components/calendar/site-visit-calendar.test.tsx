// SiteVisitCalendar - default view (T-VISITS-AGENDA-DEFAULT, 2026-09-16).
//
// The owner asked for Agenda to be the default on /visits. It was `'week'`, a
// single hard-coded literal in `site-visit-calendar.tsx` with no test on it -
// exactly the kind of one-word default that drifts back during an unrelated
// refactor, silently, because nothing asserts it.
//
// WHY IT MATTERS (not cosmetic): the page answers "what visits do I have coming
// up?". The week grid can only show visits inside the visible 7-day window the
// page fetched, so a visit scheduled next month is invisible on load and reads as
// "no visits". The agenda lists upcoming visits across the range.
//
// These render the REAL component tree and assert which view the calendar
// actually mounts, rather than grepping for the literal - a grep would pass even
// if the state were initialised but then overwritten.

import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';

// The calendar pulls visits + reschedule through these hooks. Stubbed so the
// default view is observable without a network layer; the suite is about which
// VIEW mounts, not about data.
vi.mock('@/hooks/queries/crm', () => ({
  useVisitsInRange: vi.fn(() => ({ data: [], isLoading: false, error: null })),
  useRescheduleVisit: vi.fn(() => ({ mutate: vi.fn(), isPending: false })),
  // T-LEAD-SYNC-COVERAGE (2026-09-30): the calendar reports a skipped lead sync
  // after a drag-reschedule, so it imports this too. A partial mock must expose
  // every export the component reads.
  leadSyncNoteOf: () => null,
}));

vi.mock('@paalstack/react-ui', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@paalstack/react-ui')>();
  return { ...actual, toast: { error: vi.fn(), success: vi.fn() } };
});

import { useVisitsInRange } from '@/hooks/queries/crm';
import { SiteVisitCalendar } from './site-visit-calendar';

function render(): string {
  return renderToStaticMarkup(
    <SiteVisitCalendar
      projectId="proj-1"
      weekStart={new Date('2026-09-16T00:00:00.000Z')}
      onWeekStartChange={() => undefined}
      onSlotClick={() => undefined}
    />,
  );
}

describe('SiteVisitCalendar default view', () => {
  it('mounts the AGENDA view by default, not the week grid', () => {
    const html = render();
    // The agenda view is what renders when no view has been chosen.
    expect(html).toContain('No events scheduled for the selected month');
    // The week grid must NOT be mounted - this is the assertion that would have
    // caught the change back to 'week'.
    expect(html).not.toContain('visits-week-grid');
  });

  it('still offers every view in the switcher, so the grid is one click away', () => {
    const html = render();
    // Nothing is removed by defaulting to agenda; the switcher is unchanged.
    for (const label of ['day', 'week', 'month', 'year', 'agenda']) {
      expect(html).toContain(`View by ${label}`);
    }
  });

  it('marks the agenda switcher as the active one', () => {
    const html = render();
    // The active view uses variant="default"; the others "outline". Assert the
    // agenda button is the one carrying the active treatment, so "which view is
    // selected" and "which view is mounted" cannot disagree.
    //
    // NOTE the slice direction: in the rendered markup `aria-label` comes FIRST
    // and `class` follows it, so the region to inspect runs FORWARD from the
    // label. Slicing backwards reads the previous button and asserts the wrong
    // element (which is how this test failed first time).
    const label = 'aria-label="View by agenda"';
    const idx = html.indexOf(label);
    expect(idx).toBeGreaterThan(-1);
    const button = html.slice(idx, idx + 900);
    // The active variant's filled background.
    expect(button).toContain('bg-primary');
    // And the inactive ones must not be filled - otherwise "active" means nothing.
    const weekIdx = html.indexOf('aria-label="View by week"');
    expect(html.slice(weekIdx, weekIdx + 900)).not.toContain('bg-primary');
  });

  it('shows a skeleton while visits load, not the empty agenda', () => {
    vi.mocked(useVisitsInRange).mockReturnValueOnce({
      data: undefined,
      isLoading: true,
      error: null,
    } as ReturnType<typeof useVisitsInRange>);
    const html = render();
    expect(html).not.toContain('No events scheduled for the selected month');
  });
});
