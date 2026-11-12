// PortalLock (issue #8 slice 2): the two dead-end states from the design's
// state table. Neither is an error the buyer caused, so both are calm,
// first-person-plural copy with a way to reach a human.
//   not-linked : the login exists but no lead is attached (staff must link it)
//   no-units   : linked, but no booking has been APPROVED yet
//
// REDESIGN (2026-11-09, second pass): the nested double-bezel frame is gone -
// it was the same shape as the hero and every photo card, which is why the
// page had no hierarchy. A ruled block on paper reads as a notice, which is
// what these states are.
import { Empty } from '@paalstack/react-ui';
import { LuLock, LuPhone } from '@paalstack/react-icons/lu';

export type PortalLockReason = 'not-linked' | 'no-units';

const COPY: Record<PortalLockReason, { title: string; description: string }> = {
  'not-linked': {
    title: 'Your photos are not linked yet',
    description:
      'Your account has been created, but your home is not connected to it. Please contact the project office and we will sort it out.',
  },
  'no-units': {
    title: "We're setting this up",
    description:
      'Progress photos appear here once your booking is confirmed. We will let you know as soon as that happens.',
  },
};

export function PortalLock({
  reason,
  officePhone,
}: {
  reason: PortalLockReason;
  officePhone?: string | null;
}) {
  const copy = COPY[reason];
  const tel = officePhone ? officePhone.replace(/[^\d+]/g, '') : '';
  return (
    <div data-qa="portal-lock" data-reason={reason} className="mx-auto max-w-xl py-10 sm:py-16">
      <div className="border-t-2 border-[var(--portal-navy)] pt-6">
        <Empty
          media={<LuLock className="size-full" />}
          mediaVariant="icon"
          title={copy.title}
          description={copy.description}
          content={
            officePhone && tel.length > 0 ? (
              <a
                href={`tel:${tel}`}
                data-qa="portal-lock-phone"
                className="inline-flex min-h-11 flex-wrap items-center justify-center gap-2 rounded-full border border-[var(--portal-navy)] px-5 py-2 text-base font-medium text-[var(--portal-navy)] transition-colors duration-300 hover:bg-[var(--portal-navy)] hover:text-[var(--portal-paper)]"
              >
                <LuPhone className="size-4" aria-hidden="true" />
                <span>Call the project office</span>
                <span className="portal-figure font-normal opacity-70">{officePhone}</span>
              </a>
            ) : (
              <p className="text-base text-[var(--portal-ink-2)]">
                Please contact the project office.
              </p>
            )
          }
        />
      </div>
    </div>
  );
}
