import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';

import { LeadTimeline } from './lead-timeline';

const row = (id: string, type: 'ASSIGNMENT' | 'STATUS_CHANGE', body: string) => ({
  id,
  type,
  body,
  createdAt: '2026-10-09T10:00:00.000Z',
  userName: 'Asha',
});

describe('LeadTimeline', () => {
  it('renders an ASSIGNMENT row with its friendly label', () => {
    const html = renderToStaticMarkup(
      <LeadTimeline
        leadName="Priya"
        isLoading={false}
        activities={[row('a', 'ASSIGNMENT', 'Reassigned from A to B')]}
      />,
    );
    expect(html).toContain('Assignment');
    expect(html).toContain('Reassigned from A to B');
    expect(html).not.toContain('lead-timeline-truncated');
  });

  it('offers "Load earlier events" only when older events exist', () => {
    const rows = [row('a', 'STATUS_CHANGE', 'New -> Talked')];
    const withMore = renderToStaticMarkup(
      <LeadTimeline leadName="Priya" isLoading={false} hasMore onLoadMore={() => undefined} activities={rows} />,
    );
    expect(withMore).toContain('Load earlier events');
    const without = renderToStaticMarkup(
      <LeadTimeline leadName="Priya" isLoading={false} activities={rows} />,
    );
    expect(without).not.toContain('Load earlier events');
  });
});
