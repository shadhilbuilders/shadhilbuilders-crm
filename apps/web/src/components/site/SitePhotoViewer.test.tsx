// SitePhotoViewer + PortalStageStepper (now PortalJourney) (2026-11-08).
//
// protects= the viewer renders nothing when closed, shows the note / full date /
//           uploader when open, exposes 44px prev / next / close controls with
//           their aria labels, and the buyer's stepper fills exactly the current
//           segment and NAMES it (never a percentage), with "Stage not set" when
//           the newest capture recorded no stage;
// fails_when= a closed viewer leaves markup behind, an arrow has no label, the
//           stepper prints a completion percentage, a null stage renders "Not
//           started", or the segment count stops matching the enum;
// no_claim= static markup: the keyboard handler and the portal are the library's
//           and the page's own concern.
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';

import type { TimelinePhoto } from '@/hooks/queries/customer-progress';
import { CONSTRUCTION_STAGE_ORDER } from '@/lib/labels';

import { PortalJourney as PortalStageStepper } from '@/components/portal/portal-journey';
import { fullCaptureTime, SitePhotoViewer, SitePhotoViewerPanel } from './SitePhotoViewer';

const photo: TimelinePhoto = {
  id: 'p1',
  unitId: 'unit-1',
  phaseId: 'phase-b',
  phaseName: 'Phase B',
  mimeType: 'image/webp',
  filename: 'site.webp',
  caption: 'Plinth poured, curing until Friday',
  takenAt: '2026-11-08T04:12:00.000Z',
  stage: 'STRUCTURE',
  createdAt: '2026-11-08T04:12:00.000Z',
  creatorName: 'Ravi Kumar',
  creatorIsPhotoLead: false,
  mediaUrl: '/api/bff/media/org/x/site.webp',
  canMutate: false,
};

/** The Dialog portals into document.body, so the static test renders the panel.
 *  The wrapper's own contract is the `photo === null → nothing` guard. */
const viewer = (over: Partial<Parameters<typeof SitePhotoViewerPanel>[0]> = {}): string =>
  renderToStaticMarkup(
    <SitePhotoViewerPanel
      photo={photo}
      unitNumber="B-101"
      onClose={() => undefined}
      hasPrevious
      hasNext
      onPrevious={() => undefined}
      onNext={() => undefined}
      {...over}
    />,
  );

describe('fullCaptureTime', () => {
  it('reads day, full month, year and a 12-hour clock', () => {
    expect(fullCaptureTime('2026-11-08T04:12:00.000Z')).toBe('8 November 2026 at 9:42 am');
  });
});

describe('SitePhotoViewer', () => {
  it('renders nothing when closed', () => {
    expect(
      renderToStaticMarkup(
        <SitePhotoViewer
          photo={null}
          unitNumber="B-101"
          onClose={() => undefined}
          hasPrevious={false}
          hasNext={false}
          onPrevious={() => undefined}
          onNext={() => undefined}
        />,
      ),
    ).toBe('');
  });

  it('names the unit and the note in the image alt', () => {
    expect(viewer()).toContain('alt="Unit B-101, &quot;Plinth poured, curing until Friday&quot;"');
  });

  it('carries the note, the full date and the uploader in the bottom bar', () => {
    const html = viewer();
    expect(html).toContain('data-qa="site-photo-note"');
    expect(html).toContain('Plinth poured, curing until Friday');
    expect(html).toContain('data-qa="site-photo-full-date"');
    expect(html).toContain('8 November 2026');
    expect(html).toContain('data-qa="site-photo-uploader"');
    expect(html).toContain('Ravi Kumar');
  });

  it('gives every icon-only control a label and a 44px target', () => {
    const html = viewer();
    expect(html).toContain('aria-label="Close photo"');
    expect(html).toContain('aria-label="Previous photo"');
    expect(html).toContain('aria-label="Next photo"');
    expect((html.match(/size-11/g) ?? []).length).toBeGreaterThanOrEqual(3);
  });

  it('offers neighbours only when they exist', () => {
    const alone = viewer({ hasPrevious: false, hasNext: false });
    expect(alone).not.toContain('site-photo-previous');
    expect(alone).not.toContain('site-photo-next');
  });

  it('keeps the close control below the status bar on a notched phone', () => {
    // Reported on an installed iPhone on 2026-11-24: the photo view opened with
    // no visible way out, because the whole control row was drawn at y=0, under
    // the clock and the notch, and taps there belong to the system.
    // `env(safe-area-inset-top)` is 0 in jsdom, so the contract is asserted on
    // the class string, the same way the capture header is pinned.
    const html = viewer();
    const row = html.match(/<div class="relative z-10[^"]*">/)?.[0] ?? '';
    expect(row, 'the control row is not rendered').not.toBe('');
    expect(row).toContain('env(safe-area-inset-top)');
    // It is the row that carries the controls, not an empty wrapper above them.
    expect(html.indexOf('site-photo-close')).toBeGreaterThan(html.indexOf(row));
  });

  it('keeps the image at object-contain with no percentage or progress claim', () => {
    const html = viewer();
    expect(html).toContain('object-contain');
    expect(html).not.toMatch(/\d+%/);
  });
});

describe('PortalStageStepper', () => {
  it('renders one segment per stage, in enum order', () => {
    const html = renderToStaticMarkup(<PortalStageStepper currentStage="STRUCTURE" />);
    const segments = [...html.matchAll(/data-qa="portal-stage-segment-([a-z_]+)"/g)].map(
      (m) => m[1],
    );
    expect(segments).toEqual(CONSTRUCTION_STAGE_ORDER.map((s) => s.toLowerCase()));
  });

  it('marks exactly one segment current and names the stage beside it', () => {
    const html = renderToStaticMarkup(<PortalStageStepper currentStage="STRUCTURE" />);
    expect((html.match(/data-state="current"/g) ?? []).length).toBe(1);
    expect(html).toContain('Structure');
    expect(html).toContain('data-qa="portal-stage-current"');
  });

  it('fills the earlier segments and leaves the later ones pending', () => {
    const html = renderToStaticMarkup(<PortalStageStepper currentStage="STRUCTURE" />);
    // NOT_STARTED and FOUNDATION are behind it.
    expect((html.match(/data-state="done"/g) ?? []).length).toBe(2);
  });

  it('fails_when= an unrecorded stage reads "Not started"', () => {
    const html = renderToStaticMarkup(<PortalStageStepper currentStage={null} />);
    expect(html).toContain('Stage not set');
    // The segment list is the enum itself, so NOT_STARTED's own label exists in
    // its sr-only text; what must NOT happen is the CURRENT stage claiming it.
    expect(html).toContain('data-qa="portal-stage-current"');
    expect(html).not.toContain('(current stage)');
    expect(html).not.toContain('data-state="current"');
  });

  it('never prints a percentage: nine discrete stages are not a progress bar', () => {
    const html = renderToStaticMarkup(<PortalStageStepper currentStage="PLASTERING" />);
    expect(html).not.toMatch(/\d+\s*%/);
  });
});
