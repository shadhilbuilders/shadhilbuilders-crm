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
import type { FormFieldItemType } from '@paalstack/react-ui';

import { useCreateLead } from '@/hooks/queries/crm';
import { useUsers } from '@/hooks/queries/users';
import { useTeams } from '@/hooks/queries/teams';
import { projectHref } from '@/lib/nav';
import { useProjectId, useOrgSlug, useProjectSlug } from '@/lib/tenant-context';
import { useSessionUser } from '@/lib/session';
import { LEAD_SOURCES, labelFor } from '@/lib/labels';

import { PageHeader } from '@/components/shared/PageHeader';
import { PhoneNumberInput } from '@/components/shared/PhoneNumberInput';
import { PhoneSchema } from '@shadhil/api-types';
import z from 'zod';
import { zodResolver } from '@hookform/resolvers/zod';

type CreatedLead = { id: string };

// Sentinel for "let the backend decide" (mirrors TeamMemberRemovalDialog's
// NO_REPLACEMENT pattern) - an empty string is not a valid teamId, and
// z.string() alone can't express "optional but no undefined default" for
// a Form field bound via react-hook-form (RHF fields need a defined
// initial value). onSubmit strips this sentinel back out to "omit teamId".
const NO_TEAM_OVERRIDE = '';
// Sentinel for "let the backend assign the owner automatically". Mirrors
// NO_TEAM_OVERRIDE - an empty string is not a valid user id, and the Form
// needs a defined initial value.
const NO_OWNER_OVERRIDE = '';

const createLeadSchema = z.object({
  name: z.string().min(1, 'Name is required').trim().max(120),
  phone: PhoneSchema,
  // Email is optional. The form defaults it to '' (empty string) - but
  // .optional() only allows undefined/missing, not ''. So accept '' as
  // "not provided" via a union with z.literal('') (mirrors the convert
  // modal). onSubmit omits empty values from the payload.
  email: z.union([z.literal(''), z.email().trim().toLowerCase().max(254)]).optional(),
  source: z.enum(LEAD_SOURCES),
  notes: z.string().max(2000, 'Notes must be less than 2000 characters').trim().optional(),
  // T-TEAM-AUTHORITATIVE (2026-09-13) follow-up: only rendered/relevant for
  // a MANAGER who leads more than one team - see the `managedTeams` picker
  // below. NO_TEAM_OVERRIDE means "let the backend pick" (its existing
  // oldest-managed-team default, unchanged for everyone else).
  teamId: z.string(),
  // Assigned owner - only shown for MANAGER/ADMIN/OWNER (staff self-assign).
  // The empty string sentinel mirrors NO_TEAM_OVERRIDE: omit from payload when
  // unset so the backend auto-assigns/rules.
  assignedOwnerId: z.string(),
});

type CreateLeadSchema = z.infer<typeof createLeadSchema>;

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
      email: '',
      source: 'LANDING',
      notes: '',
      teamId: NO_TEAM_OVERRIDE,
      assignedOwnerId: NO_OWNER_OVERRIDE,
    },
    mode: 'onSubmit',
  });

  function onSubmit(values: CreateLeadSchema) {
    // PhoneSchema already validated + normalized `values.phone` to E.164
    // digits (no "+", no spaces) during parse - no manual cleanup needed.
    const phone = values.phone;
    if (phone.length < 10) {
      toast.error('Phone must be at least 10 digits');
      return;
    }
    // T-LEAD-PROJECT-REQUIRED (2026-09-16): every lead needs a project. This form
    // only ever renders on a project-scoped route, so a missing projectId means
    // the routing is broken - say so instead of posting a lead that would be
    // invisible on every project surface.
    if (projectId === null) {
      toast.error('No project in context - reload the page from a project.');
      return;
    }

    const payload = {
      name: values.name.trim().replace(/\s+/g, ' '),
      phone,
      // T-LEAD-PROJECT-REQUIRED (2026-09-16): projectId is REQUIRED by the API and
      // NOT NULL in the DB, so this is no longer conditional. The route is
      // project-scoped, so a null here is a routing error, and the guard below
      // fails loudly rather than posting a lead no project surface can show.
      projectId,
      ...(values.email && values.email.trim().length > 0
        ? { email: values.email.trim().toLowerCase() }
        : {}),
      source: values.source.trim(),
      ...(values.notes && values.notes.trim().length > 0 ? { notes: values.notes.trim() } : {}),
      ...(values.teamId !== NO_TEAM_OVERRIDE ? { teamId: values.teamId } : {}),
      ...(values.assignedOwnerId !== NO_OWNER_OVERRIDE
        ? { assignedOwnerId: values.assignedOwnerId }
        : {}),
    };

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
      description: '10-digit mobile number. +91 is added automatically.',
      render: ({ field }) => (
        <PhoneNumberInput
          {...field}
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
      description: 'Which of your teams does this lead belong to? Defaults to your first team if left unset.',
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
        submitText={createLead.isPending ? 'Saving...' : 'Create lead'}
        submitButtonProps={{ disabled: createLead.isPending }}
        actionClassName='justify-end'
        resetText='Cancel'
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
          ← Back to Lead Inbox
        </Button>
      </div>
    </div>
  );
}
