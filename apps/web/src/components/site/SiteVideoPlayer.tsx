'use client';

// The lightbox's video state (plan section 7): created when the lightbox opens on
// a video, torn down when it closes (the parent keys it on the row id), no
// autoplay, and nothing downloaded until the user presses play (`preload="none"`;
// the poster is what shows). If the browser cannot decode the clip it says so in
// one sentence and offers the file, never a black box.
import { useState } from 'react';

import { LuDownload } from '@paalstack/react-icons/lu';

import { videoTileName } from '@/lib/site-video/format';

export interface SiteVideoPlayerProps {
  src: string;
  poster: string;
  durationMs: number | null | undefined;
  filename: string;
}

export function SiteVideoPlayer({ src, poster, durationMs, filename }: SiteVideoPlayerProps) {
  const [failed, setFailed] = useState(false);

  if (failed) {
    return (
      <div
        className="flex flex-1 flex-col items-center justify-center gap-3 p-6 text-center"
        data-qa="video-unplayable"
      >
        <p className="text-sm">This video can&apos;t play in your browser.</p>
        <a
          href={src}
          download={filename}
          className="text-primary focus-visible:ring-ring inline-flex min-h-11 items-center gap-2 rounded-md px-3 text-sm underline focus-visible:ring-2"
          data-qa="video-download"
        >
          <LuDownload aria-hidden="true" /> Download the clip
        </a>
      </div>
    );
  }

  return (
    <div
      className="flex min-h-0 flex-1 items-center justify-center bg-black"
      data-qa="video-player-frame"
    >
      <video
        src={src}
        poster={poster}
        controls
        playsInline
        preload="none"
        aria-label={videoTileName(durationMs)}
        onError={() => setFailed(true)}
        className="max-h-full max-w-full"
        data-qa="video-player"
      />
    </div>
  );
}
