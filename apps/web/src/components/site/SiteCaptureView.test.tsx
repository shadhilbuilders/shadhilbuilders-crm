// SiteCaptureView (2026-11-08): the capture screen's states.
//
// protects= the empty hero is ONE tap target with the three-step line, the
//           skeleton is card-shaped, a timeline error carries its retry, one card
//           renders per photo with the NOTE as the headline (no per-row phase
//           chip, no truncation), the in-flight and failed upload cards say
//           exactly what happened, and "Load more" obeys the cursor rule;
// fails_when= the two competing empty affordances come back, a caption is
//           truncated, a phase chip reappears on every row, a progress percentage
//           is invented, a failed upload claims anything other than "nothing was
//           saved", or the sticky primary action loses its 48px height;
// no_claim= static markup only: no real file picking, no camera, no fetching.
//           The FileUpload internals are the library's own tests.
import { createRef } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';

import type { TimelinePhoto } from '@/hooks/queries/customer-progress';

import { formatBytes } from '@paalstack/react-ui';

import { SiteCaptureView, type SiteCaptureViewProps } from './SiteCaptureView';
import { EMPTY_HERO_CLASS } from './SiteEmptyHero';
import {
  EMPTY_BOX_CLASS,
  MAX_NOTE_PHOTOS,
  noteDialogHeading,
  NoteDialogBody,
  NOTE_DIALOG_CONTENT_CLASS,
  noteSaveLabel,
  PREVIEW_BOX_CLASS,
  STAGE_PICKER_OPTIONS,
  STAGE_UNSET,
  type NoteAttachment,
  type NoteDialogBodyProps,
  type NoteDialogProps,
} from './NoteDialog';
import { QUICK_NOTE_LABELS, quickNoteSlug } from '@/lib/site-photos';

// The row actions need a query client (they own the mutations). The feed takes
// them as a slot, so this test provides a marker instead - the actions' own
// behaviour is covered by ProgressPhotoActions.test.tsx.
vi.mock('@/components/inventory/ProgressPhotoActions', () => ({
  ProgressPhotoActions: () => null,
}));

const NOW = new Date('2026-11-08T10:00:00.000Z');

function photo(over: Partial<TimelinePhoto> & { id: string }): TimelinePhoto {
  return {
    unitId: 'unit-1',
    phaseId: 'phase-b',
    phaseName: 'Phase B',
    mimeType: 'image/webp',
    filename: 'site.webp',
    caption: 'Plinth poured, curing until Friday',
    takenAt: '2026-11-08T04:12:00.000Z',
    stage: null,
    createdAt: '2026-11-08T04:12:00.000Z',
    creatorName: 'Ravi Kumar',
    creatorIsPhotoLead: false,
    mediaUrl: '/api/bff/media/org/x/site.webp',
    canMutate: false,
    ...over,
  };
}

const noteDialog: NoteDialogProps = {
  open: false,
  onOpenChange: () => undefined,
  unitNumber: 'B-101',
  phaseName: 'Phase B',
  attachments: [],
  onAddFiles: () => undefined,
  onRemoveAttachment: () => undefined,
  isPreparing: false,
  note: '',
  onNoteChange: () => undefined,
  selectedChips: [],
  onToggleChip: () => undefined,
  stage: null,
  onStageChange: () => undefined,
  isSaving: false,
  isOffline: false,
  onSave: () => undefined,
};

const base: SiteCaptureViewProps = {
  unit: {
    unitNumber: 'B-101',
    projectName: 'Metro Heights',
    phaseName: 'Phase B',
    status: 'AVAILABLE',
    lastRecordedStage: null,
    photoCount: 0,
    lastPhotoAt: null,
  },
  backHref: '/shadhil-builders/projects/metro-heights/site',
  photos: [],
  isLoading: false,
  isError: false,
  onRetry: () => undefined,
  hasMore: false,
  isLoadingMore: false,
  onLoadMore: () => undefined,
  uploading: [],
  onRetryUpload: () => undefined,
  onDiscardUpload: () => undefined,
  onOpenPhoto: () => undefined,
  now: NOW,
  cameraInputRef: createRef<HTMLInputElement>(),
  onCameraChange: () => undefined,
  onCameraClick: () => undefined,
  onGalleryFiles: () => undefined,
  onFileReject: () => undefined,
  isPreparing: false,
  noteDialog,
  viewer: {
    photo: null,
    unitNumber: 'B-101',
    onClose: () => undefined,
    hasPrevious: false,
    hasNext: false,
    onPrevious: () => undefined,
    onNext: () => undefined,
  },
  announcement: '',
};

const render = (over: Partial<SiteCaptureViewProps> = {}): string =>
  renderToStaticMarkup(<SiteCaptureView {...base} {...over} />);

describe('SiteCaptureView chrome', () => {
  it('protects= there is no tab bar, no modal chrome and no Close button', () => {
    const html = render();
    expect(html).not.toContain('data-qa="unit-detail-close"');
    expect(html).not.toContain('>Close<');
    expect(html).not.toContain('role="tablist"');
    // The back chevron is the only exit.
    expect(html).toContain('aria-label="Back to site updates"');
  });

  it('shows the unit, project/phase context and both header badges', () => {
    const html = render();
    expect(html).toContain('B-101');
    expect(html).toContain('Metro Heights · Phase B');
    expect(html).toContain('data-qa="site-unit-status"');
    expect(html).toContain('data-qa="site-unit-stage"');
  });

  it('protects= a null stage reads "Stage not set", never "Not started"', () => {
    const html = render();
    expect(html).toContain('Stage not set');
    expect(html).not.toContain('Not started');
  });

  it('shows a recorded stage in the header', () => {
    const html = render({ unit: { ...base.unit, lastRecordedStage: 'STRUCTURE' } });
    expect(html).toContain('Structure');
  });

  it('protects= both bars are opaque and the header pads the notch inset with air', () => {
    // Reported on an installed iPhone: the header looked half-blurred (the feed
    // showed through the 95%-opaque, backdrop-blurred surface as a patchy smear)
    // and the row sat flush against the status bar and the border.
    //
    // `env(safe-area-inset-*)` is 0 in jsdom, desktop Chrome and Playwright, so
    // the contract is asserted on the class string - the same reason
    // app-header-safe-area.test.ts pins AppHeader this way.
    const html = render();
    const header = html.match(/<header[^>]*>/)?.[0] ?? '';
    expect(header).toContain('sticky top-0');
    expect(header).toContain('env(safe-area-inset-top)');
    expect(header).toContain('min(2rem,env(safe-area-inset-top))');
    expect(header).not.toContain('backdrop-blur');
    expect(header).not.toMatch(/bg-background\/\d/);

    const footer = html.match(/<footer[^>]*>/)?.[0] ?? '';
    expect(footer).toContain('sticky bottom-0');
    expect(footer).not.toMatch(/bg-background\/\d/);
  });

  it('keeps the primary action on the sticky bar and full width', () => {
    const html = render();
    const take = html.match(/<button[^>]*data-qa="site-take-photo"[^>]*>/)?.[0] ?? '';
    const tokens = (take.match(/class="([^"]*)"/)?.[1] ?? '').split(/\s+/);
    // Exact tokens: a missing space once fused adjacent utilities and still passed a substring check.
    expect(tokens).toContain('flex-1');
    expect(tokens).toContain('min-h-12');
    expect(tokens.some((t) => /^min-h-\d+flex/.test(t))).toBe(false);
    expect(html).toContain('Take photo');
    expect(html).toContain('Gallery');
  });

  it('keeps the camera input as a plain input with capture, outside FileUpload', () => {
    // FileUpload does not expose `capture`; without it an iPhone shows the
    // Library / Take Photo sheet and costs a tap on every photo.
    const html = render();
    const input = html.match(/<input[^>]*data-qa="site-camera-input"[^>]*>/)?.[0] ?? '';
    expect(input).toContain('capture="environment"');
    expect(input).toContain('accept="image/*"');
  });

  it('reserves room below the feed so the sticky bar never covers a card', () => {
    expect(render()).toContain('pb-28');
  });
});

describe('SiteCaptureView video capture (flag)', () => {
  const video = {
    onRecord: vi.fn(),
    onFile: vi.fn(),
    fileInputRef: createRef<HTMLInputElement>(),
  };

  it('flag off: the bar is the photo-only bar, with no video control or input', () => {
    const html = render();
    expect(html).not.toContain('capture-video');
    expect(html).toContain('data-qa="site-take-photo"');
    expect(html).toContain('data-qa="site-gallery-trigger"');
    expect(html).not.toContain('Add a photo or a clip');
  });

  it('flag on: a Video target joins the bar, photo markers are unchanged, MP4 only', () => {
    const html = render({ video });
    expect(html).toContain('data-qa="capture-video"');
    expect(html).toContain('data-qa="site-take-photo"');
    expect(html).toContain('data-qa="site-gallery-trigger"');
    expect(html).toMatch(/data-qa="capture-video-input"/);
    expect(html).toContain('accept="video/mp4"');
  });

  it('flag on: the empty state offers a photo or a clip', () => {
    expect(render({ video, photos: [] })).toContain('Add a photo or a clip');
    expect(render({ photos: [] })).toContain('Add the first photo');
  });

  it('read-only viewers get no video control even with the flag on', () => {
    expect(render({ video, canCapture: false })).not.toContain('capture-video');
  });
});

describe('SiteCaptureView states', () => {
  it('protects= the empty state is ONE panel and it is a real dropzone', () => {
    const html = render();
    expect(html).toContain('data-qa="progress-empty"');
    expect(html).toContain('Add the first photo');
    expect(html).toContain(
      'B-101 has nothing on file yet. Pick photos here, or tap Take photo to shoot one now.',
    );
    // The three-step line, and NOT the old competing affordances.
    expect(html).toContain('Shoot the unit');
    expect(html).toContain('Add a one-line note');
    expect(html).toContain('The customer sees it today');
    expect(html).not.toContain('No photos yet');
    // The PANEL is a soft surface, not the old dashed drop box: the hero's own
    // classes carry a solid border, and the library dropzone's dashed border and
    // padding are stripped so the two do not double up.
    expect(EMPTY_HERO_CLASS).not.toContain('border-dashed');
    expect(EMPTY_HERO_CLASS).toContain('bg-muted-soft');
    // THE PANEL IS THE FILEUPLOAD DROPZONE, in the same provider as Gallery, so
    // a desktop drop lands in the same handler instead of on a dead surface.
    expect(html).toContain('site-file-dropzone');
    expect(html).toContain('data-qa="site-file-upload"');
    expect(html).toContain('data-qa="site-gallery-trigger"');
  });

  it('loading: skeleton cards shaped like the real card, with the a11y contract', () => {
    const html = render({ isLoading: true });
    expect(html).toContain('data-qa="progress-skeleton"');
    expect(html).toContain('role="status"');
    expect(html).toContain('aria-busy="true"');
    expect(html).toContain('aria-label="Loading photos"');
    // Compact row skeletons, matching the compact photo row.
    expect(html).toContain('h-20');
    // No empty hero while we do not yet know whether there are photos.
    expect(html).not.toContain('data-qa="progress-empty"');
  });

  it('error: an inline alert with the documented copy and a retry', () => {
    const html = render({ isError: true });
    expect(html).toContain('role="alert"');
    expect(html).toContain('Could not load the photos for this unit.');
    expect(html).toContain('data-qa="progress-load-retry"');
  });

  it('preparing: one honest line while the conversion runs', () => {
    const html = render({ isPreparing: true });
    expect(html).toContain('data-qa="site-preparing-photo"');
    expect(html).toContain('Preparing photo...');
  });
});

describe('SiteCaptureView feed', () => {
  const DATA = [
    photo({ id: 'p2', takenAt: '2026-11-08T04:12:00.000Z' }),
    photo({ id: 'p1', takenAt: '2026-11-03T04:00:00.000Z', caption: 'Slab poured' }),
  ];

  it('protects= one card per photo, newest first, with the note as the headline', () => {
    const html = render({
      photos: DATA,
      unit: { ...base.unit, photoCount: 2, lastPhotoAt: DATA[0]!.takenAt },
    });
    expect((html.match(/data-qa="progress-photo-row"/g) ?? []).length).toBe(2);
    expect(html.indexOf('Plinth poured')).toBeLessThan(html.indexOf('Slab poured'));
    const captions = html.match(/<span[^>]*data-qa="progress-caption"[^>]*>/g) ?? [];
    expect(captions).toHaveLength(2);
    for (const tag of captions) {
      // The note is clamped to two lines, never truncated to a fragment.
      expect(tag).toContain('line-clamp-2');
      expect(tag).not.toContain('truncate');
    }
  });

  it('fails_when= a per-row phase chip comes back', () => {
    // The phase is constant per unit and already in the header, so a chip on
    // every row discriminates nothing.
    const html = render({ photos: DATA });
    expect(html).not.toContain('progress-phase-chip');
    expect((html.match(/Phase B/g) ?? []).length).toBeLessThanOrEqual(2);
  });

  it('names the relative time and the uploader on one muted line', () => {
    const html = render({ photos: DATA });
    // The clock reading is local-time; the RELATIVE word is the contract.
    expect(html).toContain('Today, ');
    expect(html).toContain('Ravi Kumar');
    expect(html).toContain('data-qa="progress-date"');
  });

  it('opens each image as the tap target, with the image carrying data-qa', () => {
    const html = render({ photos: DATA });
    expect((html.match(/data-qa="site-photo-open"/g) ?? []).length).toBe(2);
    expect((html.match(/data-qa="progress-photo-thumb"/g) ?? []).length).toBe(2);
    // Plain <img>, never next/image: the optimizer would drop the session.
    expect(html).not.toMatch(/\/_next\/image/);
  });

  it('alt text names the unit and the note', () => {
    const html = render({ photos: [DATA[0]!] });
    expect(html).toContain('alt="Unit B-101, &quot;Plinth poured, curing until Friday&quot;"');
  });

  it('protects= "Load more" obeys the cursor rule', () => {
    expect(render({ photos: DATA, hasMore: true })).toContain('data-qa="progress-load-more"');
    expect(render({ photos: DATA, hasMore: false })).not.toContain('progress-load-more');
  });

  it('shows the one-line summary above the feed only when there are photos', () => {
    expect(render({ photos: DATA })).toContain('data-qa="site-summary-line"');
    expect(render({ photos: DATA })).toContain('2 photos · last added today');
    expect(render({ photos: [] })).not.toContain('data-qa="site-summary-line"');
  });
});

describe('SiteCaptureView upload cards', () => {
  it('protects= an in-flight upload says "Uploading photo..." and invents no percentage', () => {
    const html = render({
      uploading: [{ previewUrl: 'data:image/webp;base64,QQ==', note: 'Slab', status: 'uploading' }],
    });
    expect(html).toContain('data-qa="site-uploading-card"');
    expect(html).toContain('Uploading photo...');
    expect(html).not.toMatch(/\d+%/);
  });

  it('protects= a failed upload says nothing was saved and offers both exits', () => {
    const html = render({
      uploading: [{ previewUrl: 'data:image/webp;base64,QQ==', note: 'Slab', status: 'failed' }],
    });
    expect(html).toContain('That photo did not upload. Nothing was saved.');
    expect(html).toContain('data-qa="site-upload-retry"');
    expect(html).toContain('data-qa="site-upload-discard"');
    // It must not imply the photo is queued for later: there is no queue wired
    // into this app.
    expect(html).not.toMatch(/will (sync|upload|retry) (when|later|automatically)/i);
  });

  it('carries one polite live region and does not move focus', () => {
    const html = render({ announcement: 'Uploading photo...' });
    expect(html).toContain('aria-live="polite"');
    expect(html).toContain('data-qa="site-live-region"');
  });
});

describe('SiteCaptureView note dialog slot', () => {
  it('renders no dialog body when the dialog is closed', () => {
    const html = render();
    expect(html).not.toContain('data-qa="site-note-dialog-body"');
  });
});

/**
 * The dialog's BODY is a separate component: base-ui's Dialog mounts into
 * document.body, so a static-markup render of SiteCaptureView can only ever see
 * the closed state. The body carries every field, every photo tile and every
 * string, so that is what these assertions render.
 */
function attachment(over: Partial<NoteAttachment> & { id: string }): NoteAttachment {
  return {
    previewUrl: 'data:image/webp;base64,QQ==',
    filename: 'site-photo.webp',
    bytes: 240_000,
    status: 'ready',
    ...over,
  };
}

const bodyBase: NoteDialogBodyProps = {
  unitNumber: 'B-101',
  attachments: [attachment({ id: 'a1' })],
  onAddFiles: () => undefined,
  onRemoveAttachment: () => undefined,
  isPreparing: false,
  isSaving: false,
  note: '',
  onNoteChange: () => undefined,
  selectedChips: [],
  onToggleChip: () => undefined,
  stage: null,
  onStageChange: () => undefined,
  isOffline: false,
};

const renderBody = (over: Partial<NoteDialogBodyProps> = {}): string =>
  renderToStaticMarkup(<NoteDialogBody {...bodyBase} {...over} />);

describe('noteSaveLabel', () => {
  it('names the count when more than one photo is still unsent', () => {
    expect(noteSaveLabel(0)).toBe('Save photo');
    expect(noteSaveLabel(1)).toBe('Save photo');
    expect(noteSaveLabel(3)).toBe('Save 3 photos');
  });
});

describe('NOTE_DIALOG_CONTENT_CLASS', () => {
  it('protects= a bottom panel on a phone and the library dialog from sm up', () => {
    const tokens = NOTE_DIALOG_CONTENT_CLASS.split(/\s+/);
    // Thumb reach: flush to the bottom edge, full width, never taller than the
    // viewport minus a strip of context.
    expect(tokens).toEqual(
      expect.arrayContaining(['top-auto', 'bottom-0', 'left-0', 'right-0', 'max-w-none']),
    );
    expect(tokens).toContain('max-h-[92dvh]');
    expect(tokens).toContain('rounded-b-none');
    // Desktop still gets a centred, rounded card.
    expect(tokens).toEqual(
      expect.arrayContaining(['sm:top-1/2', 'sm:left-1/2', 'sm:max-w-lg', 'sm:rounded-xl']),
    );
    // Three fixed rows: header / scrolling body / sticky footer.
    expect(tokens).toContain('grid-rows-[auto_minmax(0,1fr)_auto]');
    expect(tokens).toContain('overflow-hidden');
  });
});

describe('noteDialogHeading', () => {
  it('protects= the single-photo title is the question, with the unit as context', () => {
    const heading = noteDialogHeading(1, 'B-101', 'Phase B');
    expect(heading.title).toBe('What did you shoot?');
    expect(heading.description).toBe('Unit B-101 · Phase B');
  });

  it('titles a batch by its size and says one note covers all of it', () => {
    const heading = noteDialogHeading(6, 'B-101', 'Phase B');
    expect(heading.title).toBe('6 photos · Unit B-101 · Phase B');
    expect(heading.description).toBe('One note and one stage apply to every photo in this set.');
  });

  it('stays an invitation when the note is empty and photos are added in place', () => {
    const heading = noteDialogHeading(0, 'B-101', 'Phase B');
    expect(heading.title).toBe('Add photos');
    expect(heading.description).toBe('Unit B-101 · Phase B');
  });
});

describe('NoteDialogBody', () => {
  it('offers Camera and Gallery INSIDE the dialog, for any number of picks', () => {
    const html = renderBody();
    // Both pickers are real inputs owned by the dialog: adding a photo must not
    // mean closing the note that is being typed.
    const gallery = html.match(/<input[^>]*data-qa="site-note-gallery-input"[^>]*>/)?.[0] ?? '';
    expect(gallery).toContain('multiple');
    expect(gallery).toContain('accept="image/*"');
    const camera = html.match(/<input[^>]*data-qa="site-note-camera-input"[^>]*>/)?.[0] ?? '';
    // `capture=environment` is what stops an iPhone offering the library first.
    expect(camera).toContain('capture="environment"');
    expect(html).toContain('data-qa="site-note-add-camera"');
    expect(html).toContain('data-qa="site-note-add-gallery"');
    expect(html).toContain('aria-label="Take another photo"');
  });

  it('protects= each photo is an Attachment with size, state and its own remove', () => {
    const html = renderBody({
      attachments: [
        attachment({ id: 'a1', filename: 'slab-1.webp', bytes: 240_000 }),
        attachment({ id: 'a2', filename: 'slab-2.webp', status: 'failed' }),
      ],
    });
    expect((html.match(/data-qa="site-note-attachment"/g) ?? []).length).toBe(2);
    expect((html.match(/data-slot="attachment"/g) ?? []).length).toBe(4); // 2 photos + 2 add tiles
    expect(html).toContain('slab-1.webp');
    expect(html).toContain(`${formatBytes(240_000)} · Ready`);
    expect(html).toContain('Not saved');
    // The failure is in WORDS as well as in colour.
    expect(html).toContain('data-status="failed"');
    expect(html).toContain('aria-label="Remove slab-1.webp from this note"');
  });

  it('protects= a saved photo has no remove action and tiles are frozen while saving', () => {
    const saved = renderBody({ attachments: [attachment({ id: 'a1', status: 'saved' })] });
    const savedButton =
      saved.match(/<button[^>]*data-qa="site-note-attachment-remove"[^>]*>/)?.[0] ?? '';
    expect(savedButton).toContain('disabled');

    const saving = renderBody({ isSaving: true });
    const button =
      saving.match(/<button[^>]*data-qa="site-note-attachment-remove"[^>]*>/)?.[0] ?? '';
    expect(button).toContain('disabled');
    // No adding mid-save either: the trigger button itself is disabled, so the
    // picker cannot open behind the save that is already running.
    expect(saving).toContain('aria-disabled="true"');
    for (const testId of ['site-note-add-camera', 'site-note-add-gallery']) {
      const trigger = saving.match(new RegExp(`<button[^>]*data-qa="${testId}"[^>]*>`))?.[0] ?? '';
      expect(trigger).toContain('disabled');
    }
  });

  it('shows the newest photo large, and the empty invitation when there is none', () => {
    const html = renderBody();
    expect(html).toContain('data-qa="site-note-preview"');
    expect(html).toContain('alt="Unit B-101, site-photo.webp"');
    // object-contain, never object-cover: a cropped preview hides the frame.
    expect(html).toContain('object-contain');

    const empty = renderBody({ attachments: [] });
    expect(empty).toContain('data-qa="site-note-empty"');
    expect(empty).toContain('No photos in this note');
  });

  it('protects= the preview yields to the stage picker on a short phone', () => {
    // 667px tall (iPhone SE) is the screen this exists for: the preview is a
    // check, the stage picker is the form, and the form must not be below the
    // fold. Verified in a browser at 375x667: the picker is fully visible.
    expect(PREVIEW_BOX_CLASS).toContain('[@media(max-height:679px)]:hidden');
    expect(EMPTY_BOX_CLASS).toContain('[@media(max-height:679px)]:hidden');
    // It shrinks with the viewport rather than claiming a fixed block...
    expect(PREVIEW_BOX_CLASS).toContain('min(24dvh,200px)');
    // ...and when it is shown, it keeps a tap-sized floor instead of a sliver.
    expect(PREVIEW_BOX_CLASS).toContain('min-h-28');
    expect(EMPTY_BOX_CLASS).toContain('min-h-24');
  });

  it('counts the photos against the per-note cap', () => {
    const html = renderBody({ attachments: [attachment({ id: 'a1' })] });
    expect(html).toContain(`1 of ${MAX_NOTE_PHOTOS}`);
    const full = renderBody({
      attachments: Array.from({ length: MAX_NOTE_PHOTOS }, (_, i) => attachment({ id: `a${i}` })),
    });
    // At the cap the add tiles are inert, not hidden: the affordance must not
    // vanish under the thumb that just used it.
    expect(full).toContain('aria-disabled="true"');
    expect(full).toContain(
      `aria-label="Add photos from the gallery (${MAX_NOTE_PHOTOS} of ${MAX_NOTE_PHOTOS} added)"`,
    );
    for (const testId of ['site-note-add-camera', 'site-note-add-gallery']) {
      const trigger = full.match(new RegExp(`<button[^>]*data-qa="${testId}"[^>]*>`))?.[0] ?? '';
      expect(trigger).toContain('disabled');
    }
  });

  it('carries the labelled customer note field, helper, placeholder and counter', () => {
    const html = renderBody({ note: 'Plinth' });
    // "Note for the Customer": this is the line the buyer reads, not a memo to
    // the team.
    expect(html).toContain('Note for the Customer');
    expect(html).not.toContain('Note for the team');
    expect(html).toContain('This is the line the customer reads in their portal. Keep it short.');
    expect(html).toContain('placeholder="Plinth poured, curing until Friday"');
    expect(html).toContain('data-qa="site-note-counter"');
    expect(html).toContain('6/200');
  });

  it('never autofocuses the note field, so the keyboard cannot cover the photo', () => {
    const html = renderBody();
    const input = html.match(/<textarea[^>]*data-qa="site-note-input"[^>]*>/)?.[0] ?? '';
    expect(input).not.toBe('');
    expect(input).not.toContain('autofocus');
    expect(input.toLowerCase()).toContain('maxlength="200"');
  });

  it('offers all nine construction stages in enum order, with none preselected', () => {
    const html = renderBody();
    expect(html).toContain('data-qa="site-stage-picker"');
    // The options live in base-ui's portal, which static markup cannot see, so
    // the OPTION LIST is asserted where it is defined and the rendered control
    // is asserted where it lands.
    expect(STAGE_PICKER_OPTIONS.map((option) => option.value)).toEqual([
      STAGE_UNSET,
      'NOT_STARTED',
      'FOUNDATION',
      'STRUCTURE',
      'MASONRY',
      'PLASTERING',
      'WATERPROOFING',
      'FLOORING',
      'FINISHING',
      'READY',
    ]);
    // "Stage not set" is a real option, not a placeholder masquerading as one.
    expect(STAGE_PICKER_OPTIONS[0]).toEqual({ value: STAGE_UNSET, label: 'Stage not set' });
    // The trigger shows that unset state and names the field.
    expect(html).toContain('Construction stage');
    expect(html).toContain('Stage not set');
    // No default: an unset stage must stay unset, not become NOT_STARTED.
    const trigger = html.match(/<button[^>]*data-qa="select-trigger"[^>]*>/)?.[0] ?? '';
    expect(trigger).toContain('aria-haspopup="listbox"');
    // The library's own trigger sizing is kept - no min-h override.
    expect(trigger).not.toContain('min-h-11');
    expect(html).not.toContain('Not started');
  });

  it('offers the six quick notes as suggestions under the note field', () => {
    const html = renderBody({ selectedChips: ['Slab', 'Issue'] });
    // Suggestions, not another input: a chip row the engineer taps to append a
    // line. It sits INSIDE the note field's group, below the textarea.
    expect(html).toContain('data-qa="site-note-quick-picker"');
    expect(html).toContain('aria-label="Quick notes"');
    for (const label of QUICK_NOTE_LABELS) {
      expect(html).toContain(`data-qa="site-note-chip-${quickNoteSlug(label)}"`);
    }
    // The suggestion row is after the textarea, not above it.
    expect(html.indexOf('site-note-input')).toBeLessThan(html.indexOf('site-note-quick-picker'));
  });

  it('marks the picked quick notes as pressed, so the state is not colour-only', () => {
    const html = renderBody({ selectedChips: ['Slab'] });
    const slab = html.match(/<button[^>]*data-qa="site-note-chip-slab"[^>]*>/)?.[0] ?? '';
    const issue = html.match(/<button[^>]*data-qa="site-note-chip-issue"[^>]*>/)?.[0] ?? '';
    expect(slab).toContain('aria-pressed="true"');
    expect(issue).toContain('aria-pressed="false"');
  });

  it('shows the preparing line while a picked photo converts', () => {
    const html = renderBody({ isPreparing: true });
    expect(html).toContain('data-qa="site-note-preparing"');
    expect(html).toContain('Preparing photo...');
  });

  it('states the offline truth without promising a queue', () => {
    const html = renderBody({ isOffline: true });
    expect(html).toContain('You&#x27;re offline. Saving needs a connection.');
    expect(html).not.toMatch(/queued|will sync/i);
  });
});
