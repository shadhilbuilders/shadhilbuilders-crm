// UnitProgressTab (2026-11-06, revised 2026-11-08).
//
// protects= the upload payload's `phaseId` is the UNIT's phase (not a user
//           choice), the mimeType/filename come from the PREPARED bytes rather
//           than the browser's guess from the filename, a typed note is trimmed
//           onto the payload, an empty note is omitted so the server keeps its
//           generated caption, an unset stage is omitted, and the four timeline
//           states still render;
// fails_when= the phase becomes caller-supplied again, a HEIC file keeps its
//           declared type, a whitespace note becomes `caption: ''`, or a state
//           silently disappears;
// no_claim= no real file input, no real encoder: `prepareProgressPhoto` output
//           is passed in directly (its own test owns the conversion).
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';

// The tab now converts before uploading, and the conversion is Web/CANVAS only.
// It is mocked here so these tests stay about the payload shape.
vi.mock('@/lib/photo-prep', async (importOriginal) => {
  const actual = await importOriginal<Record<string, unknown>>();
  return {
    ...actual,
    prepareProgressPhoto: vi.fn(async (file: File) => ({
      base64: 'QUJD',
      mimeType: 'image/webp',
      filename: `${file.name.replace(/\.[^.]+$/, '')}.webp`,
      takenAt: new Date(file.lastModified).toISOString(),
      source: 'camera',
      byteLength: 3,
      width: 1600,
      height: 1200,
    })),
  };
});

vi.mock('@/hooks/queries/customer-progress', () => {
  const hooks = {
    useUnitPhotos: vi.fn(() => ({
      data: { pages: [{ photos: [], nextCursor: null }] },
      isLoading: false,
      isError: false,
      error: null,
      refetch: vi.fn(),
      fetchNextPage: vi.fn(),
      isFetching: false,
    })),
    useUploadUnitPhoto: vi.fn(() => ({
      mutate: vi.fn(),
      isPending: false,
      isError: false,
      error: null,
      reset: vi.fn(),
    })),
    // Slice 4: the row actions are rendered by UnitProgressTab, so the module
    // must expose them or the tab throws at import time.
    useUpdatePhoto: vi.fn(() => ({ mutate: vi.fn(), isPending: false })),
    useDeletePhoto: vi.fn(() => ({ mutate: vi.fn(), isPending: false })),
    isForbidden: vi.fn(() => false),
  };
  // Exposed so individual cases can drive a state; the hook factory above is
  // the default every other test in this file relies on.
  (globalThis as { __customerProgressHooks?: unknown }).__customerProgressHooks = hooks;
  return hooks;
});

const customerProgressHooks = (globalThis as { __customerProgressHooks?: unknown })
  .__customerProgressHooks as {
  useUnitPhotos: ReturnType<typeof vi.fn>;
  useUploadUnitPhoto: ReturnType<typeof vi.fn>;
  isForbidden: ReturnType<typeof vi.fn>;
};

import { buildPhotoUpload, UnitProgressTabContent } from './UnitProgressTab';

const UNIT = { id: 'unit-1', phaseId: 'phase-a', phaseName: 'Phase A' };

/** The shape `prepareProgressPhoto` returns: the bytes that will upload. */
const PREPARED = {
  base64: 'QUJD',
  mimeType: 'image/webp' as const,
  filename: 'slab.webp',
  takenAt: '2026-10-26T10:00:00.000Z',
  source: 'camera' as const,
};

describe('buildPhotoUpload - the phase comes from the unit', () => {
  it('uses the unit phase id, never a caller-supplied one', () => {
    const payload = buildPhotoUpload({ phaseId: UNIT.phaseId, prepared: PREPARED });
    expect(payload.phaseId).toBe('phase-a');
  });

  it('takes the MIME type from the PREPARED bytes, not a declared type', () => {
    // The old build coerced the browser's declaration to image/jpeg. That was a
    // lie the server's byte-sniffer then had to correct by rejecting the upload.
    for (const mimeType of ['image/jpeg', 'image/png', 'image/webp'] as const) {
      expect(
        buildPhotoUpload({ phaseId: UNIT.phaseId, prepared: { ...PREPARED, mimeType } }).mimeType,
      ).toBe(mimeType);
    }
  });

  it('keeps the prepared filename, which already matches the bytes', () => {
    expect(
      buildPhotoUpload({
        phaseId: UNIT.phaseId,
        prepared: { ...PREPARED, filename: 'IMG_2676.webp' },
      }).filename,
    ).toBe('IMG_2676.webp');
  });

  it('sends takenAt with a UTC offset', () => {
    const payload = buildPhotoUpload({ phaseId: UNIT.phaseId, prepared: PREPARED });
    expect(payload.takenAt).toBe('2026-10-26T10:00:00.000Z');
    expect(payload.takenAt).toMatch(/(?:Z|[+-]\d{2}:?\d{2})$/);
  });

  it('carries the device hint from the entry point', () => {
    expect(
      buildPhotoUpload({ phaseId: UNIT.phaseId, prepared: { ...PREPARED, source: 'gallery' } })
        .clientDeviceHint,
    ).toBe('gallery');
  });

  it('truncates an over-long filename to the server cap (180)', () => {
    const payload = buildPhotoUpload({
      phaseId: UNIT.phaseId,
      prepared: { ...PREPARED, filename: `${'a'.repeat(400)}.webp` },
    });
    expect(payload.filename).toHaveLength(180);
  });
});

describe('buildPhotoUpload - the note and the stage travel with the photo', () => {
  it('protects= a supplied note lands in the payload, trimmed', () => {
    const payload = buildPhotoUpload({
      phaseId: UNIT.phaseId,
      prepared: PREPARED,
      caption: '  Plinth poured, curing until Friday  ',
    });
    expect(payload.caption).toBe('Plinth poured, curing until Friday');
  });

  it('fails_when= an empty or whitespace note becomes a caption key', () => {
    // The server rejects an empty caption; omitting the key is what lets it fall
    // back to buildCaption(...) instead of 400ing on "no note".
    const none = buildPhotoUpload({ phaseId: UNIT.phaseId, prepared: PREPARED });
    expect('caption' in none).toBe(false);
    const blank = buildPhotoUpload({ phaseId: UNIT.phaseId, prepared: PREPARED, caption: '   ' });
    expect('caption' in blank).toBe(false);
    expect(blank.caption).toBeUndefined();
  });

  it('carries a stage when one was chosen', () => {
    const payload = buildPhotoUpload({
      phaseId: UNIT.phaseId,
      prepared: PREPARED,
      stage: 'STRUCTURE',
    });
    expect(payload.stage).toBe('STRUCTURE');
  });

  it('omits the stage key entirely when none was chosen', () => {
    // Never default to NOT_STARTED: that is a guess dressed as data.
    const payload = buildPhotoUpload({ phaseId: UNIT.phaseId, prepared: PREPARED });
    expect('stage' in payload).toBe(false);
  });
});

describe('UnitProgressTabContent - upload CTA', () => {
  it('no longer renders a phase Select', () => {
    const html = renderToStaticMarkup(<UnitProgressTabContent unit={UNIT} />);
    expect(html).not.toContain('data-qa="progress-phase-select"');
    expect(html).not.toContain('Phase for this photo');
  });

  it('names the unit phase the photo will be labelled with', () => {
    const html = renderToStaticMarkup(<UnitProgressTabContent unit={UNIT} />);
    expect(html).toContain('data-qa="progress-phase-hint"');
    expect(html).toContain('Phase A');
  });

  // The old button was disabled with no phase picked; that dead end is gone
  // because the phase is never missing (Unit.phaseId is non-nullable).
  it('keeps the upload button enabled - there is no phase left to pick', () => {
    const html = renderToStaticMarkup(<UnitProgressTabContent unit={UNIT} />);
    const button = html.match(/<button[^>]*data-qa="add-progress-photo"[^>]*>/)?.[0] ?? '';
    expect(button).not.toBe('');
    // React emits a boolean attribute as `disabled=""`; Tailwind's
    // `disabled:` utility classes also contain the word, so anchor on the
    // attribute form rather than the substring.
    expect(button).not.toContain('disabled=""');
  });
});

// ────────────────────────────────────────────────────────────────────────────
// Timeline states (slice-1 AC6: "empty state before first photo, error banner
// on failure, pagination after 50 photos - mirroring the adopted state table").
//
// The states were implemented but UNTESTED, so a refactor could have removed
// one silently. These pin all four plus the cursor rule, with the query hook
// stubbed per case.
// ────────────────────────────────────────────────────────────────────────────

type PhotoPage = {
  photos: Array<{
    id: string;
    unitId: string;
    phaseId: string | null;
    phaseName: string | null;
    mimeType: string;
    filename: string;
    caption: string;
    takenAt: string;
    stage: string | null;
    createdAt: string;
    creatorName: string | null;
    creatorIsPhotoLead: boolean | null;
    mediaUrl: string;
  }>;
  nextCursor: string | null;
};

const photo = (id: string): PhotoPage['photos'][number] => ({
  id,
  unitId: 'unit-1',
  phaseId: 'phase-a',
  phaseName: 'Phase A',
  mimeType: 'image/jpeg',
  filename: `${id}.jpg`,
  caption: `Phase A November 2026 ${id}`,
  takenAt: '2026-11-03T08:00:00.000Z',
  createdAt: '2026-11-03T08:00:00.000Z',
  creatorName: 'Ravi',
  creatorIsPhotoLead: false,
  stage: null,
  mediaUrl: `/api/bff/media/${id}`,
});

/** Render the tab with a specific photosQuery shape. */
function renderWith(query: Record<string, unknown>): string {
  const hooks = customerProgressHooks as unknown as {
    useUnitPhotos: ReturnType<typeof vi.fn>;
    isForbidden: ReturnType<typeof vi.fn>;
  };
  hooks.useUnitPhotos.mockReturnValueOnce({
    data: undefined,
    isLoading: false,
    isError: false,
    error: null,
    refetch: vi.fn(),
    fetchNextPage: vi.fn(),
    isFetching: false,
    ...query,
  });
  return renderToStaticMarkup(<UnitProgressTabContent unit={UNIT} />);
}

describe('UnitProgressTabContent - timeline states (AC6)', () => {
  it('loading: skeleton rows, no timeline list', () => {
    const html = renderWith({ isLoading: true });
    expect(html).toContain('data-qa="progress-skeleton"');
    expect(html).not.toContain('data-qa="progress-timeline"');
  });

  // AC6 exact: "empty state before first photo".
  it('empty: warm first-photo copy and the CTA says "Add first photo"', () => {
    const html = renderWith({ data: { pages: [{ photos: [], nextCursor: null }] } });
    expect(html).toContain('data-qa="progress-empty"');
    expect(html).toContain('No photos yet');
    expect(html).toContain('Add first photo');
  });

  // AC6 exact: "error banner on failure" - with a retry control.
  it('error: inline banner with a retry control', () => {
    const html = renderWith({ data: undefined, isError: true, error: new Error('boom') });
    expect(html).toContain('data-qa="progress-load-error"');
    expect(html).toContain('role="alert"');
    expect(html).toContain('data-qa="progress-load-retry"');
    expect(html).not.toContain('data-qa="progress-timeline"');
  });

  it('data: ordered list with one row per photo, phase chip, uploader label', () => {
    const html = renderWith({
      data: { pages: [{ photos: [photo('p3'), photo('p2')], nextCursor: null }] },
    });
    expect(html.match(/data-qa="progress-photo-row"/g)).toHaveLength(2);
    expect(html).toContain('<ol');
    expect(html).toContain('data-qa="progress-phase-chip"');
    // siteMemberLabel: not a photo lead -> "Site Engineer"
    expect(html).toContain('Site Engineer');
  });

  // AC6 exact: "pagination after 50 photos (cursor)".
  it('hasMore: "Load more" renders only when the last page carries a cursor', () => {
    const withCursor = renderWith({
      data: { pages: [{ photos: [photo('p1')], nextCursor: 'cursor-1' }] },
    });
    expect(withCursor).toContain('data-qa="progress-load-more"');

    const noCursor = renderWith({
      data: { pages: [{ photos: [photo('p1')], nextCursor: null }] },
    });
    expect(noCursor).not.toContain('data-qa="progress-load-more"');
  });

  it('hasMore follows the LAST page, not the first', () => {
    const html = renderWith({
      data: {
        pages: [
          { photos: [photo('p2')], nextCursor: 'cursor-1' },
          { photos: [photo('p1')], nextCursor: null },
        ],
      },
    });
    // Page 2 has no cursor left, so the exhausted end hides "Load more" even
    // though page 1 still carried one.
    expect(html).not.toContain('data-qa="progress-load-more"');
    expect(html.match(/data-qa="progress-photo-row"/g)).toHaveLength(2);
  });

  it('fails_when= a 403 renders an empty timeline instead of hiding the tab', () => {
    const hooks = customerProgressHooks as unknown as { isForbidden: ReturnType<typeof vi.fn> };
    hooks.isForbidden.mockReturnValueOnce(true);
    const html = renderWith({ data: undefined, isError: true, error: new Error('forbidden') });
    // The tab renders NOTHING for a non-member - not an error banner that
    // leaks that a timeline exists.
    expect(html).toBe('');
  });
});
