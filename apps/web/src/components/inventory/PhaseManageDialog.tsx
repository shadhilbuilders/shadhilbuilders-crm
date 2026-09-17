'use client';

// PhaseManageDialog - create or rename a phase (MANAGER/ADMIN/OWNER only).
//
// Two-API convention: props API `<Dialog open onOpenChange header footer>`
// wraps a separately-exported `PhaseFormBody` - the named export is the
// repo's Dialog/jsdom rule (Base UI portals render empty under
// renderToStaticMarkup, so tests target the body, not the portal).
//
// ONE `useForm` instance per dialog (user-mandated): the Dialog shell owns
// it (it needs form.reset on open + handleSubmit); the body is a pure
// presentational component that receives `form` as a prop and renders the
// `<Form>` fields. Validation is zod (zodResolver) - the name field is
// required + trimmed + length-capped, mirroring the shared
// CreatePhaseDtoSchema / UpdatePhaseDtoSchema.
//
// `phase === null` = create mode (needs projectId); `phase` set = rename
// mode. The mutation lives in the Dialog shell so the footer can read
// isPending.
import { useEffect } from 'react';
import type { UseFormReturn } from 'react-hook-form';

import { Button, Dialog, Form, toast } from '@paalstack/react-ui';
import { useForm } from 'react-hook-form';
import { z } from 'zod';
import { zodResolver } from '@hookform/resolvers/zod';

import {
  useCreatePhase,
  useUpdatePhase,
} from '@/hooks/queries/inventory';

const FORM_ID = 'phase-manage-form';

const phaseFormSchema = z.object({
  name: z
    .string()
    .trim()
    .min(1, 'Phase name is required')
    .max(80, 'Phase name must be 80 characters or fewer'),
});
type PhaseFormValues = z.infer<typeof phaseFormSchema>;

/** Minimal phase shape the dialog needs (from the phases list). */
export type PhaseManageTarget = {
  id: string;
  name: string;
};

export type PhaseManageDialogProps = {
  /** null = create mode; set = rename mode. */
  phase: PhaseManageTarget | null;
  projectId: string | null;
  open: boolean;
  onOpenChange: (open: boolean) => void;
};

/**
 * The form body, exported for tests (jsdom portal rule: render THIS with
 * renderToStaticMarkup; the Dialog shell + footer are covered by the
 * parent's render flow). Receives the Dialog's single `useForm` instance
 * as a prop - it does NOT create its own (user-mandated: one form per
 * dialog). Owns only the form markup; the mutation lives in the shell.
 */
export function PhaseFormBody({
  form,
  onSubmit,
}: {
  form: UseFormReturn<PhaseFormValues>;
  onSubmit: (values: PhaseFormValues) => void;
}) {
  return (
    <Form
      id={FORM_ID}
      form={form}
      onSubmit={onSubmit}
      hideSubmitButton
      hideResetButton
      fields={[
        {
          type: 'input',
          name: 'name',
          label: 'Phase name',
          required: true,
          placeholder: 'e.g. Phase D',
          inputProps: {
            maxLength: 80,
            'data-qa': 'phase-name',
          },
        },
      ]}
    />
  );
}

/**
 * Controlled add/edit dialog. `phase === null` renders the create form
 * (projectId required); `phase` set renders the rename form. Owns the
 * single `useForm` instance (zod-validated) and the mutation.
 */
export function PhaseManageDialog({
  phase,
  projectId,
  open,
  onOpenChange,
}: PhaseManageDialogProps) {
  const createPhase = useCreatePhase();
  const updatePhase = useUpdatePhase();
  const pending = createPhase.isPending || updatePhase.isPending;
  const isEdit = phase !== null;

  const form = useForm<PhaseFormValues>({
    resolver: zodResolver(phaseFormSchema),
    defaultValues: { name: phase?.name ?? '' },
    mode: 'onSubmit',
  });

  // Reset RHF defaults when a different phase opens (or when switching
  // between create/rename) - stale values must never leak in.
  useEffect(() => {
    if (open) {
      form.reset({ name: phase?.name ?? '' });
    }
  }, [open, phase?.id]);

  if (!isEdit && projectId === null) return null;

  function handleSubmit(values: PhaseFormValues) {
    const name = values.name.trim();
    if (isEdit) {
      updatePhase.mutate(
        { id: phase.id, body: { name } },
        {
          onSuccess: () => {
            toast.success(`Phase renamed to ${name}`);
            onOpenChange(false);
          },
          onError: (error) => {
            const msg = error instanceof Error ? error.message : 'Rename failed';
            toast.error(msg);
          },
        },
      );
    } else {
      createPhase.mutate(
        { projectId: projectId as string, name },
        {
          onSuccess: () => {
            toast.success(`Phase ${name} created`);
            onOpenChange(false);
          },
          onError: (error) => {
            const msg = error instanceof Error ? error.message : 'Create failed';
            toast.error(msg);
          },
        },
      );
    }
  }

  return (
    <Dialog
      open={open}
      onOpenChange={onOpenChange}
      header={{
        title: isEdit ? `Rename phase ${phase.name}` : 'New phase',
        description: isEdit
          ? 'Update the phase name.'
          : 'Add a phase to this project.',
      }}
      contentClassName='sm:max-w-lg'
      footer={
        <div className="flex w-full justify-end gap-2">
          <Button
            type="button"
            variant="outline"
            onClick={() => onOpenChange(false)}
            disabled={pending}
            data-qa="phase-manage-cancel"
          >
            Cancel
          </Button>
          <Button
            type="submit"
            form={FORM_ID}
            isLoading={pending}
            loadingText="Saving..."
            data-qa="phase-manage-save"
          >
            {isEdit ? 'Save changes' : 'Create phase'}
          </Button>
        </div>
      }
    >
      <PhaseFormBody form={form} onSubmit={handleSubmit} />
    </Dialog>
  );
}
