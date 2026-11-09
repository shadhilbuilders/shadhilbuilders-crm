'use client';

// PortalPhaseGroup: one construction phase of the photo record, rendered as a
// ledger block rather than a card grid.
//
// REDESIGN (2026-11-09, second pass). The old version was a 3-up grid of
// double-bezel cards - the same shape as the hero, the lock card and the
// skeleton, which is why the page had no hierarchy. A photo record is a list of
// dated entries, so it now reads like one: a ruled phase header, then rows of
// [thumb] [note] [stage] [date] on the same 12-column grid the page uses.
//
// ONE DOM, TWO LAYOUTS: below `sm` the date and stage share a meta line under
// the note; from `sm` the meta wrapper becomes `display: contents` so both land
// in their own grid columns. The date is rendered ONCE - duplicating it per
// breakpoint would make a screen reader announce it twice.
//
// The note stays visible without a tap (2026-11-08 rule: the note IS the
// content). Empty captions are skipped - a blank line is noise, not a note.
import { LuImage } from '@paalstack/react-icons/lu';

import type { TimelinePhoto } from '@/hooks/queries/customer-portal';
import { constructionStageLabel } from '@/lib/labels';

import { formatDay, photoAlt } from './portal-format';
import type { PhaseGroup } from './portal-progress';
import { Reveal } from './reveal';

/** The first two images load eagerly (above the fold); the rest lazily. */
const EAGER_IMAGES = 2;

function EntryRow({
  photo,
  index,
  focused,
  onOpen,
}: {
  photo: TimelinePhoto;
  index: number;
  focused: boolean;
  onOpen: () => void;
}) {
  const note = photo.caption.trim();
  const hasNote = note.length > 0;

  return (
    <Reveal
      as="li"
      id={`photo-${photo.id}`}
      data-qa="portal-photo-row"
      data-focused={focused ? 'true' : undefined}
      className={
        'portal-hairline-b group grid grid-cols-[4.5rem_minmax(0,1fr)] items-start gap-x-4 gap-y-1 py-4 sm:grid-cols-12 sm:items-center sm:gap-x-5 ' +
        (focused ? 'animate-portal-focus' : '')
      }
    >
      {/* thumbnail: the thumb is the target, not the whole row */}
      <button
        type="button"
        onClick={onOpen}
        aria-haspopup="dialog"
        data-qa="portal-photo-open"
        className="col-span-1 row-span-2 block w-full self-start overflow-hidden border border-[var(--portal-hair)] bg-[var(--portal-tint)] focus-visible:ring-2 focus-visible:ring-[var(--portal-navy)] focus-visible:ring-offset-2 focus-visible:outline-none sm:col-span-2 sm:row-span-1"
      >
        {/* Same-origin, cookie-authenticated BFF media URL: next/image's
            optimizer would drop the session, so a plain <img> is correct
            (same call as the staff Progress tab). */}
        <img
          src={photo.mediaUrl}
          alt={photoAlt(photo)}
          width={800}
          height={600}
          loading={index < EAGER_IMAGES ? 'eager' : 'lazy'}
          decoding="async"
          className="aspect-[4/3] w-full object-cover transition-transform duration-700 [transition-timing-function:var(--portal-ease)] group-hover:scale-[1.04] motion-reduce:transition-none"
          data-qa="portal-photo-img"
        />
      </button>

      {hasNote ? (
        <p
          className="col-span-1 text-[0.9375rem] leading-snug text-[var(--portal-navy)] sm:col-span-6"
          data-qa="portal-photo-caption"
        >
          {note}
        </p>
      ) : (
        /* No note: keep the column so the date and stage stay aligned. */
        <span className="hidden sm:col-span-6 sm:block" aria-hidden="true" />
      )}

      {/* Meta: one line on mobile, two grid columns from sm. */}
      <span className="col-span-1 flex flex-wrap items-center gap-x-3 gap-y-1 text-[0.6875rem] tracking-[0.1em] text-[var(--portal-ink-2)] uppercase sm:[display:contents]">
        <span className="sm:col-span-3 sm:order-2 sm:text-right">
          <time dateTime={photo.takenAt} className="portal-figure" data-qa="portal-photo-date">
            {formatDay(photo.takenAt)}
          </time>
        </span>
        {/* Omitted when the capture recorded none: "Stage not set" belongs on
            the journey, not repeated on every old photo. */}
        {photo.stage !== null ? (
          <span data-qa="portal-photo-stage" className="sm:col-span-1 sm:order-1">
            {constructionStageLabel(photo.stage)}
          </span>
        ) : (
          <span className="hidden sm:col-span-1 sm:order-1 sm:block" aria-hidden="true" />
        )}
      </span>
    </Reveal>
  );
}

export function PortalPhaseGroup({
  group,
  current,
  startIndex,
  focusedPhotoId,
  onOpenPhoto,
}: {
  group: PhaseGroup<TimelinePhoto>;
  current: boolean;
  /** Index of this group's first photo in the whole feed (eager-load cutoff). */
  startIndex: number;
  focusedPhotoId: string | null;
  onOpenPhoto: (photoId: string) => void;
}) {
  const count = group.photos.length;

  return (
    <Reveal
      as="section"
      aria-labelledby={`phase-${group.key}`}
      data-qa="portal-phase-group"
      data-current={current ? 'true' : undefined}
    >
      <div className="portal-rule-b flex flex-wrap items-baseline justify-between gap-x-6 gap-y-1 pb-2.5">
        <div className="flex flex-wrap items-baseline gap-x-3 gap-y-1">
          <h2
            id={`phase-${group.key}`}
            className="portal-display text-[1.375rem] leading-none text-[var(--portal-navy)]"
          >
            {group.label}
          </h2>
          {current ? (
            <span
              data-qa="portal-current-chip"
              className="inline-flex items-center rounded-sm bg-[var(--portal-green-wash)] px-2 py-0.5 text-[0.625rem] font-medium tracking-[0.12em] text-[var(--portal-green-ink)] uppercase"
            >
              Current
            </span>
          ) : null}
        </div>
        <p className="portal-figure flex items-center gap-1.5 text-[0.6875rem] tracking-[0.1em] text-[var(--portal-ink-2)] uppercase">
          <LuImage className="size-3.5" aria-hidden="true" />
          {group.rangeLabel} · {count} {count === 1 ? 'photo' : 'photos'}
        </p>
      </div>
      <ol>
        {group.photos.map((photo, i) => (
          <EntryRow
            key={photo.id}
            photo={photo}
            index={startIndex + i}
            focused={photo.id === focusedPhotoId}
            onOpen={() => onOpenPhoto(photo.id)}
          />
        ))}
      </ol>
    </Reveal>
  );
}
