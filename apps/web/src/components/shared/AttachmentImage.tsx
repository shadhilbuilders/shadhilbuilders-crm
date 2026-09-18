'use client';

// AttachmentImage - renders a chat attachment, degrading to nothing when the
// bytes can't be loaded (the parent renders a labelled link fallback).
//
// TWO KINDS OF src, handled differently (Option A - owner decision 2026-09-18):
//
//   1. ABSOLUTE (https://ik.imagekit.io/...): a public CDN image. Rendered with
//      next/image so Next optimises + caches it - that is the point of serving
//      images directly instead of through the BFF. The host must be listed in
//      next.config.ts -> images.remotePatterns.
//
//   2. SAME-ORIGIN BFF (/api/bff/media/...): an AUTHENTICATED document read.
//      Rendered with a plain <img>. next/image would rewrite this to
//      /_next/image?url=..., and that optimiser request does NOT carry the
//      session cookie for a same-origin relative URL - it answers 400 "The
//      requested resource isn't a valid image." (verified in a real browser:
//      every attachment rendered naturalWidth 0 and fell back). So documents
//      stay on the proxy and out of the optimiser.
//
// The error listener is attached via a REF rather than a JSX onError: the
// error-level `jsx-a11y/no-noninteractive-element-interactions` rule treats a
// handler on <img> as a non-interactive interaction. That rule is a false
// positive for resource-lifecycle events, but suppressing it would also hide
// the real <div onClick> cases it exists to catch. A ref sidesteps it honestly
// instead of muting it, and keeps the fallback in React state (no imperative
// innerHTML/style patching).
//
// The failure case is real: a stored media key can outlive its bytes when
// MEDIA_STORAGE is switched, leaving a row pointing at a key the current
// backend can't read.
import Image from 'next/image';
import { useEffect, useRef, useState } from 'react';

/** Intrinsic size hint for the optimiser; CSS (max-h-56 w-auto) governs layout. */
const INTRINSIC_WIDTH = 480;
const INTRINSIC_HEIGHT = 320;

export function AttachmentImage({
  src,
  alt,
  className,
  onFailed,
}: {
  src: string;
  alt: string;
  className?: string;
  /** Called once when the image fails to load. */
  onFailed?: () => void;
}) {
  const ref = useRef<HTMLImageElement | null>(null);
  const [failed, setFailed] = useState(false);

  const isAbsolute = /^https?:\/\//i.test(src);

  useEffect(() => {
    const el = ref.current;
    if (el === null) return;

    const handleError = (): void => {
      setFailed(true);
      onFailed?.();
    };

    // An image that already failed before this effect ran (e.g. served from
    // cache) emits no further 'error' event, so check the settled state too:
    // `complete` with naturalWidth 0 means the fetch finished without pixels.
    if (el.complete && el.naturalWidth === 0) {
      handleError();
      return;
    }

    el.addEventListener('error', handleError);
    return () => el.removeEventListener('error', handleError);
  }, [src, onFailed]);

  if (failed) return null;

  // 1. Public CDN image - let Next optimise it.
  if (isAbsolute) {
    return (
      <Image
        ref={ref}
        src={src}
        alt={alt}
        width={INTRINSIC_WIDTH}
        height={INTRINSIC_HEIGHT}
        className={className}
        data-qa="chat-media-image"
      />
    );
  }

  // 2. Authenticated BFF read - plain <img> so the session cookie is sent.
  return <img ref={ref} src={src} alt={alt} className={className} data-qa="chat-media-image" />;
}
