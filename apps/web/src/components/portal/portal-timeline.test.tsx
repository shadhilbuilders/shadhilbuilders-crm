// PortalTimeline (issue #8 slice 2): the four states + the design contract.
//
// protects= loading/empty/error/data states render, rows are an ordered list
//           inside month sections, ONLY the newest photo's phase chip is the
//           green accent, a11y hooks exist (alt, chip aria-label, live region)
//           and "load more" shows only when more exists;
// fails_when= a state is missing, the accent leaks to older phases, alt text
//           is empty, or load-more shows with no next page;
// no_claim= static markup only: no interaction, no real images, not visual QA.
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';

import type { TimelinePhoto } from '@/hooks/queries/customer-portal';

import { PortalTimeline, type PortalTimelineProps } from './portal-timeline';

const photo = (id: string, phaseId: string, phaseName: string, takenAt: string, caption = `${phaseName} cap`): TimelinePhoto => ({
  id,
  unitId: 'u1',
  phaseId,
  phaseName,
  mimeType: 'image/jpeg',
  filename: `${id}.jpg`,
  caption,
  takenAt,
  createdAt: takenAt,
  creatorName: 'Ravi',
  creatorIsPhotoLead: false,
  mediaUrl: `/api/bff/media/${id}`,
});

const base: PortalTimelineProps = {
  photos: [],
  isLoading: false,
  isError: false,
  onRetry: () => undefined,
  hasMore: false,
  isLoadingMore: false,
  onLoadMore: () => undefined,
  onOpenPhoto: () => undefined,
};
const render = (over: Partial<PortalTimelineProps>) => renderToStaticMarkup(<PortalTimeline {...base} {...over} />);

const DATA = [
  photo('p3', 'ph2', 'Plinth', '2026-11-03T08:00:00Z'),
  photo('p2', 'ph1', 'Foundation', '2026-10-20T08:00:00Z'),
  photo('p1', 'ph1', 'Foundation', '2026-10-05T08:00:00Z'),
];

describe('PortalTimeline states', () => {
  it('loading: a busy skeleton shaped like the list, no rows', () => {
    const html = render({ isLoading: true });
    expect(html).toContain('data-qa="portal-skeleton"');
    expect(html).toContain('aria-busy="true"');
    expect(html).not.toContain('portal-photo-row');
  });

  it('empty: warm copy, forward looking', () => {
    const html = render({});
    expect(html).toContain('First photos coming soon');
    expect(html).toContain("We&#x27;ll notify you when the first photo lands.");
  });

  it('error: inline alert with a retry control', () => {
    const html = render({ isError: true });
    expect(html).toContain('role="alert"');
    expect(html).toContain('data-qa="portal-load-retry"');
  });

  it('data: month sections each hold an ordered list of rows', () => {
    const html = render({ photos: DATA });
    expect(html).toContain('November 2026');
    expect(html).toContain('October 2026');
    expect(html.match(/<section/g)).toHaveLength(2);
    expect(html.match(/<ol/g)).toHaveLength(2);
    expect(html.match(/data-qa="portal-photo-row"/g)).toHaveLength(3);
    expect(html).toContain('aria-live="polite"');
  });
});

describe('PortalTimeline design contract', () => {
  it('only the newest photo phase is the success accent; older phases are muted', () => {
    const html = render({ photos: DATA });
    const chips = html.match(/<[^>]*data-qa="portal-phase-chip"[^>]*>/g) ?? [];
    expect(chips).toHaveLength(3);
    expect(chips[0]).toContain('Phase: Plinth, current phase');
    expect(chips[1]).toContain('aria-label="Phase: Foundation"');
    expect(chips[2]).toContain('aria-label="Phase: Foundation"');
    expect(html.match(/current phase/g)).toHaveLength(1);
  });

  it('every image has non-empty alt; first two eager, the rest lazy', () => {
    const html = render({ photos: [...DATA, photo('p0', 'ph1', 'Foundation', '2026-09-30T08:00:00Z', ' ')] });
    const imgs = html.match(/<img[^>]*>/g) ?? [];
    expect(imgs).toHaveLength(4);
    for (const img of imgs) expect(img).toMatch(/alt="[^"]+"/);
    expect(imgs[0]).toContain('loading="eager"');
    expect(imgs[1]).toContain('loading="eager"');
    expect(imgs[2]).toContain('loading="lazy"');
    expect(imgs[3]).toContain('Construction photo, Foundation');
  });

  it('shows "load more" only when another page exists', () => {
    expect(render({ photos: DATA, hasMore: true })).toContain('data-qa="portal-load-more"');
    expect(render({ photos: DATA, hasMore: false })).not.toContain('portal-load-more');
  });

  it('a deep-linked photo carries the single motion class; others do not', () => {
    const html = render({ photos: DATA, focusedPhotoId: 'p2' });
    expect(html.match(/animate-portal-focus/g)).toHaveLength(1);
    expect(html).toContain('id="photo-p2"');
  });

  it('the page uses no dashboard chrome: no search, filter or settings controls', () => {
    const html = render({ photos: DATA });
    expect(html).not.toMatch(/type="search"|aria-label="(Search|Filter|Settings)/i);
  });
});
