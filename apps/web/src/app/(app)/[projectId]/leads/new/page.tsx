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

import { useParams } from 'next/navigation';

import { useCreateLead } from '@/hooks/queries/crm';
import { projectHref } from '@/lib/nav';
import { LEAD_SOURCES, labelFor } from '@/lib/labels';

import { PageHeader } from '@/components/shared/PageHeader';
import { PhoneSchema } from '@shadhil/api-types';
import z from 'zod';
import { zodResolver } from '@hookform/resolvers/zod';

type CreatedLead = { id: string };

const createLeadSchema = z.object({
  name: z.string().min(1, 'Name is required').trim().max(120),
  phone: PhoneSchema,
  email: z.email().optional(),
  source: z.enum(LEAD_SOURCES),
  notes: z.string().max(2000, 'Notes must be less than 2000 characters').trim().optional(),
});

type CreateLeadSchema = z.infer<typeof createLeadSchema>;

const LEAD_SOURCE_OPTIONS = LEAD_SOURCES.map((value) => ({
  value,
  label: labelFor('source', value),
}));

export default function NewLeadPage() {
  const router = useRouter();
  const createLead = useCreateLead();
  // T-ProjectSwitch: new leads belong to the project in the URL.
  const params = useParams<{ projectId: string }>();
  const projectId = typeof params?.projectId === 'string' ? params.projectId : null;
  const form = useForm<CreateLeadSchema>({
    resolver: zodResolver(createLeadSchema),
    defaultValues: {
      name: '',
      phone: '',
      email: '',
      source: 'LANDING',
      notes: '',
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

    const payload = {
      name: values.name.trim().replace(/\s+/g, ' '),
      phone,
      ...(projectId !== null ? { projectId } : {}),
      ...(values.email && values.email.trim().length > 0
        ? { email: values.email.trim().toLowerCase() }
        : {}),
      source: values.source.trim(),
      ...(values.notes && values.notes.trim().length > 0 ? { notes: values.notes.trim() } : {}),
    };

    createLead.mutate(payload, {
      onSuccess: (data) => {
        toast.success(`Lead ${payload.name} created`);
        const leadId = (data as CreatedLead | undefined)?.id;
        if (typeof leadId === 'string' && leadId.length > 0) {
          void router.push(projectHref(projectId, `/leads/${leadId}`));
        } else {
          void router.push(projectHref(projectId, '/leads'));
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

  return (
    <div className="space-y-6">
      <PageHeader
        title="New lead"
        breadcrumb={[
          { label: 'Work' },
          { label: 'Leads', href: projectHref(projectId, '/leads') },
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
            void router.push(projectHref(projectId, '/leads'));
          },
        }}
        fields={[
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
            type: 'input',
            name: 'phone',
            label: 'Phone',
            placeholder: '9876543210',
            required: true,
            description: 'Indian numbers: 10 digits, no spaces or dashes.',
            inputProps: {
              inputMode: 'numeric',
              'data-qa': 'lead-phone',
            },
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
          {
            type: 'textarea',
            name: 'notes',
            label: 'Notes',
            placeholder:
              'Referred by her brother (existing client). Looking for 3BHK in Whitefield, ~1.2Cr budget.',
            description:
              'Optional. Anything the sales team should know on first contact.',
            textareaProps: {
              maxLength: 2000,
              rows: 4,
              'data-qa': 'lead-notes',
            },
          },
        ]}
      />

      {/* Manual Cancel shortcut in addition to the form's Reset button. */}
      <div className="flex justify-start">
        <Button
          type="button"
          variant="ghost"
          size="sm"
          onClick={() => void router.push(projectHref(projectId, '/leads'))}
        >
          ← Back to Lead Inbox
        </Button>
      </div>
    </div>
  );
}
