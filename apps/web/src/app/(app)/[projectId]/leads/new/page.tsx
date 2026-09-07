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
// Source is a free-form text input per Plan §3 (will become a foreign key
// when MarketingAttribution ships in v2).
//
// We use the props-API Form (data-driven, declarative `fields` array)
// per the canonical pattern in apps/web/src/app/dev/components/page.tsx.
import { useRouter } from 'next/navigation';
import { useForm } from 'react-hook-form';

import { Button, Form, toast } from '@paalstack/react-ui';

import { useParams } from 'next/navigation';

import { useCreateLead } from '@/hooks/queries/crm';
import { projectHref } from '@/lib/nav';

import { PageHeader } from '../../../PageHeader';

type CreateLeadFormValues = {
  name: string;
  phone: string;
  email: string;
  source: string;
  notes: string;
};

type CreatedLead = { id: string };

export default function NewLeadPage() {
  const router = useRouter();
  const createLead = useCreateLead();
  // T-ProjectSwitch: new leads belong to the project in the URL.
  const params = useParams<{ projectId: string }>();
  const projectId = typeof params?.projectId === 'string' ? params.projectId : null;
  const form = useForm<CreateLeadFormValues>({
    defaultValues: {
      name: '',
      phone: '',
      email: '',
      source: 'Landing site',
      notes: '',
    },
    mode: 'onSubmit',
  });

  function onSubmit(values: CreateLeadFormValues) {
    const phone = values.phone.replace(/\D/g, '');
    if (phone.length < 10) {
      toast.error('Phone must be at least 10 digits');
      return;
    }

    const payload = {
      name: values.name.trim().replace(/\s+/g, ' '),
      phone,
      ...(projectId !== null ? { projectId } : {}),
      ...(values.email.trim().length > 0
        ? { email: values.email.trim().toLowerCase() }
        : {}),
      source: values.source.trim(),
      ...(values.notes.trim().length > 0 ? { notes: values.notes.trim() } : {}),
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
        submitText={createLead.isPending ? 'Saving…' : 'Create lead'}
        submitButtonProps={{ disabled: createLead.isPending }}
        resetButtonProps={{
          children: 'Cancel',
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
            inputType: 'tel',
            description: 'Indian numbers: 10 digits, optional +91 prefix.',
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
            type: 'input',
            name: 'source',
            label: 'Source',
            placeholder: 'Landing site',
            required: true,
            description: 'Where this lead came from.',
            inputProps: {
              list: 'lead-sources',
              maxLength: 80,
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

      {/* Source datalist - used by the source field above */}
      <datalist id="lead-sources">
        <option value="Landing site" />
        <option value="Meta ads" />
        <option value="Walk-in" />
        <option value="Referral" />
        <option value="99acres" />
        <option value="Magicbricks" />
        <option value="Housing.com" />
      </datalist>

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
