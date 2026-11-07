// Portal date + alt-text formatting (issue #8 slice 2). Pinned to
// Asia/Kolkata: the buyers are local, and a fixed zone keeps month headings
// stable between server render, client render and tests.
const TZ = 'Asia/Kolkata';

export function formatDay(iso: string): string {
  return new Date(iso).toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric', timeZone: TZ });
}

export function formatMonth(iso: string): string {
  return new Date(iso).toLocaleDateString('en-GB', { month: 'long', year: 'numeric', timeZone: TZ });
}

/** Alt text: the caption when there is one, else a plain description. */
export function photoAlt(photo: { caption: string; phaseName: string | null; takenAt: string }): string {
  const caption = photo.caption.trim();
  if (caption.length > 0) return caption;
  return `Construction photo, ${photo.phaseName ?? 'site'}, ${formatDay(photo.takenAt)}`;
}

/** Group an already newest-first list into consecutive month sections. */
export function groupByMonth<T extends { takenAt: string }>(
  photos: readonly T[],
): Array<{ key: string; label: string; photos: T[] }> {
  const groups: Array<{ key: string; label: string; photos: T[] }> = [];
  for (const photo of photos) {
    const label = formatMonth(photo.takenAt);
    const last = groups[groups.length - 1];
    if (last !== undefined && last.label === label) {
      last.photos.push(photo);
    } else {
      groups.push({ key: `${label}-${photo.takenAt}`, label, photos: [photo] });
    }
  }
  return groups;
}
