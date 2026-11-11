'use client';

// NoteAttachments (2026-11-09): the photo strip inside the note dialog.
//
// Split out of NoteDialog so both files stay small and each one has a single
// job: this file owns how a photo LOOKS and what its tile can do, NoteDialog
// owns the form around it.
//
// Every tile is an `Attachment` (shadcn's composer primitive), used the way the
// primitive intends:
//   - `AttachmentMedia` holds the preview (or the icon on an add tile),
//   - `AttachmentDescription` carries the size and the upload STATE IN WORDS, so
//     a colour-blind engineer in sunlight still reads "Not saved",
//   - `AttachmentTrigger` is a full-card overlay at z-10 that changes the large
//     preview, while `AttachmentActions` sits above it at z-20 so Remove never
//     opens the viewer instead of removing,
//   - `AttachmentGroup` lays them out as a scrollable, snapping strip.
import {
  Attachment,
  AttachmentAction,
  AttachmentActions,
  AttachmentContent,
  AttachmentDescription,
  AttachmentMedia,
  AttachmentTitle,
  AttachmentTrigger,
  formatBytes,
} from '@paalstack/react-ui';
import { LuImagePlus, LuX } from '@paalstack/react-icons/lu';

import type { ReactNode } from 'react';

/** Where a photo came from - the page records it as `clientDeviceHint`. */
export type NoteAddSource = 'camera' | 'gallery';

/** One photo in the note, with the state of its own upload. */
export type NoteAttachmentStatus = 'ready' | 'uploading' | 'saved' | 'failed';

export type NoteAttachment = {
  /** Stable per-photo id. Indexes are not stable once a tile is removed. */
  id: string;
  /** Data URL of the prepared bytes - the blob that will actually upload. */
  previewUrl: string;
  filename: string;
  bytes: number;
  status: NoteAttachmentStatus;
};

/** Upload state → the Attachment primitive's visual state. */
const ATTACHMENT_STATE: Record<NoteAttachmentStatus, 'idle' | 'uploading' | 'done' | 'error'> = {
  ready: 'idle',
  uploading: 'uploading',
  saved: 'done',
  failed: 'error',
};

/** The same state, in words. Meaning is never carried by colour alone. */
const ATTACHMENT_STATUS_LABEL: Record<NoteAttachmentStatus, string> = {
  ready: 'Ready',
  uploading: 'Saving...',
  saved: 'Saved',
  failed: 'Not saved',
};

/**
 * The large preview.
 *
 * It exists to CHECK a shot, not to admire it - and on a short phone (iPhone SE,
 * 667px) the frame it occupies is the reason the stage picker sits below the
 * fold. So it shrinks with the viewport, and on a viewport under 680px tall it
 * yields entirely: the photo strip, the stage and the note are the form, and the
 * tile is one tap away for a full-size look. `min-h-` keeps a tap target, never
 * a squashed sliver.
 */
export const PREVIEW_BOX_CLASS = 'h-[min(24dvh,200px)] min-h-28 [@media(max-height:679px)]:hidden';
export const EMPTY_BOX_CLASS = 'h-[min(20dvh,160px)] min-h-24 [@media(max-height:679px)]:hidden';

/** One photo tile: preview, size + state, remove action, and a preview trigger. */
export function PhotoAttachmentTile({
  attachment,
  isFocused,
  canEdit,
  onFocus,
  onRemove,
}: {
  attachment: NoteAttachment;
  isFocused: boolean;
  canEdit: boolean;
  onFocus: () => void;
  onRemove: () => void;
}) {
  return (
    <Attachment
      state={ATTACHMENT_STATE[attachment.status]}
      size="default"
      orientation="vertical"
      data-qa="site-note-attachment"
      data-status={attachment.status}
      data-attachment-id={attachment.id}
      className={isFocused ? 'ring-primary! ring-offset-background! ring-2! ring-offset-1!' : undefined}
    >
      <AttachmentMedia variant="image">
        {/* Decorative: the filename and state are the tile's text. */}
        <img src={attachment.previewUrl} alt="" />
      </AttachmentMedia>
      <AttachmentContent>
        <AttachmentTitle>{attachment.filename}</AttachmentTitle>
        <AttachmentDescription>
          {formatBytes(attachment.bytes)} · {ATTACHMENT_STATUS_LABEL[attachment.status]}
        </AttachmentDescription>
      </AttachmentContent>
      <AttachmentActions>
        <AttachmentAction
          aria-label={`Remove ${attachment.filename} from this note`}
          onClick={onRemove}
          // A saved photo is on the record; removing it here would only hide it.
          disabled={!canEdit || attachment.status === 'saved'}
          className="bg-background/90 text-foreground hover:bg-background shadow-sm backdrop-blur disabled:opacity-40"
          data-qa="site-note-attachment-remove"
        >
          <LuX aria-hidden="true" />
        </AttachmentAction>
      </AttachmentActions>
      <AttachmentTrigger
        onClick={onFocus}
        aria-label={`Show ${attachment.filename} larger`}
        aria-pressed={isFocused}
        data-qa="site-note-attachment-focus"
      />
    </Attachment>
  );
}

/** An "add one more" tile, in the same strip as the photos. */
export function AddAttachmentTile({
  icon,
  title,
  description,
  onSelect,
  disabled,
  testId,
  label,
}: {
  icon: ReactNode;
  title: string;
  description: string;
  onSelect: () => void;
  disabled: boolean;
  testId: string;
  label: string;
}) {
  return (
    <Attachment
      state="idle"
      size="default"
      orientation="vertical"
      aria-disabled={disabled}
      className={disabled ? 'opacity-50' : undefined}
    >
      <AttachmentMedia variant="icon">{icon}</AttachmentMedia>
      <AttachmentContent>
        <AttachmentTitle>{title}</AttachmentTitle>
        <AttachmentDescription>{description}</AttachmentDescription>
      </AttachmentContent>
      {/* The TRIGGER carries the disabled state, not just the wrapper: the
          wrapper's `aria-disabled` is invisible to a button and does not stop a
          click, so at the cap the tile would still open the picker. */}
      <AttachmentTrigger
        onClick={onSelect}
        aria-label={label}
        disabled={disabled}
        className="disabled:cursor-not-allowed"
        data-qa={testId}
      />
    </Attachment>
  );
}

/**
 * The large preview of the focused photo, or the empty invitation when the note
 * has no photos. Both shrink with the viewport (see PREVIEW_BOX_CLASS).
 */
export function NotePreview({
  attachment,
  unitNumber,
}: {
  attachment: NoteAttachment | null;
  unitNumber: string;
}) {
  if (attachment === null) {
    return (
      <div
        className={`bg-muted-soft flex ${EMPTY_BOX_CLASS} w-full flex-col items-center justify-center gap-1 overflow-hidden rounded-xl px-6 text-center`}
        data-qa="site-note-empty"
        role="status"
      >
        <LuImagePlus className="text-muted-foreground size-6" aria-hidden="true" />
        <p className="text-sm font-medium">No photos in this note</p>
        <p className="text-muted-foreground text-xs">Tap Camera or Gallery below to add one.</p>
      </div>
    );
  }

  return (
    <div
      className={`bg-muted-soft flex ${PREVIEW_BOX_CLASS} w-full items-center justify-center overflow-hidden rounded-xl`}
      data-qa="site-note-preview"
    >
      {/* object-contain, never object-cover: a cropped preview would hide the
          edge of the frame the engineer is checking. */}
      <img
        src={attachment.previewUrl}
        alt={`Unit ${unitNumber}, ${attachment.filename}`}
        className="size-full object-contain"
      />
    </div>
  );
}
