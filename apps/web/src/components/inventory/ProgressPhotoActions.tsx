'use client';

// ProgressPhotoActions (slice 4, 2026-11-07): inline edit + delete controls on a
// staff timeline row.
//
// WHY INLINE: the tab is a scanning surface on a phone. A sheet-in-a-sheet (the
// Progress tab already lives inside UnitDetailSheet) buries the action and can
// stack dialogs badly. Two icon buttons on the row, an inline caption editor,
// and a confirm dialog for the destructive one.
//
// AUTHORITY IS NOT DECIDED HERE. Every mutation is re-checked against RLS on the
// server (ADMIN, the photo's creator, or the project's photo lead), and a denied
// actor gets 404 with a clear message. `photo.canMutate` is the server's own
// advisory answer to "should this session be offered the controls" - computed
// where the identity facts live, so this component never has to guess from a
// display name.
import { useState } from 'react';

import { AlertDialog, Button, Input, toast } from '@paalstack/react-ui';
import { LuCheck, LuPencil, LuTrash2, LuX } from '@paalstack/react-icons/lu';

import { useDeletePhoto, useUpdatePhoto, type TimelinePhoto } from '@/hooks/queries/customer-progress';

export function ProgressPhotoActions({
  photo,
  unitId,
}: {
  photo: TimelinePhoto;
  unitId: string;
}) {
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(photo.caption);
  const [confirming, setConfirming] = useState(false);
  const update = useUpdatePhoto(unitId);
  const remove = useDeletePhoto(unitId);

  // The server answers whether this session may act on this row; a buyer gets
  // false on every row.
  if (photo.canMutate !== true) return null;

  const save = (): void => {
    const caption = draft.trim();
    if (caption.length === 0) return;
    update.mutate(
      { photoId: photo.id, caption },
      {
        onSuccess: () => {
          setEditing(false);
          toast.success('Caption updated');
        },
        onError: (error: unknown) =>
          toast.error(error instanceof Error ? error.message : 'Could not update the caption'),
      },
    );
  };

  if (editing) {
    return (
      <div className="mt-1 flex items-center gap-1" data-qa={`progress-edit-${photo.id}`}>
        <Input
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          maxLength={200}
          aria-label="Photo caption"
          data-qa={`progress-caption-input-${photo.id}`}
          // Enter saves, Escape abandons: a phone keyboard has no room for a
          // third button.
          onKeyDown={(e) => {
            if (e.key === 'Enter') {
              e.preventDefault();
              save();
            }
            if (e.key === 'Escape') {
              setEditing(false);
              setDraft(photo.caption);
            }
          }}
        />
        <Button
          type="button"
          variant="ghost"
          size="sm"
          aria-label="Save caption"
          onClick={save}
          disabled={update.isPending || draft.trim().length === 0}
          data-qa={`progress-caption-save-${photo.id}`}
        >
          <LuCheck className="size-4" aria-hidden="true" />
        </Button>
        <Button
          type="button"
          variant="ghost"
          size="sm"
          aria-label="Cancel editing"
          onClick={() => {
            setEditing(false);
            setDraft(photo.caption);
          }}
          data-qa={`progress-caption-cancel-${photo.id}`}
        >
          <LuX className="size-4" aria-hidden="true" />
        </Button>
      </div>
    );
  }

  return (
    <div className="mt-1 flex items-center gap-1">
      <Button
        type="button"
        variant="ghost"
        size="sm"
        aria-label={`Edit the caption for ${photo.caption}`}
        onClick={() => {
          setDraft(photo.caption);
          setEditing(true);
        }}
        data-qa={`progress-photo-edit-${photo.id}`}
      >
        <LuPencil className="size-4" aria-hidden="true" />
      </Button>
      <Button
        type="button"
        variant="ghost"
        size="sm"
        aria-label={`Delete the photo ${photo.caption}`}
        onClick={() => setConfirming(true)}
        disabled={remove.isPending}
        data-qa={`progress-photo-delete-${photo.id}`}
      >
        <LuTrash2 className="size-4" aria-hidden="true" />
      </Button>

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
    </div>
  );
}
