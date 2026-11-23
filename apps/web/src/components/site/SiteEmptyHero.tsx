'use client';

// SiteEmptyHero (2026-11-08): the first-photo state, where the whole panel IS
// the affordance.
//
// WHAT IT REPLACES: an "Add first photo" button sitting directly above a large
// dashed "No photos yet" box. Both looked clickable, neither was a photo, and
// the dashed box was dead space. There is now exactly ONE thing to touch, and it
// covers the panel.
//
// The PANEL CONTENT lives here; the capture screen wraps it in the library
// `FileUpload`'s dropzone, so on desktop it accepts a drop and on a phone it
// opens the picker with multi-select (same provider as the `Gallery` trigger, so
// picking through either one lands in one handler). The sticky `Take photo`
// button stays the camera path and is always visible.
import { Empty } from '@paalstack/react-ui';
import { LuArrowRight, LuCamera } from '@paalstack/react-icons/lu';

const STEPS = ['Shoot the unit', 'Add a one-line note', 'The customer sees it today'] as const;

/** The panel's surface classes, shared by the dropzone wrapper and the tests. */
export const EMPTY_HERO_CLASS =
  'border-border bg-muted-soft hover:bg-muted w-full cursor-pointer rounded-xl border px-6 py-8 text-center transition-colors active:scale-[0.99] focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none motion-reduce:transition-none motion-reduce:active:scale-100';

export function SiteEmptyHero({
  unitNumber,
  videoEnabled = false,
}: {
  unitNumber: string;
  /** Copy changes to "a photo or a clip" only while the flag is on. */
  videoEnabled?: boolean;
}) {
  return (
    <Empty
      data-qa="progress-empty"
      className={EMPTY_HERO_CLASS}
      media={<LuCamera className="size-6" aria-hidden="true" />}
      mediaVariant="icon"
      title={videoEnabled ? 'Add a photo or a clip' : 'Add the first photo'}
      description={
        videoEnabled
          ? `${unitNumber} has nothing on file yet. Pick photos here, tap Take photo, or record a short clip.`
          : `${unitNumber} has nothing on file yet. Pick photos here, or tap Take photo to shoot one now.`
      }
      content={
        <span className="text-muted-foreground flex flex-wrap items-center justify-center gap-1 text-xs">
          {STEPS.map((step, index) => (
            <span key={step} className="flex items-center gap-1">
              <span>{step}</span>
              {index < STEPS.length - 1 ? (
                <LuArrowRight className="size-3" aria-hidden="true" />
              ) : null}
            </span>
          ))}
        </span>
      }
    />
  );
}
