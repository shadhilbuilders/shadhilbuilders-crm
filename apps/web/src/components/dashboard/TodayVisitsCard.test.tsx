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
  // The LEAD's owner and the VISIT's exec are deliberately different people in
  // this fixture: plan §3 keeps the telecaller as owner through
  // VISIT_SCHEDULED while a sales exec conducts the visit, which is exactly the
  // state the dashboard's today-list shows.
  leadOwnerName: 'Demo Telecaller',
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

  // ──────────────────────────────────────────────────────────────────────────
  // T-VISIT-OWNER-LABEL (2026-09-28)
  // ──────────────────────────────────────────────────────────────────────────
  // The reported bug: the dashboard showed one name where the lead page showed
  // another, for the same lead. The card printed the visit's exec bare, which
  // read as the lead's owner. Both are correct people; the row simply never
  // said which was which.

  it('labels the lead owner and the visit exec as two distinct people', () => {
    const html = render([visit()]);
    // Both names present...
    expect(html).toContain('Demo Telecaller');
    expect(html).toContain('Demo Exec');
    // ...and each carries its label, so neither can be read as the other.
    expect(html).toContain('Owner:');
    expect(html).toContain('Visit exec:');
    // The owner label must NOT be satisfied by the exec's name - this is the
    // assertion that would have failed before the fix, when the exec was the
    // only name and had no label at all.
    expect(html).toMatch(/Owner:\s*(<[^>]*>\s*)*Demo Telecaller/);
    expect(html).toMatch(/Visit exec:\s*(<[^>]*>\s*)*Demo Exec/);
  });

  it('renders the owner before the exec, matching the lead page field order', () => {
    const html = render([visit()]);
    expect(html.indexOf('Owner:')).toBeLessThan(html.indexOf('Visit exec:'));
  });

  it('shows "-" when the owner name is missing rather than borrowing the exec name', () => {
    // The backend types `leadOwnerName` as non-null (Lead.ownerId is NOT NULL),
    // so this only guards the render against an absent/blank value - the point
    // is that it must NEVER fall back to the exec name, which would rebuild the
    // exact confusion this change removes.
    const html = render([visit({ leadOwnerName: '' })]);
    expect(html).toMatch(/Owner:\s*(<[^>]*>\s*)*-/);
    expect(html).toContain('Demo Exec');
  });

  it('keeps "unassigned" for a visit with no exec', () => {
    const html = render([visit({ userName: undefined })]);
    expect(html).toContain('unassigned');
    expect(html).toContain('Demo Telecaller');
  });

  it('degrades safely when the field is absent entirely (older payload)', () => {
    const html = render([visit({ leadOwnerName: undefined })]);
    expect(html).not.toContain('undefined');
    expect(html).toContain('Owner:');
    expect(html).toContain('Demo Exec');
  });
});
