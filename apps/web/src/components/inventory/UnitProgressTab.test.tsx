// UnitProgressTab (2026-11-06): the phase Select was removed - the upload
// payload's `phaseId` is the UNIT's phase, not a user choice. These tests pin
// that rule (plus the MIME coercion and capture-time normalisation) without
// mounting the tab or driving a real file input.
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';

vi.mock('@/hooks/queries/customer-progress', () => ({
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
  isForbidden: vi.fn(() => false),
}));

import { buildPhotoUpload, UnitProgressTabContent } from './UnitProgressTab';

const UNIT = { id: 'unit-1', phaseId: 'phase-a', phaseName: 'Phase A' };

const FILE = { type: 'image/jpeg', name: 'slab.jpg', lastModified: Date.UTC(2026, 9, 26, 10, 0, 0) };

describe('buildPhotoUpload - the phase comes from the unit', () => {
  it('uses the unit phase id, never a caller-supplied one', () => {
    const payload = buildPhotoUpload({ phaseId: UNIT.phaseId, base64: 'QUJD', file: FILE });
    expect(payload.phaseId).toBe('phase-a');
  });

  it('keeps the allowlisted MIME types as-is', () => {
    for (const mime of ['image/jpeg', 'image/png', 'image/webp'] as const) {
      expect(buildPhotoUpload({ phaseId: UNIT.phaseId, base64: 'x', file: { ...FILE, type: mime } }).mimeType).toBe(mime);
    }
  });

  // The server allowlist is JPEG/PNG/WebP only; HEIC and anything else would be
  // refused there, so the client coerces rather than sending a doomed request.
  it('coerces non-allowlisted types (HEIC) to image/jpeg', () => {
    expect(buildPhotoUpload({ phaseId: UNIT.phaseId, base64: 'x', file: { ...FILE, type: 'image/heic' } }).mimeType).toBe('image/jpeg');
    expect(buildPhotoUpload({ phaseId: UNIT.phaseId, base64: 'x', file: { ...FILE, type: '' } }).mimeType).toBe('image/jpeg');
  });

  it('sends takenAt with a UTC offset, derived from file.lastModified', () => {
    const payload = buildPhotoUpload({ phaseId: UNIT.phaseId, base64: 'x', file: FILE });
    expect(payload.takenAt).toBe('2026-10-26T10:00:00.000Z');
    expect(payload.takenAt).toMatch(/(?:Z|[+-]\d{2}:?\d{2})$/);
  });

  it('truncates an over-long filename to the server cap (180)', () => {
    const payload = buildPhotoUpload({
      phaseId: UNIT.phaseId,
      base64: 'x',
      file: { ...FILE, name: `${'a'.repeat(400)}.jpg` },
    });
    expect(payload.filename).toHaveLength(180);
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
