'use client';

// NoteDialog (2026-11-09): the one screen between "I shot it" and "it is on the
// record". Replaces the bottom Sheet with a Dialog - the Sheet read as a sales
// surface, while this is a form with a photo strip, and a dialog anchored to the
// bottom on a phone / centred on a desktop behaves the same everywhere.
//
// Three things the engineer does here, in thumb order:
//   1. check the shots, and add more WITHOUT leaving - the Camera and Gallery
//      tiles live inside the strip, so ten photos can arrive in three separate
//      picks and still be saved together (or in separate saves),
//   2. pick the STAGE (what changed, in one of nine words) - a `Select`, because
//      nine stages plus "not set" do not fit a phone width as chips,
//   3. write the NOTE (the line the customer reads).
//
// Details that are deliberate:
//   - every photo is an `Attachment` (see NoteAttachments.tsx): the media is the
//     preview, the description carries the size and the upload state.
//   - the textarea is `text-base` (16px). Anything smaller makes iOS Safari zoom
//     the page on focus, which on a phone in the field looks broken.
//   - it is never autofocused. The keyboard covering the photo you are checking
//     against is worse than one tap.
//   - the quick notes are SUGGESTIONS under the note field, not a field of their
//     own: tapping one APPENDS A LINE to the textarea. The textarea stays the
//     single source of truth and stays freely editable.
//   - an empty note is VALID: the server falls back to its generated caption.
//   - the dialog cannot be dismissed while saving, so a half-saved batch can
//     never look finished.
import { useEffect, useRef, useState } from 'react';

import {
  AlertDialog,
  AttachmentGroup,
  Badge,
  Button,
  Dialog,
  DialogFooter,
  FieldLabel,
  FieldRoot,
  Select,
  Spinner,
  Textarea,
} from '@paalstack/react-ui';
import { LuCamera, LuImagePlus } from '@paalstack/react-icons/lu';

import { CONSTRUCTION_STAGE_ORDER, constructionStageLabel } from '@/lib/labels';
import { quickNoteSlug, QUICK_NOTE_LABELS } from '@/lib/site-photos';

import {
  AddAttachmentTile,
  NotePreview,
  PhotoAttachmentTile,
  type NoteAddSource,
  type NoteAttachment,
} from './NoteAttachments';

// The tile components and their types live in NoteAttachments.tsx; re-exported
// so callers import the dialog and its tiles from one place.
export {
  EMPTY_BOX_CLASS,
  PREVIEW_BOX_CLASS,
  type NoteAddSource,
  type NoteAttachment,
  type NoteAttachmentStatus,
} from './NoteAttachments';

const NOTE_MAX = 200;

/** The dialog is a composer, not a library: one note covers a small set. */
export const MAX_NOTE_PHOTOS = 8;

/**
 * The stage picker's "no stage" value.
 *
 * A `Select` needs a real option for the empty state, and base-ui hands back
 * `null` for "cleared" — but "" is also a legitimate `value` for an option, so
 * the sentinel has to be a string that can never collide with an enum value.
 * Exported because it is part of the picker's contract, not an implementation
 * detail.
 */
export const STAGE_UNSET = '__unset__';

/** The nine stages in enum order, preceded by the explicit "not set". */
export const STAGE_PICKER_OPTIONS: { value: string; label: string }[] = [
  { value: STAGE_UNSET, label: 'Stage not set' },
  ...CONSTRUCTION_STAGE_ORDER.map((value) => ({
    value,
    label: constructionStageLabel(value),
  })),
];

/**
 * The dialog's title and description.
 *
 * Pure and exported because base-ui portals the dialog body into document.body:
 * a static-markup test can assert the words here, but can never see the header.
 */
export function noteDialogHeading(
  photoCount: number,
  unitNumber: string,
  phaseName: string
): { title: string; description: string } {
  if (photoCount > 1) {
    return {
      title: `${photoCount} photos · Unit ${unitNumber} · ${phaseName}`,
      description: 'One note and one stage apply to every photo in this set.',
    };
  }
  if (photoCount === 0) {
    return {
      title: 'Add photos',
      description: `Unit ${unitNumber} · ${phaseName}`,
    };
  }
  return {
    title: 'What did you shoot?',
    description: `Unit ${unitNumber} · ${phaseName}`,
  };
}

/**
 * Mobile: a bottom-anchored panel that can never outgrow the viewport, with the
 * save action in thumb reach. `sm:`: the library's centred dialog.
 *
 * The three grid rows are header / scrollable body / sticky footer, so the note
 * field scrolls under a fixed action instead of pushing Save off-screen.
 */
export const NOTE_DIALOG_CONTENT_CLASS =
  'top-auto right-0 bottom-0 left-0 max-h-[92dvh] max-w-none translate-x-0 translate-y-0 grid-rows-[auto_minmax(0,1fr)_auto] gap-0 overflow-hidden rounded-b-none p-0 pb-[env(safe-area-inset-bottom)] sm:top-1/2 sm:right-auto sm:bottom-auto sm:left-1/2 sm:max-w-lg sm:-translate-x-1/2 sm:-translate-y-1/2 sm:rounded-xl sm:pb-0';

/** The library's close button is 28px; a 44px target is the floor on a phone. */
const DIALOG_CLOSE_CLASS =
  '[&>[data-slot=dialog-close]]:size-11 [&>[data-slot=dialog-close]]:top-1 [&>[data-slot=dialog-close]]:right-1';

/** What the save button says for a given number of unsent photos. */
export function noteSaveLabel(pendingCount: number): string {
  return pendingCount > 1 ? `Save ${pendingCount} photos` : 'Save photo';
}

/**
 * The discard confirmation's heading.
 *
 * Pure and exported so the copy is testable and cannot drift from the behaviour.
 * Discard throws away photos that were never sent - they are held in memory until
 * Save - so the wording names that, and nothing about the server.
 */
export function discardTitle(pendingCount: number): string {
  return pendingCount > 1 ? 'Discard these photos?' : 'Discard this photo?';
}

/** The discard confirmation's body, worded for what Discard actually does. */
export function discardDescription(pendingCount: number): string {
  return pendingCount > 1
    ? `${pendingCount} photos have not been saved yet. Closing this note throws them away.`
    : 'This photo has not been saved yet. Closing this note throws it away.';
}

export type NoteDialogBodyProps = {
  unitNumber: string;
  attachments: readonly NoteAttachment[];
  /** Files picked inside the dialog - camera or gallery, any number of times. */
  onAddFiles: (files: File[], source: NoteAddSource) => void;
  onRemoveAttachment: (id: string) => void;
  /** True while a picked file is being converted to WebP. */
  isPreparing: boolean;
  isSaving: boolean;
  note: string;
  onNoteChange: (next: string) => void;
  /** Selected quick-note lines, derived by the caller from the note text. */
  selectedChips: readonly string[];
  onToggleChip: (label: string, selected: boolean) => void;
  stage: string | null;
  onStageChange: (next: string | null) => void;
  isOffline: boolean;
};

export type NoteDialogProps = NoteDialogBodyProps & {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** Shown in the dialog's title/description, not in the body. */
  phaseName: string;
  onSave: () => void;
};

export function NoteDialogBody({
  unitNumber,
  attachments,
  onAddFiles,
  onRemoveAttachment,
  isPreparing,
  isSaving,
  note,
  onNoteChange,
  selectedChips,
  onToggleChip,
  stage,
  onStageChange,
  isOffline,
}: NoteDialogBodyProps) {
  const galleryInputRef = useRef<HTMLInputElement | null>(null);
  const cameraInputRef = useRef<HTMLInputElement | null>(null);
  // A ref on the BODY, not on AttachmentGroup: the group does not forward a ref.
  const bodyRef = useRef<HTMLDivElement | null>(null);
  const [focusedId, setFocusedId] = useState<string | null>(null);

  // The LAST photo added is what the engineer wants to check; a tap on another
  // tile overrides that. Derived, so removing the focused tile cannot strand it.
  const last = attachments[attachments.length - 1];
  const focused = attachments.find((attachment) => attachment.id === focusedId) ?? last ?? null;
  const canAdd = !isSaving && !isPreparing && attachments.length < MAX_NOTE_PHOTOS;

  // Adding a photo appends it to the END of a horizontally scrolling strip, so
  // without this it can land off-screen and read as "nothing happened". Bring the
  // NEW photo (not the strip's end, which is the add tiles) into view.
  // Keyed on the count: a status change must not re-scroll it.
  const photoCount = attachments.length;
  const lastId = last?.id ?? null;
  useEffect(() => {
    const body = bodyRef.current;
    if (photoCount === 0 || body === null || lastId === null) return;
    const group = body.querySelector<HTMLElement>('[data-qa="site-note-attachments"]');
    const tile = body.querySelector<HTMLElement>(`[data-attachment-id="${lastId}"]`);
    if (group === null || tile === null) return;
    // Scroll the STRIP to the end: the newest photo sits just before the two add
    // tiles, so this brings it into view instead of leaving it off the right edge.
    // Two Chromium behaviours have to be worked around: `scrollIntoView` decides
    // by itself which ancestor scrolls (the dialog popup is one too), and the
    // strip is `snap-mandatory` — it re-snaps to an arbitrary point once the new
    // tile changes the content width. So: suspend snapping for exactly one frame,
    // set the position, then hand snapping back.
    group.style.scrollSnapType = 'none';
    group.scrollLeft = group.scrollWidth;
    const id = setTimeout(() => {
      group.style.removeProperty('scroll-snap-type');
    }, 0);
    return () => {
      clearTimeout(id);
      group.style.removeProperty('scroll-snap-type');
    };
  }, [photoCount, lastId]);

  return (
    <div ref={bodyRef} className="space-y-5" data-qa="site-note-dialog-body">
      {/* Both pickers live INSIDE the dialog: the engineer adds photos without
          losing the note they were typing, and the camera stays the
          `capture="environment"` plain input an iPhone needs. */}
      <input
        ref={galleryInputRef}
        type="file"
        accept="image/*"
        multiple
        className="hidden"
        data-qa="site-note-gallery-input"
        onChange={(event) => {
          const files = Array.from(event.target.files ?? []);
          event.target.value = ''; // allow re-picking the same file
          if (files.length > 0) onAddFiles(files, 'gallery');
        }}
      />
      <input
        ref={cameraInputRef}
        type="file"
        accept="image/*"
        capture="environment"
        className="hidden"
        data-qa="site-note-camera-input"
        onChange={(event) => {
          const file = event.target.files?.[0];
          event.target.value = '';
          if (file !== undefined) onAddFiles([file], 'camera');
        }}
      />

      <NotePreview attachment={focused} unitNumber={unitNumber} />

      <section className="space-y-2" aria-labelledby="site-note-photos-heading">
        <div className="flex items-baseline justify-between gap-3">
          <p id="site-note-photos-heading" className="text-sm font-medium">
            Photos
          </p>
          <p className="text-muted-foreground text-xs tabular-nums" aria-live="polite">
            {attachments.length} of {MAX_NOTE_PHOTOS}
          </p>
        </div>
        <AttachmentGroup
          role="group"
          aria-label="Photos in this note"
          data-qa="site-note-attachments"
          className="pl-1"
        >
          {attachments.map((attachment) => (
            <PhotoAttachmentTile
              key={attachment.id}
              attachment={attachment}
              isFocused={focused !== null && focused.id === attachment.id}
              canEdit={!isSaving}
              onFocus={() => setFocusedId(attachment.id)}
              onRemove={() => onRemoveAttachment(attachment.id)}
            />
          ))}
          <AddAttachmentTile
            icon={<LuCamera className="size-5" aria-hidden="true" />}
            title="Camera"
            description="Shoot now"
            label="Take another photo"
            testId="site-note-add-camera"
            disabled={!canAdd}
            onSelect={() => cameraInputRef.current?.click()}
          />
          <AddAttachmentTile
            icon={<LuImagePlus className="size-5" aria-hidden="true" />}
            title="Gallery"
            description="Pick photos"
            label={`Add photos from the gallery (${attachments.length} of ${MAX_NOTE_PHOTOS} added)`}
            testId="site-note-add-gallery"
            disabled={!canAdd}
            onSelect={() => galleryInputRef.current?.click()}
          />
        </AttachmentGroup>
      </section>

      {isPreparing ? (
        <p
          className="text-muted-foreground flex items-center gap-2 text-sm"
          data-qa="site-note-preparing"
          role="status"
          aria-live="polite"
        >
          <Spinner className="size-4" aria-hidden="true" /> Preparing photo...
        </p>
      ) : null}

      {/* Stage first: "what changed" is the question the engineer can answer in
          one pick, and the note then explains it.
          `Select`, not a chip row: nine enum values plus "not set" do not fit a
          phone's width without a horizontal scroll that hides the last stages. */}
      <div data-qa="site-stage-picker">
        <Select
          value={stage ?? STAGE_UNSET}
          onValueChange={(next) =>
            // "Not set" is a real answer, not a missing one: it must never
            // silently become NOT_STARTED.
            onStageChange(next === null || next === STAGE_UNSET ? null : next)
          }
          options={STAGE_PICKER_OPTIONS}
          label="Construction stage"
          labelProps={{ 'data-qa': 'site-stage-label' }}
          placeholder="Stage not set"
        />
      </div>

      <FieldRoot className="gap-1.5">
        <FieldLabel htmlFor="site-note-input">Note for the Customer</FieldLabel>
        <Textarea
          id="site-note-input"
          // 16px minimum: anything smaller makes iOS Safari zoom on focus.
          className="text-sm"
          rows={3}
          maxLength={NOTE_MAX}
          value={note}
          onValueChange={onNoteChange}
          placeholder="Plinth poured, curing until Friday"
          // Never autofocused: the keyboard would cover the photo.
          aria-describedby="site-note-helper"
          data-qa="site-note-input"
        />
        <div className="flex items-start justify-between gap-3">
          <p id="site-note-helper" className="text-muted-foreground text-xs">
            This is the line the customer reads in their portal. Keep it short.
          </p>
          <p
            className="text-muted-foreground text-xs tabular-nums"
            data-qa="site-note-counter"
            aria-live="polite"
          >
            {note.length}/{NOTE_MAX}
          </p>
        </div>
        {/* Suggestions, not a field: tapping one appends that line to the note
            above, and the textarea stays the single source of truth.
            The BADGE is purely visual; the hit area is the plain button AROUND
            it. A badge is 20px tall by design, well under the 44px touch floor,
            and padding the badge itself would change how it looks. Wrapping it
            keeps the badge exactly as the library draws it while giving a gloved
            thumb a full-height target.
            Selection is carried by the badge variant (`default` when on,
            `outline` when off) AND by `aria-pressed` on the button, so meaning
            is never colour alone.
            The wrapper is a scroll container: six labels are wider than a phone,
            so they scroll sideways instead of being clipped by the dialog edge. */}
        <div
          className="-mx-1 flex gap-1.5 overflow-x-auto px-1"
          role="group"
          aria-label="Quick notes"
          data-qa="site-note-quick-picker"
        >
          {QUICK_NOTE_LABELS.map((label) => {
            const isSelected = selectedChips.includes(label);
            return (
              <button
                key={label}
                type="button"
                aria-pressed={isSelected}
                aria-label={`${isSelected ? 'Remove' : 'Add'} ${label} from the note`}
                onClick={() => onToggleChip(label, !isSelected)}
                // `min-h-11` is the whole point of the wrapper; `rounded-full`
                // and the focus ring match the badge's pill so the outline does
                // not read as a second shape.
                className="focus-visible:outline-ring flex min-h-11 shrink-0 items-center rounded-full focus-visible:outline-2 focus-visible:outline-offset-2"
                data-qa={`site-note-chip-${quickNoteSlug(label)}`}
              >
                <Badge variant={isSelected ? 'default' : 'outline'}>{label}</Badge>
              </button>
            );
          })}
        </div>
      </FieldRoot>

      {isOffline ? (
        <p className="text-destructive text-sm" role="status" data-qa="site-note-offline">
          You&apos;re offline. Saving needs a connection.
        </p>
      ) : null}
    </div>
  );
}

export function NoteDialog({
  open,
  onOpenChange,
  onSave,
  attachments,
  isSaving,
  isOffline,
  unitNumber,
  phaseName,
  ...body
}: NoteDialogProps) {
  const heading = noteDialogHeading(attachments.length, unitNumber, phaseName);
  const pendingCount = attachments.filter(
    (attachment) => attachment.status === 'ready' || attachment.status === 'failed'
  ).length;
  const saveLabel = noteSaveLabel(pendingCount);

  // Opening the dialog must not paint a focus ring on anything. Left to its
  // default, the primitive moves focus to the FIRST TABBABLE control inside the
  // popup, and a programmatically focused button matches `:focus-visible` - so
  // the dialog arrived with the photo tile (or the close button) already ringed,
  // which reads as "you have already touched this". The POPUP becomes the first
  // focus target instead (base-ui does the same on touch): it is `outline-none`
  // by design, so nothing is drawn, and its title/description are still
  // announced to a screen reader.
  //
  // Typed as a local object rather than inline: `dialogContentProps` is declared
  // `ComponentPropsWithoutRef`, but React 19 hands `ref` through as an ordinary
  // prop and base-ui forwards it to the popup <div>.
  const popupRef = useRef<HTMLDivElement | null>(null);
  const dialogSurfaceProps = { ref: popupRef, initialFocus: popupRef };

  // The discard confirmation. Unsent photos live only in memory, so closing the
  // note without saving loses them outright - worth one question, never a silent
  // loss.
  const [confirmDiscard, setConfirmDiscard] = useState(false);

  // Opening the note again must not inherit a stale confirmation from the
  // previous one.
  useEffect(() => {
    if (!open) setConfirmDiscard(false);
  }, [open]);

  /**
   * EVERY dismissal goes through here - the X, Escape, an outside press and the
   * Cancel button - so they cannot disagree about whether to ask.
   *
   * Unsent photos are the whole risk: they live only in memory until Save POSTs
   * them, so closing the note loses them outright. A failed tile is still
   * retryable in place, so it counts too.
   */
  const requestClose = (next: boolean): void => {
    if (next) {
      onOpenChange(true);
      return;
    }
    // Dismissing mid-upload would hide a batch that is still landing.
    if (isSaving) return;
    if (pendingCount > 0) {
      setConfirmDiscard(true);
      return;
    }
    onOpenChange(false);
  };

  return (
    <Dialog
      open={open}
      onOpenChange={requestClose}
      header={heading}
      contentClassName={`${NOTE_DIALOG_CONTENT_CLASS} ${DIALOG_CLOSE_CLASS}`}
      dialogContentProps={dialogSurfaceProps}
      dialogHeaderProps={{ className: 'gap-1 border-b px-4 pt-4 pr-14 pb-3' }}
    >
      {/* Row 2 of the grid: the only scrolling surface, so the header and the
          save action stay put while the note is being typed. */}
      <div className="min-h-0 overflow-y-auto overscroll-contain px-4 py-4">
        <NoteDialogBody
          {...body}
          unitNumber={unitNumber}
          attachments={attachments}
          isSaving={isSaving}
          isOffline={isOffline}
        />
      </div>

      {/* Row 3: the library's `DialogFooter`, at its own styling. The ONLY
          override is `mx-0 mb-0`: the library assumes a `p-4` popup and pulls
          itself out by 16px on each side, but this dialog is deliberately
          `p-0` (full-bleed header, photo strip and bar), so those negative
          margins would push the bar 16px past the clipped edge. Everything
          else - column-reverse stacking on a phone, right alignment from `sm:`,
          the top border - is the library's and is left alone.
          `Cancel` asks first when unsent photos would be lost. */}
      <DialogFooter className="mx-0 mb-0" data-qa="site-note-dialog-footer">
        <Button
          type="button"
          variant="outline"
          onClick={() => requestClose(false)}
          disabled={isSaving}
          data-qa="site-note-cancel"
        >
          Cancel
        </Button>
        <Button
          type="button"
          onClick={onSave}
          // Disabled ONLY while saving, while offline (there is no queue to fall
          // back on), and when there is nothing left to send.
          disabled={isSaving || isOffline || pendingCount === 0}
          isLoading={isSaving}
          loadingText="Saving..."
          data-qa="site-save-photo"
        >
          {saveLabel}
        </Button>
      </DialogFooter>

      {/* The confirmation is a nested AlertDialog: base-ui tracks nested dialogs
          (the parent's `nestedOpenDialogCount`), so this opens on top with its
          own focus trap rather than fighting the note dialog's. Its "Discard"
          closes the note through the same `onOpenChange`, so the page still owns
          the rule about what is thrown away. */}
      <AlertDialog
        open={confirmDiscard}
        onOpenChange={(next) => {
          if (!next) setConfirmDiscard(false);
        }}
        trigger={null}
        header={{
          title: discardTitle(pendingCount),
          description: discardDescription(pendingCount),
        }}
        cancelButtonText="Keep editing"
        confirmButtonText="Discard"
        onCancel={() => setConfirmDiscard(false)}
        onConfirm={() => {
          setConfirmDiscard(false);
          onOpenChange(false);
        }}
        confirmButtonProps={{ variant: 'destructive' }}
      />
    </Dialog>
  );
}
