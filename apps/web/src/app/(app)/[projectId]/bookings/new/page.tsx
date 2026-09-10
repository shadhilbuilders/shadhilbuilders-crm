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
// ScheduleVisitDialog). Unit picker is data-driven via useInventoryUnits
// (AVAILABLE units in the active project) - the inventory module is live
// (2026-09-10). A `?unitId=` query param pre-fills the picker (deep-link
// from the inventory detail sheet).
//
// We use the props-API Form (data-driven `fields` array) per
// the canonical pattern in apps/web/src/app/(app)/leads/new/page.tsx.
import { useRouter, useSearchParams } from 'next/navigation';
import { useForm } from 'react-hook-form';
import { Suspense } from 'react';

import { Button, Form, toast } from '@paalstack/react-ui';

import { useParams } from 'next/navigation';

import { useCreateBooking, useLeads } from '@/hooks/queries/crm';
import { useInventoryUnits } from '@/hooks/queries/inventory';
import { projectHref } from '@/lib/nav';

import { PageHeader } from '@/components/shared/PageHeader';
import { Skeleton } from '@/components/shared/Skeleton';

type CreateBookingFormValues = {
  leadId: string;
  unitId: string;
  amount: string;
  tokenAmount: string;
  notes: string;
};

type CreatedBooking = { id: string; leadId?: string };

export default function NewBookingPage() {
  // useSearchParams() must be inside a Suspense boundary (Next.js App
  // Router requirement - same pattern as the leads page) or the client
  // render throws a hydration mismatch. The fallback is a shape-matched
  // form skeleton so the page never flashes blank while the search
  // params resolve.
  return (
    <Suspense fallback={<Skeleton variant="text" count={6} />}>
      <NewBookingPageInner />
    </Suspense>
  );
}

function NewBookingPageInner() {
  const router = useRouter();
  const createBooking = useCreateBooking();
  // T-ProjectSwitch: the booking form lives under the URL project.
  const params = useParams<{ projectId: string }>();
  const projectId = typeof params?.projectId === 'string' ? params.projectId : null;
  const leadsQuery = useLeads({
    limit: 200,
    projectId: projectId ?? undefined,
    // A booking is initiated from a lead in NEGOTIATION (matches the
    // empty-state copy). Filter server-side so the picker only offers
    // bookable leads.
    state: ['NEGOTIATION'],
  });
  // Inventory picker: AVAILABLE units in the active project.
  const unitsQuery = useInventoryUnits({
    projectId: projectId ?? undefined,
    status: ['AVAILABLE'],
    limit: 200,
  });
  const searchParams = useSearchParams();
  const unitParam = searchParams.get('unitId') ?? '';

  const form = useForm<CreateBookingFormValues>({
    defaultValues: {
      leadId: '',
      unitId: unitParam,
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

  const unitOptions = (() => {
    const rows = unitsQuery.data;
    if (rows === undefined || !Array.isArray(rows)) return [];
    return (rows as Array<{ id: string; unitNumber?: string; bhk?: number }>).map(
      (row) => ({
        value: row.id,
        label: `${row.unitNumber ?? 'Unit'}${typeof row.bhk === 'number' ? ` · ${row.bhk} BHK` : ''}`,
      }),
    );
  })();

  function onSubmit(values: CreateBookingFormValues) {
    if (values.leadId.length === 0) {
      toast.error('Pick a lead');
      return;
    }
    if (values.unitId.length === 0) {
      toast.error('Pick a unit');
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
          void router.push(projectHref(projectId, `/leads/${leadId}`));
        } else {
          void router.push(projectHref(projectId, '/bookings'));
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
          { label: 'Bookings', href: projectHref(projectId, '/bookings') },
          { label: 'New' },
        ]}
        subtitle="Starts in HOLD. Manager approval advances to APPROVED."
      />

      <Form
        form={form}
        onSubmit={onSubmit}
        submitText={createBooking.isPending ? 'Saving...' : 'Create booking'}
        submitButtonProps={{ disabled: createBooking.isPending }}
        resetButtonProps={{
          children: 'Cancel',
          onClick: () => {
            form.reset();
            void router.push(projectHref(projectId, '/bookings'));
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
            type: 'select',
            name: 'unitId',
            label: 'Unit',
            required: true,
            placeholder: 'Pick an available unit',
            options: unitOptions,
            description:
              'Available units in this project. A booking holds the unit.',
            selectProps: {
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
          onClick={() => void router.push(projectHref(projectId, '/bookings'))}
        >
          ← Back to bookings
        </Button>
      </div>
    </div>
  );
}