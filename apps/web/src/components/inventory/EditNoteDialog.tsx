'use client';

// EditNoteDialog: edit a photo's note in a dialog (replaces the old inline
// input on the row, which was cramped on a phone).
//
// The rule lives in ONE zod schema: the note is required once trimmed and capped
// at NOTE_MAX_LENGTH. `zodResolver` validates before submit, so a blank or
// over-long note never reaches the mutation. The mutation, its toasts and the
// server-error message are the same as before - only the surface changed.
import { useEffect } from 'react';

import { zodResolver } from '@hookform/resolvers/zod';
import { Button, Dialog, Form, toast } from '@paalstack/react-ui';
import type { FormFieldItemType } from '@paalstack/react-ui';
import { useForm } from 'react-hook-form';
import { z } from 'zod';

import { ConstructionStageSchema, type ConstructionStage } from '@shadhil/api-types';

import { useUpdatePhoto } from '@/hooks/queries/customer-progress';
import { CONSTRUCTION_STAGE_ORDER, constructionStageLabel } from '@/lib/labels';

export const NOTE_MAX_LENGTH = 200;

export const editNoteSchema = z.object({
  caption: z
    .string()
    .trim()
    .min(1, 'Write a note for this photo')
    .max(NOTE_MAX_LENGTH, `Keep the note under ${NOTE_MAX_LENGTH} characters`),
  // '' = no stage recorded. The server can correct a stage but not clear one,
  // so there is deliberately no "unset" option to pick once a stage exists.
  stage: z.union([ConstructionStageSchema, z.literal('')]),
});

const STAGE_OPTIONS = CONSTRUCTION_STAGE_ORDER.map((value) => ({
  value,
  label: constructionStageLabel(value),
}));

export type EditNoteValues = z.infer<typeof editNoteSchema>;

const FORM_ID = 'edit-note-form';

export type EditNoteDialogProps = {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  photoId: string;
  unitId: string;
  caption: string;
  /** The photo's current stage; null when none was recorded. */
  stage: ConstructionStage | null;
};

export function EditNoteDialog({
  open,
  onOpenChange,
  photoId,
  unitId,
  caption,
  stage,
}: EditNoteDialogProps) {
  const update = useUpdatePhoto(unitId);
  const form = useForm<EditNoteValues>({
    resolver: zodResolver(editNoteSchema),
    defaultValues: { caption, stage: stage ?? '' },
    mode: 'onSubmit',
  });

  // `defaultValues` is read once at mount: re-seed each time the dialog opens so
  // an abandoned edit never leaks into the next one.
  useEffect(() => {
    if (open) form.reset({ caption, stage: stage ?? '' });
  }, [open, caption, stage, form]);

  const onSubmit = (values: EditNoteValues): void => {
    update.mutate(
      {
        photoId,
        caption: values.caption,
        // Sent only when it actually changed, so a note-only edit stays a
        // note-only write.
        ...(values.stage !== '' && values.stage !== stage ? { stage: values.stage } : {}),
      },
      {
        onSuccess: () => {
          onOpenChange(false);
          toast.success('Caption updated');
        },
        onError: (error: unknown) =>
          toast.error(error instanceof Error ? error.message : 'Could not update the caption'),
      },
    );
  };

  const fields: FormFieldItemType<EditNoteValues>[] = [
    {
      type: 'select',
      name: 'stage',
      label: 'Construction stage',
      placeholder: 'Stage not set',
      options: STAGE_OPTIONS,
      selectProps: { 'data-qa': 'edit-note-stage' },
    },
    {
      type: 'textarea',
      name: 'caption',
      label: 'Note',
      required: true,
      placeholder: 'What does this photo show?',
      textareaProps: {
        rows: 4,
        'data-qa': 'edit-note-input',
      },
    },
  ];

  return (
    <Dialog
      trigger={null}
      open={open}
      onOpenChange={onOpenChange}
      header={{ title: 'Edit note', description: 'What does this photo show?' }}
      contentClassName="sm:max-w-md"
      footer={
        <div className="flex w-full justify-end gap-2">
          <Button
            type="button"
            variant="outline"
            onClick={() => onOpenChange(false)}
            data-qa="edit-note-cancel"
          >
            Cancel
          </Button>
          <Button
            type="submit"
            form={FORM_ID}
            isLoading={update.isPending}
            loadingText="Saving..."
            data-qa="edit-note-save"
          >
            Save
          </Button>
        </div>
      }
    >
      <Form
        id={FORM_ID}
        form={form}
        onSubmit={onSubmit}
        hideSubmitButton
        hideResetButton
        fields={fields}
      />
    </Dialog>
  );
}
