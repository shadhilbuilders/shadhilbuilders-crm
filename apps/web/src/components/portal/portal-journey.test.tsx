// PortalJourney + PortalHandoverCard + PortalHero (redesign 2026-11-09, pass 2).
// protects= "Stage N of 9" is stated in words, states are marked by text +
//           aria-current (not colour), an unrecorded stage says so and fills
//           nothing, no percentage is ever printed, and the handover card is
//           absent when staff entered nothing;
// fails_when= an unset stage reads as stage 1, a "%" appears, or empty handover
//           data renders an empty card; no_claim= static markup, not visual QA.
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';

import type { TimelinePhoto } from '@/hooks/queries/customer-portal';

import { PortalHandoverCard } from './portal-handover-card';
import { PortalHero } from './portal-hero';
import { PortalJourney } from './portal-journey';

const NOW = new Date('2026-11-09T10:00:00Z').getTime();

describe('PortalJourney', () => {
  it('names the position out of nine and marks done/current/upcoming by text', () => {
    const html = renderToStaticMarkup(<PortalJourney currentStage="MASONRY" />);
    expect(html).toContain('data-qa="portal-stage-stepper"');
    // The redesigned ladder prints the numeral and the total as figures, with
    // the stage NAME in visible text; "of 9" is no longer a sentence.
    expect(html).toContain('04');
    expect(html).toContain('/ 09');
    expect(html).toContain('Brickwork');
    expect(html.match(/aria-current="step"/g)).toHaveLength(1);
    expect(html).toContain('data-state="done"');
    expect(html).toContain('data-state="current"');
    expect(html).toContain('data-state="pending"');
    expect(html).toContain('(completed)');
    expect(html).toContain('(current stage)');
    expect(html).toContain('(upcoming)');
    expect(html).not.toContain('%');
  });

  // Regression (2026-11-09): "1 done · 7 to go" for stage 2 of 9 counted only
  // 8 stages. All three states must be named so the arithmetic reads true.
  it('accounts for all nine stages in the summary counts', () => {
    const html = renderToStaticMarkup(<PortalJourney currentStage="FOUNDATION" />);
    expect(html).toContain('data-qa="portal-stage-counts"');
    expect(html).toContain('1 done');
    expect(html).toContain('1 in progress');
    expect(html).toContain('7 left');
  });

  it('shows the update age when the newest capture time is supplied', () => {
    const html = renderToStaticMarkup(
      <PortalJourney currentStage="FOUNDATION" latestTakenAt="2026-11-09T04:00:00Z" now={NOW} />,
    );
    expect(html).toContain('data-qa="portal-stage-updated"');
    expect(html).toContain('Updated today');
  });

  it('renders all nine stages in enum order', () => {
    const html = renderToStaticMarkup(<PortalJourney currentStage="FOUNDATION" />);
    expect(html.match(/data-qa="portal-stage-segment-/g)).toHaveLength(9);
    expect(html.indexOf('segment-foundation')).toBeLessThan(html.indexOf('segment-ready'));
  });

  it('an unrecorded stage says so and marks nothing current or done', () => {
    const html = renderToStaticMarkup(<PortalJourney currentStage={null} />);
    expect(html).toContain('Stage not set');
    expect(html).not.toContain('aria-current="step"');
    expect(html).not.toContain('data-state="done"');
    expect(html).not.toContain('01');
  });

  // Regression (2026-11-09): the old nine-row list cost 584px of a 900px
  // viewport before the buyer saw a photo. The ladder must stay one row.
  it('is a single ladder of nine segments, not a nine-row list', () => {
    const html = renderToStaticMarkup(<PortalJourney currentStage="FOUNDATION" />);
    expect(html).toContain('portal-ladder');
    expect(html.match(/data-qa="portal-stage-segment-/g)).toHaveLength(9);
    // No per-row vertical padding classes from the old stepper.
    expect(html).not.toContain('min-h-[5.5rem]');
  });
});

describe('PortalHandoverCard', () => {
  it('renders nothing when there is no date and no milestones', () => {
    expect(renderToStaticMarkup(<PortalHandoverCard expectedHandoverDate={null} milestones={[]} now={NOW} />)).toBe('');
  });

  it('shows the date, a countdown, and the next unfinished milestone', () => {
    const html = renderToStaticMarkup(
      <PortalHandoverCard
        expectedHandoverDate="2027-06-15T00:00:00Z"
        milestones={[
          { id: 'a', name: 'Foundation complete', targetDate: null, completedAt: '2026-10-01T00:00:00Z' },
          { id: 'b', name: 'Slab casting', targetDate: '2026-12-20T00:00:00Z', completedAt: null },
        ]}
        now={NOW}
      />,
    );
    expect(html).toContain('data-qa="portal-handover"');
    expect(html).toContain('15 Jun 2027');
    expect(html).toContain('about 7 months to go');
    expect(html).toContain('Slab casting');
    expect(html).toContain('1 of 2');
  });

  it('milestones alone still render (no handover date)', () => {
    const html = renderToStaticMarkup(
      <PortalHandoverCard
        expectedHandoverDate={null}
        milestones={[{ id: 'a', name: 'Roof', targetDate: null, completedAt: null }]}
        now={NOW}
      />,
    );
    expect(html).toContain('Roof');
    expect(html).not.toContain('Expected handover');
  });
});

const photo: TimelinePhoto = {
  id: 'p1',
  unitId: 'u1',
  phaseId: 'ph1',
  phaseName: 'Plinth',
  mimeType: 'image/jpeg',
  filename: 'p1.jpg',
  caption: 'Plinth beam poured',
  takenAt: '2026-11-09T04:00:00Z',
  stage: 'FOUNDATION',
  createdAt: '2026-11-09T04:00:00Z',
  creatorName: 'Ravi',
  creatorIsPhotoLead: false,
  mediaUrl: '/api/bff/media/p1',
  canMutate: false,
};

describe('PortalHero', () => {
  const base = {
    customerName: 'Anita Rao',
    unitNumber: 'A-101',
    projectName: 'Green Valley',
    isLoading: false,
    onOpenPhoto: () => undefined,
    now: NOW,
  };

  it('titles the home as a record and frames the latest photo with its note', () => {
    const html = renderToStaticMarkup(<PortalHero {...base} latest={photo} />);
    expect(html).toContain('data-qa="portal-unit-heading"');
    expect(html).toContain('A-101');
    expect(html).toContain('Green Valley');
    expect(html).toContain('Hello, Anita');
    expect(html).toContain('Updated today');
    expect(html).toContain('Plinth beam poured');
    expect(html).toContain('/api/bff/media/p1');
    expect(html).toContain('data-qa="portal-hero-photo"');
    // The stage appears as a tabular figure, not a sentence.
    expect(html).toContain('data-qa="portal-hero-stage"');
    expect(html).toContain('2 of 9');
    // The note is stated once in a blockquote. (The caption also appears in
    // alt + aria-label, which is accessibility text, not visible duplication.)
    expect(html.match(/<blockquote[^>]*>Plinth beam poured/g)).toHaveLength(1);
    // The photo strip names the phase, not the note again.
    expect(html).toContain('data-qa="portal-hero-phase"');
  });

  it('with no photo yet: warm placeholder, no broken image, no stage figure', () => {
    const html = renderToStaticMarkup(<PortalHero {...base} latest={null} />);
    expect(html).toContain('data-qa="portal-hero-empty"');
    expect(html).not.toContain('<img');
    expect(html).not.toContain('of 9');
  });

  it('loading: busy skeleton in the photo slot', () => {
    const html = renderToStaticMarkup(<PortalHero {...base} latest={null} isLoading />);
    expect(html).toContain('aria-busy="true"');
    expect(html).not.toContain('data-qa="portal-hero-empty"');
  });

  // Regression (2026-11-09): "Stage 2 of 9" used to be printed in the hero
  // chip, the journey heading, the 12px meta and every photo card. The hero
  // owns it now; the journey shows the numeral only.
  it('states the stage position exactly once in the hero', () => {
    const html = renderToStaticMarkup(<PortalHero {...base} latest={photo} />);
    expect(html.match(/2 of 9/g)).toHaveLength(1);
  });

  // Regression (2026-11-09): the greeting was a tracked uppercase chip, which
  // is the coldest possible rendering of "Hello, <name>".
  it('greets in sentence case, not tracked uppercase', () => {
    const html = renderToStaticMarkup(<PortalHero {...base} latest={photo} />);
    expect(html).toContain('Hello, Anita');
    expect(html).not.toContain('HELLO, ANITA');
  });

  // Regression (2026-11-09): four components shared one double-bezel frame, so
  // nothing had hierarchy. The hero must not reintroduce the nested shell.
  // Regression (2026-11-09): the record head ran on `gap-5` and the plate row
  // on `gap-8`, so the right-hand column started 8px further right on one row
  // than the other (spec dl at x=912 vs note at x=920) and the photo ended 4px
  // short of the headline above it. Both rows must use ONE gap token.
  it('uses one column gap for the head and the plate, so edges cannot drift', () => {
    const html = renderToStaticMarkup(<PortalHero {...base} latest={photo} />);
    const grids = html.match(/lg:grid-cols-12 lg:gap-x-8 lg:gap-y-0/g) ?? [];
    expect(grids).toHaveLength(2);
    // The old divergent gaps must not reappear.
    expect(html).not.toContain('lg:gap-5');
    expect(html).not.toContain('lg:gap-8 ');
  });

  // The journey is a full-width band between the head and the plate: it
  // describes the UNIT, not the photo, so it renders before the plate.
  it('renders the journey band between the record head and the photo', () => {
    const html = renderToStaticMarkup(
      <PortalHero {...base} latest={photo}>
        <p data-qa="band-under-test">journey</p>
      </PortalHero>,
    );
    expect(html).toContain('data-qa="band-under-test"');
    expect(html.indexOf('portal-unit-heading')).toBeLessThan(html.indexOf('band-under-test'));
    expect(html.indexOf('band-under-test')).toBeLessThan(html.indexOf('portal-hero-photo'));
  });

  // The note column answers the questions the quote raises.
  it('shows phase, stage, recorded date and photo count under the note', () => {
    const html = renderToStaticMarkup(<PortalHero {...base} latest={photo} photoCount={2} />);
    expect(html).toContain('data-qa="portal-hero-note-facts"');
    expect(html).toContain('Phase');
    expect(html).toContain('Recorded');
    expect(html).toContain('Photos');
    expect(html).toContain('2 photos');
  });
});
