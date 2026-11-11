// PortalJourney + PortalHandoverCard + PortalMilestones + PortalHero.
// protects= "Stage N of 9" is stated in words, states are marked by text +
//           aria-current (not colour), an unrecorded stage says so and fills
//           nothing, no percentage is ever printed, the handover band is absent
//           when staff entered no date, and EVERY milestone reaches the buyer
//           in staff order (2026-11-10 - the card used to print only the next
//           one while the admin dialog promised "buyers see these, in order");
// fails_when= an unset stage reads as stage 1, a "%" appears, empty handover
//           data renders an empty card, or a milestone is hidden/ re-sorted;
// no_claim= static markup, not visual QA.
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';

import type { TimelinePhoto } from '@/hooks/queries/customer-portal';

import { PortalHandoverCard } from './portal-handover-card';
import { PortalHero } from './portal-hero';
import { PortalJourney } from './portal-journey';
import { PortalMilestones, metaCopy } from './portal-milestones';

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
  it('shows the date and a countdown', () => {
    const html = renderToStaticMarkup(
      <PortalHandoverCard expectedHandoverDate="2027-06-15T00:00:00Z" now={NOW} />,
    );
    expect(html).toContain('data-qa="portal-handover"');
    expect(html).toContain('15 Jun 2027');
    expect(html).toContain('about 7 months to go');
    // Milestones are NOT printed here any more (2026-11-10): PortalMilestones
    // owns them, so the same checkpoint cannot appear twice on one screen.
    expect(html).not.toContain('data-qa="portal-milestone');
  });

  it('has no countdown once the date has passed, and says nothing else', () => {
    const html = renderToStaticMarkup(
      <PortalHandoverCard expectedHandoverDate="2026-10-01T00:00:00Z" now={NOW} />,
    );
    expect(html).toContain('1 Oct 2026');
    expect(html).not.toContain('to go');
  });
});

describe('PortalMilestones', () => {
  const three = [
    { id: 'a', name: 'Foundation complete', targetDate: null, completedAt: '2026-10-01T00:00:00Z' },
    { id: 'b', name: 'Slab casting', targetDate: '2026-12-20T00:00:00Z', completedAt: null },
    { id: 'c', name: 'Handover', targetDate: '2027-06-15T00:00:00Z', completedAt: null },
  ];

  it('renders nothing when staff entered no milestones', () => {
    expect(renderToStaticMarkup(<PortalMilestones milestones={[]} now={NOW} />)).toBe('');
  });

  // The dialog tells the admin "buyers see these, in this order". Every row
  // must therefore reach the buyer - the old card printed only the next one.
  it('lists EVERY milestone in staff order, not just the next one', () => {
    const html = renderToStaticMarkup(<PortalMilestones milestones={three} now={NOW} />);
    expect(html.match(/data-qa="portal-milestone"/g)).toHaveLength(3);
    expect(html.indexOf('Foundation complete')).toBeLessThan(html.indexOf('Slab casting'));
    expect(html.indexOf('Slab casting')).toBeLessThan(html.indexOf('Handover'));
  });

  it('marks exactly one row as the next step, and states each state in words', () => {
    const html = renderToStaticMarkup(<PortalMilestones milestones={three} now={NOW} />);
    expect(html.match(/aria-current="step"/g)).toHaveLength(1);
    expect(html).toContain('data-state="reached"');
    expect(html).toContain('data-state="next"');
    expect(html).toContain('data-state="upcoming"');
    expect(html).toContain('Reached 1 Oct 2026');
    expect(html).toContain('Next');
    expect(html).toContain('Target 15 Jun 2027');
  });

  it('states the count of reached checkpoints', () => {
    const html = renderToStaticMarkup(<PortalMilestones milestones={three} now={NOW} />);
    expect(html).toContain('1 of 3 reached');
  });

  // A passed target date is a FACT ("was due"), never an "overdue" verdict -
  // the product has no basis for that grade (decision #116).
  it('says "was due" for a passed target and never the word overdue', () => {
    const html = renderToStaticMarkup(
      <PortalMilestones
        milestones={[{ id: 'x', name: 'Roof', targetDate: '2026-10-01T00:00:00Z', completedAt: null }]}
        now={NOW}
      />,
    );
    expect(html).toContain('Was due');
    expect(html.toLowerCase()).not.toContain('overdue');
  });

  it('states every row\'s date status, including a missing target', () => {
    const html = renderToStaticMarkup(
      <PortalMilestones
        milestones={[{ id: 'x', name: 'Roof', targetDate: null, completedAt: null }]}
        now={NOW}
      />,
    );
    expect(html).toContain('0 of 1 reached');
    expect(html).toContain('Target not set');
  });

  // Mobile (2026-11-11): a long milestone name and a long meta line must wrap,
  // not clip. `min-w-0` on the text column is what allows the wrap inside a
  // grid track; without it the track refuses to shrink and the text overflows.
  it('lets long names and meta lines wrap on a narrow screen', () => {
    const html = renderToStaticMarkup(
      <PortalMilestones
        milestones={[
          {
            id: 'x',
            name: 'Brickwork to terrace level including parapet and coping',
            targetDate: '2026-12-20T00:00:00Z',
            completedAt: null,
          },
        ]}
        now={NOW}
      />,
    );
    // The grid declares a shrinkable middle track and the text column opts in.
    expect(html).toContain('minmax(0,1fr)');
    expect(html).toContain('min-w-0');
    // No truncation utilities, which would hide part of the name outright.
    expect(html).not.toContain('truncate');
    expect(html).not.toContain('line-clamp');
    expect(html).not.toContain('overflow-hidden');
  });

  // The trailing date duplicate is a desktop affordance; on a phone it would
  // repeat the line directly above it on a 320px-wide row.
  it('hides the duplicate trailing date below sm', () => {
    const html = renderToStaticMarkup(<PortalMilestones milestones={three} now={NOW} />);
    const timeTag = html.match(/<time[^>]*>/)?.[0] ?? '';
    expect(timeTag).toContain('hidden');
    expect(timeTag).toContain('sm:block');
  });
});

describe('metaCopy', () => {
  const base = { id: 'x', name: 'Roof' };
  it('states reached with its date', () => {
    expect(
      metaCopy('reached', { ...base, targetDate: null, completedAt: '2026-10-01T00:00:00Z' }, false),
    ).toBe('Reached 1 Oct 2026');
  });
  it('leads the next row with "Next", and names the target', () => {
    expect(metaCopy('next', { ...base, targetDate: '2026-12-20T00:00:00Z', completedAt: null }, false)).toBe(
      'Next · Target 20 Dec 2026',
    );
  });
  it('states a passed target as "Was due", not overdue', () => {
    expect(metaCopy('upcoming', { ...base, targetDate: '2026-10-01T00:00:00Z', completedAt: null }, true)).toBe(
      'Was due 1 Oct 2026',
    );
  });
  it('says the target is unset rather than printing a dash', () => {
    expect(metaCopy('next', { ...base, targetDate: null, completedAt: null }, false)).toBe(
      'Next · Target not set',
    );
    expect(metaCopy('upcoming', { ...base, targetDate: null, completedAt: null }, false)).toBe('Target not set');
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
    expect(html).toContain('Hello, Anita Rao');
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
    expect(html).toContain('Hello, Anita Rao');
    expect(html).not.toContain('HELLO, ANITA');
  });

  // The hero greets the buyer by FULL name (2026-11-10). The masthead already
  // prints the short form, so the hero carries the whole name; stray whitespace
  // in the stored name must not leak into the sentence.
  it('greets with the full name, whitespace collapsed', () => {
    const html = renderToStaticMarkup(
      <PortalHero {...base} customerName="  Anita   Rao  " latest={photo} />,
    );
    expect(html).toContain('Hello, Anita Rao');
    expect(html).not.toContain('Anita   Rao');
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
