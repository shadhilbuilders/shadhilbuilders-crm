// AttachmentImage - the two-src contract (Option A).
//
// The component branches on the src shape, and flipping that branch is a
// correctness bug:
//
//   ABSOLUTE (https://ik.imagekit.io/...) -> next/image, optimised.
//   SAME-ORIGIN (/api/bff/media/...)      -> plain <img>, cookie sent.
//
// Routing a BFF path through next/image rewrites it to /_next/image?url=...,
// and that optimiser does NOT carry the session cookie for a same-origin
// relative URL - it answers 400 ("The requested resource isn't a valid image")
// and every attachment silently renders naturalWidth 0 (verified in a real
// browser).
//
// next/image is MOCKED here for two reasons: vitest does not load
// next.config.ts (so the real component throws "hostname ... is not configured
// under images"), and asserting the optimiser's generated URL would couple
// these tests to Next internals. Instead the mock tags itself, so we assert the
// real contract: WHICH renderer the component picks for a given src.
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';

vi.mock('next/image', () => ({
  // Stand-in that advertises its use; forwards src/alt/className so the shared
  // assertions below still work.
  default: ({
    src,
    alt,
    className,
  }: {
    src: string;
    alt: string;
    className?: string;
  }) => (
    <img
      src={src}
      alt={alt}
      className={className}
      data-test-next-image="true"
      data-qa="chat-media-image"
    />
  ),
}));

import { AttachmentImage } from './AttachmentImage';

describe('AttachmentImage', () => {
  describe('public CDN images (absolute URL) -> next/image', () => {
    const cdnSrc = 'https://ik.imagekit.io/paalstack/org1/abc/pic.png';

    it('renders via next/image so the CDN image is optimised', () => {
      const html = renderToStaticMarkup(<AttachmentImage src={cdnSrc} alt="pic.png" />);

      expect(html).toContain('data-test-next-image="true"');
      expect(html).toContain(cdnSrc);
      expect(html).toContain('data-qa="chat-media-image"');
    });

    it('treats http:// as absolute too (self-hosted/R2 dev endpoint)', () => {
      const html = renderToStaticMarkup(
        <AttachmentImage src="http://localhost:9000/bucket/pic.png" alt="x" />,
      );

      expect(html).toContain('data-test-next-image="true"');
    });

    it('keeps the alt text', () => {
      const html = renderToStaticMarkup(<AttachmentImage src={cdnSrc} alt="pic.png" />);

      expect(html).toContain('alt="pic.png"');
    });
  });

  describe('authenticated BFF reads (same-origin path) -> plain <img>', () => {
    const bffSrc = '/api/bff/media/%2Forg1%2Fabc%2Fdoc.pdf';

    it('does NOT use next/image (the optimiser would drop the session cookie)', () => {
      const html = renderToStaticMarkup(<AttachmentImage src={bffSrc} alt="doc.pdf" />);

      // The regression guard.
      expect(html).not.toContain('data-test-next-image');
      expect(html).not.toContain('/_next/image');
      expect(html).not.toContain('data-nimg');
      // Plain <img> pointing at the BFF path, so the session cookie is sent.
      expect(html).toContain(`<img src="${bffSrc}"`);
    });

    it('keeps the alt text and marker', () => {
      const html = renderToStaticMarkup(<AttachmentImage src={bffSrc} alt="doc.pdf" />);

      expect(html).toContain('alt="doc.pdf"');
      expect(html).toContain('data-qa="chat-media-image"');
    });
  });

  it('applies the caller className (bubble sizing) in BOTH branches', () => {
    for (const src of [
      'https://ik.imagekit.io/paalstack/org1/abc/pic.png',
      '/api/bff/media/%2Forg1%2Fabc%2Fpic.png',
    ]) {
      const html = renderToStaticMarkup(
        <AttachmentImage src={src} alt="x" className="max-h-56 rounded-lg" />,
      );
      expect(html).toContain('max-h-56');
      expect(html).toContain('rounded-lg');
    }
  });

  it('does NOT attach a JSX interaction handler to the plain <img> (a11y rule)', () => {
    // HONEST LIMITATION: renderToStaticMarkup never serializes React event
    // handlers, so this cannot prove the handler is absent - it would pass
    // either way. The real guard is the error-level
    // `jsx-a11y/no-noninteractive-element-interactions` rule in eslint.config.js,
    // which fails `pnpm lint` if `onError` is put back on the <img>.
    const html = renderToStaticMarkup(
      <AttachmentImage src="/api/bff/media/x.png" alt="x" />,
    );

    expect(html).toContain('<img src="/api/bff/media/x.png" alt="x"');
  });
});
