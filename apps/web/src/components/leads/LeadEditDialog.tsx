'use client';

// LeadEditDialog - edit a lead from the inbox row actions (autoplan
// 2026-09-07, plan §2). Editable surface is name / email / phone
// (D15/D10): notes was dropped because the Lead model has no notes
// column and the service silently drops the field - shipping a notes
// input would fake persistence (TODOS.md T-NOTES tracks the column).
//
// Two-API convention: props API `<Dialog open onOpenChange header footer>`
// wraps a separately-exported `LeadEditFormBody` - the named export is
// the repo's Dialog/jsdom rule (Base UI portals render empty under
// renderToStaticMarkup, so tests target the body, not the portal).
//
// Form is the props-API Form (data-driven `fields`); validation is
// server-side (UpdateLeadDto Zod) - the form only runs HTML `required`.
// Phone uniqueness violations surface the server's 409 message verbatim.
//
// Footer pattern (library canonical, mirrors WhatsappUnknownContactConvertModal
// + ScheduleVisitDialog): the Cancel + Save actions live in the Dialog
// footer, NOT the Form's own action section. The Save button is
// `type="submit" form="lead-edit-form"` so clicking it invokes the Form's
// submit (native <button form=...> association). The Form's internal
// submit/reset buttons are hidden so actions aren't duplicated.
import { useEffect } from 'react';

import { Button, Dialog, Form, toast } from '@paalstack/react-ui';
import { useForm } from 'react-hook-form';

import { useUpdateLead } from '@/hooks/queries/crm';

const FORM_ID = 'lead-edit-form';

type LeadEditFormValues = {
  name: string;
  phone: string;
  email: string;
};

/** Minimal lead shape the dialog needs (from the inbox row). */
export type LeadEditTarget = {
  id: string;
  name: string;
  phone: string;
  email?: string | null;
};

export type LeadEditDialogProps = {
  lead: LeadEditTarget | null;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onSaved?: () => void;
};

/**
 * The form body, exported for tests (jsdom portal rule: render THIS
 * with renderToStaticMarkup; the Dialog shell + footer are covered by
 * the parent's render flow). Owns only the form markup - the mutation
 * lives in the Dialog shell so the footer can read isPending.
 */
export function LeadEditFormBody({
  lead,
  onSubmit,
}: {
  lead: LeadEditTarget;
  onSubmit: (values: LeadEditFormValues) => void;
}) {
  const form = useForm<LeadEditFormValues>({
    defaultValues: {
      name: lead.name,
      phone: lead.phone,
      email: lead.email ?? '',
    },
    mode: 'onSubmit',
  });

  return (
    <Form
      id={FORM_ID}
      form={form}
      onSubmit={onSubmit}
      // The Save action lives in the Dialog footer (linked via
      // form={FORM_ID} + type="submit" on the footer button); hide the
      // Form's own action buttons so the submit isn't duplicated.
      hideSubmitButton
      hideResetButton
      fields={[
        {
          type: 'input',
          name: 'name',
          label: 'Full name',
          required: true,
          placeholder: 'Enter full name',
          inputProps: {
            maxLength: 120,
            'data-qa': 'lead-edit-name',
            autoComplete: 'name',
          },
        },
        {
          type: 'input',
          name: 'phone',
          label: 'Phone',
          required: true,
          inputType: 'tel',
          placeholder: 'Enter phone number',
          description: 'Indian numbers: 10 digits, optional +91 prefix.',
          inputProps: {
            inputMode: 'numeric',
            'data-qa': 'lead-edit-phone',
          },
        },
        {
          type: 'input',
          name: 'email',
          label: 'Email',
          inputType: 'email',
          placeholder: 'Enter email address',
          description: 'Optional. Used for booking confirmations.',
          inputProps: {
            'data-qa': 'lead-edit-email',
            autoComplete: 'email',
          },
        },
      ]}
    />
  );
}

/**
 * Controlled edit dialog. `lead === null` renders nothing (the inbox
 * holds the currently-editing row in state; null = closed).
 */
export function LeadEditDialog({
  lead,
  open,
  onOpenChange,
  onSaved,
}: LeadEditDialogProps) {
  const updateLead = useUpdateLead(lead?.id ?? null);
  const pending = updateLead.isPending;

  const form = useForm<LeadEditFormValues>({
    defaultValues: {
      name: lead?.name ?? '',
      phone: lead?.phone ?? '',
      email: lead?.email ?? '',
    },
    mode: 'onSubmit',
  });

  // Reset RHF defaults when a different lead opens - stale values from
  // a previous edit must never leak into the next dialog (plan §4
  // interaction edge: prefilled from the row, every time).
  useEffect(() => {
    if (open && lead !== null) {
      form.reset({
        name: lead.name,
        phone: lead.phone,
        email: lead.email ?? '',
      });
    }
    // form is stable (useForm); lead identity drives the reset. The
    // react-hooks plugin is not configured in this repo, so no
    // exhaustive-deps suppression is needed.
  }, [open, lead?.id]);

  if (lead === null) return null;
  const target = lead;

  function handleSubmit(values: LeadEditFormValues) {
    updateLead.mutate(
      {
        id: target.id,
        name: values.name.trim(),
        phone: values.phone.replace(/\D/g, ''),
        ...(values.email.trim().length > 0
          ? { email: values.email.trim().toLowerCase() }
          : { email: null }),
      },
      {
        onSuccess: () => {
          toast.success('Lead updated');
          onOpenChange(false);
          onSaved?.();
        },
        onError: (error) => {
          // Server validation + unique-violation messages come through
          // verbatim (BFF forwards the Zod/409 message).
          const msg = error instanceof Error ? error.message : 'Update failed';
          toast.error(msg);
        },
      },
    );
  }

  return (
    <Dialog
      open={open}
      onOpenChange={onOpenChange}
      header={{ title: 'Edit lead', description: "Edit the lead's name, phone, and email." }}
      footer={
        <div className="flex w-full justify-end gap-2">
          <Button
            type="button"
            variant="ghost"
            onClick={() => onOpenChange(false)}
            disabled={pending}
            data-qa="lead-edit-cancel"
          >
            Cancel
          </Button>
          <Button
            type="submit"
            form={FORM_ID}
            isLoading={pending}
            loadingText="Saving…"
            data-qa="lead-edit-save"
          >
            Save changes
          </Button>
        </div>
      }
    >
      <LeadEditFormBody lead={lead} onSubmit={handleSubmit} />
    </Dialog>
  );
}
