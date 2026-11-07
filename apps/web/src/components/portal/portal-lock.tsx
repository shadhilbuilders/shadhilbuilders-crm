// PortalLock (issue #8 slice 2): the two dead-end states from the design's
// state table. Neither is an error the buyer caused, so both are calm,
// first-person-plural copy with a way to reach a human.
//   not-linked : the login exists but no lead is attached (staff must link it)
//   no-units   : linked, but no booking has been APPROVED yet
import { Empty } from '@paalstack/react-ui';
import { LuLock, LuPhone } from '@paalstack/react-icons/lu';

export type PortalLockReason = 'not-linked' | 'no-units';

const COPY: Record<PortalLockReason, { title: string; description: string }> = {
  'not-linked': {
    title: 'Your photos are not linked yet',
    description: 'Your account has been created, but your home is not connected to it. Please contact the project office and we will sort it out.',
  },
  'no-units': {
    title: "We're setting this up",
    description: 'Progress photos appear here once your booking is confirmed. We will let you know as soon as that happens.',
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
    <div data-qa="portal-lock" data-reason={reason} className="px-4 py-10">
      <Empty
        media={<LuLock className="size-full" />}
        mediaVariant="icon"
        title={copy.title}
        description={copy.description}
        content={
          officePhone ? (
            <a
              href={`tel:${tel}`}
              data-qa="portal-lock-phone"
              className="border-border text-foreground inline-flex min-h-11 items-center gap-2 rounded-full border px-5 text-base font-medium"
            >
              <LuPhone className="size-4" aria-hidden="true" />
              <span>Call the project office</span>
              <span className="text-muted-foreground font-normal">{officePhone}</span>
            </a>
          ) : (
            <p className="text-muted-foreground text-base">Please contact the project office.</p>
          )
        }
      />
    </div>
  );
}
