import { LuPlay } from '@paalstack/react-icons/lu';

import { formatClock } from '@/lib/site-video/format';

/**
 * Play cue laid over a video's poster tile. Decorative: the tile's own label
 * (see `videoTileName`) carries the meaning for assistive tech. Shared by the
 * staff feed and the buyer portal so a clip looks the same on both.
 */
export function VideoBadge({ durationMs }: { durationMs: number | null | undefined }) {
  return (
    <span
      aria-hidden="true"
      className="from-background/70 pointer-events-none absolute inset-0 flex flex-col items-center justify-end bg-gradient-to-t to-transparent p-1"
      data-qa="video-tile-badge"
    >
      <LuPlay className="text-foreground my-auto size-6" />
      {durationMs !== null && durationMs !== undefined ? (
        <span className="bg-background/80 text-foreground rounded px-1 text-[11px] font-medium tabular-nums">
          {formatClock(durationMs)}
        </span>
      ) : null}
    </span>
  );
}
