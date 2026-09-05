'use client';

// /bookings/new - Create-Booking form (T-F4).
//
// Posts to /api/bookings via useCreateBooking (T-F1). Server
// validates with CreateBookingDto Zod schema in
// packages/api-types/src/bookings.ts; we mirror the validation
// client-side so 400s land as inline errors via the standard form
// flow.
//
// Lead picker is data-driven via useLeads (the same pattern as
// ScheduleVisitDialog). Unit ID is required by the DTO but the
// Inventory module is not yet wired - so we accept a free-text
// cuid input. When the inventory module ships this becomes a
// picker driven by InventoryUnit.status='AVAILABLE'.
//
// We use the props-API Form (data-driven `fields` array) per
// the canonical pattern in apps/web/src/app/(app)/leads/new/page.tsx.
import { useRouter } from 'next/navigation';
import { useForm } from 'react-hook-form';

import { Button, Form, toast } from '@paalstack/react-ui';

import { useParams } from 'next/navigation';

import { useCreateBooking, useLeads } from '@/hooks/queries/crm';

import { PageHeader } from '../../../PageHeader';

type CreateBookingFormValues = {
  leadId: string;
  unitId: string;
  amount: string;
  tokenAmount: string;
  notes: string;
};

type CreatedBooking = { id: string; leadId?: string };

// cuid regex (matches api-types CreateBookingDto)
const CUID_RE = /^c[a-z0-9]{20,}$/i;

export default function NewBookingPage() {
  const router = useRouter();
  const createBooking = useCreateBooking();
  // T-ProjectSwitch: the booking form lives under the URL project.
  const params = useParams<{ projectId: string }>();
  const projectId = typeof params?.projectId === 'string' ? params.projectId : null;
  const leadsQuery = useLeads({ limit: 200, projectId: projectId ?? undefined });

  const form = useForm<CreateBookingFormValues>({
    defaultValues: {
      leadId: '',
      unitId: '',
      amount: '',
      tokenAmount: '',
      notes: '',
    },
    mode: 'onSubmit',
  });

  const leadOptions = (() => {
    const rows = leadsQuery.data;
    if (rows === undefined || !Array.isArray(rows)) return [];
    return (rows as Array<{ id: string; name?: string; status?: string }>).map(
      (row) => ({
        value: row.id,
        label: `${row.name ?? 'Lead'}${
          typeof row.status === 'string' ? ` (${row.status})` : ''
        }`,
      }),
    );
  })();

  function onSubmit(values: CreateBookingFormValues) {
    if (values.leadId.length === 0) {
      toast.error('Pick a lead');
      return;
    }
    if (!CUID_RE.test(values.unitId)) {
      toast.error('Unit id must be a cuid');
      return;
    }
    const amount = Number(values.amount);
    if (!Number.isFinite(amount) || amount <= 0) {
      toast.error('Amount must be a positive number');
      return;
    }
    let tokenAmount: number | undefined;
    if (values.tokenAmount.trim().length > 0) {
      const parsed = Number(values.tokenAmount);
      if (!Number.isFinite(parsed) || parsed <= 0) {
        toast.error('Token amount must be a positive number');
        return;
      }
      tokenAmount = parsed;
    }

    const payload: {
      leadId: string;
      unitId: string;
      amount: number;
      tokenAmount?: number;
      notes?: string;
    } = {
      leadId: values.leadId,
      unitId: values.unitId,
      amount,
    };
    if (tokenAmount !== undefined) payload.tokenAmount = tokenAmount;
    if (values.notes.trim().length > 0) {
      payload.notes = values.notes.trim();
    }

    createBooking.mutate(payload, {
      onSuccess: (data) => {
        toast.success('Booking created in HOLD');
        const id = (data as CreatedBooking | undefined)?.id;
        const leadId =
          (data as CreatedBooking | undefined)?.leadId ?? values.leadId;
        if (typeof id === 'string' && id.length > 0) {
          void router.push(`/${projectId}/leads/${leadId}`);
        } else {
          void router.push(`/${projectId ?? ''}/bookings`);
        }
      },
      onError: (error) => {
        const msg = error instanceof Error ? error.message : 'Create failed';
        toast.error(msg);
      },
    });
  }

  return (
    <div className="space-y-6">
      <PageHeader
        title="New booking"
        breadcrumb={[
          { label: 'Work' },
          { label: 'Bookings', href: '/bookings' },
          { label: 'New' },
        ]}
        subtitle="Starts in HOLD. Manager approval advances to APPROVED."
      />

      <Form
        form={form}
        onSubmit={onSubmit}
        submitText={createBooking.isPending ? 'Saving…' : 'Create booking'}
        submitButtonProps={{ disabled: createBooking.isPending }}
        resetButtonProps={{
          children: 'Cancel',
          onClick: () => {
            form.reset();
            void router.push(`/${projectId ?? ''}/bookings`);
          },
        }}
        fields={[
          {
            type: 'select',
            name: 'leadId',
            label: 'Lead',
            required: true,
            placeholder: 'Pick a lead',
            options: leadOptions,
          },
          {
            type: 'input',
            name: 'unitId',
            label: 'Unit ID',
            required: true,
            placeholder: 'cxxxxxxxxxxxxxxxxxxxxxxx',
            description:
              'Cuid of the inventory unit. Inventory picker ships in Week 6.',
            inputProps: {
              'data-qa': 'booking-unit-id',
            },
          },
          {
            type: 'input',
            name: 'amount',
            label: 'Total amount (₹)',
            required: true,
            inputType: 'number',
            description: 'Booking value in rupees (cap ₹100 Cr).',
            inputProps: {
              min: 1,
              step: 1,
              'data-qa': 'booking-amount',
            },
          },
          {
            type: 'input',
            name: 'tokenAmount',
            label: 'Token amount (₹, optional)',
            inputType: 'number',
            description: 'Optional. Booking starts in HOLD if zero / blank.',
            inputProps: {
              min: 0,
              step: 1,
              'data-qa': 'booking-token-amount',
            },
          },
          {
            type: 'textarea',
            name: 'notes',
            label: 'Notes',
            textareaProps: { rows: 3, maxLength: 2000 },
          },
        ]}
      />

      <div className="flex justify-start">
        <Button
          type="button"
          variant="ghost"
          size="sm"
          onClick={() => void router.push(`/${projectId ?? ''}/bookings`)}
        >
          ← Back to bookings
        </Button>
      </div>
    </div>
  );
}