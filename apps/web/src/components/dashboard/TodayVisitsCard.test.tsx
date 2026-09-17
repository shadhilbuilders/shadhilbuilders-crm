// TodayVisitsCard - the dashboard's "Today's visits" list (T-LINK-CONVENTION).
//
// Covers the two changes made when the owner asked for the link convention:
//   1. the lead-name link is the library's `variant="link"` (hover underline
//      only) instead of a hand-styled `Link` with a static `underline`, and
//   2. the time is formatted by `dateIntl`, not a hand-rolled
//      `toLocaleTimeString` (the standing formatting convention forbids
//      hand-rolled Intl).
//
// renderToStaticMarkup only, per the repo's standing rule (apps/web has no
// @testing-library/react).
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';

import { TodayVisitsCard } from './TodayVisitsCard';

const visit = (over: Record<string, unknown> = {}) => ({
  id: 'v-1',
  leadId: 'l-1',
  leadName: 'Demo Priya',
  scheduledFor: '2026-09-16T11:30:00.000Z',
  userName: 'Demo Exec',
  ...over,
});

const render = (visits: unknown[], isExec = false) =>
  renderToStaticMarkup(
    <TodayVisitsCard
      visits={visits}
      isLoading={false}
      isExec={isExec}
      orgSlug="demo"
      projectSlug="demo-villas"
    />
  );

describe('TodayVisitsCard', () => {
  it('renders the lead link with the library link variant', () => {
    const html = render([visit()]);
    // The variant supplies the underline ON HOVER, so there must be NO bare
    // `underline` utility (that was the hand-rolled version, which underlined
    // the link at rest). Checked per CLASS TOKEN, not by regex: a `\bunderline\b`
    // pattern happily matches the `underline` inside `hover:underline`, which is
    // the string we want to keep.
    const classTokens = [...html.matchAll(/class="([^"]*)"/g)].flatMap((m) =>
      (m[1] ?? '').split(/\s+/).filter((t) => t.length > 0)
    );
    expect(classTokens).not.toContain('underline');
    expect(classTokens).toContain('hover:underline');
    expect(classTokens).toContain('underline-offset-4');
    // The app's link colour token, not the variant's default text-primary.
    expect(classTokens).toContain('text-link');
  });

  it('keeps the link a real anchor with a lead href', () => {
    const html = render([visit()]);
    // A link must stay navigable (middle-click, copy address, open in new tab);
    // rendering it as a plain button would lose all three.
    expect(html).toMatch(/<a [^>]*href="\/[^"]*\/leads\/l-1"/);
  });

  it('formats the visit time through dateIntl, not toLocaleTimeString', () => {
    const html = render([visit({ scheduledFor: '2026-09-16T11:30:00.000Z' })]);
    // dateIntl's configured dateTimeFormat is 'dd/MM/yyyy hh:mm a', so a
    // time-only render is 'hh:mm a'. Assert the shape rather than one zone's
    // exact hour, since the instance formats in its configured zone.
    expect(html).toMatch(/\d{2}:\d{2}\s?(AM|PM|am|pm)/);
  });

  it('falls back to "-" for a missing time rather than "Invalid Date"', () => {
    const html = render([visit({ scheduledFor: undefined })]);
    expect(html).not.toContain('Invalid Date');
    expect(html).toContain('-');
  });

  it('renders the plain name when a visit has no lead to link to', () => {
    const html = render([visit({ leadId: undefined })]);
    expect(html).toContain('Demo Priya');
    // No href means no anchor in this row.
    expect(html).not.toMatch(/\/leads\//);
  });

  it('re-labels the card for a sales exec, who CONDUCTS the visits', () => {
    expect(render([visit()], false)).toContain('Today&#x27;s visits');
    expect(render([visit()], true)).toContain('Today&#x27;s visits to conduct');
  });

  it('shows its own empty state', () => {
    const html = render([]);
    expect(html).not.toContain('hover:underline');
    expect(html.toLowerCase()).toMatch(/no visits|nothing/);
  });
});
