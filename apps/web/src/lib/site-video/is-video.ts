// One definition of "this timeline row is a playable video", so the tile, the
// lightbox and the portal agree. A VIDEO row whose clip URL is missing (archived,
// or purged by retention) is NOT playable and renders as its poster only.
interface MaybeVideo {
  kind?: 'PHOTO' | 'VIDEO';
  videoUrl?: string | null;
}

export function isPlayableVideo(row: MaybeVideo): row is MaybeVideo & { videoUrl: string } {
  return row.kind === 'VIDEO' && typeof row.videoUrl === 'string' && row.videoUrl.length > 0;
}
