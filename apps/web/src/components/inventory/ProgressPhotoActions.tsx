'use client';

// ProgressPhotoActions (slice 4, 2026-11-07; menu 2026-11-08): the per-photo
// edit-note and delete controls on the capture feed. Edit note opens
// EditNoteDialog (zod-validated Form); delete goes through a confirm.
//
// WHY A MENU NOW: two ghost icon buttons sat on every row at icon scale, inside
// a crowded row. On a phone those were hard to hit and easy to hit wrongly, and
// they competed with the photo for attention. One 44x44 kebab holding both
// actions keeps them reachable without putting a destructive control one
// mis-tap away from the image.
//
// WHAT DID NOT CHANGE: the edit/delete mutations, the `canMutate` gate, and the
// delete confirmation's copy - a buyer may already have seen this photo, and
// that sentence is the reason the confirm exists.
//
// AUTHORITY IS NOT DECIDED HERE. Every mutation is re-checked against RLS on the
// server (ADMIN, the photo's creator, or the project's photo lead), and a denied
// actor gets 404 with a clear message. `photo.canMutate` is the server's own
// advisory answer to "should this session be offered the controls" - computed
// where the identity facts live, so this component never has to guess from a
// display name.
import { useState } from 'react';

import { AlertDialog, Button, DropdownMenu, toast } from '@paalstack/react-ui';
import { LuEllipsisVertical, LuPencil, LuTrash2 } from '@paalstack/react-icons/lu';

import { useDeletePhoto, type TimelinePhoto } from '@/hooks/queries/customer-progress';

import { EditNoteDialog } from './EditNoteDialog';

export function ProgressPhotoActions({ photo, unitId }: { photo: TimelinePhoto; unitId: string }) {
  const [editing, setEditing] = useState(false);
  const [confirming, setConfirming] = useState(false);
  const remove = useDeletePhoto(unitId);

  // The server answers whether this session may act on this row; a buyer gets
  // false on every row.
  if (photo.canMutate !== true) return null;

  return (
    <>
      <DropdownMenu
        trigger={
          // 44x44 touch target; the label names the date so a screen reader can
          // tell two rows apart.
          <Button
            type="button"
            variant="ghost"
            size="sm"
            className="size-11 shrink-0 pointer-fine:size-9"
            aria-label={`Actions for the photo from ${new Date(photo.takenAt).toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric' })}`}
            data-qa={`progress-photo-menu-${photo.id}`}
          >
            <LuEllipsisVertical className="size-5" aria-hidden="true" />
          </Button>
        }
        items={[
          {
            // The item TYPE does not accept a data-qa (it is a Base UI
            // component prop), so the anchor lives on the label content. A click
            // on it bubbles to the item, which is what the tests drive.
            label: (
              <span className="flex items-center gap-2" data-qa={`progress-photo-edit-${photo.id}`}>
                <LuPencil className="size-4" aria-hidden="true" /> Edit note
              </span>
            ),
            onClick: () => setEditing(true),
            id: `progress-photo-edit-${photo.id}`,
          },
          {
            label: (
              <span
                className="flex items-center gap-2"
                data-qa={`progress-photo-delete-${photo.id}`}
              >
                <LuTrash2 className="size-4" aria-hidden="true" /> Delete photo
              </span>
            ),
            variant: 'destructive',
            onClick: () => setConfirming(true),
            disabled: remove.isPending,
            id: `progress-photo-delete-${photo.id}`,
          },
        ]}
      />

      <EditNoteDialog
        open={editing}
        onOpenChange={setEditing}
        photoId={photo.id}
        unitId={unitId}
        caption={photo.caption}
        stage={photo.stage}
      />

      <AlertDialog
        open={confirming}
        onOpenChange={(open) => {
          if (!open) setConfirming(false);
        }}
        trigger={null}
        header={{
          title: 'Delete this photo?',
          // Says what is permanent and what the buyer sees, because a buyer may
          // already have seen this photo in their portal.
          description:
            'The photo is removed for everyone, including the customer portal, and cannot be recovered. This cannot be undone.',
        }}
        cancelButtonText="Cancel"
        confirmButtonText={remove.isPending ? 'Deleting...' : 'Delete photo'}
        confirmButtonProps={{ variant: 'destructive', disabled: remove.isPending }}
        onConfirm={() =>
          remove.mutate(photo.id, {
            onSuccess: () => {
              setConfirming(false);
              toast.success('Photo deleted');
            },
            onError: (error: unknown) => {
              setConfirming(false);
              toast.error(error instanceof Error ? error.message : 'Could not delete the photo');
            },
          })
        }
        onCancel={() => setConfirming(false)}
      />
    </>
  );
}
