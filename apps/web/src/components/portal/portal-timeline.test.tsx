// PortalTimeline (phase-grouped story, 2026-11-09): the four states + the design contract.
//
// protects= loading/empty/error/data states render, rows are an ordered list
//           inside phase sections, ONLY the newest photo's phase carries the
//           "Current phase" badge, a11y hooks exist (alt, live region)
//           and "load more" shows only when more exists;
// fails_when= a state is missing, the accent leaks to older phases, alt text
//           is empty, or load-more shows with no next page;
// no_claim= static markup only: no interaction, no real images, not visual QA.
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';

import type { TimelinePhoto } from '@/hooks/queries/customer-portal';

import { PortalTimeline, type PortalTimelineProps } from './portal-timeline';

const photo = (
  id: string,
  phaseId: string,
  phaseName: string,
  takenAt: string,
  caption = `${phaseName} cap`,
  stage: TimelinePhoto['stage'] = null,
): TimelinePhoto => ({
  id,
  unitId: 'u1',
  phaseId,
  phaseName,
  mimeType: 'image/jpeg',
  filename: `${id}.jpg`,
  caption,
  takenAt,
  stage,
  createdAt: takenAt,
  creatorName: 'Ravi',
  creatorIsPhotoLead: false,
  mediaUrl: `/api/bff/media/${id}`,
  canMutate: false,
});

const base: PortalTimelineProps = {
  photos: [],
  isLoading: false,
  hasMore: false,
  isLoadingMore: false,
  onLoadMore: () => undefined,
  onOpenPhoto: () => undefined,
};
const render = (over: Partial<PortalTimelineProps>) =>
  renderToStaticMarkup(<PortalTimeline {...base} {...over} />);

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
    expect(html).toContain('We&#x27;ll notify you when the first photo lands.');
  });

  // 2026-11-09: the error state moved OUT of this component. A failed timeline
  // means the hero photo and the journey ladder are both untrustworthy, so the
  // page renders the shared PageError instead of this panel - rendering an error
  // here left "First photos coming soon" sitting directly above a 500 screen.
  it('owns no error state: a failed load is the page\u2019s job, not the list\u2019s', () => {
    const html = render({ photos: [] });
    expect(html).not.toContain('error-internal-server');
    expect(html).not.toContain('portal-load-error');
    expect(html).not.toContain('Internal Server Error');
  });

  it('data: phase sections each hold an ordered list of rows', () => {
    const html = render({ photos: DATA });
    expect(html).toContain('Plinth');
    expect(html).toContain('Foundation');
    expect(html.match(/data-qa="portal-phase-group"/g)).toHaveLength(2);
    expect(html.match(/<ol/g)).toHaveLength(2);
    expect(html.match(/data-qa="portal-photo-row"/g)).toHaveLength(3);
    expect(html).toContain('2 photos');
    expect(html).toContain('role="status"');
    expect(html).not.toContain('aria-live');
  });
});

describe('PortalTimeline design contract', () => {
  it('only the newest photo phase is badged "Current phase"', () => {
    const html = render({ photos: DATA });
    expect(html.match(/data-qa="portal-current-chip"/g)).toHaveLength(1);
    expect(html.match(/data-current="true"/g)).toHaveLength(1);
    expect(html.indexOf('Current phase')).toBeLessThan(html.indexOf('Foundation'));
  });

  it('every image has non-empty alt; first two eager, the rest lazy', () => {
    const html = render({
      photos: [...DATA, photo('p0', 'ph1', 'Foundation', '2026-09-30T08:00:00Z', ' ')],
    });
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

  // 2026-11-09: the phase group now shows EVERY loaded photo. The page used to
  // slice the newest one off to avoid repeating it, which also hid that photo
  // from the record.
  it('renders every photo it is given, with no cap per phase', () => {
    const html = render({ photos: DATA });
    expect(html.match(/data-qa="portal-photo-row"/g)).toHaveLength(3);

    const many = Array.from({ length: 60 }, (_, i) =>
      photo(
        `x${i}`,
        'ph1',
        'Foundation',
        `2026-10-${String((i % 28) + 1).padStart(2, '0')}T08:00:00Z`,
      ),
    );
    expect(render({ photos: many }).match(/data-qa="portal-photo-row"/g)).toHaveLength(60);
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

  // 2026-11-08: the note was invisible unless the buyer tapped the photo (it
  // only existed in the lightbox description). It is now the row's content, so
  // this assertion fails the moment that column disappears again.
  it('renders the note under the photo, without a tap', () => {
    const html = render({
      photos: [
        photo(
          'p1',
          'ph1',
          'Foundation',
          '2026-11-05T08:00:00Z',
          'Plinth poured, curing until Friday',
        ),
      ],
    });
    expect(html).toContain('Plinth poured, curing until Friday');
    expect(html).toContain('data-qa="portal-photo-caption"');
    // The image comes first, then the caption: reading order is photo, note.
    expect(html.indexOf('<img')).toBeLessThan(html.indexOf('Plinth poured'));
  });

  it('skips the caption line entirely when the note is empty', () => {
    const html = render({
      photos: [photo('p1', 'ph1', 'Foundation', '2026-11-05T08:00:00Z', '   ')],
    });
    expect(html).not.toContain('data-qa="portal-photo-caption"');
  });

  // 2026-11-08: each entry carries the stage recorded with that capture, and a
  // null stage renders nothing on the row (the unit header owns "Stage not set";
  // repeating it on every old photo would be noise).
  it('shows the per-photo stage when one was recorded, and omits it when null', () => {
    const staged = render({
      photos: [photo('p1', 'ph1', 'Foundation', '2026-11-05T08:00:00Z', 'Slab', 'STRUCTURE')],
    });
    expect(staged).toContain('data-qa="portal-photo-stage"');
    expect(staged).toContain('Structure');

    const unstaged = render({
      photos: [photo('p1', 'ph1', 'Foundation', '2026-11-05T08:00:00Z', 'Slab', null)],
    });
    expect(unstaged).not.toContain('data-qa="portal-photo-stage"');
    expect(unstaged).not.toContain('Not started');
  });
});
