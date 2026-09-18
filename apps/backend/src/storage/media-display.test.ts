// media-display.ts - the Option A policy (images direct, docs proxy) and the
// provider seam that makes an ImageKit -> R2 swap a one-adapter change.
import { describe, expect, it } from 'vitest';

import {
  bffMediaPath,
  isPubliclyServableImage,
  resolveMediaDisplayUrl,
} from './media-display';

describe('resolveMediaDisplayUrl - Option A policy', () => {
  const IK = 'https://ik.imagekit.io/paalstack';
  const key = '/org1/abc/pic.png';

  it('serves an IMAGE directly from the provider CDN', () => {
    const out = resolveMediaDisplayUrl({
      mediaKey: key,
      mediaType: 'image/png',
      directUrl: `${IK}${key}`,
    });

    expect(out).toEqual({ url: `${IK}${key}`, kind: 'direct' });
  });

  it('serves a PDF via the authenticated BFF path, NOT the public CDN', () => {
    // The whole point of Option A: documents must not become public URLs.
    const out = resolveMediaDisplayUrl({
      mediaKey: '/org1/abc/contract.pdf',
      mediaType: 'application/pdf',
      directUrl: `${IK}/org1/abc/contract.pdf`,
    });

    expect(out?.kind).toBe('proxied');
    expect(out?.url).toBe(bffMediaPath('/org1/abc/contract.pdf'));
    expect(out?.url.startsWith('/api/bff/media/')).toBe(true);
    // Must not leak the CDN URL.
    expect(out?.url).not.toContain('imagekit.io');
  });

  it('proxies non-image types (text, video, audio, unknown)', () => {
    for (const mediaType of ['text/plain', 'video/mp4', 'audio/mpeg', null, undefined]) {
      const out = resolveMediaDisplayUrl({
        mediaKey: key,
        mediaType,
        directUrl: `${IK}${key}`,
      });
      expect(out?.kind).toBe('proxied');
    }
  });

  it('falls back to the BFF when the provider has no public URL (LocalDisk)', () => {
    // LocalDiskStorage.publicUrl() returns null - so even images stay proxied
    // in a local-disk dev environment. Proves the policy degrades correctly.
    const out = resolveMediaDisplayUrl({
      mediaKey: 'org1/abc/pic.png',
      mediaType: 'image/png',
      directUrl: null,
    });

    expect(out).toEqual({ url: bffMediaPath('org1/abc/pic.png'), kind: 'proxied' });
  });

  it('percent-encodes the whole key (it contains slashes) in the BFF path', () => {
    const out = resolveMediaDisplayUrl({ mediaKey: '/a/b/c.png', mediaType: 'application/pdf' });

    expect(out?.url).toBe('/api/bff/media/%2Fa%2Fb%2Fc.png');
  });

  it('resolves legacy rows (storedUrl only, no key) unchanged', () => {
    // Pre-existing rows hold a BFF path and no mediaKey - they must keep
    // working with no backfill.
    const legacy = '/api/bff/media/%2Fceid01%2Fabc%2Fpic.png';
    const out = resolveMediaDisplayUrl({ storedUrl: legacy });

    expect(out).toEqual({ url: legacy, kind: 'proxied' });
  });

  it('treats a stored ABSOLUTE url as direct (legacy public URL)', () => {
    const out = resolveMediaDisplayUrl({ storedUrl: 'https://cdn.example.com/x.png' });

    expect(out).toEqual({ url: 'https://cdn.example.com/x.png', kind: 'direct' });
  });

  it('PREFERS the key over a stale storedUrl', () => {
    // After the switch a row could carry both; the key is canonical, so a
    // stale BFF path must not win.
    const out = resolveMediaDisplayUrl({
      mediaKey: key,
      mediaType: 'image/png',
      directUrl: `${IK}${key}`,
      storedUrl: '/api/bff/media/%2Fstale.png',
    });

    expect(out).toEqual({ url: `${IK}${key}`, kind: 'direct' });
  });

  it('returns null when there is nothing to render', () => {
    expect(resolveMediaDisplayUrl({})).toBeNull();
    expect(resolveMediaDisplayUrl({ mediaKey: '', mediaType: 'image/png' })).toBeNull();
    expect(resolveMediaDisplayUrl({ storedUrl: '' })).toBeNull();
  });
});

describe('isPubliclyServableImage', () => {
  it('is true only for image/* mime types', () => {
    expect(isPubliclyServableImage('image/png')).toBe(true);
    expect(isPubliclyServableImage('image/jpeg')).toBe(true);
    expect(isPubliclyServableImage('application/pdf')).toBe(false);
    expect(isPubliclyServableImage('text/plain')).toBe(false);
    expect(isPubliclyServableImage(null)).toBe(false);
    expect(isPubliclyServableImage(undefined)).toBe(false);
    expect(isPubliclyServableImage('')).toBe(false);
  });
});
