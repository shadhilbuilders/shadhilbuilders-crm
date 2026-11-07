'use client';

// PhotoLightbox (issue #8 slice 2): a photo opened full-bleed in a bottom
// drawer. Used for tapping a row and for the `?photo=<id>` push deep link.
import { Button, Drawer, DrawerClose } from '@paalstack/react-ui';

import type { TimelinePhoto } from '@/hooks/queries/customer-portal';

import { formatDay, photoAlt } from './portal-format';

export function PhotoLightbox({
  photo,
  onClose,
}: {
  photo: TimelinePhoto | null;
  onClose: () => void;
}) {
  return (
    <Drawer
      open={photo !== null}
      onOpenChange={(open) => {
        if (!open) onClose();
      }}
      direction="bottom"
      title={photo?.phaseName ?? 'Construction photo'}
      description={photo ? `${photo.caption} - ${formatDay(photo.takenAt)}` : undefined}
      footer={
        <DrawerClose asChild>
          <Button type="button" variant="outline" size="lg" className="min-h-11 w-full" data-qa="portal-lightbox-close">
            Close
          </Button>
        </DrawerClose>
      }
    >
      {photo ? (
        <div className="px-4" data-qa="portal-lightbox">
          <img
            src={photo.mediaUrl}
            alt={photoAlt(photo)}
            className="max-h-[70dvh] w-full rounded-lg object-contain"
            data-qa="portal-lightbox-img"
          />
        </div>
      ) : null}
    </Drawer>
  );
}
