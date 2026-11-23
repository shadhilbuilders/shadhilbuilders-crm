// The site-update deep link (build-sequence step 8, gap 6).
//
// protects= the message link points at the WEB app, lands on the buyer's record
// with the right unit and row, and never carries a value that could smuggle a
// second query parameter.
// fails_when= the origin resolution falls back to the API host, a link is built
// without encoding, or an unconfigured deployment emits a relative link.
import { describe, expect, it } from 'vitest';

import { buildSiteUpdateLink, resolveAppOrigin, siteUpdateMessage } from './site-update-link';

describe('resolveAppOrigin', () => {
  it('prefers APP_URL, then NEXT_PUBLIC_APP_URL', () => {
    expect(
      resolveAppOrigin({ APP_URL: 'https://a.example', NEXT_PUBLIC_APP_URL: 'https://b' }),
    ).toBe('https://a.example');
    expect(resolveAppOrigin({ NEXT_PUBLIC_APP_URL: 'https://b.example' })).toBe(
      'https://b.example',
    );
  });

  it('falls back to the first CORS origin', () => {
    expect(resolveAppOrigin({ CORS_ORIGINS: 'https://web.example,https://other' })).toBe(
      'https://web.example',
    );
  });

  it('refuses BETTER_AUTH_URL when it points at the API, and throws when nothing does', () => {
    // This is the exact misconfiguration that once produced dead invite links.
    expect(() =>
      resolveAppOrigin({ BETTER_AUTH_URL: 'http://localhost:8080', API_PORT: '8080' }),
    ).toThrow(/APP_URL/);
    expect(() => resolveAppOrigin({})).toThrow(/APP_URL/);
  });
});

describe('buildSiteUpdateLink', () => {
  it('points at the portal, at this unit and this row', () => {
    expect(buildSiteUpdateLink('https://crm.example.com', 'unit-1', 'row-1')).toBe(
      'https://crm.example.com/portal?unit=unit-1&photo=row-1',
    );
  });

  it('does not double the slash on an origin that has one', () => {
    expect(buildSiteUpdateLink('https://crm.example.com/', 'u', 'r')).toBe(
      'https://crm.example.com/portal?unit=u&photo=r',
    );
  });

  it('encodes ids, so one can never smuggle another parameter', () => {
    const url = buildSiteUpdateLink('https://crm.example.com', 'u&admin=1', 'r#x');
    expect(url).not.toContain('&admin=1');
    const parsed = new URL(url);
    expect(parsed.searchParams.get('unit')).toBe('u&admin=1');
    expect(parsed.searchParams.get('admin')).toBeNull();
  });
});

describe('siteUpdateMessage', () => {
  it('states the update then the link', () => {
    expect(
      siteUpdateMessage({
        unitNumber: 'A-101',
        stage: 'STRUCTURE',
        takenAt: '2026-11-23T10:00:00.000Z',
        link: 'https://x/portal?unit=u&photo=r',
      }),
    ).toBe('Site update for A-101 · STRUCTURE · 2026-11-23\nhttps://x/portal?unit=u&photo=r');
  });
});
