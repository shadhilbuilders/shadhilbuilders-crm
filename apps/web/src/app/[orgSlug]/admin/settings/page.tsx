'use client';

// /[orgSlug]/admin/settings - ADMIN/OWNER organization settings.
// First setting: how many minutes before a scheduled site visit the reminder
// goes to the exec, lead owner, team manager and org owner (T-VISIT-REMINDER).
//
// Props-API Form + zodResolver. The numeric field is held as a string (same as
// BookingEditDialog) so it can be fully cleared; converted to a number on submit.

import { z } from 'zod';
import { zodResolver } from '@hookform/resolvers/zod';
import { useForm } from 'react-hook-form';

import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
  Form,
  NumberInput,
  toast,
  type FormFieldItemType,
} from '@paalstack/react-ui';
import {
  VISIT_REMINDER_MAX_MINUTES,
  VISIT_REMINDER_MIN_MINUTES,
  type OrganizationSettings,
} from '@shadhil/api-types';

import { PageHeader } from '@/components/shared/PageHeader';
import { Skeleton } from '@/components/shared/Skeleton';
import { useOrgSettings, useUpdateOrgSettings } from '@/hooks/queries/org-settings';

const FORM_ID = 'org-settings-form';

const RANGE_MESSAGE = `Enter a whole number between ${VISIT_REMINDER_MIN_MINUTES} and ${VISIT_REMINDER_MAX_MINUTES}.`;

// The field is held as a STRING so the user can clear it and retype from
// scratch. (The library's `type: 'number'` field writes `undefined` on clear,
// and react-hook-form then snaps back to the default value.) Same bounds as the
// shared OrganizationSettingsSchema; the server stays the source of truth and
// the value is converted to a number on submit.
const OrgSettingsFormSchema = z.object({
  visitReminderLeadMinutes: z
    .string()
    .trim()
    .min(1, 'Lead time is required')
    .refine(
      (v) => {
        const n = Number(v);
        return (
          Number.isInteger(n) && n >= VISIT_REMINDER_MIN_MINUTES && n <= VISIT_REMINDER_MAX_MINUTES
        );
      },
      { message: RANGE_MESSAGE },
    ),
});

type FormValues = z.infer<typeof OrgSettingsFormSchema>;

const toFormValues = (s: OrganizationSettings): FormValues => ({
  visitReminderLeadMinutes: String(s.visitReminderLeadMinutes),
});

function OrgSettingsForm({ initial }: { initial: OrganizationSettings }) {
  const update = useUpdateOrgSettings();
  const form = useForm<FormValues>({
    resolver: zodResolver(OrgSettingsFormSchema),
    defaultValues: toFormValues(initial),
    mode: 'onSubmit',
  });

  // No effect re-syncing from the query: this form mounts only once the data
  // has loaded, and a successful save resets it. Re-syncing would fight a user
  // who clears the field to type a fresh value.

  function onSubmit(values: FormValues): void {
    update.mutate(
      { visitReminderLeadMinutes: Number(values.visitReminderLeadMinutes) },
      {
        onSuccess: (saved) => {
          toast.success('Settings saved');
          form.reset(toFormValues(saved));
        },
        onError: (err: unknown) => {
          toast.error(err instanceof Error ? err.message : 'Could not save settings');
        },
      },
    );
  }

  const fields: FormFieldItemType<FormValues>[] = [
    {
      // `custom` so we own onChange: the Form's built-in `number` type writes
      // `undefined` on clear and RHF then restores the default value.
      type: 'custom',
      name: 'visitReminderLeadMinutes',
      label: 'Visit reminder lead time (minutes)',
      required: true,
      description: `The exec, lead owner, team manager and organization owner are reminded this long before a scheduled visit. Allowed: ${VISIT_REMINDER_MIN_MINUTES}-${VISIT_REMINDER_MAX_MINUTES}.`,
      render: ({ field }) => (
        <NumberInput
          {...field}
          onValueChange={field.onChange}
          isPositiveInteger
          positiveIntegerStartsWithZero
          placeholder={String(VISIT_REMINDER_MIN_MINUTES)}
          min={VISIT_REMINDER_MIN_MINUTES}
          max={VISIT_REMINDER_MAX_MINUTES}
          step={1}
          inputMode="numeric"
          data-qa="visit-reminder-minutes"
          className="w-full max-w-sm"
        />
      ),
    },
  ];

  return (
    <Card data-qa="org-settings-visit-reminder">
      <CardHeader>
        <CardTitle>Visit reminders</CardTitle>
        <CardDescription>
          How early staff are notified before a scheduled site visit.
        </CardDescription>
      </CardHeader>
      <CardContent className="mt-4">
        <Form
          id={FORM_ID}
          form={form}
          onSubmit={onSubmit}
          fields={fields}
          submitText={update.isPending ? 'Saving...' : 'Save'}
          submitButtonProps={{
            type: 'submit',
            disabled: update.isPending,
            isLoading: update.isPending,
            'data-qa': 'visit-reminder-save',
          }}
          hideResetButton
        />
      </CardContent>
    </Card>
  );
}

export default function OrgSettingsPage() {
  const query = useOrgSettings();

  return (
    <div className="space-y-6">
      <PageHeader
        title="Settings"
        breadcrumb={[{ label: 'Admin' }, { label: 'Settings' }]}
        subtitle="Organization-wide preferences."
      />
      {query.isLoading ? (
        <Skeleton variant="text" />
      ) : query.error !== null && query.error !== undefined ? (
        <p role="alert" className="text-destructive text-sm">
          Could not load settings: {query.error.message}
        </p>
      ) : query.data !== undefined ? (
        <OrgSettingsForm initial={query.data} />
      ) : null}
    </div>
  );
}
