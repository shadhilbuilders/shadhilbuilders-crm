'use client';

// PortalHero: the record head - the buyer's unit as a document title, then the
// newest site photo as a plate with the engineer's note beside it.
//
// REDESIGN (2026-11-09, third pass). Two structural fixes:
//   1. ALIGNMENT. The record head ran on `gap-5` and the plate row on `gap-8`,
//      so the right-hand column started 8px further right on one row than the
//      other (measured: spec dl at x=912, note at x=920), and the photo ended
//      4px short of the headline above it (888 vs 892). Both rows now use one
//      token - `--portal-col-gap` - so every column edge is shared.
//   2. THE JOURNEY MOVED. It is now a full-width band BETWEEN the head and the
//      plate (passed in as `children`), because it describes the unit, not the
//      photo. As a 7-of-12 column beside a 5-of-12 handover card it was 612px
//      wide while the photo under it was 704px, so two neighbouring blocks
//      disagreed about where the page's right edge was.
//
// The note column carries real substance now: the note itself, who posted it,
// and the entry's phase / stage / date / photo count as aligned label-value
// pairs, so the column is information rather than one floating quote.
//
// No percentage anywhere - the stage is "Stage N of 9" (decision #116).
import type { ReactNode } from 'react';
import { LuCamera } from '@paalstack/react-icons/lu';

import { VideoBadge } from '@/components/site/VideoBadge';
import { constructionStageLabel } from '@/lib/labels';
import { isPlayableVideo } from '@/lib/site-video/is-video';
import type { TimelinePhoto } from '@/hooks/queries/customer-portal';

import { formatDay, photoAlt } from './portal-format';
import { stagePosition, updatedLabel } from './portal-progress';

export type PortalHeroProps = {
  customerName: string;
  unitNumber: string;
  projectName: string;
  /** Newest photo of the selected unit, or null when there is none yet. */
  latest: TimelinePhoto | null;
  isLoading: boolean;
  onOpenPhoto: (photoId: string) => void;
  /** Injected so SSR and tests agree on "today". */
  now: number;
  /** Entries recorded for this unit, including the one on the plate. */
  photoCount?: number;
  /** Full-width band between the record head and the plate (the journey). */
  children?: ReactNode;
};

/** One gap token for every column on this section, so edges cannot drift. */
const COLS = 'lg:grid-cols-12 lg:gap-x-8 lg:gap-y-0';

function PhotoSlot({
  latest,
  isLoading,
  onOpenPhoto,
}: Pick<PortalHeroProps, 'latest' | 'isLoading' | 'onOpenPhoto'>) {
  // Site photos arrive as wide panoramas (the seeded sample is 1600x470, a
  // 3.4:1 frame). A 4:3 or 16:10 box crops most of that away, so the plate
  // is portrait-comfortable on phones and wide from sm up.
  const frame = 'aspect-[4/3] w-full sm:aspect-[2/1]';

  if (isLoading) {
    return (
      <div aria-busy="true" className={`${frame} animate-pulse bg-[var(--portal-hair)]`}>
        <span className="sr-only">Loading the latest photo</span>
      </div>
    );
  }

  if (latest === null) {
    return (
      <div
        data-qa="portal-hero-empty"
        className={`${frame} flex flex-col items-center justify-center gap-3 border border-[var(--portal-hair)] bg-[var(--portal-tint)] px-6 text-center`}
      >
        <LuCamera className="size-7 text-[var(--portal-ink-2)]" aria-hidden="true" />
        <p className="portal-display text-xl text-[var(--portal-navy)]">First photos coming soon</p>
        <p className="max-w-[30ch] text-sm text-[var(--portal-ink-2)]">
          The site team will post the first update here. We will let you know.
        </p>
      </div>
    );
  }

  return (
    <button
      type="button"
      onClick={() => onOpenPhoto(latest.id)}
      data-qa="portal-hero-photo"
      aria-label={`Open the latest ${isPlayableVideo(latest) ? 'video' : 'photo'}: ${photoAlt(latest)}`}
      className="group block w-full overflow-hidden border border-[var(--portal-hair)] bg-[var(--portal-tint)] text-left focus-visible:ring-2 focus-visible:ring-[var(--portal-navy)] focus-visible:ring-offset-2 focus-visible:outline-none"
    >
      <span className={`${frame} relative block overflow-hidden bg-[var(--portal-hair)]`}>
        {/* Plain <img>: same-origin, cookie-authenticated media (not next/image). */}
        <img
          src={latest.mediaUrl}
          alt={photoAlt(latest)}
          width={1200}
          height={900}
          loading="eager"
          decoding="async"
          className="size-full object-cover transition-transform duration-700 [transition-timing-function:var(--portal-ease)] group-hover:scale-[1.025] motion-reduce:transition-none"
        />
        {isPlayableVideo(latest) ? <VideoBadge durationMs={latest.durationMs} /> : null}
      </span>
      {/* One caption strip, not an overlay. It names the PHASE (the photo's
          context); the engineer's note lives in the ruled column beside it, so
          the same sentence is never printed twice on one screen. */}
      <span className="flex flex-wrap items-center justify-between gap-x-4 gap-y-1 border-t border-[var(--portal-hair)] px-3 py-3 sm:px-4">
        <span className="text-[0.9375rem] text-[var(--portal-navy)]" data-qa="portal-hero-phase">
          {latest.phaseName ?? 'Site update'}
        </span>
        <span className="portal-figure text-[0.6875rem] tracking-[0.12em] text-[var(--portal-ink-2)] uppercase">
          {formatDay(latest.takenAt)}
        </span>
      </span>
    </button>
  );
}

/** One label-value line in the note column. Values are tabular so the column
 *  reads as a table rather than a paragraph with numbers in it. */
function Fact({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="flex items-baseline justify-between gap-4 border-b border-[var(--portal-hair)] py-2 last:border-b-0">
      <dt className="text-[0.6875rem] tracking-[0.1em] text-[var(--portal-ink-2)] uppercase">
        {label}
      </dt>
      <dd className="portal-figure text-right text-[0.8125rem] text-[var(--portal-navy)]">
        {children}
      </dd>
    </div>
  );
}

export function PortalHero({
  customerName,
  unitNumber,
  projectName,
  latest,
  isLoading,
  onOpenPhoto,
  now,
  photoCount,
  children,
}: PortalHeroProps) {
  // The hero greets the buyer by full name. The masthead also carries the full
  // name, but it is hidden below `sm` and it is chrome, not a greeting - this is
  // the line that opens the buyer's own record (2026-11-10).
  const fullName = customerName.trim().replace(/\s+/g, ' ');
  const { position, total } = stagePosition(latest?.stage ?? null);
  const note = latest?.caption.trim() ?? '';
  const hasNote = note.length > 0 && latest !== null;

  return (
    <section aria-labelledby="portal-hero-title" data-qa="portal-hero">
      {/* ---- record head: title left, spec figures right ---- */}
      <div className={`portal-rule-b grid grid-cols-1 items-end gap-6 pt-7 pb-5 ${COLS}`}>
        <div className="lg:col-span-8">
          {fullName.length > 0 ? (
            <p className="mb-3 text-sm text-(--portal-ink-2)" data-qa="portal-hero-greeting">
              Hello, {fullName}
            </p>
          ) : null}
          <h1
            id="portal-hero-title"
            data-qa="portal-unit-heading"
            className="portal-display text-[clamp(2.75rem,7vw,4.75rem)] leading-[0.92] text-(--portal-navy)"
          >
            {unitNumber}
            <span className="mt-2 block text-[clamp(0.9375rem,1.6vw,1.1875rem)] font-normal tracking-[-0.01em] text-[var(--portal-ink-2)]">
              {projectName}
            </span>
          </h1>
        </div>
        <dl className="grid grid-cols-2 gap-6 border-t border-(--portal-hair) pt-4 lg:col-span-4 lg:border-t-0 lg:border-l lg:pt-0 lg:pl-8">
          <div>
            <dt className="portal-eyebrow mb-2">Last update</dt>
            <dd
              data-qa="portal-hero-updated"
              className="text-[0.9375rem] leading-snug text-(--portal-navy)"
            >
              {latest !== null ? updatedLabel(latest.takenAt, now) : 'No updates yet'}
            </dd>
          </div>
          <div>
            <dt className="portal-eyebrow mb-2">Stage</dt>
            <dd className="text-[0.9375rem] leading-snug text-(--portal-navy)">
              {position !== null && latest !== null && latest.stage !== null ? (
                <span data-qa="portal-hero-stage" className="portal-figure">
                  {position} of {total}
                  <span className="mt-0.5 block text-(--portal-ink-2)">
                    {constructionStageLabel(latest.stage)}
                  </span>
                </span>
              ) : (
                <span className="text-(--portal-ink-2)">Not recorded</span>
              )}
            </dd>
          </div>
        </dl>
      </div>

      {/* ---- full-width band between the head and the photo (the journey) ---- */}
      {children !== undefined ? <div className="py-6">{children}</div> : null}

      {/* ---- the plate: photo + note column, on the SAME grid as the head ---- */}
      <div className={`grid grid-cols-1 items-start gap-6 ${COLS}`}>
        <div className="lg:col-span-8">
          <PhotoSlot latest={latest} isLoading={isLoading} onOpenPhoto={onOpenPhoto} />
        </div>
        <div className="lg:col-span-4 lg:self-stretch">
          {hasNote ? (
            <figure
              data-qa="portal-hero-note"
              className="border-t-2 border-(--portal-navy) pt-4 lg:flex lg:h-full lg:flex-col"
            >
              <figcaption className="portal-eyebrow mb-3">Site team note</figcaption>

              <blockquote className="portal-display text-[1.25rem] leading-[1.32] text-[var(--portal-navy)]">
                {note}
              </blockquote>

              {latest.creatorName ? (
                <p className="mt-3 text-sm leading-relaxed text-(--portal-ink-2)">
                  Posted by your site team
                  <br />
                  <span className="text-(--portal-navy)">{latest.creatorName}</span>
                </p>
              ) : null}

              {/* The entry's own record, so the column answers the questions the
                  quote raises: which phase, which stage, when, how many photos.
                  `mt-auto` pushes the block to the column's bottom edge, so the
                  shorter note column ends level with the taller photo instead
                  of leaving a gap under it. */}
              <dl className="pt-5" data-qa="portal-hero-note-facts">
                {latest.phaseName !== null ? <Fact label="Phase">{latest.phaseName}</Fact> : null}
                {latest.stage !== null ? (
                  <Fact label="Stage">{constructionStageLabel(latest.stage)}</Fact>
                ) : null}
                <Fact label="Recorded">
                  <time dateTime={latest.takenAt}>{formatDay(latest.takenAt)}</time>
                </Fact>
                {photoCount !== undefined && photoCount > 0 ? (
                  <Fact label="Photos">
                    {photoCount} {photoCount === 1 ? 'photo' : 'photos'}
                  </Fact>
                ) : null}
              </dl>
            </figure>
          ) : null}
        </div>
      </div>
    </section>
  );
}
