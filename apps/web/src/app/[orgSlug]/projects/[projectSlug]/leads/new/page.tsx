'use client';

// /leads/new - Create-Lead form (T-LEAD-CRUD).
//
// Day 2 demo path: a real create-lead form wired to POST /api/leads via
// the BFF. Server validates with the shared CreateLeadDto Zod schema
// (packages/api-types/src/leads.ts); we re-validate client-side via
// react-hook-form validation rules.
//
// Phone is normalized to digits-only client-side before submit (server's
// CreateLeadDto.phone does the same).
//
// Source is a fixed option set today; will become a foreign key when
// MarketingAttribution ships in v2.
//
// We use the props-API Form (data-driven, declarative `fields` array)
// per the canonical pattern in apps/web/src/app/dev/components/page.tsx.
import { useRouter } from 'next/navigation';
import { useForm } from 'react-hook-form';

import { Button, Form, toast } from '@paalstack/react-ui';
import { LuArrowLeft } from '@paalstack/react-icons/lu';
import type { FormFieldItemType } from '@paalstack/react-ui';

import { useCreateLead } from '@/hooks/queries/crm';
import { useUsers } from '@/hooks/queries/users';
import { useTeams } from '@/hooks/queries/teams';
import { projectHref } from '@/lib/nav';
import { useProjectId, useOrgSlug, useProjectSlug } from '@/lib/tenant-context';
import { useSessionUser } from '@/lib/session';
import { LEAD_SOURCES, labelFor } from '@/lib/labels';
import { DEFAULT_PHONE_COUNTRY, phoneFieldErrorFromServer } from '@/lib/phone';
import { focusField } from '@/lib/form-focus';

import { PageHeader } from '@/components/shared/PageHeader';
import { IntlPhoneInput } from '@/components/shared/IntlPhoneInput';
import { zodResolver } from '@hookform/resolvers/zod';

import {
  NO_OWNER_OVERRIDE,
  NO_TEAM_OVERRIDE,
  buildLeadPayload,
  createLeadSchema,
  type CreateLeadSchema,
} from './new-lead-form';

type CreatedLead = { id: string };

const LEAD_SOURCE_OPTIONS = LEAD_SOURCES.map((value) => ({
  value,
  label: labelFor('source', value),
}));

export default function NewLeadPage() {
  const router = useRouter();
  const createLead = useCreateLead();
  // T-ProjectSwitch: the resolved project comes from tenant context;
  // id keys the create payload, slugs key hrefs.
  const projectId = useProjectId();
  const orgSlug = useOrgSlug();
  const projectSlug = useProjectSlug();
  const { user } = useSessionUser();
  const teamsQuery = useTeams();
  // T-TEAM-AUTHORITATIVE (2026-09-13) follow-up: useTeams() returns every
  // team the actor can ACCESS (managed UNION ordinary membership for a
  // MANAGER - team-access.service.ts), but leads.service.ts only accepts
  // a `teamId` the actor MANAGES (Team.managerId === actor.sub) - picking
  // an ordinary-membership team 403s server-side. Filter to managerId
  // match so every option in the picker is guaranteed valid.
  const managedTeams = (teamsQuery.data ?? []).filter(
    (t) => user?.role === 'MANAGER' && t.managerId === user.id,
  );
  const form = useForm<CreateLeadSchema>({
    resolver: zodResolver(createLeadSchema),
    defaultValues: {
      name: '',
      phone: '',
      phoneCountry: DEFAULT_PHONE_COUNTRY,
      email: '',
      source: 'WALK_IN',
      notes: '',
      teamId: NO_TEAM_OVERRIDE,
      assignedOwnerId: NO_OWNER_OVERRIDE,
    },
    // `onSubmit`, the house rule (AGENTS.md, Forms): the phone rule reports on
    // the first Save, and reValidateMode ('onChange', the default) clears it as
    // soon as the number parses. Now that the schema no longer transforms the
    // value, nothing rewrites the input mid-typing either.
    mode: 'onSubmit',
  });

  function onSubmit(values: CreateLeadSchema) {
    // T-LEAD-PROJECT-REQUIRED (2026-09-16): every lead needs a project. This form
    // only ever renders on a project-scoped route, so a missing projectId means
    // the routing is broken - say so instead of posting a lead that would be
    // invisible on every project surface.
    if (projectId === null) {
      toast.error('No project in context - reload the page from a project.');
      return;
    }

    const payload = buildLeadPayload(values, projectId);

    createLead.mutate(payload, {
      onSuccess: (data) => {
        toast.success(`Lead ${payload.name} created`);
        const leadId = (data as CreatedLead | undefined)?.id;
        if (typeof leadId === 'string' && leadId.length > 0) {
          void router.push(projectHref(orgSlug, projectSlug, `/leads/${leadId}`));
        } else {
          void router.push(projectHref(orgSlug, projectSlug, '/leads'));
        }
      },
      onError: (error) => {
        // Server validation messages come through verbatim (400 from
        // the parseBody Zod wrapper in leads.controller.ts:31).
        const msg = error instanceof Error ? error.message : 'Create failed';
        // A duplicate number is about the phone field: show it there too, with
        // focus moved to it, and still toast.
        const phoneMessage = phoneFieldErrorFromServer(error);
        if (phoneMessage !== null) {
          form.setError('phone', { message: phoneMessage });
          focusField('phone');
        }
        toast.error(msg);
      },
    });
  }

  const fields: FormFieldItemType<CreateLeadSchema>[] = [
    {
      type: 'input',
      name: 'name',
      label: 'Full name',
      placeholder: 'Priya Sharma',
      required: true,
      inputProps: {
        maxLength: 120,
        'data-qa': 'lead-name',
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
          placeholder="9876543210"
          data-qa="lead-phone"
        />
      ),
    },
    {
      type: 'input',
      name: 'email',
      label: 'Email',
      placeholder: 'priya@example.com',
      inputType: 'email',
      description: 'Optional. Used for booking confirmations.',
      inputProps: {
        'data-qa': 'lead-email',
      },
    },
    {
      type: 'select',
      name: 'source',
      label: 'Source',
      placeholder: 'Pick a source',
      required: true,
      description: 'Where this lead came from.',
      options: LEAD_SOURCE_OPTIONS,
      selectProps: {
        'data-qa': 'lead-source',
      },
    },
  ];

  // New-lead owner assignment: TELECALLER/SALES_EXEC always self-assign
  // (backend hard-guarantees it). MANAGER/ADMIN/OWNER may pick an owner from
  // the assignable staff (TELECALLER/SALES_EXEC) or a MANAGER - render a
  // combobox for those roles only. `useUsers` is scoped server-side (ADMIN
  // sees all, MANAGER sees own team) so the picker only offers valid,
  // in-scope staff.
  const usersQuery = useUsers({
    role: ['TELECALLER', 'SALES_EXEC', 'MANAGER'],
  });
  const canPickOwner =
    (user?.role === 'MANAGER' || user?.role === 'ADMIN' || user?.role === 'OWNER') &&
    (usersQuery.data?.rows ?? []).length > 0;

  // T-TEAM-AUTHORITATIVE (2026-09-13) follow-up: only shown for a MANAGER
  // who leads MORE THAN ONE team - a single-team manager (the common case)
  // sees no change, matching the backend's "unchanged behavior for
  // single-team actors" default.
  if (managedTeams.length > 1) {
    fields.push({
      type: 'select',
      name: 'teamId',
      label: 'Team',
      description:
        'Which of your teams does this lead belong to? Defaults to your first team if left unset.',
      options: [
        { value: NO_TEAM_OVERRIDE, label: 'Default (first team)' },
        ...managedTeams.map((t) => ({ value: t.id, label: t.name })),
      ],
    });
  }

  // Owner picker for MANAGER/ADMIN/OWNER. Defaults to "auto-assign" (backend
  // rule engine); selecting a specific staff user overrides it. Uses the
  // props-API Combobox (searchable, `selectOptionAsValue`) - the same
  // assignee pattern as LeadReassignDialog / LeadCoOwnerDialog.
  if (canPickOwner) {
    fields.push({
      type: 'combobox' as const,
      name: 'assignedOwnerId',
      label: 'Assignee',
      placeholder: 'Search staff by name or email...',
      options: [
        { value: NO_OWNER_OVERRIDE, label: 'Auto-assign (rule engine)' },
        ...(usersQuery.data?.rows ?? [])
          .map((u) => ({ value: u.id, label: `${u.name} (${u.email})` }))
          .sort((a, b) => a.label.localeCompare(b.label)),
      ],
      description:
        'Optional. Defaults to the assignment rule; pick a specific staff member to assign directly to them.',
      comboboxProps: {
        selectOptionAsValue: true,
        emptyOptionMessage: 'No assignable staff found.',
        loadingMessage: 'Loading staff...',
        'data-qa': 'lead-assignee',
        className: 'min-w-0',
      },
    });
  }

  fields.push({
    type: 'textarea',
    name: 'notes',
    label: 'Notes',
    placeholder:
      'Referred by her brother (existing client). Looking for 3BHK in Whitefield, ~1.2Cr budget.',
    description: 'Optional. Anything the sales team should know on first contact.',
    textareaProps: {
      maxLength: 2000,
      rows: 4,
      'data-qa': 'lead-notes',
    },
  });

  return (
    <div className="space-y-6">
      <PageHeader
        title="New lead"
        breadcrumb={[
          { label: 'Work' },
          { label: 'Leads', href: projectHref(orgSlug, projectSlug, '/leads') },
          { label: 'New' },
        ]}
        subtitle="Owner is assigned automatically by the assignment rule."
      />

      <Form
        form={form}
        onSubmit={onSubmit}
        // The phone is a custom item the Form cannot focus; nudge it only when
        // the phone is what failed (2026-11-27). Reads the callback's `errors`;
        // `form.formState.errors` is not committed yet here.
        onSubmitError={(errors) => {
          if (errors.phone) focusField('phone');
        }}
        submitText={createLead.isPending ? 'Saving...' : 'Create lead'}
        submitButtonProps={{ disabled: createLead.isPending }}
        actionClassName="justify-end"
        resetText="Cancel"
        resetButtonProps={{
          onClick: () => {
            form.reset();
            void router.push(projectHref(orgSlug, projectSlug, '/leads'));
          },
        }}
        fields={fields}
      />

      {/* Manual Cancel shortcut in addition to the form's Reset button. */}
      <div className="flex justify-start">
        <Button
          type="button"
          variant="ghost"
          size="sm"
          onClick={() => void router.push(projectHref(orgSlug, projectSlug, '/leads'))}
        >
          <LuArrowLeft className="size-4 shrink-0" aria-hidden />
          Back to Lead Inbox
        </Button>
      </div>
    </div>
  );
}
