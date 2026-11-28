'use client';

// LeadEditDialog - edit a lead from the inbox row actions (autoplan
// 2026-09-07, plan §2). Editable surface is name / email / phone
// (D15/D10) plus notes (T-NOTES, 2026-11-27 - the Lead.notes column now
// exists, so the textarea persists instead of faking it) and the budget band
// (T-LEAD-BUDGET, same date - a rep writes down what the buyer can spend while
// the call is fresh, and the band is what the pipeline filters on).
//
// Two-API convention: props API `<Dialog open onOpenChange header footer>`
// wraps a separately-exported `LeadEditFormBody` - the named export is
// the repo's Dialog/jsdom rule (Base UI portals render empty under
// renderToStaticMarkup, so tests target the body, not the portal).
//
// Form is the props-API Form (data-driven `fields`); the resolver runs the
// SAME phone rule the API does (shape + the country on the trigger) so a bad
// number reports under the field instead of as a toast. A phone refusal the
// SERVER alone can decide (a duplicate number) shows under the field too, with
// focus moved there, and still toasts.
//
// Footer pattern (library canonical, mirrors WhatsappUnknownContactConvertModal
// + ScheduleVisitDialog): the Cancel + Save actions live in the Dialog
// footer, NOT the Form's own action section. The Save button is
// `type="submit" form="lead-edit-form"` so clicking it invokes the Form's
// submit (native <button form=...> association). The Form's internal
// submit/reset buttons are hidden so actions aren't duplicated.
import { useEffect } from 'react';

import { Button, Dialog, Form, toast } from '@paalstack/react-ui';
import type { FormFieldItemType } from '@paalstack/react-ui';
import { zodResolver } from '@hookform/resolvers/zod';
import { useForm, type UseFormReturn } from 'react-hook-form';
import { z } from 'zod';

import { useUpdateLead } from '@/hooks/queries/crm';
import { LEAD_BUDGET_OPTIONS } from '@/lib/labels';
import {
  DEFAULT_PHONE_COUNTRY,
  PhoneCountrySchema,
  PhoneInputSchema,
  countryOfStored,
  phoneFieldErrorFromServer,
  refinePhonePair,
  toPhoneInputValue,
} from '@/lib/phone';
import { focusField } from '@/lib/form-focus';
import { IntlPhoneInput } from '@/components/shared/IntlPhoneInput';
import type { CountryCode } from '@shadhil/api-types/phone';
import { LEAD_BUDGET_BANDS, type LeadBudgetBand } from '@shadhil/api-types';

const FORM_ID = 'lead-edit-form';

type LeadEditFormValues = {
  name: string;
  phone: string;
  /** The country the number was typed in - sent beside `phone`. */
  // Optional to match the schema's output type exactly; the form seeds it on
  // mount and the picker keeps it set, so submit always has a country.
  phoneCountry?: CountryCode;
  email: string;
  notes: string;
  /**
   * The band, or '' for "nobody has asked". '' is a real state here: a select
   * cannot show a null, and clearing it must be possible when a rep realises
   * the number was misheard.
   */
  budget: LeadBudgetBand | '';
};

/**
 * Client contract for the edit dialog. The phone rule is the server's own
 * (via `PhoneInputSchema`), so the inline message and the API agree.
 * `name` mirrors the create form's rule; `email` stays optional/loose here
 * because the dialog already lowercases and omits blanks on submit.
 */
const LeadEditFormSchema = z
  .object({
    name: z
      .string()
      .trim()
      .min(1, 'Name is required')
      .max(120, 'Name must be at most 120 characters'),
    phone: PhoneInputSchema,
    phoneCountry: PhoneCountrySchema.optional(),
    email: z.string(),
    // T-NOTES (2026-11-27): the note is free text but not unbounded - the API
    // caps it at 2000, so the field must too or a long paste fails after the
    // round trip.
    notes: z.string().max(2000, 'Notes must be at most 2000 characters'),
    budget: z.union([z.literal(''), z.enum(LEAD_BUDGET_BANDS)]),
  })
  // The country rule (2026-11-27): the shape rule above accepts
  // `1234567890`, which is not an Indian mobile. That used to reach the API and
  // come back as a toast; now it fails here, in the field, with the server's
  // own sentence. Required, because a lead without a phone cannot be messaged.
  .superRefine((values, ctx) => refinePhonePair(values, ctx, { required: true }));

/** Minimal lead shape the dialog needs (from the inbox row). */
export type LeadEditTarget = {
  id: string;
  name: string;
  /** Stored canonical digits. `phoneE164` wins when the row carries both. */
  phone: string;
  phoneE164?: string | null;
  email?: string | null;
  /**
   * T-NOTES: the row's note. The dialog seeds its textarea from this and sends
   * it back, so a row that arrives without it would clear a real note on save -
   * the inbox query selects `notes` for exactly that reason.
   */
  notes?: string | null;
  /**
   * T-LEAD-BUDGET: the band, or null/absent for "never asked". The dialog sends
   * whatever it renders, so a row that arrives without it would wipe a band the
   * rep set earlier - the inbox query selects `budget` for that reason.
   */
  budget?: LeadBudgetBand | null;
};

/**
 * The stored value in the form `IntlPhoneInput` takes (canonical digits).
 * Re-exported from lib/phone.ts so the dialog's public surface stays stable.
 */
export { toPhoneInputValue } from '@/lib/phone';

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
  /**
   * Receives the form instance as well as the values: a server failure that
   * belongs to the phone field has to be set on THIS form, and the dialog shell
   * holds a separate instance (used for the row reset).
   */
  onSubmit: (values: LeadEditFormValues, form: UseFormReturn<LeadEditFormValues>) => void;
}) {
  const form = useForm<LeadEditFormValues>({
    // ADDED 2026-11-19: this form had NO resolver, so a mistyped phone was
    // handed straight to the mutation and the failure surfaced as a toast.
    // The schema below validates the SAME shapes the API accepts (it calls
    // the server's normalizer) while keeping the typed value - `PhoneSchema`
    // would transform it to `91…` mid-keystroke.
    resolver: zodResolver(LeadEditFormSchema),
    defaultValues: {
      name: lead.name,
      // Canonical digits, and the country the number already belongs to, so
      // the trigger shows the right flag instead of the form's default.
      phone: toPhoneInputValue(lead.phoneE164 ?? lead.phone),
      phoneCountry: countryOfStored(lead.phoneE164 ?? lead.phone) ?? DEFAULT_PHONE_COUNTRY,
      email: lead.email ?? '',
      notes: lead.notes ?? '',
      budget: lead.budget ?? '',
    },
    // `onSubmit`: the number is checked on Save and cleared as soon as it
    // parses. `name`/`email` behave the same way.
    mode: 'onSubmit',
  });

  const fields: FormFieldItemType<LeadEditFormValues>[] = [
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
      type: 'custom',
      name: 'phone',
      label: 'Phone',
      required: true,
      render: ({ field, fieldState }) => (
        <IntlPhoneInput
          aria-invalid={fieldState.invalid}
          id={field.name}
          name={field.name}
          value={field.value ?? ''}
          onBlur={field.onBlur}
          defaultCountry={DEFAULT_PHONE_COUNTRY}
          onChange={(digits, country) => {
            field.onChange(digits);
            form.setValue('phoneCountry', country ?? DEFAULT_PHONE_COUNTRY);
          }}
          placeholder="Enter phone number"
          data-qa="lead-edit-phone"
        />
      ),
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
    {
      type: 'select',
      name: 'budget',
      label: 'Budget',
      placeholder: 'Not asked yet',
      description:
        'What the buyer says they can spend. Reported on; the figure in detail goes in Notes.',
      options: LEAD_BUDGET_OPTIONS,
      selectProps: {
        'data-qa': 'lead-edit-budget',
      },
    },
    {
      type: 'textarea',
      name: 'notes',
      label: 'Notes',
      placeholder: 'Budget, preferred city, anything the buyer told us',
      description: 'Optional, up to 2000 characters. Shown on the lead detail page.',
      textareaProps: {
        rows: 4,
        maxLength: 2000,
        'data-qa': 'lead-edit-notes',
      },
    },
  ];

  return (
    <Form
      id={FORM_ID}
      form={form}
      // The body's own form travels with the values so a server phone
      // rejection can be set on the field the operator is looking at.
      onSubmit={(values) => onSubmit(values, form)}
      // The phone is a custom item the Form cannot focus; nudge it only when
      // the phone is what failed (2026-11-27). Reads the callback's `errors`;
      // `form.formState.errors` is not committed yet here.
      onSubmitError={(errors) => {
        if (errors.phone) focusField('phone');
      }}
      // The Save action lives in the Dialog footer (linked via
      // form={FORM_ID} + type="submit" on the footer button); hide the
      // Form's own action buttons so the submit isn't duplicated.
      hideSubmitButton
      hideResetButton
      fields={fields}
    />
  );
}

/**
 * Controlled edit dialog. `lead === null` renders nothing (the inbox
 * holds the currently-editing row in state; null = closed).
 */
export function LeadEditDialog({ lead, open, onOpenChange, onSaved }: LeadEditDialogProps) {
  const updateLead = useUpdateLead(lead?.id ?? null);
  const pending = updateLead.isPending;

  const form = useForm<LeadEditFormValues>({
    defaultValues: {
      name: lead?.name ?? '',
      phone: toPhoneInputValue(lead?.phoneE164 ?? lead?.phone),
      phoneCountry: countryOfStored(lead?.phoneE164 ?? lead?.phone) ?? DEFAULT_PHONE_COUNTRY,
      email: lead?.email ?? '',
      notes: lead?.notes ?? '',
      budget: lead?.budget ?? '',
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
        phone: toPhoneInputValue(lead.phoneE164 ?? lead.phone),
        phoneCountry: countryOfStored(lead.phoneE164 ?? lead.phone) ?? DEFAULT_PHONE_COUNTRY,
        email: lead.email ?? '',
        notes: lead.notes ?? '',
        budget: lead.budget ?? '',
      });
    }
    // form is stable (useForm); lead identity drives the reset. The
    // react-hooks plugin is not configured in this repo, so no
    // exhaustive-deps suppression is needed.
  }, [open, lead?.id]);

  if (lead === null) return null;
  const target = lead;

  function handleSubmit(values: LeadEditFormValues, bodyForm: UseFormReturn<LeadEditFormValues>) {
    updateLead.mutate(
      {
        id: target.id,
        name: values.name.trim(),
        phone: values.phone,
        phoneCountry: values.phoneCountry ?? DEFAULT_PHONE_COUNTRY,
        ...(values.email.trim().length > 0
          ? { email: values.email.trim().toLowerCase() }
          : { email: null }),
        // Sent always, so clearing the box clears the note. The server treats
        // '' as null (T-NOTES).
        notes: values.notes.trim(),
        // Same convention: '' clears the band, a value sets it (T-LEAD-BUDGET).
        budget: values.budget === '' ? null : values.budget,
      },
      {
        onSuccess: () => {
          toast.success('Lead updated');
          onOpenChange(false);
          onSaved?.();
        },
        onError: (error) => {
          const msg = error instanceof Error ? error.message : 'Update failed';
          // A phone the server refused (a duplicate this org already holds) is
          // shown under the field with focus moved there, AND as a toast: the
          // inline copy is what survives long enough to act on.
          const phoneMessage = phoneFieldErrorFromServer(error);
          if (phoneMessage !== null) {
            bodyForm.setError('phone', { message: phoneMessage });
            focusField('phone');
          }
          toast.error(msg);
        },
      },
    );
  }

  return (
    <Dialog
      open={open}
      onOpenChange={onOpenChange}
      contentClassName="sm:max-w-lg"
      header={{ title: 'Edit lead', description: "Edit the lead's name, phone, email and notes." }}
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
            loadingText="Saving..."
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
