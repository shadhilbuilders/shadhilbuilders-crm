'use client';

// ProjectOptionManageDialog - add a facing/BHK option to a project
// (MANAGER/ADMIN/OWNER only).
//
// Add-only (options are categorical labels; renaming a facing/BHK doesn't
// make sense - the user confirmed this). ONE `useForm` instance per dialog
// (user-mandated), zod-validated, the body passed the form as a prop.
import { useEffect } from 'react';
import type { UseFormReturn } from 'react-hook-form';

import { Button, Dialog, Form, toast } from '@paalstack/react-ui';
import { useForm } from 'react-hook-form';
import { z } from 'zod';
import { zodResolver } from '@hookform/resolvers/zod';

import { useCreateProjectOption } from '@/hooks/queries/inventory';

const FORM_ID = 'project-option-manage-form';

const optionFormSchema = z.object({
  value: z
    .string()
    .trim()
    .min(1, 'Value is required')
    .max(40, 'Value must be 40 characters or fewer'),
});
type OptionFormValues = z.infer<typeof optionFormSchema>;

export type OptionType = 'FACING' | 'BHK';

function typeLabel(type: OptionType): string {
  return type === 'FACING' ? 'facing' : 'BHK';
}

export type ProjectOptionManageDialogProps = {
  type: OptionType;
  projectId: string | null;
  open: boolean;
  onOpenChange: (open: boolean) => void;
};

/**
 * The form body, exported for tests (jsdom portal rule: render THIS with
 * renderToStaticMarkup; the Dialog shell + footer are covered by the
 * parent's render flow). Receives the Dialog's single `useForm` instance
 * as a prop - it does NOT create its own.
 */
export function OptionFormBody({
  form,
  type,
  onSubmit,
}: {
  form: UseFormReturn<OptionFormValues>;
  type: OptionType;
  onSubmit: (values: OptionFormValues) => void;
}) {
  const label = typeLabel(type).charAt(0).toUpperCase() + typeLabel(type).slice(1);
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
          name: 'value',
          label: `${label} value`,
          required: true,
          placeholder: type === 'FACING' ? 'e.g. North-East' : 'e.g. 6',
          inputProps: {
            maxLength: 40,
            'data-qa': `option-${type.toLowerCase()}-value`,
          },
        },
      ]}
    />
  );
}

export function ProjectOptionManageDialog({
  type,
  projectId,
  open,
  onOpenChange,
}: ProjectOptionManageDialogProps) {
  const createOption = useCreateProjectOption();
  const pending = createOption.isPending;
  const label = typeLabel(type);

  const form = useForm<OptionFormValues>({
    resolver: zodResolver(optionFormSchema),
    defaultValues: { value: '' },
    mode: 'onSubmit',
  });

  // Reset on open so a stale value from a previous add never leaks in.
  useEffect(() => {
    if (open) form.reset({ value: '' });
  }, [open, type]);

  if (projectId === null) return null;
  const pid = projectId;

  function handleSubmit(values: OptionFormValues) {
    const value = values.value.trim();
    createOption.mutate(
      { projectId: pid, type, value },
      {
        onSuccess: () => {
          toast.success(`${label} "${value}" added`);
          onOpenChange(false);
        },
        onError: (error) => {
          const msg = error instanceof Error ? error.message : 'Add failed';
          toast.error(msg);
        },
      },
    );
  }

  return (
    <Dialog
      open={open}
      onOpenChange={onOpenChange}
      header={{
        title: `Add ${label}`,
        description: `Add a ${label} value to this project's pickers.`,
      }}
      contentClassName='sm:max-w-lg'
      footer={
        <div className="flex w-full justify-end gap-2">
          <Button
            type="button"
            variant="outline"
            onClick={() => onOpenChange(false)}
            disabled={pending}
            data-qa="option-manage-cancel"
          >
            Cancel
          </Button>
          <Button
            type="submit"
            form={FORM_ID}
            isLoading={pending}
            loadingText="Saving..."
            data-qa="option-manage-save"
          >
            Add {label}
          </Button>
        </div>
      }
    >
      <OptionFormBody form={form} type={type} onSubmit={handleSubmit} />
    </Dialog>
  );
}
